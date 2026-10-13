<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";

import { openUrl } from "@tauri-apps/plugin-opener";

import { useWhatsapp } from "../composables/useWhatsapp";
import type { WhatsappChat } from "../types/whatsapp";
import WhatsappAudio from "./WhatsappAudio.vue";

const wa = useWhatsapp();
const { state, qr, detail, chats, active, recording, enabled, notifyGroups } = wa;

const draft = ref("");
const zoom = ref("");
const inputEl = ref<HTMLInputElement | null>(null);
const composerEl = ref<HTMLElement | null>(null);
const list = ref<HTMLElement | null>(null);
const seconds = ref(0);
const micError = ref("");
let recorder: MediaRecorder | null = null;
let stream: MediaStream | null = null;
let chunks: Blob[] = [];
let tick: number | undefined;

onMounted(() => { wa.panelOpen.value = true; });
onBeforeUnmount(() => { wa.panelOpen.value = false; stopStream(); });

const messages = computed(() => active.value?.messages ?? []);
async function scrollDown() {
  await nextTick();
  list.value?.scrollTo({ top: list.value.scrollHeight });
}
watch([() => messages.value.length, () => active.value?.jid], () => {
  if (active.value) wa.open(active.value.jid);
  void scrollDown();
}, { immediate: true });

// Última mensagem da conversa, em uma linha.
const preview = (chat: WhatsappChat) => {
  const last = chat.messages[chat.messages.length - 1];
  if (!last) return "";
  const label = last.text || (last.media?.kind === "image" ? "📷 Foto" : last.media?.kind === "sticker" ? "Figurinha" : last.media?.kind === "audio" ? "🎤 Áudio" : "");
  return `${last.from === "me" ? "Você: " : ""}${label}`;
};

// Quebra o texto em trechos e links; nunca vira HTML.
const URL_PATTERN = /((?:https?:\/\/|www\.)[^\s<>"']+)/gi;
function parts(text: string) {
  return text.split(URL_PATTERN).filter(Boolean).map((chunk) => {
    if (!/^(https?:\/\/|www\.)/i.test(chunk)) return { text: chunk, url: "" };
    const trimmed = chunk.replace(/[.,;:!?)\]]+$/, "");
    return { text: chunk, url: /^https?:/i.test(trimmed) ? trimmed : `https://${trimmed}`, tail: chunk.slice(trimmed.length) };
  });
}
async function openLink(url: string) {
  try { await openUrl(url); } catch { /* sem navegador padrão disponível */ }
}

const waiting = computed(() => ["connecting", "reconnecting", "stopped"].includes(state.value));
const initial = (name: string) => (name || "?").trim().charAt(0).toUpperCase();
function hue(name: string) {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % 360;
}
const clock = (at: number) => new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit", hour12: false }).format(at);

// A nova bolha sai do campo de resposta e desliza até o lugar dela no chat.
function flyIn(from: DOMRect) {
  void nextTick().then(() => {
    const box = list.value;
    const bubble = box?.lastElementChild as HTMLElement | null;
    if (!box || !bubble) return;
    box.scrollTo({ top: box.scrollHeight });
    const to = bubble.getBoundingClientRect();
    const dy = from.top + from.height / 2 - (to.top + to.height / 2);
    box.style.overflow = "visible"; // a bolha parte de fora da área rolável
    bubble.style.zIndex = "3";
    const animation = bubble.animate(
      [
        { transform: `translateY(${dy}px)`, opacity: 0.4 },
        { transform: "translateY(0)", opacity: 1 },
      ],
      { duration: 420, easing: "cubic-bezier(0.32, 0.72, 0, 1)" },
    );
    const done = () => { box.style.overflow = ""; bubble.style.zIndex = ""; };
    animation.onfinish = done;
    animation.oncancel = done;
  });
}

function submit() {
  if (!active.value || !draft.value.trim()) return;
  const from = (inputEl.value ?? list.value)?.getBoundingClientRect();
  void wa.sendText(active.value.jid, draft.value, () => { if (from) flyIn(from); });
  draft.value = "";
}

function stopStream() {
  window.clearInterval(tick);
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
}

