// The user's PawpawBI account: signing in with an email and password, and the sign-in token,
// stored encrypted on this computer (like the assistant's API keys), never in a project.
// Organisations and members are managed in the web console, which the app links to.
// Google and Microsoft sign-in are planned. Server API: docs/pawpaw-server-api.md
import { app, ipcMain, safeStorage, shell } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { removePath } from './fs-json';
import {
  isReportUrl,
  pawpawServer,
  REPORT_ID,
  SignedOutError,
  signedInUrl,
  type ServerAccount,
} from './pawpaw-server';
import type { AccountState } from './shared/types';

/**
 * The PawpawBI server. It will be https://api.pawpawbi.com/v1; it isn't live yet, so this stays
 * empty and publishing to PawpawBI is unavailable in packaged builds until it is. In development, PAWPAW_SERVER points the app at one, such
 * as the stand-in (npm run server:stub).
 */
const SERVER_URL = 'https://api.pawpawbi.com/v1';

/** The web console, where people manage their account, organisations and reports. */
const CONSOLE_URL = 'https://console.pawpawbi.com';

export function serverUrl(): string | null {
  const local = app.isPackaged ? undefined : process.env.PAWPAW_SERVER;
  return local || SERVER_URL || null;
}

/**
 * The console, once the server is live; in development PAWPAW_CONSOLE points at one (the
 * stand-in has none).
 */
function consoleUrl(): string | null {
  if (!app.isPackaged && process.env.PAWPAW_SERVER) {
    return process.env.PAWPAW_CONSOLE || null;
  }
  return SERVER_URL ? CONSOLE_URL : null;
}

interface Saved {
  token: string;
  account: ServerAccount;
}

const accountPath = () => path.join(app.getPath('userData'), 'account.bin');

async function readSaved(): Promise<Saved | null> {
  try {
    const saved = JSON.parse(
      safeStorage.decryptString(await fs.readFile(accountPath())),
    );
    return typeof saved?.token === 'string' && saved.account?.email
      ? saved
      : null;
  } catch {
    return null;
  }
}

async function save(saved: Saved): Promise<AccountState> {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      "This computer's secure storage isn't available, so you can't stay signed in.",
    );
  }
  await fs.mkdir(path.dirname(accountPath()), { recursive: true });
  await fs.writeFile(
    accountPath(),
    safeStorage.encryptString(JSON.stringify(saved)),
  );
  return state();
}

async function state(): Promise<AccountState> {
  const saved = await readSaved();
  return {
    available: serverUrl() !== null,
    email: saved?.account.email ?? null,
    emailVerified: saved?.account.emailVerified === true,
    consoleUrl: consoleUrl(),
  };
}

/**
 * While the address isn't verified, asks the server whether it has been since (the link in the
 * email opens the console). Offline or failing, the saved state stands; a rejected token signs
 * the user out here too.
 */
async function refreshVerified() {
  const saved = await readSaved();
  const url = serverUrl();
  if (!saved || saved.account.emailVerified || !url) return;
  try {
    const account = await pawpawServer(url, saved.token).account();
    if (account.emailVerified) await save({ ...saved, account });
  } catch (error) {
    if (error instanceof SignedOutError) await removePath(accountPath());
  }
}

function requireServerUrl(): string {
  const url = serverUrl();
  if (!url) {
    throw new Error(
      "Publishing to PawpawBI isn't available in this version yet. Publish to a folder instead.",
    );
  }
  return url;
}

/**
 * The server, signed in, for publishing. A rejected token signs the user out on this computer
 * too, so the app asks them to sign in again.
 */
export async function signedInServer() {
  const saved = await readSaved();
  if (!saved) throw new SignedOutError('Sign in to PawpawBI first.');
  return { server: pawpawServer(requireServerUrl(), saved.token), saved };
}

/** Forgets the saved sign-in if `error` says it's no longer valid; rethrows it either way. */
export async function forgetIfSignedOut(error: unknown): Promise<never> {
  if (error instanceof SignedOutError) await removePath(accountPath());
  throw error;
}

function checkDetails(email: unknown, password: unknown) {
  if (typeof email !== 'string' || !/^\S+@\S+\.\S+$/.test(email.trim())) {
    throw new Error('Enter your email address.');
  }
  if (typeof password !== 'string' || !password) {
    throw new Error('Enter your password.');
  }
  return email.trim();
}

export function registerAccountHandlers() {
  ipcMain.handle('account:get', async () => {
    await refreshVerified();
    return state();
  });
  ipcMain.handle('account:sign-up', async (_event, email, password) => {
    const clean = checkDetails(email, password);
    return save(await pawpawServer(requireServerUrl()).signUp(clean, password));
  });
  ipcMain.handle('account:sign-in', async (_event, email, password) => {
    const clean = checkDetails(email, password);
    return save(await pawpawServer(requireServerUrl()).signIn(clean, password));
  });
  // A published report, in the browser. Signed in, it opens with a pass for that report from this
  // app's session, so a members-only report opens without signing in again there. Without one
  // (signed out, offline, no access), the plain link.
  ipcMain.handle('account:open-report', async (_event, reportId, url) => {
    if (!isReportUrl(url)) throw new Error('That isn’t a report’s address.');
    let address = url;
    const saved = await readSaved();
    const server = serverUrl();
    if (
      saved &&
      server &&
      typeof reportId === 'string' &&
      REPORT_ID.test(reportId)
    ) {
      try {
        const granted = await pawpawServer(server, saved.token).reportPass(
          reportId,
        );
        // To the report's address as the server gives it, never one from the page.
        address = signedInUrl(granted.url, granted.pass);
      } catch (error) {
        if (error instanceof SignedOutError) await removePath(accountPath());
      }
    }
    await shell.openExternal(address);
  });
  ipcMain.handle('account:sign-out', async () => {
    const saved = await readSaved();
    const url = serverUrl();
    // Revoke the token if the server can be reached; forget it here either way.
    if (saved && url) {
      await pawpawServer(url, saved.token)
        .signOut()
        .catch(() => {});
    }
    await removePath(accountPath());
    return state();
  });
}
