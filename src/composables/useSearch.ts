import { ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface SearchHit {
  path: string;
  name: string;
  dir: boolean;
}
export interface AppHit {
  id: string;
  name: string;
  icon: string;
}
export interface SiteHit {
  title: string;
  url: string;
  host: string;
  icon: string;
}
interface SearchStatus { ready: boolean; building: boolean; count: number }

const query = ref("");
const results = ref<SearchHit[]>([]);
const apps = ref<AppHit[]>([]);
const sites = ref<SiteHit[]>([]);
const selected = ref(0);
const indexing = ref(false);
const indexed = ref(0);
const searching = ref(false);
/** Sobe a cada Super+Espaço; o painel usa para devolver o foco ao campo de busca. */
const focusTick = ref(0);
const error = ref("");
const shortcutHandlers = new Set<() => void>();
const closeHandlers = new Set<() => void>();
let started = false;
// "%termo%" pede também os itens do sistema; para apps e web vale só o termo.
const plain = () => query.value.trim().replace(/^%+|%+$/g, "").trim();
let sequence = 0;
let debounce: number | undefined;
let webDebounce: number | undefined;
let webSequence = 0;

// Sem texto digitado, a lista mostra sugestões: apps e pastas mais usados.
async function loadSuggestions() {
  try {
    const found = await invoke<{ apps: AppHit[]; dirs: SearchHit[] }>("search_suggestions");
    if (plain()) return; // o usuário já começou a digitar
    apps.value = found.apps;
    results.value = found.dirs;
    sites.value = [];
    selected.value = 0;
  } catch { /* Browser preview. */ }
}

async function run() {
  const mine = ++sequence;
  const text = query.value.trim();
  const term = plain();
  if (!term) { searching.value = false; await loadSuggestions(); return; }
  searching.value = true;
  try {
    // Aplicativos são rápidos: aparecem antes dos arquivos.
    const appsPromise = invoke<AppHit[]>("search_apps", { query: term }).then((found) => {
      if (mine === sequence) { apps.value = found; selected.value = 0; }
    }).catch(() => undefined);
    const hits = await invoke<SearchHit[]>("search_query", { query: text });
    await appsPromise;
    if (mine !== sequence) return; // chegou uma consulta mais nova
    results.value = hits;
    selected.value = 0;
  } catch { /* Browser preview. */ }
  if (mine === sequence) searching.value = false;
}

// Sites da web são mais lentos (rede): vêm depois, com espera maior entre as teclas.
async function runWeb() {
  const mine = ++webSequence;
  const text = plain();
  if (!text) { sites.value = []; return; }
  try {
    const found = await invoke<SiteHit[]>("search_web_sites", { query: text });
    if (mine === webSequence) sites.value = found;
  } catch { /* Browser preview. */ }
}

function setQuery(text: string) {
  query.value = text;
  window.clearTimeout(webDebounce);
  if (plain()) webDebounce = window.setTimeout(() => void runWeb(), 500);
  else { webSequence++; sites.value = []; }
  searching.value = plain().length > 0;
  window.clearTimeout(debounce);
  debounce = window.setTimeout(() => void run(), 90);
}

// Abre a busca: garante o índice (montado em segundo plano na primeira vez).
async function prepare() {
  if (!plain()) void loadSuggestions();
  try {
    const status = await invoke<SearchStatus>("search_prepare");
    indexing.value = status.building;
    indexed.value = status.count;
  } catch { /* Browser preview. */ }
}

async function start() {
  if (started) return;
  started = true;
  try {
    await listen("search-shortcut", () => { focusTick.value++; for (const handler of shortcutHandlers) handler(); });
    await listen<SearchStatus>("search-index-progress", (event) => { indexing.value = true; indexed.value = event.payload.count; });
    await listen<SearchStatus>("search-index-ready", (event) => {
      indexing.value = false;
      indexed.value = event.payload.count;
      if (query.value.trim()) void run();
    });
  } catch { started = false; }
}

// Ordem da seleção: aplicativos (uma linha), arquivos, sites da web e, por último, "pesquisar na web".
// Com texto digitado a lista nunca fica vazia, porque a pesquisa na web sempre existe.
const total = () => apps.value.length + results.value.length + sites.value.length + (plain() ? 1 : 0);

function move(step: number, sideways = false) {
  if (!total()) return;
  const count = apps.value.length;
  const now = selected.value;
  if (sideways) {
    if (now < count) selected.value = (now + step + count) % count;
    return;
  }
  if (count && now < count) {
    // ↓ sai da linha de apps para o primeiro arquivo; ↑ volta ao fim da lista.
    selected.value = step > 0 ? count : total() - 1;
  } else if (count && now === count && step < 0) {
    selected.value = 0;
  } else {
    selected.value = (now + step + total()) % total();
  }
}

function fail(cause: unknown) { error.value = String(cause); }

async function searchWeb() {
  const text = plain();
  if (!text) return;
  error.value = "";
  try {
    await invoke("search_web", { query: text });
    for (const handler of closeHandlers) handler();
  } catch (cause) { fail(cause); }
}

async function launch(app: AppHit) {
  error.value = "";
  // Fecha já: iniciar o app pode levar segundos e a busca não precisa ficar esperando.
  for (const handler of closeHandlers) handler();
  try {
    await invoke("search_launch", { id: app.id });
  } catch (cause) { fail(cause); }
}

async function openSite(site: SiteHit) {
  error.value = "";
  try {
    await invoke("search_open_url", { url: site.url });
    for (const handler of closeHandlers) handler();
  } catch (cause) { fail(cause); }
}

async function openHit(hit: SearchHit, reveal = false) {
  error.value = "";
  try {
    await invoke("search_open", { path: hit.path, reveal });
    for (const handler of closeHandlers) handler();
  } catch (cause) { fail(cause); }
}

/** Abre o item selecionado (Ctrl+Enter abre a pasta de um arquivo). */
async function open(reveal = false) {
  const at = selected.value;
  const app = apps.value[at];
  if (app) return launch(app);
  const hit = results.value[at - apps.value.length];
  if (hit) return openHit(hit, reveal);
  const site = sites.value[at - apps.value.length - results.value.length];
  if (site) return openSite(site);
  return searchWeb();
}

export function useSearch() {
  return {
    query, plain, results, apps, sites, selected, focusTick, indexing, indexed, searching, error,
    start, prepare, setQuery, move, open, openHit, openSite, launch, searchWeb,
    close: () => { for (const handler of closeHandlers) handler(); },
    onClose(handler: () => void) { closeHandlers.add(handler); return () => closeHandlers.delete(handler); },
    onShortcut(handler: () => void) { shortcutHandlers.add(handler); return () => shortcutHandlers.delete(handler); },
  };
}
