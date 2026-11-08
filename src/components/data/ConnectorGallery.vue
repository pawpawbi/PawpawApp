<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { ConnectorCatalog, ConnectorInfo } from '../../shared/types';

const props = defineProps<{ catalog: ConnectorCatalog }>();
defineEmits<{ choose: [connector: ConnectorInfo]; cancel: [] }>();

const query = ref('');
const category = ref<string | null>(null);
const searchInput = ref<HTMLInputElement | null>(null);

onMounted(() => searchInput.value?.focus());

const matches = computed(() => {
  const words = query.value.toLowerCase().split(/\s+/).filter(Boolean);
  return props.catalog.connectors.filter((c) => {
    if (category.value && c.category !== category.value) return false;
    const haystack = [c.name, c.description, c.category, ...c.keywords]
      .join(' ')
      .toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
});

/** Results grouped by category, in catalog order. */
const groups = computed(() =>
  props.catalog.categories
    .map((name) => ({
      name,
      connectors: matches.value.filter((c) => c.category === name),
    }))
    .filter((group) => group.connectors.length > 0),
);

const countFor = (name: string) =>
  props.catalog.connectors.filter((c) => c.category === name).length;
</script>

<template>
  <div class="gallery">
    <header class="head">
      <div>
        <h2>Add a data source</h2>
        <p>
          {{ catalog.connectors.length }} connectors for files, databases and
          business apps.
        </p>
      </div>
      <button class="btn-ghost" @click="$emit('cancel')">Cancel</button>
    </header>

    <div class="search">
      <svg class="icon" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="11" cy="11" r="7" />
        <path d="M20 20l-3.5-3.5" />
      </svg>
      <input
        ref="searchInput"
        v-model="query"
        type="search"
        placeholder="Search, e.g. Excel, Postgres, Salesforce…"
      />
    </div>

    <div class="chips" role="tablist" aria-label="Categories">
      <button
        role="tab"
        :aria-selected="category === null"
        :class="{ active: category === null }"
        @click="category = null"
      >
        All
      </button>
      <button
        v-for="name in catalog.categories"
        :key="name"
        role="tab"
        :aria-selected="category === name"
        :class="{ active: category === name }"
        @click="category = category === name ? null : name"
      >
        {{ name }} <span class="count">{{ countFor(name) }}</span>
      </button>
    </div>

    <div class="results">
      <section v-for="group in groups" :key="group.name">
        <h3>{{ group.name }}</h3>
        <div class="grid">
          <button
            v-for="c in group.connectors"
            :key="c.id"
            class="card"
            @click="$emit('choose', c)"
          >
            <span class="monogram" aria-hidden="true">{{
              c.name.charAt(0)
            }}</span>
            <span class="card-text">
              <strong>{{ c.name }}</strong>
              <small>{{ c.description }}</small>
              <span v-if="c.packages.length" class="badge"
                >Downloads on first use</span
              >
            </span>
          </button>
        </div>
      </section>

      <p v-if="groups.length === 0" class="none">
        No connectors match "{{ query }}". The
        <strong>REST API</strong> connector works with most web services.
      </p>
    </div>
  </div>
</template>

<style scoped>
.gallery {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.head h2 {
  font-size: 26px;
}

.head p {
  margin: 6px 0 0;
  color: var(--ink-muted);
}

.search {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  box-shadow: var(--shadow-sm);
}

.search:focus-within {
  border-color: var(--ink-faint);
}

.search .icon {
  width: 18px;
  height: 18px;
  flex: none;
  stroke: var(--ink-faint);
}

.search input {
  flex: 1;
  padding: 12px 0;
  border: none;
  outline: none;
  background: none;
  font: inherit;
  font-size: 15px;
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.chips button {
  padding: 5px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface);
  color: var(--ink-muted);
  font-size: 13px;
  font-weight: 500;
}

.chips button.active {
  border-color: var(--ink);
  background: var(--ink);
  color: var(--surface);
}

.count {
  opacity: 0.6;
  font-size: 11px;
}

.results {
  display: flex;
  flex-direction: column;
  gap: 22px;
}

.results h3 {
  margin-bottom: 10px;
  font-size: 15px;
  font-weight: var(--display-weight);
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 10px;
}

.card {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  text-align: left;
  transition:
    border-color 0.15s,
    box-shadow 0.15s,
    transform 0.15s;
}

.card:hover {
  border-color: var(--ink-faint);
  box-shadow: var(--shadow-md);
  transform: translateY(-1px);
}

.monogram {
  display: grid;
  place-items: center;
  flex: none;
  width: 36px;
  height: 36px;
  border-radius: var(--radius-sm);
  background: var(--accent-soft);
  color: var(--accent);
  font-family: var(--font-display);
  font-weight: var(--display-weight);
  font-size: 16px;
}

.card-text {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.card-text strong {
  font-weight: 600;
}

.card-text small {
  display: -webkit-box;
  overflow: hidden;
  color: var(--ink-muted);
  font-size: 12px;
  line-height: 1.4;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.badge {
  align-self: flex-start;
  margin-top: 4px;
  padding: 1px 7px;
  border-radius: var(--radius-sm);
  background: var(--surface-muted);
  color: var(--ink-muted);
  font-size: 11px;
}

.none {
  padding: 32px;
  border: 1px dashed var(--border);
  border-radius: var(--radius);
  color: var(--ink-muted);
  text-align: center;
}
</style>
