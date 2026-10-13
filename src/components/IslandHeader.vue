<script setup lang="ts">
import type { IslandTab } from "../composables/useIsland";
import { useWhatsapp } from "../composables/useWhatsapp";

import { useCodex } from "../composables/useCodex";
import { usePlugins } from "../composables/usePlugins";
import { computed } from "vue";
import { usePets } from "../composables/usePets";
import { usePetTasks } from "../composables/usePetTasks";

const { enabledCount: pluginCount } = usePlugins();

const { unread: whatsappUnread } = useWhatsapp();
const { pendingApprovals } = useCodex();
const { needyCount } = usePets();
const { runs } = usePetTasks();
const petBadge = computed(() => needyCount.value + Object.values(runs).reduce((sum, run) => sum + run.entries.filter((item) => item.kind === "approval" && item.decision === null).length, 0));

defineProps<{ tab: IslandTab; hasMedia: boolean; source?: string; notifications?: number; controlsOpen?: boolean }>();
const emit = defineEmits<{ select: [tab: IslandTab]; toggleControls: [] }>();
</script>

<template>
  <header class="island-header">
    <div class="island-tabs" role="tablist">
      <button type="button" role="tab" class="island-tab" :aria-selected="tab === 'home'" aria-label="Início" title="Início" @click="emit('select', 'home')">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6.5A1.5 1.5 0 0 1 5.5 5h13A1.5 1.5 0 0 1 20 6.5v12a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5zM4 10h16M8 3v4m8-4v4" /></svg>
        <span class="tab-label">Início</span>
      </button>
      <button type="button" role="tab" class="island-tab" aria-label="IA" title="IA" :aria-selected="tab === 'ai'" @click="emit('select', 'ai')">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3c.6 4.6 3.4 7.4 8 8-4.6.6-7.4 3.4-8 8-.6-4.6-3.4-7.4-8-8 4.6-.6 7.4-3.4 8-8M19 3v3m-1.5-1.5h3" /></svg>
        <span class="tab-label">IA</span>
      </button>
      <button v-if="hasMedia" type="button" role="tab" class="island-tab" :aria-selected="tab === 'media'" aria-label="Mídia" title="Mídia" @click="emit('select', 'media')">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18V5l11-2v13M9 9l11-2M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6m11-2a3 3 0 1 0 0-6 3 3 0 0 0 0 6" /></svg>
        <span class="tab-label">Mídia</span>
      </button>
      <button type="button" role="tab" class="island-tab" aria-label="Tempo" title="Tempo" :aria-selected="tab === 'weather'" @click="emit('select', 'weather')">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 18a4 4 0 0 1-.3-8 5.500 5.500 0 0 1 10.600 1.200A3.400 3.400 0 0 1 17 18zM9 3.500l.7 1.500M4.200 6.200l1.400 1" /></svg>
        <span class="tab-label">Tempo</span>
      </button>
      <button type="button" role="tab" class="island-tab" aria-label="WhatsApp" title="WhatsApp" :aria-selected="tab === 'whatsapp'" @click="emit('select', 'whatsapp')">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20l1.200-4.100A8 8 0 1 1 8.200 18.900zM9 9.500c0 3 2.500 5.500 5.500 5.500l1-1.500-1.800-.9-.7.700c-.9-.4-1.600-1.100-2-2l.7-.7-.9-1.800z" /></svg>
        <span class="tab-label">WhatsApp</span>
        <span v-if="whatsappUnread" class="tab-badge tab-badge--wa">{{ whatsappUnread > 99 ? "99+" : whatsappUnread }}</span>
      </button>
      <button type="button" role="tab" class="island-tab" aria-label="Central de agentes" title="Central de agentes" :aria-selected="tab === 'codex'" @click="emit('select', 'codex')">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="6" r="2.5" /><circle cx="6" cy="17" r="2.5" /><circle cx="18" cy="17" r="2.5" /><path d="M10.8 8.2 7.3 14.8M13.2 8.2l3.5 6.6M8.5 17h7" /></svg>
        <span class="tab-label">Agentes</span>
        <span v-if="pendingApprovals" class="tab-badge">{{ pendingApprovals }}</span>
      </button>
      <button type="button" role="tab" class="island-tab" aria-label="Mascotes" title="Mascotes" :aria-selected="tab === 'pets'" @click="emit('select', 'pets')">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M8.500 14a4.500 4.500 0 0 0 7 0M9 9.500h.01M15 9.500h.01" /></svg>
        <span class="tab-label">Mascotes</span>
        <span v-if="petBadge" class="tab-badge">{{ petBadge }}</span>
      </button>
      <button type="button" role="tab" class="island-tab" aria-label="Área de transferência" title="Área de transferência" :aria-selected="tab === 'clipboard'" @click="emit('select', 'clipboard')">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4h6v3H9zM8 5.500H6.500A1.500 1.500 0 0 0 5 7v12a1.500 1.500 0 0 0 1.500 1.500h11A1.500 1.500 0 0 0 19 19V7a1.500 1.500 0 0 0-1.500-1.500H16M9 12h6m-6 4h4" /></svg>
        <span class="tab-label">Copiados</span>
      </button>
      <button v-if="pluginCount" type="button" role="tab" class="island-tab" aria-label="Widgets" title="Widgets" :aria-selected="tab === 'plugins'" @click="emit('select', 'plugins')">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5.500A1.500 1.500 0 0 1 5.500 4h4A1.500 1.500 0 0 1 11 5.500v4A1.500 1.500 0 0 1 9.500 11h-4A1.500 1.500 0 0 1 4 9.500zM13 5.500A1.500 1.500 0 0 1 14.500 4h4A1.500 1.500 0 0 1 20 5.500v4a1.500 1.500 0 0 1-1.500 1.500h-4A1.500 1.500 0 0 1 13 9.500zM4 14.500A1.500 1.500 0 0 1 5.500 13h4a1.500 1.500 0 0 1 1.500 1.500v4A1.500 1.500 0 0 1 9.500 20h-4A1.500 1.500 0 0 1 4 18.500zM13 14.500a1.500 1.500 0 0 1 1.500-1.500h4a1.500 1.500 0 0 1 1.500 1.500v4a1.500 1.500 0 0 1-1.500 1.500h-4a1.500 1.500 0 0 1-1.500-1.500z" /></svg>
        <span class="tab-label">Widgets</span>
      </button>
      <button type="button" role="tab" class="island-tab" aria-label="Buscar" title="Buscar (Super+Espaço)" :aria-selected="tab === 'search'" @click="emit('select', 'search')">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m21 21-4.300-4.300M10.500 18a7.500 7.500 0 1 1 0-15 7.500 7.500 0 0 1 0 15" /></svg>
        <span class="tab-label">Buscar</span>
      </button>
      <button type="button" role="tab" class="island-tab" aria-label="Notificações" title="Notificações" :aria-selected="tab === 'notifications'" @click="emit('select', 'notifications')">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9a6 6 0 0 1 12 0c0 6 2.5 7.5 2.5 7.5h-17S6 15 6 9m4 10.5a2 2 0 0 0 4 0" /></svg>
        <span class="tab-label">Notificações</span>
        <span v-if="notifications" class="tab-badge">{{ notifications > 99 ? "99+" : notifications }}</span>
      </button>
    </div>
    <span v-if="source && tab === 'media'" class="source-label">{{ source }}</span>
    <button class="header-action" :class="{ 'header-action--on': controlsOpen }" type="button" aria-label="Central de controle" title="Central de controle" :aria-pressed="controlsOpen" @click="emit('toggleControls')">
      <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1" /></svg>
    </button>
  </header>
</template>