// idle → gravando → (parar) revisão → enviar; ou gravando → enviar direto.
type Phase = "idle" | "recording" | "review";
const phase = ref<Phase>("idle");
const review = ref<{ blob: Blob; url: string; seconds: number } | null>(null);
let stopMode: "send" | "review" | "cancel" = "send";
let recordingJid = "";

function setPhase(next: Phase) {
  phase.value = next;
  // Gravando ou revisando um áudio, a ilha não recolhe sozinha.
  recording.value = next !== "idle";
}

function discardReview() {
  if (review.value) URL.revokeObjectURL(review.value.url);
  review.value = null;
}

function reset() {
  discardReview();
  setPhase("idle");
}

function deliver(blob: Blob, duration: number) {
  const from = composerEl.value?.getBoundingClientRect();
  void wa.sendAudio(recordingJid, blob, duration, () => { if (from) flyIn(from); });
}

async function startRecording() {
  micError.value = "";
  if (!active.value) return;
  // Diz exatamente o que faltou, em vez de um "sem acesso" genérico.
  if (!navigator.mediaDevices?.getUserMedia) {
    micError.value = "Este WebKit não oferece captura de áudio (mediaDevices indisponível).";
    return;
  }
  if (typeof MediaRecorder === "undefined") {
    micError.value = "Este WebKit não tem MediaRecorder; não dá para gravar áudio aqui.";
    return;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = ["audio/ogg;codecs=opus", "audio/webm;codecs=opus", "audio/mp4"].find((type) => MediaRecorder.isTypeSupported(type));
    recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  } catch (error) {
    const name = error instanceof DOMException ? error.name : "Erro";
    micError.value = name === "NotAllowedError" || name === "SecurityError"
      ? "O sistema negou o microfone (NotAllowedError)."
      : name === "NotFoundError"
        ? "Nenhum microfone encontrado (NotFoundError)."
        : `Não foi possível gravar: ${name}${error instanceof Error && error.message ? ` — ${error.message}` : ""}`;
    console.warn("Stache: falha ao iniciar a gravação", error);
    stopStream();
    return;
  }
  recordingJid = active.value.jid;
  chunks = [];
  stopMode = "send";
  seconds.value = 0;
  recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
  recorder.onstop = () => {
    const duration = Math.max(1, seconds.value);
    const blob = new Blob(chunks, { type: recorder?.mimeType || "audio/webm" });
    stopStream();
    if (stopMode === "cancel" || !blob.size) return reset();
    if (stopMode === "send") {
      deliver(blob, duration);
      return reset();
    }
    review.value = { blob, url: URL.createObjectURL(blob), seconds: duration };
    setPhase("review");
  };
  recorder.start();
  setPhase("recording");
  tick = window.setInterval(() => { seconds.value += 1; }, 1_000);
}

// Lixeira, parar e enviar durante a gravação.
function endRecording(mode: "send" | "review" | "cancel") {
  stopMode = mode;
  if (recorder && recorder.state !== "inactive") recorder.stop();
  else reset();
}

// Na revisão: enviar o áudio ouvido ou descartá-lo.
function sendReview() {
  if (!review.value) return;
  deliver(review.value.blob, review.value.seconds);
  reset();
}

onBeforeUnmount(() => {
  if (recorder && recorder.state !== "inactive") { stopMode = "cancel"; recorder.stop(); }
  discardReview();
  recording.value = false;
});

const timer = computed(() => `${Math.floor(seconds.value / 60)}:${String(seconds.value % 60).padStart(2, "0")}`);
</script>

