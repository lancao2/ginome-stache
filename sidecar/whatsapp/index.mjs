// Ponte entre o Stache e o WhatsApp (protocolo do WhatsApp Web, via Baileys).
// Fala JSON por linha: eventos saem em stdout e comandos entram em stdin.
// Nada do histórico é sincronizado nem guardado; só chegam mensagens novas.
import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { createInterface } from "node:readline";
import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";
import pino from "pino";
import QRCode from "qrcode";

const authDir = process.argv[2];
if (!authDir) {
  console.error("uso: index.mjs <pasta-de-autenticação>");
  process.exit(2);
}
mkdirSync(authDir, { recursive: true });

const MAX_AGE_SECONDS = 10 * 60;
const MAX_MEDIA_BYTES = 8 * 1024 * 1024;
// Último estado e QR, para responder a quem recarregou a interface depois do evento.
let lastStatus = null;
let lastQr = null;
const emit = (event) => {
  if (event.type === "status") { lastStatus = event; if (event.state !== "qr") lastQr = null; }
  if (event.type === "qr") lastQr = event;
  process.stdout.write(`${JSON.stringify(event)}\n`);
};
const logger = pino({ level: "silent" });
const groupInfos = new Map();
const avatars = new Map();
// Ids do que o próprio Stache enviou, para não confundir com resposta feita no celular.
const sentIds = new Set();
function remember(id) {
  if (!id) return;
  sentIds.add(id);
  if (sentIds.size > 200) sentIds.delete(sentIds.values().next().value);
}

let socket = null;
let stopping = false;
let reconnectTimer = null;

const unwrap = (message) =>
  message?.ephemeralMessage?.message
  ?? message?.viewOnceMessage?.message
  ?? message?.viewOnceMessageV2?.message
  ?? message?.documentWithCaptionMessage?.message
  ?? message;

// Texto exibível e, quando houver, qual mídia baixar; null para o que não é
// mensagem de conversa (reações, protocolo…).
function describe(raw) {
  const message = unwrap(raw);
  if (!message) return null;
  // Visualização única só pode ser aberta no celular: não baixa nem mostra a mídia.
  const holder = (value) => value?.viewOnceMessage ?? value?.viewOnceMessageV2 ?? value?.viewOnceMessageV2Extension;
  const once = holder(raw) ?? holder(raw?.ephemeralMessage?.message);
  const flagged = message.imageMessage?.viewOnce || message.videoMessage?.viewOnce || message.audioMessage?.viewOnce;
  if (once || flagged) {
    const inner = once?.message ?? message;
    const what = inner.audioMessage ? "Áudio" : inner.videoMessage ? "Vídeo" : "Foto";
    return { text: `👁 ${what} de visualização única. Abra no celular para ver.`, kind: "media" };
  }
  if (message.conversation) return { text: message.conversation, kind: "text" };
  if (message.extendedTextMessage?.text) return { text: message.extendedTextMessage.text, kind: "text" };
  if (message.imageMessage) return { text: message.imageMessage.caption ?? "", fallback: "📷 Foto", kind: "media", media: "image", source: message.imageMessage };
  if (message.stickerMessage) return { text: "", fallback: "Figurinha", kind: "media", media: "sticker", source: message.stickerMessage };
  if (message.audioMessage) return { text: "", fallback: message.audioMessage.ptt ? "🎤 Mensagem de voz" : "🎵 Áudio", kind: "audio", media: "audio", source: message.audioMessage };
  if (message.videoMessage) return { text: message.videoMessage.caption ? `🎬 ${message.videoMessage.caption}` : "🎬 Vídeo", kind: "media" };
  if (message.documentMessage) return { text: `📄 ${message.documentMessage.fileName || "Documento"}`, kind: "media" };
  if (message.locationMessage) return { text: "📍 Localização", kind: "media" };
  if (message.contactMessage) return { text: "👤 Contato", kind: "media" };
  return null;
}

// Baixa a mídia como data URL; null se for grande demais ou falhar.
async function download(item, content) {
  const length = Number(content.source.fileLength?.toString?.() ?? content.source.fileLength ?? 0);
  if (length > MAX_MEDIA_BYTES) return null;
  try {
    const buffer = await downloadMediaMessage(item, "buffer", {}, { logger, reuploadRequest: socket.updateMediaMessage });
    if (!buffer?.length || buffer.length > MAX_MEDIA_BYTES) return null;
    const mime = content.source.mimetype || (content.media === "audio" ? "audio/ogg; codecs=opus" : "image/jpeg");
    return { kind: content.media, src: `data:${mime.split(";")[0]};base64,${buffer.toString("base64")}`, mime, seconds: Number(content.source.seconds ?? 0) || undefined };
  } catch {
    return null;
  }
}

