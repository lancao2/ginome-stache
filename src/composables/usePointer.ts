import { ref } from "vue";
import { invoke } from "@tauri-apps/api/core";

// Posição do mouse relativa ao canto da janela do Stache, em pixels CSS.
// Com a extensão do GNOME ela vale para a tela toda (no Wayland o app só vê o mouse sobre a própria
// janela); sem a extensão, ou com uma versão antiga dela, cai para o mouse dentro da janela.
const pointer = ref<{ x: number; y: number } | null>(null);

const POLL_MS = 60;
const RETRY_MS = 5_000;

let users = 0;
let timer: number | undefined;
let globalWorks = false;

function onMove(event: PointerEvent) {
  if (!globalWorks) pointer.value = { x: event.clientX, y: event.clientY };
}

async function poll() {
  timer = undefined;
  if (users === 0) return;
  if (!document.hidden) {
    try {
      const position = await invoke<[number, number] | null>("pointer_position");
      globalWorks = position !== null;
      if (position) pointer.value = { x: position[0], y: position[1] };
    } catch { globalWorks = false; }
  }
  if (users > 0) timer = window.setTimeout(poll, globalWorks ? POLL_MS : RETRY_MS);
}

/** Quem mostra olhos que seguem o mouse chama `acquire` ao montar e `release` ao desmontar. */
export function usePointer() {
  return {
    pointer,
    acquire() {
      users += 1;
      if (users === 1) {
        window.addEventListener("pointermove", onMove, { passive: true });
        void poll();
      }
    },
    release() {
      users = Math.max(0, users - 1);
      if (users === 0) {
        window.removeEventListener("pointermove", onMove);
        window.clearTimeout(timer);
        timer = undefined;
      }
    },
  };
}
