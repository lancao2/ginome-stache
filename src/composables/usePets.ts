import { computed, reactive, ref } from "vue";

import { CARE_LABEL, NEEDS, PET_IDS, PROFILES, pickLine, type CareAction, type PetId, type PetState } from "../pets/data";
import { EVENT_TITLE, absenceLine, eventLine, type EventKind } from "../pets/lines";
import {
  absenceOf, anniversaryDue, dailyEventDue, dayKey, daysTogether, freshMemory, memorySummary, touch, type InteractionKind,
} from "../pets/memory";
import {
  alertDue, advance, advanceOffline, applyCare, applyTaskDone, canWork as engineCanWork, deriveState, freshPet, isSleepTime, mediaFactor, needsCare,
  COOLDOWN_MIN, LIMITS, type PetData,
} from "../pets/engine";
import { returnBoost } from "../pets/absence";
import { useCodex } from "./useCodex";
import { usePetAbsence } from "./usePetAbsence";
import { useNotifications } from "./useNotifications";
import { useTasks } from "./useTasks";
import { useWhatsapp } from "./useWhatsapp";

const KEY = "stache.pets";
const TICK_MS = 30_000;
const TRANSIENT_MS = 3_500;
const OFFLINE_GAP_MS = 120_000;

interface Saved { v: 1; at: number; pets: Record<PetId, PetData> }

function load(now: number): Saved {
  const fresh = (): Saved => ({ v: 1, at: now, pets: { tick: freshPet(now), papo: freshPet(now), work: freshPet(now) } });
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null") as Saved | null;
    if (!raw || raw.v !== 1) return fresh();
    const saved = fresh();
    const hours = Math.max(0, (now - raw.at) / 3_600_000);
    for (const id of PET_IDS) {
      const stored = raw.pets?.[id];
      if (!stored?.needs) continue;
      saved.pets[id] = advanceOffline({ ...freshPet(now), ...stored, lastCare: stored.lastCare ?? {}, memory: { ...freshMemory(now), ...stored.memory } }, PROFILES[id], hours);
    }
    return saved;
  } catch { return fresh(); }
}

const startedAt = Date.now();
const pets = reactive<Record<PetId, PetData>>(load(startedAt).pets);
const clock = ref(startedAt);
const transient = ref<Partial<Record<PetId, { state: PetState; line: string }>>>({});
const speech = ref<Partial<Record<PetId, string>>>({});
// Estados mantidos por quem está usando o mascote (conversa em andamento), até serem limpos.
const busy = ref<Partial<Record<PetId, PetState>>>({});

const media = reactive({ playing: false, key: "", text: "", since: 0 });

let started = false;
let lastTick = startedAt;
const transientTimers = new Map<PetId, number>();
const alertHandlers = new Set<(event: { pet: PetId; state: PetState; text: string }) => void>();
const lastAlert = new Map<string, number>();
let previousStates: Partial<Record<PetId, PetState>> = {};
const eventHandlers = new Set<(event: PetEvent) => void>();

export interface PetEvent { pet: PetId; kind: EventKind; title: string; text: string }

function save() {
  try { localStorage.setItem(KEY, JSON.stringify({ v: 1, at: Date.now(), pets } satisfies Saved)); }
  catch { /* sem armazenamento: vale só nesta sessão */ }
}

// Sinais do sistema: aceleram só a necessidade irritante de cada mascote.
function pressure(id: PetId): number {
  if (id === "tick") {
    const now = Date.now();
    return useTasks().tasks.value.filter((task) => {
      if (task.done || !task.dueDate) return false;
      return new Date(`${task.dueDate}T${task.dueTime ?? "23:59"}`).getTime() < now;
    }).length;
  }
  if (id === "papo") return Math.floor((useNotifications().count.value + useWhatsapp().unread.value) / 3);
  return useCodex().entries.value.filter((entry) => entry.kind === "error").length;
}

function tick() {
  const now = Date.now();
  const gap = now - lastTick;
  lastTick = now;
  clock.value = now;
  // Ausentes (sem tokens): ninguém gasta nem ganha necessidade enquanto estão fora.
  const absent = usePetAbsence().isAway.value;
  for (const id of PET_IDS) {
    if (absent) break;
    const profile = PROFILES[id];
    if (gap > OFFLINE_GAP_MS) { pets[id] = advanceOffline(pets[id], profile, gap / 3_600_000); continue; }
    const factor = media.playing ? mediaFactor(profile, media.text, (now - media.since) / 60_000) : 0;
    pets[id] = advance(pets[id], profile, gap / 3_600_000, pressure(id), factor);
  }
  save();
  notifyNeeds(now);
  checkEvents(now);
}

