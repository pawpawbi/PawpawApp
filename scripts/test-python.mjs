// Runs the Python sidecar's tests (python/tests) with pytest.
//
// pytest is installed into a separate virtual environment, python/.venv-test, so it never ends
// up in the bundled runtime that ships with the app. The venv is created from the bundled
// runtime with --system-site-packages, so tests see the same dlt, pyarrow and DuckDB as the app.
//
// Usage: npm run test:python [-- <extra pytest arguments>]
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pythonDir = path.join(root, 'python');
const runtimeDir = path.join(pythonDir, 'runtime');
const venvDir = path.join(pythonDir, '.venv-test');
const requirementsPath = path.join(pythonDir, 'requirements-test.txt');
const constraintsPath = path.join(pythonDir, 'constraints.txt');
const stampPath = path.join(venvDir, '.pawpaw-test-stamp');

const isWindows = process.platform === 'win32';
const runtimePython = isWindows
  ? path.join(runtimeDir, 'python.exe')
  : path.join(runtimeDir, 'bin', 'python3');
const venvPython = isWindows
  ? path.join(venvDir, 'Scripts', 'python.exe')
  : path.join(venvDir, 'bin', 'python');

const readIfExists = (file) =>
  fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function runOrExit(command, args) {
  const status = run(command, args);
  if (status !== 0) process.exit(status);
}

if (!fs.existsSync(runtimePython)) {
  console.error(
    'The bundled Python runtime is missing. Run `npm run setup:python` first.',
  );
  process.exit(1);
}

// Changes when the test requirements, the locked versions or the runtime itself change
// (the runtime's own stamp changes whenever setup-python reinstalls it).
const stamp = createHash('sha256')
  .update(
    [
      runtimePython,
      readIfExists(path.join(runtimeDir, '.pawpaw-stamp')),
      readIfExists(requirementsPath),
      readIfExists(constraintsPath),
    ].join('\n'),
  )
  .digest('hex');

if (readIfExists(stampPath) !== stamp || !fs.existsSync(venvPython)) {
  console.log('Setting up the Python test environment (python/.venv-test)...');
  fs.rmSync(venvDir, { recursive: true, force: true, maxRetries: 5 });
  runOrExit(runtimePython, [
    '-E',
    '-s',
    '-m',
    'venv',
    '--system-site-packages',
    venvDir,
  ]);
  runOrExit(venvPython, [
    '-E',
    '-s',
    '-m',
    'pip',
    'install',
    '--disable-pip-version-check',
    '--no-warn-script-location',
    '-r',
    requirementsPath,
    '-c',
    constraintsPath,
  ]);
  fs.writeFileSync(stampPath, stamp);
}

// Run every test unless specific test files or folders were given.
const extraArgs = process.argv.slice(2);
const hasPaths = extraArgs.some(
  (arg) =>
    !arg.startsWith('-') &&
    fs.existsSync(path.resolve(root, arg.split('::')[0])),
);
const testArgs = hasPaths
  ? extraArgs
  : [path.join('python', 'tests'), ...extraArgs];

// A fresh dlt state folder per run, so tests never touch the user's real one.
const dltDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pawpaw-pytest-dlt-'));
let status;
try {
  status = run(venvPython, ['-E', '-s', '-B', '-m', 'pytest', ...testArgs], {
    cwd: root,
    env: {
      ...process.env,
      RUNTIME__DLTHUB_TELEMETRY: 'false',
      DLT_DATA_DIR: dltDataDir,
    },
  });
} finally {
  fs.rmSync(dltDataDir, { recursive: true, force: true, maxRetries: 5 });
}
process.exit(status);
