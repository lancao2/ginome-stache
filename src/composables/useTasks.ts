import { computed, ref } from "vue";
import { invoke } from "@tauri-apps/api/core";

import type { Task, TaskInput } from "../types/task";

const tasks = ref<Task[]>([]);
const error = ref("");
// Pedido para abrir uma tarefa na aba Início (ex.: clique no aviso de vencimento).
const focusRequest = ref<number | null>(null);

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T | null> {
  try {
    error.value = "";
    return await invoke<T>(command, args);
  } catch (cause) {
    error.value = String(cause);
    return null;
  }
}

export function toISO(date: Date) {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

export function useTasks() {
  const byDate = computed(() => {
    const map = new Map<string, Task[]>();
    for (const task of tasks.value) {
      if (!task.dueDate) continue;
      const list = map.get(task.dueDate) ?? [];
      list.push(task);
      map.set(task.dueDate, list);
    }
    return map;
  });

  async function load() {
    const result = await call<Task[]>("list_tasks");
    if (result) tasks.value = result;
  }

  async function create(input: TaskInput) {
    if (await call<Task>("create_task", { input })) await load();
  }

  async function update(id: number, input: TaskInput) {
    if (await call<Task>("update_task", { id, input })) await load();
  }

  async function setDone(id: number, done: boolean) {
    const task = tasks.value.find((item) => item.id === id);
    if (task) task.done = done; // Resposta imediata; o banco confirma em seguida.
    await call<Task>("set_task_done", { id, done });
    await load();
  }

  async function remove(id: number) {
    await call<null>("delete_task", { id });
    await load();
  }

  return { tasks, byDate, error, focusRequest, load, create, update, setDone, remove };
}