// Aviso na ilha quando um mascote passa a precisar de cuidado (fome, raiva, tristeza).
function notifyNeeds(now: number) {
  if (usePetAbsence().isAway.value) { for (const id of PET_IDS) previousStates[id] = stateOf(id); return; }
  for (const id of PET_IDS) {
    const state = stateOf(id);
    const previous = previousStates[id];
    previousStates[id] = state;
    if (previous === undefined) continue; // o primeiro ciclo só registra o ponto de partida
    const key = `${id}:${state}`;
    if (!alertDue(previous, state, lastAlert.get(key) ?? 0, now)) continue;
    lastAlert.set(key, now);
    const text = pickLine(id, state);
    speech.value = { ...speech.value, [id]: text };
    for (const handler of alertHandlers) handler({ pet: id, state, text });
  }
}

const clampNeed = (value: number) => Math.min(100, Math.max(0, value));

function boost(id: PetId, gains: Partial<Record<(typeof NEEDS)[number], number>>) {
  const needs = { ...pets[id].needs };
  for (const [need, gain] of Object.entries(gains) as [(typeof NEEDS)[number], number][]) needs[need] = clampNeed(needs[need] + gain);
  pets[id] = { ...pets[id], needs };
}

/** Fala, anima e avisa na ilha um evento especial. */
function announce(id: PetId, kind: EventKind, text: string, celebrate: boolean) {
  speech.value = { ...speech.value, [id]: text };
  if (celebrate) setTransient(id, "feliz", text);
  for (const handler of eventHandlers) handler({ pet: id, kind, title: EVENT_TITLE[kind], text });
}

/** Registra que o usuário cuidou, conversou ou deu tarefa: sequência, contadores, saudade e marcos. */
function register(id: PetId, kind: InteractionKind) {
  const now = Date.now();
  const result = touch(pets[id].memory, now, kind);
  pets[id] = { ...pets[id], memory: result.memory };
  if (result.returned !== "nenhuma") {
    boost(id, { carinho: 10 }); // voltar depois de sumir conta como carinho
    speech.value = { ...speech.value, [id]: eventLine(id, "reencontro") };
  }
  for (const milestone of result.milestones) {
    boost(id, { diversao: 10, carinho: 10 });
    announce(id, "marco", eventLine(id, "marco", { marco: milestone.label }), true);
  }
  save();
}

// Eventos do dia: aniversário de convivência e um evento aleatório por dia (presente ou comentário de madrugada).
function checkEvents(now: number) {
  if (usePetAbsence().isAway.value) return;
  for (const id of PET_IDS) {
    if (stateOf(id) === "dormindo") continue;
    const memory = pets[id].memory;
    const years = anniversaryDue(memory, now);
    if (years > 0) {
      pets[id] = { ...pets[id], memory: { ...memory, anniversaryYear: new Date(now).getFullYear() } };
      boost(id, { diversao: 20, carinho: 20 });
      announce(id, "aniversario", eventLine(id, "aniversario", { anos: years }), true);
      continue;
    }
    const active = now - pets[id].lastInteraction < 10 * 60_000;
    const kind = dailyEventDue(memory, now, active, Math.random);
    if (!kind) continue;
    pets[id] = { ...pets[id], memory: { ...memory, eventDay: dayKey(now) } };
    if (kind === "presente") boost(id, { fome: 20, diversao: 10 });
    announce(id, kind, eventLine(id, kind), kind === "presente");
  }
}

// Ao abrir o app depois de um tempo: o mascote mais magoado cobra a ausência na ilha; os outros só falam no painel.
function greetAbsence() {
  const now = Date.now();
  const missed = PET_IDS
    .map((id) => ({ id, away: absenceOf(pets[id].memory.lastSeenAt, now), memory: pets[id].memory }))
    .filter((item) => item.away !== "nenhuma" && item.memory.greetedFor !== item.memory.lastSeenAt);
  if (!missed.length) return;
  missed.sort((a, b) => a.memory.lastSeenAt - b.memory.lastSeenAt);
  missed.forEach((item, index) => {
    const text = absenceLine(item.id, item.away as "ontem" | "dias" | "semana");
    pets[item.id] = { ...pets[item.id], memory: { ...item.memory, greetedFor: item.memory.lastSeenAt } };
    if (index === 0) announce(item.id, "saudade", text, false);
    else speech.value = { ...speech.value, [item.id]: text };
  });
  save();
}

function start() {
  if (started) return;
  started = true;
  window.setTimeout(greetAbsence, 10_000);
  // Voltaram da ausência: comer, dormir ou passear faz bem, e a volta conta como encontro.
  usePetAbsence().onReturn(({ pet, reason, text }) => {
    boost(pet, returnBoost(reason));
    speech.value = { ...speech.value, [pet]: text };
    pets[pet].lastInteraction = Date.now();
    lastTick = Date.now();
    save();
  });
  for (const id of PET_IDS) previousStates[id] = stateOf(id);
  window.setInterval(tick, TICK_MS);
  window.addEventListener("beforeunload", save);
}

