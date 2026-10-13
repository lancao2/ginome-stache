import { computed, ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface AgendaEvent {
  uid: string;
  title: string;
  start: number;
  end: number;
  allDay: boolean;
  location: string;
  description: string;
  link: string | null;
  calendar: string;
  source: number;
  color: string;
}
export interface AgendaConflict { text: string; at: number }
export interface CalendarSource { id: number; name: string; hint: string; color: string }
/** Cores oferecidas para as agendas (a primeira livre é usada nas novas). */
export const CALENDAR_COLORS = ["#5ab0ff", "#30d158", "#ff9f0a", "#bf5af2", "#ff453a", "#64d2ff", "#ffd60a", "#ff6482"];
interface Agenda { events: AgendaEvent[]; conflicts: AgendaConflict[]; errors: string[] }

const events = ref<AgendaEvent[]>([]);
const conflicts = ref<AgendaConflict[]>([]);
const errors = ref<string[]>([]);
const sources = ref<CalendarSource[]>([]);
const loaded = ref(false);
/** Compromissos do mês exibido, por dia (AAAA-MM-DD), inclusive os de dia inteiro. */
const byDay = ref(new Map<string, AgendaEvent[]>());
const dayKey = (millis: number) => {
  const date = new Date(millis);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
};

// Carrega o intervalo visível do calendário (primeiro ao último dia da grade).
async function loadRange(from: Date, to: Date) {
  try {
    const found = await invoke<AgendaEvent[]>("calendar_range", { from: from.getTime(), to: to.getTime() });
    const map = new Map<string, AgendaEvent[]>();
    for (const event of found) {
      // Um evento de dia inteiro termina à meia-noite do dia seguinte: o último dia não conta.
      const last = event.allDay ? event.end - 1 : event.end;
      for (let at = event.start; at <= Math.max(last, event.start); at += 86_400_000) {
        const key = dayKey(at);
        map.set(key, [...(map.get(key) ?? []), event]);
      }
    }
    byDay.value = map;
  } catch { /* Browser preview. */ }
}
const failure = ref("");
let timer: number | undefined;
let unlisten: UnlistenFn | undefined;
let users = 0;

const refreshing = ref(false);

async function load(force = false) {
  if (force) refreshing.value = true;
  try {
    const agenda = await invoke<Agenda>("calendar_agenda", { force });
    events.value = agenda.events;
    conflicts.value = agenda.conflicts;
    errors.value = agenda.errors;
    sources.value = await invoke<CalendarSource[]>("calendar_sources");
  } catch { /* Browser preview. */ }
  loaded.value = true;
  refreshing.value = false;
}

/** Baixa as agendas de novo agora (o evento criado há instantes aparece). */
const refreshNow = () => load(true);

async function add(name: string, url: string, color: string | null = null) {
  failure.value = "";
  try {
    await invoke("calendar_add", { name, url, color });
    await load();
    return true;
  } catch (cause) {
    failure.value = String(cause);
    return false;
  }
}

async function setColor(id: number, color: string) {
  // Atualiza na hora; o backend aplica a cor também aos eventos já carregados.
  const source = sources.value.find((item) => item.id === id);
  if (source) source.color = color;
  try { await invoke("calendar_set_color", { id, color }); } catch (cause) { failure.value = String(cause); }
  await load();
}

async function remove(id: number) {
  try { await invoke("calendar_remove", { id }); } catch (cause) { failure.value = String(cause); }
  await load();
}

// Um compromisso de hora marcada que ainda não acabou; os de dia inteiro ficam de fora do "próximo".
const next = computed(() => events.value.find((event) => !event.allDay && event.end >= Date.now() - 60_000) ?? null);

export function useCalendar() {
  function watch() {
    if (users++ === 0) {
      void load();
      timer = window.setInterval(() => void load(), 60_000);
      // O backend baixa as agendas sozinho e avisa quando algo mudou: a tela atualiza na hora.
      void listen("calendar-updated", () => void load()).then((stop) => { if (users === 0) stop(); else unlisten = stop; }).catch(() => undefined);
    }
    return () => { if (--users === 0) { window.clearInterval(timer); unlisten?.(); unlisten = undefined; } };
  }
  return { events, conflicts, errors, sources, loaded, failure, next, byDay, refreshing, refreshNow, loadRange, load, add, setColor, remove, watch };
}
