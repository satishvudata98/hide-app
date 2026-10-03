<script setup>
import { computed } from 'vue'

const props = defineProps({
  canAnswer: Boolean,
  canAnalyze: Boolean,
  canPaste: Boolean,
  pasteOpen: Boolean,
  listen: { type: String, default: 'off' }, // 'off' | 'starting' | 'on' | 'paused'
  connection: { type: String, default: 'offline' }, // live transcript socket state
  level: { type: Number, default: 0 }, // input loudness 0..1 while listening
  hasPending: Boolean, // heard text waiting for the next answer
  hasHistory: Boolean,
  settingsOpen: Boolean,
  clickThrough: Boolean
})

defineEmits(['answer', 'analyze', 'toggle-paste', 'toggle-settings', 'reset-block', 'clear-session', 'toggle-listen', 'quit'])

const isOn = computed(() => props.listen === 'on')
const isDegraded = computed(() => isOn.value && props.connection !== 'connected')
const listenLabel = computed(() => {
  if (props.listen === 'starting') return '…'
  if (props.listen === 'paused') return 'paused'
  if (!isOn.value) return 'listen'
  return isDegraded.value ? props.connection : 'live'
})
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
      <span class="badge" v-if="clickThrough" title="Ctrl+Shift+X to turn off">click-through</span>
      <button class="icon-btn" v-if="hasPending" @click="$emit('reset-block')" title="Discard what was heard so far">↺</button>
      <button class="icon-btn clear-btn" v-if="hasHistory" @click="$emit('clear-session')" title="Clear session history">⊘</button>
      <div
        class="rec-pill"
        :class="[isOn ? 'active' : 'inactive', { degraded: isDegraded }]"
        @click="$emit('toggle-listen')"
        title="Ctrl+Shift+Space: pause / resume listening"
      >
        <span class="rec-dot" :class="{ pulsing: isOn && !isDegraded }"></span>
        <span class="rec-label">{{ listenLabel }}</span>
        <span class="level-meter" v-if="isOn" title="Input level">
          <span class="level-fill" :style="{ width: Math.round(level * 100) + '%' }"></span>
        </span>
      </div>
      <button class="icon-btn" :class="{ active: settingsOpen }" @click="$emit('toggle-settings')" title="Settings">⚙</button>
      <button class="icon-btn exit-btn" @click="$emit('quit')" title="Exit">✕</button>
    </div>
  </div>
</template>

<style scoped>
.badge {
  font-size: 10px;
  color: rgb(251, 191, 36);
  border: 1px solid rgba(245, 158, 11, 0.35);
  border-radius: 10px;
  padding: 1px 8px;
}

.level-meter {
  width: 28px;
  height: 4px;
  border-radius: 2px;
  background: rgba(239, 68, 68, 0.18);
  overflow: hidden;
}

.level-fill {
  display: block;
  height: 100%;
  background: var(--red);
  transition: width 0.1s linear;
}

.icon-btn.active {
  color: var(--text-primary);
  background: rgba(255, 255, 255, 0.08);
}

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

/* Listening, but the live transcript is (re)connecting */
.rec-pill.degraded {
  background: rgba(245, 158, 11, 0.14);
  border-color: rgba(245, 158, 11, 0.35);
}

.rec-pill.degraded .rec-dot {
  background: rgb(251, 191, 36);
  opacity: 1;
}

.rec-pill.degraded .rec-label {
  color: rgb(251, 191, 36);
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
