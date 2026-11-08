// Background work tracking (src/background.ts): saving waits for it, closing waits for or stops it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BackgroundWork, CancelledError } from '../../src/background.ts';

/** A promise plus its resolve function, to control when a task finishes. */
function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

test('running lists tasks per project while they run', async () => {
  const work = new BackgroundWork();
  const a = gate();
  const task = work.run('p1', 'Loading data', () => a.promise);
  assert.deepEqual(work.running('p1'), ['Loading data']);
  assert.deepEqual(work.running('p2'), []);
  assert.deepEqual(work.running(), ['Loading data']);
  a.open();
  await task;
  assert.deepEqual(work.running('p1'), []);
});

test('run returns the result and passes errors through', async () => {
  const work = new BackgroundWork();
  assert.equal(await work.run('p1', 'x', async () => 42), 42);
  await assert.rejects(
    work.run('p1', 'x', async () => {
      throw new Error('boom');
    }),
    /boom/,
  );
  assert.deepEqual(work.running(), []);
});

test('idle resolves at once when nothing runs, and after the last task otherwise', async () => {
  const work = new BackgroundWork();
  await work.idle('p1');

  const a = gate();
  const b = gate();
  const first = work.run('p1', 'one', () => a.promise);
  const second = work.run('p1', 'two', () => b.promise);
  let idle = false;
  const waiting = work.idle('p1').then(() => (idle = true));

  a.open();
  await first;
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(idle, false, 'one task still running');
  b.open();
  await second;
  await waiting;
  assert.equal(idle, true);
});

test('idle for one project ignores other projects', async () => {
  const work = new BackgroundWork();
  const other = gate();
  const task = work.run('p2', 'elsewhere', () => other.promise);
  await work.idle('p1');
  other.open();
  await task;
});

test('block refuses new tasks until unblocked', async () => {
  const work = new BackgroundWork();
  work.block('p1');
  await assert.rejects(
    work.run('p1', 'x', async () => 1),
    /closing/,
  );
  assert.equal(await work.run('p2', 'x', async () => 2), 2);
  work.unblock('p1');
  assert.equal(await work.run('p1', 'x', async () => 3), 3);
});

test('cancel stops registered processes and makes checkCancelled throw', async () => {
  const work = new BackgroundWork();
  const killed: string[] = [];
  const step = gate();
  const task = work.run('p1', 'Refreshing all data', async () => {
    work.onCancel(() => killed.push('runner'));
    await step.promise;
    work.checkCancelled(); // the next step must not run
    return 'finished';
  });

  work.cancel('p1');
  assert.deepEqual(killed, ['runner']);
  step.open();
  await assert.rejects(task, CancelledError);
  assert.deepEqual(work.running(), []);
});

test('cancel only affects the given project', async () => {
  const work = new BackgroundWork();
  const killed: string[] = [];
  const a = gate();
  const b = gate();
  const p1 = work.run('p1', 'one', async () => {
    work.onCancel(() => killed.push('p1'));
    await a.promise;
  });
  const p2 = work.run('p2', 'two', async () => {
    work.onCancel(() => killed.push('p2'));
    await b.promise;
  });
  work.cancel('p1');
  assert.deepEqual(killed, ['p1']);
  a.open();
  b.open();
  await Promise.all([p1, p2]);
});

test('a canceller registered after cancelling runs straight away', async () => {
  const work = new BackgroundWork();
  const killed: string[] = [];
  const step = gate();
  const task = work.run('p1', 'x', async () => {
    await step.promise;
    work.onCancel(() => killed.push('late'));
  });
  work.cancel('p1');
  step.open();
  await task;
  assert.deepEqual(killed, ['late']);
});

test('a released canceller is not called', async () => {
  const work = new BackgroundWork();
  const killed: string[] = [];
  const step = gate();
  const task = work.run('p1', 'x', async () => {
    const release = work.onCancel(() => killed.push('finished process'));
    release();
    await step.promise;
  });
  work.cancel('p1');
  step.open();
  await task;
  assert.deepEqual(killed, []);
});

test('onCancel and checkCancelled outside a task do nothing', () => {
  const work = new BackgroundWork();
  work.onCancel(() => assert.fail('should not be called'))();
  work.cancel();
  work.checkCancelled();
});

test('onChange fires when tasks start and finish', async () => {
  const work = new BackgroundWork();
  let changes = 0;
  const unsubscribe = work.onChange(() => changes++);
  await work.run('p1', 'x', async () => {});
  assert.equal(changes, 2);
  unsubscribe();
  await work.run('p1', 'x', async () => {});
  assert.equal(changes, 2);
});

test('stop ends only the task with that key', async () => {
  const work = new BackgroundWork();
  const killed: string[] = [];
  const a = gate();
  const b = gate();
  const loadA = work.run(
    'p1',
    'Loading data',
    async () => {
      work.onCancel(() => killed.push('a'));
      await a.promise;
      work.checkCancelled();
      return 'a';
    },
    'source-a',
  );
  const loadB = work.run(
    'p1',
    'Loading data',
    async () => {
      work.onCancel(() => killed.push('b'));
      await b.promise;
      work.checkCancelled();
      return 'b';
    },
    'source-b',
  );

  work.stop('p2', 'source-a'); // another project's task with that key: nothing
  work.stop('p1', 'source-a');
  assert.deepEqual(killed, ['a']);
  a.open();
  b.open();
  await assert.rejects(loadA, { message: 'Stopped.' });
  assert.equal(await loadB, 'b');
});
