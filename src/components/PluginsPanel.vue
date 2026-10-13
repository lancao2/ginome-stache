<script setup lang="ts">
import { usePlugins } from "../composables/usePlugins";

const { groups, enabledCount, runAction, openUrl } = usePlugins();
</script>

<template>
  <div class="pl-panel">
    <p v-if="!groups.length" class="pl-empty">
      {{ enabledCount ? "Os plugins ativos ainda não enviaram cartões…" : "Nenhum plugin ativo. Ative e instale plugins em Configurações → Ajustes do Stache → Plugins." }}
    </p>
    <div v-else class="pl-grid">
      <template v-for="group in groups" :key="group.pluginId">
        <article v-for="card in group.cards" :key="`${group.pluginId}/${card.id}`" class="pl-card" :class="`pl-tone-${card.tone}`">
          <header class="pl-head">
            <component :is="card.url ? 'button' : 'div'" class="pl-title" type="button" @click="card.url && openUrl(card.url)">
              <strong>{{ card.title || group.pluginName }}</strong>
              <small v-if="card.subtitle">{{ card.subtitle }}</small>
            </component>
            <span class="pl-source">{{ group.pluginName }}</span>
          </header>
          <p v-if="card.body" class="pl-body">{{ card.body }}</p>
          <dl v-if="card.lines.length" class="pl-lines">
            <div v-for="(line, index) in card.lines" :key="index" class="pl-line">
              <dt>{{ line.label }}</dt>
              <dd :class="`pl-tone-${line.tone}`">{{ line.value }}</dd>
            </div>
          </dl>
          <div v-if="card.progress !== null" class="pl-progress" role="progressbar" :aria-valuenow="Math.round(card.progress * 100)" aria-valuemin="0" aria-valuemax="100">
            <span :style="{ width: `${card.progress * 100}%` }" />
          </div>
          <footer v-if="card.actions.length" class="pl-actions">
            <button v-for="action in card.actions" :key="action.id" type="button" class="pl-action" @click="runAction(group.pluginId, card.id, action.id)">{{ action.label }}</button>
          </footer>
        </article>
      </template>
    </div>
  </div>
</template>