// Parte numérica do id, sem dispositivo (:N) nem domínio.
const bare = (id) => (id ?? "").split("@")[0].split(":")[0];

function isMeAdmin(metadata) {
  const mine = new Set([bare(socket.user?.id), bare(socket.user?.lid)].filter(Boolean));
  return (metadata.participants ?? []).some((p) =>
    p.admin && [p.id, p.phoneNumber, p.lid].some((id) => id && mine.has(bare(id))));
}

// Nome do grupo e se posso escrever nele (grupos "só admins enviam" têm announce).
async function groupInfo(jid) {
  const cached = groupInfos.get(jid);
  if (cached && Date.now() - cached.at < 10 * 60_000) return cached;
  try {
    const metadata = await socket.groupMetadata(jid);
    const info = { name: metadata.subject, canSend: !metadata.announce || isMeAdmin(metadata), at: Date.now() };
    groupInfos.set(jid, info);
    return info;
  } catch {
    return cached ?? { name: "Grupo", canSend: true, at: 0 };
  }
}

// Foto de perfil como data URL (o link do WhatsApp expira); null se não houver ou demorar.
async function avatar(jid) {
  if (avatars.has(jid)) return avatars.get(jid);
  const lookup = (async () => {
    try {
      const url = await socket.profilePictureUrl(jid, "preview");
      if (!url) return null;
      const response = await fetch(url, { signal: AbortSignal.timeout(4000) });
      if (!response.ok) return null;
      const type = response.headers.get("content-type") || "image/jpeg";
      return `data:${type};base64,${Buffer.from(await response.arrayBuffer()).toString("base64")}`;
    } catch { return null; }
  })();
  const result = await Promise.race([lookup, new Promise((resolve) => setTimeout(() => resolve(undefined), 1500))]);
  // Se demorou, guarda quando chegar para as próximas mensagens.
  if (result === undefined) void lookup.then((value) => avatars.set(jid, value));
  else avatars.set(jid, result);
  return result ?? null;
}

async function onMessage(item) {
  const { key, message, pushName, messageTimestamp } = item;
  const jid = key.remoteJid;
  if (!jid) return;
  if (key.fromMe) {
    // Resposta enviada pelo celular (ou outro aparelho): a conversa foi atendida.
    const age = Date.now() / 1000 - Number(messageTimestamp?.toString?.() ?? messageTimestamp ?? 0);
    // O eco do que o Stache enviou pode chegar antes de o envio terminar; espera para comparar.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    if (!sentIds.has(key.id) && age < 120 && describe(message) && jid !== "status@broadcast" && !jid.endsWith("@newsletter"))
      emit({ type: "replied", jid });
    return;
  }
  if (jid === "status@broadcast" || jid.endsWith("@newsletter") || jid.endsWith("@broadcast")) return;
  const seconds = Number(messageTimestamp?.toString?.() ?? messageTimestamp ?? 0);
  if (seconds && Date.now() / 1000 - seconds > MAX_AGE_SECONDS) return;
  const content = describe(message);
  if (!content) return;

  const media = content.media ? await download(item, content) : null;
  const isGroup = jid.endsWith("@g.us");
  const group = isGroup ? await groupInfo(jid) : null;
  const sender = pushName || (key.participant ?? jid).split("@")[0];
  emit({
    type: "message",
    id: key.id,
    jid,
    isGroup,
    // Em grupos o título é o do grupo e `sender` diz quem falou.
    name: group ? group.name : sender,
    canSend: group ? group.canSend : true,
    sender,
    avatar: await avatar(jid),
    text: media || !content.fallback ? content.text : content.fallback,
    kind: content.kind,
    media,
    at: (seconds || Math.floor(Date.now() / 1000)) * 1000,
  });
}

