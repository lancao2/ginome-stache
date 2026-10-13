#[cfg(target_os = "linux")]
use std::process::{Command, Stdio};

#[cfg(target_os = "linux")]
use std::{collections::HashMap, fs};

#[cfg(target_os = "linux")]
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::Serialize;
#[cfg(target_os = "linux")]
use url::Url;
#[cfg(target_os = "linux")]
use zbus::{blocking::{Connection, Proxy}, zvariant::OwnedValue};

mod ai_usage;
mod apps;
mod autostart;
mod background;
mod calendar;
mod clipboard;
mod codex;
mod context;
mod controls;
mod notifications;
mod plugins;
mod pointer;
mod search;
mod session;
mod suggest;
mod tasks;
mod vault;
mod web;
mod whatsapp;

use tauri::{AppHandle, LogicalSize, Manager, PhysicalPosition, WebviewWindow};

// A janela tem largura fixa e a altura acompanha a ilha; a escala escolhida
// nos ajustes do Stache chega aqui já aplicada à altura.
const COMPACT_SIZE: (f64, f64) = (760.0, 30.0);
const MIN_HEIGHT: f64 = 24.0;
const MAX_HEIGHT: f64 = 460.0;
const TOP_MARGIN: f64 = 0.0;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MediaTrack {
    title: String,
    artist: String,
    album: String,
    accent: String,
    duration: f64,
    position: f64,
    artwork: Option<String>,
    source: String,
    can_go_next: bool,
    can_go_previous: bool,
}

#[derive(Serialize)]
struct MediaState {
    active: bool,
    playing: bool,
    track: Option<MediaTrack>,
}

#[cfg(target_os = "linux")]
fn metadata_string(metadata: &HashMap<String, OwnedValue>, key: &str) -> String {
    metadata.get(key)
        .and_then(|value| String::try_from(value.clone()).ok())
        .unwrap_or_default()
}

#[cfg(target_os = "linux")]
fn metadata_artists(metadata: &HashMap<String, OwnedValue>) -> String {
    metadata.get("xesam:artist")
        .and_then(|value| Vec::<String>::try_from(value.clone()).ok())
        .map(|artists| artists.join(", "))
        .unwrap_or_default()
}

#[cfg(target_os = "linux")]
fn metadata_i64(metadata: &HashMap<String, OwnedValue>, key: &str) -> i64 {
    let Some(value) = metadata.get(key) else { return 0 };
    i64::try_from(value.clone()).ok()
        .or_else(|| u64::try_from(value.clone()).ok().and_then(|number| i64::try_from(number).ok()))
        .unwrap_or_default()
}

#[cfg(target_os = "linux")]
fn artwork_data_url(raw_url: &str) -> Option<String> {
    let parsed = Url::parse(raw_url).ok()?;
    if matches!(parsed.scheme(), "http" | "https") {
        return Some(raw_url.to_owned());
    }
    if parsed.scheme() != "file" {
        return None;
    }

    let path = parsed.to_file_path().ok()?;
    let metadata = fs::metadata(&path).ok()?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > 5 * 1024 * 1024 {
        return None;
    }
    let bytes = fs::read(path).ok()?;
    let mime = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        "image/png"
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        "image/jpeg"
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        "image/gif"
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        "image/webp"
    } else {
        return None;
    };
    Some(format!("data:{mime};base64,{}", BASE64.encode(bytes)))
}

#[cfg(target_os = "linux")]
fn friendly_app_name(identity: String, bus_name: &str) -> String {
    if !identity.trim().is_empty() {
        return identity;
    }
    bus_name
        .trim_start_matches("org.mpris.MediaPlayer2.")
        .split('.')
        .next()
        .unwrap_or("Reprodutor")
        .to_owned()
}

