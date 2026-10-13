<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";

import { PET_IDS, type PetId } from "../pets/data";
import { needsCare } from "../pets/engine";
import { usePets } from "../composables/usePets";
import { usePetAbsence } from "../composables/usePetAbsence";
import PetSprite from "./PetSprite.vue";

// Um mascote espia ao lado da ilha recolhida de vez em quando. Quem precisa de cuidado aparece mais.
const props = defineProps<{ offset: number; hidden: boolean }>();

const SIZE = 28;
const FIRST_MS = 12_000;
const VISIBLE_MS = 7_500;

const { states } = usePets();
const { isAway } = usePetAbsence();
const current = ref<{ pet: PetId; side: "left" | "right" } | null>(null);
let waitTimer: number | undefined;
let hideTimer: number | undefined;

const anyNeedy = computed(() => PET_IDS.some((id) => needsCare(states.value[id])));

function pickPet(): PetId {
  const weights = PET_IDS.map((id) => (needsCare(states.value[id]) ? 3 : 1));
  let roll = Math.random() * weights.reduce((sum, weight) => sum + weight, 0);
  for (let index = 0; index < PET_IDS.length; index += 1) {
    roll -= weights[index];
    if (roll <= 0) return PET_IDS[index];
  }
  return PET_IDS[0];
}

function schedule(first = false) {
  window.clearTimeout(waitTimer);
  const [min, max] = anyNeedy.value ? [20_000, 50_000] : [50_000, 130_000];
  waitTimer = window.setTimeout(show, first ? FIRST_MS : min + Math.random() * (max - min));
}

function show() {
  // Com a ilha aberta ou um aviso na cápsula, espera a próxima vez.
  // Sem tokens os mascotes saíram: ninguém espia até a volta.
  if (props.hidden || document.hidden || isAway.value) { schedule(); return; }
  current.value = { pet: pickPet(), side: Math.random() < 0.5 ? "left" : "right" };
  hideTimer = window.setTimeout(() => { current.value = null; schedule(); }, VISIBLE_MS);
}

// Voltaram da ausência: um deles aparece logo, sem esperar o sorteio.
watch(isAway, (away) => {
  if (away) return;
  window.clearTimeout(waitTimer);
  waitTimer = window.setTimeout(show, 1_500);
});

watch([() => props.hidden, isAway], ([hidden, away]) => {
  if (!(hidden || away) || !current.value) return;
  window.clearTimeout(hideTimer);
  current.value = null;
  schedule();
});

onMounted(() => schedule(true));
onBeforeUnmount(() => { window.clearTimeout(waitTimer); window.clearTimeout(hideTimer); });

const style = computed(() => {
  const side = current.value?.side;
  const gap = `${props.offset + 26}px`;
  return side === "left" ? { right: `calc(50% + ${gap})` } : { left: `calc(50% + ${gap})` };
});
</script>

<template>
  <Transition name="pet-peek">
    <div v-if="current && !hidden && !isAway" :key="`${current.pet}-${current.side}`" class="pet-peek" :class="`pet-peek--${current.side}`" :style="style" aria-hidden="true">
      <PetSprite :pet="current.pet" :state="states[current.pet]" :size="SIZE" compact />
    </div>
  </Transition>
</template>

<style>
.pet-peek { position: absolute; top: 2px; width: 28px; height: 28px; pointer-events: none; }
.pet-peek-enter-active { transition: transform 520ms cubic-bezier(0.34, 1.56, 0.64, 1), opacity 240ms ease; }
.pet-peek-leave-active { transition: transform 360ms cubic-bezier(0.5, 0, 0.8, 0.4), opacity 260ms ease; }
.pet-peek--left.pet-peek-enter-from, .pet-peek--left.pet-peek-leave-to { transform: translateX(34px) scale(0.6); opacity: 0; }
.pet-peek--right.pet-peek-enter-from, .pet-peek--right.pet-peek-leave-to { transform: translateX(-34px) scale(0.6); opacity: 0; }
@media (prefers-reduced-motion: reduce) { .pet-peek-enter-active, .pet-peek-leave-active { transition: opacity 200ms; } }
</style>
