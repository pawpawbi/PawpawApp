<script setup lang="ts">
// The warning icon in the top bar, shown while the project has errors: it flashes slowly,
// lists them when hovered and opens the Errors page when clicked.
import { computed } from 'vue';
import { errorLabel, errorSummary } from '../shared/project-errors';
import type { ProjectError } from '../shared/types';

// `active`: the Errors page is showing, so the icon stops flashing and the list isn't needed.
const props = defineProps<{ errors: ProjectError[]; active?: boolean }>();
defineEmits<{ open: [] }>();

/** The most listed when hovering; the Errors page has them all. */
const MAX_SHOWN = 5;
const shown = computed(() => props.errors.slice(0, MAX_SHOWN));
const count = computed(() =>
  props.errors.length === 1 ? '1 error' : `${props.errors.length} errors`,
);
</script>

<template>
  <div class="errors-indicator" :class="{ active }">
    <button
      class="warning"
      :aria-label="`${count} in this project. Show them`"
      aria-describedby="errors-list"
      @click="$emit('open')"
    >
      <svg class="icon" viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"
        />
        <path d="M12 9v4M12 17h.01" />
      </svg>
      <span class="count">{{ errors.length }}</span>
    </button>
    <div id="errors-list" class="popover" role="tooltip" @click="$emit('open')">
      <p class="popover-title">{{ count }} in this project</p>
      <ul>
        <li v-for="(e, i) in shown" :key="i">
          <span class="label">{{ errorLabel(e) }}</span>
          <strong>{{ errorSummary(e) }}</strong>
          <span class="message">{{ e.message }}</span>
        </li>
      </ul>
      <p v-if="errors.length > MAX_SHOWN" class="more">
        And {{ errors.length - MAX_SHOWN }} more.
      </p>
      <p class="hint">Click to see them all and fix them with the assistant.</p>
    </div>
  </div>
</template>

<style scoped>
.errors-indicator {
  position: relative;
}

.warning {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 5px 8px;
  border: none;
  border-radius: var(--radius-sm);
  background: none;
  color: var(--danger);
  animation: flash 2.4s ease-in-out infinite;
}

.warning:hover,
.active .warning {
  background: var(--danger-soft);
  animation: none;
}

.warning .icon {
  width: 18px;
  height: 18px;
}

.count {
  font-family: var(--font-mono);
  font-size: 13px;
  font-weight: 600;
}

@keyframes flash {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.3;
  }
}

@media (prefers-reduced-motion: reduce) {
  .warning {
    animation: none;
  }
}

/* The list, below the icon, while it's hovered (or focused from the keyboard). */
.popover {
  display: none;
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  z-index: 30;
  width: 380px;
  padding: 12px 14px;
  border: 1px solid var(--ink);
  border-radius: var(--radius);
  background: var(--surface);
  box-shadow: var(--shadow-md);
  white-space: normal;
  cursor: pointer;
}

/* Bridges the gap above the list, so moving onto it keeps it open. */
.popover::before {
  content: '';
  position: absolute;
  inset: -9px 0 auto;
  height: 9px;
}

.errors-indicator:not(.active):hover .popover,
.errors-indicator:not(.active):has(.warning:focus-visible) .popover {
  display: block;
}

.popover-title {
  margin: 0 0 6px;
  font-family: var(--font-display);
  font-size: 15px;
  font-weight: var(--display-weight);
}

.popover ul {
  margin: 0;
  padding: 0;
  list-style: none;
}

.popover li {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 8px 0;
  border-top: 1px solid var(--border);
}

.label {
  color: var(--ink-faint);
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.popover strong {
  font-size: 13px;
  font-weight: 600;
  overflow-wrap: anywhere;
}

.message {
  display: -webkit-box;
  overflow: hidden;
  color: var(--ink-muted);
  font-family: var(--font-mono);
  font-size: 12px;
  overflow-wrap: anywhere;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.more,
.hint {
  margin: 0;
  padding-top: 8px;
  border-top: 1px solid var(--border);
  color: var(--ink-muted);
  font-size: 12px;
}

.more + .hint {
  padding-top: 2px;
  border-top: none;
}
</style>
