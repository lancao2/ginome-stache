<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";

import { openUrl } from "@tauri-apps/plugin-opener";

import { useCodex, type CodexEntry } from "../composables/useCodex";
import { usePetTasks } from "../composables/usePetTasks";
import { useAgentHub } from "../composables/useAgentHub";
import { usePets } from "../composables/usePets";
import { PET_IDS, PROFILES, pickLine, type PetId } from "../pets/data";
import { taskInstructions } from "../pets/persona";
import { mentionedPet, routePet } from "../pets/router";
import { CONTEXT, clip } from "../pets/budget";
import { usePetAbsence } from "../composables/usePetAbsence";
import PetSprite from "./PetSprite.vue";

const codex = useCodex();
const petTasks = usePetTasks();
const agentHub = useAgentHub();
const petsStore = usePets();
const absence = usePetAbsence();
const { cwd, recents, status, detail, entries, running, pendingApprovals } = codex;

const draft = ref("");
const picker = ref(false);
const manual = ref("");
const scroller = ref<HTMLElement | null>(null);
const open = ref<Record<string, boolean>>({});
const routing = ref<{ target: PetId; shown: PetId; settled: boolean } | null>(null);
const routingTimers: number[] = [];
const ROUTE_INTERVALS = [70, 70, 75, 80, 90, 105, 125, 150, 185] as const;
let turnEntryStart = 0;
let turnPet: PetId | null = null;
let turnTask = false;
let lastTurnPet: PetId | null = null;

onMounted(() => { codex.panelOpen.value = true; if (cwd.value) void codex.boot().catch(() => undefined); });
onBeforeUnmount(() => {
  codex.panelOpen.value = false;
  routingTimers.forEach((timer) => window.clearTimeout(timer));
});

const folderName = (path: string) => path.split("/").filter(Boolean).pop() || path || "Escolher pasta";

// Mantém o fim da conversa à vista enquanto o Codex escreve, sem puxar quem rolou para cima.
let stick = true;
function onScroll() {
  const box = scroller.value;
  if (box) stick = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
}
watch(entries, async () => {
  await nextTick();
  if (stick) scroller.value?.scrollTo({ top: scroller.value.scrollHeight });
}, { deep: true });

watch(running, (isRunning, wasRunning) => {
  if (isRunning || !wasRunning || !turnPet) return;
  const produced = entries.value.slice(turnEntryStart);
  const answered = produced.some((item) => item.kind === "agent" && item.text.trim());
  const usedTools = produced.some((item) => item.kind === "command" || item.kind === "files" || item.kind === "approval");
  // Tarefa (sugestão pronta ou uso de ferramentas) conta para o status do agente; conversa só para a memória.
  if (turnTask || usedTools) petsStore.taskDone(turnPet, answered && !produced.some((item) => item.kind === "error"));
  else if (answered) petsStore.noteChat(turnPet);
  turnPet = null;
  turnTask = false;
});

function wait(ms: number) {
  return new Promise<void>((resolve) => routingTimers.push(window.setTimeout(resolve, ms)));
}

async function identify(target: PetId) {
  const end = PET_IDS.indexOf(target);
  const sequence = Array.from({ length: ROUTE_INTERVALS.length + 1 }, (_, index) => PET_IDS[(end - (ROUTE_INTERVALS.length - index) + PET_IDS.length * 4) % PET_IDS.length]);
  routing.value = { target, shown: sequence[0], settled: false };
  for (let index = 1; index < sequence.length; index += 1) {
    await wait(ROUTE_INTERVALS[index - 1]);
    if (!routing.value) return;
    routing.value = { target, shown: sequence[index], settled: index === sequence.length - 1 };
  }
  await wait(360);
}

// Sugestões prontas: mostra as do agente escolhido ou, sem escolha, as de todos.
const presets = computed(() => (agentHub.preferredPet.value ? [agentHub.preferredPet.value] : [...PET_IDS]).flatMap((pet) => petTasks.presets[pet].map((item) => ({ pet, ...item }))));

