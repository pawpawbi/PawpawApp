// The report as a single HTML file (src/report-single-file.ts). These check what goes into the
// file; how the file behaves in a browser is checked by hand (docs/guides/report.md, "Hosting").
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { buildSingleFile } from '../../src/report-single-file.ts';
import {
  createPage,
  createSite,
  readReport,
  type SiteTemplates,
} from '../../src/report-site.ts';

const TEMPLATES: SiteTemplates = {
  index:
    '<!doctype html><html><head><title>{{title}}</title><link rel="stylesheet" href="assets/report.css"><script src="assets/charts.js"></script></head><body><h1>{{title}}</h1></body></html>',
  page: '<!doctype html><html><head><title>{{title}}</title><link rel="stylesheet" href="../assets/report.css" /><script src="../assets/charts.js"></script></head><body><h1>{{title}}</h1></body></html>',
  css: 'body { background: url("logo.png"); }',
  charts: 'window.pawpaw = { closing: "</script>" };',
};

const SCRIPTS = { viewer: '/* viewer */', frame: '/* frame */' };

interface Bundle {
  title: string;
  pages: { id: string; title: string }[];
  docs: Record<string, string>;
  files: Record<string, { t: string; s?: string; b?: string }>;
}

let dir: string;
let site: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pawpaw-single-'));
  site = path.join(dir, 'report');
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 });
});

/** Builds the file and unpacks its bundle. */
async function build(): Promise<{ html: string; bundle: Bundle }> {
  const html = await buildSingleFile(dir, SCRIPTS);
  const packed =
    /<script type="application\/octet-stream" id="pp-bundle">([^<]*)<\/script>/.exec(
      html,
    );
  assert.ok(packed, 'the file has a bundle');
  const bundle = JSON.parse(
    gunzipSync(Buffer.from(packed[1], 'base64')).toString('utf8'),
  ) as Bundle;
  return { html, bundle };
}

const write = (file: string, content: string | Buffer) =>
  fs.writeFile(path.join(site, ...file.split('/')), content);

test('holds the landing page, every listed page, the datasets and report.json', async () => {
  await createSite(dir, 'Sales', TEMPLATES);
  const extra = await createPage(dir, 'Regions', TEMPLATES);
  const report = await readReport(dir);
  await write('data/revenue.json', '{"columns":[],"rows":[]}');
  await write('data/.staging.json', '{"secret":true}');
  await write('pages/unlisted.html', '<p>not in report.json</p>');

  const { bundle } = await build();
  assert.equal(bundle.title, 'Sales');
  assert.deepEqual(bundle.pages, report.pages);
  assert.deepEqual(
    Object.keys(bundle.docs).sort(),
    [...report.pages.map((p) => p.id), 'index'].sort(),
  );
  assert.ok(bundle.docs[extra.id].includes('<h1>Regions</h1>'));
  assert.equal(bundle.files['data/revenue.json'].s, '{"columns":[],"rows":[]}');
  assert.deepEqual(JSON.parse(bundle.files['report.json'].s!), report);
  assert.ok(!('data/.staging.json' in bundle.files), 'hidden files left out');
  assert.ok(
    !Object.values(bundle.docs).some((d) => d.includes('not in report.json')),
  );
});

test('leaves out pages whose files are missing', async () => {
  await createSite(dir, 'Sales', TEMPLATES);
  const gone = await createPage(dir, 'Gone', TEMPLATES);
  await fs.rm(path.join(site, 'pages', `${gone.id}.html`));
  const { html, bundle } = await build();
  assert.ok(!bundle.pages.some((p) => p.id === gone.id));
  assert.ok(!(gone.id in bundle.docs));
  assert.ok(!html.includes(gone.id));
  assert.ok(!bundle.files['report.json'].s!.includes(gone.id));
});

