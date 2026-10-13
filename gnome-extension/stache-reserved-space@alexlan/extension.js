import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const BUS_NAME = 'org.gnome.Shell.Extensions.Stache';
const OBJECT_PATH = '/org/gnome/Shell/Extensions/Stache';
const COMPACT_HEIGHT = 30;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_HEIGHT = 60;
const WINDOW_TITLE = 'Stache';
const NOTIFICATION_SCHEMA = 'org.gnome.desktop.notifications';
const SHOW_BANNERS_KEY = 'show-banners';
const KEYBINDINGS_SCHEMA = 'org.gnome.shell.keybindings';
const TRAY_KEY = 'toggle-message-tray';
const SHORTCUT_KEY = 'clipboard-shortcut';
const SEARCH_KEY = 'search-shortcut';
const MEDIA_KEYS_SCHEMA = 'org.gnome.settings-daemon.plugins.media-keys';
const CUSTOM_SCHEMA = 'org.gnome.settings-daemon.plugins.media-keys.custom-keybinding';
const WM_SCHEMA = 'org.gnome.desktop.wm.keybindings';
const INPUT_SOURCE_KEYS = ['switch-input-source', 'switch-input-source-backward'];
// Gerenciadores de senhas marcam o que copiam com este tipo; esse conteúdo não é guardado.
const PASSWORD_HINT = 'x-kde-passwordManagerHint';
// Terminais colam com Ctrl+Shift+V.
const TERMINALS = ['gnome-terminal', 'kgx', 'org.gnome.console', 'org.gnome.terminal', 'alacritty',
    'kitty', 'wezterm', 'foot', 'tilix', 'konsole', 'xterm', 'terminator', 'ptyxis', 'org.gnome.ptyxis'];

const INTERFACE_XML = `
<node>
  <interface name="org.gnome.Shell.Extensions.Stache">
    <method name="SetHeight">
      <arg type="u" name="height" direction="in"/>
    </method>
    <method name="SetClipboard">
      <arg type="s" name="text" direction="in"/>
    </method>
    <method name="Paste">
      <arg type="s" name="text" direction="in"/>
    </method>
    <method name="PasteImage">
      <arg type="s" name="path" direction="in"/>
    </method>
    <method name="FocusIsland"/>
    <method name="GetPointer">
      <arg type="b" name="found" direction="out"/>
      <arg type="i" name="x" direction="out"/>
      <arg type="i" name="y" direction="out"/>
    </method>
    <method name="RunningApps">
      <arg type="as" name="ids" direction="out"/>
    </method>
    <method name="ActivateApp">
      <arg type="s" name="desktopId" direction="in"/>
      <arg type="b" name="found" direction="out"/>
    </method>
    <signal name="ClipboardChanged">
      <arg type="s" name="text"/>
    </signal>
    <signal name="ClipboardImage">
      <arg type="s" name="path"/>
    </signal>
    <signal name="FilesCopied">
      <arg type="s" name="paths"/>
    </signal>
    <signal name="ClipboardShortcut"/>
    <signal name="SearchShortcut"/>
    <property name="Height" type="u" access="read"/>
  </interface>
</node>`;

export default class StacheReservedSpaceExtension extends Extension {
    enable() {
        this._height = COMPACT_HEIGHT;
        this._strut = new St.Widget({
            name: 'stache-reserved-space',
            reactive: false,
            opacity: 0,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.START,
        });

        Main.layoutManager.addChrome(this._strut, {
            affectsStruts: true,
            trackFullscreen: true,
        });
        this._monitorsChangedId = Main.layoutManager.connect(
            'monitors-changed', () => this._syncGeometry());
        this._syncGeometry();

        this._windowSignals = new Map();
        this._windowCreatedId = global.display.connect(
            'window-created', (_display, window) => this._track(window));
        global.get_window_actors().forEach(actor => this._track(actor.meta_window));

        this._dbusObject = Gio.DBusExportedObject.wrapJSObject(INTERFACE_XML, this);
        this._busOwnerId = Gio.bus_own_name(
            Gio.BusType.SESSION,
            BUS_NAME,
            Gio.BusNameOwnerFlags.NONE,
            connection => this._dbusObject?.export(connection, OBJECT_PATH),
            null,
            null);

        this._enableClipboard();
    }

