<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";

import { COMPACT_SCALE_RANGE, EXPANDED_SCALE_RANGE, useStacheSettings } from "../composables/useStacheSettings";
import { useControls } from "../composables/useControls";
import type { SystemAction } from "../types/controls";
import { CALENDAR_COLORS, useCalendar } from "../composables/useCalendar";
import { IN_VAULT, usePlugins } from "../composables/usePlugins";

const emit = defineEmits<{ close: [] }>();
const { state, error, load, setVolume, setMuted, setBrightness, setToggle, setPowerProfile, run } = useControls();

const { compactScale, expandedScale, reset } = useStacheSettings();
const quitArmed = ref(false);
let quitTimer: number | undefined;

// Recarrega a interface; tarefas, notificações e limites são lidos de novo.
function refreshApp() {
  window.location.reload();
}

function quitApp() {
  if (!quitArmed.value) {
    quitArmed.value = true;
    window.clearTimeout(quitTimer);
    quitTimer = window.setTimeout(() => { quitArmed.value = false; }, 3_000);
    return;
  }
  void invoke("quit_app");
}
const view = ref<"main" | "stache" | "background" | "calendars" | "plugins">("main");

// Início automático com a sessão do GNOME (serviço de usuário do systemd).
const autostart = ref<{ enabled: boolean; available: boolean; reason: string }>({ enabled: false, available: false, reason: "" });
const autostartError = ref("");
async function loadAutostart() {
  try { autostart.value = await invoke("autostart_status"); } catch { /* Browser preview. */ }
}
async function toggleAutostart() {
  autostartError.value = "";
  try { await invoke("autostart_set", { enabled: !autostart.value.enabled }); } catch (cause) { autostartError.value = String(cause); }
  await loadAutostart();
}
onMounted(() => void loadAutostart());

const pluginStore = usePlugins();
const { plugins: pluginList, loadErrors: pluginErrors, failure: pluginFailure } = pluginStore;
// Ligar um plugin é aprovar as permissões que ele mostra; por isso pede um segundo clique.
const reviewing = ref<string | null>(null);
function openPlugins() { view.value = "plugins"; reviewing.value = null; void pluginStore.loadList(); void loadVault(); }
function togglePlugin(id: string, enabled: boolean) {
  if (!enabled) { void pluginStore.setEnabled(id, false); return; }
  if (reviewing.value !== id) { reviewing.value = id; return; }
  reviewing.value = null;
  void pluginStore.setEnabled(id, true);
}
const settingTimers = new Map<string, number>();
function editSetting(id: string, key: string, value: string) {
  window.clearTimeout(settingTimers.get(`${id}/${key}`));
  settingTimers.set(`${id}/${key}`, window.setTimeout(() => void pluginStore.setSetting(id, key, value), 600));
}

// Onde os segredos ficam: GNOME Keyring (ideal) ou, se ele faltar, um arquivo 0600.
const vault = ref<{ backend: "keyring" | "file"; inFile: number; message: string } | null>(null);
async function loadVault() {
  try { vault.value = await invoke("vault_status"); } catch { vault.value = null; }
}

const agenda = useCalendar();
const { sources: calendarSources, errors: calendarErrors, failure: calendarFailure } = agenda;
const calendarName = ref("");
const calendarUrl = ref("");
const calendarBusy = ref(false);
// Cor da agenda nova (vazia = a primeira livre da paleta) e agenda cuja cor está sendo trocada.
const newColor = ref("");
const editingColor = ref<number | null>(null);
function openCalendars() { view.value = "calendars"; void agenda.load(); void loadVault(); }
async function addCalendar() {
  if (!calendarUrl.value.trim() || calendarBusy.value) return;
  calendarBusy.value = true;
  const saved = await agenda.add(calendarName.value, calendarUrl.value, newColor.value || null);
  calendarBusy.value = false;
  if (saved) { calendarName.value = ""; calendarUrl.value = ""; newColor.value = ""; }
  void loadVault();
}

