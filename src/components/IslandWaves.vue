<script setup lang="ts">
// Ondas de neon que saem das laterais da ilha. Use dentro de qualquer aviso.
</script>

<template>
  <div class="waves" aria-hidden="true">
    <template v-for="side in ['left', 'right']" :key="side">
      <i v-for="step in 3" :key="`${side}${step}`" class="wave-ring" :class="`wave-ring--${side}`" :style="{ animationDelay: `${(step - 1) * 650}ms` }" />
    </template>
  </div>
</template>
