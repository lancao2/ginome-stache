<script setup lang="ts">
import { computed } from "vue";

const props = defineProps<{ code: number; day?: boolean }>();

type Kind = "clear" | "partly" | "cloudy" | "fog" | "drizzle" | "rain" | "snow" | "storm";

const kind = computed<Kind>(() => {
  const code = props.code;
  if (code === 0 || code === 1) return "clear";
  if (code === 2) return "partly";
  if (code === 3) return "cloudy";
  if (code === 45 || code === 48) return "fog";
  if (code >= 51 && code <= 57) return "drizzle";
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return "rain";
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "snow";
  if (code >= 95) return "storm";
  return "cloudy";
});
const day = computed(() => props.day !== false);
</script>

<template>
  <svg viewBox="0 0 48 48" class="wx-icon" aria-hidden="true">
    <!-- Sol ou lua -->
    <g v-if="kind === 'clear' || kind === 'partly'" :transform="kind === 'partly' ? 'translate(-5 -6) scale(0.8)' : ''">
      <template v-if="day">
        <circle cx="24" cy="24" r="8" fill="#ffc83d" />
        <g stroke="#ffc83d" stroke-width="2.6" stroke-linecap="round">
          <path d="M24 8v4M24 36v4M8 24h4M36 24h4M12.7 12.7l2.8 2.8M32.5 32.5l2.8 2.8M12.7 35.3l2.8-2.8M32.5 15.5l2.8-2.8" />
        </g>
      </template>
      <path v-else d="M31 30a11 11 0 0 1-13-15 11 11 0 1 0 13 15" fill="#c9d4ff" />
    </g>
    <!-- Nuvem -->
    <path v-if="kind !== 'clear'" d="M15 36a7 7 0 0 1-.5-14 10 10 0 0 1 19.3 2.4A6 6 0 0 1 33 36z" :fill="kind === 'storm' || kind === 'rain' || kind === 'drizzle' ? '#8d99ae' : '#d8dee9'" />
    <!-- Precipitação -->
    <g v-if="kind === 'rain'" stroke="#5aa9ff" stroke-width="2.6" stroke-linecap="round"><path d="M18 40l-2 5M25 40l-2 5M32 40l-2 5" /></g>
    <g v-if="kind === 'drizzle'" stroke="#8cc4ff" stroke-width="2.2" stroke-linecap="round"><path d="M18 41l-1 3M25 41l-1 3M32 41l-1 3" /></g>
    <g v-if="kind === 'snow'" fill="#fff"><circle cx="18" cy="42" r="2" /><circle cx="25" cy="44" r="2" /><circle cx="32" cy="42" r="2" /></g>
    <path v-if="kind === 'storm'" d="M25 33l-5 8h4l-2 6 8-9h-4l3-5z" fill="#ffc83d" />
    <g v-if="kind === 'fog'" stroke="#b6bfcc" stroke-width="2.6" stroke-linecap="round"><path d="M12 40h24M16 45h18" /></g>
  </svg>
</template>