<template>
  <div class="wa-panel">
    <!-- Conectar / aguardar -->
    <div v-if="state !== 'open'" class="wa-connect">
      <template v-if="!enabled || state === 'off' || state === 'logged_out'">
        <svg class="wa-logo" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20l1.2-4.100A8 8 0 1 1 8.200 18.900zM9 9.500c0 3 2.500 5.500 5.500 5.500l1-1.500-1.800-.9-.7.700c-.9-.4-1.600-1.100-2-2l.7-.7-.9-1.800z" /></svg>
        <strong>Conectar ao WhatsApp</strong>
        <small>Vincule como "dispositivo conectado". Só mensagens novas aparecem aqui; nenhum histórico é carregado.</small>
        <button type="button" class="wa-primary" @click="wa.connect()">Conectar</button>
      </template>
      <template v-else-if="state === 'qr'">
        <img v-if="qr" class="wa-qr" :src="qr" alt="QR code do WhatsApp" />
        <strong>Escaneie com o celular</strong>
        <small>WhatsApp › Aparelhos conectados › Conectar um aparelho</small>
      </template>
      <template v-else-if="state === 'unavailable'">
        <strong>WhatsApp indisponível</strong>
        <small>{{ detail || "Não foi possível iniciar a ponte." }}</small>
        <button type="button" class="wa-primary" @click="wa.connect()">Tentar de novo</button>
      </template>
      <template v-else>
        <strong>{{ waiting && state === 'reconnecting' ? "Reconectando…" : "Conectando…" }}</strong>
        <small v-if="detail">{{ detail }}</small>
      </template>
    </div>

    <!-- Lista e chat -->
    <Transition v-else name="wa-slide" mode="out-in" @after-enter="scrollDown">
      <section v-if="!active" key="list" class="wa-list">
        <header class="wa-bar">
          <strong>WhatsApp</strong>
          <label class="wa-toggle" title="Receber avisos de mensagens de grupos">
            <input type="checkbox" :checked="notifyGroups" @change="wa.setNotifyGroups(($event.target as HTMLInputElement).checked)" />
            Avisar grupos
            <span class="wa-switch" aria-hidden="true" />
          </label>
        </header>
        <div class="wa-rows">
          <p v-if="!chats.length" class="wa-empty">Conectado. As próximas mensagens aparecem aqui.</p>
          <button v-for="chat in chats" :key="chat.jid" type="button" class="wa-row" @click="wa.open(chat.jid)">
            <span class="wa-avatar" :style="{ '--hue': hue(chat.name) }"><img v-if="chat.avatar" :src="chat.avatar" alt="" />{{ chat.avatar ? "" : initial(chat.name) }}</span>
            <span class="wa-row-text">
              <span class="wa-row-top">
                <b>{{ chat.name }}</b><small v-if="chat.isGroup">Grupo</small>
              </span>
              <span class="wa-row-last">{{ preview(chat) }}</span>
            </span>
            <time>{{ clock(chat.updatedAt) }}</time>
            <span v-if="chat.unread" class="wa-unread" :class="{ 'is-muted': chat.isGroup && !notifyGroups }">{{ chat.unread }}</span>
          </button>
        </div>
        <button type="button" class="wa-logout" @click="wa.disconnect()">Desconectar</button>
      </section>

      <section v-else key="chat" class="wa-main">
        <header class="wa-head">
          <button type="button" class="wa-clear" title="Voltar" aria-label="Voltar para a lista" @click="wa.back()">
            <svg viewBox="0 0 24 24"><path d="m14 6-6 6 6 6" /></svg>
          </button>
          <span class="wa-avatar wa-avatar--head" :style="{ '--hue': hue(active.name) }"><img v-if="active.avatar" :src="active.avatar" alt="" />{{ active.avatar ? "" : initial(active.name) }}</span>
          <strong>{{ active.name }}</strong>
          <small v-if="active.isGroup">Grupo</small>
          <button type="button" class="wa-clear" title="Apagar esta conversa" aria-label="Apagar esta conversa" @click="wa.clearChat(active.jid)">
            <svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V5h4v2m-7 0 1 12h8l1-12M10 11v5m4-5v5" /></svg>
          </button>
        </header>
        <div ref="list" class="wa-messages">
          <div v-for="message in messages" :key="message.id" class="wa-bubble" :class="[`wa-bubble--${message.from}`, { 'is-failed': message.status === 'failed', 'is-sticker': message.media?.kind === 'sticker' }]">
            <b v-if="active.isGroup && message.from === 'them'">{{ message.sender }}</b>
            <img v-if="message.media?.kind === 'image'" class="wa-image" :src="message.media.src" alt="Imagem recebida" @click="zoom = message.media.src" />
            <img v-else-if="message.media?.kind === 'sticker'" class="wa-sticker" :src="message.media.src" alt="Figurinha" />
            <WhatsappAudio v-else-if="message.media?.kind === 'audio'" :src="message.media.src" :seconds="message.media.seconds" />
            <span v-if="message.text" class="wa-text"><template v-for="(piece, index) in parts(message.text)" :key="index"><a v-if="piece.url" class="wa-link" :href="piece.url" :title="piece.url" @click.prevent.stop="openLink(piece.url)">{{ piece.text.slice(0, piece.text.length - (piece.tail?.length ?? 0)) }}</a><template v-if="piece.url">{{ piece.tail }}</template><template v-else>{{ piece.text }}</template></template></span>
            <span class="wa-meta">
              <time>{{ message.status === "failed" ? "não enviada" : clock(message.at) }}</time>
              <svg v-if="message.from === 'me' && message.status && message.status !== 'failed'" class="wa-tick" :class="`wa-tick--${message.status}`" viewBox="0 0 20 14" role="img" :aria-label="{ sending: 'Enviando', sent: 'Enviada', delivered: 'Recebida', read: 'Lida' }[message.status]">
                <circle v-if="message.status === 'sending'" cx="10" cy="7" r="4.500" /><path v-else-if="message.status === 'sent'" d="m6 7.500 3 3 6-7.500" />
                <template v-else><path d="m2 7.500 3 3 6-7.500" /><path d="m8 9 1.500 1.500 6.500-8" /></template>
              </svg>
            </span>
            <button v-if="message.status === 'failed'" type="button" class="wa-retry" @click="wa.resend(active.jid, message.id)">
              <svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.500-5.800M20 4v5h-5" /></svg>Reenviar
            </button>
            <button type="button" class="wa-del" title="Apagar mensagem" aria-label="Apagar mensagem" @click="wa.deleteMessage(active.jid, message.id)">×</button>
          </div>
        </div>
        <p v-if="micError" class="wa-error" role="alert">{{ micError }}</p>
        <p v-if="!active.canSend" class="wa-locked">Só administradores podem enviar mensagens neste grupo.</p>
        <form v-else ref="composerEl" class="wa-composer" @submit.prevent="submit">
          <template v-if="phase === 'recording'">
            <button type="button" class="wa-round" title="Descartar" aria-label="Descartar gravação" @click="endRecording('cancel')">
              <svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V5h4v2m-7 0 1 12h8l1-12M10 11v5m4-5v5" /></svg>
            </button>
            <span class="wa-rec"><i aria-hidden="true" />{{ timer }}</span>
            <button type="button" class="wa-round" title="Parar e ouvir" aria-label="Parar e ouvir antes de enviar" @click="endRecording('review')">
              <svg viewBox="0 0 24 24" class="wa-fill"><rect x="7" y="7" width="10" height="10" rx="2" /></svg>
            </button>
            <button type="button" class="wa-round wa-round--send" title="Enviar" aria-label="Enviar áudio" @click="endRecording('send')">
              <svg viewBox="0 0 24 24"><path d="M4 12 20 4l-4 16-4.500-6.500z" /></svg>
            </button>
          </template>
          <template v-else-if="phase === 'review' && review">
            <button type="button" class="wa-round" title="Descartar" aria-label="Descartar áudio" @click="reset">
              <svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V5h4v2m-7 0 1 12h8l1-12M10 11v5m4-5v5" /></svg>
            </button>
            <WhatsappAudio class="wa-review" :src="review.url" :seconds="review.seconds" />
            <button type="button" class="wa-round wa-round--send" title="Enviar" aria-label="Enviar áudio" @click="sendReview">
              <svg viewBox="0 0 24 24"><path d="M4 12 20 4l-4 16-4.500-6.500z" /></svg>
            </button>
          </template>
          <template v-else>
            <input ref="inputEl" v-model="draft" class="wa-input" type="text" placeholder="Responder…" aria-label="Mensagem" autocomplete="off" />
            <button v-if="draft.trim()" type="submit" class="wa-round wa-round--send" aria-label="Enviar">
              <svg viewBox="0 0 24 24"><path d="M4 12 20 4l-4 16-4.500-6.500z" /></svg>
            </button>
            <button v-else type="button" class="wa-round" aria-label="Gravar áudio" title="Gravar áudio" @click="startRecording">
              <svg viewBox="0 0 24 24"><path d="M12 3a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3M5 11a7 7 0 0 0 14 0M12 18v3" /></svg>
            </button>
          </template>
        </form>
      </section>
    </Transition>
    <div v-if="zoom" class="wa-zoom" role="dialog" aria-label="Imagem ampliada" @click="zoom = ''">
      <img :src="zoom" alt="" />
    </div>
  </div>
</template>
