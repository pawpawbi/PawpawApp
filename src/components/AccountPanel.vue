<script setup lang="ts">
// Signing in to PawpawBI with an email and password, or who's signed in. Used where publishing
// needs an account. Verifying the email address happens in the web console, through the link
// emailed at sign-up; until then this says so, and checks again when the window gets focus.
import { onMounted, onUnmounted, ref } from 'vue';
import { errorMessage } from '../errors';
import type { AccountState } from '../shared/types';

const emit = defineEmits<{ changed: [state: AccountState] }>();

const state = ref<AccountState | null>(null);
const mode = ref<'sign-in' | 'sign-up'>('sign-in');
const email = ref('');
const password = ref('');
const busy = ref<'' | 'email' | 'sign-out'>('');
const error = ref('');

function update(next: AccountState) {
  state.value = next;
  emit('changed', next);
}

async function reload() {
  try {
    update(await window.api.account.get());
  } catch (e) {
    error.value = errorMessage(e);
  }
}

function recheck() {
  if (state.value?.email && !state.value.emailVerified && !busy.value) reload();
}

onMounted(() => {
  reload();
  window.addEventListener('focus', recheck);
});
onUnmounted(() => window.removeEventListener('focus', recheck));
defineExpose({ reload });

async function run(
  kind: typeof busy.value,
  action: () => Promise<AccountState>,
) {
  busy.value = kind;
  error.value = '';
  try {
    update(await action());
    password.value = '';
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    busy.value = '';
  }
}

const submit = () =>
  run('email', () =>
    mode.value === 'sign-in'
      ? window.api.account.signIn(email.value, password.value)
      : window.api.account.signUp(email.value, password.value),
  );
const signOut = () => run('sign-out', () => window.api.account.signOut());
</script>

<template>
  <div class="account">
    <p v-if="!state" class="muted">Checking your account…</p>

    <p v-else-if="!state.available" class="box-notice muted-box">
      Publishing to PawpawBI isn't available in this version yet.
    </p>

    <div v-else-if="state.email" class="signed-in">
      <span class="avatar" aria-hidden="true">{{
        state.email.charAt(0).toUpperCase()
      }}</span>
      <span>
        Signed in as <strong>{{ state.email }}</strong>
      </span>
      <a
        v-if="state.consoleUrl"
        class="console-link"
        :href="state.consoleUrl"
        target="_blank"
        rel="noreferrer"
        title="Your account, organisations and members, and who can open each report"
        >Manage your account</a
      >
      <button class="btn-link" :disabled="!!busy" @click="signOut">
        Sign out
      </button>
    </div>

    <div v-else class="sign-in">
      <p class="intro">
        {{
          mode === 'sign-in'
            ? 'Sign in to your PawpawBI account to publish.'
            : 'Create a free PawpawBI account to publish your reports.'
        }}
      </p>
      <form class="form" @submit.prevent="submit">
        <label>
          Email
          <input v-model="email" type="email" autocomplete="email" required />
        </label>
        <label>
          Password
          <input
            v-model="password"
            type="password"
            :autocomplete="
              mode === 'sign-in' ? 'current-password' : 'new-password'
            "
            :minlength="mode === 'sign-up' ? 8 : undefined"
            required
          />
          <small v-if="mode === 'sign-up'">At least 8 characters.</small>
        </label>
        <button class="btn-primary" type="submit" :disabled="!!busy">
          {{
            busy === 'email'
              ? 'One moment…'
              : mode === 'sign-in'
                ? 'Sign in'
                : 'Create account'
          }}
        </button>
      </form>
      <a
        v-if="mode === 'sign-in' && state.consoleUrl"
        class="forgot"
        :href="`${state.consoleUrl}/#/forgot`"
        target="_blank"
        rel="noreferrer"
        >Forgot your password?</a
      >
      <p class="switch">
        <template v-if="mode === 'sign-in'">
          New to PawpawBI?
          <button class="btn-link" @click="mode = 'sign-up'">
            Create an account
          </button>
        </template>
        <template v-else>
          Already have an account?
          <button class="btn-link" @click="mode = 'sign-in'">Sign in</button>
        </template>
      </p>
    </div>

    <p
      v-if="state?.available && state.email && !state.emailVerified"
      class="verify-note"
    >
      We emailed a link to {{ state.email }}. Open it to verify your address.
      <a
        v-if="state.consoleUrl"
        :href="`${state.consoleUrl}/#/account`"
        target="_blank"
        rel="noreferrer"
        >Send a new link</a
      >
    </p>

    <p v-if="error" class="box-error" role="alert">{{ error }}</p>
  </div>
</template>

<style scoped>
.account {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.muted,
.intro,
.switch {
  margin: 0;
  color: var(--ink-muted);
  font-size: 14px;
}

.muted-box {
  background: var(--surface-muted);
  color: var(--ink-muted);
}

.signed-in {
  display: flex;
  align-items: center;
  gap: 10px;
}

.forgot {
  align-self: flex-start;
  color: var(--accent);
  font-size: 14px;
}

.verify-note {
  margin: 0;
  color: var(--ink-muted);
  font-size: 14px;
}

.verify-note a {
  color: var(--accent);
}

.console-link {
  margin-left: auto;
  color: var(--accent);
  font-size: 14px;
}

.avatar {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border-radius: var(--radius-sm);
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 600;
}

.sign-in {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-width: 380px;
}

.form {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.form label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 14px;
  font-weight: 600;
}

.form input {
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font: inherit;
  font-weight: 400;
}

.form small {
  color: var(--ink-muted);
  font-weight: 400;
}

.form .btn-primary {
  align-self: flex-start;
}
</style>
