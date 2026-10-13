import { ref, watch } from "vue";

const KEY = "stache.settings";

export const COMPACT_SCALE_RANGE = { min: 80, max: 130, step: 5 } as const;
export const EXPANDED_SCALE_RANGE = { min: 80, max: 125, step: 5 } as const;

function read(): { compact: number; expanded: number } {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return {
      compact: Math.min(COMPACT_SCALE_RANGE.max, Math.max(COMPACT_SCALE_RANGE.min, Number(saved.compact) || 100)),
      expanded: Math.min(EXPANDED_SCALE_RANGE.max, Math.max(EXPANDED_SCALE_RANGE.min, Number(saved.expanded) || 100)),
    };
  } catch {
    return { compact: 100, expanded: 100 };
  }
}

const initial = read();
// Tamanhos em porcentagem do padrão.
const compactScale = ref(initial.compact);
const expandedScale = ref(initial.expanded);

watch([compactScale, expandedScale], ([compact, expanded]) => {
  try { localStorage.setItem(KEY, JSON.stringify({ compact, expanded })); }
  catch { /* Sem armazenamento: a escolha vale só nesta sessão. */ }
});

export function useStacheSettings() {
  return {
    compactScale,
    expandedScale,
    reset() { compactScale.value = 100; expandedScale.value = 100; },
  };
}
