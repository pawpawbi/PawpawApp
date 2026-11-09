<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { errorMessage } from '../errors';
import type {
  OpenResult,
  Project,
  RecentProject,
  RefreshStatus,
} from '../shared/types';
import { timeAgo } from '../time';

const emit = defineEmits<{ open: [project: Project]; published: [] }>();

const version = ref('');
const recents = ref<RecentProject[]>([]);
const busy = ref(false);
const error = ref('');
/** A published project refreshing in the background (by hand or on schedule), if any. */
const refreshing = ref<RefreshStatus | null>(null);

const unsubscribe = window.api.publish.onRefreshStatus(
  (status) => (refreshing.value = status),
);
onBeforeUnmount(unsubscribe);

onMounted(async () => {
  window.api.publish
    .refreshStatus()
    .then((status) => (refreshing.value = status))
    .catch(() => {});

  // Starts the Python sidecar now, so the first project opens without waiting for it.
  window.api.python
    .info()
    .catch((error) => console.error('Python sidecar unavailable:', error));

  [version.value, recents.value] = await Promise.all([
    window.api.getAppVersion(),
    window.api.projects.listRecent(),
  ]);
});

/** Runs a create or open action. `failure` prefixes the message if it throws. */
async function run(action: () => Promise<OpenResult>, failure: string) {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    const result = await action();
    if (result && 'project' in result) {
      emit('open', result.project);
    } else if (result) {
      error.value = result.error;
      recents.value = await window.api.projects.listRecent();
    }
  } catch (err) {
    error.value = `${failure} ${errorMessage(err)}`;
  } finally {
    busy.value = false;
  }
}

const createProject = () =>
  run(window.api.projects.create, "Couldn't create the project.");
const openProject = () =>
  run(window.api.projects.open, "Couldn't open the project.");
const openRecent = (recent: RecentProject) =>
  run(
    () => window.api.projects.openRecent(recent.path),
    "Couldn't open the project.",
  );
</script>

<template>
  <div class="splash">
    <section class="hero">
      <div class="brand">
        <img class="logo" src="/logo-dark.svg" alt="" />
        <h1>PawpawBI</h1>
        <p class="tagline">
          Turn your data into reports, with an assistant guiding each step.
        </p>
      </div>

      <div class="actions">
        <button class="action primary" :disabled="busy" @click="createProject">
          <span class="action-icon" aria-hidden="true">
            <svg class="icon" viewBox="0 0 24 24">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </span>
          <span class="action-text">
            <strong>New project</strong>
            <small>Start a blank report</small>
          </span>
        </button>
        <button class="action" :disabled="busy" @click="openProject">
          <span class="action-icon" aria-hidden="true">
            <svg class="icon" viewBox="0 0 24 24">
              <path
                d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"
              />
            </svg>
          </span>
          <span class="action-text">
            <strong>Open project</strong>
            <small>Browse for a .pawpaw file</small>
          </span>
        </button>
        <button class="action" :disabled="busy" @click="emit('published')">
          <span class="action-icon" aria-hidden="true">
            <svg class="icon" viewBox="0 0 24 24">
              <path d="M12 15V3M7 8l5-5 5 5M5 21h14" />
            </svg>
          </span>
          <span class="action-text">
            <strong>Published projects</strong>
            <small v-if="refreshing?.projectPath"
              >Refreshing “{{ refreshing.projectName }}”…</small
            >
            <small v-else>Refresh data, now or on a schedule</small>
          </span>
        </button>
      </div>

      <p class="version">Version {{ version }}</p>
    </section>

    <section class="recents">
      <h2>Recent projects</h2>
      <p v-if="error" class="box-error error" role="alert">{{ error }}</p>

      <ul v-if="recents.length" class="recent-list">
        <li v-for="recent in recents" :key="recent.path">
          <button class="recent" :disabled="busy" @click="openRecent(recent)">
            <span class="recent-initial" aria-hidden="true">{{
              recent.name.charAt(0)
            }}</span>
            <span class="recent-text">
              <strong>{{ recent.name }}</strong>
              <small :title="recent.path">{{ recent.path }}</small>
            </span>
            <time :datetime="recent.openedAt">{{
              timeAgo(recent.openedAt)
            }}</time>
          </button>
        </li>
      </ul>

      <div v-else class="empty">
        <strong>No recent projects</strong>
        <p>Projects you create or open will show up here.</p>
      </div>
    </section>
  </div>
