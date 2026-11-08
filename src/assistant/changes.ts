// The record of the assistant's changes, so each can be undone.
//
// Before a change runs, the files and folders it may touch are copied to the undo store. If the
// change fails, they're put back at once, so a change is never half-done. Undo puts them back
// later: "undo back to here" reverts a change and every change after it, newest first, so the
// project is always left as it was at that point.
//
// The store lives in the working folder beside the project files (not in them), so it survives
// a crash but isn't saved into the .pawpaw file, and goes when the project is closed.
//
// No Electron imports, so this is tested with plain Node (tests/node/assistant-changes.test.ts).
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { newId } from '../shared/ids';
import type { AssistantChange } from '../shared/types';

/** What a change may touch, relative to the project folder. */
export type Target =
  | { file: string }
  /** A folder and everything in it, except subfolders named in `exclude`. */
  | { dir: string; exclude?: string[] };

/** A change as the chat shows it: what it did (e.g. "Created the dataset revenue_by_month"). */
export type ChangeRecord = AssistantChange;

interface Snapshot {
  /** Project-relative path -> content hash before and after the change (null: no file). */
  files: Record<string, { before: string | null; after: string | null }>;
}

interface StoredChange extends ChangeRecord, Snapshot {}

// A path segment: anything Windows allows in a file name (so no control characters).
// eslint-disable-next-line no-control-regex
const SAFE = /^[^<>:"|?*\\/\x00-\x1f]+$/;

/** A project-relative path, checked to stay inside the project folder. */
function checkRelative(relative: string): string[] {
  const parts = relative.split(/[\\/]/).filter(Boolean);
  if (
    !parts.length ||
    parts.some((p) => p === '..' || p === '.' || !SAFE.test(p))
  ) {
    throw new Error(`Invalid path: ${relative}`);
  }
  return parts;
}

const hash = (content: Buffer) =>
  createHash('sha1').update(content).digest('hex');

async function readOrNull(file: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(file);
  } catch {
    return null;
  }
}

export interface JournalOptions {
  /**
   * Files the app rewrites from others (e.g. the report's data, after tables change). They
   * change without anyone editing them, so they're never reported as conflicts.
   */
  rebuilt?: (relative: string) => boolean;
}

export class ChangeJournal {
  private readonly store: string;
  private readonly root: string;
  private readonly rebuilt: (relative: string) => boolean;
  private changes: StoredChange[] | null = null;

  /**
   * @param root the project folder (the working folder's project/)
   * @param store where undo copies are kept, outside the project folder
   */
  constructor(root: string, store: string, options: JournalOptions = {}) {
    this.root = root;
    this.store = store;
    this.rebuilt = options.rebuilt ?? (() => false);
  }

  private abs(relative: string) {
    return path.join(this.root, ...checkRelative(relative));
  }

  private async load(): Promise<StoredChange[]> {
    if (!this.changes) {
      try {
        const saved = JSON.parse(
          await fs.readFile(path.join(this.store, 'journal.json'), 'utf8'),
        );
        this.changes = Array.isArray(saved) ? saved : [];
      } catch {
        this.changes = [];
      }
    }
    return this.changes!;
  }

  private async saveJournal() {
    await fs.mkdir(this.store, { recursive: true });
    await fs.writeFile(
      path.join(this.store, 'journal.json'),
      JSON.stringify(this.changes, null, 2),
    );
  }

