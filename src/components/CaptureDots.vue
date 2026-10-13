<script setup lang="ts">
import { onMounted } from "vue";

import { useCapture } from "../composables/useCapture";

const props = defineProps<{ offset: number; hold: string[] }>();
// Enquanto o aviso da captura está na cápsula, a pílula espera.
const shown = (kind: string, apps: string[]) => apps.length > 0 && !props.hold.includes(kind);
const { mic, camera, screen, start } = useCapture();
onMounted(() => void start());
</script>

<template>
  <!-- Microfone à esquerda da cápsula; câmera e tela à direita. Ícones sempre brancos. -->
  <div class="capture-dots capture-dots--left" :style="{ right: `calc(50% + ${offset}px)` }" role="status" aria-live="polite">
    <span v-if="shown('mic', mic)" class="capture-dot capture-dot--mic" :aria-label="`Microfone em uso: ${mic.join(', ')}`">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3M5 11a7 7 0 0 0 14 0M12 18v3" /></svg>
    </span>
  </div>
  <div class="capture-dots capture-dots--right" :style="{ left: `calc(50% + ${offset}px)` }" role="status" aria-live="polite">
    <span v-if="shown('camera', camera)" class="capture-dot capture-dot--camera" :aria-label="`Câmera em uso: ${camera.join(', ')}`">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 8a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM15 11l6-3v8l-6-3" /></svg>
    </span>
    <span v-if="shown('screen', screen)" class="capture-dot capture-dot--screen" :aria-label="`Tela compartilhada: ${screen.join(', ')}`">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 5.500A1.500 1.500 0 0 1 4.500 4h15A1.500 1.500 0 0 1 21 5.500v9a1.500 1.500 0 0 1-1.500 1.500h-15A1.500 1.500 0 0 1 3 14.500zM8 20h8M12 16v4" /></svg>
    </span>
  </div>
</template>
