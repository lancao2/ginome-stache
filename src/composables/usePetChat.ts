import { reactive, ref } from "vue";

import { PET_IDS, type PetId } from "../pets/data";
import { personaInstructions, stateLine } from "../pets/persona";
import { MAX_THREAD_TURNS, effortFor } from "../pets/budget";
import { isUsageLimit } from "../pets/absence";
import { usePets } from "./usePets";
import { usePetAbsence } from "./usePetAbsence";
import { useCodex } from "./useCodex";

const KEY = "stache.pets.chat";
const KEEP = 30;

export interface PetMessage { id: string; role: "user" | "pet" | "error"; text: string; streaming?: boolean }

function read(): Record<PetId, PetMessage[]> {
  const empty = () => ({ tick: [], papo: [], work: [] }) as Record<PetId, PetMessage[]>;
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<Record<PetId, PetMessage[]>> | null;
    const result = empty();
    for (const id of PET_IDS) result[id] = (saved?.[id] ?? []).filter((m) => m.role !== "error").map((m) => ({ ...m, streaming: false }));
    return result;
  } catch { return empty(); }
}

const chats = reactive<Record<PetId, PetMessage[]>>(read());
const sending = ref<PetId | null>(null);
const threads = new Map<PetId, string>();
const owners = new Map<string, PetId>();
const turnCount = new Map<PetId, number>();
let wired = false;
let counter = 0;

function persist() {
  try {
    const trimmed = Object.fromEntries(PET_IDS.map((id) => [id, chats[id].filter((m) => !m.streaming).slice(-KEEP)]));
    localStorage.setItem(KEY, JSON.stringify(trimmed));
  } catch { /* vale só nesta sessão */ }
}

const lastStreaming = (pet: PetId) => [...chats[pet]].reverse().find((m) => m.role === "pet" && m.streaming);
const nextId = () => `m-${Date.now()}-${counter++}`;

export function usePetChat() {
  const pets = usePets();
  const absence = usePetAbsence();
  const { bridge } = useCodex();

  function wire() {
    if (wired) return;
    wired = true;
    bridge.onRaw((message) => {
      const params = message.params ?? {};
      const pet = typeof params.threadId === "string" ? owners.get(params.threadId) : undefined;
      if (!pet) return;
      const reply = lastStreaming(pet);
      // Conversa é só conversa: qualquer pedido de aprovação é recusado.
      if (message.id !== undefined && typeof message.method === "string" && message.method.endsWith("requestApproval")) {
        void bridge.send({ id: message.id, result: { decision: "decline" } });
      } else if (message.method === "item/agentMessage/delta" && reply) {
        reply.text += params.delta ?? "";
        pets.setBusy(pet, "falando");
      } else if (message.method === "item/completed" && params.item?.type === "agentMessage" && reply) {
        reply.text = params.item.text ?? reply.text;
      } else if (message.method === "turn/completed") {
        finish(pet, params.turn?.status === "failed" ? (params.turn?.error?.message ?? "O Codex não conseguiu responder.") : null, params.turn?.error?.codexErrorInfo);
      } else if (message.method === "error" && !params.willRetry) {
        finish(pet, params.error?.message ?? "Erro do Codex.", params.error?.codexErrorInfo);
      }
    });
  }

  function finish(pet: PetId, error: string | null, info?: unknown) {
    const reply = lastStreaming(pet);
    // Acabaram os tokens: o mascote sai com a desculpa do momento em vez de mostrar um erro seco.
    if (error && isUsageLimit(info, error)) {
      if (reply) chats[pet].splice(chats[pet].indexOf(reply), 1);
      pets.setBusy(pet, null);
      if (sending.value === pet) sending.value = null;
      void absence.reportLimit().then(() => {
        const excuse = absence.excuse(pet);
        if (excuse) chats[pet].push({ id: nextId(), role: "pet", text: excuse });
        persist();
      });
      return;
    }
    if (reply) {
      reply.streaming = false;
      if (!reply.text.trim()) chats[pet].splice(chats[pet].indexOf(reply), 1);
    }
    if (error) chats[pet].push({ id: nextId(), role: "error", text: error });
    else {
      pets.care(pet, "conversar"); // conversar dá carinho (respeita o tempo de espera)
      pets.noteChat(pet);
    }
    pets.setBusy(pet, null);
    if (sending.value === pet) sending.value = null;
    persist();
  }

  async function ensureThread(pet: PetId): Promise<string> {
    const existing = threads.get(pet);
    // Conversa longa fica cara (o histórico volta inteiro a cada turno): a cada tantos turnos, thread nova.
    if (existing && (turnCount.get(pet) ?? 0) < MAX_THREAD_TURNS) return existing;
    if (existing) { owners.delete(existing); threads.delete(pet); }
    turnCount.set(pet, 0);
    const response = await bridge.request("thread/start", {
      developerInstructions: personaInstructions(pet),
      sandbox: "read-only",
      approvalPolicy: "never",
      ephemeral: true,
    });
    const id = response.thread.id as string;
    threads.set(pet, id);
    owners.set(id, pet);
    bridge.claimThread(id);
    return id;
  }

  async function send(pet: PetId, text: string) {
    const body = text.trim();
    if (!body || sending.value) return;
    const excuse = absence.excuse(pet);
    if (excuse) {
      // Fora do ar: responde a desculpa sem gastar nada.
      chats[pet].push({ id: nextId(), role: "user", text: body }, { id: nextId(), role: "pet", text: excuse });
      persist();
      return;
    }
    wire();
    sending.value = pet;
    chats[pet].push({ id: nextId(), role: "user", text: body });
    chats[pet].push({ id: nextId(), role: "pet", text: "", streaming: true });
    pets.setBusy(pet, "pensando");
    try {
      await bridge.boot();
      const thread = await ensureThread(pet);
      const input = `${stateLine(pets.states.value[pet], pets.pets[pet].needs, pets.mediaText.value, pets.memoryNote(pet))}\n${body}`;
      turnCount.set(pet, (turnCount.get(pet) ?? 0) + 1);
      await bridge.request("turn/start", { threadId: thread, input: [{ type: "text", text: input, text_elements: [] }], ...effortFor(pet, true) });
    } catch (error) {
      finish(pet, error instanceof Error ? error.message : String(error));
    }
  }

  function clear(pet: PetId) {
    if (sending.value === pet) return;
    chats[pet].splice(0);
    const thread = threads.get(pet);
    if (thread) { owners.delete(thread); threads.delete(pet); }
    turnCount.delete(pet);
    persist();
  }

  return { chats, sending, send, clear };
}
