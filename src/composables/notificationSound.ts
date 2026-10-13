export type NotificationKind = "default" | "task" | "sent";

// Todo aviso usa o som padrão, a não ser que o tipo tenha um próprio.
// Arquivos em public/sound; nomes sem acento, que o servidor do Vite não resolve.
const FILES: Record<NotificationKind, string> = {
  default: "notification.mp3", // Notificação de bloqueio de tela, som digital nítido
  task: "task-reminder.mp3", // Alerta de evento no calendário, lembrete suave
  sent: "son_duquotidient-message-envoye-iphone-apple-391098.mp3", // Mensagem enviada no WhatsApp
};

// Volume por tipo (0 a 1); o som de envio fica mais baixo que os avisos.
const VOLUME: Partial<Record<NotificationKind, number>> = { sent: 0.35 };

const players = new Map<NotificationKind, HTMLAudioElement>();

function player(kind: NotificationKind) {
  let audio = players.get(kind);
  if (!audio) {
    audio = new Audio(`/sound/${FILES[kind]}`);
    audio.preload = "auto";
    audio.volume = VOLUME[kind] ?? 1;
    players.set(kind, audio);
  }
  return audio;
}

// O som de envio é curto e tocado em sequência. Elementos <audio> descartáveis podem ser
// recolhidos pelo coletor de lixo no meio da reprodução, e reaproveitar um só às vezes fica
// mudo (o GStreamer do WebKit já encerrou o fluxo). O Web Audio decodifica o arquivo uma vez
// e cada envio toca um buffer novo, sem atraso e sem depender de elemento nenhum.
const BUFFERED: NotificationKind[] = ["sent"];
let context: AudioContext | null = null;
const buffers = new Map<NotificationKind, AudioBuffer>();
const loading = new Map<NotificationKind, Promise<AudioBuffer | null>>();

function audioContext() {
  context ??= new AudioContext();
  return context;
}

function loadBuffer(kind: NotificationKind) {
  let pending = loading.get(kind);
  if (!pending) {
    pending = fetch(`/sound/${FILES[kind]}`)
      .then((response) => response.arrayBuffer())
      .then((data) => audioContext().decodeAudioData(data))
      .then((buffer) => { buffers.set(kind, buffer); return buffer; })
      .catch((error) => { console.warn("Stache não conseguiu preparar o som", error); loading.delete(kind); return null; });
    loading.set(kind, pending);
  }
  return pending;
}

export function preloadNotificationSounds() {
  (Object.keys(FILES) as NotificationKind[]).forEach((kind) => {
    if (BUFFERED.includes(kind)) void loadBuffer(kind); else player(kind);
  });
}

// Cada envio recebe um elemento próprio, guardado até terminar, caso o Web Audio falhe.
const playing = new Set<HTMLAudioElement>();
function playElement(kind: NotificationKind) {
  const audio = new Audio(`/sound/${FILES[kind]}`);
  audio.volume = VOLUME[kind] ?? 1;
  playing.add(audio);
  const release = () => playing.delete(audio);
  audio.addEventListener("ended", release);
  audio.addEventListener("error", release);
  audio.play().catch((error) => { release(); console.warn("Stache não conseguiu tocar o som do envio", error); });
}

async function playBuffer(kind: NotificationKind) {
  try {
    const ctx = audioContext();
    if (ctx.state !== "running") await ctx.resume();
    const buffer = buffers.get(kind) ?? await loadBuffer(kind);
    if (!buffer) return playElement(kind);
    const source = ctx.createBufferSource();
    const gain = ctx.createGain();
    gain.gain.value = VOLUME[kind] ?? 1;
    source.buffer = buffer;
    source.connect(gain).connect(ctx.destination);
    source.start();
  } catch (error) {
    console.warn("Stache não conseguiu tocar pelo Web Audio; usando <audio>", error);
    playElement(kind);
  }
}

export function playNotificationSound(kind: NotificationKind = "default") {
  if (BUFFERED.includes(kind)) {
    void playBuffer(kind);
    return;
  }
  const audio = player(kind);
  audio.currentTime = 0;
  audio.play().catch((error) => console.warn("Stache não conseguiu tocar o som do aviso", error));
}
