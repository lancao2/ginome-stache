<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, useId, watch } from "vue";

import { usePointer } from "../composables/usePointer";
import type { PetId, PetState } from "../pets/data";
import PetEye, { type Lid } from "./PetEye.vue";

// Personagens abstratos: silhuetas macias, olhos grandes e sem anatomia animal. A expressão vem
// das pálpebras, do olhar e de movimentos sutis do corpo.
const props = withDefaults(defineProps<{
  pet: PetId;
  state: PetState;
  size?: number;
  /** Sem adereços (balões, notas, gotas): para tamanhos pequenos. */
  compact?: boolean;
  /** Segue o mouse com os olhos; sem isso (ou sem mouse) ele passeia o olhar. */
  follow?: boolean;
}>(), { size: 96, compact: false, follow: true });

interface Face { lid: Lid; /** Olhar fixo do estado (só quando não segue o mouse). */ gaze?: { x: number; y: number }; follow: boolean }

const FACES: Record<PetState, Face> = {
  parado: { lid: "open", follow: true },
  pensando: { lid: "open", gaze: { x: 0.6, y: -0.8 }, follow: false },
  fome: { lid: "open", follow: true },
  raiva: { lid: "angry", follow: true },
  entediado: { lid: "half", follow: true },
  triste: { lid: "sad", follow: true },
  feliz: { lid: "open", follow: true },
  musica: { lid: "happy", follow: false },
  dormindo: { lid: "closed", follow: false },
  comendo: { lid: "happy", follow: false },
  banho: { lid: "happy", follow: false },
  brincando: { lid: "open", follow: true },
  trabalhando: { lid: "half", gaze: { x: 0, y: 0.5 }, follow: false },
  falando: { lid: "open", follow: true },
};

const face = computed(() => FACES[props.state]);

// Olhar: segue o mouse (na tela toda, quando a extensão do GNOME informa a posição); sem mouse,
// passeia sozinho. Estados como pensar ou dormir mandam no olhar.
const root = ref<SVGSVGElement | null>(null);
const { pointer, acquire, release } = usePointer();
const mouse = ref<{ x: number; y: number } | null>(null);
const wander = ref({ x: 0, y: 0 });
let wanderTimer: number | undefined;

function aim() {
  const element = root.value;
  if (!props.follow || !pointer.value || !element) { mouse.value = null; return; }
  const box = element.getBoundingClientRect();
  const dx = pointer.value.x - (box.left + box.width / 2);
  const dy = pointer.value.y - (box.top + box.height / 2);
  const dist = Math.hypot(dx, dy) || 1;
  // Perto do mascote o olhar desvia menos; longe, vai até o limite do olho.
  const pull = Math.min(1, dist / Math.max(24, box.width * 0.7));
  mouse.value = { x: (dx / dist) * pull, y: (dy / dist) * pull };
}

function glance() {
  const slow = props.state === "entediado";
  wander.value = Math.random() < 0.28 ? { x: 0, y: 0 } : { x: (Math.random() * 2 - 1) * 0.9, y: (Math.random() * 2 - 1) * 0.55 };
  wanderTimer = window.setTimeout(glance, (slow ? 3000 : 1300) + Math.random() * (slow ? 3500 : 2800));
}

watch(pointer, aim);
watch(() => props.follow, aim);

onMounted(() => {
  acquire();
  aim();
  glance();
});
onBeforeUnmount(() => {
  release();
  window.clearTimeout(wanderTimer);
});

const gaze = computed(() => {
  if (!face.value.follow && !face.value.gaze) return { x: 0, y: 0 };
  if (face.value.follow && mouse.value) return mouse.value;
  return face.value.gaze ?? wander.value;
});

// O rosto inteiro se desloca um pouco para o lado do olhar, o que dá a sensação de virar a cabeça.
const faceStyle = computed(() => ({ transform: `translate(${gaze.value.x * 2.4}px, ${gaze.value.y * 1.8}px)` }));

const PALETTE: Record<PetId, { light: string; mid: string; dark: string; accent: string }> = {
  tick: { light: "#bceeff", mid: "#69c8f4", dark: "#8f9ff1", accent: "#f29ac7" },
  papo: { light: "#fff7b0", mid: "#ffd95f", dark: "#f6ad72", accent: "#ef9fc9" },
  work: { light: "#f5f7fb", mid: "#cbd3df", dark: "#9daec6", accent: "#b6a6e7" },
};
const palette = computed(() => PALETTE[props.pet]);
const skin = computed(() => palette.value.mid);

const gradientId = `pet-surface-${useId().replace(/:/g, "")}`;
</script>

