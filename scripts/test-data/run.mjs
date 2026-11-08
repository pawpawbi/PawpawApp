// Runs make_test_data.py with the bundled Python (never the system one).
// Usage: npm run test-data -- [--models retail,saas] [--scale 2] [--formats csv,sqlite,parquet,xlsx]
//        [--messy] [--out folder] [--seed 7]
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const runtime = path.resolve(here, '..', '..', 'python', 'runtime');
const python =
  process.platform === 'win32'
    ? path.join(runtime, 'python.exe')
    : path.join(runtime, 'bin', 'python3');

if (!fs.existsSync(python)) {
  console.error(
    'The bundled Python isn\'t installed yet. Run "npm run setup:python" (or "npm start") first.',
  );
  process.exit(1);
}

const result = spawnSync(
  python,
  [
    '-E',
    '-s',
    '-B',
    '-u',
    '-X',
    'utf8',
    path.join(here, 'make_test_data.py'),
    ...process.argv.slice(2),
  ],
  { stdio: 'inherit' },
);
process.exit(result.status ?? 1);
