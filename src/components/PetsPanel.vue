<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";

import {
  CARE_LABEL, NEEDS, NEED_LABEL, PET_IDS, PROFILES, STATE_LABEL, pickLine, type CareAction, type PetId,
} from "../pets/data";
import { average } from "../pets/engine";
import { usePets } from "../composables/usePets";
import { usePetAbsence } from "../composables/usePetAbsence";
import { returnLabel } from "../pets/absence";
import { usePetChat } from "../composables/usePetChat";
import { usePetTasks } from "../composables/usePetTasks";
import { usePetsIntro } from "../composables/usePetsIntro";
import { useAgentHub } from "../composables/useAgentHub";
import PetSprite from "./PetSprite.vue";

const emit = defineEmits<{ navigate: [tab: "codex"] }>();

const store = usePets();
const { away, isAway, excuse } = usePetAbsence();
const chat = usePetChat();
const tasks = usePetTasks();
const intro = usePetsIntro();
const agentHub = useAgentHub();
const { pets, states, speech } = store;

const selected = ref<PetId>("tick");
const view = ref<"cuidar" | "sobre" | "conversar" | "tarefa">("cuidar");
const job = ref("");
const refusal = ref("");
const run = computed(() => tasks.runs[selected.value]);
const running = computed(() => run.value.status === "running");
const ctx = computed(() => tasks.context(selected.value));
const folderName = computed(() => tasks.cwd.value.split("/").filter(Boolean).pop() || "Escolher pasta");

async function startTask() {
  if (!job.value.trim() || running.value) return;
  refusal.value = "";
  const result = await tasks.run(selected.value, job.value);
  if (!result.ok) refusal.value = result.line;
}
const draft = ref("");
const scroller = ref<HTMLElement | null>(null);
const messages = computed(() => chat.chats[selected.value]);
const talking = computed(() => chat.sending.value !== null);

watch([messages, view, selected], async () => {
  await nextTick();
  scroller.value?.scrollTo({ top: scroller.value.scrollHeight });
}, { deep: true });

function submit() {
  if (!draft.value.trim() || talking.value) return;
  void chat.send(selected.value, draft.value);
  draft.value = "";
}

function choose(id: PetId) {
  selected.value = id;
  view.value = "cuidar";
  refusal.value = "";
  store.say(id);
}

function act(action: CareAction | "tarefa") {
  if (action === "conversar") {
    agentHub.openConversation(selected.value);
    emit("navigate", "codex");
    return;
  }
  if (action === "tarefa") { view.value = "tarefa"; refusal.value = ""; return; }
  store.care(selected.value, action);
}
const profile = computed(() => PROFILES[selected.value]);
const state = computed(() => states.value[selected.value]);
const data = computed(() => pets[selected.value]);
const line = computed(() => (isAway.value ? excuse(selected.value) : speech.value[selected.value] ?? pickLine(selected.value, state.value)));
const awayNote = computed(() => (away.value ? `O escritório está vazio: sem tokens, todos saíram. Voltam ${returnLabel(away.value.until, now.value)}.` : ""));
const blocked = computed(() => !store.canWork(selected.value));

// Relógio local para os recortes de espera dos botões.
const now = ref(Date.now());
let timer: number | undefined;
const OFFICE_ACTIVITIES = ["trabalhando", "café", "papeando", "janela"] as const;
type OfficeActivity = (typeof OFFICE_ACTIVITIES)[number];
const officeActivities = ref<Record<PetId, OfficeActivity>>({ tick: "janela", papo: "café", work: "trabalhando" });
const officeWalking = ref<Record<PetId, boolean>>({ tick: false, papo: false, work: false });
const officeTimers: number[] = [];

function sceneActivity(id: PetId): OfficeActivity {
  const live = states.value[id];
  if (live === "comendo") return "café";
  if (live === "trabalhando" || live === "pensando") return "trabalhando";
  if (live === "falando") return "papeando";
  return officeActivities.value[id];
}

function scheduleOfficeMove(id: PetId) {
  const delay = 4500 + Math.random() * 6500;
  officeTimers.push(window.setTimeout(() => {
    const current = officeActivities.value[id];
    const choices = OFFICE_ACTIVITIES.filter((activity) => activity !== current);
    officeActivities.value = { ...officeActivities.value, [id]: choices[Math.floor(Math.random() * choices.length)] };
    officeWalking.value = { ...officeWalking.value, [id]: true };
    officeTimers.push(window.setTimeout(() => {
      officeWalking.value = { ...officeWalking.value, [id]: false };
    }, 1700));
    scheduleOfficeMove(id);
  }, delay));
}

