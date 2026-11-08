<script setup lang="ts">
// How long something has been running, in seconds, and after a few seconds a Stop button.
// Shown while connecting to or loading from a data source, and on the assistant's running
// steps. `canStop` false hides Stop (a load whose data has arrived is processed to the end, and
// the chat has its own Stop); `showAfter` hides the count for quick steps.
import { onBeforeUnmount, ref } from 'vue';

const STOP_AFTER_SECONDS = 5;

withDefaults(defineProps<{ canStop?: boolean; showAfter?: number }>(), {
  canStop: true,
  showAfter: 0,
});
defineEmits<{ stop: [] }>();

const started = Date.now();
const seconds = ref(0);
const stopping = ref(false);
const timer = window.setInterval(() => {
  seconds.value = Math.floor((Date.now() - started) / 1000);
}, 250);
onBeforeUnmount(() => window.clearInterval(timer));

const elapsed = (s: number) =>
  s < 60
    ? `${s}s`
    : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
</script>

<template>
  <span v-if="seconds >= showAfter" class="running-timer">
    <span class="elapsed" aria-live="off">{{ elapsed(seconds) }}</span>
    <button
      v-if="canStop && seconds >= STOP_AFTER_SECONDS"
      type="button"
      class="stop"
      :disabled="stopping"
      @click="
        stopping = true;
        $emit('stop');
      "
    >
      {{ stopping ? 'Stopping…' : 'Stop' }}
    </button>
  </span>
</template>

<style scoped>
.running-timer {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.elapsed {
  color: var(--ink-faint);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}

.stop {
  padding: 3px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface);
  color: var(--danger);
  font-size: 13px;
  font-weight: 600;
}

.stop:hover:not(:disabled) {
  border-color: var(--danger);
}

.stop:disabled {
  opacity: 0.6;
}
</style>