    // ---- Área de transferência -------------------------------------------------
    // O Wayland não deixa um app comum observar a seleção nem colar em outra janela;
    // dentro do Shell dá para ler a área de transferência, ouvir Super+V e digitar Ctrl+V.
    _enableClipboard() {
        try {
            this._clipboard = St.Clipboard.get_default();
            this._selection = global.display.get_selection();
            this._selectionId = this._selection.connect('owner-changed', (_selection, type) => {
                if (type === Meta.SelectionType.SELECTION_CLIPBOARD)
                    this._readClipboard();
            });
        } catch (error) {
            console.error(`Stache: não consegui observar a área de transferência: ${error}`);
        }

        try {
            // Super+V já é "abrir a lista de notificações"; libera para o Stache enquanto a extensão roda.
            const keybindings = new Gio.Settings({schema_id: KEYBINDINGS_SCHEMA});
            const current = keybindings.get_strv(TRAY_KEY);
            if (current.some(accel => accel.toLowerCase() === '<super>v')) {
                this._savedTray = current;
                keybindings.set_strv(TRAY_KEY, current.filter(accel => accel.toLowerCase() !== '<super>v'));
            }
            this._settings = this.getSettings();
            Main.wm.addKeybinding(SHORTCUT_KEY, this._settings, Meta.KeyBindingFlags.NONE,
                Shell.ActionMode.ALL, () => this._onShortcut());
            this._shortcutBound = true;

            // Super+Espaço troca o idioma do teclado; libera para a busca enquanto a extensão roda.
            const wm = new Gio.Settings({schema_id: WM_SCHEMA});
            this._savedInputSource = new Map();
            for (const key of INPUT_SOURCE_KEYS) {
                const accels = wm.get_strv(key);
                if (accels.some(accel => accel.toLowerCase().includes('<super>space'))) {
                    this._savedInputSource.set(key, accels);
                    wm.set_strv(key, accels.filter(accel => !accel.toLowerCase().includes('<super>space')));
                }
            }
            // Atalhos personalizados (ex.: Albert, Ulauncher) em Super+Espaço também disputam a tecla.
            this._savedCustom = new Map();
            const media = new Gio.Settings({schema_id: MEDIA_KEYS_SCHEMA});
            for (const path of media.get_strv('custom-keybindings')) {
                const custom = new Gio.Settings({schema_id: CUSTOM_SCHEMA, path});
                const binding = custom.get_string('binding');
                if (binding.toLowerCase().includes('<super>space')) {
                    this._savedCustom.set(path, binding);
                    custom.set_string('binding', '');
                }
            }
            Main.wm.addKeybinding(SEARCH_KEY, this._settings, Meta.KeyBindingFlags.NONE,
                Shell.ActionMode.ALL, () => this._onSearchShortcut());
            this._searchBound = true;
        } catch (error) {
            console.error(`Stache: não consegui registrar o atalho da área de transferência: ${error}`);
        }
    }

    _disableClipboard() {
        if (this._selectionId && this._selection)
            this._selection.disconnect(this._selectionId);
        this._selectionId = 0;
        this._selection = null;
        this._clipboard = null;
        if (this._shortcutBound) {
            Main.wm.removeKeybinding(SHORTCUT_KEY);
            this._shortcutBound = false;
        }
        if (this._searchBound) {
            Main.wm.removeKeybinding(SEARCH_KEY);
            this._searchBound = false;
        }
        if (this._savedInputSource) {
            try {
                const wm = new Gio.Settings({schema_id: WM_SCHEMA});
                this._savedInputSource.forEach((accels, key) => wm.set_strv(key, accels));
            } catch (error) {
                console.error(`Stache: não consegui restaurar o atalho de idioma do teclado: ${error}`);
            }
            this._savedInputSource = null;
        }
        if (this._savedCustom) {
            try {
                this._savedCustom.forEach((binding, path) =>
                    new Gio.Settings({schema_id: CUSTOM_SCHEMA, path}).set_string('binding', binding));
            } catch (error) {
                console.error(`Stache: não consegui restaurar o atalho personalizado: ${error}`);
            }
            this._savedCustom = null;
        }
        this._settings = null;
        if (this._savedTray) {
            try {
                new Gio.Settings({schema_id: KEYBINDINGS_SCHEMA}).set_strv(TRAY_KEY, this._savedTray);
            } catch (error) {
                console.error(`Stache: não consegui restaurar o atalho Super+V: ${error}`);
            }
            this._savedTray = null;
        }
        if (this._pasteTimeoutId) {
            GLib.source_remove(this._pasteTimeoutId);
            this._pasteTimeoutId = 0;
        }
        this._vkbd = null;
        this._previousWindow = null;
    }

