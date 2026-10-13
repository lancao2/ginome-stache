// Motor das necessidades: funções puras, sem Vue nem Tauri, para ficarem fáceis de testar.
import { NEEDS, type CareAction, type NeedId, type PetProfile, type PetState } from "./data.ts";
import { freshMemory, type PetMemory } from "./memory.ts";

export type Needs = Record<NeedId, number>;

export interface PetData {
  needs: Needs;
  lastCare: Partial<Record<CareAction, number>>;
  lastInteraction: number;
  memory: PetMemory;
}

/** Pontos perdidos por hora, antes do multiplicador do temperamento. */
const BASE_RATE: Record<NeedId, number> = { fome: 6, diversao: 5, higiene: 3.5, carinho: 4, proposito: 4 };

export const LIMITS = {
  sad: 28, // média abaixo disso: triste (e sem tarefas com IA)
  irritated: 20, // necessidade irritante abaixo disso: com raiva
  hungry: 25,
  bored: 30,
  happy: 75,
  mediaCap: 80, // a música sozinha não enche a Diversão além disso
  mediaPerHour: 120, // +2 por minuto com a música certa
  trackBonus: 3,
  repeatMinutes: 5, // depois disso a mesma faixa rende menos
  repeatFactor: 0.25,
  likedFactor: 1.5,
  offlineFloor: 20, // ficar fora não zera ninguém
  offlineMaxHours: 8,
  sleepFrom: 0,
  sleepTo: 6,
  sleepIdleMinutes: 30,
} as const;

export const COOLDOWN_MIN: Record<CareAction, number> = { comer: 20, brincar: 10, banho: 30, conversar: 5 };

const CARE_EFFECT: Record<CareAction, Partial<Record<NeedId, number>>> = {
  comer: { fome: 35 },
  brincar: { diversao: 30, higiene: -4 },
  banho: { higiene: 45 },
  conversar: { carinho: 25 },
};

/** Necessidade principal de cada ação; se já estiver quase cheia, o mascote recusa. */
const CARE_TARGET: Record<CareAction, NeedId> = { comer: "fome", brincar: "diversao", banho: "higiene", conversar: "carinho" };
const FULL_AT = 92;

const clamp = (value: number) => Math.min(100, Math.max(0, value));

export function freshPet(now: number): PetData {
  return { needs: { fome: 80, diversao: 80, higiene: 85, carinho: 80, proposito: 75 }, lastCare: {}, lastInteraction: now, memory: freshMemory(now) };
}

export function average(needs: Needs): number {
  return NEEDS.reduce((sum, need) => sum + needs[need], 0) / NEEDS.length;
}

/** `pressure` (0 a 5) acelera só a necessidade irritante: tarefas atrasadas, notificações, erros. */
function rate(profile: PetProfile, need: NeedId, pressure: number) {
  const base = BASE_RATE[need] * profile.taxas[need];
  return need === profile.irritante ? base * (1 + Math.min(5, Math.max(0, pressure)) * 0.4) : base;
}

/** Avança `hours` com o app aberto. `mediaFactor` > 0 quando a música enche a Diversão. */
export function advance(data: PetData, profile: PetProfile, hours: number, pressure: number, mediaFactor: number): PetData {
  const needs = { ...data.needs };
  for (const need of NEEDS) needs[need] = clamp(needs[need] - rate(profile, need, pressure) * hours);
  if (mediaFactor > 0 && needs.diversao < LIMITS.mediaCap)
    needs.diversao = Math.min(LIMITS.mediaCap, needs.diversao + LIMITS.mediaPerHour * mediaFactor * hours);
  return { ...data, needs };
}

/** Tempo com o app fechado: só desgaste, com teto de horas e um piso. Nunca há ganho passivo. */
export function advanceOffline(data: PetData, profile: PetProfile, hours: number): PetData {
  const capped = Math.min(hours, LIMITS.offlineMaxHours);
  const needs = { ...data.needs };
  for (const need of NEEDS) {
    if (needs[need] <= LIMITS.offlineFloor) continue;
    needs[need] = Math.max(LIMITS.offlineFloor, needs[need] - rate(profile, need, 0) * capped);
  }
  return { ...data, needs };
}