async function connect() {
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  let version;
  try { ({ version } = await fetchLatestBaileysVersion()); } catch { /* usa a versão embutida */ }

  emit({ type: "status", state: "connecting" });
  const sock = makeWASocket({
    auth: state,
    version,
    logger,
    browser: Browsers.appropriate("Stache"),
    syncFullHistory: false,
    shouldSyncHistoryMessage: () => false,
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: false,
  });
  socket = sock;

  sock.ev.on("creds.update", saveCreds);
  // Andamento do que enviamos: 2 = servidor, 3 = entregue, 4 = lida, 5 = ouvida.
  sock.ev.on("messages.update", (updates) => {
    for (const { key, update } of updates)
      if (key.fromMe && typeof update?.status === "number") emit({ type: "ack", id: key.id, status: update.status });
  });
  // Permissões do grupo mudaram (admin, "só admins enviam"): relê na próxima mensagem.
  sock.ev.on("groups.update", (updates) => { for (const { id } of updates) if (id) groupInfos.delete(id); });
  sock.ev.on("group-participants.update", ({ id }) => groupInfos.delete(id));

  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    if (sock !== socket) return;
    if (qr) emit({ type: "qr", dataUrl: await QRCode.toDataURL(qr, { margin: 1, width: 240 }) });
    if (connection === "open") emit({ type: "status", state: "open", me: sock.user?.name ?? sock.user?.id ?? "" });
    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (stopping) return;
      if (code === DisconnectReason.loggedOut) {
        rmSync(authDir, { recursive: true, force: true });
        mkdirSync(authDir, { recursive: true });
        emit({ type: "status", state: "logged_out" });
      } else {
        emit({ type: "status", state: "reconnecting" });
      }
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => void connect().catch(fail), code === DisconnectReason.loggedOut ? 500 : 3000);
    }
  });

  // Só "notify" é mensagem nova; "append" é histórico e fica de fora.
  sock.ev.on("messages.upsert", ({ messages, type }) => {
    for (const item of messages) {
      // "append" é histórico; só interessa uma resposta própria recém-enviada.
      if (type !== "notify" && !item.key.fromMe) continue;
      void onMessage(item).catch(() => undefined);
    }
  });
}

function fail(error) {
  emit({ type: "error", message: error instanceof Error ? error.message : String(error) });
}

// O WhatsApp só toca como mensagem de voz em ogg/opus; converte quando há ffmpeg.
function toOpus(buffer) {
  return new Promise((resolve) => {
    const child = spawn("ffmpeg", ["-loglevel", "error", "-i", "pipe:0", "-vn", "-ac", "1", "-c:a", "libopus", "-b:a", "32k", "-f", "ogg", "pipe:1"]);
    const chunks = [];
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code === 0 && chunks.length ? Buffer.concat(chunks) : null));
    child.stdin.on("error", () => undefined);
    child.stdin.end(buffer);
  });
}

async function handle(command) {
  if (command.cmd === "status") {
    if (lastStatus) emit(lastStatus);
    if (lastQr) emit(lastQr);
    return;
  }
  if (command.cmd === "logout") {
    stopping = true;
    try { await socket?.logout(); } catch { /* já desconectado */ }
    rmSync(authDir, { recursive: true, force: true });
    emit({ type: "status", state: "logged_out" });
    process.exit(0);
  }
  if (!socket || !command.jid) return emit({ type: "error", ref: command.ref, message: "WhatsApp não está conectado." });

  if (command.cmd === "send_text") {
    const sent = await socket.sendMessage(command.jid, { text: command.text });
    remember(sent?.key?.id);
    return emit({ type: "sent", ref: command.ref, id: sent?.key?.id, jid: command.jid });
  }

  if (command.cmd === "send_audio") {
    const original = Buffer.from(command.data, "base64");
    const opus = await toOpus(original);
    const sent = await socket.sendMessage(command.jid, opus
      ? { audio: opus, mimetype: "audio/ogg; codecs=opus", ptt: true }
      : { audio: original, mimetype: command.mime || "audio/ogg; codecs=opus", ptt: true });
    remember(sent?.key?.id);
    return emit({ type: "sent", ref: command.ref, id: sent?.key?.id, jid: command.jid, converted: Boolean(opus) });
  }
}

createInterface({ input: process.stdin }).on("line", (line) => {
  let command;
  try { command = JSON.parse(line); } catch { return; }
  handle(command).catch((error) => emit({ type: "error", ref: command.ref, message: error instanceof Error ? error.message : String(error) }));
});
process.stdin.on("end", () => process.exit(0));

setInterval(() => avatars.clear(), 60 * 60 * 1000).unref();
connect().catch(fail);
