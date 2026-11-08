// The report site on disk (src/report-site.ts). report.json, page files and datasets.json come
// from project files that may be someone else's, so they're read defensively.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { GUID } from '../../src/shared/ids.ts';
import {
  MENU_CSS,
  menuHtml,
  withMenu,
  withoutOldMenu,
} from '../../src/shared/site-menu.ts';
import {
  MAX_FILE_BYTES,
  cleanDatasets,
  cleanReport,
  createPage,
  createSite,
  datasetFile,
  deletePage,
  exportSite,
  hasSite,
  readReport,
  readSiteFile,
  renamePage,
  renameReport,
  sitePath,
  writeSiteFile,
  type SiteTemplates,
} from '../../src/report-site.ts';

const TEMPLATES: SiteTemplates = {
  index: '<title>{{title}}</title><h1>{{title}}</h1>',
  page: '<title>{{title}}</title><h1>{{title}}</h1>{{unknown}}',
  css: 'body {}',
  charts: 'window.pawpaw = {};',
};

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pawpaw-site-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 });
});

const read = (file: string) =>
  fs.readFile(path.join(dir, 'report', file), 'utf8');
const exists = (p: string) =>
  fs.access(p).then(
    () => true,
    () => false,
  );

test('a new site has a landing page, assets and one page with a GUID', async () => {
  assert.equal(await hasSite(dir), false);
  const report = await createSite(dir, 'Sales <2024>', TEMPLATES);
  assert.equal(await hasSite(dir), true);
  assert.equal(report.title, 'Sales <2024>');
  assert.equal(report.pages.length, 1);
  assert.match(report.pages[0].id, GUID);
  assert.equal(report.pages[0].title, 'Overview');
  assert.equal(
    await read('index.html'),
    '<title>Sales &lt;2024&gt;</title><h1>Sales &lt;2024&gt;</h1>',
  );
  assert.equal(await read('assets/report.css'), 'body {}');
  assert.equal(await read('assets/charts.js'), 'window.pawpaw = {};');
  assert.equal(
    await read(`pages/${report.pages[0].id}.html`),
    '<title>Overview</title><h1>Overview</h1>{{unknown}}',
  );
});

test('pages are added, renamed and deleted', async () => {
  const { pages } = await createSite(dir, 'Report', TEMPLATES);
  const added = await createPage(dir, '  Sales \n by region ', TEMPLATES);
  assert.equal(added.title, 'Sales by region');
  assert.notEqual(added.id, pages[0].id);

  await renamePage(dir, added.id, 'Regions');
  assert.deepEqual(
    (await readReport(dir)).pages.map((p) => p.title),
    ['Overview', 'Regions'],
  );
  await assert.rejects(renamePage(dir, added.id, '  '), /Enter a title/);

  await deletePage(dir, pages[0].id);
  assert.deepEqual(
    (await readReport(dir)).pages.map((p) => p.id),
    [added.id],
  );
  assert.equal(
    await exists(path.join(dir, 'report', 'pages', `${pages[0].id}.html`)),
    false,
  );
  await assert.rejects(deletePage(dir, pages[0].id), /doesn’t exist/);
});

test('a damaged or hostile report.json is cleaned up', () => {
  const good = '3f2b8c1e-9a4d-4e7b-b6c2-5d1e8f0a7c94';
  const report = cleanReport({
    title: 42,
    pages: [
      { id: good, title: 'Fine' },
      { id: good, title: 'Duplicate' },
      { id: '../../manifest', title: 'Path' },
      { id: 'k3f9x2ab', title: 'Not a GUID' },
      { id: good.toUpperCase(), title: 'Upper case' },
      { id: '3f2b8c1e-9a4d-1e7b-b6c2-5d1e8f0a7c94', title: 'Version 1' },
      null,
    ],
  });
  assert.equal(report.title, 'Report');
  assert.deepEqual(report.pages, [{ id: good, title: 'Fine' }]);
  assert.deepEqual(cleanReport('nonsense'), { title: 'Report', pages: [] });
});

test('site paths stay inside the report folder and serve only known file types', () => {
  const root = path.join(dir, 'report');
  assert.equal(
    sitePath(dir, '/pages/a.html'),
    path.join(root, 'pages', 'a.html'),
  );
  assert.equal(
    sitePath(dir, 'data/sales.json'),
    path.join(root, 'data', 'sales.json'),
  );
  assert.equal(
    sitePath(dir, '/assets/my%20logo.png'),
    path.join(root, 'assets', 'my logo.png'),
  );
  for (const bad of [
    '/../manifest.json',
    '/pages/..%2F..%2Fmanifest.json',
    '/..\\manifest.json',
    '/%2e%2e/manifest.json',
    '/.hidden/x.html',
    '/data/.sales.json.tmp',
    '/C:/Windows/win.ini',
    '/assets/run.exe',
    '/assets/x.html%00.png',
    '/',
    '/%E0%A4%A',
  ]) {
    assert.equal(sitePath(dir, bad), null, bad);
  }
});

