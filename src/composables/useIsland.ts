import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

import type { MediaState, MediaTrack } from "../types/media";
import type { SystemNotification } from "../types/notification";
import { useNotifications } from "./useNotifications";
import { useStacheSettings } from "./useStacheSettings";
import { playNotificationSound, preloadNotificationSounds } from "./notificationSound";
import { useTasks } from "./useTasks";
import { useWhatsapp } from "./useWhatsapp";
import { useCodex } from "./useCodex";
import { useClipboard } from "./useClipboard";
import { useSearch } from "./useSearch";
import { usePlugins } from "./usePlugins";
import { usePets } from "./usePets";
import { usePetAbsence } from "./usePetAbsence";
import { usePetTasks } from "./usePetTasks";
import { usePetsIntro } from "./usePetsIntro";
import { PROFILES, type PetId } from "../pets/data";
import type { WhatsappIncoming } from "../types/whatsapp";

export type IslandTab = "media" | "home" | "ai" | "weather" | "notifications" | "whatsapp" | "codex" | "clipboard" | "search" | "plugins" | "pets";

// Aviso mostrado na cápsula: tarefa vencendo ou notificação do sistema.
export interface IslandAlertItem {
  kind: "task" | "system" | "whatsapp" | "codex" | "context" | "pet";
  jid?: string;
  initial?: string;
  label: string;
  text: string;
  tone: "urgent" | "normal" | "system" | "whatsapp" | "success" | "warning" | "mic" | "camera" | "screen";
  taskId?: number;
  icon?: string | null;
  /** Eventos contextuais: ícone (tipo do evento) e o que o clique faz. */
  symbol?: string;
  action?: "reveal" | "controls" | "url" | "none";
  path?: string | null;
}

interface ContextEventPayload {
  kind: string;
  label: string;
  text: string;
  tone: IslandAlertItem["tone"];
  action: "reveal" | "controls" | "url" | "none";
  path: string | null;
}

const PET_NAMES = Object.fromEntries(Object.values(PROFILES).map((profile) => [profile.id, profile.nome])) as Record<PetId, string>;
const HEIGHT_MEDIA = 180;
const HEIGHT_HOME = 320;
const HEIGHT_INTRO = 300;
const INTRO_DELAY = 1_800;
const POLL_INTERVAL = 1_000;
const PAUSED_RETURN_DELAY = 10_000;
const TASK_RELOAD_INTERVAL = 20_000;
const ALERT_DURATION = 8_000;
const SYSTEM_ALERT_DURATION = 3_500;
const ALERT_MAX_AGE = 5 * 60_000;
const CONTEXT_ALERT_DURATION = 4_500;

function fallbackAccent(track: MediaTrack) {
  const palette = ["#f97316", "#38bdf8", "#a78bfa", "#34d399", "#f472b6"];
  const text = `${track.title}${track.artist}${track.source}`;
  let hash = 0;
  for (let index = 0; index < text.length; index += 1)
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  return palette[hash % palette.length];
}

async function dominantColor(source: string): Promise<string | null> {
  return new Promise((resolve) => {
    const image = new Image();
    if (!source.startsWith("data:")) image.crossOrigin = "anonymous";
    image.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = 32;
        canvas.height = 32;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) return resolve(null);
        context.drawImage(image, 0, 0, 32, 32);
        const pixels = context.getImageData(0, 0, 32, 32).data;
        const buckets = new Map<string, { count: number; r: number; g: number; b: number }>();
        for (let index = 0; index < pixels.length; index += 16) {
          const r = pixels[index];
          const g = pixels[index + 1];
          const b = pixels[index + 2];
          const alpha = pixels[index + 3];
          const max = Math.max(r, g, b);
          const min = Math.min(r, g, b);
          if (alpha < 180 || max < 30 || min > 235 || max - min < 18) continue;
          const key = `${r >> 5}-${g >> 5}-${b >> 5}`;
          const bucket = buckets.get(key) ?? { count: 0, r: 0, g: 0, b: 0 };
          bucket.count += 1;
          bucket.r += r;
          bucket.g += g;
          bucket.b += b;
          buckets.set(key, bucket);
        }
        const winner = [...buckets.values()].sort((a, b) => b.count - a.count)[0];
        if (!winner) return resolve(null);
        const channel = (value: number) => Math.round(Math.min(220, Math.max(45, value / winner.count)));
        resolve(`#${[channel(winner.r), channel(winner.g), channel(winner.b)].map((value) => value.toString(16).padStart(2, "0")).join("")}`);
      } catch { resolve(null); }
    };
    image.onerror = () => resolve(null);
    image.src = source;
  });
}

