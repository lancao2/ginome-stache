import { computed, ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface ClipItem {
  id: number;
  text: string;
  createdAt: number;
  favorite: boolean;
  kind: "text" | "image";
  image: string | null;
}

const items = ref<ClipItem[]>([]);
const selected = ref(0);
const error = ref("");
const closeHandlers = new Set<() => void>();
const shortcutHandlers = new Set<() => void>();
let started = false;

const current = computed(() => items.value[selected.value] ?? null);

async function load() {
  try {
    items.value = await invoke<ClipItem[]>("clipboard_list");
    if (selected.value >= items.value.length) selected.value = Math.max(0, items.value.length - 1);
  } catch { /* Browser preview. */ }
}

async function start() {
  if (started) return;
  started = true;
  await load();
  try {
    await listen("clipboard-updated", () => void load());
    await listen("clipboard-shortcut", () => { for (const handler of shortcutHandlers) handler(); });
  } catch { started = false; }
}

function move(step: number) {
  if (!items.value.length) return;
  selected.value = (selected.value + step + items.value.length) % items.value.length;
}

async function toggleFavorite(item: ClipItem) {
  await invoke("clipboard_toggle_favorite", { id: item.id });
  await load();
}

async function remove(item: ClipItem) {
  await invoke("clipboard_delete", { id: item.id });
  await load();
}

async function clear() {
  await invoke("clipboard_clear");
  selected.value = 0;
  await load();
}

// Coloca o item na área de transferência, devolve o foco à janela anterior e cola.
async function paste(item: ClipItem | null = current.value) {
  if (!item) return;
  error.value = "";
  try {
    await invoke("clipboard_paste", { id: item.id });
    for (const handler of closeHandlers) handler();
  } catch (cause) {
    error.value = String(cause);
  }
}

export function useClipboard() {
  return {
    items, selected, current, error,
    start, load, move, toggleFavorite, remove, clear, paste,
    close: () => { for (const handler of closeHandlers) handler(); },
    onClose(handler: () => void) { closeHandlers.add(handler); return () => closeHandlers.delete(handler); },
    onShortcut(handler: () => void) { shortcutHandlers.add(handler); return () => shortcutHandlers.delete(handler); },
  };
}
