// Downloads a portable Python runtime into python/runtime and installs python/requirements.txt.
// Runs automatically before start/package/make, and does nothing when already up to date.
// Builds come from https://github.com/astral-sh/python-build-standalone
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RELEASE = '20261001';
const PYTHON_VERSION = '3.12.15';
const BUILDS = {
  'win32-x64': {
    triple: 'x86_64-pc-windows-msvc',
    sha256: '52124cee54126f3f360eaa378288f6f64c402c983a3c14c95eff67f4af986aaa',
  },
  'darwin-arm64': {
    triple: 'aarch64-apple-darwin',
    sha256: '10cab8f6ed6202fdd81637aa6eda4af8d5b7eaa8fc42f9df3c6bea4923de0d93',
  },
  'darwin-x64': {
    triple: 'x86_64-apple-darwin',
    sha256: 'd101ac54bc34afff54741406261325dc896b7b646a36a58fff4845ef0a00b2ce',
  },
  'linux-x64': {
    triple: 'x86_64-unknown-linux-gnu',
    sha256: '7bb1659e3235077b7f63d5b6eb6ce653c6fcd6c5041e9d5f73b42ce10421464d',
  },
};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pythonDir = path.join(root, 'python');
const runtimeDir = path.join(pythonDir, 'runtime');
const requirementsPath = path.join(pythonDir, 'requirements.txt');
const constraintsPath = path.join(pythonDir, 'constraints.txt');
const stampPath = path.join(runtimeDir, '.pawpaw-stamp');
const cacheDir = path.join(root, 'node_modules', '.cache', 'pawpaw-python');

const platformKey = `${process.platform}-${process.arch}`;
const build = BUILDS[platformKey];
if (!build) {
  console.error(`No bundled Python build is configured for ${platformKey}.`);
  process.exit(1);
}

const pythonExe =
  process.platform === 'win32'
    ? path.join(runtimeDir, 'python.exe')
    : path.join(runtimeDir, 'bin', 'python3');
const readIfExists = (file) =>
  fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
const requirements = readIfExists(requirementsPath);
const constraints = readIfExists(constraintsPath);
const lockOnly = process.argv.includes('--lock');

// Changes whenever the Python build, requirements or locked versions change.
const computeStamp = () =>
  createHash('sha256')
    .update(
      [
        RELEASE,
        PYTHON_VERSION,
        platformKey,
        requirements,
        readIfExists(constraintsPath),
      ].join('\n'),
    )
    .digest('hex');

if (!lockOnly && readIfExists(stampPath) === computeStamp()) {
  process.exit(0);
}

const archiveName = `cpython-${PYTHON_VERSION}+${RELEASE}-${build.triple}-install_only_stripped.tar.gz`;
const archivePath = path.join(cacheDir, archiveName);

async function download() {
  if (fs.existsSync(archivePath)) return;
  const url = `https://github.com/astral-sh/python-build-standalone/releases/download/${RELEASE}/${encodeURIComponent(archiveName)}`;
  console.log(`Downloading Python ${PYTHON_VERSION} (${build.triple})...`);
  const response = await fetch(url);
  if (!response.ok)
    throw new Error(
      `Download failed: ${response.status} ${response.statusText}`,
    );
  const data = Buffer.from(await response.arrayBuffer());

  const actual = createHash('sha256').update(data).digest('hex');
  if (actual !== build.sha256) {
    throw new Error(
      `Checksum mismatch for ${archiveName}: expected ${build.sha256}, got ${actual}`,
    );
  }
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(archivePath, data);
}

function extract() {
  console.log('Extracting Python runtime...');
  fs.rmSync(runtimeDir, { recursive: true, force: true, maxRetries: 5 });
  fs.mkdirSync(runtimeDir, { recursive: true });

  // Use Windows' built-in bsdtar explicitly; GNU tar from Git Bash misreads "C:\" paths.
  const tar =
    process.platform === 'win32'
      ? path.join(
          process.env.SystemRoot ?? 'C:\\Windows',
          'System32',
          'tar.exe',
        )
      : 'tar';
  // The archive has a single top-level "python" folder; strip it so files land in runtime/.
  // (Extracting in place avoids renaming freshly written files, which antivirus can block.)
  execFileSync(
    tar,
    ['-xzf', archivePath, '-C', runtimeDir, '--strip-components', '1'],
    {
      stdio: 'inherit',
    },
  );
}

function installRequirements() {
  const hasPackages = requirements
    .split(/\r?\n/)
    .some((line) => line.trim() !== '' && !line.trim().startsWith('#'));
  if (!hasPackages) return;

  console.log('Installing Python packages...');
  const args = [
    '-m',
    'pip',
    'install',
    '--disable-pip-version-check',
    '--no-warn-script-location',
  ];
  args.push('-r', requirementsPath);
  // Constraints pin every transitive dependency so all machines get identical packages.
  // Skipped with --lock, which resolves fresh versions to write a new constraints file, using
  // only releases at least 14 days old (the project's rule for every dependency).
  if (lockOnly) args.push('--uploaded-prior-to', 'P14D');
  else if (constraints) args.push('-c', constraintsPath);
  execFileSync(pythonExe, args, { stdio: 'inherit' });
}

function writeConstraints() {
  const frozen = execFileSync(
    pythonExe,
    ['-m', 'pip', 'freeze', '--disable-pip-version-check'],
    {
      encoding: 'utf8',
    },
  );
  const header =
    '# Generated by `npm run lock:python` from requirements.txt. Do not edit by hand.\n' +
    `# Resolved on ${platformKey}; platform-only packages are ignored elsewhere.\n`;
  fs.writeFileSync(constraintsPath, header + frozen.replace(/\r\n/g, '\n'));
  console.log('Wrote python/constraints.txt.');
}

await download();
extract();
installRequirements();
if (lockOnly) writeConstraints();
fs.writeFileSync(stampPath, computeStamp());
console.log(`Python ${PYTHON_VERSION} is ready in python/runtime.`);
