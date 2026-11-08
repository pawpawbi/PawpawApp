// The assistant's settings, kept on this computer, never in a project:
//   userData/assistant/settings.json   which provider, and the model chosen for each
//   userData/assistant/<provider>.key  that provider's API key, encrypted with the OS's secure
//                                      storage (Electron safeStorage)
import { app, safeStorage } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { removePath, writeJson } from '../fs-json';
import type { AssistantPermissions, AssistantSettings } from '../shared/types';
import { DEFAULT_MODELS, PROVIDERS } from './models';
import type { ProviderId } from './types';

const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[];

const dir = () => path.join(app.getPath('userData'), 'assistant');
const settingsPath = () => path.join(dir(), 'settings.json');

function keyPath(provider: ProviderId) {
  if (!PROVIDER_IDS.includes(provider)) throw new Error('Unknown provider.');
  if (!PROVIDERS[provider].needsKey)
    throw new Error(`${PROVIDERS[provider].name} doesn't use a key.`);
  return path.join(dir(), `${provider}.key`);
}

interface SettingsFile {
  provider: ProviderId;
  models: Record<ProviderId, string>;
  /** Whether the assistant asks before each change. Asks unless the user chose otherwise. */
  permissions: AssistantPermissions;
}

async function readFile(): Promise<SettingsFile> {
  const file: SettingsFile = {
    provider: 'anthropic',
    models: { ...DEFAULT_MODELS },
    permissions: 'ask',
  };
  try {
    const saved = JSON.parse(await fs.readFile(settingsPath(), 'utf8'));
    if (PROVIDER_IDS.includes(saved?.provider)) file.provider = saved.provider;
    if (saved?.permissions === 'allow') file.permissions = 'allow';
    for (const id of PROVIDER_IDS) {
      if (typeof saved?.models?.[id] === 'string' && saved.models[id]) {
        file.models[id] = saved.models[id];
      }
    }
  } catch {
    // Not set up yet.
  }
  return file;
}

const exists = (p: string) =>
  fs.access(p).then(
    () => true,
    () => false,
  );

/** The settings the UI shows. Keys are never sent back, only whether one is saved. */
export async function getSettings(): Promise<AssistantSettings> {
  const file = await readFile();
  const hasKey = { anthropic: false, openai: false, ollama: false };
  for (const id of PROVIDER_IDS) {
    if (PROVIDERS[id].needsKey) hasKey[id] = await exists(keyPath(id));
  }
  return {
    provider: file.provider,
    models: file.models,
    hasKey,
    ready: PROVIDERS[file.provider].needsKey
      ? hasKey[file.provider]
      : !!file.models[file.provider],
    permissions: file.permissions,
  };
}

export async function saveSettings(provider: ProviderId, model: string) {
  if (!PROVIDER_IDS.includes(provider)) throw new Error('Unknown provider.');
  const file = await readFile();
  file.provider = provider;
  if (typeof model === 'string' && model.trim())
    file.models[provider] = model.trim();
  await writeJson(settingsPath(), file);
}

export async function setPermissions(permissions: AssistantPermissions) {
  const file = await readFile();
  file.permissions = permissions === 'allow' ? 'allow' : 'ask';
  await writeJson(settingsPath(), file);
}

export async function setKey(provider: ProviderId, key: string) {
  const clean = typeof key === 'string' ? key.trim() : '';
  if (!clean) throw new Error('Paste an API key.');
  if (/\s/.test(clean))
    throw new Error("That doesn't look like an API key: it has spaces in it.");
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      "This computer's secure storage isn't available, so the key can't be saved.",
    );
  }
  await fs.mkdir(dir(), { recursive: true });
  await fs.writeFile(keyPath(provider), safeStorage.encryptString(clean));
}

export async function removeKey(provider: ProviderId) {
  await removePath(keyPath(provider));
}

/** The saved key, or null. Only the main process ever sees it. */
export async function readKey(provider: ProviderId): Promise<string | null> {
  if (!PROVIDERS[provider]?.needsKey) return null;
  try {
    return safeStorage.decryptString(await fs.readFile(keyPath(provider)));
  } catch {
    return null;
  }
}