/** Fator de ganho da música: 1,5× para o que ele gosta e 0,25× para a mesma faixa por muito tempo. */
export function mediaFactor(profile: PetProfile, text: string, sameTrackMinutes: number): number {
  const lower = text.toLowerCase();
  const liked = profile.gosta.some((word) => lower.includes(word));
  const repeat = sameTrackMinutes >= LIMITS.repeatMinutes ? LIMITS.repeatFactor : 1;
  return (liked ? LIMITS.likedFactor : 1) * repeat;
}

export function isSleepTime(now: Date, idleMs: number): boolean {
  const hour = now.getHours();
  return hour >= LIMITS.sleepFrom && hour < LIMITS.sleepTo && idleMs > LIMITS.sleepIdleMinutes * 60_000;
}

export function isSad(needs: Needs): boolean {
  return average(needs) < LIMITS.sad;
}

/** Estado visual de base; ações e tarefas (comendo, trabalhando…) se sobrepõem a este. */
export function deriveState(profile: PetProfile, needs: Needs, ctx: { sleeping: boolean; mediaPlaying: boolean }): PetState {
  if (ctx.sleeping) return "dormindo";
  if (isSad(needs)) return "triste";
  if (needs[profile.irritante] < LIMITS.irritated) return "raiva";
  if (needs.fome < LIMITS.hungry) return "fome";
  if (needs.diversao < LIMITS.bored) return "entediado";
  if (ctx.mediaPlaying) return "musica";
  if (average(needs) >= LIMITS.happy) return "feliz";
  return "parado";
}

/** Precisa de cuidado agora (aparece mais vezes na ilha e marca a aba). */
export function needsCare(state: PetState): boolean {
  return state === "triste" || state === "raiva" || state === "fome" || state === "entediado";
}

/** Estados que viram aviso na ilha quando o mascote entra neles; entediado só aparece na espiada. */
export const ALERT_STATES: readonly PetState[] = ["fome", "raiva", "triste"];
export const ALERT_COOLDOWN_MS = 30 * 60_000;

/** Avisa só na entrada num estado de necessidade, e no máximo uma vez por meia hora por mascote e estado. */
export function alertDue(previous: PetState, next: PetState, lastAlertAt: number, now: number): boolean {
  return next !== previous && ALERT_STATES.includes(next) && now - lastAlertAt >= ALERT_COOLDOWN_MS;
}

export type CareResult =
  | { ok: true; data: PetData }
  | { ok: false; reason: "cheio" | "cooldown"; waitMs?: number };

export function applyCare(data: PetData, action: CareAction, now: number): CareResult {
  if (data.needs[CARE_TARGET[action]] >= FULL_AT) return { ok: false, reason: "cheio" };
  const last = data.lastCare[action] ?? 0;
  const waitMs = COOLDOWN_MIN[action] * 60_000 - (now - last);
  if (waitMs > 0) return { ok: false, reason: "cooldown", waitMs };
  const needs = { ...data.needs };
  for (const [need, delta] of Object.entries(CARE_EFFECT[action]) as [NeedId, number][]) needs[need] = clamp(needs[need] + delta);
  return { ok: true, data: { ...data, needs, lastCare: { ...data.lastCare, [action]: now }, lastInteraction: now } };
}

/** Ao concluir uma tarefa com IA: Propósito sobe, o resto desgasta um pouco. */
export function applyTaskDone(data: PetData, success: boolean, now: number): PetData {
  const needs = { ...data.needs };
  if (success) needs.proposito = clamp(needs.proposito + 20);
  needs.diversao = clamp(needs.diversao - 4);
  needs.higiene = clamp(needs.higiene - (success ? 4 : 10));
  if (!success) needs.carinho = clamp(needs.carinho - 6);
  return { ...data, needs, lastInteraction: now };
}

/** Tarefa com IA liberada? Só quando o mascote não está triste. */
export function canWork(data: PetData): boolean {
  return !isSad(data.needs);
}
