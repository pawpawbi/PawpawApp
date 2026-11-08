<script setup lang="ts">
// Publishing the project's report: to PawpawBI (hosted at a link, with an account), as a single
// HTML file to send by email, or to a folder to host anywhere. A new report goes to the organisation chosen here, open to whoever's
// chosen; after that, who can open it is changed in the PawpawBI web console. Design:
// docs/pawpaw-server-api.md and docs/guides/report.md
import { computed, onMounted, ref, watch } from 'vue';
import AccountPanel from '../components/AccountPanel.vue';
import UploadProgress from '../components/UploadProgress.vue';
import { errorMessage } from '../errors';
import { plain } from '../plain';
import {
  openReport,
  orgLabel,
  PRIVATE_LINK_NOTE,
  visibilityLabel,
} from '../report-access';
import {
  EMAIL_LIMIT_BYTES,
  type AccountState,
  type Project,
  type PublishedReport,
  type PublishTarget,
  type ReportVisibility,
} from '../shared/types';
import { timeAgo } from '../time';

defineProps<{ project: Project }>();
const emit = defineEmits<{ back: [] }>();

const VISIBILITIES: ReportVisibility[] = ['link', 'org', 'restricted'];

const hasReport = ref<boolean | null>(null);
const published = ref<PublishedReport | null>(null);
const account = ref<AccountState | null>(null);
const accountPanel = ref<InstanceType<typeof AccountPanel> | null>(null);
const busy = ref<'' | 'pawpawbi' | 'file' | 'folder'>('');
const error = ref('');
const notice = ref('');
const fileNotice = ref('');
const fileWarning = ref('');
const fileError = ref('');
const folderNotice = ref('');
const folderError = ref('');
/** Why publishing over the old report failed (it's gone), so it's published as a new one. */
const gone = ref('');

// Where a new report goes, and who can open it.
const targets = ref<PublishTarget[] | null>(null);
const targetsError = ref('');
const orgId = ref('');
const visibility = ref<ReportVisibility>('link');
const target = computed(
  () => targets.value?.find((t) => t.id === orgId.value) ?? null,
);
/** A new report is being published: the first time, or over one that's gone. */
const choosing = computed(() => !published.value || !!gone.value);

onMounted(async () => {
  try {
    [hasReport.value, published.value] = await Promise.all([
      window.api.report.get().then((r) => r !== null),
      window.api.publish.get(),
    ]);
  } catch (e) {
    error.value = errorMessage(e);
  }
});

// Signed in, with a new report to publish: load where it can go.
watch(
  () => [account.value?.email, choosing.value] as const,
  async ([email, isChoosing]) => {
    if (!email || !isChoosing || targets.value) return;
    targetsError.value = '';
    try {
      targets.value = await window.api.publish.targets();
      orgId.value = targets.value[0]?.id ?? '';
    } catch (e) {
      targetsError.value = `Couldn't load your organisations. ${errorMessage(e)}`;
    }
  },
);

// Each place has its own sensible default: the link in a personal workspace (it's only you
// otherwise), members in an organisation.
watch(target, (t) => {
  if (t) visibility.value = t.personal ? 'link' : 'org';
});

/** The visibilities that make sense where the report is going. */
const visibilityChoices = computed(() =>
  target.value?.personal ? (['link', 'org'] as const) : VISIBILITIES,
);

async function publish() {
  busy.value = 'pawpawbi';
  error.value = '';
  notice.value = '';
  const asNew = !!gone.value;
  const first = !published.value || asNew;
  try {
    const outcome = await window.api.publish.toPawpawBI(
      plain(
        first
          ? {
              orgId: orgId.value || undefined,
              visibility: visibility.value,
              asNew,
            }
          : {},
      ),
    );
    if (!outcome.ok) {
      gone.value = outcome.gone;
      return;
    }
    published.value = outcome.report;
    gone.value = '';
    notice.value = first
      ? 'Published. Save the project to keep its link with it.'
      : 'Published your changes.';
  } catch (e) {
    error.value = `Couldn't publish the report. ${errorMessage(e)}`;
    // A rejected sign-in signs out here too: show the sign-in form again.
    await accountPanel.value?.reload();
  } finally {
    busy.value = '';
  }
}

