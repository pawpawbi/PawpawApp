<script setup lang="ts">
// Sets when a published project refreshes by itself (Published projects): weekly on chosen
// days, or monthly on chosen days counted from the start or the end of the month, at one or
// more times. Checked again by the main process (src/shared/schedule.ts).
import { computed, ref } from 'vue';
import {
  checkSchedule,
  dayName,
  describeSchedule,
  MAX_TIMES,
  monthDayLabel,
  nextRun,
  WEEKDAYS,
} from '../shared/schedule';
import type { RefreshSchedule } from '../shared/types';

const props = defineProps<{
  schedule: RefreshSchedule | null;
  saving: boolean;
}>();
const emit = defineEmits<{
  save: [schedule: RefreshSchedule];
  remove: [];
  cancel: [];
}>();

const repeat = ref<RefreshSchedule['repeat']>(
  props.schedule?.repeat ?? 'weekly',
);
// Each kind keeps its own days, so switching back and forth loses nothing.
const weekDays = ref<number[]>(
  props.schedule?.repeat === 'weekly' ? [...props.schedule.days] : [1],
);
const monthDays = ref<number[]>(
  props.schedule?.repeat === 'monthly' ? [...props.schedule.days] : [1],
);
const times = ref<string[]>(
  props.schedule ? [...props.schedule.times] : ['06:00'],
);

const MONTH_DAYS = Array.from({ length: 31 }, (_, i) => i + 1);
const FROM_END = Array.from({ length: 10 }, (_, i) => -(i + 1));

const days = computed(() =>
  repeat.value === 'weekly' ? weekDays.value : monthDays.value,
);

function toggle(day: number) {
  const list = repeat.value === 'weekly' ? weekDays : monthDays;
  list.value = list.value.includes(day)
    ? list.value.filter((d) => d !== day)
    : [...list.value, day];
}

function addTime() {
  // The hour after the latest one, so each new time starts out different.
  const last = [...times.value].sort().at(-1) ?? '05:00';
  const hour = (Number(last.slice(0, 2)) + 1) % 24;
  times.value = [...times.value, `${String(hour).padStart(2, '0')}:00`];
}

const removeTime = (i: number) =>
  (times.value = times.value.filter((_, j) => j !== i));

/** The schedule as it stands, or what's wrong with it. */
const checked = computed(() => {
  try {
    return {
      schedule: checkSchedule({
        repeat: repeat.value,
        days: days.value,
        times: times.value,
      }),
      problem: '',
    };
  } catch (e) {
    return { schedule: null, problem: (e as Error).message };
  }
});

const summary = computed(() => {
  const schedule = checked.value.schedule;
  if (!schedule) return '';
  const next = nextRun(schedule, new Date());
  return next
    ? `${describeSchedule(schedule)}. Next: ${next.toLocaleString(undefined, {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      })}.`
    : describeSchedule(schedule);
});

function save() {
  if (checked.value.schedule) emit('save', checked.value.schedule);
}
</script>