function runPreset(item: { pet: PetId; prompt: string }) {
  if (running.value || routing.value) return;
  void submit({ pet: item.pet, prompt: item.prompt });
}

async function submit(forced?: { pet: PetId; prompt: string }) {
  const request = forced?.prompt ?? draft.value.trim();
  if (!request || running.value || routing.value) return;
  stick = true;
  if (!forced) draft.value = "";
  const followsContext = /^(?:essa|esse|isso|isto|aquilo|aquela|sim\b|não\b|nao\b)|\b(?:anterior(?:mente)?|mencionad[oa]|que .{0,24} disse|acima)\b/i.test(request);
  const pet = forced?.pet ?? (followsContext ? lastTurnPet : null) ?? mentionedPet(request) ?? agentHub.preferredPet.value ?? routePet(request);
  await identify(pet);
  // Fora do ar (sem tokens): responde a desculpa sem chamar o Codex.
  const excuse = absence.excuse(pet);
  if (excuse) {
    routing.value = null;
    agentHub.consumePreference();
    lastTurnPet = pet;
    codex.absentReply(request, pet, excuse);
    return;
  }
  // Mascote triste recusa tarefa com IA, em personagem (como no painel Mascotes).
  if (forced && !petsStore.canWork(pet)) {
    const line = pickLine(pet, "recusa");
    routing.value = null;
    petsStore.speech.value = { ...petsStore.speech.value, [pet]: line };
    codex.absentReply(request, pet, line);
    return;
  }
  const context = petTasks.context(pet);
  // O que cada agente já viu fica na thread dele: o resumo da conversa só vai ao trocar de agente.
  const shared = () => {
    const recent = entries.value
      .filter((item): item is Extract<CodexEntry, { kind: "user" | "agent" }> => item.kind === "user" || item.kind === "agent")
      .slice(-CONTEXT.recentMessages)
      .map((item) => item.kind === "user" ? `Usuário: ${clip(item.text, CONTEXT.recentLength)}` : `${item.pet ? PROFILES[item.pet].nome : "Agente"}: ${clip(item.text, CONTEXT.recentLength)}`)
      .join("\n");
    return recent ? `Contexto recente compartilhado entre os agentes:\n${recent}` : "";
  };
  turnEntryStart = entries.value.length;
  turnPet = pet;
  turnTask = Boolean(forced);
  lastTurnPet = pet;
  agentHub.consumePreference();
  routing.value = null;
  await codex.sendMessage(request, { pet, developerInstructions: taskInstructions(pet), context: context.body, always: context.now, shared });
}

function pick(path: string) {
  codex.setCwd(path);
  picker.value = false;
  manual.value = "";
  void codex.boot().catch(() => undefined);
}
async function choose() {
  await codex.chooseFolder();
  picker.value = false;
  if (cwd.value) void codex.boot().catch(() => undefined);
}

function newChat() {
  codex.newChat();
  lastTurnPet = null;
  agentHub.clearPreference();
}