  /** Every file a target covers right now, project-relative with forward slashes. */
  private async filesOf(target: Target): Promise<string[]> {
    if ('file' in target) {
      checkRelative(target.file);
      return [target.file.split(/[\\/]/).filter(Boolean).join('/')];
    }
    const base = this.abs(target.dir);
    const exclude = new Set(target.exclude ?? []);
    const found: string[] = [];
    const walk = async (dir: string, prefix: string) => {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const relative = `${prefix}/${entry.name}`;
        if (entry.isDirectory()) {
          if (
            prefix === target.dir.replace(/\/$/, '') &&
            exclude.has(entry.name)
          )
            continue;
          await walk(path.join(dir, entry.name), relative);
        } else if (entry.isFile()) {
          found.push(relative);
        }
      }
    };
    await walk(base, target.dir.replace(/\/$/, ''));
    return found;
  }

  /** Copies every covered file into the store. Returns path -> hash (null if none). */
  private async snapshot(id: string, targets: Target[]) {
    const files: Record<string, string | null> = {};
    for (const target of targets) {
      for (const relative of await this.filesOf(target)) {
        if (relative in files) continue;
        const content = await readOrNull(this.abs(relative));
        files[relative] = content ? hash(content) : null;
        if (content) {
          const copy = path.join(this.store, id, ...checkRelative(relative));
          await fs.mkdir(path.dirname(copy), { recursive: true });
          await fs.writeFile(copy, content);
        }
      }
    }
    return files;
  }

  /**
   * Puts a change's files back as they were before it. Every saved copy is read before any
   * file is touched, so a missing copy (e.g. the store was deleted) changes nothing.
   */
  private async restore(change: StoredChange) {
    const copies = new Map<string, Buffer | null>();
    for (const [relative, { before }] of Object.entries(change.files)) {
      copies.set(
        relative,
        before === null
          ? null
          : await fs.readFile(
              path.join(this.store, change.id, ...checkRelative(relative)),
            ),
      );
    }
    for (const [relative, content] of copies) {
      const target = this.abs(relative);
      if (content === null) {
        await fs.rm(target, { force: true, maxRetries: 5 });
      } else {
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, content);
      }
    }
  }

  /**
   * Runs a change. `targets` must cover every file it may create, change or delete. If it
   * throws, the files are put back and the error rethrown.
   */
  async record<T>(
    summary: string,
    targets: Target[],
    operation: () => Promise<T>,
  ): Promise<{ result: T; record: ChangeRecord }> {
    const changes = await this.load();
    const id = newId();
    const before = await this.snapshot(id, targets);
    const stored: StoredChange = {
      id,
      summary,
      createdAt: new Date().toISOString(),
      undone: false,
      files: {},
    };
    let result: T;
    try {
      result = await operation();
    } catch (error) {
      stored.files = Object.fromEntries(
        Object.entries(before).map(([p, h]) => [p, { before: h, after: null }]),
      );
      // Files the change created inside a covered folder are found by looking again.
      for (const target of targets) {
        for (const relative of await this.filesOf(target)) {
          if (!(relative in stored.files)) {
            stored.files[relative] = { before: null, after: null };
          }
        }
      }
      try {
        await this.restore(stored);
      } catch (restoreError) {
        // Keep the saved copies: they're the only way back. Report both failures.
        throw new Error(
          `${(error as Error)?.message ?? error} Putting the files back also failed (${(restoreError as Error)?.message}); the copies are in ${path.join(this.store, id)}.`,
        );
      }
      await fs.rm(path.join(this.store, id), { recursive: true, force: true });
      throw error;
    }
    // Record what each covered file is now, including ones the change created.
    const after: Record<string, string | null> = {};
    for (const target of targets) {
      for (const relative of await this.filesOf(target)) {
        const content = await readOrNull(this.abs(relative));
        after[relative] = content ? hash(content) : null;
      }
    }
    for (const relative of new Set([
      ...Object.keys(before),
      ...Object.keys(after),
    ])) {
      const b = before[relative] ?? null;
      const a = after[relative] ?? null;
      if (a !== b) stored.files[relative] = { before: b, after: a };
    }
    changes.push(stored);
    await this.saveJournal();
    return { result, record: toRecord(stored) };
  }

  async list(): Promise<ChangeRecord[]> {
    return (await this.load()).map(toRecord);
  }

  /** The changes "undo back to `id`" would revert: it and every later change not yet undone. */
  private async from(id: string) {
    const changes = await this.load();
    const index = changes.findIndex((c) => c.id === id);
    if (index === -1)
      throw new Error("That change isn't in the record any more.");
    if (changes[index].undone)
      throw new Error('That change has already been undone.');
    return changes.slice(index).filter((c) => !c.undone);
  }

  /** Every file undoing back to `id` would put back, project-relative. */
  async files(id: string): Promise<string[]> {
    const files = new Set<string>();
    for (const change of await this.from(id)) {
      for (const relative of Object.keys(change.files)) files.add(relative);
    }
    return [...files].sort();
  }

  /**
   * Files changed since the assistant's last change to them, which undoing back to `id` would
   * overwrite (e.g. the user edited a page the assistant wrote).
   */
  async conflicts(id: string): Promise<string[]> {
    const latest = new Map<string, string | null>();
    for (const change of await this.from(id)) {
      for (const [relative, { after }] of Object.entries(change.files)) {
        latest.set(relative, after);
      }
    }
    const changed: string[] = [];
    for (const [relative, after] of latest) {
      if (this.rebuilt(relative)) continue;
      const content = await readOrNull(this.abs(relative));
      if ((content ? hash(content) : null) !== after) changed.push(relative);
    }
    return changed.sort();
  }

  /** Reverts a change and every later one, newest first. Returns the changes undone. */
  async undoBackTo(id: string): Promise<ChangeRecord[]> {
    const undoing = await this.from(id);
    // Newest first, recording each as it's done, so a failure part-way leaves the record true.
    for (const change of [...undoing].reverse()) {
      await this.restore(change);
      change.undone = true;
      await this.saveJournal();
      await fs.rm(path.join(this.store, change.id), {
        recursive: true,
        force: true,
      });
    }
    return undoing.map(toRecord);
  }
}

const toRecord = ({
  id,
  summary,
  createdAt,
  undone,
}: StoredChange): ChangeRecord => ({
  id,
  summary,
  createdAt,
  undone,
});
