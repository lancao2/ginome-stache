<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";

import { useWeather, type GeocodeResult } from "../composables/useWeather";
import WeatherIcon from "./WeatherIcon.vue";

const { locations, selected, selectedId, weather, loading, error, current, defaultId, setDefault, detectLocation, load, search, add, remove } = useWeather();

const adding = ref(false);
const query = ref("");
const results = ref<GeocodeResult[]>([]);
const searching = ref(false);
const searchError = ref("");
let searchTimer: number | undefined;
let refreshTimer: number | undefined;

const DESCRIPTION: Record<number, string> = {
  0: "Céu limpo", 1: "Predomínio de sol", 2: "Parcialmente nublado", 3: "Nublado",
  45: "Neblina", 48: "Neblina com geada",
  51: "Garoa fraca", 53: "Garoa", 55: "Garoa forte", 56: "Garoa gelada", 57: "Garoa gelada forte",
  61: "Chuva fraca", 63: "Chuva", 65: "Chuva forte", 66: "Chuva gelada", 67: "Chuva gelada forte",
  71: "Neve fraca", 73: "Neve", 75: "Neve forte", 77: "Grãos de neve",
  80: "Pancadas fracas", 81: "Pancadas de chuva", 82: "Pancadas fortes", 85: "Pancadas de neve", 86: "Pancadas de neve fortes",
  95: "Tempestade", 96: "Tempestade com granizo", 99: "Tempestade com granizo forte",
};
const describe = (code: number) => DESCRIPTION[code] ?? "—";
const deg = (value: number) => `${Math.round(value)}°`;

const hourFormat = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", hour12: false });
const hourLabel = (time: string) => `${hourFormat.format(new Date(time))}h`;
const clock = (time: string) => time.slice(11, 16);
function dayLabel(date: string, index: number) {
  if (index === 0) return "Hoje";
  const [year, month, day] = date.split("-").map(Number);
  return new Intl.DateTimeFormat("pt-BR", { weekday: "short" }).format(new Date(year, month - 1, day)).replace(".", "");
}

const range = computed(() => {
  const days = weather.value?.daily ?? [];
  return { min: Math.min(...days.map((day) => day.min)), max: Math.max(...days.map((day) => day.max)) };
});
function barStyle(day: { min: number; max: number }) {
  const span = Math.max(1, range.value.max - range.value.min);
  return { left: `${((day.min - range.value.min) / span) * 100}%`, width: `${Math.max(8, ((day.max - day.min) / span) * 100)}%` };
}

async function start() {
  if (!current.value) await detectLocation();
  await load();
}

onMounted(() => {
  void start();
  refreshTimer = window.setInterval(() => void load(), 5 * 60_000);
});
onBeforeUnmount(() => { window.clearInterval(refreshTimer); window.clearTimeout(searchTimer); });
watch(selectedId, () => void load());

function toggleAdd() {
  adding.value = !adding.value;
  query.value = "";
  results.value = [];
  searchError.value = "";
}

watch(query, (text) => {
  window.clearTimeout(searchTimer);
  searchError.value = "";
  if (text.trim().length < 2) { results.value = []; return; }
  searchTimer = window.setTimeout(async () => {
    searching.value = true;
    try { results.value = await search(text); if (!results.value.length) searchError.value = "Nenhuma cidade encontrada."; }
    catch { searchError.value = "Não consegui buscar agora."; }
    finally { searching.value = false; }
  }, 300);
});

function pick(result: GeocodeResult) {
  add(result);
  toggleAdd();
}
</script>

