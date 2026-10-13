<script setup lang="ts">
// Favicons oficiais em public/ai (baixados de cada serviço).
defineProps<{ id: string }>();
</script>

<template>
  <img class="ai-logo" :class="`ai-logo--${id}`" :src="`/ai/${id}.png`" :alt="id" draggable="false" />
</template>