#[cfg(target_os = "linux")]
fn media_player() -> Result<(String, MediaTrack, bool), String> {
    let connection = Connection::session().map_err(|error| error.to_string())?;
    let dbus = zbus::blocking::fdo::DBusProxy::new(&connection)
        .map_err(|error| error.to_string())?;
    let names = dbus.list_names().map_err(|error| error.to_string())?;

    let mut paused_player = None;
    for name in names {
        let bus_name = name.as_str();
        if !bus_name.starts_with("org.mpris.MediaPlayer2.") {
            continue;
        }
        // O som de notificação do próprio Stache (webview) também aparece como
        // sessão MPRIS; não é mídia do usuário.
        let own_pid = std::process::id();
        let owner_pid = zbus::names::BusName::try_from(bus_name)
            .ok()
            .and_then(|n| dbus.get_connection_unix_process_id(n).ok());
        if owner_pid == Some(own_pid) || bus_name.contains(&format!("instance{own_pid}")) {
            continue;
        }
        let Ok(player) = Proxy::new(
            &connection,
            bus_name,
            "/org/mpris/MediaPlayer2",
            "org.mpris.MediaPlayer2.Player",
        ) else { continue };
        let status: String = player.get_property("PlaybackStatus").unwrap_or_default();
        if status != "Playing" && status != "Paused" {
            continue;
        }

        let metadata: HashMap<String, OwnedValue> =
            player.get_property("Metadata").unwrap_or_default();
        let title = metadata_string(&metadata, "xesam:title");
        if title.trim().is_empty() {
            continue;
        }
        let root = Proxy::new(
            &connection,
            bus_name,
            "/org/mpris/MediaPlayer2",
            "org.mpris.MediaPlayer2",
        ).ok();
        let identity = root.as_ref()
            .and_then(|proxy| proxy.get_property::<String>("Identity").ok())
            .unwrap_or_default();
        if identity.eq_ignore_ascii_case("stache") {
            continue;
        }
        let art_url = metadata_string(&metadata, "mpris:artUrl");
        let duration = metadata_i64(&metadata, "mpris:length").max(0) as f64 / 1_000_000.0;
        let position = player.get_property::<i64>("Position").unwrap_or_default().max(0) as f64 / 1_000_000.0;
        let track = MediaTrack {
            title,
            artist: metadata_artists(&metadata),
            album: metadata_string(&metadata, "xesam:album"),
            accent: "#8b5cf6".to_owned(),
            duration,
            position,
            artwork: artwork_data_url(&art_url),
            source: friendly_app_name(identity, bus_name),
            can_go_next: player.get_property("CanGoNext").unwrap_or(false),
            can_go_previous: player.get_property("CanGoPrevious").unwrap_or(false),
        };
        let result = (bus_name.to_owned(), track, status == "Playing");
        if result.2 {
            return Ok(result);
        }
        paused_player.get_or_insert(result);
    }
    paused_player.ok_or_else(|| "no media session is available".to_owned())
}

#[cfg(target_os = "linux")]
fn run_media_action(action: &str) -> Result<(), String> {
    let (bus_name, _, _) = media_player()?;
    let connection = Connection::session().map_err(|error| error.to_string())?;
    let player = Proxy::new(
        &connection,
        bus_name,
        "/org/mpris/MediaPlayer2",
        "org.mpris.MediaPlayer2.Player",
    ).map_err(|error| error.to_string())?;
    let method = match action {
        "play_pause" => "PlayPause",
        "next" => "Next",
        "previous" => "Previous",
        _ => return Err("unsupported media action".to_owned()),
    };
    player.call_method(method, &()).map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn get_media_state() -> MediaState {
    #[cfg(target_os = "linux")]
    if let Ok((_, track, playing)) = media_player() {
        return MediaState { active: true, playing, track: Some(track) };
    }
    MediaState { active: false, playing: false, track: None }
}

#[tauri::command]
fn get_user_name() -> String {
    #[cfg(target_os = "linux")]
    {
        let login = std::env::var("USER").unwrap_or_default();
        // Prefere o primeiro nome cadastrado no sistema (campo GECOS).
        let full = fs::read_to_string("/etc/passwd").ok().and_then(|passwd| {
            passwd.lines().find_map(|line| {
                let fields: Vec<&str> = line.split(':').collect();
                (fields.first() == Some(&login.as_str()))
                    .then(|| fields.get(4).and_then(|gecos| gecos.split(',').next()).unwrap_or("").to_owned())
            })
        });
        let name = full
            .and_then(|text| text.split_whitespace().next().map(str::to_owned))
            .filter(|text| !text.is_empty())
            .unwrap_or(login);
        let mut chars = name.chars();
        return chars.next().map(|first| first.to_uppercase().chain(chars).collect()).unwrap_or_default();
    }
    #[cfg(not(target_os = "linux"))]
    std::env::var("USERNAME").unwrap_or_default()
}

#[tauri::command]
fn media_action(action: String) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    return run_media_action(&action);
    #[cfg(not(target_os = "linux"))]
    Err(format!("media controls are not implemented on this platform: {action}"))
}

