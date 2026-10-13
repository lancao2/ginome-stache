<script setup lang="ts">
import { computed, useId } from "vue";

export type Lid = "open" | "half" | "closed" | "happy" | "angry" | "sad";

const props = defineProps<{
  cx: number; cy: number; r: number;
  /** Direção do olhar, de -1 a 1 em cada eixo. */
  gx: number; gy: number;
  lid: Lid;
  /** Cor da pálpebra: a da pele em volta do olho. */
  skin: string;
  /** Olho esquerdo (-1) ou direito (1): inverte a inclinação das pálpebras. */
  side: -1 | 1;
}>();

const clipId = `pet-eye-${useId().replace(/:/g, "")}`;

// A pálpebra é um retângulo cuja borda inferior passa pelo centro do olho; só se move e gira,
// o que o WebKitGTK anima sem problemas (formas de path não animam).
const lidStyle = computed(() => {
  const r = props.r;
  const slant = props.side === -1 ? 1 : -1;
  const table: Record<Lid, string> = {
    open: `translateY(${-r - 4}px) rotate(0deg)`,
    half: `translateY(${-r * 0.1}px) rotate(0deg)`,
    closed: `translateY(${r + 1}px) rotate(0deg)`,
    happy: `translateY(${r + 1}px) rotate(0deg)`,
    angry: `translateY(${-r * 0.2}px) rotate(${22 * slant}deg)`,
    sad: `translateY(${-r * 0.15}px) rotate(${-20 * slant}deg)`,
  };
  return { transform: table[props.lid] };
});

const pupilStyle = computed(() => {
  const reach = props.r * 0.5;
  return { transform: `translate(${props.gx * reach}px, ${props.gy * reach}px)` };
});
</script>

<template>
  <g class="pet-eye" :transform="`translate(${cx} ${cy})`">
    <clipPath :id="clipId"><ellipse :rx="r" :ry="r * 1.18" /></clipPath>
    <g class="pet-eye__blink">
      <ellipse class="pet-eye__white" :class="{ 'is-shut': lid === 'closed' || lid === 'happy' }" :rx="r" :ry="r * 1.18" />
      <g :clip-path="`url(#${clipId})`">
        <g class="pet-eye__pupil" :style="pupilStyle">
          <ellipse :rx="r * 0.48" :ry="r * 0.66" fill="#17202b" />
          <ellipse :cx="-r * 0.14" :cy="-r * 0.26" :rx="r * 0.16" :ry="r * 0.22" fill="#fff" />
        </g>
        <rect class="pet-eye__lid" :x="-r - 3" :y="-2 * r - 8" :width="2 * r + 6" :height="2 * r + 8" :fill="skin" :style="lidStyle" />
      </g>
      <!-- Olho fechado vira um traço (relaxado) ou um arco (feliz). -->
      <path class="pet-eye__line" :class="{ 'is-on': lid === 'closed' }" :d="`M${-r * 0.7} 0 Q0 ${r * 0.45} ${r * 0.7} 0`" />
      <!-- Olho feliz: arco para cima. -->
      <path class="pet-eye__line" :class="{ 'is-on': lid === 'happy' }" :d="`M${-r * 0.7} ${r * 0.25} Q0 ${-r * 0.55} ${r * 0.7} ${r * 0.25}`" />
    </g>
  </g>
</template>

<style>
.pet-eye__white { fill: #fff; stroke: rgba(75, 80, 105, 0.16); stroke-width: 0.8; filter: drop-shadow(0 2px 2px rgba(55, 65, 100, 0.22)); transition: stroke 160ms; }
.pet-eye__white.is-shut { stroke: transparent; }
.pet-eye__pupil { transition: transform 220ms cubic-bezier(0.3, 0.7, 0.2, 1); }
.pet-eye__lid { transition: transform 260ms cubic-bezier(0.3, 0.7, 0.2, 1); transform-origin: 0 0; }
.pet-eye__line { fill: none; stroke: #30384a; stroke-width: 2.6; stroke-linecap: round; opacity: 0; transition: opacity 160ms; }
.pet-eye__line.is-on { opacity: 1; }
.pet-eye__blink { transform-box: fill-box; transform-origin: 50% 50%; animation: pet-blink 5.2s infinite; }
@keyframes pet-blink {
  0%, 93%, 100% { transform: scaleY(1); }
  95.5% { transform: scaleY(0.08); }
}
</style>
