<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";

import { toISO, useTasks } from "../composables/useTasks";
import type { Task } from "../types/task";
import { useCalendar, type AgendaEvent } from "../composables/useCalendar";

type Filter = "day" | "pending" | "done";

const { tasks, byDate, error, focusRequest, load, create, update, setDone, remove } = useTasks();

const agenda = useCalendar();
const { conflicts: agendaConflicts, sources: agendaSources, byDay: agendaByDay, refreshing: agendaRefreshing } = agenda;
const hourFormat = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit", hour12: false });
function joinMeeting(link: string) { void invoke("search_open_url", { url: link }).catch(() => undefined); }

const now = ref(new Date());
const userName = ref("");
const today = computed(() => toISO(now.value));
let clockTimer: number | undefined;
const clockLabel = computed(() => new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit", hour12: false }).format(now.value));
const dateLabelToday = computed(() => new Intl.DateTimeFormat("pt-BR", { weekday: "long", day: "numeric", month: "long" }).format(now.value));
const greeting = computed(() => {
  const hour = now.value.getHours();
  return hour < 5 ? "Boa madrugada" : hour < 12 ? "Bom dia" : hour < 18 ? "Boa tarde" : "Boa noite";
});
const selected = ref(toISO(new Date()));
const month = ref(new Date().getFullYear() * 12 + new Date().getMonth());
const filter = ref<Filter>("day");
const title = ref("");
const time = ref("");
const priority = ref<0 | 1 | 2>(0);
const detailId = ref<number | null>(null);
const detailEditing = ref(false);
const confirmDelete = ref(false);
const draft = ref({ title: "", notes: "", dueDate: "", dueTime: "", priority: 0 as 0 | 1 | 2 });
const detail = computed(() => tasks.value.find((task) => task.id === detailId.value) ?? null);
const priorityNames = ["Sem prioridade", "Prioridade média", "Prioridade alta"];

const monthDate = computed(() => new Date(Math.floor(month.value / 12), month.value % 12, 1));
const monthLabel = computed(() => new Intl.DateTimeFormat("pt-BR", { month: "long", year: "numeric" }).format(monthDate.value));
const weekdays = ["D", "S", "T", "Q", "Q", "S", "S"];
const adding = ref(false);

// Horário padrão de uma tarefa nova: a próxima meia hora cheia (13:28 → 13:30; 13:30 fica 13:30).
function nextHalfHour(base = new Date()) {
  const seconds = base.getHours() * 3600 + base.getMinutes() * 60 + base.getSeconds() + base.getMilliseconds() / 1000;
  const next = Math.ceil(seconds / 1800) * 1800;
  // Passando da meia-noite o horário cairia no dia seguinte: vale o fim de hoje.
  if (next >= 86_400) return "23:59";
  return `${String(Math.floor(next / 3600)).padStart(2, "0")}:${String((next % 3600) / 60).padStart(2, "0")}`;
}
// Ao abrir o formulário o horário já vem preenchido (pode ser apagado ou editado).
watch(adding, (open) => { if (open) time.value = nextHalfHour(); });

const cells = computed(() => {
  const first = monthDate.value;
  const offset = first.getDay();
  const total = Math.ceil((offset + new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate()) / 7) * 7;
  return Array.from({ length: total }, (_, index) => {
    const date = new Date(first.getFullYear(), first.getMonth(), index - offset + 1);
    const iso = toISO(date);
    const list = byDate.value.get(iso) ?? [];
    return {
      iso,
      day: date.getDate(),
      outside: date.getMonth() !== first.getMonth(),
      has: list.length > 0,
      allDone: list.length > 0 && list.every((task) => task.done),
      // Eventos: uma barra sólida por evento, na cor da agenda. Tarefas: um anel por tarefa (aberto = pendente).
      bars: (agendaByDay.value.get(iso) ?? []).slice(0, 3).map((event) => event.color),
      rings: [...list].sort((a, b) => Number(a.done) - Number(b.done)).slice(0, 3).map((task) => task.done),
    };
  });
});

// Compromissos da agenda no dia selecionado (feriados e outros eventos de dia inteiro vêm primeiro).
// Tela de detalhes de um compromisso.
const eventDetail = ref<AgendaEvent | null>(null);
const longDay = new Intl.DateTimeFormat("pt-BR", { weekday: "long", day: "numeric", month: "long" });
function eventWhen(event: AgendaEvent) {
  const first = longDay.format(event.start);
  if (event.allDay) {
    const last = longDay.format(event.end - 1);
    return last === first ? first : `${first} – ${last}`;
  }
  return `${first}, ${hourFormat.format(event.start)}–${hourFormat.format(event.end)}`;
}
const eventConflicts = computed(() => eventDetail.value ? agendaConflicts.value.filter((item) => item.text.includes(`“${eventDetail.value!.title}”`)) : []);
function meetingHost(link: string) { try { return new URL(link).host; } catch { return link; } }
const dayAgenda = computed(() => [...(agendaByDay.value.get(selected.value) ?? [])].sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start - b.start));
// Recarrega o intervalo da grade quando o mês muda ou as agendas são atualizadas.
// (Observa o mês, e não a grade: a grade já depende do resultado e geraria um laço.)
watch([month, agendaSources, agenda.events], () => {
  const grid = cells.value;
  if (!grid.length || !agendaSources.value.length) { agendaByDay.value = new Map(); return; }
  const first = new Date(`${grid[0].iso}T00:00:00`);
  const last = new Date(`${grid[grid.length - 1].iso}T23:59:59`);
  void agenda.loadRange(first, last);
}, { immediate: true });

