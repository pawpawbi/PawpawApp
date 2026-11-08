<script setup lang="ts">
// A textarea for code (SQL, HTML): dark, monospace, Tab indents and Ctrl+Enter emits `run`.
import { ref } from 'vue';

defineProps<{
  placeholder?: string;
  ariaLabel?: string;
  minHeight?: string;
}>();
const model = defineModel<string>({ required: true });
const emit = defineEmits<{ run: [] }>();

const textarea = ref<HTMLTextAreaElement | null>(null);

function onKeydown(event: KeyboardEvent) {
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
    event.preventDefault();
    emit('run');
  } else if (event.key === 'Tab' && !event.shiftKey) {
    event.preventDefault();
    insert('  ');
  }
}

/** Inserts text at the cursor, as an edit Ctrl+Z can undo. */
function insert(text: string) {
  const el = textarea.value;
  if (!el) return;
  // Focusing restores the cursor position the textarea had before the click.
  el.focus();
  // Setting the value directly would bypass the textarea's undo history, so insert the way
  // typing does. (execCommand is deprecated but is still the only way to do this in Chromium.)
  if (!document.execCommand('insertText', false, text)) {
    el.setRangeText(text, el.selectionStart, el.selectionEnd, 'end');
    el.dispatchEvent(new Event('input'));
  }
}

const focus = () => textarea.value?.focus();

defineExpose({ insert, focus });
</script>

<template>
  <textarea
    ref="textarea"
    v-model="model"
    class="code-editor"
    spellcheck="false"
    :placeholder="placeholder"
    :aria-label="ariaLabel"
    :style="{ minHeight }"
    @keydown="onKeydown"
  ></textarea>
</template>

<style scoped>
.code-editor {
  display: block;
  width: 100%;
  padding: 14px 16px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--code-bg);
  color: var(--code-ink);
  font-family: var(--font-mono);
  font-size: 13px;
  line-height: 1.6;
  resize: vertical;
  tab-size: 2;
}

.code-editor:focus {
  outline: 2px solid var(--accent);
  outline-offset: -1px;
}
</style>
