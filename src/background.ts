// Tracks background work on open projects (data loads, rebuilds, connector downloads), so that
// saving can wait for it and closing can wait for it or stop it. Without this, closing a project
// mid-load deleted the working folder the load was writing into, and saving could capture
// half-written tables.
//
// No Electron imports, so it's testable with plain Node (tests/node/background.test.ts).
import { AsyncLocalStorage } from 'node:async_hooks';

export class CancelledError extends Error {
  constructor() {
    super('Stopped.');
  }
}

interface Task {
  projectId: string;
  label: string;
  /** Names the task so it can be stopped on its own (see stop), e.g. a data source's ID. */
  key?: string;
  cancelled: boolean;
  /** Ways to stop the task's work, e.g. killing the process it started. */
  cancelers: Set<() => void>;
}

export class BackgroundWork {
  private tasks = new Set<Task>();
  private blocked = new Set<string>();
  private listeners = new Set<() => void>();
  private idleWaiters: { projectId?: string; resolve: () => void }[] = [];
  private current = new AsyncLocalStorage<Task>();

  /**
   * Runs `work` as a tracked task of a project. Refused while the project is saving or closing.
   * Processes started inside it should register with onCancel so it can be stopped.
   */
  async run<T>(
    projectId: string,
    label: string,
    work: () => Promise<T>,
    key?: string,
  ): Promise<T> {
    if (this.blocked.has(projectId)) {
      throw new Error('The project is saving or closing, so this can’t start.');
    }
    const task: Task = {
      projectId,
      label,
      key,
      cancelled: false,
      cancelers: new Set(),
    };
    this.tasks.add(task);
    this.changed();
    try {
      return await this.current.run(task, work);
    } finally {
      this.tasks.delete(task);
      this.changed();
      this.resolveIdleWaiters();
    }
  }

  /**
   * Registers a way to stop the current task's work (if called inside run). Returns a function
   * that unregisters it, to call once that work has finished.
   */
  onCancel(cancel: () => void): () => void {
    const task = this.current.getStore();
    if (!task) return () => {};
    if (task.cancelled) cancel();
    task.cancelers.add(cancel);
    return () => task.cancelers.delete(cancel);
  }

  /** Throws CancelledError if the current task has been stopped. Call between steps. */
  checkCancelled() {
    if (this.current.getStore()?.cancelled) throw new CancelledError();
  }

  /** Labels of the running tasks, for a project or all projects. */
  running(projectId?: string): string[] {
    return [...this.tasks]
      .filter((t) => projectId === undefined || t.projectId === projectId)
      .map((t) => t.label);
  }

  /** Resolves once a project (or every project) has no running tasks. */
  idle(projectId?: string): Promise<void> {
    if (this.running(projectId).length === 0) return Promise.resolve();
    return new Promise((resolve) =>
      this.idleWaiters.push({ projectId, resolve }),
    );
  }

  /** Stops a project's (or every project's) running tasks. */
  cancel(projectId?: string) {
    for (const task of this.tasks) {
      if (projectId !== undefined && task.projectId !== projectId) continue;
      this.stopTask(task);
    }
  }

  /** Stops a project's running tasks with the given key (the user pressed Stop). */
  stop(projectId: string, key: string) {
    for (const task of this.tasks) {
      if (task.projectId === projectId && task.key === key) this.stopTask(task);
    }
  }

  private stopTask(task: Task) {
    task.cancelled = true;
    for (const cancel of task.cancelers) {
      try {
        cancel();
      } catch {
        // Already finished.
      }
    }
  }

  /** Refuses new tasks for a project (while it's closing) until unblock. */
  block(projectId: string) {
    this.blocked.add(projectId);
  }

  unblock(projectId: string) {
    this.blocked.delete(projectId);
  }

  /** Called whenever a task starts or finishes. Returns an unsubscribe function. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed() {
    for (const listener of this.listeners) listener();
  }

  private resolveIdleWaiters() {
    this.idleWaiters = this.idleWaiters.filter((waiter) => {
      if (this.running(waiter.projectId).length > 0) return true;
      waiter.resolve();
      return false;
    });
  }
}

/** The app's tracker. */
export const work = new BackgroundWork();