interface BackgroundApp { id: string; name: string; icon: string; processes: number; memoryMb: number; hasWindow: boolean }
const background = ref<BackgroundApp[]>([]);
const windowsKnown = ref(true);
const backgroundLoaded = ref(false);
let backgroundTimer: number | undefined;
async function loadBackground() {
  try {
    const found = await invoke<{ apps: BackgroundApp[]; windowsKnown: boolean }>("background_apps");
    background.value = found.apps;
    windowsKnown.value = found.windowsKnown;
  } catch { /* Browser preview. */ }
  backgroundLoaded.value = true;
}
function openBackground() {
  view.value = "background";
  backgroundLoaded.value = false;
  void loadBackground();
  window.clearInterval(backgroundTimer);
  backgroundTimer = window.setInterval(() => void loadBackground(), 3_000);
}
watch(view, (now) => { if (now !== "background") window.clearInterval(backgroundTimer); });
const memory = (mb: number) => (mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`);
const dragging = ref(false);
let refreshTimer: number | undefined;
onMounted(() => {
  void load();
  refreshTimer = window.setInterval(() => { if (!dragging.value) void load(); }, 2_500);
});
onBeforeUnmount(() => { window.clearInterval(refreshTimer); window.clearInterval(backgroundTimer); });

const armed = ref<SystemAction | null>(null);
let armTimer: number | undefined;

// Ações destrutivas pedem um segundo clique para confirmar.
function power(action: SystemAction) {
  if (armed.value !== action) {
    armed.value = action;
    window.clearTimeout(armTimer);
    armTimer = window.setTimeout(() => { armed.value = null; }, 3_000);
    return;
  }
  armed.value = null;
  void run(action);
}

function simple(action: SystemAction) {
  void run(action);
  // A captura abre a interface do GNOME; a ilha sai da frente.
  if (action === "screenshot" || action === "settings") emit("close");
}

const profiles = [
  { id: "power-saver", label: "Economia" },
  { id: "balanced", label: "Equilibrado" },
  { id: "performance", label: "Desempenho" },
];
const profileLabel = computed(() => profiles.find((profile) => profile.id === state.value.powerProfile)?.label ?? "Indisponível");
function cycleProfile() {
  const index = profiles.findIndex((profile) => profile.id === state.value.powerProfile);
  void setPowerProfile(profiles[(index + 1) % profiles.length].id);
}

const volumeIcon = computed(() => (state.value.muted || state.value.volume === 0 ? "mute" : state.value.volume < 50 ? "low" : "high"));
const fill = (value: number) => ({ "--fill": `${value}%` });
const onLabel = (on: boolean) => (on ? "Ativado" : "Desativado");
const batteryLabel = computed(() => (state.value.battery === null ? "" : `${state.value.battery}%${state.value.charging ? " · carregando" : ""}`));
</script>

<template>
  <div class="cc" role="dialog" aria-label="Central de controle">
    <template v-if="view === 'main'">
    <div class="cc-grid">
      <section class="cc-card cc-card--list" aria-label="Conexões">
        <button type="button" class="cc-item" :aria-pressed="state.wifi" @click="setToggle('wifi', !state.wifi)">
          <span class="cc-dot cc-dot--blue" :class="{ 'is-on': state.wifi }"><svg viewBox="0 0 24 24"><path d="M2 9a15 15 0 0 1 20 0M5 12.5a10.5 10.5 0 0 1 14 0M8.5 16a5.5 5.5 0 0 1 7 0M12 19.5v.01" /></svg></span>
          <span class="cc-item-text"><strong>Wi-Fi</strong><small>{{ onLabel(state.wifi) }}</small></span>
        </button>
        <button type="button" class="cc-item" :aria-pressed="state.bluetooth" @click="setToggle('bluetooth', !state.bluetooth)">
          <span class="cc-dot cc-dot--blue" :class="{ 'is-on': state.bluetooth }"><svg viewBox="0 0 24 24"><path d="m7 7 10 10-5 5V2l5 5L7 17" /></svg></span>
          <span class="cc-item-text"><strong>Bluetooth</strong><small>{{ onLabel(state.bluetooth) }}</small></span>
        </button>
        <button type="button" class="cc-item" :aria-pressed="state.airplane" @click="setToggle('airplane', !state.airplane)">
          <span class="cc-dot cc-dot--orange" :class="{ 'is-on': state.airplane }"><svg viewBox="0 0 24 24"><path d="M10.5 13.5 3 11l1-2 8 1 4-6a1.5 1.5 0 0 1 2.6 1.4L16 11l5 1.5V15l-6-.5-3 6h-2z" /></svg></span>
          <span class="cc-item-text"><strong>Modo avião</strong><small>{{ onLabel(state.airplane) }}</small></span>
        </button>
      </section>

      <section class="cc-card cc-card--list" aria-label="Ajustes rápidos">
        <button type="button" class="cc-item" :aria-pressed="state.nightLight" @click="setToggle('nightlight', !state.nightLight)">
          <span class="cc-dot cc-dot--amber" :class="{ 'is-on': state.nightLight }"><svg viewBox="0 0 24 24"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5" /></svg></span>
          <span class="cc-item-text"><strong>Luz noturna</strong><small>{{ onLabel(state.nightLight) }}</small></span>
        </button>
        <button type="button" class="cc-item" :aria-pressed="state.micMuted" @click="setMuted('mic', !state.micMuted)">
          <span class="cc-dot cc-dot--red" :class="{ 'is-on': state.micMuted }"><svg viewBox="0 0 24 24"><path d="M12 3a3 3 0 0 1 3 3v5a3 3 0 0 1-6 3zM5 11a7 7 0 0 0 14 0M12 18v3M4 4l16 16" /></svg></span>
          <span class="cc-item-text"><strong>Microfone</strong><small>{{ state.micMuted ? "Mudo" : "Ativo" }}</small></span>
        </button>
        <button type="button" class="cc-item" @click="cycleProfile">
          <span class="cc-dot cc-dot--green is-on"><svg viewBox="0 0 24 24"><path d="M13 2 4 14h7l-1 8 9-12h-7z" /></svg></span>
          <span class="cc-item-text"><strong>Energia</strong><small>{{ profileLabel }}</small></span>
        </button>
      </section>

      <section class="cc-col">
        <div v-if="state.brightness !== null" class="cc-card cc-card--slider">
          <strong>Brilho</strong>
          <label class="cc-fat">
            <input type="range" min="3" max="100" :value="state.brightness" :style="fill(state.brightness)" aria-label="Brilho" @input="setBrightness(Number(($event.target as HTMLInputElement).value))" @pointerdown="dragging = true" @pointerup="dragging = false" />
            <svg class="cc-fat-icon" :class="{ 'is-dark': state.brightness > 12 }" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>
          </label>
        </div>
        <div class="cc-card cc-card--slider">
          <strong>Som</strong>
          <div class="cc-fat">
            <input type="range" min="0" max="100" :value="state.muted ? 0 : state.volume" :style="fill(state.muted ? 0 : state.volume)" aria-label="Volume" @input="setVolume(Number(($event.target as HTMLInputElement).value))" @pointerdown="dragging = true" @pointerup="dragging = false" />
            <button type="button" class="cc-fat-icon cc-fat-icon--btn" :class="{ 'is-dark': !state.muted && state.volume > 12 }" :aria-label="state.muted ? 'Ativar som' : 'Silenciar'" @click="setMuted('speaker', !state.muted)">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" />
                <path v-if="volumeIcon === 'low' || volumeIcon === 'high'" d="M15.5 9.5a3.5 3.5 0 0 1 0 5" />
                <path v-if="volumeIcon === 'high'" d="M18 7a7 7 0 0 1 0 10" />
                <path v-if="volumeIcon === 'mute'" d="m16 9.5 5 5m0-5-5 5" />
              </svg>
            </button>
          </div>
        </div>
        <span v-if="batteryLabel" class="cc-battery">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 8.5A1.5 1.5 0 0 1 4.5 7h13A1.5 1.5 0 0 1 19 8.5v7a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 3 15.5zM21 10.5v3" /></svg>
          {{ batteryLabel }}
        </span>
      </section>
    </div>

    <div class="cc-dock" aria-label="Ações do sistema">
      <button type="button" class="cc-circle" title="Captura de tela" aria-label="Captura de tela" @click="simple('screenshot')">
        <svg viewBox="0 0 24 24"><path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2M9 12h6" /></svg>
      </button>
      <button type="button" class="cc-circle" title="Configurações" aria-label="Configurações" @click="simple('settings')">
        <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1" /></svg>
      </button>
      <button type="button" class="cc-circle" title="Bloquear tela" aria-label="Bloquear tela" @click="simple('lock')">
        <svg viewBox="0 0 24 24"><path d="M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3" /></svg>
      </button>
      <button type="button" class="cc-circle" title="Ajustes do Stache" aria-label="Ajustes do Stache" @click="view = 'stache'">
        <svg viewBox="0 0 24 24"><path d="M4 7h9m4 0h3M4 17h3m4 0h9M13 4v6m-6 4v6" /></svg>
      </button>
      <button type="button" class="cc-circle" title="Apps em segundo plano" aria-label="Apps em segundo plano" @click="openBackground">
        <svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h10" /></svg>
      </button>
      <span class="cc-dock-sep" aria-hidden="true" />
      <button type="button" class="cc-circle" :class="{ 'is-armed': armed === 'suspend' }" :title="armed === 'suspend' ? 'Clique para confirmar' : 'Suspender'" aria-label="Suspender" @click="power('suspend')">
        <svg viewBox="0 0 24 24"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5" /></svg>
      </button>
      <button type="button" class="cc-circle" :class="{ 'is-armed': armed === 'logout' }" :title="armed === 'logout' ? 'Clique para confirmar' : 'Encerrar sessão'" aria-label="Encerrar sessão" @click="power('logout')">
        <svg viewBox="0 0 24 24"><path d="M9 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h4M16 8l4 4-4 4M20 12H9" /></svg>
      </button>
      <button type="button" class="cc-circle" :class="{ 'is-armed': armed === 'reboot' }" :title="armed === 'reboot' ? 'Clique para confirmar' : 'Reiniciar'" aria-label="Reiniciar" @click="power('reboot')">
        <svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.5-5.8M20 4v5h-5" /></svg>
      </button>
      <button type="button" class="cc-circle cc-circle--danger" :class="{ 'is-armed': armed === 'poweroff' }" :title="armed === 'poweroff' ? 'Clique para confirmar' : 'Desligar'" aria-label="Desligar" @click="power('poweroff')">
        <svg viewBox="0 0 24 24"><path d="M12 3v9M6.3 6.8a8 8 0 1 0 11.4 0" /></svg>
      </button>
    </div>
    <p v-if="armed" class="cc-confirm" role="status">Clique novamente para confirmar</p>
    <p v-if="error" class="cc-error" role="alert">{{ error }}</p>
    </template>

    <div v-else-if="view === 'background'" class="cc-stache">
      <header class="cc-stache-head">
        <button type="button" class="cc-circle cc-circle--small" aria-label="Voltar" @click="view = 'main'">
          <svg viewBox="0 0 24 24"><path d="m14 6-6 6 6 6" /></svg>
        </button>
        <strong>Apps em segundo plano</strong>
        <span class="cc-bg-count">{{ background.length }}</span>
      </header>
      <p v-if="!backgroundLoaded" class="cc-bg-empty">Procurando…</p>
      <p v-else-if="!background.length" class="cc-bg-empty">Nenhum app rodando em segundo plano.</p>
      <ul v-else class="cc-bg-list">
        <li v-for="app in background" :key="app.id" class="cc-bg-item">
          <img v-if="app.icon" :src="app.icon" alt="" draggable="false" />
          <span v-else class="cc-bg-letter" aria-hidden="true">{{ app.name.charAt(0).toUpperCase() }}</span>
          <span class="cc-bg-name">{{ app.name }}</span>
          <small>{{ app.processes }} {{ app.processes === 1 ? "processo" : "processos" }} · {{ memory(app.memoryMb) }}</small>
        </li>
      </ul>
      <p v-if="backgroundLoaded && !windowsKnown" class="cc-bg-note">Sem a extensão do GNOME atualizada, apps com janela aparecem também. Reinicie a sessão.</p>
    </div>

    <div v-else-if="view === 'plugins'" class="cc-stache">
      <header class="cc-stache-head">
        <button type="button" class="cc-circle cc-circle--small" aria-label="Voltar" @click="view = 'stache'">
          <svg viewBox="0 0 24 24"><path d="m14 6-6 6 6 6" /></svg>
        </button>
        <strong>Plugins</strong>
        <button type="button" class="cc-reset" @click="pluginStore.installExamples()">Instalar exemplos</button>
        <button type="button" class="cc-reset" @click="pluginStore.openDir()">Abrir pasta</button>
      </header>
<p v-if="vault" class="cc-vault" :class="{ 'is-warn': vault.backend === 'file' || vault.inFile > 0 }" role="status">{{ vault.message }}</p>
      <p v-if="pluginFailure" class="cc-error" role="alert">{{ pluginFailure }}</p>
      <p v-if="pluginList.some((plugin) => !plugin.sandboxed)" class="cc-plugin-warn">O isolamento (bubblewrap) não está instalado: nenhum plugin será executado. Instale com <code>sudo apt install bubblewrap</code>.</p>
      <p v-if="!pluginList.length && !pluginErrors.length" class="cc-bg-empty">Nenhum plugin instalado. “Instalar exemplos” traz Timer, Cotação, GitHub, Docker e Status.</p>
      <ul class="cc-bg-list">
        <li v-for="plugin in pluginList" :key="plugin.id" class="cc-plugin">
          <div class="cc-plugin-head">
            <strong>{{ plugin.name }} <small>{{ plugin.version }}</small></strong>
            <button type="button" class="cc-reset" :class="{ 'is-armed': reviewing === plugin.id }" @click="togglePlugin(plugin.id, !plugin.enabled)">
              {{ plugin.enabled ? "Desligar" : reviewing === plugin.id ? "Aprovar e ligar" : "Ligar" }}
            </button>
          </div>
          <small>{{ plugin.description }}</small>
          <small>Estado: {{ plugin.enabled && !plugin.approved ? "as permissões mudaram" : plugin.status }}</small>
          <template v-if="reviewing === plugin.id || (!plugin.approved && plugin.enabled)">
            <small>Este plugin poderá:</small>
            <ul><li v-for="line in plugin.permissions" :key="line">{{ line }}</li></ul>
          </template>
          <label v-for="item in plugin.settings" :key="item.key" class="cc-plugin-set">
            <span>{{ item.secret ? "🔒 " : "" }}{{ item.label }}</span>
            <input
              v-if="item.secret" class="cc-field" type="password" autocomplete="off" maxlength="500"
              :placeholder="plugin.values[item.key] === IN_VAULT ? '••••••••  guardado no cofre (digite para trocar)' : item.hint || 'segredo'"
              @input="editSetting(plugin.id, item.key, ($event.target as HTMLInputElement).value)"
            />
            <input v-else class="cc-field" type="text" :value="plugin.values[item.key]" :placeholder="item.hint || item.default" maxlength="500" @input="editSetting(plugin.id, item.key, ($event.target as HTMLInputElement).value)" />
          </label>
        </li>
        <li v-for="broken in pluginErrors" :key="broken.folder" class="cc-plugin">
          <strong>{{ broken.folder }}</strong>
          <small class="cc-plugin-warn">{{ broken.error }}</small>
        </li>
      </ul>
      <p class="cc-bg-note">Cada plugin roda isolado: sem rede, sem sua pasta pessoal e sem ver outros programas. Só faz o que o manifesto declara e você aprovou.</p>
    </div>

    <div v-else-if="view === 'calendars'" class="cc-stache">
      <header class="cc-stache-head">
        <button type="button" class="cc-circle cc-circle--small" aria-label="Voltar" @click="view = 'stache'">
          <svg viewBox="0 0 24 24"><path d="m14 6-6 6 6 6" /></svg>
        </button>
        <strong>Agendas</strong>
      </header>
      <form class="cc-cal-form" @submit.prevent="addCalendar">
        <label class="cc-swatch cc-swatch--pick" :style="{ background: newColor || 'transparent' }" title="Cor da agenda (vazio = automática)">
          <input v-model="newColor" type="color" aria-label="Cor da agenda" />
        </label>
        <input v-model="calendarName" class="cc-field" type="text" maxlength="40" placeholder="Nome (ex.: Trabalho)" aria-label="Nome da agenda" />
        <input v-model="calendarUrl" class="cc-field cc-field--grow" type="url" placeholder="Endereço iCal (.ics) da agenda" aria-label="Endereço iCal da agenda" spellcheck="false" />
        <button type="submit" class="cc-reset" :disabled="calendarBusy || !calendarUrl.trim()">{{ calendarBusy ? "Verificando…" : "Adicionar" }}</button>
      </form>
<p v-if="vault" class="cc-vault" :class="{ 'is-warn': vault.backend === 'file' || vault.inFile > 0 }" role="status">{{ vault.message }}</p>
      <p v-if="calendarFailure" class="cc-error" role="alert">{{ calendarFailure }}</p>
      <ul v-if="calendarSources.length" class="cc-bg-list">
        <li v-for="source in calendarSources" :key="source.id" class="cc-bg-item cc-cal-item">
          <span class="cc-bg-name">
            <button type="button" class="cc-swatch" :style="{ background: source.color }" :aria-label="`Trocar a cor de ${source.name}`" :aria-expanded="editingColor === source.id" @click="editingColor = editingColor === source.id ? null : source.id" />
            {{ source.name }}
          </span>
          <small>🔒 {{ source.hint }}</small>
          <button type="button" class="cc-reset" @click="agenda.remove(source.id)">Remover</button>
          <div v-if="editingColor === source.id" class="cc-palette" role="group" aria-label="Cores">
            <button v-for="color in CALENDAR_COLORS" :key="color" type="button" class="cc-swatch" :class="{ 'is-on': color === source.color }" :style="{ background: color }" :aria-label="color" @click="agenda.setColor(source.id, color)" />
            <label class="cc-swatch cc-swatch--pick" title="Outra cor">
              <input type="color" :value="source.color" aria-label="Outra cor" @change="agenda.setColor(source.id, ($event.target as HTMLInputElement).value)" />
            </label>
          </div>
        </li>
      </ul>
      <p v-for="error in calendarErrors" :key="error" class="cc-error">{{ error }}</p>
      <p class="cc-bg-note">Google Agenda: Configurações da agenda → “Endereço secreto no formato iCal”. Outlook: Calendário → Publicar → link ICS. Qualquer link .ics (ou webcal://) funciona.</p>
    </div>

    <div v-else class="cc-stache">
      <header class="cc-stache-head">
        <button type="button" class="cc-circle cc-circle--small" aria-label="Voltar" @click="view = 'main'">
          <svg viewBox="0 0 24 24"><path d="m14 6-6 6 6 6" /></svg>
        </button>
        <strong>Ajustes do Stache</strong>
        <button type="button" class="cc-reset" @click="openPlugins">Plugins</button>
        <button type="button" class="cc-reset" @click="openCalendars">Agendas</button>
        <button type="button" class="cc-reset" @click="reset">Restaurar padrão</button>
        <button type="button" class="cc-reset" @click="refreshApp">Atualizar</button>
        <button type="button" class="cc-reset cc-reset--danger" :class="{ 'is-armed': quitArmed }" @click="quitApp">{{ quitArmed ? "Confirmar saída" : "Sair" }}</button>
      </header>

      <div class="cc-settings-row">
      <section class="cc-card cc-setting">
        <div class="cc-setting-head"><strong>Tamanho recolhido</strong><span>{{ compactScale }}%</span></div>
        <div class="cc-fat">
          <input type="range" :min="COMPACT_SCALE_RANGE.min" :max="COMPACT_SCALE_RANGE.max" :step="COMPACT_SCALE_RANGE.step" v-model.number="compactScale" :style="{ '--fill': `${((compactScale - COMPACT_SCALE_RANGE.min) / (COMPACT_SCALE_RANGE.max - COMPACT_SCALE_RANGE.min)) * 100}%` }" aria-label="Tamanho recolhido" />
        </div>
        <div class="cc-preview" aria-hidden="true"><span class="cc-pill" :style="{ transform: `scale(${compactScale / 100})` }">23:48 · Sex, 9 De Out</span></div>
      </section>

      <section class="cc-card cc-setting">
        <div class="cc-setting-head"><strong>Tamanho expandido</strong><span>{{ expandedScale }}%</span></div>
        <div class="cc-fat">
          <input type="range" :min="EXPANDED_SCALE_RANGE.min" :max="EXPANDED_SCALE_RANGE.max" :step="EXPANDED_SCALE_RANGE.step" v-model.number="expandedScale" :style="{ '--fill': `${((expandedScale - EXPANDED_SCALE_RANGE.min) / (EXPANDED_SCALE_RANGE.max - EXPANDED_SCALE_RANGE.min)) * 100}%` }" aria-label="Tamanho expandido" />
        </div>
        <small>Vale para todas as abas, na hora.</small>
      </section>
      </div>

      <section class="cc-card cc-setting cc-autostart">
        <div class="cc-setting-head">
          <strong>Iniciar com o computador</strong>
          <button type="button" class="cc-switch" role="switch" :aria-checked="autostart.enabled" :disabled="!autostart.available" aria-label="Iniciar com o computador" @click="toggleAutostart"><span /></button>
        </div>
        <small v-if="autostart.available">O Stache sobe junto com a sessão do GNOME, antes dos outros apps, e só aparece com a tela desbloqueada.</small>
        <small v-else class="cc-plugin-warn">{{ autostart.reason }}</small>
        <small v-if="autostartError" class="cc-plugin-warn" role="alert">{{ autostartError }}</small>
      </section>
    </div>
  </div>
</template>
