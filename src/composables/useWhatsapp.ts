import { computed, ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { playNotificationSound } from "./notificationSound";
import type { WhatsappChat, WhatsappIncoming, WhatsappMessage, WhatsappState } from "../types/whatsapp";

const KEY = "stache.whatsapp";
const GROUPS_KEY = "stache.whatsapp.groups";
const MAX_MESSAGES = 30;
const MAX_CHATS = 5;

// Conversas ficam só na memória: nada do histórico é carregado nem gravado.
const enabled = ref(read());
// Desligado, grupos continuam na lista mas não geram aviso, som nem contagem.
const notifyGroups = ref(readGroups());
const state = ref<WhatsappState>("off");
const qr = ref("");
const detail = ref("");
const chats = ref<Record<string, WhatsappChat>>({});
const activeJid = ref("");
const recording = ref(false);

const incomingHandlers = new Set<(message: WhatsappIncoming) => void>();
const repliedHandlers = new Set<(jid: string) => void>();
let started = false;
let counter = 0;

function read() {
  try { return localStorage.getItem(KEY) === "1"; } catch { return false; }
}
function readGroups() {
  try { return localStorage.getItem(GROUPS_KEY) !== "0"; } catch { return true; }
}
function setNotifyGroups(value: boolean) {
  notifyGroups.value = value;
  try { localStorage.setItem(GROUPS_KEY, value ? "1" : "0"); } catch { /* vale só nesta sessão */ }
}
function persist(value: boolean) {
  try { localStorage.setItem(KEY, value ? "1" : "0"); } catch { /* vale só nesta sessão */ }
}

const chatList = computed(() => Object.values(chats.value).sort((a, b) => b.updatedAt - a.updatedAt));
// Sem conversa escolhida, a aba mostra a lista.
const active = computed(() => chats.value[activeJid.value] ?? null);
// Grupos silenciados aparecem na lista, mas não entram na contagem da aba.
const unread = computed(() => chatList.value.reduce((sum, chat) => sum + (chat.isGroup && !notifyGroups.value ? 0 : chat.unread), 0));

function push(jid: string, base: Pick<WhatsappChat, "name" | "isGroup"> & { avatar?: string | null; canSend?: boolean }, message: WhatsappMessage) {
  const chat = chats.value[jid] ?? { jid, name: base.name, isGroup: base.isGroup, avatar: null, canSend: true, unread: 0, updatedAt: 0, messages: [] };
  chat.name = base.name || chat.name;
  if (base.avatar) chat.avatar = base.avatar;
  if (base.canSend !== undefined) chat.canSend = base.canSend;
  chat.messages = [...chat.messages, message].slice(-MAX_MESSAGES);
  chat.updatedAt = message.at;
  chats.value[jid] = chat;
  const extra = Object.values(chats.value).sort((a, b) => b.updatedAt - a.updatedAt).slice(MAX_CHATS);
  for (const old of extra) delete chats.value[old.jid];
  return chat;
}

function onEvent(event: any) {
  switch (event.type) {
    case "status":
      state.value = event.state;
      detail.value = event.message ?? "";
      if (event.state !== "qr") qr.value = event.state === "connecting" ? qr.value : "";
      if (event.state === "logged_out") chats.value = {};
      break;
    case "qr":
      qr.value = event.dataUrl;
      state.value = "qr";
      break;
    case "message": {
      const incoming = event as WhatsappIncoming & { type: string };
      const chat = push(incoming.jid, { name: incoming.name, isGroup: incoming.isGroup, avatar: incoming.avatar, canSend: incoming.canSend }, {
        id: incoming.id, from: "them", sender: incoming.sender, text: incoming.text, kind: incoming.kind, media: incoming.media, at: incoming.at,
      });
      if (activeJid.value !== incoming.jid || !panelOpen.value) chat.unread += 1;
      for (const handler of incomingHandlers) handler(incoming);
      break;
    }
    case "replied":
      // Respondeu pelo celular: o Stache esquece a conversa.
      clearChat(event.jid);
      for (const handler of repliedHandlers) handler(event.jid);
      break;
    case "sent":
      onSent(event.ref, event.id);
      break;
    case "ack":
      onAck(event.id, event.status);
      break;
    case "error":
      detail.value = event.message ?? "";
      if (event.ref) for (const chat of Object.values(chats.value)) markFailed(chat.jid, event.ref);
      break;
  }
}

// A aba precisa avisar quando está visível, para não contar como não lida.
const panelOpen = ref(false);

async function start() {
  if (started) return;
  started = true;
  try {
    await listen("whatsapp-event", ({ payload }) => onEvent(payload));
  } catch { started = false; return; /* Browser preview. */ }
  if (enabled.value) void connect();
}

async function connect() {
  enabled.value = true;
  persist(true);
  state.value = "connecting";
  detail.value = "";
  try { await invoke("whatsapp_start"); }
  catch { /* o próprio sidecar já avisou o motivo por evento */ }
}

async function disconnect() {
  enabled.value = false;
  persist(false);
  try { await invoke("whatsapp_send", { command: { cmd: "logout" } }); } catch { /* já parado */ }
  state.value = "off";
  chats.value = {};
  activeJid.value = "";
}

function back() {
  activeJid.value = "";
}

function open(jid: string) {
  activeJid.value = jid;
  const chat = chats.value[jid];
  if (chat) chat.unread = 0;
}

const SEND_TIMEOUT = 30_000;
// O que é preciso guardar para reenviar; fica só na memória.
const retry = new Map<string, { jid: string; blob?: Blob }>();
// Confirmações que chegaram antes de sabermos o id do WhatsApp.
const pendingAcks = new Map<string, number>();
const timers = new Map<string, number>();
const RANK = { sending: 0, sent: 1, delivered: 2, read: 3 } as const;

function find(id: string, by: "id" | "remoteId" = "id") {
  for (const chat of Object.values(chats.value)) {
    const message = chat.messages.find((item) => item[by] === id);
    if (message) return message;
  }
  return undefined;
}

function advance(message: WhatsappMessage, next: "sent" | "delivered" | "read") {
  const current = message.status && message.status !== "failed" ? RANK[message.status] : -1;
  if (RANK[next] > current) message.status = next;
}

function applyAck(message: WhatsappMessage, code: number) {
  advance(message, code >= 4 ? "read" : code === 3 ? "delivered" : "sent");
}

function track(id: string) {
  window.clearTimeout(timers.get(id));
  // Sem resposta do WhatsApp em 30 s (offline, por exemplo), oferece reenviar.
  timers.set(id, window.setTimeout(() => {
    const message = find(id);
    if (message?.status === "sending") message.status = "failed";
    timers.delete(id);
  }, SEND_TIMEOUT));
}

function settle(id: string) {
  window.clearTimeout(timers.get(id));
  timers.delete(id);
}

function onSent(ref: string, remoteId?: string) {
  const message = find(ref);
  if (!message) return;
  settle(ref);
  if (remoteId) {
    message.remoteId = remoteId;
    const early = pendingAcks.get(remoteId);
    pendingAcks.delete(remoteId);
    if (early !== undefined) applyAck(message, early);
  }
  advance(message, "sent");
}

function onAck(id: string, code: number) {
  const message = find(id, "remoteId");
  if (message) applyAck(message, code);
  else pendingAcks.set(id, Math.max(code, pendingAcks.get(id) ?? 0));
}

async function toBase64(blob: Blob) {
  const buffer = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let index = 0; index < buffer.length; index += 0x8000)
    binary += String.fromCharCode(...buffer.subarray(index, index + 0x8000));
  return btoa(binary);
}

