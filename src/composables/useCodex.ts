import { computed, ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isUsageLimit } from "../pets/absence";
import { MAX_THREAD_TURNS, contextToSend, effortFor, needsShared } from "../pets/budget";
import type { PetId } from "../pets/data";
import { usePetAbsence } from "./usePetAbsence";

const KEY = "stache.codex";
const MAX_RECENTS = 6;
const MAX_OUTPUT = 20_000;

export type CodexDecision = "accept" | "acceptForSession" | "decline";

export type CodexEntry =
  | { id: string; kind: "user"; text: string }
  | { id: string; kind: "agent"; text: string; streaming: boolean; pet?: PetId }
  | { id: string; kind: "command"; command: string; status: string; output: string; exitCode: number | null }
  | { id: string; kind: "files"; files: { path: string; change: "add" | "delete" | "update" }[]; status: string }
  | { id: string; kind: "approval"; requestId: string | number; what: "command" | "files"; title: string; detail: string; itemId: string; decision: CodexDecision | null }
  | { id: string; kind: "error"; text: string };

export type CodexStatus = "off" | "starting" | "ready" | "unavailable" | "stopped";

interface Saved { cwd: string; recents: string[] }

function read(): Saved {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Saved>;
    return { cwd: saved.cwd ?? "", recents: Array.isArray(saved.recents) ? saved.recents : [] };
  } catch { return { cwd: "", recents: [] }; }
}
function persist() {
  try { localStorage.setItem(KEY, JSON.stringify({ cwd: cwd.value, recents: recents.value })); }
  catch { /* vale só nesta sessão */ }
}

const saved = read();
const cwd = ref(saved.cwd);
const recents = ref(saved.recents);
const status = ref<CodexStatus>("off");
const detail = ref("");
const entries = ref<CodexEntry[]>([]);
const running = ref(false);
const panelOpen = ref(false);
const pendingApprovals = computed(() => entries.value.filter((entry) => entry.kind === "approval" && entry.decision === null).length);

let threadId = "";
let threadPet: PetId | undefined;
const petThreads = new Map<PetId, string>();
let turnId = "";
let started = false;
let nextId = 0;
let initPromise: Promise<void> | null = null;
const waiting = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
const attentionHandlers = new Set<(event: { kind: "approval" | "done"; text: string }) => void>();
// Threads de outros usos do mesmo app-server (conversa dos mascotes): o painel do Codex as ignora.
const foreignThreads = new Set<string>();
const rawHandlers = new Set<(message: any) => void>();
let activePet: PetId | undefined;
// Gasto por thread: quantos turnos já rodaram e qual contexto do app já foi enviado a ela.
const threadTurns = new Map<string, number>();
const sentContext = new Map<string, string>();
let createdThread = false;

const send = (message: unknown) => invoke("codex_send", { message });

function request<T = any>(method: string, params: unknown): Promise<T> {
  const id = ++nextId;
  return new Promise<T>((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    send({ id, method, params }).catch((error) => { waiting.delete(id); reject(new Error(String(error))); });
  });
}

function entry<K extends CodexEntry["kind"]>(id: string, kind: K) {
  return entries.value.find((item) => item.id === id && item.kind === kind) as Extract<CodexEntry, { kind: K }> | undefined;
}

function fail(text: string, info?: unknown) {
  // Acabaram os tokens: o agente sai com uma desculpa em vez de mostrar um erro seco.
  if (isUsageLimit(info, text)) {
    const pet = activePet;
    const absence = usePetAbsence();
    void absence.reportLimit().then(() => {
      const excuse = pet ? absence.excuse(pet) : "";
      if (excuse) entries.value.push({ id: `away-${Date.now()}-${nextId++}`, kind: "agent", text: excuse, streaming: false, pet });
      else entries.value.push({ id: `err-${Date.now()}-${nextId++}`, kind: "error", text });
    });
    return;
  }
  entries.value.push({ id: `err-${Date.now()}-${nextId++}`, kind: "error", text });
}

function attention(kind: "approval" | "done", text: string) {
  if (panelOpen.value) return;
  for (const handler of attentionHandlers) handler({ kind, text });
}

function onItem(item: any, done: boolean) {
  switch (item.type) {
    case "agentMessage": {
      const existing = entry(item.id, "agent");
      if (existing) { if (done) { existing.text = item.text; existing.streaming = false; } }
      else entries.value.push({ id: item.id, kind: "agent", text: item.text ?? "", streaming: !done, pet: activePet });
      break;
    }
    case "commandExecution": {
      const existing = entry(item.id, "command");
      const output = (item.aggregatedOutput ?? "").slice(-MAX_OUTPUT);
      if (existing) {
        existing.status = item.status;
        if (done || output) existing.output = output || existing.output;
        existing.exitCode = item.exitCode ?? null;
      } else entries.value.push({ id: item.id, kind: "command", command: item.command, status: item.status, output, exitCode: item.exitCode ?? null });
      break;
    }
    case "fileChange": {
      const files = (item.changes ?? []).map((change: any) => ({ path: change.path, change: change.kind?.type ?? "update" }));
      const existing = entry(item.id, "files");
      if (existing) { existing.files = files; existing.status = item.status; }
      else entries.value.push({ id: item.id, kind: "files", files, status: item.status });
      break;
    }
  }
}

