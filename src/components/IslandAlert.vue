<script setup lang="ts">
import type { IslandAlertItem } from "../composables/useIsland";
import IslandWaves from "./IslandWaves.vue";

defineProps<{ item: IslandAlertItem }>();
const emit = defineEmits<{ hoverEnter: []; hoverLeave: []; open: [] }>();
</script>

<template>
  <section
    :class="['island', 'island--alert', `island--alert-${item.tone}`]"
    role="alert"
    tabindex="0"
    :aria-label="`${item.label}: ${item.text}`"
    @click="emit('open')"
    @keydown.enter.self="emit('open')"
    @pointerenter="emit('hoverEnter')"
    @pointerleave="emit('hoverLeave')"
  >
    <IslandWaves v-if="item.kind === 'task'" />
    <div class="compact-view">
      <img v-if="item.icon" class="alert-app-icon" :src="item.icon" alt="" />
      <span v-else-if="item.kind === 'whatsapp'" class="alert-initial" aria-hidden="true">{{ (item.initial || "?").trim().charAt(0).toUpperCase() }}</span>
      <span v-else-if="item.kind === 'context'" class="alert-bell" aria-hidden="true">
        <svg viewBox="0 0 24 24">
          <path v-if="item.symbol === 'download'" d="M12 4v10m0 0-4-4m4 4 4-4M5 19h14" />
          <path v-else-if="item.symbol === 'download-done' || item.symbol === 'battery-full'" d="m5 12.5 4.5 4.5L19 7.500" />
          <path v-else-if="item.symbol === 'mic'" d="M12 3a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3M5 11a7 7 0 0 0 14 0M12 18v3" />
          <path v-else-if="item.symbol === 'camera'" d="M3 8a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM15 11l6-3v8l-6-3" />
          <path v-else-if="item.symbol === 'plugin'" d="M4 5.500A1.500 1.500 0 0 1 5.500 4h4A1.500 1.500 0 0 1 11 5.500v4A1.500 1.500 0 0 1 9.500 11h-4A1.500 1.500 0 0 1 4 9.500zM13 14.500a1.500 1.500 0 0 1 1.500-1.500h4a1.500 1.500 0 0 1 1.500 1.500v4a1.500 1.500 0 0 1-1.500 1.500h-4a1.500 1.500 0 0 1-1.500-1.500zM13 7h7M4 16h7" />
          <path v-else-if="item.symbol === 'meeting'" d="M7 3v3m10-3v3M4 8h16M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1" />
          <path v-else-if="item.symbol === 'conflict'" d="M12 8v5m0 3.500v.01M10.300 4.200 2.900 17a2 2 0 0 0 1.700 3h14.800a2 2 0 0 0 1.700-3L13.700 4.200a2 2 0 0 0-3.400 0" />
          <path v-else-if="item.symbol === 'screen'" d="M3 5.500A1.500 1.500 0 0 1 4.500 4h15A1.500 1.500 0 0 1 21 5.500v9a1.500 1.500 0 0 1-1.500 1.500h-15A1.500 1.500 0 0 1 3 14.500zM8 20h8M12 16v4" />
          <path v-else-if="item.symbol === 'bluetooth'" d="m7 7 10 10-5 5V2l5 5L7 17" />
          <path v-else-if="item.symbol === 'battery-low'" d="M3 8.500A1.500 1.500 0 0 1 4.500 7h13A1.500 1.500 0 0 1 19 8.500v7a1.500 1.500 0 0 1-1.500 1.500h-13A1.500 1.500 0 0 1 3 15.500zM21 10.500v3M6 10v4" />
          <path v-else d="M8 4h8a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2m2 4h4m-4 4h4" />
        </svg>
      </span>
      <span v-else class="alert-bell" aria-hidden="true">
        <svg viewBox="0 0 24 24"><path d="M6 9a6 6 0 0 1 12 0c0 6 2.5 7.5 2.5 7.5h-17S6 15 6 9m4 10.5a2 2 0 0 0 4 0" /></svg>
      </span>
      <span class="compact-title"><b>{{ item.label }}</b> · {{ item.text }}</span>
      <svg v-if="item.kind === 'task'" class="alert-mark" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8v5m0 3.5v.01M10.3 4.2 2.9 17a2 2 0 0 0 1.7 3h14.8a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0" /></svg>
    </div>
  </section>
</template>
