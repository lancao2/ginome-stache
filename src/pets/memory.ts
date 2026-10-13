// Memória e eventos especiais dos mascotes: funções puras, sem Vue nem Tauri.

export type AbsenceClass = "nenhuma" | "ontem" | "dias" | "semana";
export type InteractionKind = "cuidado" | "conversa" | "tarefa" | "tarefa_falha";
export type DailyEvent = "presente" | "madrugada";

export interface PetMemory {
  firstMetAt: number;
  /** Última vez que o usuário cuidou, conversou ou deu tarefa a este mascote. */
  lastSeenAt: number;
  /** `lastSeenAt` para o qual o mascote já cobrou a ausência (não repete a bronca). */
  greetedFor: number;
  streak: number;
  streakDay: string;
  cares: number;
  chats: number;
  tasksDone: number;
  tasksFailed: number;
  milestones: string[];
  /** Último dia (local) em que houve um evento aleatório. */
  eventDay: string;
  anniversaryYear: number;
}

export interface Milestone { id: string; label: string }

export const ABSENCE_MIN_HOURS = 8;

export function freshMemory(now: number): PetMemory {
  return {
    firstMetAt: now, lastSeenAt: now, greetedFor: now, streak: 1, streakDay: dayKey(now),
    cares: 0, chats: 0, tasksDone: 0, tasksFailed: 0, milestones: [], eventDay: "", anniversaryYear: 0,
  };
}

/** Dia local no formato AAAA-MM-DD. */
export function dayKey(ts: number): string {
  const date = new Date(ts);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

export function daysBetween(from: string, to: string): number {
  const parse = (key: string) => { const [y, m, d] = key.split("-").map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((parse(to) - parse(from)) / 86_400_000);
}

export function absenceOf(lastSeenAt: number, now: number): AbsenceClass {
  const hours = (now - lastSeenAt) / 3_600_000;
  if (hours < ABSENCE_MIN_HOURS) return "nenhuma";
  if (hours < 48) return "ontem";
  if (hours < 24 * 7) return "dias";
  return "semana";
}

const MILESTONES: { id: string; label: string; reached: (memory: PetMemory, together: number) => boolean }[] = [
  { id: "streak3", label: "3 dias seguidos", reached: (m) => m.streak >= 3 },
  { id: "streak7", label: "7 dias seguidos", reached: (m) => m.streak >= 7 },
  { id: "streak30", label: "30 dias seguidos", reached: (m) => m.streak >= 30 },
  { id: "tarefas10", label: "10 tarefas concluídas", reached: (m) => m.tasksDone >= 10 },
  { id: "tarefas50", label: "50 tarefas concluídas", reached: (m) => m.tasksDone >= 50 },
  { id: "tarefas100", label: "100 tarefas concluídas", reached: (m) => m.tasksDone >= 100 },
  { id: "conversas25", label: "25 conversas", reached: (m) => m.chats >= 25 },
  { id: "conversas100", label: "100 conversas", reached: (m) => m.chats >= 100 },
  { id: "juntos7", label: "1 semana juntos", reached: (_, d) => d >= 7 },
  { id: "juntos30", label: "1 mês juntos", reached: (_, d) => d >= 30 },
  { id: "juntos100", label: "100 dias juntos", reached: (_, d) => d >= 100 },
];

export function daysTogether(memory: PetMemory, now: number): number {
  return Math.max(0, daysBetween(dayKey(memory.firstMetAt), dayKey(now)));
}

/**
 * Registra uma interação: atualiza contadores e a sequência de dias.
 * `returned` diz se o usuário voltou depois de uma ausência (e quão longa); `milestones` são os marcos novos.
 */
export function touch(memory: PetMemory, now: number, kind: InteractionKind): { memory: PetMemory; returned: AbsenceClass; milestones: Milestone[] } {
  const returned = absenceOf(memory.lastSeenAt, now);
  const today = dayKey(now);
  const gap = memory.streakDay ? daysBetween(memory.streakDay, today) : 0;
  const next: PetMemory = {
    ...memory,
    lastSeenAt: now,
    streak: gap === 0 ? memory.streak : gap === 1 ? memory.streak + 1 : 1,
    streakDay: today,
    cares: memory.cares + (kind === "cuidado" ? 1 : 0),
    chats: memory.chats + (kind === "conversa" ? 1 : 0),
    tasksDone: memory.tasksDone + (kind === "tarefa" ? 1 : 0),
    tasksFailed: memory.tasksFailed + (kind === "tarefa_falha" ? 1 : 0),
  };
  const together = daysTogether(next, now);
  const fresh = MILESTONES.filter((item) => !next.milestones.includes(item.id) && item.reached(next, together));
  next.milestones = [...next.milestones, ...fresh.map((item) => item.id)];
  return { memory: next, returned, milestones: fresh.map(({ id, label }) => ({ id, label })) };
}

/** Anos de aniversário se hoje é o dia em que se conheceram (e ainda não foi comemorado); senão 0. */
export function anniversaryDue(memory: PetMemory, now: number): number {
  const first = new Date(memory.firstMetAt);
  const today = new Date(now);
  const years = today.getFullYear() - first.getFullYear();
  const sameDay = first.getMonth() === today.getMonth() && first.getDate() === today.getDate();
  return years >= 1 && sameDay && memory.anniversaryYear !== today.getFullYear() ? years : 0;
}

/**
 * Evento aleatório do dia (no máximo um por dia): um presente durante o dia ou um comentário de madrugada.
 * `active` = o usuário mexeu com o mascote há pouco; `rand` é injetável para teste.
 */
export function dailyEventDue(memory: PetMemory, now: number, active: boolean, rand: () => number): DailyEvent | null {
  if (memory.eventDay === dayKey(now)) return null;
  const hour = new Date(now).getHours();
  if (hour >= 9 && hour < 21) return rand() < 0.25 ? "presente" : null;
  if (hour < 5 && active) return rand() < 0.5 ? "madrugada" : null;
  return null;
}

/** Resumo da memória para o Codex: o mascote cita isso nas conversas. */
export function memorySummary(memory: PetMemory, now: number): string {
  const together = daysTogether(memory, now);
  const away = absenceOf(memory.lastSeenAt, now);
  const awayText = away === "nenhuma" ? "" : ` O usuário ficou sem aparecer por cerca de ${Math.max(1, Math.floor((now - memory.lastSeenAt) / 86_400_000))} dia(s).`;
  return `Vocês se conhecem há ${together} dia(s); sequência atual de ${memory.streak} dia(s) seguidos; ${memory.tasksDone} tarefa(s) concluída(s) e ${memory.chats} conversa(s).${awayText}`;
}