function onServerRequest(message: any) {
  const params = message.params ?? {};
  if (message.method === "item/commandExecution/requestApproval") {
    entries.value.push({
      id: `ap-${message.id}`, kind: "approval", requestId: message.id, what: "command", itemId: params.itemId,
      title: "Executar comando", detail: [params.command, params.reason].filter(Boolean).join("\n"), decision: null,
    });
    attention("approval", "pede aprovação para executar um comando");
  } else if (message.method === "item/fileChange/requestApproval") {
    const files = entry(params.itemId, "files")?.files.map((file) => file.path).join("\n");
    entries.value.push({
      id: `ap-${message.id}`, kind: "approval", requestId: message.id, what: "files", itemId: params.itemId,
      title: "Alterar arquivos", detail: [files, params.reason].filter(Boolean).join("\n"), decision: null,
    });
    attention("approval", "pede aprovação para alterar arquivos");
  } else {
    // Perguntas, permissões extras e ferramentas externas ainda não têm tela: recusa sem travar o turno.
    void send({ id: message.id, error: { code: -32601, message: "Não suportado pelo Stache." } });
  }
}

function onNotification(message: any) {
  const params = message.params ?? {};
  switch (message.method) {
    case "item/started": onItem(params.item, false); break;
    case "item/completed": onItem(params.item, true); break;
    case "item/agentMessage/delta": {
      const existing = entry(params.itemId, "agent");
      if (existing) existing.text += params.delta;
      else entries.value.push({ id: params.itemId, kind: "agent", text: params.delta, streaming: true, pet: activePet });
      break;
    }
    case "item/commandExecution/outputDelta": {
      const existing = entry(params.itemId, "command");
      if (existing) existing.output = (existing.output + params.delta).slice(-MAX_OUTPUT);
      break;
    }
    case "turn/started": turnId = params.turn?.id ?? turnId; running.value = true; break;
    case "turn/completed": {
      running.value = false;
      turnId = "";
      for (const item of entries.value) if (item.kind === "agent") item.streaming = false;
      const turn = params.turn ?? {};
      if (turn.status === "failed") fail(turn.error?.message ?? "O Codex não conseguiu terminar.", turn.error?.codexErrorInfo);
      else if (turn.status !== "interrupted") attention("done", "terminou a tarefa");
      break;
    }
    case "error":
      if (!params.willRetry) { running.value = false; fail(params.error?.message ?? "Erro do Codex.", params.error?.codexErrorInfo); }
      break;
    case "stache/unavailable": status.value = "unavailable"; detail.value = params.message ?? ""; break;
    case "stache/stopped":
      status.value = "stopped"; started = false; initPromise = null; running.value = false; threadId = ""; threadPet = undefined; petThreads.clear();
      break;
  }
}

function onMessage(message: any) {
  for (const handler of rawHandlers) handler(message);
  const owner = message.params?.threadId;
  if (message.method !== undefined && typeof owner === "string" && foreignThreads.has(owner)) return;
  if (message.id !== undefined && message.method === undefined) {
    const call = waiting.get(message.id);
    if (!call) return;
    waiting.delete(message.id);
    if (message.error) call.reject(new Error(message.error.message ?? "Erro do Codex."));
    else call.resolve(message.result);
  } else if (message.id !== undefined) onServerRequest(message);
  else onNotification(message);
}

async function boot() {
  if (initPromise) return initPromise;
  status.value = "starting";
  initPromise = (async () => {
    if (!started) {
      started = true;
      try { await listen("codex-event", ({ payload }) => onMessage(payload)); }
      catch { started = false; throw new Error("Disponível só no app."); }
    }
    await invoke("codex_start");
    await request("initialize", { clientInfo: { name: "stache", title: "Stache", version: "1.0.0" }, capabilities: null });
    await send({ method: "initialized" });
    status.value = "ready";
  })().catch((error) => {
    initPromise = null;
    if (status.value !== "unavailable") { status.value = "unavailable"; detail.value = error.message; }
    throw error;
  });
  return initPromise;
}

const spent = (id: string) => (threadTurns.get(id) ?? 0) >= MAX_THREAD_TURNS;

