<script setup lang="ts">
// The report's menu as the app draws it above the page: the same markup and styles Publish
// writes into every page (shared/site-menu.ts), so what's here is what's published. In the app
// it also edits: double-click to rename, + to add a page.
import { nextTick, onMounted, ref } from 'vue';
import { MENU_CSS } from '../../shared/site-menu';
import type { ReportFile } from '../../shared/types';

defineProps<{ report: ReportFile; currentId: string | null; busy: boolean }>();
const emit = defineEmits<{
  select: [id: string];
  add: [];
  renamePage: [id: string, title: string];
  renameReport: [title: string];
}>();

// The menu's styles are plain global CSS, as on the published site.
onMounted(() => {
  if (document.getElementById('pp-menu-css')) return;
  const style = document.createElement('style');
  style.id = 'pp-menu-css';
  style.textContent = MENU_CSS;
  document.head.append(style);
});

/** What's being renamed: a page's ID, or 'report' for the title. */
const renaming = ref<string | null>(null);
const text = ref('');
const input = ref<HTMLInputElement[] | HTMLInputElement | null>(null);

async function startRename(what: string, title: string) {
  renaming.value = what;
  text.value = title;
  await nextTick();
  const el = Array.isArray(input.value) ? input.value[0] : input.value;
  el?.select();
}

function finishRename() {
  const what = renaming.value;
  renaming.value = null;
  const title = text.value.trim();
  if (!what || !title) return;
  if (what === 'report') emit('renameReport', title);
  else emit('renamePage', what, title);
}

defineExpose({ startRename });
</script>

<template>
  <header class="pp-menu">
    <input
      v-if="renaming === 'report'"
      ref="input"
      v-model="text"
      class="rename pp-menu-title"
      aria-label="Report title"
      maxlength="80"
      @keydown.enter="finishRename"
      @keydown.escape="renaming = null"
      @blur="finishRename"
    />
    <a
      v-else
      class="pp-menu-title"
      href="#"
      title="Double-click to rename the report"
      @click.prevent
      @dblclick.prevent="startRename('report', report.title)"
      >{{ report.title }}</a
    >
    <ul class="pp-menu-list">
      <li v-for="page in report.pages" :key="page.id">
        <input
          v-if="renaming === page.id"
          ref="input"
          v-model="text"
          class="rename pp-menu-link"
          aria-label="Page title"
          maxlength="80"
          @keydown.enter="finishRename"
          @keydown.escape="renaming = null"
          @blur="finishRename"
        />
        <a
          v-else
          class="pp-menu-link"
          href="#"
          :aria-current="page.id === currentId ? 'page' : undefined"
          title="Double-click to rename"
          @click.prevent="emit('select', page.id)"
          @dblclick.prevent="startRename(page.id, page.title)"
          >{{ page.title }}</a
        >
      </li>
      <li>
        <button
          class="add"
          title="New page"
          aria-label="New page"
          :disabled="busy"
          @click="emit('add')"
        >
          +
        </button>
      </li>
    </ul>
  </header>
</template>

<style scoped>
/* Only the app's editing extras; the menu itself is styled by MENU_CSS. */
.pp-menu {
  flex: none;
}

.rename {
  width: 180px;
  border: none;
  outline: 2px solid var(--accent);
  font: inherit;
}

.add {
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border: 1px dashed var(--border);
  border-radius: var(--radius-sm);
  background: none;
  color: var(--ink-muted);
  font-size: 18px;
  line-height: 1;
}

.add:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--accent);
}
</style>
