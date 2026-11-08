<script setup lang="ts">
// A progress bar for an upload to PawpawBI, following the main process's publish:progress
// events (src/published.ts). Shows nothing until an upload starts.
import { computed, onBeforeUnmount, ref } from 'vue';
import type { PublishProgress } from '../shared/types';

const progress = ref<PublishProgress | null>(null);
const stop = window.api.publish.onProgress((p) => (progress.value = p));
onBeforeUnmount(stop);

const size = (bytes: number) =>
  bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

const share = computed(() => {
  const p = progress.value;
  if (!p || p.stage !== 'uploading' || !p.total) return null;
  return Math.min(1, p.sent / p.total);
});

const label = computed(() => {
  const p = progress.value;
  if (!p) return '';
  if (p.stage === 'preparing') return 'Getting ready to upload…';
  if (p.stage === 'finishing') return 'Finishing…';
  return `Uploading ${size(p.sent)} of ${size(p.total)}`;
});
</script>

<template>
  <div v-if="progress" class="upload-progress">
    <div
      class="track"
      role="progressbar"
      aria-label="Upload progress"
      :aria-valuenow="share === null ? undefined : Math.round(share * 100)"
      aria-valuemin="0"
      aria-valuemax="100"
    >
      <div
        class="fill"
        :class="{ busy: share === null }"
        :style="share === null ? undefined : { width: `${share * 100}%` }"
      ></div>
    </div>
    <small>
      {{ label }}
      <template v-if="share !== null">
        · {{ Math.round(share * 100) }}%</template
      >
    </small>
  </div>
</template>

<style scoped>
.upload-progress {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.track {
  height: 8px;
  overflow: hidden;
  border-radius: var(--radius-sm);
  background: var(--surface-muted);
}

.fill {
  height: 100%;
  border-radius: var(--radius-sm);
  background: var(--accent);
  transition: width 0.2s ease;
}

/* No byte count yet (getting ready, finishing): a sliding bar. */
.fill.busy {
  width: 30%;
  animation: slide 1.2s ease-in-out infinite;
}

@keyframes slide {
  from {
    transform: translateX(-100%);
  }
  to {
    transform: translateX(340%);
  }
}

small {
  color: var(--ink-muted);
  font-variant-numeric: tabular-nums;
}
</style>
