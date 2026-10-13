import { reactive, ref } from "vue";

import { PET_IDS, PROFILES, pickLine, type PetId } from "../pets/data";
import { isUsageLimit } from "../pets/absence";
import { CONTEXT, clip, effortFor } from "../pets/budget";
import { taskInstructions } from "../pets/persona";
import { useClipboard } from "./useClipboard";
import { useCodex } from "./useCodex";
import { useNotifications } from "./useNotifications";
import { usePets } from "./usePets";
import { usePetAbsence } from "./usePetAbsence";
import { useTasks } from "./useTasks";

export type TaskDecision = "accept" | "decline";

export type TaskEntry =
  | { id: string; kind: "agent"; text: string; streaming: boolean }
  | { id: string; kind: "command"; command: string; status: string; output: string; exitCode: number | null }
  | { id: string; kind: "files"; files: { path: string; change: string }[]; status: string }
  | { id: string; kind: "approval"; requestId: string | number; what: "command" | "files"; title: string; detail: string; decision: TaskDecision | null }
  | { id: string; kind: "error"; text: string };

export type RunStatus = "idle" | "running" | "done" | "failed" | "stopped";

export interface PetRun { prompt: string; status: RunStatus; entries: TaskEntry[] }

/** Sugestões de tarefa por mascote: o que cada um sabe fazer com o contexto que o Stache já tem. */
export const PRESETS: Record<PetId, { label: string; prompt: string }[]> = {
  tick: [
    { label: "Resumir meu dia", prompt: "Resuma o que tenho para hoje e diga por onde começar." },
    { label: "Priorizar atrasadas", prompt: "Priorize minhas tarefas atrasadas e sugira um plano realista para colocá-las em dia." },
    { label: "Planejar a semana", prompt: "Monte um plano simples para esta semana com base nas minhas tarefas pendentes." },
  ],
  papo: [
    { label: "Resumir notificações", prompt: "Resuma minhas notificações pendentes e diga quais merecem resposta primeiro." },
    { label: "Reescrever o copiado", prompt: "Reescreva o texto copiado de forma clara e educada, mantendo o sentido." },
    { label: "Sugerir resposta", prompt: "Sugira duas respostas curtas e naturais para o texto copiado." },
  ],
  work: [
    { label: "Explicar o projeto", prompt: "Explique de forma breve o que este projeto faz e como ele está organizado." },
    { label: "Achar bugs óbvios", prompt: "Leia o código com atenção e liste problemas óbvios, sem alterar nada." },
    { label: "Rodar os testes", prompt: "Descubra como rodar os testes deste projeto, rode e resuma o resultado." },
  ],
};

const SETUP: Record<PetId, { sandbox: "read-only" | "workspace-write"; approval: "never" | "untrusted"; needsFolder: boolean }> = {
  tick: { sandbox: "read-only", approval: "never", needsFolder: false },
  papo: { sandbox: "read-only", approval: "never", needsFolder: false },
  work: { sandbox: "workspace-write", approval: "untrusted", needsFolder: true },
};

const MAX_OUTPUT = 20_000;
const attentionHandlers = new Set<(event: { pet: PetId; kind: "approval" | "done"; text: string }) => void>();
const panelOpen = ref(false);

const emptyRun = (): PetRun => ({ prompt: "", status: "idle", entries: [] });
const runs = reactive<Record<PetId, PetRun>>({ tick: emptyRun(), papo: emptyRun(), work: emptyRun() });
const threads = new Map<PetId, string>();
const turns = new Map<PetId, string>();
const owners = new Map<string, PetId>();
let wired = false;
let counter = 0;
const nextId = () => `t-${Date.now()}-${counter++}`;

function entry<K extends TaskEntry["kind"]>(pet: PetId, id: string, kind: K) {
  return runs[pet].entries.find((item) => item.id === id && item.kind === kind) as Extract<TaskEntry, { kind: K }> | undefined;
}

function attention(pet: PetId, kind: "approval" | "done", text: string) {
  if (panelOpen.value) return;
  for (const handler of attentionHandlers) handler({ pet, kind, text });
}

