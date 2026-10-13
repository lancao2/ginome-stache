import { onBeforeUnmount, onMounted, ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

const charging = ref(false);
let users = 0;
let unlisten: UnlistenFn | undefined;

// Estado compartilhado: o backend avisa na hora em que o carregador é ligado ou removido.
export function useCharging() {
  onMounted(async () => {
    if (users++ > 0) return;
    try {
      const stop = await listen<boolean>("charging-changed", ({ payload }) => { charging.value = payload; });
      if (users === 0) stop(); else unlisten = stop;
      charging.value = await invoke<boolean>("get_charging");
    } catch { /* Browser preview. */ }
  });
  onBeforeUnmount(() => {
    if (--users === 0) { unlisten?.(); unlisten = undefined; }
  });
  return { charging };
}
