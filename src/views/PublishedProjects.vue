<script setup lang="ts">
// Every project on this computer that's published to PawpawBI, with a button to refresh each
// report's data and a schedule to refresh it by itself. A refresh works on a copy of the project
// in the background: its sources are loaded again, the new data uploaded and the project saved
// (src/published.ts, src/scheduled-refresh.ts). Scheduled ones run while PawpawBI is open or in
// the system tray.
import { onBeforeUnmount, onMounted, ref } from 'vue';
import AccountPanel from '../components/AccountPanel.vue';
import RunningTimer from '../components/RunningTimer.vue';
import ScheduleEditor from '../components/ScheduleEditor.vue';
import UploadProgress from '../components/UploadProgress.vue';
import { errorMessage } from '../errors';
import { plain } from '../plain';
import { openReport, orgLabel, visibilityLabel } from '../report-access';
import { describeSchedule, nextRun } from '../shared/schedule';
import type {
  AccountState,
  PublishedProject,
  RefreshSchedule,
  RefreshStatus,
} from '../shared/types';
import { timeAgo } from '../time';

const emit = defineEmits<{ back: [] }>();

const projects = ref<PublishedProject[] | null>(null);
const account = ref<AccountState | null>(null);
const accountPanel = ref<InstanceType<typeof AccountPanel> | null>(null);
const status = ref<RefreshStatus | null>(null);
/** The project whose schedule is being edited. */
const editing = ref<string | null>(null);
const saving = ref(false);
const startAtLogin = ref(false);
const error = ref('');
const notice = ref('');

const reload = async () => {
  projects.value = await window.api.publish.list().catch(() => projects.value);
};

onMounted(async () => {
  try {
    [projects.value, status.value, startAtLogin.value] = await Promise.all([
      window.api.publish.list(),
      window.api.publish.refreshStatus(),
      window.api.publish.getStartAtLogin(),
    ]);
  } catch (e) {
    error.value = `Couldn't load the published projects. ${errorMessage(e)}`;
  }
});

// A refresh's progress, whether started here or by its schedule. When one ends, the list shows
// how it went.
const unsubscribe = window.api.publish.onRefreshStatus((next) => {
  const ended = status.value?.projectPath && !next.projectPath;
  status.value = next;
  if (ended) void reload();
});
onBeforeUnmount(unsubscribe);

const refreshing = (p: PublishedProject) =>
  status.value?.projectPath === p.projectPath;

async function open(project: PublishedProject) {
  error.value = (await openReport(project)) ?? '';
}

async function refresh(project: PublishedProject) {
  error.value = '';
  notice.value = '';
  try {
    const updated = await window.api.publish.refresh(project.projectPath);
    notice.value = updated.lastError
      ? ''
      : `Refreshed "${updated.projectName}". The published report shows the new data.`;
  } catch (e) {
    error.value = `Couldn't refresh "${project.projectName}". ${errorMessage(e)}`;
    await accountPanel.value?.reload();
  } finally {
    await reload();
  }
}

/** "Every Monday at 06:00 · next Mon 16 Nov, 06:00" */
function scheduleText(schedule: RefreshSchedule) {
  const next = nextRun(schedule, new Date());
  const when = next?.toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
  return when
    ? `${describeSchedule(schedule)} · next ${when}`
    : describeSchedule(schedule);
}

async function saveSchedule(
  project: PublishedProject,
  schedule: RefreshSchedule | null,
) {
  saving.value = true;
  error.value = '';
  notice.value = '';
  try {
    projects.value = await window.api.publish.setSchedule(
      project.projectPath,
      schedule && plain(schedule),
    );
    editing.value = null;
    // The first schedule turns on starting with Windows (unless it was turned off).
    startAtLogin.value = await window.api.publish.getStartAtLogin();
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    saving.value = false;
  }
}

async function changeStartAtLogin(event: Event) {
  const on = (event.target as HTMLInputElement).checked;
  try {
    startAtLogin.value = await window.api.publish.setStartAtLogin(on);
  } catch (e) {
    error.value = errorMessage(e);
  }
}

async function forget(project: PublishedProject) {
  if (
    !window.confirm(
      `Take "${project.projectName}" off this list? Its report stays on PawpawBI, and the project is listed again if you open it while it's still published.`,
    )
  ) {
    return;
  }
  error.value = '';
  notice.value = '';
  try {
    projects.value = await window.api.publish.forget(project.projectPath);
  } catch (e) {
    error.value = errorMessage(e);
  }
}

async function addFiles() {
  error.value = '';
  try {
    projects.value = await window.api.publish.addFiles();
  } catch (e) {
    error.value = errorMessage(e);
    projects.value = await window.api.publish
      .list()
      .catch(() => projects.value);
  }
}
</script>