<template>
  <svg
    ref="root"
    class="pet"
    :class="[`pet--${pet}`, { 'pet--compact': compact }]"
    :data-state="state"
    viewBox="-12 -14 124 128"
    :width="size"
    :height="size * (128 / 124)"
    role="img"
    :aria-label="pet"
  >
    <defs>
      <linearGradient :id="gradientId" x1="0" y1="0" x2="0.8" y2="1">
        <stop offset="0" :stop-color="palette.light" />
        <stop offset="0.38" :stop-color="palette.mid" />
        <stop offset="0.72" :stop-color="palette.dark" />
        <stop offset="1" :stop-color="palette.accent" />
      </linearGradient>
    </defs>
    <ellipse class="pet-shadow" cx="50" cy="97" rx="26" ry="4" />

    <!-- TICK: forma orgânica azul, inspirada na massa macia da referência -->
    <g v-if="pet === 'tick'" class="pet-body">
      <path class="pet-surface" :fill="`url(#${gradientId})`" d="M16 51 C8 39 17 25 31 26 C37 12 58 9 68 22 C83 20 94 32 90 46 C101 55 96 72 83 76 C82 91 66 100 53 93 C42 104 24 96 24 82 C10 78 5 62 16 51 Z" />
      <path class="pet-shine" d="M29 32 Q43 18 59 22" />
      <g class="pet-face" :style="faceStyle">
        <PetEye :cx="36" :cy="56" :r="11.5" :gx="gaze.x" :gy="gaze.y" :lid="face.lid" :skin="skin" :side="-1" />
        <PetEye :cx="64" :cy="56" :r="11.5" :gx="gaze.x" :gy="gaze.y" :lid="face.lid" :skin="skin" :side="1" />
      </g>
    </g>

    <!-- PAPO: triângulo arredondado amarelo -->
    <g v-else-if="pet === 'papo'" class="pet-body">
      <path class="pet-surface" :fill="`url(#${gradientId})`" d="M41 15 C46 6 55 6 60 15 L96 80 C102 91 94 100 82 99 L18 99 C6 100 -2 91 4 80 Z" />
      <path class="pet-shine" d="M41 27 Q49 17 57 27" />
      <g class="pet-face" :style="faceStyle">
        <PetEye :cx="36" :cy="65" :r="11.5" :gx="gaze.x" :gy="gaze.y" :lid="face.lid" :skin="skin" :side="-1" />
        <PetEye :cx="64" :cy="65" :r="11.5" :gx="gaze.x" :gy="gaze.y" :lid="face.lid" :skin="skin" :side="1" />
      </g>
    </g>

    <!-- WORK: quadrado cinza rotacionado, com cantos macios -->
    <g v-else class="pet-body">
      <path class="pet-surface" :fill="`url(#${gradientId})`" d="M50 6 C57 6 61 12 67 18 L82 33 C93 44 93 56 82 67 L67 82 C56 93 44 93 33 82 L18 67 C7 56 7 44 18 33 L33 18 C39 12 43 6 50 6 Z" />
      <path class="pet-shine" d="M26 36 L39 23 Q48 14 57 21" />
      <g class="pet-face" :style="faceStyle">
        <PetEye :cx="35" :cy="56" :r="11.5" :gx="gaze.x" :gy="gaze.y" :lid="face.lid" :skin="skin" :side="-1" />
        <PetEye :cx="65" :cy="56" :r="11.5" :gx="gaze.x" :gy="gaze.y" :lid="face.lid" :skin="skin" :side="1" />
      </g>
    </g>

    <!-- Adereços por estado (escondidos no tamanho compacto). -->
    <g v-if="!compact" class="pet-props">
      <g class="prop prop-think"><circle cx="86" cy="12" r="3.4" /><circle cx="94" cy="4" r="4.6" /><circle cx="104" cy="-4" r="6" /></g>
      <path class="prop prop-tear" d="M26 66 Q23 72 26 75 Q29 72 26 66 Z" />
      <g class="prop prop-steam"><path d="M20 28 q-6 -6 0 -12 q6 -6 0 -12" /><path d="M80 28 q6 -6 0 -12 q-6 -6 0 -12" /></g>
      <g class="prop prop-anger"><path d="M82 8 l6 6 M88 8 l-6 6 M84 4 q4 -2 8 0 M80 16 q-2 4 0 8" /></g>
      <g class="prop prop-notes"><text x="88" y="24">♪</text><text x="2" y="30">♫</text></g>
      <g class="prop prop-zzz"><text x="80" y="22">z</text><text x="90" y="10">Z</text></g>
      <g class="prop prop-bubbles"><circle cx="16" cy="30" r="5" /><circle cx="88" cy="22" r="4" /><circle cx="76" cy="6" r="3" /><circle cx="26" cy="12" r="3.4" /></g>
      <g class="prop prop-hearts"><text x="82" y="20">♥</text></g>
      <g class="prop prop-crumbs"><circle cx="32" cy="84" r="1.8" /><circle cx="66" cy="88" r="1.6" /><circle cx="52" cy="92" r="1.8" /></g>
      <g class="prop prop-ball"><circle cx="92" cy="86" r="7" /><path d="M85 86 Q92 80 99 86" /></g>
      <g class="prop prop-growl"><path d="M38 84 q3 -3 6 0 t6 0 t6 0 t6 0" /></g>
      <g class="prop prop-talk"><circle cx="38" cy="82" r="2.6" /><circle cx="50" cy="82" r="2.6" /><circle cx="62" cy="82" r="2.6" /></g>
    </g>
  </svg>