/// Mostra a ilha (posição, tamanho e espaço reservado no GNOME).
pub(crate) fn show_island(app: &AppHandle) -> Result<(), String> {
    let window = app.get_webview_window("main")
        .ok_or_else(|| "main window is unavailable".to_owned())?;
    window.show().map_err(|error| error.to_string())?;
    configure_island_window(&window, COMPACT_SIZE.1)?;
    sync_reserved_height(COMPACT_SIZE.1 as u32);
    Ok(())
}

/// Esconde a janela (tela bloqueada) sem mexer no espaço reservado.
pub(crate) fn hide_island(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") { let _ = window.hide(); }
}

#[tauri::command]
fn set_media_visibility(app: AppHandle, visible: bool) -> Result<(), String> {
    // Com a tela bloqueada a janela espera: ela aparece quando o GNOME for desbloqueado.
    let show_now = session::set_wanted(visible);
    if visible {
        if show_now { show_island(&app)?; }
    } else {
        let window = app.get_webview_window("main")
            .ok_or_else(|| "main window is unavailable".to_owned())?;
        window.hide().map_err(|error| error.to_string())?;
        sync_reserved_height(0);
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn sync_reserved_height(height: u32) {
    use std::sync::atomic::{AtomicU32, Ordering};
    // O GNOME refaz o layout a cada chamada; só avisa quando o valor muda.
    static LAST: AtomicU32 = AtomicU32::new(u32::MAX);
    // Cada pedido novo cancela as tentativas pendentes do anterior.
    static GENERATION: AtomicU32 = AtomicU32::new(0);
    if LAST.swap(height, Ordering::Relaxed) == height {
        return;
    }
    let generation = GENERATION.fetch_add(1, Ordering::Relaxed) + 1;
    std::thread::spawn(move || {
        // Iniciado junto com a sessão, o app pode subir antes da extensão do Stache no GNOME Shell:
        // tenta de novo por até 2 minutos, até o serviço dela aparecer no barramento.
        for _ in 0..240 {
            if GENERATION.load(Ordering::Relaxed) != generation { return; }
            let delivered = Command::new("gdbus")
                .args([
                    "call", "--session",
                    "--dest", "org.gnome.Shell.Extensions.Stache",
                    "--object-path", "/org/gnome/Shell/Extensions/Stache",
                    "--method", "org.gnome.Shell.Extensions.Stache.SetHeight",
                    &height.to_string(),
                ])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .is_ok_and(|status| status.success());
            if delivered { return; }
            std::thread::sleep(std::time::Duration::from_millis(500));
        }
    });
}

#[cfg(not(target_os = "linux"))]
fn sync_reserved_height(_height: u32) {}

fn resize_island(window: &WebviewWindow, height: f64) -> Result<(), String> {
    let height = height.clamp(MIN_HEIGHT, MAX_HEIGHT);
    let current = window.inner_size().map_err(|error| error.to_string())?;
    let scale = window.scale_factor().map_err(|error| error.to_string())?;
    // Só cresce. Encolher a janela transparente no fim da animação de
    // fechamento faz o WebKit repintar tudo (a "piscada"); o espaço extra é
    // invisível e não recebe cliques, pois `set_input_region` limita a área.
    if current.height as f64 >= (height * scale).round() - 1.0 {
        return Ok(());
    }
    window
        .set_size(LogicalSize::new(COMPACT_SIZE.0, height))
        .map_err(|error| error.to_string())
}

fn position_island(window: &WebviewWindow, height: f64) -> Result<(), String> {
    let (width, height) = (COMPACT_SIZE.0, height.clamp(MIN_HEIGHT, MAX_HEIGHT));

    window
        .set_size(LogicalSize::new(width, height))
        .map_err(|error| error.to_string())?;

    let monitor = window
        .current_monitor()
        .map_err(|error| error.to_string())?
        .or_else(|| window.primary_monitor().ok().flatten());

    if let Some(monitor) = monitor {
        let scale = monitor.scale_factor();
        let window_width = (width * scale).round() as i32;
        let monitor_position = monitor.position();
        let monitor_size = monitor.size();
        let x = monitor_position.x + (monitor_size.width as i32 - window_width) / 2;
        let y = monitor_position.y + (TOP_MARGIN * scale).round() as i32;
        window
            .set_position(PhysicalPosition::new(x, y))
            .map_err(|error| error.to_string())?;
    }

    Ok(())
}

/// Libera o microfone na webview (respostas em áudio do WhatsApp); o WebKit
/// nega por padrão e o Stache não tem outra tela para pedir permissão.
#[cfg(target_os = "linux")]
fn allow_microphone(window: &WebviewWindow) {
    let _ = window.with_webview(|webview| {
        use webkit2gtk::glib::ObjectExt;
        use webkit2gtk::{PermissionRequestExt, SettingsExt, UserMediaPermissionRequest, WebViewExt};
        let view = webview.inner();
        if let Some(settings) = WebViewExt::settings(&view) {
            settings.set_enable_media_stream(true);
        }
        view.connect_permission_request(|_, request| {
            if request.is::<UserMediaPermissionRequest>() {
                request.allow();
                return true;
            }
            false
        });
    });
}

#[cfg(not(target_os = "linux"))]
fn allow_microphone(_window: &WebviewWindow) {}

fn configure_island_window(window: &WebviewWindow, height: f64) -> Result<(), String> {
    window
        .set_always_on_top(true)
        .map_err(|error| error.to_string())?;
    window
        .set_skip_taskbar(true)
        .map_err(|error| error.to_string())?;

    #[cfg(target_os = "linux")]
    {
        use gtk::prelude::*;
        if let Ok(gtk_window) = window.gtk_window() {
            gtk_window.set_type_hint(gtk::gdk::WindowTypeHint::Utility);
            gtk_window.set_keep_above(true);
        }
    }

    position_island(window, height)
}

#[tauri::command]
fn set_island_expanded(app: AppHandle, height: f64, reserved: Option<f64>) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window is unavailable".to_string())?;
    // Só redimensiona: refazer dicas de janela e posição a cada troca faz o
    // compositor repintar a janela, e isso aparecia como uma piscada ao recolher.
    resize_island(&window, height)?;
    // O painel expandido flutua sobre as janelas; só a cápsula reserva espaço.
    sync_reserved_height(reserved.unwrap_or(COMPACT_SIZE.1).round() as u32);
    Ok(())
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    whatsapp::stop(&app);
    codex::stop(&app);
    // A extensão do GNOME libera o espaço reservado quando a janela some.
    app.exit(0);
}

/// Só o desenho da ilha recebe cliques; o resto da janela transparente deixa
/// o mouse passar para as janelas de baixo. `width` e `height` são da ilha,
/// em pixels lógicos, e as "orelhas" de 14 px de cada lado entram na conta.
#[tauri::command]
fn set_input_region(app: AppHandle, width: f64, height: f64) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let window = app.get_webview_window("main")
            .ok_or_else(|| "main window is unavailable".to_owned())?;
        let target = window.clone();
        window.run_on_main_thread(move || {
            use gtk::prelude::*;
            let Ok(gtk_window) = target.gtk_window() else { return };
            let Some(surface) = gtk_window.window() else { return };
            let ears = 14.0;
            let total = (width + ears * 2.0).round() as i32;
            let x = ((gtk_window.allocated_width() - total) / 2).max(0);
            let rectangle = gtk::cairo::RectangleInt::new(x, 0, total, height.round() as i32);
            surface.input_shape_combine_region(&gtk::cairo::Region::create_rectangle(&rectangle), 0, 0);
        }).map_err(|error| error.to_string())?;
    }
    #[cfg(not(target_os = "linux"))]
    let _ = (app, width, height);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // `stache --autostart enable|disable`: registra (ou remove) o início com a sessão, sem abrir a janela.
    let args: Vec<String> = std::env::args().collect();
    if let Some(at) = args.iter().position(|arg| arg == "--autostart") {
        let enable = args.get(at + 1).is_some_and(|value| value == "enable");
        match autostart::autostart_set(enable) {
            Ok(()) => { println!("Início automático {}.", if enable { "ativado" } else { "desativado" }); std::process::exit(0); }
            Err(error) => { eprintln!("{error}"); std::process::exit(1); }
        }
    }

    // No Wayland o app não consegue se esconder da dock nem ficar à frente das
    // outras janelas; pelo XWayland as dicas de janela (fora da barra de
    // tarefas, sempre no topo) funcionam. STACHE_WAYLAND=1 mantém o Wayland nativo.
    #[cfg(target_os = "linux")]
    if std::env::var_os("GDK_BACKEND").is_none()
        && std::env::var_os("STACHE_WAYLAND").is_none()
        // Iniciado cedo pelo systemd, o app pode não herdar XDG_SESSION_TYPE: o socket do Wayland basta.
        && (std::env::var("XDG_SESSION_TYPE").is_ok_and(|kind| kind == "wayland")
            || (std::env::var_os("XDG_SESSION_TYPE").is_none() && std::env::var_os("WAYLAND_DISPLAY").is_some()))
        && std::env::var_os("DISPLAY").is_some()
    {
        // Antes de qualquer thread ou da inicialização do GTK.
        unsafe { std::env::set_var("GDK_BACKEND", "x11") };
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            app.manage(tasks::Database::open(app.handle())?);
            app.manage(whatsapp::Bridge::default());
            app.manage(codex::Bridge::default());
            app.manage(std::sync::Arc::new(search::Search::default()));
            app.manage(std::sync::Arc::new(apps::Apps::default()));
            app.manage(std::sync::Arc::new(calendar::Calendar::default()));
            app.manage(std::sync::Arc::new(plugins::Plugins::default()));
            session::start(app.handle().clone());
            std::thread::spawn(autostart::ensure_extension_enabled);
            notifications::start_monitor(app.handle().clone());
            clipboard::start(app.handle().clone());
            search::start(app.handle().clone());
            context::start(app.handle().clone());
            calendar::start(app.handle().clone());
            plugins::start(app.handle().clone());
            controls::start_charging_monitor(app.handle().clone());
            if let Some(window) = app.get_webview_window("main") {
                if let Err(error) = configure_island_window(&window, COMPACT_SIZE.1) {
                    eprintln!("failed to position Stache: {error}");
                }
                sync_reserved_height(0);
                allow_microphone(&window);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            set_island_expanded,
            get_media_state,
            get_user_name,
            media_action,
            set_media_visibility,
            set_input_region,
            quit_app,
            ai_usage::get_ai_usage,
            pointer::pointer_position,
            controls::get_controls,
            controls::get_charging,
            search::search_prepare,
            search::search_query,
            search::search_open,
            search::search_web,
            apps::search_apps,
            background::background_apps,
            autostart::autostart_status,
            autostart::autostart_set,
            calendar::calendar_agenda,
            vault::vault_status,
            plugins::plugins_list,
            plugins::plugins_set_enabled,
            plugins::plugins_set_setting,
            plugins::plugins_cards,
            plugins::plugin_action,
            plugins::plugins_install_examples,
            plugins::plugins_open_dir,
            calendar::calendar_sources,
            calendar::calendar_range,
            calendar::calendar_add,
            calendar::calendar_remove,
            calendar::calendar_set_color,
            context::capture_state,
            suggest::search_suggestions,
            web::search_web_sites,
            web::search_open_url,
            apps::search_launch,
            controls::set_volume,
            controls::set_muted,
            controls::set_brightness,
            controls::set_toggle,
            controls::set_power_profile,
            controls::system_action,
            notifications::list_notifications,
            notifications::clear_notifications,
            notifications::delete_notification,
            tasks::list_tasks,
            tasks::create_task,
            tasks::update_task,
            tasks::set_task_done,
            tasks::delete_task,
            whatsapp::whatsapp_start,
            whatsapp::whatsapp_send,
            codex::codex_start,
            codex::codex_send,
            codex::pick_folder,
            clipboard::clipboard_list,
            clipboard::clipboard_toggle_favorite,
            clipboard::clipboard_delete,
            clipboard::clipboard_clear,
            clipboard::clipboard_paste,
            clipboard::clipboard_focus
        ])
        .build(tauri::generate_context!())
        .expect("error while building Stache")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                whatsapp::stop(app);
                codex::stop(app);
            }
        });
}
