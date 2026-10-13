import { ref } from "vue";
import { invoke } from "@tauri-apps/api/core";

import type { AiUsage } from "../types/ai";

const usage = ref<AiUsage[]>([]);
const loading = ref(false);
const loaded = ref(false);
let lastLoad = 0;

export function useAiUsage() {
  async function load(force = false) {
    // Os endpoints de uso são externos; evita consultar mais de uma vez por minuto.
    if (loading.value || (!force && Date.now() - lastLoad < 60_000)) return;
    loading.value = true;
    try {
      usage.value = await invoke<AiUsage[]>("get_ai_usage");
      lastLoad = Date.now();
    } catch { /* Browser preview. */ }
    finally {
      loading.value = false;
      loaded.value = true;
    }
  }

  return { usage, loading, loaded, load };
}