<template>
  <div class="schedule-editor">
    <fieldset class="group">
      <legend>Repeat</legend>
      <div class="segmented" role="radiogroup" aria-label="Repeat">
        <button
          type="button"
          role="radio"
          :aria-checked="repeat === 'weekly'"
          :class="{ on: repeat === 'weekly' }"
          @click="repeat = 'weekly'"
        >
          Weekly
        </button>
        <button
          type="button"
          role="radio"
          :aria-checked="repeat === 'monthly'"
          :class="{ on: repeat === 'monthly' }"
          @click="repeat = 'monthly'"
        >
          Monthly
        </button>
      </div>
    </fieldset>

    <fieldset v-if="repeat === 'weekly'" class="group">
      <legend>On</legend>
      <div class="chips">
        <button
          v-for="d in WEEKDAYS"
          :key="d"
          type="button"
          class="chip"
          :class="{ on: weekDays.includes(d) }"
          :aria-pressed="weekDays.includes(d)"
          @click="toggle(d)"
        >
          {{ dayName(d).slice(0, 3) }}
        </button>
      </div>
    </fieldset>

    <template v-else>
      <fieldset class="group">
        <legend>On these days of the month</legend>
        <div class="chips days">
          <button
            v-for="d in MONTH_DAYS"
            :key="d"
            type="button"
            class="chip"
            :class="{ on: monthDays.includes(d) }"
            :aria-pressed="monthDays.includes(d)"
            :title="`The ${monthDayLabel(d)}`"
            @click="toggle(d)"
          >
            {{ d }}
          </button>
        </div>
      </fieldset>
      <fieldset class="group">
        <legend>Or counting back from the end of the month</legend>
        <div class="chips days">
          <button
            v-for="d in FROM_END"
            :key="d"
            type="button"
            class="chip"
            :class="{ on: monthDays.includes(d) }"
            :aria-pressed="monthDays.includes(d)"
            :title="`The ${monthDayLabel(d)}`"
            @click="toggle(d)"
          >
            −{{ -d }}
          </button>
        </div>
        <p class="hint">
          −1 is the last day of the month, −2 the day before, and so on. In a
          shorter month, a day it doesn't have (such as the 31st) means its last
          day.
        </p>
      </fieldset>
    </template>

    <fieldset class="group">
      <legend>At</legend>
      <div class="times">
        <span v-for="(_, i) in times" :key="i" class="time">
          <input
            v-model="times[i]"
            type="time"
            required
            :aria-label="`Time ${i + 1}`"
          />
          <button
            v-if="times.length > 1"
            type="button"
            class="btn-link"
            :aria-label="`Remove ${times[i]}`"
            @click="removeTime(i)"
          >
            Remove
          </button>
        </span>
        <button
          v-if="times.length < MAX_TIMES"
          type="button"
          class="btn-ghost add"
          @click="addTime"
        >
          Add a time
        </button>
      </div>
      <p class="hint">In this computer's time.</p>
    </fieldset>

    <p v-if="checked.problem" class="problem">{{ checked.problem }}</p>
    <p v-else class="summary">{{ summary }}</p>

    <div class="actions">
      <button
        class="btn-primary"
        :disabled="!checked.schedule || saving"
        @click="save"
      >
        {{ saving ? 'Saving…' : 'Save schedule' }}
      </button>
      <button class="btn-ghost" :disabled="saving" @click="emit('cancel')">
        Cancel
      </button>
      <button
        v-if="schedule"
        class="btn-link danger remove"
        :disabled="saving"
        @click="emit('remove')"
      >
        Stop refreshing on a schedule
      </button>
    </div>
  </div>
</template>

<style scoped>
.schedule-editor {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 14px 18px 16px;
  border-top: 1px solid var(--border);
  background: var(--bg);
}

.group {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  border: none;
}

legend {
  margin-bottom: 6px;
  padding: 0;
  color: var(--ink-muted);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.segmented {
  display: inline-flex;
  align-self: flex-start;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface);
}

.segmented button {
  padding: 5px 14px;
  border: none;
  background: none;
  color: var(--ink-muted);
}

.segmented button + button {
  border-left: 1px solid var(--border);
}

.segmented button.on {
  background: var(--ink);
  color: var(--surface);
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.chip {
  min-width: 44px;
  padding: 4px 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface);
  color: var(--ink-muted);
  font-size: 13px;
}

.chips.days .chip {
  min-width: 34px;
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
}

.chip:hover {
  border-color: var(--ink);
}

.chip.on {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 600;
}

.times {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 14px;
}

.time {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.time input {
  padding: 4px 6px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface);
  color: var(--ink);
  font-family: var(--font-mono);
  font-size: 13px;
}

.add {
  padding: 4px 10px;
  font-size: 13px;
}

.hint {
  margin: 0;
  color: var(--ink-muted);
  font-size: 12px;
}

.summary,
.problem {
  margin: 0;
  font-size: 13px;
}

.summary {
  color: var(--ink);
}

.problem {
  color: var(--danger);
}

.actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.actions .remove {
  margin-left: auto;
}
</style>