const ACTIVITY_LABEL: Record<OfficeActivity, string> = {
  trabalhando: "Trabalhando",
  café: "Pegando café",
  papeando: "Papeando",
  janela: "Olhando a vista",
};

onMounted(() => {
  tasks.panelOpen.value = true;
  timer = window.setInterval(() => { now.value = Date.now(); }, 1000);
  PET_IDS.forEach(scheduleOfficeMove);
});
onBeforeUnmount(() => {
  tasks.panelOpen.value = false;
  window.clearInterval(timer);
  officeTimers.forEach((id) => window.clearTimeout(id));
});

const ACTIONS: { id: CareAction | "tarefa"; icon: string }[] = [
  { id: "comer", icon: "M4 11h16M6 11a6 6 0 0 0 12 0M9 7c0-1.500 1.500-1.500 1.500-3M14 7c0-1.500 1.500-1.500 1.500-3" },
  { id: "brincar", icon: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M3.500 9.500c4 1 12 1 17 0M3.500 14.500c4-1 12-1 17 0M12 3v18" },
  { id: "banho", icon: "M12 3c3 4 5.500 6.500 5.500 10a5.500 5.500 0 0 1-11 0C6.500 9.500 9 7 12 3M9.500 14.500a2.500 2.500 0 0 0 2 2" },
  { id: "tarefa", icon: "M9 6h11M9 12h11M9 18h11M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2" },
  { id: "conversar", icon: "M4 5.500A1.500 1.500 0 0 1 5.500 4h13A1.500 1.500 0 0 1 20 5.500v9a1.500 1.500 0 0 1-1.500 1.500H11l-4.500 4V16h-1A1.500 1.500 0 0 1 4 14.500z" },
];

function wait(action: CareAction | "tarefa") {
  if (action === "tarefa") return 0;
  const ms = store.cooldownLeft(selected.value, action, now.value);
  return ms > 0 ? Math.ceil(ms / 60_000) : 0;
}

function actionTitle(action: CareAction | "tarefa") {
  if (action === "tarefa") return `Tarefa com IA (${profile.value.papel})`;
  const extra = action === "comer" ? profile.value.comida.nome : action === "brincar" ? profile.value.brincadeira.nome : "";
  const minutes = wait(action);
  return [CARE_LABEL[action], extra && `(${extra})`, minutes ? `· volta em ${minutes} min` : ""].filter(Boolean).join(" ");
}

const level = (value: number) => (value < 25 ? "low" : value < 55 ? "mid" : "high");
const stats = computed(() => store.memoryStats(selected.value));
const mood = computed(() => Math.round(average(data.value.needs)));
const DETAIL_THEME: Record<PetId, { primary: string; secondary: string; glow: string }> = {
  tick: { primary: "105, 200, 244", secondary: "242, 154, 199", glow: "143, 159, 241" },
  papo: { primary: "255, 217, 95", secondary: "239, 159, 201", glow: "246, 173, 114" },
  work: { primary: "203, 211, 223", secondary: "182, 166, 231", glow: "157, 174, 198" },
};
const detailTheme = computed(() => ({
  "--pet-primary": DETAIL_THEME[selected.value].primary,
  "--pet-secondary": DETAIL_THEME[selected.value].secondary,
  "--pet-glow": DETAIL_THEME[selected.value].glow,
}));
</script>

<template>
  <div class="pets-panel">
    <section class="pets-office" aria-label="Escritório dos mascotes">
      <div class="office-window" aria-hidden="true">
        <i class="office-sky" /><i class="office-city office-city--back" /><i class="office-city office-city--front" />
        <span class="office-window__bar office-window__bar--v" /><span class="office-window__bar office-window__bar--h" />
      </div>
      <div class="office-desk office-desk--left" aria-hidden="true"><i class="office-monitor" /><i class="office-keyboard" /></div>
      <div class="office-desk office-desk--right" aria-hidden="true"><i class="office-monitor" /><i class="office-keyboard" /></div>
      <div class="office-coffee" aria-hidden="true"><i /><span>CAFÉ</span></div>
      <div class="office-sofa" aria-hidden="true"><i /><i /></div>
      <div class="office-rug" aria-hidden="true" />

      <button
        v-for="id in PET_IDS"
        :key="id"
        type="button"
        class="office-pet"
        :class="[`office-pet--${id}`, `at-${sceneActivity(id)}`, { 'is-selected': selected === id, 'is-walking': officeWalking[id] }]"
        :aria-label="`${PROFILES[id].nome}: ${ACTIVITY_LABEL[sceneActivity(id)]}`"
        v-show="!isAway"
        @click="choose(id)"
      >
        <PetSprite :pet="id" :state="states[id]" :size="58" compact />
        <span class="office-pet__activity">{{ ACTIVITY_LABEL[sceneActivity(id)] }}</span>
      </button>

      <p v-if="isAway" class="office-away" role="status">{{ awayNote }}</p>

      <nav class="pets-household" aria-label="Selecionar mascote">
        <button v-for="id in PET_IDS" :key="id" type="button" :class="{ 'is-selected': selected === id }" @click="choose(id)">
          <PetSprite :pet="id" :state="states[id]" :size="36" compact />
          <span><strong>{{ PROFILES[id].nome }}</strong><small>{{ isAway ? "Ausente" : STATE_LABEL[states[id]] }}</small></span>
        </button>
      </nav>
    </section>

    <section class="pets-detail" :class="`pets-detail--${selected}`" :style="detailTheme">
      <div class="pets-bubble" role="status">{{ line }}</div>

      <div v-if="view === 'conversar'" class="pets-info pets-chat">
        <header class="pets-head">
          <div>
            <strong>Conversa com {{ profile.nome }}</strong>
            <span>Codex · só conversa, sem executar nada</span>
          </div>
          <span class="pets-chat__tools">
            <button type="button" class="pets-chat__link" :disabled="talking || !messages.length" @click="chat.clear(selected)">Limpar</button>
            <button type="button" class="pets-chat__link" @click="view = 'cuidar'">Voltar</button>
          </span>
        </header>
        <div ref="scroller" class="pets-chat__list">
          <p v-if="!messages.length" class="pets-note">Diga oi para {{ profile.nome }}. Ele responde de acordo com o humor que está agora.</p>
          <div v-for="message in messages" :key="message.id" class="pets-msg" :class="`pets-msg--${message.role}`">
            <template v-if="message.text">{{ message.text }}</template>
            <span v-else class="pets-msg__dots"><i /><i /><i /></span>
          </div>
        </div>
        <form class="pets-chat__form" @submit.prevent="submit">
          <input v-model="draft" type="text" :placeholder="`Falar com ${profile.nome}…`" :disabled="talking" maxlength="400" autocomplete="off" />
          <button type="submit" :disabled="talking || !draft.trim()">Enviar</button>
        </form>
      </div>

      <div v-else-if="view === 'tarefa'" class="pets-info pets-chat pets-task">
        <header class="pets-head">
          <div>
            <strong>Tarefa de {{ profile.nome }}</strong>
            <span>Codex · {{ profile.papel }}</span>
          </div>
          <button type="button" class="pets-chat__link" @click="view = 'cuidar'">Voltar</button>
        </header>

        <p v-if="blocked" class="pets-warning">{{ refusal || `${profile.nome} está sem ânimo e não executa tarefas com IA. Cuide dele primeiro.` }}</p>
        <p v-else-if="refusal" class="pets-warning">{{ refusal }}</p>

        <div class="pets-chips">
          <button v-for="preset in tasks.presets[selected]" :key="preset.label" type="button" :disabled="running" @click="job = preset.prompt">{{ preset.label }}</button>
        </div>
        <form class="pets-chat__form" @submit.prevent="startTask">
          <input v-model="job" type="text" :placeholder="`Peça algo ao ${profile.nome}…`" :disabled="running" maxlength="600" autocomplete="off" />
          <button v-if="!running" type="submit" :disabled="!job.trim()">Executar</button>
          <button v-else type="button" class="pets-stop" @click="tasks.stop(selected)">Parar</button>
        </form>
        <div class="pets-ctx">
          <span>Envia ao Codex: {{ ctx.label }}</span>
          <button v-if="tasks.needsFolder(selected)" type="button" class="pets-chat__link" :disabled="running" @click="tasks.chooseFolder()">{{ folderName }}</button>
        </div>

        <div ref="scroller" class="pets-chat__list">
          <p v-if="run.status === 'idle'" class="pets-note">{{ blocked ? "Tarefas ficam bloqueadas enquanto ele estiver triste." : "O resultado aparece aqui. Mudanças de arquivo e comandos pedem a sua aprovação." }}</p>
          <template v-for="item in run.entries" :key="item.id">
            <div v-if="item.kind === 'agent'" class="pets-msg pets-msg--pet">{{ item.text }}<span v-if="item.streaming" class="pets-msg__dots"><i /><i /><i /></span></div>
            <div v-else-if="item.kind === 'command'" class="pets-cmd" :data-status="item.status">
              <code>$ {{ item.command }}</code>
              <small>{{ item.status }}<template v-if="item.exitCode !== null"> · código {{ item.exitCode }}</template></small>
            </div>
            <div v-else-if="item.kind === 'files'" class="pets-cmd">
              <code v-for="file in item.files" :key="file.path">{{ file.change }} {{ file.path }}</code>
              <small>{{ item.status }}</small>
            </div>
            <div v-else-if="item.kind === 'approval'" class="pets-approval">
              <strong>{{ item.title }}</strong>
              <pre>{{ item.detail }}</pre>
              <div v-if="item.decision === null" class="pets-approval__buttons">
                <button type="button" @click="tasks.answer(item, 'accept')">Aprovar</button>
                <button type="button" class="is-no" @click="tasks.answer(item, 'decline')">Recusar</button>
              </div>
              <small v-else>{{ item.decision === "accept" ? "Aprovado" : "Recusado" }}</small>
            </div>
            <div v-else class="pets-msg pets-msg--error">{{ item.text }}</div>
          </template>
          <p v-if="run.status === 'done'" class="pets-note">Concluída. {{ profile.nome }} ganhou Propósito.</p>
          <p v-else-if="run.status === 'failed'" class="pets-note">Não deu certo. Isso cansa um pouco o {{ profile.nome }}.</p>
          <p v-else-if="run.status === 'stopped'" class="pets-note">Interrompida.</p>
        </div>
      </div>

      <div v-else-if="view === 'sobre'" class="pets-info pets-about">
        <header class="pets-head">
          <div><strong>Sobre {{ profile.nome }}</strong><span>{{ profile.especie }} · {{ profile.papel }}</span></div>
          <button type="button" class="pets-close-info" aria-label="Voltar às necessidades" @click="view = 'cuidar'">×</button>
        </header>
        <div class="pets-about__portrait"><PetSprite :pet="selected" state="feliz" :size="76" compact /></div>
        <p>{{ profile.resumo }}</p>
        <dl>
          <div><dt>Gosta de ouvir</dt><dd>{{ profile.gosta.slice(0, 5).join(' · ') }}</dd></div>
          <div><dt>Comida favorita</dt><dd>{{ profile.comida.emoji }} {{ profile.comida.nome }}</dd></div>
          <div><dt>Diversão</dt><dd>{{ profile.brincadeira.emoji }} {{ profile.brincadeira.nome }}</dd></div>
        </dl>
        <button type="button" class="pets-replay" @click="intro.start()">Rever apresentação</button>
      </div>

      <div v-else class="pets-info pets-care">
        <header class="pets-head">
          <div>
            <strong>{{ profile.nome }}</strong>
            <span>{{ profile.especie }} · {{ profile.papel }}</span>
          </div>
          <span class="pets-head__tools">
            <button type="button" class="pets-info-button" aria-label="Personalidade e gostos" title="Personalidade e gostos" @click="view = 'sobre'">i</button>
            <span class="pets-mood" :data-level="level(mood)">{{ STATE_LABEL[state] }}</span>
          </span>
        </header>

        <ul class="pets-needs">
          <li v-for="need in NEEDS" :key="need" :class="{ 'is-irritant': need === profile.irritante }">
            <span>{{ NEED_LABEL[need] }}</span>
            <i><b :data-level="level(data.needs[need])" :style="{ width: `${Math.round(data.needs[need])}%` }" /></i>
          </li>
        </ul>

        <p class="pets-memory" title="O que o mascote lembra de vocês">{{ stats.together ? `Juntos há ${stats.together} dia(s)` : "Acabaram de se conhecer" }} · sequência de {{ stats.streak }} · {{ stats.tasks }} tarefa(s) · {{ stats.chats }} conversa(s)</p>
        <p v-if="blocked" class="pets-warning">{{ profile.nome }} está sem ânimo e não executa tarefas com IA. Cuide dele primeiro.</p>
        <p v-else class="pets-note">Clique no <b>i</b> para conhecer personalidade e gostos.</p>
        <div class="pets-actions">
          <button
            v-for="action in ACTIONS"
            :key="action.id"
            type="button"
            class="pets-action"
            :disabled="action.id !== 'conversar' && action.id !== 'tarefa' && wait(action.id) > 0"
            :title="actionTitle(action.id)"
            @click="act(action.id)"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true"><path :d="action.icon" /></svg>
            <span>{{ action.id === 'tarefa' ? 'Tarefa' : CARE_LABEL[action.id] }}</span>
            <small v-if="action.id !== 'conversar' && action.id !== 'tarefa' && wait(action.id)">{{ wait(action.id) }} min</small>
          </button>
        </div>
      </div>
    </section>
  </div>
</template>

<style>
.pets-panel { flex: 1; min-height: 0; display: grid; grid-template-columns: 340px minmax(0, 1fr); gap: 8px; padding-top: 2px; }
.pets-office { position: relative; min-width: 0; overflow: hidden; border-radius: 18px; background: linear-gradient(180deg, #182033 0 58%, #252538 58% 100%); box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.08); }
.pets-office::after { content: ""; position: absolute; left: 0; right: 0; top: 58%; height: 1px; background: rgba(255, 255, 255, 0.1); box-shadow: 0 8px 18px rgba(0, 0, 0, 0.22); }
.office-window { position: absolute; top: 12px; left: 118px; width: 106px; height: 68px; overflow: hidden; border: 4px solid #363c52; border-radius: 8px; background: linear-gradient(#263c63, #8a729b); box-shadow: 0 0 22px rgba(91, 145, 232, 0.13); }
.office-sky { position: absolute; inset: 0; background: radial-gradient(circle at 70% 24%, rgba(255, 219, 177, 0.75) 0 4px, transparent 5px), linear-gradient(#263c63, #b27f9f); }
.office-city { position: absolute; left: 0; right: 0; bottom: 0; height: 28px; background: repeating-linear-gradient(90deg, #25314c 0 13px, transparent 13px 17px); clip-path: polygon(0 32%, 12% 32%, 12% 0, 24% 0, 24% 45%, 40% 45%, 40% 18%, 57% 18%, 57% 54%, 72% 54%, 72% 8%, 86% 8%, 86% 38%, 100% 38%, 100% 100%, 0 100%); }
.office-city--back { opacity: 0.42; transform: translateY(-8px) scaleX(1.08); }
.office-city--front { background-color: #151d31; }
.office-window__bar { position: absolute; z-index: 2; background: #363c52; }
.office-window__bar--v { top: 0; bottom: 0; left: 50%; width: 3px; }
.office-window__bar--h { left: 0; right: 0; top: 50%; height: 3px; }
.office-desk { position: absolute; top: 94px; width: 92px; height: 43px; border-radius: 5px 5px 2px 2px; background: #655340; box-shadow: inset 0 3px #8d7358, 0 16px 0 -13px #3b3340; }
.office-desk::before, .office-desk::after { content: ""; position: absolute; top: 37px; width: 5px; height: 36px; background: #3c3440; }
.office-desk::before { left: 8px; }.office-desk::after { right: 8px; }
.office-desk--left { left: 12px; }.office-desk--right { right: 12px; }
.office-monitor { position: absolute; left: 31px; top: -25px; width: 40px; height: 27px; border: 4px solid #323848; border-radius: 4px; background: linear-gradient(135deg, #37628b, #182437); }
.office-monitor::after { content: ""; position: absolute; left: 15px; bottom: -10px; width: 4px; height: 8px; background: #41485a; }
.office-keyboard { position: absolute; left: 28px; top: 8px; width: 46px; height: 6px; border-radius: 2px; background: #343442; transform: skewX(-18deg); }
.office-coffee { position: absolute; top: 18px; right: 16px; width: 50px; height: 55px; border-radius: 8px; background: #34394a; box-shadow: inset 0 0 0 1px rgba(255,255,255,.08); }
.office-coffee i { position: absolute; left: 11px; bottom: 8px; width: 25px; height: 19px; border-radius: 3px 3px 7px 7px; background: #d9d6cd; box-shadow: inset 0 -5px #a99582; }
.office-coffee span { position: absolute; top: 6px; left: 0; right: 0; font-size: 6px; letter-spacing: .12em; text-align: center; color: rgba(255,255,255,.45); }
.office-sofa { position: absolute; left: 117px; bottom: 58px; width: 107px; height: 43px; border-radius: 14px 14px 6px 6px; background: #3f5264; box-shadow: inset 0 -10px rgba(0,0,0,.12); }
.office-sofa i { position: absolute; top: 8px; width: 43px; height: 25px; border-radius: 9px; background: #526a7c; }.office-sofa i:first-child { left: 7px; }.office-sofa i:last-child { right: 7px; }
.office-rug { position: absolute; left: 91px; bottom: 45px; width: 157px; height: 38px; border-radius: 50%; background: radial-gradient(ellipse, rgba(69, 112, 151, .45), rgba(43, 49, 73, .18) 68%, transparent 70%); }
.office-pet { position: absolute; z-index: 4; width: 68px; height: 82px; display: grid; place-items: center; transition: left 1.6s cubic-bezier(.22,1,.36,1), top 1.6s cubic-bezier(.22,1,.36,1), transform 180ms; }
.office-pet:hover { transform: translateY(-2px) scale(1.04); }
.office-pet.is-selected .pet { filter: drop-shadow(0 0 7px rgba(116, 208, 255, .42)); }
.office-pet.is-walking .pet { animation: office-walk 420ms ease-in-out infinite; }
.office-pet.at-trabalhando { left: 25px; top: 105px; }.office-pet--papo.at-trabalhando, .office-pet--work.at-trabalhando { left: 247px; }
.office-pet.at-café { left: 266px; top: 52px; }.office-pet--papo.at-café { left: 252px; }.office-pet--work.at-café { left: 238px; }
.office-pet.at-papeando { left: 137px; top: 143px; }.office-pet--papo.at-papeando { left: 171px; }.office-pet--work.at-papeando { left: 105px; }
.office-pet.at-janela { left: 137px; top: 61px; }.office-pet--papo.at-janela { left: 169px; }.office-pet--work.at-janela { left: 106px; }
.office-pet__activity { position: absolute; top: 67px; left: 50%; padding: 2px 6px; border-radius: 8px; color: rgba(255,255,255,.72); background: rgba(9,11,18,.74); font-size: 7px; white-space: nowrap; opacity: 0; transform: translateX(-50%) translateY(2px); transition: opacity 160ms, transform 160ms; }
.office-pet:hover .office-pet__activity, .office-pet.is-selected .office-pet__activity { opacity: 1; transform: translateX(-50%); }
.office-away { position: absolute; z-index: 7; left: 18px; right: 18px; top: 46%; margin: 0; padding: 9px 12px; border-radius: 12px; text-align: center; font-size: 12px; line-height: 1.35; color: rgba(255,255,255,.82); background: rgba(10, 12, 20, 0.72); box-shadow: inset 0 0 0 1px rgba(255,255,255,.1); }
.pets-household { position: absolute; z-index: 8; left: 8px; right: 8px; bottom: 6px; height: 47px; display: grid; grid-template-columns: repeat(3, 1fr); gap: 5px; padding: 4px; border-radius: 14px; background: rgba(10, 12, 20, 0.9); box-shadow: inset 0 0 0 1px rgba(255,255,255,.09), 0 -8px 20px rgba(0,0,0,.2); backdrop-filter: blur(12px); }
.pets-household button { display: flex; align-items: center; gap: 3px; min-width: 0; padding: 1px 4px; border-radius: 10px; text-align: left; }
.pets-household button:hover { background: rgba(255,255,255,.07); }.pets-household button.is-selected { background: linear-gradient(135deg, rgba(48,209,88,.22), rgba(10,132,255,.16)); box-shadow: inset 0 0 0 1px rgba(96,229,143,.4); }
.pets-household button > span { display: flex; flex-direction: column; min-width: 0; }.pets-household strong { font-size: 9px; }.pets-household small { overflow: hidden; font-size: 7.5px; color: rgba(255,255,255,.5); text-overflow: ellipsis; white-space: nowrap; }
.pets-detail { position: relative; min-width: 0; min-height: 0; display: flex; flex-direction: column; gap: 5px; padding: 7px; border-radius: 18px; overflow: hidden; background: radial-gradient(circle at 108% -8%, rgba(var(--pet-secondary), .25), transparent 42%), radial-gradient(circle at -12% 110%, rgba(var(--pet-primary), .17), transparent 48%), linear-gradient(155deg, rgba(35,42,60,.98), rgba(20,23,34,.98)); box-shadow: inset 0 0 0 1px rgba(var(--pet-primary), .2), 0 8px 24px rgba(var(--pet-glow), .07); transition: background 360ms ease, box-shadow 360ms ease; }
.pets-detail::before { content: ""; position: absolute; inset: 0; pointer-events: none; background: linear-gradient(120deg, rgba(255,255,255,.035), transparent 35%, rgba(var(--pet-secondary), .055)); }
.pets-detail > * { position: relative; z-index: 1; }
.pets-bubble { width: 100%; min-height: 27px; max-height: 32px; overflow: hidden; padding: 5px 7px; border-radius: 11px; background: linear-gradient(110deg, rgba(var(--pet-primary), .13), rgba(var(--pet-secondary), .1)); box-shadow: inset 0 0 0 1px rgba(var(--pet-primary), .1); font-size: 9px; line-height: 1.25; text-align: center; color: rgba(255, 255, 255, 0.86); }
@keyframes office-walk { 0%,100% { transform: translateY(0) rotate(-1.5deg); } 50% { transform: translateY(-2px) rotate(1.5deg); } }
.pets-info { min-width: 0; min-height: 0; display: flex; flex-direction: column; gap: 6px; }
.pets-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
.pets-head strong { display: block; font-size: 15px; }
.pets-head > div { min-width: 0; }
.pets-head > div > span { display: block; overflow: hidden; color: rgba(255, 255, 255, 0.55); font-size: 9.5px; text-overflow: ellipsis; white-space: nowrap; }
.pets-head__tools { display: flex; align-items: center; gap: 5px; }
.pets-info-button { width: 21px; height: 21px; border-radius: 50%; color: rgba(255,255,255,.9); background: linear-gradient(135deg, rgba(var(--pet-primary), .34), rgba(var(--pet-secondary), .22)); box-shadow: inset 0 0 0 1px rgba(var(--pet-primary), .48), 0 0 10px rgba(var(--pet-primary), .12); font-family: Georgia, serif; font-size: 13px; font-weight: 700; }
.pets-info-button:hover { background: linear-gradient(135deg, rgba(var(--pet-primary), .5), rgba(var(--pet-secondary), .34)); }
.pets-close-info { width: 22px; height: 22px; border-radius: 50%; color: rgba(255,255,255,.7); background: rgba(255,255,255,.08); font-size: 17px; line-height: 20px; }
.pets-head .pets-mood { padding: 3px 9px; border-radius: 10px; font-size: 10.5px; font-weight: 600; color: #fff; background: rgba(255, 255, 255, 0.12); white-space: nowrap; }
.pets-mood[data-level="low"] { background: rgba(255, 69, 58, 0.55); }
.pets-mood[data-level="high"] { background: linear-gradient(110deg, rgba(var(--pet-primary), .55), rgba(var(--pet-secondary), .42)); box-shadow: inset 0 0 0 1px rgba(255,255,255,.12); }
.pets-needs { margin: 0; padding: 0; list-style: none; display: grid; gap: 2px; }
.pets-needs li { display: grid; grid-template-columns: 55px 1fr; align-items: center; gap: 6px; font-size: 9.5px; color: rgba(255, 255, 255, 0.72); }
.pets-needs li.is-irritant span::after { content: " ●"; color: #ff9f0a; font-size: 7px; vertical-align: middle; }
.pets-needs i { display: block; height: 7px; padding: 1px; border-radius: 5px; background: rgba(255, 255, 255, 0.075); box-shadow: inset 0 1px 2px rgba(0,0,0,.25); overflow: hidden; }
.pets-needs b { display: block; height: 100%; border-radius: 4px; background: linear-gradient(90deg, rgb(var(--pet-primary)), rgb(var(--pet-secondary))); box-shadow: 0 0 7px rgba(var(--pet-primary), .28); transition: width 400ms ease, background 300ms ease; }
.pets-needs b[data-level="mid"] { background: #ffd60a; }
.pets-needs b[data-level="low"] { background: #ff453a; }
.pets-memory { margin: 0; max-height: 25px; overflow: hidden; font-size: 9px; line-height: 1.25; color: rgba(var(--pet-primary), .92); }
.pets-note, .pets-warning { margin: 0; font-size: 10px; line-height: 1.35; color: rgba(255, 255, 255, 0.5); }
.pets-warning { color: #ffb4ac; }
.pets-care, .pets-about { overflow-y: auto; overflow-x: hidden; padding-right: 3px; scrollbar-width: thin; scrollbar-color: rgba(var(--pet-primary), .42) rgba(255,255,255,.05); }
.pets-care::-webkit-scrollbar, .pets-about::-webkit-scrollbar { width: 4px; }
.pets-care::-webkit-scrollbar-track, .pets-about::-webkit-scrollbar-track { border-radius: 4px; background: rgba(255,255,255,.05); }
.pets-care::-webkit-scrollbar-thumb, .pets-about::-webkit-scrollbar-thumb { border-radius: 4px; background: linear-gradient(rgb(var(--pet-primary)), rgb(var(--pet-secondary))); }
.pets-actions { flex: none; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 5px; margin-top: 2px; padding-bottom: 1px; }
.pets-action { position: relative; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; min-width: 0; min-height: 42px; padding: 5px 3px; border-radius: 11px; font-size: 9px; background: linear-gradient(145deg, rgba(var(--pet-primary), .14), rgba(var(--pet-secondary), .08)); box-shadow: inset 0 0 0 1px rgba(var(--pet-primary), .09); transition: background 140ms, opacity 140ms, transform 140ms; }
.pets-action:last-child { grid-column: 1 / -1; min-height: 38px; flex-direction: row; gap: 6px; }
.pets-action:hover:not(:disabled) { background: linear-gradient(145deg, rgba(var(--pet-primary), .3), rgba(var(--pet-secondary), .18)); transform: translateY(-1px); }
.pets-action:disabled { opacity: 0.4; cursor: default; }
.pets-action svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
.pets-action small { position: absolute; top: 2px; right: 4px; font-size: 8.5px; color: rgba(255, 255, 255, 0.7); }

.pets-chat { min-height: 0; }
.pets-chat__tools { display: flex; gap: 8px; }
.pets-chat__link { font-size: 10.5px; color: rgba(255, 255, 255, 0.6); }
.pets-chat__link:hover:not(:disabled) { color: #fff; }
.pets-chat__link:disabled { opacity: 0.35; cursor: default; }
.pets-chat__list { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 5px; padding-right: 2px; scrollbar-width: thin; }
.pets-msg { max-width: 88%; padding: 5px 9px; border-radius: 12px; font-size: 11.5px; line-height: 1.35; user-select: text; -webkit-user-select: text; white-space: pre-wrap; overflow-wrap: anywhere; }
.pets-msg--user { align-self: flex-end; background: rgba(10, 132, 255, 0.55); }
.pets-msg--pet { align-self: flex-start; background: rgba(255, 255, 255, 0.12); }
.pets-msg--error { align-self: stretch; max-width: 100%; font-size: 10.5px; color: #ffb4ac; background: rgba(255, 69, 58, 0.16); }
.pets-msg__dots { display: inline-flex; gap: 3px; }
.pets-msg__dots i { width: 5px; height: 5px; border-radius: 50%; background: rgba(255, 255, 255, 0.7); animation: pets-dot 1s ease-in-out infinite; }
.pets-msg__dots i:nth-child(2) { animation-delay: 0.15s; }
.pets-msg__dots i:nth-child(3) { animation-delay: 0.3s; }
@keyframes pets-dot { 0%, 100% { opacity: 0.3; transform: translateY(0); } 50% { opacity: 1; transform: translateY(-2px); } }
.pets-chat__form { display: flex; gap: 6px; }
.pets-chat__form input { flex: 1; min-width: 0; height: 28px; padding: 0 10px; border: 0; border-radius: 14px; color: inherit; font: inherit; font-size: 11.5px; background: rgba(255, 255, 255, 0.1); outline: none; user-select: text; -webkit-user-select: text; }
.pets-chat__form input:focus { background: rgba(255, 255, 255, 0.16); }
.pets-chat__form button { padding: 0 12px; border-radius: 14px; font-size: 11px; font-weight: 600; background: rgba(10, 132, 255, 0.7); }
.pets-chat__form button:disabled { opacity: 0.4; cursor: default; }
.pets-replay { align-self: flex-start; font-size: 9.5px; color: rgba(255, 255, 255, 0.4); }
.pets-replay:hover { color: #fff; }
.pets-about { position: relative; }
.pets-about__portrait { align-self: center; height: 72px; display: grid; place-items: center; }
.pets-about p { margin: 0; font-size: 10px; line-height: 1.4; color: rgba(255,255,255,.68); }
.pets-about dl { display: grid; gap: 5px; margin: 0; }
.pets-about dl div { padding: 5px 7px; border-radius: 9px; background: rgba(255,255,255,.055); }
.pets-about dt { font-size: 8px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: rgba(127,205,255,.78); }
.pets-about dd { margin: 1px 0 0; font-size: 9.5px; line-height: 1.25; color: rgba(255,255,255,.76); }
.pets-chips { display: flex; flex-wrap: wrap; gap: 4px; }
.pets-chips button { padding: 3px 8px; border-radius: 10px; font-size: 10px; background: rgba(255, 255, 255, 0.1); }
.pets-chips button:hover:not(:disabled) { background: rgba(255, 255, 255, 0.2); }
.pets-chips button:disabled { opacity: 0.4; cursor: default; }
.pets-ctx { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 9.5px; color: rgba(255, 255, 255, 0.5); }
.pets-stop { background: rgba(255, 69, 58, 0.7) !important; }
.pets-cmd { display: flex; flex-direction: column; gap: 1px; padding: 4px 8px; border-radius: 8px; background: rgba(0, 0, 0, 0.32); font-size: 10px; }
.pets-cmd code { font: 10px ui-monospace, monospace; color: #d6e4ff; overflow-wrap: anywhere; user-select: text; -webkit-user-select: text; }
.pets-cmd small { color: rgba(255, 255, 255, 0.5); }
.pets-cmd[data-status="failed"] small { color: #ff8a80; }
.pets-approval { display: flex; flex-direction: column; gap: 3px; padding: 6px 8px; border-radius: 10px; background: rgba(255, 159, 10, 0.16); box-shadow: inset 0 0 0 1px rgba(255, 159, 10, 0.4); font-size: 10.5px; }
.pets-approval pre { margin: 0; max-height: 52px; overflow: auto; font: 10px ui-monospace, monospace; white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; -webkit-user-select: text; }
.pets-approval__buttons { display: flex; gap: 6px; }
.pets-approval__buttons button { padding: 3px 10px; border-radius: 10px; font-size: 10.5px; font-weight: 600; background: rgba(48, 209, 88, 0.6); }
.pets-approval__buttons button.is-no { background: rgba(255, 69, 58, 0.6); }
</style>