    _readClipboard() {
        try {
            const mimes = this._selection.get_mimetypes(Meta.SelectionType.SELECTION_CLIPBOARD) ?? [];
            if (mimes.includes(PASSWORD_HINT))
                return;
        } catch (_error) { /* sem a lista de tipos, segue */ }
        this._readFiles();
        this._clipboard?.get_text(St.ClipboardType.CLIPBOARD, (_clipboard, text) => {
            if (text && text.trim()) {
                this._dbusObject?.emit_signal('ClipboardChanged', new GLib.Variant('(s)', [text]));
                return;
            }
            this._readImage();
        });
    }

    // Arquivos copiados no gerenciador de arquivos: o Stache mostra um aviso na cápsula.
    _readFiles() {
        let mimes = [];
        try {
            mimes = this._selection.get_mimetypes(Meta.SelectionType.SELECTION_CLIPBOARD) ?? [];
        } catch (_error) { return; }
        if (!mimes.includes('x-special/gnome-copied-files'))
            return;
        this._clipboard?.get_content(St.ClipboardType.CLIPBOARD, 'x-special/gnome-copied-files', (_clipboard, bytes) => {
            try {
                const text = new TextDecoder().decode(bytes?.get_data() ?? new Uint8Array());
                const paths = text.split('\n').slice(1)
                    .filter(line => line.startsWith('file://'))
                    .map(uri => Gio.File.new_for_uri(uri).get_path())
                    .filter(path => path);
                if (paths.length)
                    this._dbusObject?.emit_signal('FilesCopied', new GLib.Variant('(s)', [paths.join('\n')]));
            } catch (error) {
                console.error(`Stache: não consegui ler os arquivos copiados: ${error}`);
            }
        });
    }

    // Prints e imagens copiadas: grava o PNG numa pasta de entrada e avisa o Stache com o caminho.
    _readImage() {
        let mimes = [];
        try {
            mimes = this._selection.get_mimetypes(Meta.SelectionType.SELECTION_CLIPBOARD) ?? [];
        } catch (_error) { return; }
        if (!mimes.includes('image/png'))
            return;
        this._clipboard?.get_content(St.ClipboardType.CLIPBOARD, 'image/png', (_clipboard, bytes) => {
            try {
                const data = bytes?.get_data();
                if (!data || data.length === 0 || data.length > MAX_IMAGE_BYTES)
                    return;
                const dir = GLib.build_filenamev([GLib.get_user_data_dir(), 'com.alexlan.stache', 'clipboard-incoming']);
                GLib.mkdir_with_parents(dir, 0o700);
                const path = GLib.build_filenamev([dir, `${GLib.get_real_time()}.png`]);
                GLib.file_set_contents(path, data);
                this._dbusObject?.emit_signal('ClipboardImage', new GLib.Variant('(s)', [path]));
            } catch (error) {
                console.error(`Stache: não consegui guardar a imagem copiada: ${error}`);
            }
        });
    }

    _islandWindow() {
        return global.get_window_actors().map(actor => actor.meta_window).find(window => this._isIsland(window));
    }

    _onShortcut() {
        const focused = global.display.focus_window;
        // Lembra quem tinha o foco para devolvê-lo (e colar nele) depois.
        if (focused && !this._isIsland(focused))
            this._previousWindow = focused;
        this.FocusIsland();
        this._dbusObject?.emit_signal('ClipboardShortcut', null);
    }

    _onSearchShortcut() {
        const focused = global.display.focus_window;
        if (focused && !this._isIsland(focused))
            this._previousWindow = focused;
        this.FocusIsland();
        this._dbusObject?.emit_signal('SearchShortcut', null);
    }