// Texto do Codex: blocos de código e `código`/**negrito** simples; nunca vira HTML.
interface Block { code: boolean; text: string }
function blocks(text: string): Block[] {
  const result: Block[] = [];
  const pattern = /```[^\n]*\n?([\s\S]*?)(?:```|$)/g;
  let last = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    if (match.index > last) result.push({ code: false, text: text.slice(last, match.index) });
    result.push({ code: true, text: match[1].replace(/\n$/, "") });
    last = pattern.lastIndex;
    if (match[0].length === 0) pattern.lastIndex += 1;
  }
  if (last < text.length) result.push({ code: false, text: text.slice(last) });
  return result.filter((block) => block.text.trim() !== "");
}
// [texto](url), https://… soltos, `código` e **negrito**.
const INLINE = /(\[[^\]\n]+\]\((?:https?:\/\/|mailto:)[^)\s]+\)|https?:\/\/[^\s<>"')\]]+|`[^`\n]+`|\*\*[^*\n]+\*\*)/;
function inline(text: string) {
  return text.split(INLINE).filter(Boolean).map((chunk) => {
    const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(chunk);
    if (link) return { kind: "link", text: link[1], url: link[2] };
    if (/^https?:\/\//.test(chunk)) {
      const url = chunk.replace(/[.,;:!?]+$/, "");
      return { kind: "link", text: chunk, url };
    }
    if (chunk.startsWith("`")) return { kind: "code", text: chunk.slice(1, -1), url: "" };
    if (chunk.startsWith("**") && chunk.endsWith("**") && chunk.length > 4) return { kind: "bold", text: chunk.slice(2, -2), url: "" };
    return { kind: "text", text: chunk, url: "" };
  });
}
async function openLink(url: string) {
  try { await openUrl(url); } catch { /* sem navegador padrão disponível */ }
}

const changeLabel = { add: "novo", delete: "removido", update: "editado" } as const;
const commandState = (item: Extract<CodexEntry, { kind: "command" }>) =>
  item.status === "inProgress" ? "running" : item.status === "declined" ? "declined" : item.exitCode ? "failed" : "done";
</script>

<template>
  <div class="cx-panel">
    <header class="cx-bar">
      <button type="button" class="cx-folder" :title="cwd || 'Escolher pasta'" @click="picker = !picker">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>
        <span>{{ folderName(cwd) }}</span>
        <svg class="cx-caret" viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5" /></svg>
      </button>
      <span v-if="pendingApprovals" class="cx-pending">{{ pendingApprovals }} aguardando aprovação</span>
      <span v-if="agentHub.preferredPet.value" class="cx-agent-target">
        <PetSprite :pet="agentHub.preferredPet.value" state="parado" :size="22" compact />
        Falar com {{ PROFILES[agentHub.preferredPet.value].nome }}
        <button type="button" aria-label="Usar seleção automática" title="Usar seleção automática" @click="agentHub.clearPreference()">×</button>
      </span>
      <span class="cx-spacer" />
      <button type="button" class="cx-ghost" :disabled="!entries.length && !running" @click="newChat">Novo chat</button>
    </header>

    <div v-if="picker" class="cx-picker" role="dialog" aria-label="Pasta do Codex">
      <button type="button" class="cx-pick-main" @click="choose">Escolher pasta…</button>
      <form class="cx-path" @submit.prevent="manual.trim() && pick(manual)">
        <input v-model="manual" type="text" class="cx-field" placeholder="ou cole um caminho" aria-label="Caminho da pasta" autocomplete="off" />
      </form>
      <button v-for="path in recents" :key="path" type="button" class="cx-recent" :class="{ 'is-current': path === cwd }" :title="path" @click="pick(path)">
        <b>{{ folderName(path) }}</b><small>{{ path }}</small>
      </button>
    </div>

    <div v-if="!cwd" class="cx-empty">
      <strong>Codex no Stache</strong>
      <small>Escolha a pasta em que ele vai trabalhar.</small>
      <button type="button" class="cx-primary" @click="choose">Escolher pasta</button>
    </div>
    <div v-else-if="status === 'unavailable'" class="cx-empty">
      <strong>Codex indisponível</strong>
      <small>{{ detail || "Não foi possível iniciar o Codex." }}</small>
      <button type="button" class="cx-primary" @click="codex.boot().catch(() => undefined)">Tentar de novo</button>
    </div>

    <template v-else>
      <div ref="scroller" class="cx-feed" @scroll="onScroll">
        <p v-if="!entries.length" class="cx-hint">Pergunte algo sobre <b>{{ folderName(cwd) }}</b>. Comandos e edições pedem a sua aprovação.</p>

        <template v-for="item in entries" :key="item.id">
          <div v-if="item.kind === 'user'" class="cx-msg cx-msg--user">{{ item.text }}</div>

          <div v-else-if="item.kind === 'agent'" class="cx-msg cx-msg--agent" :class="{ 'is-streaming': item.streaming }">
            <div v-if="item.pet" class="cx-agent-head">
              <PetSprite :pet="item.pet" :state="item.streaming ? 'trabalhando' : 'parado'" :size="28" compact />
              <span><b>{{ PROFILES[item.pet].nome }}</b><small>{{ PROFILES[item.pet].papel }}</small></span>
            </div>
            <template v-for="(block, index) in blocks(item.text)" :key="index">
              <pre v-if="block.code" class="cx-code">{{ block.text }}</pre>
              <p v-else class="cx-text"><template v-for="(part, at) in inline(block.text)" :key="at"><a v-if="part.kind === 'link'" class="cx-link" :href="part.url" :title="part.url" @click.prevent.stop="openLink(part.url)">{{ part.text }}</a><code v-else-if="part.kind === 'code'">{{ part.text }}</code><b v-else-if="part.kind === 'bold'">{{ part.text }}</b><template v-else>{{ part.text }}</template></template></p>
            </template>
          </div>

          <div v-else-if="item.kind === 'command'" class="cx-card">
            <button type="button" class="cx-card-head" :aria-expanded="!!open[item.id]" @click="open[item.id] = !open[item.id]">
              <span class="cx-state" :class="`cx-state--${commandState(item)}`" aria-hidden="true" />
              <code>{{ item.command }}</code>
            </button>
            <pre v-if="open[item.id] && item.output" class="cx-output">{{ item.output }}</pre>
          </div>

          <div v-else-if="item.kind === 'files'" class="cx-card">
            <div class="cx-card-head">
              <span class="cx-state" :class="`cx-state--${item.status === 'completed' ? 'done' : item.status === 'inProgress' ? 'running' : item.status === 'declined' ? 'declined' : 'failed'}`" aria-hidden="true" />
              <span class="cx-files"><span v-for="file in item.files" :key="file.path"><b>{{ folderName(file.path) }}</b> <small>{{ changeLabel[file.change] }}</small></span></span>
            </div>
          </div>

          <div v-else-if="item.kind === 'approval'" class="cx-approval" :class="{ 'is-done': item.decision }">
            <strong>{{ item.title }}</strong>
            <pre class="cx-detail">{{ item.detail }}</pre>
            <div v-if="!item.decision" class="cx-actions">
              <button type="button" class="cx-yes" @click="codex.answer(item, 'accept')">Aprovar</button>
              <button type="button" class="cx-ghost" @click="codex.answer(item, 'acceptForSession')">Aprovar na sessão</button>
              <button type="button" class="cx-no" @click="codex.answer(item, 'decline')">Negar</button>
            </div>
            <small v-else>{{ item.decision === "decline" ? "Negado" : item.decision === "accept" ? "Aprovado" : "Aprovado na sessão" }}</small>
          </div>

          <p v-else class="cx-error" role="alert">{{ item.text }}</p>
        </template>

        <div v-if="routing" class="cx-router" :class="{ 'is-settled': routing.settled }" role="status">
          <span class="cx-router__window">
            <PetSprite :key="routing.shown" :pet="routing.shown" :state="routing.settled ? 'feliz' : 'parado'" :size="34" compact />
          </span>
          <span class="cx-router__text">
            <template v-if="!routing.settled">Identificando o agente ideal…</template>
            <template v-else><b>{{ PROFILES[routing.target].nome }}</b> vai cuidar disso<span class="cx-router__dots"><i /><i /><i /></span></template>
          </span>
        </div>
        <p v-else-if="running && !pendingApprovals" class="cx-working"><span /><span /><span /></p>
      </div>

      <div v-if="!running && !routing" class="cx-presets" aria-label="Tarefas prontas">
        <button v-for="item in presets" :key="`${item.pet}-${item.label}`" type="button" :title="item.prompt" @click="runPreset(item)">
          <PetSprite :pet="item.pet" state="parado" :size="14" compact />{{ item.label }}
        </button>
      </div>
      <form class="cx-composer" @submit.prevent="submit()">
        <input v-model="draft" class="cx-field" type="text" :disabled="!!routing" :placeholder="routing ? 'Identificando o agente…' : running ? 'Seu agente está trabalhando…' : 'Peça algo à equipe…'" aria-label="Mensagem para a equipe de agentes" autocomplete="off" />
        <button v-if="running" type="button" class="cx-round" title="Parar" aria-label="Parar" @click="codex.interrupt()">
          <svg viewBox="0 0 24 24" class="cx-fill"><rect x="7" y="7" width="10" height="10" rx="2" /></svg>
        </button>
        <button v-else type="submit" class="cx-round cx-round--send" :disabled="!draft.trim() || !!routing" aria-label="Enviar">
          <svg viewBox="0 0 24 24"><path d="M12 19V5m-6 6 6-6 6 6" /></svg>
        </button>
      </form>
    </template>
  </div>
</template>

<style>
.cx-router { align-self: flex-start; display: inline-flex; align-items: center; gap: 9px; padding: 4px 12px 4px 4px; border: 1px solid rgba(255,255,255,.1); border-radius: 999px; color: rgba(255,255,255,.62); background: rgba(255,255,255,.055); font-size: 11px; }
.cx-router__window { position: relative; width: 44px; height: 44px; display: grid; place-items: center; overflow: hidden; border-radius: 50%; background: rgba(111,181,255,.08); transition: box-shadow 240ms, background 240ms; }
.cx-router__window .pet { animation: cx-route-in 90ms ease-out both; }
.cx-router.is-settled .cx-router__window { background: rgba(83,214,151,.11); box-shadow: 0 0 0 2px rgba(83,214,151,.3), 0 0 14px rgba(83,214,151,.14); }
.cx-router.is-settled .cx-router__window .pet { animation: cx-route-settle 340ms ease-out both; }
.cx-router__text { display: inline-flex; align-items: center; gap: 4px; }
.cx-router__text b { color: rgba(255,255,255,.94); }
.cx-router__dots { display: inline-flex; gap: 3px; margin-left: 2px; }
.cx-router__dots i { width: 4px; height: 4px; border-radius: 50%; background: currentColor; animation: cx-router-dot .9s ease-in-out infinite; }
.cx-router__dots i:nth-child(2) { animation-delay: .14s; }.cx-router__dots i:nth-child(3) { animation-delay: .28s; }
.cx-agent-head { display: flex; align-items: center; gap: 6px; margin: -2px 0 4px; }
.cx-agent-head > span { display: flex; flex-direction: column; }
.cx-agent-head b { font-size: 10.5px; color: rgba(255,255,255,.9); }
.cx-agent-head small { font-size: 8.5px; color: rgba(255,255,255,.42); }
.cx-presets { display: flex; gap: 5px; overflow-x: auto; padding: 0 2px 5px; scrollbar-width: none; }
.cx-presets button { flex: none; display: inline-flex; align-items: center; gap: 4px; padding: 3px 8px 3px 5px; border-radius: 999px; font-size: 10px; white-space: nowrap; color: rgba(255,255,255,.78); background: rgba(255,255,255,.07); box-shadow: inset 0 0 0 1px rgba(255,255,255,.1); }
.cx-presets button:hover { background: rgba(255,255,255,.14); color: #fff; }
.cx-agent-target { display: inline-flex; align-items: center; gap: 4px; min-width: 0; padding: 1px 5px 1px 2px; border-radius: 999px; color: rgba(255,255,255,.72); background: rgba(105,200,244,.1); box-shadow: inset 0 0 0 1px rgba(105,200,244,.18); font-size: 9px; white-space: nowrap; }
.cx-agent-target button { width: 15px; height: 15px; border-radius: 50%; color: rgba(255,255,255,.5); font-size: 12px; line-height: 14px; }
.cx-agent-target button:hover { color: #fff; background: rgba(255,255,255,.1); }
@keyframes cx-route-in { from { opacity: .35; transform: translateY(-80%); } to { opacity: 1; transform: translateY(0); } }
@keyframes cx-route-settle { 0% { transform: translateY(0); } 45% { transform: translateY(-6px); } 100% { transform: translateY(0); } }
@keyframes cx-router-dot { 0%,100% { opacity: .35; transform: scale(.7); } 50% { opacity: 1; transform: scale(1.15); } }
@media (prefers-reduced-motion: reduce) { .cx-router__window .pet, .cx-router.is-settled .cx-router__window .pet, .cx-router__dots i { animation: none; } }
</style>