async function ensureThread(pet?: PetId, developerInstructions?: string) {
  createdThread = false;
  // Thread longa demais: o histórico volta inteiro a cada turno, então começa uma nova.
  if (threadId && threadPet === pet && spent(threadId)) { if (pet) petThreads.delete(pet); threadId = ""; }
  if (threadId && threadPet === pet) return threadId;
  if (pet) {
    const existing = petThreads.get(pet);
    if (existing && !spent(existing)) { threadId = existing; threadPet = pet; return existing; }
    if (existing) petThreads.delete(pet);
  }
  threadId = "";
  threadPet = pet;
  // Pede aprovação para tudo que não for leitura segura; edições ficam dentro da pasta.
  const canWrite = !pet || pet === "work";
  const response = await request("thread/start", {
    cwd: cwd.value,
    approvalPolicy: canWrite ? "untrusted" : "never",
    sandbox: canWrite ? "workspace-write" : "read-only",
    ...(developerInstructions ? { developerInstructions } : {}),
  });
  threadId = response.thread.id;
  createdThread = true;
  if (pet) petThreads.set(pet, threadId);
  return threadId;
}

interface SendOptions {
  pet?: PetId;
  developerInstructions?: string;
  /** Contexto do app (tarefas, notificações): só vai se mudou desde o último envio nesta thread. */
  context?: string;
  /** Hora e afins: vai sempre, por ser curto. */
  always?: string;
  /** Conversa dos outros agentes: só ao trocar de agente ou numa thread nova. */
  shared?: () => string;
}

/** Resposta de um agente fora do ar: não chama o Codex, então não gasta nada. */
function absentReply(request: string, pet: PetId, text: string) {
  entries.value.push(
    { id: `u-${Date.now()}-${nextId++}`, kind: "user", text: request },
    { id: `away-${Date.now()}-${nextId++}`, kind: "agent", text, streaming: false, pet },
  );
}

async function sendMessage(text: string, options: SendOptions = {}) {
  const body = text.trim();
  if (!body || running.value || !cwd.value) return;
  activePet = options.pet;
  entries.value.push({ id: `u-${Date.now()}-${nextId++}`, kind: "user", text: body });
  const switched = !threadId || threadPet !== options.pet;
  running.value = true;
  try {
    await boot();
    const id = await ensureThread(options.pet, options.developerInstructions);
    const context = contextToSend(options.context ?? "", sentContext.get(id));
    const shared = needsShared(switched, createdThread) ? options.shared?.() ?? "" : "";
    const extras = [options.always, context, shared].filter(Boolean);
    const input = extras.length ? [...extras, `Pedido atual: ${body}`].join("\n\n") : body;
    if (context) sentContext.set(id, options.context ?? "");
    threadTurns.set(id, (threadTurns.get(id) ?? 0) + 1);
    await request("turn/start", { threadId: id, input: [{ type: "text", text: input, text_elements: [] }], cwd: cwd.value, ...effortFor(options.pet) });
  } catch (error) {
    running.value = false;
    fail(error instanceof Error ? error.message : String(error));
  }
}

async function interrupt() {
  if (!threadId || !turnId) return;
  try { await request("turn/interrupt", { threadId, turnId }); } catch { /* o turno já terminou */ }
}

function answer(item: Extract<CodexEntry, { kind: "approval" }>, decision: CodexDecision) {
  item.decision = decision;
  void send({ id: item.requestId, result: { decision } });
}

function newChat() {
  if (running.value) void interrupt();
  threadId = "";
  threadPet = undefined;
  petThreads.clear();
  turnId = "";
  activePet = undefined;
  entries.value = [];
  running.value = false;
}

function setCwd(path: string) {
  const next = path.trim();
  if (!next || next === cwd.value) return;
  cwd.value = next;
  recents.value = [next, ...recents.value.filter((item) => item !== next)].slice(0, MAX_RECENTS);
  persist();
  newChat();
}

async function chooseFolder() {
  try {
    const picked = await invoke<string | null>("pick_folder", { start: cwd.value });
    if (picked) setCwd(picked);
  } catch { /* sem zenity: use o campo de caminho */ }
}

export function useCodex() {
  return {
    cwd, recents, status, detail, entries, running, panelOpen, pendingApprovals,
    boot, sendMessage, absentReply, interrupt, answer, newChat, setCwd, chooseFolder,
    /** Acesso ao app-server para outros recursos (mascotes), em threads próprias. */
    bridge: {
      boot, request, send,
      claimThread: (id: string) => { foreignThreads.add(id); },
      onRaw(handler: (message: any) => void) { rawHandlers.add(handler); return () => rawHandlers.delete(handler); },
    },
    onAttention(handler: (event: { kind: "approval" | "done"; text: string }) => void) {
      attentionHandlers.add(handler);
      return () => attentionHandlers.delete(handler);
    },
  };
}
