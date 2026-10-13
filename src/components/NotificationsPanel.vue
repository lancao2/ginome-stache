<script setup lang="ts">
import { onBeforeUnmount, ref } from "vue";

import { useNotifications } from "../composables/useNotifications";
import type { SystemNotification } from "../types/notification";

const { notifications, count, clear, remove } = useNotifications();

const now = ref(Date.now());
const timer = window.setInterval(() => { now.value = Date.now(); }, 30_000);
onBeforeUnmount(() => window.clearInterval(timer));

function initial(item: SystemNotification) {
  return (item.app || "S").trim().charAt(0).toUpperCase();
}
function hue(item: SystemNotification) {
  let hash = 0;
  for (const char of item.app) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % 360;
}

function ago(item: SystemNotification) {
  const at = new Date(item.createdAt.replace(" ", "T")).getTime();
  const minutes = Math.floor((now.value - at) / 60_000);
  if (Number.isNaN(minutes) || minutes < 1) return "agora";
  if (minutes < 60) return `há ${minutes} min`;
  if (minutes < 24 * 60) return `há ${Math.floor(minutes / 60)} h`;
  return new Intl.DateTimeFormat("pt-BR", { day: "numeric", month: "short" }).format(at).replace(".", "");
}
</script>

<template>
  <div class="notif-panel">
    <header class="notif-head">
      <h2>Notificações</h2>
      <button type="button" class="clear-btn" :disabled="!count" aria-label="Limpar todas as notificações" @click="clear">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17" /></svg>
        <span>Limpar tudo</span>
      </button>
    </header>

    <TransitionGroup v-if="count" tag="ul" name="notif" class="notif-list">
      <li v-for="item in notifications" :key="item.id" class="notif">
        <img v-if="item.icon" class="notif-icon" :src="item.icon" alt="" />
        <span v-else class="notif-icon notif-icon--letter" :style="{ '--hue': hue(item) }" aria-hidden="true">{{ initial(item) }}</span>
        <div class="notif-content">
          <div class="notif-top">
            <span class="notif-app">{{ item.app || "Sistema" }}</span>
            <span class="notif-time">{{ ago(item) }}</span>
          </div>
          <strong class="notif-summary">{{ item.summary || item.app }}</strong>
          <p v-if="item.body" class="notif-body">{{ item.body }}</p>
        </div>
        <button type="button" class="notif-remove" aria-label="Dispensar notificação" @click="remove(item.id)">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 8 8 8M16 8l-8 8" /></svg>
        </button>
      </li>
    </TransitionGroup>
    <div v-else class="notif-empty">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9a6 6 0 0 1 12 0c0 6 2.5 7.5 2.5 7.5h-17S6 15 6 9m4 10.5a2 2 0 0 0 4 0" /></svg>
      <p>Sem notificações</p>
    </div>
  </div>
</template>
