<script setup lang="ts">
import type { IslandTab } from "../composables/useIsland";
import type { MediaTrack } from "../types/media";
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

defineProps<{ expanded: boolean; tab: IslandTab; tall: boolean; controlsOpen: boolean; track: MediaTrack; playing: boolean; elapsed: number; progress: number }>();
const { count: notificationCount } = useNotifications();
const emit = defineEmits<{ toggle: []; hoverEnter: []; hoverLeave: []; playPause: []; next: []; previous: []; selectTab: [tab: IslandTab]; toggleControls: [] }>();

const formatTime = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
</script>

<template>
  <section
    class="island"
    :class="{ 'island--expanded': expanded, 'island--tall': expanded && tall }"
    :style="{ '--accent': track.accent }"
    role="region"
    :aria-label="expanded ? 'Stache expandido' : 'Expandir Stache'"
    :tabindex="expanded ? -1 : 0"
    @click="!expanded && emit('toggle')"
    @keydown.enter.self="!expanded && emit('toggle')"
    @keydown.space.self.prevent="!expanded && emit('toggle')"
    @pointerenter="emit('hoverEnter')"
    @pointerleave="emit('hoverLeave')"
  >
    <div class="compact-view" :aria-hidden="expanded">
      <span class="compact-cover" aria-hidden="true">
        <img v-if="track.artwork" :src="track.artwork" alt="" />
        <span v-else>♪</span>
      </span>
      <span class="compact-title" :style="{ fontWeight: 600 }">{{ track.title }}</span>
      <div class="wave" :class="{ 'wave--paused': !playing }" aria-hidden="true">
        <i /><i /><i /><i />
      </div>
      <ChargeBolt />
    </div>

    <div class="expanded-view" :aria-hidden="!expanded" :inert="!expanded">
      <IslandHeader :tab="tab" :has-media="true" :source="track.source" :notifications="notificationCount" :controls-open="controlsOpen" @select="emit('selectTab', $event)" @toggle-controls="emit('toggleControls')" />

      <div v-show="tab === 'media'" class="media-card">
        <div class="album-cover" aria-hidden="true">
          <img v-if="track.artwork" :src="track.artwork" alt="" />
          <template v-else>
            <span>♪</span>
            <div class="album-glow" />
          </template>
        </div>

        <div class="media-info">
          <div class="media-copy">
            <strong>{{ track.title }}</strong>
            <span>{{ [track.artist, track.album].filter(Boolean).join(" · ") || track.source }}</span>
          </div>
          <div class="progress" role="progressbar" :aria-valuenow="Math.round(progress * 100)" aria-valuemin="0" aria-valuemax="100">
            <span :style="{ transform: `scaleX(${progress})` }" />
          </div>
          <div class="time-row">
            <span>{{ formatTime(elapsed) }}</span>
            <span>{{ formatTime(track.duration) }}</span>
          </div>
        </div>

        <div class="controls" @click.stop>
          <button type="button" aria-label="Faixa anterior" :disabled="!track.canGoPrevious" @click="emit('previous')">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h2v14H6zm3 7 9-7v14z" /></svg>
          </button>
          <button type="button" class="controls__primary" :aria-label="playing ? 'Pausar' : 'Reproduzir'" @click="emit('playPause')">
            <svg v-if="playing" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h4v14H6zm8 0h4v14h-4z" /></svg>
            <svg v-else viewBox="0 0 24 24" aria-hidden="true"><path d="m8 5 11 7-11 7z" /></svg>
          </button>
          <button type="button" aria-label="Próxima faixa" :disabled="!track.canGoNext" @click="emit('next')">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 5 9 7-9 7zm10 0h2v14h-2z" /></svg>
          </button>
        </div>
      </div>
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