test('pages, styles and scripts can be edited; data and other files cannot', async () => {
  await createSite(dir, 'Report', TEMPLATES);
  await writeSiteFile(dir, 'assets/report.css', 'h1 { color: red }');
  assert.equal(
    await readSiteFile(dir, 'assets/report.css'),
    'h1 { color: red }',
  );
  await writeSiteFile(dir, 'assets/extra.js', '1');
  assert.equal(await read('assets/extra.js'), '1');

  await assert.rejects(writeSiteFile(dir, 'data/sales.js', 'x'), /data\//);
  await assert.rejects(writeSiteFile(dir, 'report.json', '{}'), /isn’t a page/);
  await assert.rejects(
    writeSiteFile(dir, '../manifest.html', 'x'),
    /isn’t a page/,
  );
  await assert.rejects(
    writeSiteFile(dir, 'pages/big.html', 'x'.repeat(MAX_FILE_BYTES + 1)),
    /too big/,
  );
});

test('export copies the site into an empty folder, leaving out hidden files', async () => {
  await createSite(dir, 'Report', TEMPLATES);
  await fs.writeFile(path.join(dir, 'report', 'data', 'sales.json'), '{}');
  await fs.writeFile(path.join(dir, 'report', 'data', '.sales.json.tmp'), '');
  const out = path.join(dir, 'out');

  await exportSite(dir, out);
  assert.ok(await exists(path.join(out, 'index.html')));
  assert.ok(await exists(path.join(out, 'report.json')));
  assert.ok(await exists(path.join(out, 'data', 'sales.json')));
  assert.equal(await exists(path.join(out, 'data', '.sales.json.tmp')), false);

  await assert.rejects(exportSite(dir, out), /empty folder/);
});

test('datasets.json keeps only valid names and fields', () => {
  const file = cleanDatasets({
    datasets: {
      revenue_by_month: { sql: 'SELECT 1', updatedAt: 'x', rows: 3, error: 7 },
      '../evil': { sql: 'SELECT 1' },
      Upper: { sql: 'SELECT 1' },
      no_sql: { sql: 42 },
    },
  });
  assert.deepEqual(file, {
    datasets: {
      revenue_by_month: { sql: 'SELECT 1', updatedAt: 'x', rows: 3 },
    },
  });
  assert.throws(() => datasetFile(dir, '../evil'), /Invalid dataset name/);
  assert.equal(
    datasetFile(dir, 'sales'),
    path.join(dir, 'report', 'data', 'sales.json'),
  );
});

test('the menu lists every page, marks the current one and escapes titles', () => {
  const report = {
    title: 'Sales & <Co>',
    pages: [
      { id: 'a', title: 'Overview' },
      { id: 'b', title: '"Q1"' },
    ],
  };
  assert.equal(
    menuHtml(report, 'b'),
    '<header class="pp-menu"><a class="pp-menu-title" href="../index.html">Sales &amp; &lt;Co&gt;</a>' +
      '<ul class="pp-menu-list"><li><a class="pp-menu-link" href="a.html">Overview</a></li>' +
      '<li><a class="pp-menu-link" href="b.html" aria-current="page">&quot;Q1&quot;</a></li></ul></header>',
  );
});

test('pages lose the menu they used to draw for themselves', () => {
  const old = `<body>
    <header id="nav" class="site-header"></header>
    <main class="page"><h1>Hi</h1></main>
    <script>
      pawpaw.nav('#nav');
      pawpaw.barChart('#a', 'sales');
    </script>
  </body>`;
  const page = withoutOldMenu(old);
  assert.doesNotMatch(page, /id="nav"|pawpaw\.nav/);
  assert.match(page, /<main class="page">[\s\S]*pawpaw\.barChart/);
  // The landing page's list of pages is left alone.
  assert.equal(
    withoutOldMenu("pawpaw.nav('#pages');"),
    "pawpaw.nav('#pages');",
  );
});

test('publishing writes the menu and its styles into each page', async () => {
  const report = await createSite(dir, 'Report', {
    ...TEMPLATES,
    page: '<html><head><title>{{title}}</title></head><body><h1>{{title}}</h1></body></html>',
  });
  const second = await createPage(dir, 'Second', {
    ...TEMPLATES,
    page: '<html><head></head><body class="x"><h1>{{title}}</h1></body></html>',
  });
  const out = path.join(dir, 'out');
  await exportSite(dir, out);

  const first = await fs.readFile(
    path.join(out, 'pages', `${report.pages[0].id}.html`),
    'utf8',
  );
  assert.ok(first.includes(`<style>\n${MENU_CSS}\n</style>\n</head>`));
  assert.match(first, /<body>\n<header class="pp-menu">.*<\/header><h1>/);
  assert.match(
    first,
    new RegExp(`href="${report.pages[0].id}.html" aria-current="page"`),
  );

  const other = await fs.readFile(
    path.join(out, 'pages', `${second.id}.html`),
    'utf8',
  );
  assert.match(other, /<body class="x">\n<header class="pp-menu">/);
  assert.match(
    other,
    new RegExp(`href="${second.id}.html" aria-current="page">Second`),
  );
  // The project's own page files keep no menu.
  const own = await readSiteFile(dir, `pages/${second.id}.html`);
  assert.doesNotMatch(own, /pp-menu/);
  // Without a head or body, the menu and its styles go first.
  assert.match(
    withMenu('<p>no head or body</p>', await readReport(dir), second.id),
    /^<header class="pp-menu">.*<\/header><style>[\s\S]*<\/style>\n<p>no head or body<\/p>$/,
  );
});

test('the report can be renamed', async () => {
  await createSite(dir, 'Report', TEMPLATES);
  await renameReport(dir, '  Sales   overview ');
  assert.equal((await readReport(dir)).title, 'Sales overview');
  await assert.rejects(renameReport(dir, '  '), /Enter a title/);
});
