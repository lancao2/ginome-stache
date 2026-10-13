<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from "vue";

const props = defineProps<{ src: string; seconds?: number }>();
const audio = ref<HTMLAudioElement | null>(null);
const playing = ref(false);
const current = ref(0);
const total = ref(props.seconds ?? 0);
const failed = ref(false);

const progress = computed(() => (total.value ? Math.min(1, current.value / total.value) : 0));
const format = (value: number) => `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, "0")}`;

async function toggle() {
  const element = audio.value;
  if (!element) return;
  if (playing.value) return element.pause();
  try { await element.play(); } catch { failed.value = true; }
}
function readDuration() {
  const element = audio.value;
  if (element && Number.isFinite(element.duration) && element.duration > 0) total.value = element.duration;
}
function seek(event: MouseEvent) {
  const element = audio.value;
  if (!element || !total.value) return;
  const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
  element.currentTime = ((event.clientX - box.left) / box.width) * total.value;
}
onBeforeUnmount(() => audio.value?.pause());
</script>

<template>
  <div class="wa-audio">
    <audio
      ref="audio" :src="src" preload="metadata"
      @play="playing = true" @pause="playing = false" @ended="playing = false; current = 0"
      @timeupdate="current = audio?.currentTime ?? 0"
      @loadedmetadata="readDuration"
      @error="failed = true"
    />
    <button type="button" class="wa-audio-btn" :aria-label="playing ? 'Pausar' : 'Reproduzir'" :disabled="failed" @click="toggle">
      <svg v-if="playing" viewBox="0 0 24 24"><path d="M7 5h3v14H7zm7 0h3v14h-3z" /></svg>
      <svg v-else viewBox="0 0 24 24"><path d="m8 5 11 7-11 7z" /></svg>
    </button>
    <div v-if="!failed" class="wa-audio-bar" @click.stop="seek"><span :style="{ transform: `scaleX(${progress})` }" /></div>
    <span v-if="!failed" class="wa-audio-time">{{ format(playing || current ? current : total) }}</span>
    <span v-else class="wa-audio-time">Não foi possível reproduzir</span>
  </div>
</template>
