<script setup lang="ts">
// An assistant reply: paragraphs with inline code and bold, and fenced code blocks (with a
// Copy button when `copyable`). Rendered with text interpolation only; see src/chat-format.ts.
import { computed, ref } from 'vue';
import { blocks } from '../chat-format';

const props = defineProps<{ text: string; copyable?: boolean }>();
const parts = computed(() => blocks(props.text));

const copied = ref<number | null>(null);
async function copy(text: string, index: number) {
  await navigator.clipboard.writeText(text);
  copied.value = index;
  setTimeout(() => {
    if (copied.value === index) copied.value = null;
  }, 1500);
}
</script>

<template>
  <div class="reply">
    <template v-for="(b, i) in parts" :key="i">
      <div v-if="b.kind === 'code'" class="code">
        <button v-if="copyable" class="copy" @click="copy(b.text, i)">
          {{ copied === i ? 'Copied' : 'Copy' }}
        </button>
        <pre><code>{{ b.text }}</code></pre>
      </div>
      <p v-else class="prose">
        <template v-for="(p, j) in b.parts" :key="j">
          <code v-if="p.kind === 'code'">{{ p.text }}</code>
          <strong v-else-if="p.kind === 'bold'">{{ p.text }}</strong>
          <template v-else>{{ p.text }}</template>
        </template>
      </p>
    </template>
  </div>
</template>

<style scoped>
.reply {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.prose {
  margin: 0;
  white-space: pre-wrap;
}

.prose code,
.code pre {
  font-family: var(--font-mono);
  font-size: 12px;
}

.prose code {
  padding: 1px 5px;
  border-radius: var(--radius-sm);
  background: rgb(31 28 23 / 0.07);
}

.code {
  position: relative;
}

.code pre {
  margin: 0;
  padding: 10px 12px;
  overflow-x: auto;
  border-radius: var(--radius-sm);
  background: var(--code-bg);
  color: var(--code-ink);
  line-height: 1.5;
  white-space: pre;
}

.copy {
  position: absolute;
  top: 6px;
  right: 6px;
  padding: 2px 8px;
  border: 1px solid rgb(255 255 255 / 0.2);
  border-radius: var(--radius-sm);
  background: var(--ink-hover);
  color: var(--code-ink);
  font-size: 11px;
  opacity: 0;
  transition: opacity 0.15s;
}

.code:hover .copy,
.copy:focus-visible {
  opacity: 1;
}
</style>
