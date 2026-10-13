<script setup lang="ts">
import IslandPlayer from "./components/IslandPlayer.vue";
import IslandAlert from "./components/IslandAlert.vue";
import IslandClock from "./components/IslandClock.vue";
import CaptureDots from "./components/CaptureDots.vue";
import PetPeek from "./components/PetPeek.vue";
import PetsIntro from "./components/PetsIntro.vue";
import { useIsland } from "./composables/useIsland";

const island = useIsland();
</script>

<template>
  <main class="app-shell" @pointerdown.self="island.collapse">
    <div class="scale-root" :style="{ transform: `scale(${island.scale.value})` }">
    <Transition name="island-swap" mode="out-in">
      <PetsIntro v-if="island.intro.value" key="intro" @done="island.finishIntro" />
      <IslandAlert
        v-else-if="island.alert.value && !island.expanded.value"
        key="alert"
        :item="island.alert.value"
        @hover-enter="island.hoverEnter"
        @hover-leave="island.hoverLeave"
        @open="island.openAlert"
      />
      <IslandPlayer
        v-else-if="island.active.value && island.currentTrack.value"
        key="player"
        :expanded="island.expanded.value"
        :tab="island.tab.value"
        :tall="island.tall.value"
        :controls-open="island.controlsOpen.value"
        @toggle-controls="island.toggleControls()"
        :track="island.currentTrack.value"
        :playing="island.playing.value"
        :elapsed="island.elapsed.value"
        :progress="island.progress.value"
        @toggle="island.toggle"
        @hover-enter="island.hoverEnter"
        @hover-leave="island.hoverLeave"
        @play-pause="island.togglePlayback"
        @next="island.next"
        @previous="island.previous"
        @select-tab="island.selectTab"
      />
      <IslandClock
        v-else
        key="clock"
        :now="island.now.value"
        @hover-enter="island.hoverEnter"
        @hover-leave="island.hoverLeave"
        :has-media="Boolean(island.currentTrack.value)"
        :controls-open="island.controlsOpen.value"
        @toggle-controls="island.toggleControls()"
        @select-tab="island.selectTab"
        @toggle="island.toggle"
        :expanded="island.expanded.value"
        :tab="island.tab.value"
      />
    </Transition>
    <!-- Metade da ilha + orelha (14px) + 3px de respiro. -->
    <CaptureDots :offset="island.baseWidth.value / 2 + 17" :hold="island.pendingCapture.value" />
    <PetPeek :offset="island.baseWidth.value / 2 + 17" :hidden="island.expanded.value || Boolean(island.alert.value)" />
    </div>
  </main>
</template>