export function usePetTasks() {
  const pets = usePets();
  const absence = usePetAbsence();
  const codex = useCodex();
  const { bridge } = codex;

  /** O que será enviado ao Codex como contexto, para o usuário saber antes de rodar. */
  function context(pet: PetId): { label: string; text: string; body: string; now: string } {
    if (pet === "tick") {
      const now = Date.now();
      const open = useTasks().tasks.value.filter((task) => !task.done).slice(0, CONTEXT.tasks);
      const lines = open.map((task) => {
        const due = task.dueDate ? ` · prazo ${task.dueDate}${task.dueTime ? ` ${task.dueTime}` : ""}` : "";
        const late = task.dueDate && new Date(`${task.dueDate}T${task.dueTime ?? "23:59"}`).getTime() < now ? " · ATRASADA" : "";
        return `- ${task.priority > 0 ? "[prioridade] " : ""}${task.title}${due}${late}${task.notes ? ` (${clip(task.notes, CONTEXT.taskNotes)})` : ""}`;
      });
      const body = `Tarefas pendentes:\n${lines.join("\n") || "(nenhuma)"}`;
      const current = `Agora: ${new Date(now).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}.`;
      return { label: `${open.length} tarefa(s) pendente(s)`, text: `${current}\n${body}`, body, now: current };
    }
    if (pet === "papo") {
      const notes = useNotifications().notifications.value.slice(0, CONTEXT.notifications);
      const copied = useClipboard().items.value.find((item) => item.kind === "text" && item.text.trim());
      const parts = [
        `Notificações:\n${notes.map((note) => `- ${note.app}: ${note.summary}${note.body ? ` — ${clip(note.body, CONTEXT.notificationBody)}` : ""}`).join("\n") || "(nenhuma)"}`,
        `Último texto copiado:\n${copied ? clip(copied.text, CONTEXT.clipboard) : "(nenhum)"}`,
      ];
      const text = parts.join("\n\n");
      return { label: `${notes.length} notificação(ões)${copied ? " + texto copiado" : ""}`, text, body: text, now: "" };
    }
    return { label: codex.cwd.value ? `Pasta: ${codex.cwd.value}` : "Nenhuma pasta escolhida", text: "", body: "", now: "" };
  }

  function wire() {
    if (wired) return;
    wired = true;
    bridge.onRaw((message) => {
      const params = message.params ?? {};
      const pet = typeof params.threadId === "string" ? owners.get(params.threadId) : undefined;
      if (!pet) return;
      if (message.id !== undefined && typeof message.method === "string") return onRequest(pet, message);
      onNotification(pet, message.method, params);
    });
  }

  function onRequest(pet: PetId, message: any) {
    const params = message.params ?? {};
    const isCommand = message.method === "item/commandExecution/requestApproval";
    const isFiles = message.method === "item/fileChange/requestApproval";
    // Só o Work pode pedir aprovação; para os outros ou para pedidos desconhecidos a resposta é não.
    if (pet !== "work" || (!isCommand && !isFiles)) {
      void bridge.send({ id: message.id, result: isCommand || isFiles ? { decision: "decline" } : undefined, error: isCommand || isFiles ? undefined : { code: -32601, message: "Não suportado pelo Stache." } });
      return;
    }
    const files = isFiles ? entry(pet, params.itemId, "files")?.files.map((file) => file.path).join("\n") : "";
    runs[pet].entries.push({
      id: `ap-${message.id}`, kind: "approval", requestId: message.id, what: isCommand ? "command" : "files", decision: null,
      title: isCommand ? "Executar comando" : "Alterar arquivos",
      detail: isCommand ? [params.command, params.reason].filter(Boolean).join("\n") : [files, params.reason].filter(Boolean).join("\n"),
    });
    attention(pet, "approval", isCommand ? "pede aprovação para executar um comando" : "pede aprovação para alterar arquivos");
  }

  function onItem(pet: PetId, item: any, done: boolean) {
    switch (item?.type) {
      case "agentMessage": {
        const existing = entry(pet, item.id, "agent");
        if (existing) { if (done) { existing.text = item.text ?? existing.text; existing.streaming = false; } }
        else runs[pet].entries.push({ id: item.id, kind: "agent", text: item.text ?? "", streaming: !done });
        break;
      }
      case "commandExecution": {
        const output = (item.aggregatedOutput ?? "").slice(-MAX_OUTPUT);
        const existing = entry(pet, item.id, "command");
        if (existing) { existing.status = item.status; existing.output = output || existing.output; existing.exitCode = item.exitCode ?? null; }
        else runs[pet].entries.push({ id: item.id, kind: "command", command: item.command, status: item.status, output, exitCode: item.exitCode ?? null });
        break;
      }
      case "fileChange": {
        const files = (item.changes ?? []).map((change: any) => ({ path: change.path, change: change.kind?.type ?? "update" }));
        const existing = entry(pet, item.id, "files");
        if (existing) { existing.files = files; existing.status = item.status; }
        else runs[pet].entries.push({ id: item.id, kind: "files", files, status: item.status });
        break;
      }
    }
  }

  function onNotification(pet: PetId, method: string, params: any) {
    switch (method) {
      case "turn/started": turns.set(pet, params.turn?.id ?? ""); break;
      case "item/started": onItem(pet, params.item, false); break;
      case "item/completed": onItem(pet, params.item, true); break;
      case "item/agentMessage/delta": {
        const existing = entry(pet, params.itemId, "agent");
        if (existing) existing.text += params.delta;
        else runs[pet].entries.push({ id: params.itemId, kind: "agent", text: params.delta, streaming: true });
        break;
      }
      case "item/commandExecution/outputDelta": {
        const existing = entry(pet, params.itemId, "command");
        if (existing) existing.output = (existing.output + params.delta).slice(-MAX_OUTPUT);
        break;
      }
      case "turn/completed": {
        const status = params.turn?.status;
        if (status === "failed") finish(pet, "failed", params.turn?.error?.message ?? "O Codex não conseguiu terminar.", params.turn?.error?.codexErrorInfo);
        else finish(pet, status === "interrupted" ? "stopped" : "done");
        break;
      }
      case "error":
        if (!params.willRetry) finish(pet, "failed", params.error?.message ?? "Erro do Codex.", params.error?.codexErrorInfo);
        break;
    }
  }

  function finish(pet: PetId, status: Exclude<RunStatus, "idle" | "running">, error?: string, info?: unknown) {
    const run = runs[pet];
    if (run.status !== "running") return;
    // Acabaram os tokens: a tarefa não conta como falha do mascote, ele só sai (e a desculpa aparece no lugar do erro).
    if (error && isUsageLimit(info, error)) {
      for (const item of run.entries) if (item.kind === "agent") item.streaming = false;
      for (const item of run.entries) if (item.kind === "approval" && item.decision === null) item.decision = "decline";
      run.status = "stopped";
      turns.delete(pet);
      pets.setBusy(pet, null);
      void absence.reportLimit().then(() => {
        const excuse = absence.excuse(pet);
        if (excuse) run.entries.push({ id: nextId(), kind: "error", text: excuse });
      });
      return;
    }
    for (const item of run.entries) if (item.kind === "agent") item.streaming = false;
    // Aprovações que ficaram sem resposta deixam de valer.
    for (const item of run.entries) if (item.kind === "approval" && item.decision === null) item.decision = "decline";
    if (error) run.entries.push({ id: nextId(), kind: "error", text: error });
    run.status = status;
    turns.delete(pet);
    pets.setBusy(pet, null);
    if (status !== "stopped") pets.taskDone(pet, status === "done");
    if (status === "done") attention(pet, "done", "terminou a tarefa");
    else if (status === "failed") attention(pet, "done", "não conseguiu terminar a tarefa");
  }

  /** Inicia uma tarefa. Mascote triste recusa, em personagem. */
  async function run(pet: PetId, prompt: string): Promise<{ ok: boolean; line: string }> {
    const body = prompt.trim();
    const profile = PROFILES[pet];
    if (!body || runs[pet].status === "running") return { ok: false, line: "" };
    const excuse = absence.excuse(pet);
    if (excuse) {
      pets.speech.value = { ...pets.speech.value, [pet]: excuse };
      return { ok: false, line: excuse };
    }
    if (!pets.canWork(pet)) {
      const line = pickLine(pet, "recusa");
      pets.speech.value = { ...pets.speech.value, [pet]: line };
      return { ok: false, line };
    }
    const setup = SETUP[pet];
    if (setup.needsFolder && !codex.cwd.value) {
      const line = `${profile.nome} precisa de uma pasta de trabalho. Escolha uma pasta primeiro.`;
      return { ok: false, line };
    }
    wire();
    runs[pet] = { prompt: body, status: "running", entries: [] };
    pets.setBusy(pet, "trabalhando");
    try {
      await bridge.boot();
      const response = await bridge.request("thread/start", {
        developerInstructions: taskInstructions(pet),
        sandbox: setup.sandbox,
        approvalPolicy: setup.approval,
        ephemeral: true,
        ...(setup.needsFolder ? { cwd: codex.cwd.value } : {}),
      });
      const id = response.thread.id as string;
      threads.set(pet, id);
      owners.set(id, pet);
      bridge.claimThread(id);
      const ctx = context(pet).text;
      const input = ctx ? `${ctx}\n\nPedido: ${body}` : body;
      await bridge.request("turn/start", { threadId: id, input: [{ type: "text", text: input, text_elements: [] }], ...effortFor(pet) });
      return { ok: true, line: "" };
    } catch (error) {
      finish(pet, "failed", error instanceof Error ? error.message : String(error));
      return { ok: false, line: "" };
    }
  }

  async function stop(pet: PetId) {
    const thread = threads.get(pet);
    const turn = turns.get(pet);
    if (!thread || !turn) return;
    try { await bridge.request("turn/interrupt", { threadId: thread, turnId: turn }); } catch { /* o turno já terminou */ }
  }

  function answer(item: Extract<TaskEntry, { kind: "approval" }>, decision: TaskDecision) {
    item.decision = decision;
    void bridge.send({ id: item.requestId, result: { decision } });
  }

  function reset(pet: PetId) {
    if (runs[pet].status === "running") return;
    runs[pet] = emptyRun();
    const thread = threads.get(pet);
    if (thread) { owners.delete(thread); threads.delete(pet); }
  }

  const pending = () => PET_IDS.reduce((sum, id) => sum + runs[id].entries.filter((item) => item.kind === "approval" && item.decision === null).length, 0);

  return {
    runs, panelOpen, presets: PRESETS, context, run, stop, answer, reset, pending,
    cwd: codex.cwd, chooseFolder: codex.chooseFolder,
    needsFolder: (pet: PetId) => SETUP[pet].needsFolder,
    onAttention(handler: (event: { pet: PetId; kind: "approval" | "done"; text: string }) => void) {
      attentionHandlers.add(handler);
      return () => attentionHandlers.delete(handler);
    },
  };
}
