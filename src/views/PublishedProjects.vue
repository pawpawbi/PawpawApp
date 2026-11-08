<script setup lang="ts">
// Every project on this computer that's published to PawpawBI, with a button to refresh each
// report's data: the project is opened in the background, its sources loaded again and the new
// data uploaded (src/published.ts).
import { onBeforeUnmount, onMounted, ref } from 'vue';
import AccountPanel from '../components/AccountPanel.vue';
import RunningTimer from '../components/RunningTimer.vue';
import UploadProgress from '../components/UploadProgress.vue';
import { errorMessage } from '../errors';
import { openReport, orgLabel, visibilityLabel } from '../report-access';
import type { AccountState, PublishedProject } from '../shared/types';
import { ALL_SOURCES } from '../shared/types';
import { timeAgo } from '../time';

const emit = defineEmits<{ back: [] }>();

const projects = ref<PublishedProject[] | null>(null);
const account = ref<AccountState | null>(null);
const accountPanel = ref<InstanceType<typeof AccountPanel> | null>(null);
const refreshing = ref<string | null>(null);
const status = ref('');
const error = ref('');
const notice = ref('');

onMounted(async () => {
  try {
    projects.value = await window.api.publish.list();
  } catch (e) {
    error.value = `Couldn't load the published projects. ${errorMessage(e)}`;
  }
});

// Progress of the refresh, as the data screens show it.
const unsubscribe = window.api.data.onProgress((p) => {
  if (refreshing.value && p.sourceId === ALL_SOURCES) status.value = p.message;
});
onBeforeUnmount(unsubscribe);

async function refresh(project: PublishedProject) {
  refreshing.value = project.projectPath;
  status.value = 'Opening the project…';
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
    refreshing.value = null;
    projects.value = await window.api.publish
      .list()
      .catch(() => projects.value);
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
      <button
        class="btn-link back"
        :disabled="!!refreshing"
        @click="emit('back')"
      >
        ← Projects
      </button>
      <header class="head">
        <div>
          <h2>Published projects</h2>
          <p class="hint">
            Refresh the data on reports you've published to PawpawBI. Each
            project's sources are loaded again, the new data is uploaded and the
            project is saved.
          </p>
        </div>
        <button class="btn-ghost" :disabled="!!refreshing" @click="addFiles">
          Add a project…
        </button>
      </header>

      <section class="panel">
        <AccountPanel ref="accountPanel" @changed="account = $event" />
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
              @click.prevent="openReport(p)"
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
            <p v-if="refreshing === p.projectPath" class="progress">
              {{ status }}
              <RunningTimer :can-stop="false" />
            </p>
            <p v-else-if="p.lastError" class="item-error">{{ p.lastError }}</p>
            <UploadProgress v-if="refreshing === p.projectPath" />
          </div>
          <div class="item-actions">
            <button
              class="btn-primary"
              :disabled="!!refreshing || !account?.email"
              :title="account?.email ? '' : 'Sign in to refresh'"
              @click="refresh(p)"
            >
              {{
                refreshing === p.projectPath ? 'Refreshing…' : 'Refresh data'
              }}
            </button>
            <button
              class="btn-link"
              :disabled="!!refreshing"
              @click="forget(p)"
            >
              Forget
            </button>
          </div>
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

.item {
  display: flex;
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
</style>
