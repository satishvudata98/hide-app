<script setup>
import { ref, onMounted } from 'vue'

const emit = defineEmits(['complete'])

const apiKey = ref('')
const prompt = ref('')

onMounted(() => {
  apiKey.value = localStorage.getItem('parakeet-api-key') || ''
  prompt.value = localStorage.getItem('parakeet-prompt') || 'You are a helpful assistant. Answer concisely and clearly based on the user question/transcript provided.'
})

function saveAndContinue() {
  if (!apiKey.value.trim()) return
  localStorage.setItem('parakeet-api-key', apiKey.value.trim())
  localStorage.setItem('parakeet-prompt', prompt.value.trim())
  emit('complete')
}
</script>

<template>
  <div class="setup-wrap">
    <div class="setup-card glass">
      <h2>Setup</h2>
      <p class="hint">Enter your OpenAI API key to get started.</p>

      <div class="field">
        <label>API Key</label>
        <input
          v-model="apiKey"
          type="password"
          placeholder="sk-..."
          autocomplete="off"
          class="input"
          @keyup.enter="saveAndContinue"
        />
      </div>

      <div class="field">
        <label>System Prompt</label>
        <textarea
          v-model="prompt"
          placeholder="Instructions for the AI assistant..."
          class="input textarea"
        ></textarea>
      </div>

      <button
        class="go-btn"
        :disabled="!apiKey.trim()"
        @click="saveAndContinue"
      >
        Continue
      </button>
    </div>
  </div>
</template>

<style scoped>
.setup-wrap {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}

.setup-card {
  width: min(100%, 420px);
  padding: 24px;
}

.setup-card h2 {
  font-size: 18px;
  font-weight: 600;
  margin-bottom: 4px;
}

.hint {
  color: var(--muted);
  font-size: 12px;
  margin-bottom: 20px;
}

.field {
  margin-bottom: 14px;
}

.field label {
  display: block;
  font-size: 11px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--muted);
  margin-bottom: 6px;
}

.input {
  width: 100%;
  background: rgba(0, 0, 0, 0.3);
  border: 1px solid var(--glass-border);
  border-radius: 10px;
  color: var(--text);
  outline: none;
  transition: border-color 0.2s;
}

.input:not(.textarea) {
  height: 40px;
  padding: 0 12px;
}

.textarea {
  min-height: 80px;
  padding: 10px 12px;
  resize: vertical;
  line-height: 1.5;
}

.input:focus {
  border-color: rgba(158, 241, 91, 0.4);
}

.go-btn {
  width: 100%;
  height: 40px;
  border: none;
  border-radius: 10px;
  background: linear-gradient(180deg, var(--accent), #7ad14d);
  color: #0a0e08;
  font-weight: 600;
  font-size: 13px;
  cursor: pointer;
  transition: opacity 0.2s, transform 0.15s;
  margin-top: 6px;
}

.go-btn:hover:not(:disabled) {
  transform: translateY(-1px);
}

.go-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
</style>