export function useIsland() {
  const expanded = ref(false);
  const tab = ref<IslandTab>("media");
  const controlsOpen = ref(false);
  const active = ref(false);
  const playing = ref(false);
  const currentTrack = ref<MediaTrack | null>(null);
  const taskStore = useTasks();
  const { compactScale, expandedScale } = useStacheSettings();
  const notificationStore = useNotifications();
  const whatsapp = useWhatsapp();
  const codex = useCodex();
  const clipboard = useClipboard();
  const search = useSearch();
  const pets = usePets();
  const intro = usePetsIntro();
  // Aberta pelo atalho, a ilha fica aberta mesmo com o mouse longe, até colar, Esc ou perder o foco.
  let pinnedOpen = false;
  const alert = ref<IslandAlertItem | null>(null);
  const alertQueue: IslandAlertItem[] = [];
  // Capturas (mic/camera/screen) com aviso ainda na fila ou na tela: a pílula só aparece depois dele.
  const pendingCapture = ref<string[]>([]);
  const notified = new Set<number>();
  let alertTimer: number | undefined;
  let dueTimer: number | undefined;
  let reloadTimer: number | undefined;
  const now = ref(Date.now());
  const sampledAt = ref(Date.now());
  let progressTimer: number | undefined;
  let pollTimer: number | undefined;
  let resizeTimer: number | undefined;
  let hoverTimer: number | undefined;
  let leaveTimer: number | undefined;
  let pausedReturnTimer: number | undefined;
  let unlistenFocus: UnlistenFn | undefined;
  let unlistenNotifications: UnlistenFn | undefined;
  let unlistenContext: UnlistenFn | undefined;
  let unlistenWhatsapp: (() => void) | undefined;
  let introTimer: number | undefined;
  let destroyed = false;
  let pollRunning = false;
  let lastArtwork = "";
  let pointerInside = false;

  const elapsed = computed(() => {
    const track = currentTrack.value;
    if (!track) return 0;
    const interpolated = track.position + (playing.value ? (now.value - sampledAt.value) / 1_000 : 0);
    return track.duration > 0 ? Math.min(track.duration, interpolated) : interpolated;
  });
  const progress = computed(() => currentTrack.value?.duration
    ? Math.min(1, elapsed.value / currentTrack.value.duration)
    : 0);

  // Sem reprodução só existe a aba Início.
  const effectiveTab = computed<IslandTab>(() => {
    if (tab.value === "notifications" || tab.value === "ai" || tab.value === "weather" || tab.value === "whatsapp" || tab.value === "codex" || tab.value === "clipboard" || tab.value === "search" || tab.value === "plugins" || tab.value === "pets") return tab.value;
    return active.value && currentTrack.value ? tab.value : "home";
  });
  // A central de controle precisa de mais altura que a aba Mídia.
  const tall = computed(() => effectiveTab.value !== "media" || controlsOpen.value);
  const targetHeight = () => (intro.open.value ? HEIGHT_INTRO : tall.value ? HEIGHT_HOME : HEIGHT_MEDIA);

  watch([compactScale, expandedScale], () => void resizeWindow(expanded.value));

  // Apresentação dos mascotes: abre a ilha no tamanho dela e, ao terminar, recolhe ou abre a aba Mascotes.
  watch(intro.open, (isOpen) => {
    if (isOpen) {
      if (alertTimer !== undefined) window.clearTimeout(alertTimer);
      alertTimer = undefined;
      alert.value = null;
      cancelPausedReturn();
      if (expanded.value) void resizeWindow(true);
      else setExpanded(true);
      return;
    }
    if (intro.goToPets.value) { selectTab("pets"); pinnedOpen = true; }
    else setExpanded(false);
    if (alertQueue.length && !alert.value) window.setTimeout(nextAlert, 700);
  });

  // A música em reprodução alimenta a Diversão dos mascotes.
  watch([playing, currentTrack], () => {
    const track = currentTrack.value;
    pets.setMedia(playing.value && Boolean(track), track ? `${track.source}|${track.title}|${track.artist}` : "", track ? `${track.title} ${track.artist} ${track.album} ${track.source}` : "");
  }, { immediate: true });

  // Região clicável da janela: só a ilha, e não toda a área transparente.
  let inputTimer: number | undefined;
  let inputBox = { width: 0, height: 0 };
  // Escala atual da ilha, escolhida nos ajustes do Stache.
  const scale = computed(() => (expanded.value ? expandedScale.value : compactScale.value) / 100);
  // Largura da ilha sem escala (a escala é aplicada pelo contêiner).
  const baseWidth = computed(() => (alert.value && !expanded.value ? 340 : expanded.value ? 560 : active.value && currentTrack.value ? 330 : 190));
  const islandBox = computed(() => ({
    width: Math.round(baseWidth.value * scale.value),
    height: Math.round((expanded.value ? targetHeight() : 30) * scale.value),
  }));
  function applyInputRegion(box: { width: number; height: number }) {
    inputBox = box;
    void invoke("set_input_region", box).catch(() => undefined);
  }
  watch(islandBox, (box) => {
    if (inputTimer !== undefined) window.clearTimeout(inputTimer);
    inputTimer = undefined;
    // Cresce na hora; só encolhe depois da animação, para não cortar a ilha.
    if (box.width >= inputBox.width && box.height >= inputBox.height) applyInputRegion(box);
    else inputTimer = window.setTimeout(() => { applyInputRegion(islandBox.value); inputTimer = undefined; }, 500);
  });

  async function resizeWindow(nextExpanded: boolean) {
    const reserved = Math.round(30 * compactScale.value / 100);
    const height = Math.round((nextExpanded ? targetHeight() * expandedScale.value / 100 : reserved) + 2);
    try { await invoke("set_island_expanded", { height, reserved }); }
    catch { /* Browser preview. */ }
  }


  function setExpanded(nextExpanded: boolean) {
    // Durante a apresentação dos mascotes a ilha não recolhe sozinha.
    if (!nextExpanded && intro.open.value) return;
    if (expanded.value === nextExpanded) return;
    expanded.value = nextExpanded;
    if (!nextExpanded) { controlsOpen.value = false; pinnedOpen = false; }
    if (resizeTimer !== undefined) window.clearTimeout(resizeTimer);
    if (nextExpanded) void resizeWindow(true);
    else resizeTimer = window.setTimeout(() => {
      void resizeWindow(false);
      resizeTimer = undefined;
    }, 500);
  }

  // A janela cresce na hora e só encolhe depois da animação da ilha.
  function followHeight(previous: number) {
    if (!expanded.value) return;
    if (resizeTimer !== undefined) window.clearTimeout(resizeTimer);
    if (targetHeight() >= previous) void resizeWindow(true);
    else resizeTimer = window.setTimeout(() => {
      void resizeWindow(true);
      resizeTimer = undefined;
    }, 500);
  }

  function toggleControls(open = !controlsOpen.value) {
    const previous = targetHeight();
    controlsOpen.value = open;
    followHeight(previous);
  }

  function selectTab(next: IslandTab) {
    const previous = targetHeight();
    controlsOpen.value = false;
    tab.value = next;
    // Com algo pausado a ilha é o relógio; abrir Mídia traz o player de volta.
    if (next === "media" && currentTrack.value && !active.value) active.value = true;
    followHeight(previous);
  }

  function collapse() {
    if (hoverTimer !== undefined) window.clearTimeout(hoverTimer);
    if (leaveTimer !== undefined) window.clearTimeout(leaveTimer);
    hoverTimer = leaveTimer = undefined;
    setExpanded(false);
  }

  function cancelPausedReturn() {
    if (pausedReturnTimer !== undefined) {
      window.clearTimeout(pausedReturnTimer);
      pausedReturnTimer = undefined;
    }
  }

  function schedulePausedReturn() {
    cancelPausedReturn();
    if (playing.value || !currentTrack.value || pointerInside) return;
    // Só quem saiu com a aba Mídia aberta vê o player pausado por um tempo.
    if (tab.value !== "media") {
      active.value = false;
      return;
    }
    pausedReturnTimer = window.setTimeout(() => {
      collapse();
      active.value = false;
      pausedReturnTimer = undefined;
    }, PAUSED_RETURN_DELAY);
  }

  // Lembretes e avisos de atenção (reunião, conflito, bateria) usam o som de lembrete; o resto, o padrão.
  function alertSound(item: IslandAlertItem) {
    return item.kind === "task" || (item.kind === "context" && item.tone === "warning") ? "task" : "default";
  }

  function nextAlert() {
    if (intro.open.value) return; // os avisos esperam a apresentação terminar
    while (alertQueue.length) {
      const item = alertQueue.shift()!;
      if (item.kind === "task") {
        const fresh = taskStore.tasks.value.find((task) => task.id === item.taskId);
        if (!fresh || fresh.done) continue;
      }
      // O aviso só aparece com a ilha fechada; se ela estava aberta, recolhe.
      collapse();
      alert.value = item;
      playNotificationSound(alertSound(item));
      alertTimer = window.setTimeout(dismissAlert, item.kind === "context" ? CONTEXT_ALERT_DURATION : item.kind === "system" ? SYSTEM_ALERT_DURATION : item.kind === "codex" && item.tone !== "urgent" ? SYSTEM_ALERT_DURATION : ALERT_DURATION);
      return;
    }
  }

  function dismissAlert() {
    const symbol = alert.value?.kind === "context" ? alert.value.symbol : undefined;
    if (symbol) pendingCapture.value = pendingCapture.value.filter((item) => item !== symbol);
    if (alertTimer !== undefined) window.clearTimeout(alertTimer);
    alertTimer = undefined;
    alert.value = null;
    if (alertQueue.length) alertTimer = window.setTimeout(() => { alertTimer = undefined; nextAlert(); }, 500);
  }

  function checkDue() {
    const current = Date.now();
    for (const task of taskStore.tasks.value) {
      if (task.done || notified.has(task.id) || !task.dueDate || !task.dueTime) continue;
      const at = new Date(`${task.dueDate}T${task.dueTime}`).getTime();
      if (Number.isNaN(at) || at > current) continue;
      notified.add(task.id);
      // Tarefas que venceram muito antes de o Stache abrir não geram aviso.
      if (current - at <= ALERT_MAX_AGE)
        alertQueue.push({ kind: "task", label: task.dueTime, text: task.title, tone: task.priority > 0 ? "urgent" : "normal", taskId: task.id });
    }
    if (!alert.value && alertTimer === undefined) nextAlert();
  }

  function openAlert() {
    const item = alert.value;
    dismissAlert();
    if (!item) return;
    if (item.kind === "context") {
      if (item.action === "reveal" && item.path) void invoke("search_open", { path: item.path, reveal: true }).catch(() => undefined);
      else if (item.action === "url" && item.path) void invoke("search_open_url", { url: item.path }).catch(() => undefined);
      else if (item.action === "controls") { selectTab("home"); setExpanded(true); toggleControls(true); }
      return;
    }
    if (item.kind === "task" && item.taskId !== undefined) {
      taskStore.focusRequest.value = item.taskId;
      selectTab("home");
    } else if (item.kind === "codex") {
      selectTab("codex");
    } else if (item.kind === "pet") {
      selectTab("pets");
    } else if (item.kind === "whatsapp" && item.jid) {
      whatsapp.open(item.jid);
      selectTab("whatsapp");
    } else selectTab("notifications");
    setExpanded(true);
  }

  function onWhatsappMessage(message: WhatsappIncoming) {
    if (message.isGroup && !whatsapp.notifyGroups.value) return;
    // Com o chat dessa conversa aberto a mensagem já aparece nele.
    if (expanded.value) {
      if (!(tab.value === "whatsapp" && whatsapp.activeJid.value === message.jid)) playNotificationSound("default");
      return;
    }
    const who = message.isGroup ? `${message.sender} · ${message.name}` : message.name;
    alertQueue.push({ kind: "whatsapp", label: who, text: "enviou uma mensagem", tone: "whatsapp", jid: message.jid, icon: message.avatar ?? null, initial: message.name });
    if (!alert.value && alertTimer === undefined) nextAlert();
  }

  function onSystemNotification(notification: SystemNotification) {
    notificationStore.add(notification);
    // Aberta, a ilha só toca o som: o aviso na cápsula exige a ilha fechada.
    if (expanded.value) {
      playNotificationSound("default");
      return;
    }
    alertQueue.push({ kind: "system", label: notification.app || "Sistema", text: notification.summary || notification.body, tone: "system", icon: notification.icon });
    if (!alert.value && alertTimer === undefined) nextAlert();
  }

  function onContextEvent(payload: ContextEventPayload) {
    // Os avisos são da cápsula fechada; com a ilha aberta só toca o som (como nas notificações do sistema).
    if (expanded.value) {
      playNotificationSound(payload.tone === "warning" ? "task" : "default");
      return;
    }
    // O mesmo aviso não se repete enquanto está na tela ou na fila.
    const same = (item: IslandAlertItem) => item.kind === "context" && item.symbol === payload.kind && item.text === payload.text;
    if ((alert.value && same(alert.value)) || alertQueue.some(same)) return;
    if (["mic", "camera", "screen"].includes(payload.kind) && !pendingCapture.value.includes(payload.kind)) pendingCapture.value = [...pendingCapture.value, payload.kind];
    alertQueue.push({ kind: "context", symbol: payload.kind, label: payload.label, text: payload.text, tone: payload.tone, action: payload.action, path: payload.path });
    if (!alert.value && alertTimer === undefined) nextAlert();
  }

  function hoverEnter() {
    pointerInside = true;
    pinnedOpen = false; // o mouse assumiu o controle
    // Aviso de WhatsApp: passar o mouse abre direto no chat.
    if (alert.value?.kind === "whatsapp") {
      if (hoverTimer === undefined) hoverTimer = window.setTimeout(() => { hoverTimer = undefined; openAlert(); }, 200);
      return;
    }
    // Durante os outros avisos a ilha não expande: o clique é que abre a tarefa.
    if (alert.value) return;
    cancelPausedReturn();
    if (leaveTimer !== undefined) window.clearTimeout(leaveTimer);
    leaveTimer = undefined;
    if (expanded.value || hoverTimer !== undefined) return;
    hoverTimer = window.setTimeout(() => {
      // Com o player na cápsula, passar o mouse sempre abre na aba Mídia.
      if (active.value && currentTrack.value) selectTab("media");
      setExpanded(true);
      hoverTimer = undefined;
    }, 280);
  }

  // Só segura o recolhimento quem está de fato digitando (campo de texto com conteúdo)
  // ou gravando áudio; um campo vazio ou um interruptor com foco não conta.
  function isBusy() {
    if (whatsapp.recording.value) return true;
    const element = document.activeElement;
    if (element instanceof HTMLTextAreaElement) return element.value.trim() !== "";
    if (element instanceof HTMLInputElement)
      return ["text", "search", "url", "email", ""].includes(element.type) && element.value.trim() !== "";
    return false;
  }

  function hoverLeave() {
    pointerInside = false;
    if (hoverTimer !== undefined) window.clearTimeout(hoverTimer);
    hoverTimer = undefined;
    if (expanded.value) {
      leaveTimer = window.setTimeout(() => {
        // Não recolhe enquanto o usuário digita uma tarefa.
        leaveTimer = undefined;
        if (isBusy() || pinnedOpen) return;
        setExpanded(false);
      }, 360);
    }
    schedulePausedReturn();
  }

  // Rede de segurança: se um pointerleave se perder (ponteiro saiu pela área
  // transparente) ou o recolhimento foi adiado por um campo em foco, volta a tentar.
  let watchdog: number | undefined;
  let staleTicks = 0;
  watch(expanded, (open) => {
    window.clearInterval(watchdog);
    watchdog = undefined;
    staleTicks = 0;
    if (!open) return;
    watchdog = window.setInterval(() => {
      if (!expanded.value || leaveTimer !== undefined || hoverTimer !== undefined) return;
      if (isBusy() || pinnedOpen) return;
      const hovering = Boolean(document.querySelector(".island:hover"));
      // pointerInside "preso" em verdadeiro sem :hover por 2 ciclos também conta como saída.
      staleTicks = pointerInside && !hovering ? staleTicks + 1 : 0;
      if (!pointerInside || staleTicks >= 2) {
        pointerInside = false;
        setExpanded(false);
      }
    }, 450);
  });

  async function syncMedia() {
    if (pollRunning) return;
    pollRunning = true;
    try {
      const state = await invoke<MediaState>("get_media_state");
      const hasSession = state.active && Boolean(state.track);
      const wasPlaying = playing.value;
      playing.value = state.playing;
      const previousHeight = targetHeight();
      if (hasSession && state.track) {
        const previous = currentTrack.value;
        const artworkKey = state.track.artwork ?? "";
        state.track.accent = previous && lastArtwork === artworkKey ? previous.accent : fallbackAccent(state.track);
        currentTrack.value = state.track;
        sampledAt.value = Date.now();
        now.value = sampledAt.value;
        if (artworkKey && artworkKey !== lastArtwork) {
          lastArtwork = artworkKey;
          const expected = artworkKey;
          const color = await dominantColor(artworkKey);
          if (color && currentTrack.value?.artwork === expected)
            currentTrack.value = { ...currentTrack.value, accent: color };
        } else {
          lastArtwork = artworkKey;
        }
        if (state.playing) {
          cancelPausedReturn();
          active.value = true;
        } else if (wasPlaying && active.value) {
          cancelPausedReturn();
          // Pausar com a aba Mídia aberta mantém o player; a volta ao relógio
          // começa quando o ponteiro sai. Em qualquer outro caso é imediata.
          if (expanded.value && tab.value === "media") {
            if (!pointerInside) schedulePausedReturn();
          } else {
            collapse();
            active.value = false;
          }
        }
        followHeight(previousHeight);
      } else {
        cancelPausedReturn();
        active.value = false;
        playing.value = false;
        currentTrack.value = null;
        lastArtwork = "";
        followHeight(previousHeight);
      }
    } catch (error) {
      console.warn("Stache não conseguiu consultar o estado MPRIS", error);
    } finally {
      pollRunning = false;
    }
  }

  async function mediaAction(action: "play_pause" | "next" | "previous") {
    try {
      await invoke("media_action", { action });
      window.setTimeout(() => void syncMedia(), 180);
    } catch { /* The player may have closed between refreshes. */ }
  }

  onMounted(async () => {
    try { await invoke("set_media_visibility", { visible: true }); }
    catch { /* Browser preview. */ }
    void resizeWindow(false);
    applyInputRegion(islandBox.value);
    preloadNotificationSounds();
    void notificationStore.load();
    try {
      const stopNotifications = await listen<SystemNotification>("system-notification", ({ payload }) => onSystemNotification(payload));
      if (destroyed) stopNotifications(); else unlistenNotifications = stopNotifications;
    } catch { /* Browser preview. */ }
    try {
      const stopContext = await listen<ContextEventPayload>("context-event", ({ payload }) => onContextEvent(payload));
      if (destroyed) stopContext(); else unlistenContext = stopContext;
    } catch { /* Browser preview. */ }
    const stopIncoming = whatsapp.onIncoming(onWhatsappMessage);
    const stopReplied = whatsapp.onReplied((jid) => {
      // Já respondida no celular: o aviso pendente não faz mais sentido.
      for (let index = alertQueue.length - 1; index >= 0; index -= 1)
        if (alertQueue[index].jid === jid) alertQueue.splice(index, 1);
      if (alert.value?.jid === jid) dismissAlert();
    });
    // Codex pediu aprovação ou terminou com a ilha fechada: avisa na cápsula.
    const stopCodex = codex.onAttention(({ kind, text }) => {
      if (expanded.value) { playNotificationSound("default"); return; }
      alertQueue.push({ kind: "codex", label: "Codex", text, tone: kind === "approval" ? "urgent" : "system" });
      if (!alert.value && alertTimer === undefined) nextAlert();
    });
    // Mascote pediu aprovação ou terminou uma tarefa com a ilha fechada: avisa na cápsula.
    const stopPets = usePetTasks().onAttention(({ pet, kind, text }) => {
      if (expanded.value) { playNotificationSound("default"); return; }
      alertQueue.push({ kind: "pet", label: PET_NAMES[pet], text, tone: kind === "approval" ? "urgent" : "success" });
      if (!alert.value && alertTimer === undefined) nextAlert();
    });
    // Mascote com fome, com raiva ou triste: avisa na cápsula, com a fala dele.
    const stopNeeds = pets.onNeed(({ pet, state, text }) => {
      if (expanded.value) return;
      alertQueue.push({ kind: "pet", label: PET_NAMES[pet], text, tone: state === "triste" ? "warning" : "normal" });
      if (!alert.value && alertTimer === undefined) nextAlert();
    });
    // Acabaram os tokens: cada mascote avisa na cápsula a desculpa por sumir, e depois avisa que voltou.
    const absence = usePetAbsence();
    const stopLeave = absence.onLeave(({ pet, text }) => {
      if (expanded.value) return;
      alertQueue.push({ kind: "pet", label: PET_NAMES[pet], text, tone: "warning" });
      if (!alert.value && alertTimer === undefined) nextAlert();
    });
    const stopReturn = absence.onReturn(({ pet, text }) => {
      if (expanded.value) return;
      alertQueue.push({ kind: "pet", label: PET_NAMES[pet], text, tone: "success" });
      if (!alert.value && alertTimer === undefined) nextAlert();
    });
    // Saudade, marcos, aniversário e presentes dos mascotes: avisam na cápsula com a fala dele.
    const stopEvents = pets.onEvent(({ pet, kind, text }) => {
      if (expanded.value) return;
      alertQueue.push({ kind: "pet", label: PET_NAMES[pet], text, tone: kind === "saudade" ? "warning" : "success" });
      if (!alert.value && alertTimer === undefined) nextAlert();
    });
    // Super+V (via extensão): abre a lista de copiados com o teclado; de novo, fecha.
    const stopShortcut = clipboard.onShortcut(() => {
      if (expanded.value && tab.value === "clipboard") { collapse(); return; }
      cancelPausedReturn();
      clipboard.selected.value = 0;
      void clipboard.load();
      selectTab("clipboard");
      setExpanded(true);
      pinnedOpen = true;
      void invoke("clipboard_focus").catch(() => undefined);
    });
    const stopClose = clipboard.onClose(() => collapse());
    // Super+Espaço (via extensão): abre a busca; de novo, fecha.
    const stopSearch = search.onShortcut(() => {
      if (expanded.value && tab.value === "search") { collapse(); return; }
      cancelPausedReturn();
      selectTab("search");
      setExpanded(true);
      pinnedOpen = true;
      void invoke("clipboard_focus").catch(() => undefined);
    });
    const stopSearchClose = search.onClose(() => collapse());
    if (intro.shouldAutoShow()) introTimer = window.setTimeout(intro.start, INTRO_DELAY);
    void search.start();
    void usePlugins().start();
    void clipboard.start();
    unlistenWhatsapp = () => { stopIncoming(); stopReplied(); stopCodex(); stopPets(); stopNeeds(); stopLeave(); stopReturn(); stopEvents(); stopShortcut(); stopClose(); stopSearch(); stopSearchClose(); };
    void whatsapp.start();
    void taskStore.load();
    dueTimer = window.setInterval(checkDue, 1_000);
    reloadTimer = window.setInterval(() => void taskStore.load(), TASK_RELOAD_INTERVAL);
    void syncMedia();
    pollTimer = window.setInterval(() => void syncMedia(), POLL_INTERVAL);
    progressTimer = window.setInterval(() => { now.value = Date.now(); }, 250);
    try {
      const stopListening = await getCurrentWindow().onFocusChanged(({ payload: focused }) => {
        if (!focused) onFocusLost();
      });
      if (destroyed) stopListening(); else unlistenFocus = stopListening;
    } catch { /* Browser preview. */ }
  });

  // Clicar fora tira o foco da janela. Não dá para confiar em pointerInside/:hover aqui:
  // no XWayland o ponteiro que sai para uma janela Wayland não gera "leave", e os dois
  // ficam presos em "dentro". O X11 também emite perda de foco ao clicar na própria ilha,
  // mas o foco volta em instantes; só recolhe se continuar sem foco depois de uma pausa.
  let focusTimer: number | undefined;
  function onFocusLost() {
    window.clearTimeout(focusTimer);
    focusTimer = window.setTimeout(() => {
      focusTimer = undefined;
      if (!expanded.value || document.hasFocus() || whatsapp.recording.value) return;
      pointerInside = false;
      collapse();
      schedulePausedReturn();
    }, 220);
  }
  const onWindowBlur = onFocusLost;
  window.addEventListener("blur", onWindowBlur);
  // Interagir com a ilha aberta garante o foco nela; sem isso, clicar fora (que só tira o
  // foco de quem o tem) não geraria nenhum evento quando ela foi aberta apenas pelo hover.
  const claimFocus = () => { if (expanded.value && !document.hasFocus()) void getCurrentWindow().setFocus().catch(() => undefined); };
  window.addEventListener("pointerdown", claimFocus, true);

  onBeforeUnmount(() => {
    window.removeEventListener("blur", onWindowBlur);
    window.removeEventListener("pointerdown", claimFocus, true);
    window.clearTimeout(focusTimer);
    destroyed = true;
    unlistenFocus?.();
    unlistenNotifications?.();
    unlistenContext?.();
    unlistenWhatsapp?.();
    window.clearInterval(watchdog);
    for (const timer of [progressTimer, pollTimer, resizeTimer, hoverTimer, leaveTimer, pausedReturnTimer, alertTimer, dueTimer, reloadTimer, inputTimer, introTimer])
      if (timer !== undefined) window.clearInterval(timer);
  });

  return {
    intro: intro.open, finishIntro: intro.finish, scale, baseWidth, pendingCapture, alert, openAlert, controlsOpen, toggleControls, active, playing, expanded, tab: effectiveTab, tall, selectTab, currentTrack, now, elapsed, progress,
    toggle: () => setExpanded(!expanded.value), collapse, hoverEnter, hoverLeave,
    togglePlayback: () => mediaAction("play_pause"),
    next: () => mediaAction("next"),
    previous: () => mediaAction("previous"),
  };
}