</template>

<style>
.pet { display: block; overflow: visible; --pet-ink: #202536; }
.pet-shadow { fill: rgba(80, 98, 150, 0.18); transform-box: fill-box; transform-origin: 50% 50%; filter: blur(3px); }
.pet-body { transform-box: fill-box; transform-origin: 50% 100%; filter: drop-shadow(0 5px 5px rgba(74, 92, 142, 0.16)); }
.pet-face { transition: transform 200ms cubic-bezier(0.3, 0.7, 0.2, 1); }
.pet-surface { stroke: rgba(255, 255, 255, 0.3); stroke-width: 0.8; }
.pet-shine { fill: none; stroke: rgba(255, 255, 255, 0.38); stroke-width: 5; stroke-linecap: round; filter: blur(1px); pointer-events: none; }
.pet-foot { stroke: none; }
.pet--tick .pet-foot { fill: #819eea; }
.pet--papo .pet-foot { fill: #e9a94e; }
.pet--work .pet-foot { fill: #a9b4c5; }

/* Respiração e movimento por estado. */
.pet[data-state="parado"] .pet-body { animation: pet-breathe 3.6s ease-in-out infinite; }
.pet[data-state="pensando"] .pet-body { animation: pet-tilt 2.4s ease-in-out infinite alternate; }
.pet[data-state="fome"] .pet-body { animation: pet-rumble 2.8s ease-in-out infinite; }
.pet[data-state="raiva"] .pet-body { animation: pet-tense 2s ease-in-out infinite; }
.pet[data-state="entediado"] .pet-body { animation: pet-sway 4.4s ease-in-out infinite; }
.pet[data-state="triste"] .pet-body { animation: pet-droop 3.2s ease-in-out infinite; }
.pet[data-state="feliz"] .pet-body { animation: pet-pleased 2.8s ease-in-out infinite; }
.pet[data-state="musica"] .pet-body { animation: pet-groove 1.8s ease-in-out infinite; }
.pet[data-state="dormindo"] .pet-body { animation: pet-breathe 5.2s ease-in-out infinite; }
.pet[data-state="comendo"] .pet-body { animation: pet-nod 1.3s ease-in-out infinite; }
.pet[data-state="banho"] .pet-body { animation: pet-wiggle 2.4s ease-in-out infinite; }
.pet[data-state="brincando"] .pet-body { animation: pet-play 1.9s ease-in-out infinite; }
.pet[data-state="trabalhando"] .pet-body { animation: pet-focus 2.2s ease-in-out infinite; }
.pet[data-state="falando"] .pet-body { animation: pet-talk 1.4s ease-in-out infinite; }

/* Adereços. */
.prop { opacity: 0; fill: none; transform-box: fill-box; }
.prop-think circle { fill: #fff; stroke: rgba(0, 0, 0, 0.25); stroke-width: 1; }
.prop-tear { fill: #6cc4ff; }
.prop-steam path { stroke: #ff8a7a; stroke-width: 3; stroke-linecap: round; }
.prop-anger path { stroke: #ff453a; stroke-width: 2.6; stroke-linecap: round; }
.prop-notes text, .prop-zzz text, .prop-hearts text { fill: #fff; font: 700 14px Inter, sans-serif; }
.prop-hearts text { fill: #ff5d73; }
.prop-bubbles circle { fill: rgba(190, 235, 255, 0.55); stroke: #fff; stroke-width: 1.4; }
.prop-crumbs circle { fill: #e8c07a; }
.prop-ball circle { fill: #ff5d73; stroke: #fff; stroke-width: 1.4; }
.prop-ball path { stroke: #fff; stroke-width: 1.4; }
.prop-growl path { stroke: rgba(255, 255, 255, 0.7); stroke-width: 2.2; stroke-linecap: round; }
.prop-talk circle { fill: #fff; }

.pet[data-state="pensando"] .prop-think { opacity: 1; animation: prop-pop 1.8s ease-in-out infinite; }
.pet[data-state="pensando"] .prop-think circle:nth-child(2) { animation: prop-dot 1.8s 0.2s ease-in-out infinite; }
.pet[data-state="triste"] .prop-tear { opacity: 1; animation: prop-tear 2.2s ease-in infinite; }
.pet[data-state="raiva"] .prop-steam { opacity: 1; animation: prop-steam 0.9s ease-in-out infinite; }
.pet[data-state="raiva"] .prop-anger { opacity: 1; animation: prop-pop 0.5s ease-in-out infinite; }
.pet[data-state="musica"] .prop-notes { opacity: 1; animation: prop-float 1.6s ease-in-out infinite; }
.pet[data-state="dormindo"] .prop-zzz { opacity: 1; animation: prop-float 2.6s ease-in-out infinite; }
.pet[data-state="banho"] .prop-bubbles { opacity: 1; animation: prop-float 1.8s ease-in-out infinite; }
.pet[data-state="feliz"] .prop-hearts { opacity: 1; animation: prop-float 1.8s ease-in-out infinite; }
.pet[data-state="comendo"] .prop-crumbs { opacity: 1; animation: prop-crumb 0.42s ease-in infinite; }
.pet[data-state="brincando"] .prop-ball { opacity: 1; animation: prop-bounce 0.7s ease-in infinite; }
.pet[data-state="fome"] .prop-growl { opacity: 0.9; animation: prop-pop 0.9s ease-in-out infinite; }
.pet[data-state="falando"] .prop-talk { opacity: 1; }
.pet[data-state="falando"] .prop-talk circle { animation: prop-dot 0.9s ease-in-out infinite; }
.pet[data-state="falando"] .prop-talk circle:nth-child(2) { animation-delay: 0.15s; }
.pet[data-state="falando"] .prop-talk circle:nth-child(3) { animation-delay: 0.3s; }

@keyframes pet-breathe { 0%, 100% { transform: scale(1, 1); } 50% { transform: scale(1.015, 1.035); } }
@keyframes pet-tilt { from { transform: rotate(-3deg); } to { transform: rotate(3deg); } }
@keyframes pet-rumble { 0%, 72%, 100% { transform: scale(1); } 82% { transform: scale(1.018, 0.985); } 90% { transform: scale(0.99, 1.012); } }
@keyframes pet-tense { 0%, 100% { transform: rotate(-1deg) scale(1.01, 0.99); } 50% { transform: rotate(1deg) scale(1.018, 0.985); } }
@keyframes pet-sway { 0%, 100% { transform: rotate(-3deg) scaleY(0.97); } 50% { transform: rotate(3deg) scaleY(0.95); } }
@keyframes pet-droop { 0%, 100% { transform: translateY(3px) scale(1, 0.94); } 50% { transform: translateY(4px) scale(1.01, 0.92); } }
@keyframes pet-pleased { 0%, 100% { transform: rotate(-1.5deg) scale(1); } 50% { transform: rotate(1.5deg) scale(1.018); } }
@keyframes pet-groove { 0%, 100% { transform: rotate(-3deg); } 50% { transform: rotate(3deg); } }
@keyframes pet-nod { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(3px); } }
@keyframes pet-wiggle { 0%, 100% { transform: rotate(-4deg); } 50% { transform: rotate(4deg); } }
@keyframes pet-play { 0%, 100% { transform: rotate(-3deg) scale(1); } 50% { transform: rotate(3deg) scale(1.015); } }
@keyframes pet-focus { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.012, 1.02); } }
@keyframes pet-talk { 0%, 100% { transform: rotate(-1deg); } 50% { transform: rotate(1deg); } }
@keyframes prop-pop { 0%, 100% { transform: scale(0.94); } 50% { transform: scale(1.06); } }
@keyframes prop-dot { 0%, 100% { opacity: 0.4; } 50% { opacity: 1; } }
@keyframes prop-tear { 0% { transform: translateY(0); opacity: 0; } 20% { opacity: 1; } 100% { transform: translateY(14px); opacity: 0; } }
@keyframes prop-steam { 0%, 100% { transform: translateY(0); opacity: 0.9; } 50% { transform: translateY(-4px); opacity: 0.45; } }
@keyframes prop-float { 0% { transform: translateY(6px); opacity: 0; } 30% { opacity: 1; } 100% { transform: translateY(-8px); opacity: 0; } }
@keyframes prop-crumb { 0% { transform: translateY(-4px); opacity: 1; } 100% { transform: translateY(8px); opacity: 0; } }
@keyframes prop-bounce { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-22px); } }

@media (prefers-reduced-motion: reduce) {
  .pet *, .pet-eye__blink { animation: none !important; }
}
</style>