const visible = computed(() => {
  if (filter.value === "pending") return tasks.value.filter((task) => !task.done);
  if (filter.value === "done") return tasks.value.filter((task) => task.done);
  return [
    ...(byDate.value.get(selected.value) ?? []),
    ...tasks.value.filter((task) => !task.dueDate && !task.done),
  ];
});

const heading = computed(() => {
  if (filter.value === "pending") return "Pendentes";
  if (filter.value === "done") return "Concluídas";
  const [year, monthIndex, day] = selected.value.split("-").map(Number);
  return new Intl.DateTimeFormat("pt-BR", { weekday: "long", day: "numeric", month: "long" }).format(new Date(year, monthIndex - 1, day));
});

function shiftMonth(step: number) { month.value += step; }
function goToday() {
  const now = new Date();
  month.value = now.getFullYear() * 12 + now.getMonth();
  selected.value = today.value;
  filter.value = "day";
}
function pick(iso: string) {
  selected.value = iso;
  filter.value = "day";
  const [year, monthIndex] = iso.split("-").map(Number);
  month.value = year * 12 + monthIndex - 1;
}

// Enter cria a tarefa de qualquer campo do formulário (o campo de horário não deixa o Enter virar envio).
function submitOnEnter(event: KeyboardEvent) {
  if (event.isComposing) return;
  event.preventDefault();
  void add();
}

async function add() {
  const text = title.value.trim();
  if (!text) return;
  await create({ title: text, dueDate: filter.value === "day" ? selected.value : null, dueTime: time.value || null, priority: priority.value });
  title.value = "";
  time.value = "";
  priority.value = 0;
  adding.value = false;
}

function asInput(task: Task, patch: Partial<Task> = {}) {
  const next = { ...task, ...patch };
  return { title: next.title, notes: next.notes, dueDate: next.dueDate, dueTime: next.dueTime, priority: next.priority };
}
function openDetail(task: Task) {
  detailId.value = task.id;
  detailEditing.value = false;
  confirmDelete.value = false;
}
function closeDetail() {
  detailId.value = null;
  detailEditing.value = false;
  confirmDelete.value = false;
}
function startEdit() {
  const task = detail.value;
  if (!task) return;
  draft.value = { title: task.title, notes: task.notes, dueDate: task.dueDate ?? "", dueTime: task.dueTime ?? "", priority: task.priority };
  detailEditing.value = true;
}
async function saveEdit() {
  const task = detail.value;
  const text = draft.value.title.trim();
  if (!task || !text) return;
  await update(task.id, { title: text, notes: draft.value.notes, dueDate: draft.value.dueDate || null, dueTime: draft.value.dueTime || null, priority: draft.value.priority });
  detailEditing.value = false;
}
async function deleteDetail() {
  const task = detail.value;
  if (!task) return;
  if (!confirmDelete.value) {
    confirmDelete.value = true;
    window.setTimeout(() => { confirmDelete.value = false; }, 3_000);
    return;
  }
  closeDetail();
  await remove(task.id);
}
function longDate(task: Task) {
  if (!task.dueDate) return "Sem data";
  const [year, monthIndex, day] = task.dueDate.split("-").map(Number);
  return new Intl.DateTimeFormat("pt-BR", { weekday: "long", day: "numeric", month: "long" }).format(new Date(year, monthIndex - 1, day));
}
function isOverdue(task: Task) {
  if (task.done || !task.dueDate) return false;
  if (task.dueDate !== today.value) return task.dueDate < today.value;
  return Boolean(task.dueTime) && new Date(`${task.dueDate}T${task.dueTime}`).getTime() < now.value.getTime();
}
// Só tarefas com prioridade ganham o destaque de atraso.
const urgentLate = (task: Task) => task.priority > 0 && isOverdue(task);

