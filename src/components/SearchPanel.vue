<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";

import { useSearch } from "../composables/useSearch";

const search = useSearch();
const { query, results, apps, sites, selected, focusTick, indexing, indexed, searching, error } = search;
const count = (value: number) => value.toLocaleString("pt-BR");
const input = ref<HTMLInputElement | null>(null);
const list = ref<HTMLElement | null>(null);

const focusInput = () => input.value?.focus({ preventScroll: true });
// O foco do teclado chega à janela alguns instantes depois do atalho; insiste até o campo pegar.
let retries: number[] = [];
function claimFocus() {
  retries.forEach((id) => window.clearTimeout(id));
  focusInput();
  retries = [40, 120, 250, 450, 800].map((delay) => window.setTimeout(() => {
    if (document.activeElement !== input.value) focusInput();
  }, delay));
}
watch(focusTick, () => void nextTick(claimFocus));

onMounted(() => {
  void search.prepare();
  claimFocus();
  window.addEventListener("focus", focusInput);
});
onBeforeUnmount(() => {
  retries.forEach((id) => window.clearTimeout(id));
  window.removeEventListener("focus", focusInput);
});

function onKey(event: KeyboardEvent) {
  if (event.key === "ArrowDown") search.move(1);
  else if (event.key === "ArrowUp") search.move(-1);
  else if (event.key === "ArrowRight" && selected.value < apps.value.length) search.move(1, true);
  else if (event.key === "ArrowLeft" && selected.value < apps.value.length) search.move(-1, true);
  else if (event.key === "Enter") void search.open(event.ctrlKey);
  else if (event.key === "Escape") search.close();
  else return;
  event.preventDefault();
}

watch(selected, async () => {
  await nextTick();
  list.value?.querySelector<HTMLElement>(".is-selected")?.scrollIntoView({ block: "nearest" });
});

// Mostra o caminho a partir do $HOME de forma curta: /home/alex/Docs/x → ~/Docs/x
const home = ref("");
import("@tauri-apps/api/path").then(({ homeDir }) => homeDir()).then((dir) => { home.value = dir.replace(/\/$/, ""); }).catch(() => undefined);
function parent(path: string) {
  const dir = path.slice(0, path.lastIndexOf("/")) || "/";
  return home.value && dir.startsWith(home.value) ? `~${dir.slice(home.value.length)}` : dir;
}
</script>

<template>
  <div class="sr-panel">
    <label class="sr-field">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m21 21-4.300-4.300M10.500 18a7.500 7.500 0 1 1 0-15 7.500 7.500 0 0 1 0 15" /></svg>
      <input
        ref="input" :value="query" type="text" spellcheck="false" autocomplete="off"
        placeholder="Buscar arquivos e pastas no computador…" aria-label="Buscar arquivos e pastas"
        @input="search.setQuery(($event.target as HTMLInputElement).value)" @keydown="onKey"
      />
      <span v-if="searching" class="sr-status"><i class="sr-spinner" aria-hidden="true"></i>buscando…</span>
      <span v-else-if="indexing" class="sr-status"><i class="sr-spinner" aria-hidden="true"></i>indexando… {{ count(indexed) }} itens</span>
    </label>

    <p v-if="error" class="sr-error" role="alert">{{ error }}</p>
    <p v-if="!search.plain() && !apps.length && !results.length" class="sr-empty">Digite para buscar. ↑↓ escolher · Enter abrir · Ctrl+Enter abrir a pasta · Esc fechar. Use %termo% para incluir pastas do sistema.</p>
    <div v-else ref="list" class="sr-list" role="listbox" aria-label="Resultados">
      <p v-if="!search.plain()" class="sr-heading">Sugestões</p>
      <div v-if="apps.length" class="sr-apps" role="group" aria-label="Aplicativos">
        <button
          v-for="(app, index) in apps" :key="app.id" type="button" class="sr-app" :title="app.name"
          :class="{ 'is-selected': index === selected }" tabindex="-1"
          @mousemove="selected = index" @click="search.launch(app)"
        >
          <img v-if="app.icon" :src="app.icon" alt="" draggable="false" />
          <span v-else class="sr-app-letter" aria-hidden="true">{{ app.name.charAt(0).toUpperCase() }}</span>
          <span class="sr-app-name">{{ app.name }}</span>
        </button>
      </div>
      <p v-if="search.plain() && !results.length" class="sr-empty sr-none">{{ searching ? "Buscando…" : indexing ? `Montando o índice do computador (${count(indexed)} itens até agora)…` : "Nada encontrado no computador." }}</p>
      <div
        v-for="(hit, index) in results" :key="hit.path" class="sr-item"
        :class="{ 'is-selected': apps.length + index === selected }" role="option" :aria-selected="apps.length + index === selected"
        @mousemove="selected = apps.length + index" @click="search.openHit(hit)"
      >
        <svg class="sr-kind" viewBox="0 0 24 24" aria-hidden="true">
          <path v-if="hit.dir" d="M3 7a2 2 0 0 1 2-2h4l2 2.500h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
          <path v-else d="M6 3h8l5 5v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2m8 0v5h5" />
        </svg>
        <span class="sr-name">{{ hit.name }}</span>
        <small class="sr-path">{{ parent(hit.path) }}</small>
      </div>
      <div
        v-for="(site, index) in sites" :key="site.url" class="sr-item sr-site"
        :class="{ 'is-selected': apps.length + results.length + index === selected, 'is-first': index === 0 }" role="option"
        :aria-selected="apps.length + results.length + index === selected"
        @mousemove="selected = apps.length + results.length + index" @click="search.openSite(site)"
      >
        <img v-if="site.icon" class="sr-favicon" :src="site.icon" alt="" draggable="false" />
        <svg v-else class="sr-kind" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M3 12h18M12 3c2.500 2.500 3.500 5.500 3.500 9s-1 6.500-3.500 9c-2.500-2.500-3.500-5.500-3.500-9s1-6.500 3.500-9" /></svg>
        <span class="sr-name">{{ site.title }}</span>
        <small class="sr-path">{{ site.host }}</small>
      </div>
      <div
        v-if="search.plain()" class="sr-item sr-web" :class="{ 'is-selected': selected === apps.length + results.length + sites.length }" role="option"
        :aria-selected="selected === apps.length + results.length + sites.length" @mousemove="selected = apps.length + results.length + sites.length" @click="search.searchWeb()"
      >
        <svg class="sr-kind" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M3 12h18M12 3c2.500 2.500 3.500 5.500 3.500 9s-1 6.500-3.500 9c-2.500-2.500-3.500-5.500-3.500-9s1-6.500 3.500-9" /></svg>
        <span class="sr-name">Pesquisar “{{ search.plain() }}” na web</span>
        <small class="sr-path">navegador padrão</small>
      </div>
    </div>
  </div>
</template>
