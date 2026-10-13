import { ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

interface CaptureState { mic: string[]; camera: string[]; screen: string[] }

const mic = ref<string[]>([]);
const camera = ref<string[]>([]);
const screen = ref<string[]>([]);
let started = false;

function apply(state: CaptureState) {
  mic.value = state.mic;
  camera.value = state.camera;
  screen.value = state.screen ?? [];
}

// Quem está usando microfone e câmera agora (os indicadores ficam à esquerda da cápsula).
async function start() {
  if (started) return;
  started = true;
  try {
    await listen<CaptureState>("capture-state", ({ payload }) => apply(payload));
    apply(await invoke<CaptureState>("capture_state"));
  } catch { started = false; /* Browser preview. */ }
}

export function useCapture() {
  return { mic, camera, screen, start };
}
