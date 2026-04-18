<script setup>
import WorkspaceScreen from './components/WorkspaceScreen.vue'
</script>

<template>
  <div class="hud-root">
    <WorkspaceScreen />
  </div>
</template>

<style scoped>
.hud-root {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: transparent;
  padding: 0;
}
</style>
