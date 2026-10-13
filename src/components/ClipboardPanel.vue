<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";

import { convertFileSrc } from "@tauri-apps/api/core";

import { useClipboard, type ClipItem } from "../composables/useClipboard";

const clip = useClipboard();
const { items, selected, error } = clip;
const list = ref<HTMLElement | null>(null);
const now = ref(Date.now());
let timer: number | undefined;

onMounted(() => {
  void clip.load();
  window.addEventListener("keydown", onKey);
  timer = window.setInterval(() => { now.value = Date.now(); }, 30_000);
});
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKey);
  window.clearInterval(timer);
});

// Setas escolhem, Enter cola; Esc fecha. Com um campo de texto focado, as teclas são dele.
function onKey(event: KeyboardEvent) {
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
  const item = items.value[selected.value];
  if (event.key === "ArrowDown") clip.move(1);
  else if (event.key === "ArrowUp") clip.move(-1);
  else if (event.key === "Enter") void clip.paste(item);
  else if (event.key === "Escape") clip.close();
  else if ((event.key === "Delete" || event.key === "Backspace") && item) void clip.remove(item);
  else if ((event.key === "f" || event.key === "F" || event.key === " ") && item) void clip.toggleFavorite(item);
  else return;
  event.preventDefault();
}

watch(selected, async () => {
  await nextTick();
  list.value?.querySelector<HTMLElement>(".is-selected")?.scrollIntoView({ block: "nearest" });
});

function preview(text: string) {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 160 ? `${flat.slice(0, 160)}…` : flat;
}

const HOUR = 3_600_000;
function age(item: ClipItem) {
  const minutes = Math.floor((now.value - item.createdAt) / 60_000);
  if (minutes < 1) return "agora";
  if (minutes < 60) return `há ${minutes} min`;
  return `há ${Math.floor(minutes / 60)} h`;
}
function expires(item: ClipItem) {
  if (item.favorite) return "";
  const hours = Math.ceil((item.createdAt + 24 * HOUR - now.value) / HOUR);
  return hours <= 1 ? "some em menos de 1 h" : `some em ${hours} h`;
}
</script>

<template>
  <div class="cb-panel">
    <header class="cb-bar">
      <strong>Área de transferência</strong>
      <span class="cb-keys">↑↓ escolher · Enter colar · F favoritar · Esc fechar</span>
      <button type="button" class="cb-clear" :disabled="!items.some((item) => !item.favorite)" @click="clip.clear()">Limpar</button>
    </header>

    <p v-if="error" class="cb-error" role="alert">{{ error }}</p>
    <p v-if="!items.length" class="cb-empty">Nada copiado ainda. Textos e imagens (como prints) que você copiar aparecem aqui por 24 horas; favoritos ficam para sempre.</p>

    <div v-else ref="list" class="cb-list" role="listbox" aria-label="Itens copiados">
      <div
        v-for="(item, index) in items" :key="item.id" class="cb-item"
        :class="{ 'is-selected': index === selected }" role="option" :aria-selected="index === selected"
        @mousemove="selected = index" @click="clip.paste(item)"
      >
        <img v-if="item.image" class="cb-thumb" :src="convertFileSrc(item.image)" alt="Imagem copiada" draggable="false" loading="lazy" />
        <span v-else class="cb-text">{{ preview(item.text) }}</span>
        <small class="cb-meta">{{ age(item) }}<template v-if="expires(item)"> · {{ expires(item) }}</template></small>
        <button type="button" class="cb-icon" :class="{ 'is-on': item.favorite }" :aria-pressed="item.favorite" :title="item.favorite ? 'Remover dos favoritos' : 'Favoritar'" aria-label="Favoritar" @click.stop="clip.toggleFavorite(item)">
          <svg viewBox="0 0 24 24"><path d="m12 3.500 2.600 5.300 5.800.8-4.200 4.100 1 5.800L12 16.800l-5.200 2.700 1-5.800-4.200-4.100 5.800-.8z" /></svg>
        </button>
        <button type="button" class="cb-icon cb-icon--del" title="Apagar" aria-label="Apagar" @click.stop="clip.remove(item)">
          <svg viewBox="0 0 24 24"><path d="m7 7 10 10M17 7 7 17" /></svg>
        </button>
      </div>
    </div>
  </div>
</template>