async function deliver(message: WhatsappMessage) {
  const info = retry.get(message.id);
  if (!info) return;
  message.status = "sending";
  track(message.id);
  try {
    if (info.blob)
      await invoke("whatsapp_send", { command: { cmd: "send_audio", ref: message.id, jid: info.jid, mime: info.blob.type, data: await toBase64(info.blob) } });
    else
      await invoke("whatsapp_send", { command: { cmd: "send_text", ref: message.id, jid: info.jid, text: message.text } });
  } catch {
    settle(message.id);
    message.status = "failed";
  }
}

async function sendText(jid: string, text: string, onQueued?: () => void) {
  const body = text.trim();
  if (!body) return;
  const chat = chats.value[jid];
  push(jid, { name: chat?.name ?? "", isGroup: chat?.isGroup ?? false }, { id: `me-${Date.now()}-${counter++}`, from: "me", sender: "Você", text: body, kind: "text", at: Date.now(), status: "sending" });
  const message = chats.value[jid].messages[chats.value[jid].messages.length - 1];
  retry.set(message.id, { jid });
  playNotificationSound("sent");
  onQueued?.();
  await deliver(message);
}

async function sendAudio(jid: string, blob: Blob, seconds: number, onQueued?: () => void) {
  const chat = chats.value[jid];
  push(jid, { name: chat?.name ?? "", isGroup: chat?.isGroup ?? false }, {
    id: `me-${Date.now()}-${counter++}`, from: "me", sender: "Você", kind: "audio", at: Date.now(), status: "sending",
    text: "", media: { kind: "audio", src: URL.createObjectURL(blob), seconds: Math.max(1, Math.round(seconds)) },
  });
  const message = chats.value[jid].messages[chats.value[jid].messages.length - 1];
  retry.set(message.id, { jid, blob });
  playNotificationSound("sent");
  onQueued?.();
  await deliver(message);
}

function resend(jid: string, id: string) {
  const message = chats.value[jid]?.messages.find((item) => item.id === id);
  if (message?.status === "failed") void deliver(message);
}

// Apaga só neste computador; não mexe na conversa no WhatsApp.
function deleteMessage(jid: string, id: string) {
  const chat = chats.value[jid];
  if (!chat) return;
  release(chat.messages.filter((message) => message.id === id));
  chat.messages = chat.messages.filter((message) => message.id !== id);
  if (!chat.messages.length) {
    delete chats.value[jid];
    if (activeJid.value === jid) activeJid.value = "";
  }
}

function release(messages: WhatsappMessage[]) {
  for (const message of messages) { retry.delete(message.id); settle(message.id); }
  for (const message of messages) if (message.media?.src.startsWith("blob:")) URL.revokeObjectURL(message.media.src);
}

function clearChat(jid: string) {
  release(chats.value[jid]?.messages ?? []);
  delete chats.value[jid];
  if (activeJid.value === jid) activeJid.value = "";
}

function markFailed(jid: string, id: string) {
  const target = chats.value[jid]?.messages.find((message) => message.id === id);
  if (target) { settle(id); target.status = "failed"; }
}

export function useWhatsapp() {
  return {
    enabled, state, qr, detail, chats: chatList, active, activeJid, unread, recording, panelOpen,
    notifyGroups, setNotifyGroups, back, resend, deleteMessage, clearChat,
    start, connect, disconnect, open, sendText, sendAudio,
    onReplied(handler: (jid: string) => void) {
      repliedHandlers.add(handler);
      return () => repliedHandlers.delete(handler);
    },
    onIncoming(handler: (message: WhatsappIncoming) => void) {
      incomingHandlers.add(handler);
      return () => incomingHandlers.delete(handler);
    },
  };
}
