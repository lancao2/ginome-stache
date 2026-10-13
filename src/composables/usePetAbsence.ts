import { computed, ref } from "vue";

import { PET_IDS, type PetId } from "../pets/data";
import { UNKNOWN_HOLD_MS, excuseLine, newAway, returnLine, usageBlock, type Away, type AwayReason } from "../pets/absence";
import { useAiUsage } from "./useAiUsage";

const KEY = "stache.pets.away";
const FIRST_CHECK_MS = 8_000;
const IDLE_CHECK_MS = 15 * 60_000;
const MIN_WAIT_MS = 30_000;
const MAX_WAIT_MS = 10 * 60_000;

export interface AwayEvent { pet: PetId; text: string; reason: AwayReason }

function read(): Away | null {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null") as Away | null;
    return raw && typeof raw.since === "number" && raw.picks && raw.reason ? raw : null;
  } catch { return null; }
}

const away = ref<Away | null>(read());
const clock = ref(Date.now());
const leaveHandlers = new Set<(event: AwayEvent) => void>();
const returnHandlers = new Set<(event: AwayEvent) => void>();
let started = false;
let timer: number | undefined;

function save() {
  try {
    if (away.value) localStorage.setItem(KEY, JSON.stringify(away.value));
    else localStorage.removeItem(KEY);
  } catch { /* vale só nesta sessão */ }
}

function emit(handlers: Set<(event: AwayEvent) => void>, reason: AwayReason, text: (pet: PetId) => string) {
  for (const pet of PET_IDS) for (const handler of handlers) handler({ pet, text: text(pet), reason });
}

function leave(until: number | null, source: Away["source"]) {
  const now = Date.now();
  if (away.value) {
    // Já ausentes: só adia a volta se o novo horário for mais tarde.
    if (until !== null && (away.value.until === null || until > away.value.until)) { away.value = { ...away.value, until, source }; save(); }
    return;
  }
  const next = newAway(now, until, source);
  away.value = next;
  save();
  emit(leaveHandlers, next.reason, (pet) => excuseLine(pet, next, now));
  schedule();
}

function comeBack() {
  const previous = away.value;
  if (!previous) return;
  away.value = null;
  save();
  emit(returnHandlers, previous.reason, (pet) => returnLine(pet));
  schedule();
}

/** Lê o limite de uso da conta e decide se os mascotes saem, continuam fora ou voltam. */
async function refresh() {
  const ai = useAiUsage();
  await ai.load(true);
  const now = Date.now();
  clock.value = now;
  const block = usageBlock(ai.usage.value, now);
  if (block) { leave(block.until, "usage"); return; }
  const current = away.value;
  if (!current) { schedule(); return; }
  const unreadable = !ai.usage.value.some((item) => item.id === "codex" && item.status === "ok");
  // Sem conseguir ler o uso (ou quando só um erro do Codex avisou), volta quando o prazo estimado passar.
  const deadline = current.until ?? current.since + UNKNOWN_HOLD_MS;
  if (current.source === "usage" && !unreadable) comeBack();
  else if (now >= deadline) comeBack();
  else schedule();
}

function schedule() {
  window.clearTimeout(timer);
  const now = Date.now();
  let wait = IDLE_CHECK_MS;
  if (away.value) {
    const target = away.value.until ?? away.value.since + UNKNOWN_HOLD_MS;
    wait = Math.min(MAX_WAIT_MS, Math.max(MIN_WAIT_MS, target - now + 5_000));
  }
  timer = window.setTimeout(() => void refresh(), wait);
}

function start() {
  if (started) return;
  started = true;
  timer = window.setTimeout(() => void refresh(), FIRST_CHECK_MS);
}

export function usePetAbsence() {
  start();
  return {
    away,
    isAway: computed(() => away.value !== null),
    /** Desculpa do mascote para a ausência atual (vazio se estiver presente). */
    excuse: (pet: PetId) => (away.value ? excuseLine(pet, away.value, Date.now()) : ""),
    /** O Codex recusou por limite: confere a conta para saber a hora da volta e, sem resposta, sai mesmo assim. */
    async reportLimit() {
      if (away.value) return;
      await refresh();
      if (!away.value) leave(null, "error");
    },
    refresh,
    onLeave(handler: (event: AwayEvent) => void) { leaveHandlers.add(handler); return () => leaveHandlers.delete(handler); },
    onReturn(handler: (event: AwayEvent) => void) { returnHandlers.add(handler); return () => returnHandlers.delete(handler); },
  };
}
