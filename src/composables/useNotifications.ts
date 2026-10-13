import { computed, ref } from "vue";
import { invoke } from "@tauri-apps/api/core";

import type { SystemNotification } from "../types/notification";

const notifications = ref<SystemNotification[]>([]);

export function useNotifications() {
  const count = computed(() => notifications.value.length);

  async function load() {
    try { notifications.value = await invoke<SystemNotification[]>("list_notifications"); }
    catch { /* Browser preview. */ }
  }

  function add(notification: SystemNotification) {
    notifications.value = [notification, ...notifications.value.filter((item) => item.id !== notification.id)];
  }

  async function clear() {
    notifications.value = [];
    try { await invoke("clear_notifications"); }
    catch { /* Browser preview. */ }
  }

  async function remove(id: number) {
    notifications.value = notifications.value.filter((item) => item.id !== id);
    try { await invoke("delete_notification", { id }); }
    catch { /* Browser preview. */ }
  }

  return { notifications, count, load, add, clear, remove };
}