<template>
  <div class="wx-panel">
    <header class="wx-bar">
      <div class="wx-chips" role="tablist">
        <button v-for="place in locations" :key="place.id" type="button" role="tab" class="wx-chip" :aria-selected="selected?.id === place.id" @click="selectedId = place.id">
          <svg v-if="place.current" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-6.5-6.2-6.5-11a6.5 6.5 0 0 1 13 0c0 4.800-6.500 11-6.500 11M12 12.500a2.500 2.500 0 1 0 0-5 2.500 2.500 0 0 0 0 5" /></svg>
          <span>{{ place.name }}</span>
          <span class="wx-chip-star" :class="{ 'is-default': defaultId === place.id }" role="button" :aria-pressed="defaultId === place.id" :aria-label="defaultId === place.id ? `Remover ${place.name} como padrão` : `Definir ${place.name} como padrão`" :title="defaultId === place.id ? 'Cidade padrão' : 'Definir como padrão'" @click.stop="setDefault(place.id)">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3.500 2.600 5.300 5.800.8-4.200 4.100 1 5.800L12 16.800l-5.200 2.700 1-5.800-4.200-4.100 5.800-.8z" /></svg>
          </span>
          <span v-if="!place.current" class="wx-chip-x" role="button" :aria-label="`Remover ${place.name}`" @click.stop="remove(place.id)">×</span>
        </button>
      </div>
      <button type="button" class="wx-round" :class="{ 'is-on': adding }" aria-label="Adicionar cidade" title="Adicionar cidade" @click="toggleAdd">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
      </button>
      <button type="button" class="wx-round" :class="{ 'is-loading': loading }" aria-label="Atualizar" title="Atualizar" @click="load(true)">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.500-5.800M20 4v5h-5" /></svg>
      </button>
    </header>

    <div v-if="adding" class="wx-search">
      <input v-model="query" class="field" type="text" placeholder="Buscar cidade…" aria-label="Buscar cidade" autofocus @keydown.esc="toggleAdd" />
      <ul v-if="results.length" class="wx-results">
        <li v-for="result in results" :key="result.id">
          <button type="button" @click="pick(result)"><strong>{{ result.name }}</strong><small>{{ [result.admin1, result.country].filter(Boolean).join(", ") }}</small></button>
        </li>
      </ul>
      <p v-else-if="searching || searchError" class="wx-hint">{{ searching ? "Buscando…" : searchError }}</p>
    </div>

    <div v-if="weather && selected" class="wx-body">
      <section class="wx-now">
        <div class="wx-place"><strong>{{ selected.name }}</strong><small>{{ selected.detail }}</small></div>
        <div class="wx-main">
          <WeatherIcon class="wx-big" :code="weather.current.code" :day="weather.current.isDay" />
          <span class="wx-temp">{{ deg(weather.current.temperature) }}</span>
        </div>
        <div class="wx-desc">{{ describe(weather.current.code) }} · máx {{ deg(weather.daily[0].max) }} mín {{ deg(weather.daily[0].min) }}</div>
        <dl class="wx-stats">
          <div><dt>Sensação</dt><dd>{{ deg(weather.current.apparent) }}</dd></div>
          <div><dt>Umidade</dt><dd>{{ Math.round(weather.current.humidity) }}%</dd></div>
          <div><dt>Vento</dt><dd>{{ Math.round(weather.current.wind) }} km/h</dd></div>
          <div><dt>Nascer</dt><dd>{{ clock(weather.sunrise) }}</dd></div>
          <div><dt>Pôr do sol</dt><dd>{{ clock(weather.sunset) }}</dd></div>
        </dl>
      </section>

      <section class="wx-side">
        <ol class="wx-hours" aria-label="Próximas horas">
          <li v-for="hour in weather.hourly.filter((_, index) => index % 2 === 0).slice(0, 6)" :key="hour.time">
            <span>{{ hourLabel(hour.time) }}</span>
            <WeatherIcon :code="hour.code" :day="hour.isDay" />
            <strong>{{ deg(hour.temperature) }}</strong>
          </li>
        </ol>
        <ul class="wx-days" aria-label="Próximos dias">
          <li v-for="(day, index) in weather.daily.slice(0, 5)" :key="day.date">
            <span class="wx-day">{{ dayLabel(day.date, index) }}</span>
            <WeatherIcon :code="day.code" />
            <span class="wx-rain">{{ day.rain }}%</span>
            <span class="wx-min">{{ deg(day.min) }}</span>
            <span class="wx-track"><i :style="barStyle(day)" /></span>
            <span class="wx-max">{{ deg(day.max) }}</span>
          </li>
        </ul>
      </section>
    </div>
    <p v-else class="empty">{{ error || (loading ? "Carregando previsão…" : "Adicione uma cidade para ver a previsão.") }}</p>
    <p v-if="error && weather" class="wx-hint">{{ error }}</p>
  </div>
</template>
