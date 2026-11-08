<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue';
import type { Project } from './shared/types';
import SplashScreen from './views/SplashScreen.vue';
import ProjectWorkspace from './views/ProjectWorkspace.vue';
import PublishedProjects from './views/PublishedProjects.vue';

const project = ref<Project | null>(null);
// The Published projects screen, reached from the start screen.
const showPublished = ref(false);

// Keep the open project's details (e.g. unsaved changes) in step with the main process.
const unsubscribe = window.api.projects.onChanged((changed) => {
  if (project.value?.id === changed.id) project.value = changed;
});
onBeforeUnmount(unsubscribe);
</script>

<template>
  <ProjectWorkspace v-if="project" :project="project" @close="project = null" />
  <PublishedProjects v-else-if="showPublished" @back="showPublished = false" />
  <SplashScreen
    v-else
    @open="project = $event"
    @published="showPublished = true"
  />
</template>
