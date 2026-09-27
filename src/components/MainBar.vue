<script setup>
defineProps({
  canAnswer: Boolean,
  canAnalyze: Boolean,
  canPaste: Boolean,
  pasteOpen: Boolean,
  isRecording: Boolean,
  recordingSeconds: { type: Number, default: 0 },
  hasHistory: Boolean
})

defineEmits(['answer', 'analyze', 'toggle-paste', 'clear-audio', 'clear-session', 'rec', 'quit'])
</script>

<template>
  <div class="single-row">
    <div class="left-actions">
      <button class="action-btn indigo" @click="$emit('answer')" :disabled="!canAnswer">
        <span class="action-icon">☰</span>
        <span>answer question</span>
      </button>
      <button class="action-btn green" @click="$emit('analyze')" :disabled="!canAnalyze">
        <span class="action-icon">◻</span>
        <span>analyze screen</span>
      </button>
      <button class="action-btn amber" :class="{ active: pasteOpen }" @click="$emit('toggle-paste')" :disabled="!canPaste">
        <span class="action-icon">✎</span>
        <span>paste text</span>
      </button>
    </div>

    <!-- Drag area in the middle -->
    <div class="drag-space" title="Drag to move"></div>

    <div class="right-actions">
      <button class="icon-btn" v-if="isRecording" @click="$emit('clear-audio')" title="Clear recorded audio">↺</button>
      <button class="icon-btn clear-btn" v-if="hasHistory" @click="$emit('clear-session')" title="Clear session history">⊘</button>
      <div class="rec-pill" :class="isRecording ? 'active' : 'inactive'" @click="$emit('rec')">
        <span class="rec-dot" :class="{ pulsing: isRecording }"></span>
        <span class="rec-label">{{ isRecording ? recordingSeconds + 's' : 'rec' }}</span>
      </div>
      <button class="icon-btn exit-btn" @click="$emit('quit')" title="Exit">✕</button>
    </div>
  </div>
</template>

<style scoped>
/* ── Single Row ── */
.single-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
}

.left-actions, .right-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.drag-space {
  -webkit-app-region: drag;
  flex: 1;
  height: 26px;
  cursor: grab;
}

.rec-pill {
  -webkit-app-region: no-drag;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px 3px 8px;
  border-radius: 20px;
  cursor: pointer;
  transition: all 0.2s ease;
  min-width: 52px;
}

.rec-pill.inactive {
  background: rgba(16, 185, 129, 0.10);
  border: 1px solid rgba(16, 185, 129, 0.20);
}

.rec-pill.inactive:hover {
  background: rgba(16, 185, 129, 0.18);
}

.rec-pill.inactive .rec-dot {
  background: var(--green);
  opacity: 1;
}

.rec-pill.inactive .rec-label {
  color: var(--green);
}

.rec-pill.active {
  background: rgba(239, 68, 68, 0.16);
  border: 1px solid rgba(239, 68, 68, 0.35);
}

.rec-pill.active:hover {
  background: rgba(239, 68, 68, 0.22);
}

.rec-pill.active .rec-dot {
  background: var(--red);
  opacity: 0.4;
}

.rec-pill.active .rec-label {
  color: var(--red);
}

.rec-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}

.rec-dot.pulsing {
  opacity: 1;
  animation: pulse-red 1.2s ease-in-out infinite;
}

.rec-label {
  font-size: 11px;
  font-weight: 500;
  text-transform: lowercase;
  font-variant-numeric: tabular-nums;
}

.exit-btn:hover {
  color: var(--red);
  background: rgba(239, 68, 68, 0.12);
}

/* ── Clear session button ── */
.clear-btn:hover {
  color: rgb(251, 191, 36);
  background: rgba(245, 158, 11, 0.12);
}

</style>
