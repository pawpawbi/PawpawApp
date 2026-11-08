<script setup lang="ts">
// The project's own settings: its name, and deleting it. More project settings go here.
import { computed, ref } from 'vue';
import { useUnsavedGuard } from '../composables/useUnsavedGuard';
import { errorMessage } from '../errors';
import { MAX_PROJECT_NAME } from '../shared/ids';
import type { Project } from '../shared/types';

const props = defineProps<{ project: Project }>();
const emit = defineEmits<{ back: []; deleted: [] }>();

const name = ref(props.project.name);
const renaming = ref(false);
const renamed = ref(false);
const nameError = ref('');
const nameChanged = computed(() => name.value.trim() !== props.project.name);

const { confirmLeave } = useUnsavedGuard(
  nameChanged,
  'Discard the new name for this project?',
);

function back() {
  if (confirmLeave()) emit('back');
}

async function rename() {
  if (!nameChanged.value || renaming.value) return;
  renaming.value = true;
  renamed.value = false;
  nameError.value = '';
  try {
    const project = await window.api.projects.rename(name.value);
    name.value = project.name;
    renamed.value = true;
  } catch (error) {
    nameError.value = `Couldn't rename the project. ${errorMessage(error)}`;
  } finally {
    renaming.value = false;
  }
}

const confirmingDelete = ref(false);
const deleting = ref(false);
const deleteError = ref('');

async function remove() {
  deleting.value = true;
  deleteError.value = '';
  try {
    if (await window.api.projects.delete()) emit('deleted');
  } catch (error) {
    deleteError.value = errorMessage(error);
  } finally {
    deleting.value = false;
    confirmingDelete.value = false;
  }
}
</script>

<template>
  <div class="edit-project">
    <button class="btn-link back" @click="back">← Back to the project</button>
    <h2>Edit project</h2>

    <section class="panel">
      <h3>Name</h3>
      <form class="name-row" @submit.prevent="rename">
        <input
          v-model="name"
          type="text"
          aria-label="Project name"
          :maxlength="MAX_PROJECT_NAME"
          @input="renamed = false"
        />
        <button
          class="btn-primary"
          type="submit"
          :disabled="!nameChanged || !name.trim() || renaming"
        >
          {{ renaming ? 'Saving…' : 'Rename' }}
        </button>
      </form>
      <p class="hint">
        Shown at the top of the window and in your recent projects. The file
        keeps its name: {{ project.path }}
      </p>
      <p v-if="renamed" class="box-notice" role="status">
        Renamed. Save the project to keep the new name.
      </p>
      <p v-if="nameError" class="box-error" role="alert">{{ nameError }}</p>
    </section>

    <section class="panel danger">
      <h3>Delete project</h3>
      <p class="hint">
        Moves the project file to the Recycle Bin, removes it from your recent
        projects and deletes the passwords saved on this computer for its data
        sources.
      </p>
      <div v-if="confirmingDelete" class="confirm" role="group">
        <p>
          Delete <strong>{{ project.name }}</strong
          >? Any unsaved changes are lost too.
        </p>
        <div class="actions">
          <button class="btn-danger" :disabled="deleting" @click="remove">
            {{ deleting ? 'Deleting…' : 'Delete project' }}
          </button>
          <button
            class="btn-ghost"
            :disabled="deleting"
            @click="confirmingDelete = false"
          >
            Cancel
          </button>
        </div>
      </div>
      <button v-else class="btn-danger" @click="confirmingDelete = true">
        Delete project
      </button>
      <p v-if="deleteError" class="box-error" role="alert">
        {{ deleteError }}
      </p>
    </section>
  </div>
</template>

<style scoped>
.edit-project {
  display: flex;
  flex-direction: column;
  gap: 20px;
  width: 100%;
  max-width: 720px;
  margin: 0 auto;
  padding: 32px 36px 48px;
}

.back {
  align-self: flex-start;
  text-decoration: none;
}

.back:hover {
  color: var(--ink);
}

h2 {
  font-size: 30px;
}

.panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 20px 22px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
}

.panel h3 {
  font-size: 17px;
}

.name-row {
  display: flex;
  gap: 8px;
}

.name-row input {
  flex: 1;
  min-width: 0;
  padding: 7px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font: inherit;
}

.hint {
  margin: 0;
  color: var(--ink-muted);
  font-size: 13px;
  overflow-wrap: anywhere;
}

.danger {
  border-color: var(--danger-soft);
}

.btn-danger {
  align-self: flex-start;
  padding: 7px 16px;
  border: none;
  border-radius: var(--radius-sm);
  background: var(--danger);
  color: var(--surface);
  font-weight: 600;
}

.btn-danger:disabled {
  opacity: 0.5;
}

.confirm {
  padding: 14px 16px;
  border-radius: var(--radius-sm);
  background: var(--danger-soft);
}

.confirm p {
  margin: 0 0 10px;
}

.actions {
  display: flex;
  gap: 8px;
}
</style>