<template>
  <div class="published-page">
    <div class="content">
      <button class="btn-link back" @click="emit('back')">← Projects</button>
      <header class="head">
        <div>
          <h2>Published projects</h2>
          <p class="hint">
            Refresh the data on reports you've published to PawpawBI, now or on
            a schedule. Each project's sources are loaded again, the new data is
            uploaded and the project is saved. It happens in the background, so
            you can keep working.
          </p>
        </div>
        <button class="btn-ghost" @click="addFiles">Add a project…</button>
      </header>

      <section class="panel">
        <AccountPanel ref="accountPanel" @changed="account = $event" />
      </section>

      <section class="panel background">
        <label class="check">
          <input
            type="checkbox"
            :checked="startAtLogin"
            @change="changeStartAtLogin"
          />
          Start PawpawBI in the system tray when I sign in to Windows
        </label>
        <p class="hint">
          Scheduled refreshes run while PawpawBI is open or in the system tray:
          closing its window leaves it running there (right-click its icon to
          quit). A refresh missed while it wasn't running happens once, as soon
          as it is. A project that's open waits until you close it.
        </p>
      </section>

      <p v-if="error" class="box-error" role="alert">{{ error }}</p>
      <p v-if="notice" class="box-notice" role="status">{{ notice }}</p>

      <p v-if="!projects" class="hint">Loading…</p>
      <div v-else-if="!projects.length" class="empty">
        <strong>No published projects yet</strong>
        <p>
          Publish a project's report to PawpawBI from its Publish page, and it
          shows up here. Published projects that aren't listed can be added with
          Add a project.
        </p>
      </div>
      <ul v-else class="list">
        <li v-for="p in projects" :key="p.reportId" class="item">
          <div class="item-text">
            <strong>{{ p.projectName }}</strong>
            <a
              :href="p.url"
              target="_blank"
              rel="noreferrer"
              @click.prevent="open(p)"
              >{{ p.url }}</a
            >
            <small v-if="p.org || p.visibility">
              <template v-if="p.org">{{ orgLabel(p.org) }}</template>
              <template v-if="p.org && p.visibility"> · </template>
              <template v-if="p.visibility">{{
                visibilityLabel(p.visibility, p.org)
              }}</template>
            </small>
            <small :title="p.projectPath">
              {{ p.projectPath }}
              <template v-if="p.refreshedAt">
                · data updated {{ timeAgo(p.refreshedAt) }}</template
              >
            </small>
            <small class="schedule">
              <template v-if="p.schedule">{{
                scheduleText(p.schedule)
              }}</template>
              <template v-else>Not refreshed on a schedule</template>
              ·
              <button
                class="btn-link"
                :aria-expanded="editing === p.projectPath"
                @click="
                  editing = editing === p.projectPath ? null : p.projectPath
                "
              >
                {{ p.schedule ? 'Change schedule' : 'Set a schedule' }}
              </button>
            </small>
            <p v-if="refreshing(p)" class="progress">
              {{ status?.scheduled ? 'Scheduled refresh: ' : ''
              }}{{ status?.message }}
              <RunningTimer :can-stop="false" />
            </p>
            <p v-else-if="p.lastError" class="item-error">{{ p.lastError }}</p>
            <UploadProgress
              v-if="refreshing(p)"
              :given="status?.upload ?? null"
            />
          </div>
          <div class="item-actions">
            <button
              class="btn-primary"
              :disabled="!!status?.projectPath || !account?.email"
              :title="
                !account?.email
                  ? 'Sign in to refresh'
                  : status?.projectPath && !refreshing(p)
                    ? `Wait for “${status.projectName}” to finish refreshing`
                    : ''
              "
              @click="refresh(p)"
            >
              {{ refreshing(p) ? 'Refreshing…' : 'Refresh data' }}
            </button>
            <button
              class="btn-link"
              :disabled="refreshing(p)"
              @click="forget(p)"
            >
              Forget
            </button>
          </div>
          <ScheduleEditor
            v-if="editing === p.projectPath"
            class="item-schedule"
            :schedule="p.schedule ?? null"
            :saving="saving"
            @save="saveSchedule(p, $event)"
            @remove="saveSchedule(p, null)"
            @cancel="editing = null"
          />
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.published-page {
  height: 100%;
  overflow-y: auto;
  background: var(--bg);
}

.content {
  display: flex;
  flex-direction: column;
  gap: 18px;
  max-width: 860px;
  margin: 0 auto;
  padding: 40px 36px 56px;
}

.back {
  align-self: flex-start;
  text-decoration: none;
}

.head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.head h2 {
  font-size: 30px;
}

.hint {
  max-width: 60ch;
  margin: 6px 0 0;
  color: var(--ink-muted);
  font-size: 14px;
}

.panel {
  padding: 18px 20px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
}

.empty {
  padding: 28px;
  border: 1px dashed var(--border);
  border-radius: var(--radius);
  color: var(--ink-muted);
  text-align: center;
}

.empty strong {
  color: var(--ink);
}

.empty p {
  margin: 6px 0 0;
}

.list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.background {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.check {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 500;
}

.check input {
  accent-color: var(--accent);
}

.item {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 16px;
  padding: 16px 18px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
}

.item-text {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.item-text a {
  color: var(--accent);
  font-size: 14px;
  overflow-wrap: anywhere;
}

.item-text small {
  overflow: hidden;
  color: var(--ink-muted);
  white-space: nowrap;
  text-overflow: ellipsis;
}

.progress {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 4px 0 0;
  color: var(--ink-muted);
  font-size: 13px;
}

.item-error {
  margin: 4px 0 0;
  color: var(--danger);
  font-size: 13px;
}

.item-actions {
  display: flex;
  flex: none;
  flex-direction: column;
  align-items: center;
  gap: 6px;
}

.item-actions .btn-link {
  font-size: 13px;
}

.item-text small.schedule {
  white-space: normal;
}

.schedule .btn-link {
  font-size: inherit;
}

/* The schedule editor takes the item's full width, below its text and buttons. */
.item-schedule {
  flex: 0 0 calc(100% + 36px);
  margin: 0 -18px -16px;
}
</style>
