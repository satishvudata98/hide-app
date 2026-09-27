<script setup>
import { ref, onMounted } from 'vue'

const props = defineProps({ disabled: Boolean })
const emit = defineEmits(['submit', 'close'])

const text = ref('')
const textareaEl = ref(null)

onMounted(() => textareaEl.value?.focus())

function submit() {
  const value = text.value.trim()
  if (!value || props.disabled) return
  emit('submit', value)
  text.value = ''
}
</script>

<template>
  <div class="paste-row">
    <div class="paste-header">
      <span class="paste-title">paste text / code</span>
      <button class="icon-btn" @click="$emit('close')" title="Close">✕</button>
    </div>
    <textarea
      ref="textareaEl"
      class="paste-textarea"
      v-model="text"
      placeholder="Paste code or type a question here..."
      @keydown.ctrl.enter.prevent="submit"
      rows="4"
    ></textarea>
    <div class="paste-footer">
      <span class="paste-hint">Ctrl+Enter to submit</span>
      <button class="action-btn indigo" @click="submit" :disabled="!text.trim() || disabled">
        <span>analyze</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
/* ── Paste text panel ── */
.paste-row {
  padding: 6px 10px 10px;
  border-top: 1px solid rgba(255, 255, 255, 0.04);
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.paste-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 2px;
}

.paste-title {
  font-size: 10px;
  color: var(--text-hint);
  text-transform: lowercase;
  font-weight: 500;
}

.paste-textarea {
  width: 100%;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.10);
  border-radius: 6px;
  color: var(--text-primary);
  font-family: 'SF Mono', ui-monospace, 'Cascadia Code', 'Consolas', monospace;
  font-size: 11px;
  line-height: 1.5;
  padding: 6px 8px;
  outline: none;
  resize: vertical;
  box-sizing: border-box;
  -webkit-app-region: no-drag;
}

.paste-textarea:focus {
  border-color: rgba(245, 158, 11, 0.45);
  background: rgba(245, 158, 11, 0.04);
}

.paste-textarea::placeholder {
  color: var(--text-hint);
}

.paste-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.paste-hint {
  font-size: 10px;
  color: var(--text-hint);
}
</style>