/** The console page for the report's organisation (or the console itself). */
const consoleLink = computed(() => {
  const base = account.value?.consoleUrl;
  if (!base) return null;
  const org = published.value?.org;
  return org ? `${base}/#/orgs/${encodeURIComponent(org.id)}` : `${base}/`;
});

/** A size in megabytes, e.g. "1.4 MB" (at least "0.1 MB"). */
const megabytes = (bytes: number) =>
  `${Math.max(0.1, bytes / (1024 * 1024)).toFixed(1)} MB`;

async function toFile() {
  busy.value = 'file';
  fileError.value = '';
  fileNotice.value = '';
  fileWarning.value = '';
  try {
    const saved = await window.api.report.exportFile();
    if (!saved) return;
    fileNotice.value = `Saved to ${saved.path} (${megabytes(saved.bytes)}). Send it as an attachment: it opens in any web browser.`;
    if (saved.bytes > EMAIL_LIMIT_BYTES) {
      fileWarning.value = `At ${megabytes(saved.bytes)}, it's too big for most email services, which take up to about 20 MB. Publish it to PawpawBI and send the link instead, or make the datasets smaller.`;
    }
  } catch (e) {
    fileError.value = `Couldn't save the report. ${errorMessage(e)}`;
  } finally {
    busy.value = '';
  }
}

async function toFolder() {
  busy.value = 'folder';
  folderError.value = '';
  folderNotice.value = '';
  try {
    const folder = await window.api.report.exportSite();
    if (folder) {
      folderNotice.value = `Saved to ${folder}. Upload the folder's contents to your web host, such as an S3 bucket.`;
    }
  } catch (e) {
    folderError.value = `Couldn't save the report. ${errorMessage(e)}`;
  } finally {
    busy.value = '';
  }
}
</script>