</template>

<style scoped>
.splash {
  display: grid;
  grid-template-columns: minmax(360px, 5fr) 7fr;
  height: 100%;
}

.hero {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 40px;
  padding: 56px;
  background: var(--ink);
  color: var(--surface);
}

.logo {
  display: block;
  width: 64px;
  height: 64px;
  margin-bottom: 28px;
}

.hero h1 {
  font-size: 56px;
  letter-spacing: -0.02em;
}

.tagline {
  max-width: 30ch;
  margin: 14px 0 0;
  font-size: 16px;
  color: rgb(255 255 255 / 0.65);
}

.actions {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-width: 360px;
}

.action {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 14px 16px;
  border: 1px solid rgb(255 255 255 / 0.14);
  border-radius: var(--radius);
  background: rgb(255 255 255 / 0.04);
  color: var(--surface);
  text-align: left;
  transition:
    background 0.15s,
    border-color 0.15s,
    transform 0.15s;
}

.action:hover:not(:disabled) {
  background: rgb(255 255 255 / 0.09);
  border-color: rgb(255 255 255 / 0.24);
  transform: translateY(-1px);
}

.action.primary {
  border-color: var(--accent);
  background: var(--accent);
}

.action.primary:hover:not(:disabled) {
  background: var(--accent-hover);
  border-color: var(--accent-hover);
}

.action-icon {
  display: grid;
  place-items: center;
  flex: none;
  width: 36px;
  height: 36px;
  border-radius: var(--radius-sm);
  background: rgb(255 255 255 / 0.12);
}

.action-icon .icon {
  width: 20px;
  height: 20px;
}

.action-text {
  display: flex;
  flex-direction: column;
}

.action-text strong {
  font-family: var(--font-display);
  font-weight: var(--display-weight);
  font-size: 15px;
}

.action-text small {
  font-size: 13px;
  opacity: 0.7;
}

.version {
  margin: 0;
  font-size: 12px;
  color: rgb(255 255 255 / 0.4);
}

.recents {
  display: flex;
  flex-direction: column;
  min-width: 0;
  padding: 56px;
  overflow-y: auto;
}

.recents h2 {
  margin-bottom: 20px;
  font-size: 28px;
}

.error {
  margin: 0 0 16px;
}

.recent-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.recent {
  display: flex;
  align-items: center;
  gap: 14px;
  width: 100%;
  padding: 12px 16px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  box-shadow: var(--shadow-sm);
  text-align: left;
  transition:
    border-color 0.15s,
    box-shadow 0.15s;
}

.recent:hover:not(:disabled) {
  border-color: var(--ink-faint);
  box-shadow: var(--shadow-md);
}

.recent-initial {
  display: grid;
  place-items: center;
  flex: none;
  width: 38px;
  height: 38px;
  border-radius: var(--radius-sm);
  background: var(--accent-soft);
  color: var(--accent);
  font-family: var(--font-display);
  font-weight: var(--display-weight);
  font-size: 16px;
  text-transform: uppercase;
}

.recent-text {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
}

.recent-text strong {
  font-weight: 600;
}

.recent-text small {
  overflow: hidden;
  color: var(--ink-faint);
  font-size: 12px;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.recent time {
  flex: none;
  color: var(--ink-muted);
  font-size: 12px;
}

.empty {
  padding: 40px 24px;
  border: 1px dashed var(--border);
  border-radius: var(--radius);
  color: var(--ink-muted);
  text-align: center;
}

.empty strong {
  color: var(--ink);
}

.empty p {
  margin: 4px 0 0;
}
</style>