    // Ids dos apps que têm pelo menos uma janela aberta (os demais estão em segundo plano).
    RunningApps() {
        try {
            return Shell.AppSystem.get_default().get_running()
                .filter(app => app.get_windows().length > 0)
                .map(app => app.get_id());
        } catch (error) {
            console.error(`Stache: não consegui listar os apps abertos: ${error}`);
            return [];
        }
    }

    // Se o aplicativo já tem janela aberta, traz a janela à frente (troca de área de trabalho e
    // restaura se minimizada) e devolve true; senão devolve false e o Stache o inicia.
    ActivateApp(desktopId) {
        try {
            const app = Shell.AppSystem.get_default().lookup_app(String(desktopId));
            const windows = app?.get_windows() ?? [];
            if (!windows.length)
                return false;
            const target = windows.find(window => window.has_focus()) ?? windows[0];
            Main.activateWindow(target);
            return true;
        } catch (error) {
            console.error(`Stache: não consegui ativar ${desktopId}: ${error}`);
            return false;
        }
    }

    FocusIsland() {
        this._islandWindow()?.activate(global.get_current_time());
    }

    // Posição do mouse relativa ao canto da janela da ilha, em pixels lógicos. Os mascotes usam para
    // seguir o cursor com os olhos: no Wayland o app não vê o mouse fora da própria janela.
    GetPointer() {
        const [x, y] = global.get_pointer();
        const rect = this._islandWindow()?.get_frame_rect();
        return rect ? [true, x - rect.x, y - rect.y] : [false, 0, 0];
    }

    SetClipboard(text) {
        this._clipboard?.set_text(St.ClipboardType.CLIPBOARD, String(text));
    }

    PasteImage(path) {
        try {
            const [ok, data] = GLib.file_get_contents(String(path));
            if (!ok)
                return;
            this._clipboard?.set_content(St.ClipboardType.CLIPBOARD, 'image/png', new GLib.Bytes(data));
        } catch (error) {
            console.error(`Stache: não consegui ler a imagem ${path}: ${error}`);
            return;
        }
        this._pasteIntoPrevious();
    }

    Paste(text) {
        this.SetClipboard(text);
        this._pasteIntoPrevious();
    }

