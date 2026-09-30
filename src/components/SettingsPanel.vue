<script setup>
import { ref, onMounted, onUnmounted } from 'vue'

const props = defineProps({
  settings: { type: Object, required: true } // { micDeviceId, systemAudio, includeMic, autoListen, answerModel, answerStyle }
})
const emit = defineEmits(['update', 'close'])

const mics = ref([])
const modelDraft = ref(props.settings.answerModel)

async function listMics() {
  const devices = await navigator.mediaDevices.enumerateDevices()
  return devices.filter((d) => d.kind === 'audioinput' && d.deviceId && !['default', 'communications'].includes(d.deviceId))
}

// Chromium hides device names until the page has opened a mic once, so open
// (and immediately release) one if the list comes back unnamed.
async function loadMics() {
  let found = await listMics()
  if (!found.length || found.every((d) => !d.label)) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      stream.getTracks().forEach((track) => track.stop())
      found = await listMics()
    } catch (err) {
      console.warn('[settings] could not list microphones:', err.message)
    }
  }
  mics.value = found
}

function saveModel() {
  const value = modelDraft.value.trim()
  if (value !== props.settings.answerModel) emit('update', 'answerModel', value)
}

onMounted(() => {
  loadMics()
  navigator.mediaDevices.addEventListener('devicechange', loadMics)
})
onUnmounted(() => navigator.mediaDevices.removeEventListener('devicechange', loadMics))
</script>

<template>
  <div class="settings-row">
    <div class="settings-header">
      <span class="settings-title">settings</span>
      <button class="icon-btn" @click="$emit('close')" title="Close">✕</button>
    </div>

    <label class="field">
      <span class="field-label">system audio</span>
      <input type="checkbox" :checked="settings.systemAudio" @change="emit('update', 'systemAudio', $event.target.checked)" />
      <span class="field-hint">what the interviewer says through your speakers/earphones</span>
    </label>

    <label class="field">
      <span class="field-label">mic too</span>
      <input type="checkbox" :checked="settings.includeMic" @change="emit('update', 'includeMic', $event.target.checked)" />
      <span class="field-hint">only for in-person or phone interviews (it also hears you)</span>
    </label>

    <label class="field" v-if="settings.includeMic">
      <span class="field-label">mic</span>
      <select class="field-input" :value="settings.micDeviceId" @change="emit('update', 'micDeviceId', $event.target.value)">
        <option value="">Windows default</option>
        <option v-for="mic in mics" :key="mic.deviceId" :value="mic.deviceId">
          {{ mic.label || 'Microphone ' + mic.deviceId.slice(0, 6) }}
        </option>
      </select>
    </label>

    <label class="field">
      <span class="field-label">auto listen</span>
      <input type="checkbox" :checked="settings.autoListen" @change="emit('update', 'autoListen', $event.target.checked)" />
      <span class="field-hint">start listening when the app opens</span>
    </label>

    <label class="field">
      <span class="field-label">model</span>
      <input
        class="field-input"
        v-model="modelDraft"
        placeholder="gpt-4o"
        @blur="saveModel"
        @keydown.enter="saveModel"
      />
    </label>

    <div class="field">
      <span class="field-label">answers</span>
      <div class="segmented">
        <button
          v-for="style in ['brief', 'detailed']"
          :key="style"
          :class="{ selected: settings.answerStyle === style }"
          @click="emit('update', 'answerStyle', style)"
        >{{ style }}</button>
      </div>
    </div>

    <div class="field-hint">Audio changes restart listening right away.</div>
  </div>
</template>

<style scoped>
.settings-row {
  padding: 6px 10px 10px;
  border-top: 1px solid rgba(255, 255, 255, 0.04);
  display: flex;
  flex-direction: column;
  gap: 6px;
  -webkit-app-region: no-drag;
}

.settings-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.settings-title,
.field-label {
  font-size: 10px;
  color: var(--text-hint);
  text-transform: lowercase;
  font-weight: 500;
}

.field {
  display: flex;
  align-items: center;
  gap: 8px;
}

.field-label {
  width: 80px;
  flex-shrink: 0;
}

.field-input {
  flex: 1;
  height: 24px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.10);
  border-radius: 6px;
  color: var(--text-primary);
  font-size: 11px;
  padding: 0 8px;
  outline: none;
}

.field-input:focus {
  border-color: rgba(99, 102, 241, 0.45);
}

.field-input option {
  background: #16161d;
}

.field-hint {
  font-size: 10px;
  color: var(--text-hint);
}

.segmented {
  display: flex;
  border: 1px solid rgba(255, 255, 255, 0.10);
  border-radius: 6px;
  overflow: hidden;
}

.segmented button {
  background: none;
  border: none;
  color: var(--text-secondary);
  font-size: 11px;
  padding: 3px 12px;
  cursor: pointer;
}

.segmented button.selected {
  background: var(--indigo-dim);
  color: var(--indigo);
}
</style>
