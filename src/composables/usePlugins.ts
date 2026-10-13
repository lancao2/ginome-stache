import { computed, ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface PluginLine { label: string; value: string; tone: string }
export interface PluginAction { id: string; label: string }
export interface PluginCard {
  id: string;
  title: string;
  subtitle: string | null;
  icon: string | null;
  body: string | null;
  progress: number | null;
  lines: PluginLine[];
  actions: PluginAction[];
  url: string | null;
  tone: string;
}
export interface PluginCards { pluginId: string; pluginName: string; cards: PluginCard[] }
export interface SettingDef { key: string; label: string; default: string; hint: string; secret: boolean }
/** Valor que a tela recebe no lugar de um segredo já guardado no cofre. */
export const IN_VAULT = "__vault__";
export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  permissions: string[];
  settings: SettingDef[];
  values: Record<string, string>;
  enabled: boolean;
  approved: boolean;
  status: string;
  sandboxed: boolean;
}
interface PluginList { plugins: PluginInfo[]; errors: { folder: string; error: string }[]; dir: string }

const groups = ref<PluginCards[]>([]);
const plugins = ref<PluginInfo[]>([]);
const loadErrors = ref<{ folder: string; error: string }[]>([]);
const dir = ref("");
const failure = ref("");
let started = false;

const enabledCount = computed(() => plugins.value.filter((plugin) => plugin.enabled).length);

async function loadList() {
  try {
    const list = await invoke<PluginList>("plugins_list");
    plugins.value = list.plugins;
    loadErrors.value = list.errors;
    dir.value = list.dir;
  } catch { /* Browser preview. */ }
}

async function start() {
  if (started) return;
  started = true;
  try {
    await listen<PluginCards[]>("plugin-cards", ({ payload }) => { groups.value = payload; });
    groups.value = await invoke<PluginCards[]>("plugins_cards");
  } catch { started = false; return; }
  await loadList();
}

async function attempt(action: () => Promise<unknown>) {
  failure.value = "";
  try { await action(); } catch (cause) { failure.value = String(cause); }
  await loadList();
}

const setEnabled = (id: string, enabled: boolean) => attempt(() => invoke("plugins_set_enabled", { id, enabled }));
const setSetting = (id: string, key: string, value: string) => attempt(() => invoke("plugins_set_setting", { id, key, value }));
const installExamples = () => attempt(() => invoke("plugins_install_examples"));
const openDir = () => attempt(() => invoke("plugins_open_dir"));
const runAction = (plugin: string, card: string, action: string) => void invoke("plugin_action", { plugin, card, action }).catch(() => undefined);
const openUrl = (url: string) => void invoke("search_open_url", { url }).catch(() => undefined);

export function usePlugins() {
  return { groups, plugins, loadErrors, dir, failure, enabledCount, start, loadList, setEnabled, setSetting, installExamples, openDir, runAction, openUrl };
}