<template>
  <div class="publish">
    <button class="btn-link back" @click="emit('back')">
      ← Back to the project
    </button>
    <h2>Publish</h2>

    <p v-if="hasReport === false" class="box-error">
      This project has no report yet. Add one on Build visuals first.
    </p>

    <section class="panel">
      <div class="panel-head">
        <span class="badge">Recommended</span>
        <h3>Publish to PawpawBI</h3>
        <p class="hint">
          Your report is hosted for you at a link you can share, and its data
          can be refreshed from this computer. You choose who can open it.
        </p>
      </div>

      <AccountPanel ref="accountPanel" @changed="account = $event" />

      <template v-if="account?.email && hasReport">
        <div v-if="published && !gone" class="published">
          <a
            :href="published.url"
            target="_blank"
            rel="noreferrer"
            @click.prevent="openReport(published)"
            >{{ published.url }}</a
          >
          <small>
            <template v-if="published.publishedAt"
              >Published {{ timeAgo(published.publishedAt) }}</template
            >
            <template v-if="published.refreshedAt">
              · data updated {{ timeAgo(published.refreshedAt) }}</template
            >
          </small>
          <small v-if="published.org || published.visibility">
            <template v-if="published.org"
              >In {{ orgLabel(published.org) }}</template
            >
            <template v-if="published.org && published.visibility">
              ·
            </template>
            <template v-if="published.visibility"
              >Who can open it:
              {{
                visibilityLabel(published.visibility, published.org)
              }}</template
            >
          </small>
          <p
            v-if="published.visibility && published.visibility !== 'link'"
            class="note"
          >
            {{ PRIVATE_LINK_NOTE }}
          </p>
          <a
            v-if="consoleLink"
            class="manage"
            :href="consoleLink"
            target="_blank"
            rel="noreferrer"
            >Change who can open it in the PawpawBI console</a
          >
        </div>

        <p v-if="gone" class="box-error" role="alert">
          {{ gone }} Publish it as a new report to get a new link.
        </p>

        <fieldset v-if="choosing" class="where" :disabled="!!busy">
          <p v-if="targetsError" class="box-error">{{ targetsError }}</p>
          <p v-else-if="!targets" class="hint">Loading your organisations…</p>
          <template v-else>
            <label v-if="targets.length > 1">
              Publish to
              <select v-model="orgId">
                <option v-for="t in targets" :key="t.id" :value="t.id">
                  {{ orgLabel(t) }}
                </option>
              </select>
            </label>
            <label>
              Who can open it
              <select v-model="visibility">
                <option v-for="v in visibilityChoices" :key="v" :value="v">
                  {{ visibilityLabel(v, target) }}
                </option>
              </select>
            </label>
            <p v-if="visibility !== 'link'" class="note">
              {{ PRIVATE_LINK_NOTE }}
            </p>
          </template>
        </fieldset>

        <button
          class="btn-primary"
          :disabled="!!busy || project.busy || (choosing && !targets)"
          @click="publish"
        >
          {{
            busy === 'pawpawbi'
              ? 'Publishing…'
              : gone
                ? 'Publish as a new report'
                : published
                  ? 'Publish changes'
                  : 'Publish'
          }}
        </button>
      </template>
      <UploadProgress v-if="busy === 'pawpawbi'" />
      <p v-if="notice" class="box-notice" role="status">{{ notice }}</p>
      <p v-if="error" class="box-error" role="alert">{{ error }}</p>
    </section>

    <section class="panel">
      <div class="panel-head">
        <h3>Save as a single file</h3>
        <p class="hint">
          The whole report in one file, to send by email or share like any other
          file. It opens in any web browser, even offline. Anyone you send it to
          can see all of its data, and it won't change: save it again to send
          new data.
        </p>
      </div>
      <button
        class="btn-ghost"
        :disabled="!!busy || !hasReport"
        @click="toFile"
      >
        {{ busy === 'file' ? 'Saving…' : 'Save as a file…' }}
      </button>
      <p v-if="fileNotice" class="box-notice" role="status">
        {{ fileNotice }}
      </p>
      <p v-if="fileWarning" class="box-error" role="alert">
        {{ fileWarning }}
      </p>
      <p v-if="fileError" class="box-error" role="alert">
        {{ fileError }}
      </p>
    </section>

    <section class="panel">
      <div class="panel-head">
        <h3>Publish to a folder</h3>
        <p class="hint">
          Save the report as a folder of files to host anywhere, such as an S3
          bucket behind a CDN. Publish again to update it.
        </p>
      </div>
      <button
        class="btn-ghost"
        :disabled="!!busy || !hasReport"
        @click="toFolder"
      >
        {{ busy === 'folder' ? 'Saving…' : 'Choose a folder…' }}
      </button>
      <p v-if="folderNotice" class="box-notice" role="status">
        {{ folderNotice }}
      </p>
      <p v-if="folderError" class="box-error" role="alert">
        {{ folderError }}
      </p>
    </section>
  </div>
</template>

<style scoped>
.publish {
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
  align-items: flex-start;
  gap: 14px;
  padding: 20px 22px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
}

.panel > * {
  align-self: stretch;
}

.panel > button {
  align-self: flex-start;
}

.panel-head {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.panel-head h3 {
  font-size: 20px;
}

.badge {
  align-self: flex-start;
  padding: 2px 8px;
  border-radius: var(--radius-sm);
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 12px;
  font-weight: 600;
}

.hint {
  margin: 0;
  color: var(--ink-muted);
  font-size: 14px;
}

.published {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 12px 14px;
  border-radius: var(--radius-sm);
  background: var(--surface-muted);
}

.published a {
  color: var(--accent);
  font-weight: 600;
  overflow-wrap: anywhere;
}

.published small {
  color: var(--ink-muted);
}

.published a.manage {
  margin-top: 4px;
  font-size: 13px;
  font-weight: 500;
}

.note {
  margin: 4px 0 0;
  color: var(--ink-muted);
  font-size: 13px;
}

.where {
  display: flex;
  flex-wrap: wrap;
  gap: 12px 20px;
  margin: 0;
  padding: 0;
  border: none;
}

.where .note,
.where .box-error,
.where .hint {
  flex-basis: 100%;
}

.where label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 14px;
  font-weight: 600;
}

.where select {
  min-width: 240px;
  padding: 7px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface);
  font: inherit;
  font-weight: 400;
}
</style>
