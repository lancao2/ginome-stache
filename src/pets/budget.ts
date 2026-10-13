// Orçamento de tokens dos mascotes: esforço de raciocínio, tamanho do contexto e vida das conversas.
// Funções puras, sem Vue nem Tauri.
import type { PetId } from "./data.ts";

/** Tick e Papo só organizam texto: raciocínio baixo basta. O Work herda o padrão do Codex (código pede mais). */
const EFFORT: Record<PetId, string | undefined> = { tick: "low", papo: "low", work: undefined };
const CHAT_EFFORT = "low";

/** Parâmetro de esforço para `turn/start`; vazio quando o padrão do Codex deve valer. */
export function effortFor(pet: PetId | undefined, chat = false): { effort?: string } {
  const effort = chat ? CHAT_EFFORT : pet ? EFFORT[pet] : undefined;
  return effort ? { effort } : {};
}

/** Depois disso a thread é trocada por uma nova: o histórico reenviado a cada turno só cresce. */
export const MAX_THREAD_TURNS = 12;

export const CONTEXT = {
  tasks: 15,
  taskNotes: 100,
  notifications: 8,
  notificationBody: 140,
  clipboard: 1200,
  recentMessages: 4,
  recentLength: 500,
} as const;

export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** A thread já tem o histórico: o contexto compartilhado só vai ao trocar de mascote ou numa thread nova. */
export function needsShared(switchedPet: boolean, freshThread: boolean): boolean {
  return switchedPet || freshThread;
}

/** O contexto do app (tarefas, notificações…) só vai de novo se mudou desde o último envio nesta thread. */
export function contextToSend(current: string, lastSent: string | undefined): string {
  return current && current !== lastSent ? current : "";
}