function dateLabel(task: Task) {
  if (!task.dueDate) return "Sem data";
  const [year, monthIndex, day] = task.dueDate.split("-").map(Number);
  return new Intl.DateTimeFormat("pt-BR", { day: "numeric", month: "short" }).format(new Date(year, monthIndex - 1, day)).replace(".", "");
}

let stopAgenda: (() => void) | undefined;
onMounted(async () => {
  clockTimer = window.setInterval(() => { now.value = new Date(); }, 1_000);
  stopAgenda = agenda.watch();
  void load();
  try { userName.value = await invoke<string>("get_user_name"); }
  catch { /* Browser preview. */ }
});
onBeforeUnmount(() => { window.clearInterval(clockTimer); stopAgenda?.(); });

// Clique no aviso de vencimento: abre a tarefa no dia dela.
watch([focusRequest, tasks], () => {
  const task = tasks.value.find((item) => item.id === focusRequest.value);
  if (!task) return;
  focusRequest.value = null;
  if (task.dueDate) pick(task.dueDate);
  openDetail(task);
}, { immediate: true });
</script>

<template>
  <div class="home-panel">
    <section class="tasks" aria-label="Tarefas">
      <header class="home-hello">
        <div class="hello-main">
          <p class="hello-line">{{ greeting }}<template v-if="userName">, <strong>{{ userName }}</strong></template></p>
          <time class="hello-time">{{ clockLabel }}</time>
          <p class="hello-date">{{ dateLabelToday }}</p>
        </div>
        <button type="button" class="add-btn" :class="{ 'add-btn--open': adding }" :aria-label="adding ? 'Cancelar' : 'Nova tarefa'" :aria-expanded="adding" @click="adding = !adding">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
        </button>
      </header>

      <div class="day-head">
        <h2>{{ heading }}</h2>
        <span class="day-count">{{ visible.length }}</span>
      </div>
      <div class="pills" role="tablist">
        <button type="button" role="tab" :aria-selected="filter === 'day'" @click="filter = 'day'">Dia</button>
        <button type="button" role="tab" :aria-selected="filter === 'pending'" @click="filter = 'pending'">Pendentes</button>
        <button type="button" role="tab" :aria-selected="filter === 'done'" @click="filter = 'done'">Feitas</button>
      </div>

      <form v-if="adding" class="task-add" @submit.prevent="add">
        <input v-model="title" class="field" type="text" maxlength="200" placeholder="Nova tarefa…" aria-label="Título da tarefa" autofocus @keydown.enter="submitOnEnter" />
        <input v-model="time" class="field field--time" type="time" aria-label="Horário" @keydown.enter="submitOnEnter" />
        <button type="button" class="icon-btn" :class="`prio-${priority}`" aria-label="Prioridade" title="Prioridade" @click="priority = ((priority + 1) % 3) as 0 | 1 | 2">⚑</button>
      </form>
      <p v-if="error" class="home-error" role="alert">{{ error }}</p>

      <p v-if="filter === 'day' && agendaConflicts.length" class="agenda-conflict" :title="agendaConflicts.map((item) => item.text).join('\n')">⚠ {{ agendaConflicts[0].text }}</p>
      <ul v-if="filter === 'day' && dayAgenda.length" class="agenda-day" aria-label="Agenda do dia">
        <li v-for="event in dayAgenda" :key="`${event.uid}${event.start}`" :class="{ 'is-allday': event.allDay }" :style="{ '--agenda': event.color }" role="button" tabindex="0" @click="eventDetail = event" @keydown.enter="eventDetail = event">
          <span class="agenda-day-when">{{ event.allDay ? "Dia todo" : hourFormat.format(event.start) }}</span>
          <span class="agenda-day-title">{{ event.title }}</span>
          <button v-if="event.link" type="button" class="agenda-join agenda-join--small" @click.stop="joinMeeting(event.link)">Entrar</button>
        </li>
      </ul>
      <ul v-if="visible.length" class="task-list">
        <li v-for="task in visible" :key="task.id" class="task" :class="{ 'task--done': task.done, 'task--late': urgentLate(task) }" @click="openDetail(task)">
          <button type="button" class="task-check" :aria-label="task.done ? 'Reabrir' : 'Concluir'" :aria-pressed="task.done" @click.stop="setDone(task.id, !task.done)">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5" /></svg>
          </button>
          <span class="task-title">{{ task.title }}</span>
          <svg v-if="task.notes" class="task-note" viewBox="0 0 24 24" aria-label="Tem descrição"><path d="M5 7h14M5 12h14M5 17h9" /></svg>
          <button type="button" class="icon-btn task-prio" :class="`prio-${task.priority}`" aria-label="Alterar prioridade" @click.stop="update(task.id, asInput(task, { priority: ((task.priority + 1) % 3) as 0 | 1 | 2 }))">⚑</button>
          <button type="button" class="icon-btn task-remove" aria-label="Excluir tarefa" @click.stop="remove(task.id)">×</button>
          <span v-if="task.dueTime" class="task-meta">{{ task.dueTime }}</span>
          <span v-else-if="filter !== 'day' || !task.dueDate" class="task-meta" :class="{ 'task-meta--late': !task.done && task.dueDate && task.dueDate < today }">{{ dateLabel(task) }}</span>
        </li>
      </ul>
      <p v-else class="empty">{{ filter === "done" ? "Nada concluído ainda." : filter === "pending" ? "Nenhuma pendência." : "Nada para este dia." }}</p>
    </section>

    <section class="calendar" aria-label="Calendário">
      <div class="home-head">
        <h2>{{ monthLabel }}</h2>
        <div class="home-actions">
          <button v-if="agendaSources.length" type="button" class="icon-btn agenda-refresh" :class="{ 'is-spinning': agendaRefreshing }" aria-label="Atualizar agendas" title="Atualizar agendas" :disabled="agendaRefreshing" @click="agenda.refreshNow()">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.500-5.800M20 4v5h-5" /></svg>
          </button>
          <button type="button" class="chip-btn" @click="goToday">Hoje</button>
          <button type="button" class="icon-btn" aria-label="Mês anterior" @click="shiftMonth(-1)">‹</button>
          <button type="button" class="icon-btn" aria-label="Próximo mês" @click="shiftMonth(1)">›</button>
        </div>
      </div>
      <div class="calendar-grid" role="grid">
        <span v-for="(name, index) in weekdays" :key="index" class="calendar-weekday">{{ name }}</span>
        <button
          v-for="cell in cells"
          :key="cell.iso"
          type="button"
          class="calendar-day"
          :class="{
            'calendar-day--outside': cell.outside,
            'calendar-day--today': cell.iso === today,
            'calendar-day--selected': cell.iso === selected && filter === 'day',
            'calendar-day--has': cell.has,
            'calendar-day--all-done': cell.allDone,
          }"
          :aria-label="cell.iso"
          :aria-pressed="cell.iso === selected"
          @click="pick(cell.iso)"
        >{{ cell.day }}<span v-if="cell.bars.length" class="calendar-bars" aria-hidden="true"><i v-for="(color, index) in cell.bars" :key="index" :style="{ background: color }" /></span><span v-if="cell.rings.length" class="calendar-rings" aria-hidden="true"><i v-for="(done, index) in cell.rings" :key="index" :class="{ 'is-done': done }" /></span></button>
      </div>
    </section>

    <Transition name="detail-slide">
      <aside v-if="eventDetail" class="detail" aria-label="Detalhes do compromisso">
        <header class="detail-bar">
          <button type="button" class="icon-btn" aria-label="Voltar" @click="eventDetail = null">‹</button>
          <span class="detail-bar-title">Compromisso</span>
        </header>
        <div class="detail-body">
          <h3 class="detail-title">{{ eventDetail.title }}</h3>
          <div class="detail-meta">
            <span class="meta-chip">{{ eventWhen(eventDetail) }}</span>
            <span class="meta-chip event-source" :style="{ '--agenda': eventDetail.color }">{{ eventDetail.calendar }}</span>
            <span v-if="eventDetail.location && !eventDetail.link" class="meta-chip">📍 {{ eventDetail.location }}</span>
          </div>
          <p v-for="item in eventConflicts" :key="item.text" class="agenda-conflict agenda-conflict--wrap">⚠ {{ item.text }}</p>
          <p class="detail-notes" :class="{ 'is-empty': !eventDetail.description }">{{ eventDetail.description || "Sem descrição." }}</p>
          <button v-if="eventDetail.link" type="button" class="save-btn detail-done event-join" @click="joinMeeting(eventDetail.link)">Entrar na reunião · {{ meetingHost(eventDetail.link) }}</button>
        </div>
      </aside>
    </Transition>

    <Transition name="detail-slide">
      <aside v-if="detail" class="detail" aria-label="Detalhes da tarefa">
        <header class="detail-bar">
          <button type="button" class="icon-btn" aria-label="Voltar" @click="closeDetail">‹</button>
          <span class="detail-bar-title">{{ detailEditing ? "Editar tarefa" : "Tarefa" }}</span>
          <button v-if="!detailEditing" type="button" class="icon-btn" aria-label="Editar tarefa" title="Editar" @click="startEdit">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16zm9.5-13.5 4 4" /></svg>
          </button>
          <button type="button" class="icon-btn icon-btn--danger" :class="{ 'is-armed': confirmDelete }" :aria-label="confirmDelete ? 'Confirmar exclusão' : 'Apagar tarefa'" :title="confirmDelete ? 'Clique de novo para apagar' : 'Apagar'" @click="deleteDetail">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6m4-6v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" /></svg>
          </button>
        </header>

        <form v-if="detailEditing" class="detail-body detail-form" @submit.prevent="saveEdit">
          <input v-model="draft.title" class="field" type="text" maxlength="200" placeholder="Título" aria-label="Título" autofocus />
          <textarea v-model="draft.notes" class="field field--area" placeholder="Descrição da tarefa…" aria-label="Descrição" />
          <div class="detail-row">
            <input v-model="draft.dueDate" class="field" type="date" aria-label="Data" />
            <input v-model="draft.dueTime" class="field field--time" type="time" aria-label="Horário" />
            <button type="button" class="chip-btn" :class="`prio-${draft.priority}`" @click="draft.priority = ((draft.priority + 1) % 3) as 0 | 1 | 2">⚑ {{ priorityNames[draft.priority] }}</button>
          </div>
          <div class="detail-actions">
            <button type="button" class="chip-btn" @click="detailEditing = false">Cancelar</button>
            <button type="submit" class="save-btn" :disabled="!draft.title.trim()">Salvar</button>
          </div>
        </form>

        <div v-else class="detail-body">
          <h3 class="detail-title" :class="{ 'is-done': detail.done, 'is-late': urgentLate(detail) }">{{ detail.title }}</h3>
          <div class="detail-meta">
            <span class="meta-chip">{{ longDate(detail) }}</span>
            <span v-if="detail.dueTime" class="meta-chip">{{ detail.dueTime }}</span>
            <span class="meta-chip" :class="`prio-${detail.priority}`">⚑ {{ priorityNames[detail.priority] }}</span>
          </div>
          <p class="detail-notes" :class="{ 'is-empty': !detail.notes }">{{ detail.notes || "Sem descrição. Use o lápis para adicionar detalhes." }}</p>
          <button type="button" class="save-btn detail-done" @click="setDone(detail.id, !detail.done)">{{ detail.done ? "Reabrir tarefa" : "Concluir tarefa" }}</button>
        </div>
      </aside>
    </Transition>
  </div>
</template>
