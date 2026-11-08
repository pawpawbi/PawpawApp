<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { errorMessage } from '../errors';
import type { Project, WorkflowStage } from '../shared/types';
import ChatPanel from '../components/ChatPanel.vue';
import WorkflowSteps from '../components/WorkflowSteps.vue';
import GetData from '../components/data/GetData.vue';
import ModelData from '../components/ModelData.vue';
import ReportCanvas from '../components/ReportCanvas.vue';
import EditProject from './EditProject.vue';
import PublishPage from './PublishPage.vue';

const props = defineProps<{ project: Project }>();
const emit = defineEmits<{ close: [] }>();

// Where the user is in the workflow, which also decides the screen shown. The chat loads it
// from the project and advances it; the user can also jump to a step from the top bar.
const stage = ref<WorkflowStage>('data');

// The Edit project and Publish screens, shown instead of the chat and the step's screen.
const screen = ref<'workflow' | 'edit' | 'publish'>('workflow');

async function goToStage(next: WorkflowStage) {
  screen.value = 'workflow';
  if (next === stage.value) return;
  stage.value = next;
  await window.api.projects.setStage(next);
}

const saving = ref(false);
const saveError = ref('');

async function save() {
  if (saving.value || !props.project.dirty) return;
  saving.value = true;
  saveError.value = '';
  try {
    await window.api.projects.save();
  } catch (error) {
    saveError.value = `Couldn't save. ${errorMessage(error)}`;
  } finally {
    saving.value = false;
  }
}

async function close() {
  try {
    if (await window.api.projects.close()) emit('close');
  } catch (error) {
    saveError.value = `Couldn't close the project. ${errorMessage(error)}`;
  }
}

function onKeydown(event: KeyboardEvent) {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault();
    save();
  }
}

onMounted(() => window.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));
</script>

<template>
  <div class="workspace">
    <header class="topbar">
      <button class="back" title="Back to projects" @click="close">
        <svg class="icon" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M15 18l-6-6 6-6" />
        </svg>
        Projects
      </button>
      <span class="divider" aria-hidden="true"></span>
      <h1 :title="project.path">{{ project.name }}</h1>
      <button
        class="edit"
        :class="{ active: screen === 'edit' }"
        title="Edit project"
        aria-label="Edit project"
        @click="screen = 'edit'"
      >
        <svg class="icon" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
        </svg>
      </button>

      <div class="steps-slot">
        <WorkflowSteps
          :stage="stage"
          :elsewhere="screen !== 'workflow'"
          @select="goToStage"
        />
        <button
          class="publish-button"
          :class="{ active: screen === 'publish' }"
          @click="screen = 'publish'"
        >
          <svg class="icon" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 15V3M7 8l5-5 5 5M5 21h14" />
          </svg>
          Publish
        </button>
      </div>

      <div class="save-area">
        <span v-if="saveError" class="save-error" role="alert">{{
          saveError
        }}</span>
        <span v-else class="save-status">{{
          project.busy
            ? 'Working…'
            : project.dirty
              ? 'Unsaved changes'
              : 'Saved'
        }}</span>
        <button
          class="save"
          :disabled="!project.dirty || saving"
          title="Save (Ctrl+S)"
          @click="save"
        >
          {{
            saving
              ? project.busy
                ? 'Saving after it finishes…'
                : 'Saving…'
              : 'Save'
          }}
        </button>
      </div>
    </header>

    <div v-if="screen === 'edit'" class="body edit-body">
      <EditProject
        :project="project"
        @back="screen = 'workflow'"
        @deleted="emit('close')"
      />
    </div>
    <div v-else-if="screen === 'publish'" class="body edit-body">
      <PublishPage :project="project" @back="screen = 'workflow'" />
    </div>
    <div v-show="screen === 'workflow'" class="body">
      <ChatPanel v-model:stage="stage" />
      <section class="main">
        <!-- The screen follows the workflow step. Kept alive so switching steps doesn't lose a
             half-finished data source setup. -->
        <KeepAlive>
          <GetData v-if="stage === 'data'" />
          <ModelData
            v-else-if="stage === 'model'"
            @add-data="goToStage('data')"
          />
          <ReportCanvas v-else />
        </KeepAlive>
      </section>
    </div>
  </div>
</template>

<style scoped>
.workspace {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.topbar {
  display: flex;
  flex: none;
  align-items: center;
  gap: 12px;
  height: 56px;
  padding: 0 16px;
  border-bottom: 1px solid var(--ink);
  background: var(--surface);
}

.back {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 10px 6px 6px;
  border: none;
  border-radius: var(--radius-sm);
  background: none;
  color: var(--ink-muted);
  font-weight: 500;
}

.back:hover {
  background: var(--surface-muted);
  color: var(--ink);
}

.back .icon {
  width: 18px;
  height: 18px;
}

.edit {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  margin-left: -6px;
  padding: 0;
  border: none;
  border-radius: var(--radius-sm);
  background: none;
  color: var(--ink-faint);
}

.edit:hover,
.edit.active {
  background: var(--surface-muted);
  color: var(--ink);
}

.divider {
  width: 1px;
  height: 20px;
  background: var(--border);
}

.topbar h1 {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  font-size: 20px;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.steps-slot {
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-width: max-content;
}

.publish-button {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 6px 12px;
  border: none;
  border-radius: var(--radius-sm);
  background: var(--surface-muted);
  color: var(--ink-muted);
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
  transition:
    background 0.15s,
    color 0.15s;
}

.publish-button:hover:not(.active) {
  background: var(--surface-hover);
}

.publish-button.active {
  background: var(--accent-soft);
  color: var(--accent);
}

.publish-button .icon {
  flex: none;
}

.save-area {
  display: flex;
  align-items: center;
  gap: 12px;
  white-space: nowrap;
}

.save-status {
  color: var(--ink-faint);
  font-size: 13px;
}

.save-error {
  color: var(--danger);
  font-size: 13px;
}

.save {
  padding: 6px 16px;
  border: none;
  border-radius: var(--radius-sm);
  background: var(--ink);
  color: var(--surface);
  font-weight: 600;
}

.save:hover:not(:disabled) {
  background: var(--ink-hover);
}

.save:disabled {
  background: var(--surface-muted);
  color: var(--ink-faint);
}

.body {
  display: flex;
  flex: 1;
  min-height: 0;
}

.edit-body {
  overflow-y: auto;
  background: var(--bg);
}

.main {
  display: flex;
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
  background: var(--bg);
}
</style>
