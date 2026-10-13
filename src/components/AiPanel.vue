<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

import { useAiUsage } from "../composables/useAiUsage";
import type { AiUsage, AiWindow } from "../types/ai";
import AiLogo from "./AiLogo.vue";

const { usage, loading, loaded, load } = useAiUsage();

const now = ref(Date.now());
let timer: number | undefined;
onMounted(() => {
  void load();
  timer = window.setInterval(() => { now.value = Date.now(); void load(); }, 30_000);
});
onBeforeUnmount(() => window.clearInterval(timer));

const BRAND: Record<string, string> = { claude: "#d97757", codex: "#6ee7c8", gemini: "#8ba8ff" };
// Raios dos anéis do gráfico: o de fora é a janela curta, o de dentro a semanal.
const RINGS = { session: 40, weekly: 31 } as const;
const STROKE = 8;

function windowOf(item: AiUsage, id: AiWindow["id"]) {
  return item.windows.find((window) => window.id === id);
}

function dash(percent: number, radius: number) {
  const circumference = 2 * Math.PI * radius;
  return `${(circumference * Math.min(100, Math.max(0, percent))) / 100} ${circumference}`;
}

function ringColor(item: AiUsage, percent: number) {
  if (percent >= 90) return "#ff5a5f";
  if (percent >= 75) return "#ffb340";
  return BRAND[item.id] ?? "#fff";
}

function resetLabel(window?: AiWindow) {
  if (!window?.resetsAt) return "";
  const minutes = Math.round((new Date(window.resetsAt).getTime() - now.value) / 60_000);
  if (Number.isNaN(minutes)) return "";
  if (minutes <= 0) return "reinicia agora";
  if (minutes < 60) return `reinicia em ${minutes} min`;
  if (minutes < 24 * 60) return `reinicia em ${Math.floor(minutes / 60)} h ${minutes % 60 ? `${minutes % 60} min` : ""}`.trim();
  return `reinicia em ${Math.floor(minutes / 1_440)} d ${Math.floor((minutes % 1_440) / 60)} h`;
}

const PLAN: Record<string, string> = { pro: "Pro", max: "Max", plus: "Plus", team: "Team", free: "Free", prolite: "Pro Lite" };
const planLabel = (plan: string | null) => (plan ? PLAN[plan.toLowerCase()] ?? plan : "");

function message(item: AiUsage) {
  if (item.status === "no_login") return "Faça login para ver os limites.";
  if (item.status === "error") return item.note ? `Não consegui consultar (${item.note}).` : "Não consegui consultar.";
  return item.note ?? "Limites indisponíveis.";
}

const items = computed(() => usage.value);
</script>

<template>
  <div class="ai-panel">
    <header class="ai-head">
      <h2>Inteligências artificiais</h2>
      <button type="button" class="ai-refresh" :class="{ 'is-loading': loading }" aria-label="Atualizar limites" title="Atualizar" @click="load(true)">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.5-5.8M20 4v5h-5" /></svg>
      </button>
    </header>

    <ul v-if="items.length" class="ai-grid">
      <li v-for="item in items" :key="item.id" class="ai-card">
        <div class="ai-donut">
          <svg viewBox="0 0 100 100" aria-hidden="true">
            <template v-for="id in (['session', 'weekly'] as const)" :key="id">
              <circle cx="50" cy="50" :r="RINGS[id]" class="ai-track" :stroke-width="STROKE" />
              <circle v-if="windowOf(item, id)" cx="50" cy="50" :r="RINGS[id]" class="ai-ring" :stroke-width="STROKE" :stroke="ringColor(item, windowOf(item, id)!.usedPercent)" :stroke-dasharray="dash(windowOf(item, id)!.usedPercent, RINGS[id])" />
            </template>
          </svg>
          <span class="ai-logo-wrap"><AiLogo :id="item.id" /></span>
        </div>

        <div class="ai-info">
          <div class="ai-name">
            <strong>{{ item.name }}</strong>
            <span v-if="planLabel(item.plan)" class="ai-plan">{{ planLabel(item.plan) }}</span>
          </div>
          <template v-if="item.status === 'ok'">
            <div v-for="id in (['session', 'weekly'] as const)" :key="id" class="ai-limit">
              <template v-if="windowOf(item, id)">
                <span class="ai-limit-label"><i :class="`ai-key ai-key--${id}`" :style="{ background: ringColor(item, windowOf(item, id)!.usedPercent) }" />{{ id === "session" ? "Diário" : "Semanal" }}</span>
                <span class="ai-limit-value">{{ Math.round(windowOf(item, id)!.usedPercent) }}%</span>
                <small>{{ resetLabel(windowOf(item, id)) }}</small>
              </template>
            </div>
          </template>
          <p v-else class="ai-note">{{ message(item) }}</p>
        </div>
      </li>
    </ul>
    <p v-else class="empty">{{ loaded ? "Nenhuma IA encontrada neste computador." : "Procurando IAs…" }}</p>
  </div>
</template>
