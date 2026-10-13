<script setup lang="ts">
import { useCharging } from "../composables/useCharging";

const { charging } = useCharging();
</script>

<template>
  <svg v-if="charging" class="charge-bolt" viewBox="0 0 24 24" role="img" aria-label="Carregando">
    <path d="M13.5 2 5 13.5h5.5L9.5 22 19 9.5h-5.8z" />
  </svg>
</template>