/** Estado da música vindo da ilha: tocando, faixa atual e texto para casar com os gostos. */
function setMedia(playing: boolean, key: string, text: string) {
  const now = Date.now();
  const changed = key !== media.key;
  if (playing && changed) {
    media.since = now;
    // Faixa nova rende um pequeno bônus, respeitando o teto da música.
    for (const id of PET_IDS) {
      const pet = pets[id];
      if (pet.needs.diversao < LIMITS.mediaCap)
        pet.needs.diversao = Math.min(LIMITS.mediaCap, pet.needs.diversao + LIMITS.trackBonus);
    }
  }
  if (!media.playing && playing) media.since = changed || !media.since ? now : media.since;
  media.playing = playing;
  media.key = key;
  media.text = text;
}

function setTransient(id: PetId, state: PetState, line: string) {
  transient.value = { ...transient.value, [id]: { state, line } };
  speech.value = { ...speech.value, [id]: line };
  window.clearTimeout(transientTimers.get(id));
  transientTimers.set(id, window.setTimeout(() => {
    const next = { ...transient.value };
    delete next[id];
    transient.value = next;
  }, TRANSIENT_MS));
}

const CARE_STATE: Record<CareAction, PetState> = { comer: "comendo", brincar: "brincando", banho: "banho", conversar: "falando" };

function care(id: PetId, action: CareAction): { ok: boolean; line: string } {
  const excuse = usePetAbsence().excuse(id);
  if (excuse) return { ok: false, line: excuse };
  const result = applyCare(pets[id], action, Date.now());
  if (!result.ok) {
    const line = pickLine(id, result.reason);
    speech.value = { ...speech.value, [id]: line };
    return { ok: false, line };
  }
  pets[id] = result.data;
  const state = CARE_STATE[action];
  const line = pickLine(id, state);
  setTransient(id, state, line);
  register(id, "cuidado");
  return { ok: true, line };
}

/** Tempo que falta (ms) para a ação voltar a estar disponível. */
function cooldownLeft(id: PetId, action: CareAction, now = clock.value): number {
  return Math.max(0, COOLDOWN_MIN[action] * 60_000 - (now - (pets[id].lastCare[action] ?? 0)));
}

/** Estado exibido: ação em curso, tarefa do Codex ou o estado derivado das necessidades. */
function stateOf(id: PetId): PetState {
  const action = transient.value[id];
  if (action) return action.state;
  const held = busy.value[id];
  if (held) return held;
  if (id === "work" && useCodex().running.value) return "trabalhando";
  const sleeping = isSleepTime(new Date(clock.value), clock.value - pets[id].lastInteraction);
  return deriveState(PROFILES[id], pets[id].needs, { sleeping, mediaPlaying: media.playing });
}

export function usePets() {
  start();
  const states = computed(() => Object.fromEntries(PET_IDS.map((id) => [id, stateOf(id)])) as Record<PetId, PetState>);
  const absence = usePetAbsence();
  const needyCount = computed(() => (absence.isAway.value ? 0 : PET_IDS.filter((id) => needsCare(states.value[id])).length));
  return {
    pets, states, needyCount, speech, clock, mediaPlaying: computed(() => media.playing),
    onNeed(handler: (event: { pet: PetId; state: PetState; text: string }) => void) {
      alertHandlers.add(handler);
      return () => alertHandlers.delete(handler);
    },
    onEvent(handler: (event: PetEvent) => void) {
      eventHandlers.add(handler);
      return () => eventHandlers.delete(handler);
    },
    /** Conversa concluída: conta para a memória. */
    noteChat: (id: PetId) => register(id, "conversa"),
    /** O que o mascote lembra da relação, em texto para o Codex. */
    memoryNote: (id: PetId) => memorySummary(pets[id].memory, Date.now()),
    memoryStats: (id: PetId) => {
      const memory = pets[id].memory;
      return { together: daysTogether(memory, clock.value), streak: memory.streak, tasks: memory.tasksDone, chats: memory.chats };
    },
    care, cooldownLeft, setMedia, careLabel: CARE_LABEL,
    /** Fixa um estado (pensando, falando…) enquanto algo acontece; `null` solta. Também marca a interação. */
    setBusy(id: PetId, state: PetState | null) {
      const next = { ...busy.value };
      if (state) next[id] = state; else delete next[id];
      busy.value = next;
      if (state) pets[id].lastInteraction = Date.now();
    },
    /** Fim de uma tarefa com IA: sucesso enche o Propósito; falha cansa e entristece. */
    taskDone(id: PetId, success: boolean) {
      pets[id] = applyTaskDone(pets[id], success, Date.now());
      register(id, success ? "tarefa" : "tarefa_falha");
    },
    mediaText: computed(() => (media.playing ? media.text : "")),
    canWork: (id: PetId) => engineCanWork(pets[id]),
    say(id: PetId) {
      speech.value = { ...speech.value, [id]: pickLine(id, states.value[id]) };
    },
  };
}