    _pasteIntoPrevious() {
        const target = this._previousWindow;
        this._previousWindow = null;
        target?.activate(global.get_current_time());
        // Dá tempo de o foco voltar antes de digitar o atalho.
        if (this._pasteTimeoutId)
            GLib.source_remove(this._pasteTimeoutId);
        this._pasteTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 160, () => {
            this._pasteTimeoutId = 0;
            this._sendPaste(target);
            return GLib.SOURCE_REMOVE;
        });
    }

    _sendPaste(target) {
        try {
            if (!this._vkbd) {
                this._vkbd = Clutter.get_default_backend().get_default_seat()
                    .create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
            }
            const wmClass = (target?.get_wm_class() ?? '').toLowerCase();
            const keys = TERMINALS.some(name => wmClass.includes(name))
                ? [Clutter.KEY_Control_L, Clutter.KEY_Shift_L, Clutter.KEY_v]
                : [Clutter.KEY_Control_L, Clutter.KEY_v];
            const press = state => keys.forEach(key => this._vkbd.notify_keyval(GLib.get_monotonic_time(), key, state));
            press(Clutter.KeyState.PRESSED);
            keys.slice().reverse().forEach(key =>
                this._vkbd.notify_keyval(GLib.get_monotonic_time(), key, Clutter.KeyState.RELEASED));
        } catch (error) {
            console.error(`Stache: não consegui colar: ${error}`);
        }
    }

    SetHeight(height) {
        const numericHeight = Number(height);
        if (!Number.isFinite(numericHeight))
            return;

        this._height = Math.clamp(Math.round(numericHeight), 0, MAX_HEIGHT);
        this._syncGeometry();
        this._dbusObject?.emit_property_changed(
            'Height', new GLib.Variant('u', this._height));
    }

    get Height() {
        return this._height;
    }

    _syncGeometry() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!this._strut || !monitor)
            return;

        this._strut.set_position(monitor.x, monitor.y);
        this._strut.set_size(monitor.width, this._height);
        this._windowSignals?.forEach((_ids, window) => this._pin(window));
    }

    _isIsland(window) {
        return window.get_title() === WINDOW_TITLE;
    }

    _track(window) {
        if (!window || this._windowSignals.has(window))
            return;
        // O título só é definido depois da criação da janela.
        const ids = [
            window.connect('notify::title', () => this._adopt(window)),
            window.connect('unmanaged', () => this._untrack(window)),
        ];
        this._windowSignals.set(window, ids);
        this._adopt(window);
    }

    _adopt(window) {
        if (!this._isIsland(window) || this._windowSignals.get(window)?.length > 2)
            return;
        const ids = this._windowSignals.get(window);
        ids.push(
            window.connect('position-changed', () => this._pin(window)),
            window.connect('size-changed', () => this._pin(window)),
            window.connect('notify::above', () => this._pin(window, true)),
            window.connect('shown', () => this._pin(window, true)));
        this._pin(window, true);
        this._setBanners(false);
    }

    _untrack(window) {
        this._windowSignals?.get(window)?.forEach(id => window.disconnect(id));
        this._windowSignals?.delete(window);
        if (this._isIsland(window)) {
            this._setBanners(true);
            // Sem a ilha, as janelas voltam a ocupar o topo da tela.
            this._height = 0;
            this._syncGeometry();
        }
    }

    // O Stache mostra as notificações na própria ilha; enquanto a ilha existe,
    // os banners do GNOME ficam desligados (como no modo Não Perturbe) e a
    // configuração original volta quando ela fecha. As notificações continuam
    // chegando ao Stache e à lista do GNOME.
    _setBanners(show) {
        if (!this._notificationSettings)
            this._notificationSettings = new Gio.Settings({schema_id: NOTIFICATION_SCHEMA});
        const settings = this._notificationSettings;
        if (!show) {
            if (this._bannersHidden || !settings.get_boolean(SHOW_BANNERS_KEY))
                return;
            this._bannersHidden = true;
            settings.set_boolean(SHOW_BANNERS_KEY, false);
        } else if (this._bannersHidden) {
            this._bannersHidden = false;
            settings.set_boolean(SHOW_BANNERS_KEY, true);
        }
    }

    // Mantém a ilha colada ao topo, centralizada, à frente de tudo e em
    // todas as áreas de trabalho. Wayland não permite que o cliente faça isso.
    _pin(window, raise = false) {
        if (this._pinning || !this._isIsland(window))
            return;
        this._pinning = true;
        try {
            if (!window.above)
                window.make_above();
            if (!window.on_all_workspaces)
                window.stick();
            const monitor = Main.layoutManager.primaryMonitor;
            const frame = window.get_frame_rect();
            const x = Math.round(monitor.x + (monitor.width - frame.width) / 2);
            const y = monitor.y;
            if (frame.x !== x || frame.y !== y)
                window.move_frame(true, x, y);
            if (raise)
                window.raise();

            // O Mutter mantém janelas comuns dentro da área de trabalho, ou
            // seja, abaixo da faixa reservada. Compensa visualmente a folga.
            const actor = window.get_compositor_private();
            if (actor) {
                const gap = window.get_frame_rect().y - monitor.y;
                actor.translation_y = -gap;
            }
        } finally {
            this._pinning = false;
        }
    }

    disable() {
        this._disableClipboard();
        if (this._windowCreatedId) {
            global.display.disconnect(this._windowCreatedId);
            this._windowCreatedId = 0;
        }
        [...(this._windowSignals?.keys() ?? [])].forEach(window => {
            this._untrack(window);
            const actor = window.get_compositor_private();
            if (actor)
                actor.translation_y = 0;
            window.unmake_above();
            window.unstick();
        });
        this._windowSignals = null;
        this._setBanners(true);
        this._notificationSettings = null;
        if (this._monitorsChangedId) {
            Main.layoutManager.disconnect(this._monitorsChangedId);
            this._monitorsChangedId = 0;
        }
        if (this._busOwnerId) {
            Gio.bus_unown_name(this._busOwnerId);
            this._busOwnerId = 0;
        }
        this._dbusObject?.unexport();
        this._dbusObject = null;
        this._strut?.destroy();
        this._strut = null;
        this._height = 0;
    }
}