test('stores shared files once and marks where pages use them', async () => {
  await createSite(dir, 'Sales', TEMPLATES);
  const page = await createPage(dir, 'Regions', TEMPLATES);
  await write('assets/logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await write(
    `pages/${page.id}.html`,
    `<!doctype html><html><head><link href="../assets/report.css" rel="stylesheet"><script defer src='../assets/charts.js'></script></head>
<body><img src="../assets/logo.png"><div style="background: url(../assets/logo.png)"></div><a href="other.html">x</a><img src="https://example.com/a.png"></body></html>`,
  );

  const { bundle } = await build();
  const doc = bundle.docs[page.id];
  assert.ok(doc.includes('<style>\0t:assets/report.css\0</style>'));
  assert.ok(doc.includes('<script defer>\0t:assets/charts.js\0</script>'));
  assert.ok(doc.includes('<img src="\0u:assets/logo.png\0">'));
  assert.ok(doc.includes('url("\0u:assets/logo.png\0")'));
  assert.ok(doc.includes('href="other.html"'), 'links are left as they are');
  assert.ok(doc.includes('src="https://example.com/a.png"'));
  assert.ok(!doc.includes('../assets/'));

  // Each file once: text for stylesheets and scripts, base64 for the rest.
  assert.equal(bundle.files['assets/logo.png'].b, 'iVBORw==');
  assert.equal(bundle.files['assets/logo.png'].t, 'image/png');
  assert.equal(
    bundle.files['assets/report.css'].s,
    'body { background: url("\0u:assets/logo.png\0"); }',
  );
  assert.ok(
    bundle.docs.index.includes('<style>\0t:assets/report.css\0</style>'),
  );
});

test('each page starts with its <base> on the made-up site and the frame script', async () => {
  await createSite(dir, 'Sales', TEMPLATES);
  const [page] = (await readReport(dir)).pages;
  const { bundle } = await build();
  assert.ok(
    bundle.docs[page.id].startsWith(
      `<!doctype html><html><head><base href="https://report.invalid/pages/${page.id}.html"><script>/* frame */</script><title>`,
    ),
  );
  assert.ok(
    bundle.docs.index.includes(
      '<head><base href="https://report.invalid/index.html"><script>/* frame */</script>',
    ),
  );

  // A page without <head> or <html> still gets them first, after the doctype.
  await write(`pages/${page.id}.html`, '<!DOCTYPE html><p>Bare</p>');
  const bare = (await build()).bundle.docs[page.id];
  assert.ok(bare.startsWith('<!DOCTYPE html><base href='));
});

test('removes the menu pages used to draw for themselves', async () => {
  await createSite(dir, 'Sales', TEMPLATES);
  const [page] = (await readReport(dir)).pages;
  await write(
    `pages/${page.id}.html`,
    `<html><head></head><body><header id="nav"></header><main>Hi</main><script>\npawpaw.nav('#nav');\n</script></body></html>`,
  );
  const doc = (await build()).bundle.docs[page.id];
  assert.ok(!doc.includes('id="nav"'));
  assert.ok(!doc.includes('pawpaw.nav'));
});

test('the page around it: title, menu, security policy and escaping', async () => {
  await createSite(dir, 'Q1 <sales> & "more"', TEMPLATES);
  const [page] = (await readReport(dir)).pages;
  await write('data/odd.json', '{"text":"a\0b"}');
  const { html, bundle } = await build();

  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(
    html.includes('<title>Q1 &lt;sales&gt; &amp; &quot;more&quot;</title>'),
  );
  const csp =
    /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html);
  assert.ok(csp);
  assert.ok(csp[1].includes("default-src 'none'"));
  assert.ok(csp[1].includes("connect-src 'none'"));
  assert.ok(
    html.indexOf(csp[0]) < html.indexOf('<style>'),
    'the policy comes first',
  );

  // The menu links to pages by #<id> and starts hidden (the landing page has none).
  assert.ok(html.includes('<header class="pp-menu" id="pp-menu" hidden>'));
  assert.ok(html.includes(`href="#${page.id}"`));
  assert.ok(html.includes('<a class="pp-menu-title" href="#">'));

  // Nothing ends the viewer's <script> early, and markers can't be forged.
  assert.equal(
    bundle.files['assets/charts.js'].s,
    'window.pawpaw = { closing: "<\\/script>" };',
  );
  assert.equal(bundle.files['data/odd.json'].s, '{"text":"a�b"}');
  assert.ok(html.includes('<script>/* viewer */</script>'));
});
