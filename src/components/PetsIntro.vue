<script setup lang="ts">
import { onBeforeUnmount, onMounted, reactive, ref } from "vue";

import { playPetSound } from "../composables/petSound";
import { INTRO_VERSION } from "../composables/usePetsIntro";
import { PET_IDS, PROFILES, type PetId, type PetState } from "../pets/data";
import PetSprite from "./PetSprite.vue";

const emit = defineEmits<{ done: [showPets: boolean] }>();

// Linha do tempo (ms desde a abertura): título, um mascote por vez e, por fim, os botões.
const TIMELINE = { title: 500, tick: 1400, papo: 3100, work: 4800, finale: 6700 } as const;
const AUTO_CLOSE_MS = 45_000;

const shown = reactive<Record<PetId, boolean>>({ tick: false, papo: false, work: false });
const states = reactive<Record<PetId, PetState>>({ tick: "falando", papo: "falando", work: "falando" });
const title = ref(false);
const finale = ref(false);
const timers: number[] = [];
const later = (ms: number, run: () => void) => { timers.push(window.setTimeout(run, ms)); };

function introduce(id: PetId, at: number) {
  later(at, () => {
    shown[id] = true;
    playPetSound("pop");
  });
  // Fala enquanto se apresenta e depois relaxa.
  later(at + 1900, () => { states[id] = "parado"; });
}

onMounted(() => {
  window.addEventListener("keydown", onKey);
  later(TIMELINE.title, () => { title.value = true; playPetSound("greet"); });
  introduce("tick", TIMELINE.tick);
  introduce("papo", TIMELINE.papo);
  introduce("work", TIMELINE.work);
  later(TIMELINE.finale, () => {
    finale.value = true;
    for (const id of PET_IDS) states[id] = "feliz";
  });
  later(AUTO_CLOSE_MS, () => emit("done", false));
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKey);
  timers.forEach((timer) => window.clearTimeout(timer));
});

function onKey(event: KeyboardEvent) {
  if (event.key === "Escape") emit("done", false);
}
</script>

<template>
  <section class="island island--expanded island--intro" role="dialog" aria-label="Apresentação dos mascotes do Stache" aria-live="polite">
    <div class="intro-view">
      <button type="button" class="intro-skip" @click="emit('done', false)">Pular</button>

      <header class="intro-head" :class="{ 'is-in': title }">
        <span class="intro-pill">Stache {{ INTRO_VERSION }}</span>
        <h1>Conheça seus novos mascotes</h1>
      </header>

      <div class="intro-stage">
        <div v-for="id in PET_IDS" :key="id" class="intro-slot" :class="{ 'is-in': shown[id] }">
          <template v-if="shown[id]">
            <p class="intro-bubble">{{ PROFILES[id].apresentacao }}</p>
            <div class="intro-pet">
              <PetSprite :pet="id" :state="states[id]" :size="100" />
              <span class="intro-spark intro-spark--1">✦</span>
              <span class="intro-spark intro-spark--2">✦</span>
              <span class="intro-spark intro-spark--3">✦</span>
            </div>
            <p class="intro-name"><strong>{{ PROFILES[id].nome }}</strong><small>{{ PROFILES[id].papel }}</small></p>
          </template>
        </div>
      </div>

      <footer class="intro-foot" :class="{ 'is-in': finale }">
        <p>Eles têm fome, humor e personalidade. Cuide deles e peça ajuda no dia a dia, tudo pelo Codex.</p>
        <div class="intro-actions">
          <button type="button" class="is-primary" :disabled="!finale" @click="emit('done', true)">Conhecer os mascotes</button>
          <button type="button" :disabled="!finale" @click="emit('done', false)">Agora não</button>
        </div>
      </footer>
    </div>
  </section>
</template>

