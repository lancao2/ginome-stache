<script setup lang="ts">
import type { IslandTab } from "../composables/useIsland";
import { useNotifications } from "../composables/useNotifications";
import ControlCenter from "./ControlCenter.vue";
import PluginsPanel from "./PluginsPanel.vue";
import WeatherPanel from "./WeatherPanel.vue";
import AiPanel from "./AiPanel.vue";
import HomePanel from "./HomePanel.vue";
import NotificationsPanel from "./NotificationsPanel.vue";
import WhatsappPanel from "./WhatsappPanel.vue";
import CodexPanel from "./CodexPanel.vue";
import ClipboardPanel from "./ClipboardPanel.vue";
import PetsPanel from "./PetsPanel.vue";
import SearchPanel from "./SearchPanel.vue";
import IslandHeader from "./IslandHeader.vue";
import ChargeBolt from "./ChargeBolt.vue";

defineProps<{ now: number; expanded: boolean; tab: IslandTab; hasMedia: boolean; controlsOpen: boolean }>();
const { count: notificationCount } = useNotifications();
const emit = defineEmits<{ hoverEnter: []; hoverLeave: []; toggle: []; selectTab: [tab: IslandTab]; toggleControls: [] }>();

const time = (value: number) => new Intl.DateTimeFormat("pt-BR", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
}).format(value);

const date = (value: number) => new Intl.DateTimeFormat("pt-BR", {
  weekday: "short",
  day: "numeric",
  month: "short",
}).format(value).replace(/\./g, "");
</script>

<template>
  <section
    class="island island--clock"
    :class="{ 'island--expanded': expanded, 'island--tall': expanded }"
    role="timer"
    aria-label="Data e hora atuais"
    :tabindex="expanded ? -1 : 0"
    @click="!expanded && emit('toggle')"
    @keydown.enter="!expanded && emit('toggle')"
    @pointerenter="emit('hoverEnter')"
    @pointerleave="emit('hoverLeave')"
  >
    <div class="compact-view clock-view" :aria-hidden="expanded">
      <span class="clock-time">{{ time(now) }}</span>
      <span class="clock-separator" aria-hidden="true" />
      <span class="clock-date">{{ date(now) }}</span>
      <ChargeBolt />
    </div>

    <div class="expanded-view" :aria-hidden="!expanded" :inert="!expanded">
      <IslandHeader :tab="tab" :has-media="hasMedia" :notifications="notificationCount" :controls-open="controlsOpen" @select="emit('selectTab', $event)" @toggle-controls="emit('toggleControls')" />
      <HomePanel v-show="tab === 'home'" />
      <AiPanel v-if="tab === 'ai'" />
      <WeatherPanel v-if="tab === 'weather'" />
      <NotificationsPanel v-show="tab === 'notifications'" />
      <WhatsappPanel v-if="tab === 'whatsapp'" />
      <CodexPanel v-if="tab === 'codex'" />
      <ClipboardPanel v-if="tab === 'clipboard'" />
      <PetsPanel v-if="tab === 'pets'" @navigate="emit('selectTab', $event)" />
      <SearchPanel v-if="tab === 'search'" />
      <PluginsPanel v-if="tab === 'plugins'" />
      <Transition name="cc-slide">
        <ControlCenter v-if="controlsOpen && expanded" @close="emit('toggle')" />
      </Transition>
    </div>
  </section>
</template>