<style>
.island--expanded.island--intro { height: 300px; cursor: default; }
.intro-view { position: absolute; inset: 0; display: flex; flex-direction: column; padding: 14px 18px 12px; }
.intro-skip { position: absolute; top: 10px; right: 16px; font-size: 10.5px; color: rgba(255, 255, 255, 0.45); }
.intro-skip:hover { color: #fff; }
.intro-head { display: flex; flex-direction: column; align-items: center; gap: 5px; opacity: 0; transform: translateY(-8px); transition: opacity 500ms ease, transform 500ms cubic-bezier(0.32, 0.72, 0, 1); }
.intro-head.is-in { opacity: 1; transform: none; }
.intro-pill { padding: 2px 10px; border-radius: 10px; font-size: 10px; font-weight: 700; letter-spacing: 0.08em; color: #06122f; background: linear-gradient(90deg, #7dbaff, #54e4ff); }
.intro-head h1 { margin: 0; font-size: 17px; font-weight: 700; letter-spacing: -0.01em; }
.intro-stage { flex: 1; min-height: 0; display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-top: 6px; }
.intro-slot { display: flex; flex-direction: column; align-items: center; justify-content: flex-end; gap: 2px; min-width: 0; }
.intro-bubble { position: relative; margin: 0; max-width: 158px; padding: 5px 9px; border-radius: 12px; font-size: 10px; line-height: 1.3; text-align: center; color: rgba(255, 255, 255, 0.92); background: rgba(255, 255, 255, 0.12); animation: intro-bubble 420ms 260ms cubic-bezier(0.34, 1.56, 0.64, 1) backwards; }
.intro-bubble::after { content: ""; position: absolute; left: 50%; bottom: -4px; width: 8px; height: 8px; margin-left: -4px; background: inherit; transform: rotate(45deg); }
.intro-pet { position: relative; animation: intro-arrive 620ms cubic-bezier(0.22, 1, 0.36, 1) backwards; }
.intro-name { margin: 0; display: flex; flex-direction: column; align-items: center; animation: intro-bubble 400ms 420ms ease backwards; }
.intro-name strong { font-size: 13px; }
.intro-name small { font-size: 10px; color: rgba(255, 255, 255, 0.55); }
.intro-spark { position: absolute; top: 50%; left: 50%; font-size: 11px; color: #70ddff; opacity: 0; pointer-events: none; animation: intro-spark 900ms 120ms ease-out backwards; }
.intro-spark--1 { --dx: -52px; --dy: -34px; }
.intro-spark--2 { --dx: 54px; --dy: -22px; animation-delay: 200ms; }
.intro-spark--3 { --dx: 6px; --dy: -58px; animation-delay: 300ms; }
.intro-foot { display: flex; align-items: center; justify-content: space-between; gap: 14px; margin-top: 6px; opacity: 0; transform: translateY(8px); transition: opacity 450ms ease, transform 450ms cubic-bezier(0.32, 0.72, 0, 1); }
.intro-foot.is-in { opacity: 1; transform: none; }
.intro-foot p { margin: 0; flex: 1; font-size: 10.5px; line-height: 1.35; color: rgba(255, 255, 255, 0.62); }
.intro-actions { display: flex; gap: 6px; }
.intro-actions button { padding: 6px 12px; border-radius: 14px; font-size: 11px; font-weight: 600; white-space: nowrap; background: rgba(255, 255, 255, 0.12); }
.intro-actions button.is-primary { color: #06122f; background: linear-gradient(90deg, #8fbaff, #67e5ff); }
.intro-actions button:disabled { pointer-events: none; }
@keyframes intro-arrive {
  from { opacity: 0; transform: translateY(10px) scale(0.94); }
  to { opacity: 1; transform: none; }
}
@keyframes intro-bubble { from { opacity: 0; transform: translateY(6px) scale(0.85); } to { opacity: 1; transform: none; } }
@keyframes intro-spark {
  0% { opacity: 0; transform: translate(-50%, -50%) scale(0.2); }
  30% { opacity: 1; }
  100% { opacity: 0; transform: translate(calc(-50% + var(--dx)), calc(-50% + var(--dy))) scale(1.3) rotate(90deg); }
}
@media (prefers-reduced-motion: reduce) {
  .intro-pet, .intro-bubble, .intro-name, .intro-spark { animation: none; }
  .intro-head, .intro-foot { transition: opacity 200ms; transform: none; }
}
</style>
