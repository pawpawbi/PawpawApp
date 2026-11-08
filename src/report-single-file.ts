// The report as a single HTML file, to send by email or share like any other file. It opens in
// a web browser straight from disk, with no internet, and works with any project's copy of the
// chart library. How the file works: src/report-single-file/viewer.js and frame.js.
//
// The pages, the site's other files and the datasets go into one gzipped bundle. Each page is
// shown in a sandboxed frame with a <base> on a made-up site laid out like the published one, so
// its relative URLs resolve as they do when hosted; frame.js answers its requests from the
// bundle. Stylesheets, scripts, images and fonts the pages refer to are put in as markers the
// viewer fills in, so each is stored once however many pages use it. The file's Content
// Security Policy, which its frames inherit, allows no web requests at all.
//
// No Electron imports, so this is tested with plain Node (tests/node/report-single-file.test.ts).
import fs from 'node:fs/promises';
import path from 'node:path';
import { constants, gzipSync } from 'node:zlib';
import { SITE_TYPES, readReport } from './report-site';
import { MENU_CSS, menuHtml, withoutOldMenu } from './shared/site-menu';
import type { ReportFile } from './shared/types';

/** The viewer and frame scripts (src/report-single-file/), bundled into the app. */
export interface SingleFileScripts {
  viewer: string;
  frame: string;
}

/** The made-up site pages are shown on. Must match frame.js. */
const SITE = 'https://report.invalid';

const CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  'media-src data: blob:',
  "connect-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
  `base-uri ${SITE}`,
  "form-action 'none'",
].join('; ');

const SHELL_CSS = `html,
body {
  height: 100%;
  margin: 0;
}
body {
  display: flex;
  flex-direction: column;
  background: #ffffff;
}
.pp-menu[hidden] {
  display: none;
}
.pp-frame {
  display: block;
  flex: 1;
  width: 100%;
  min-height: 0;
  border: 0;
}
.pp-status {
  margin: 0;
  padding: 24px 28px;
  color: #52514e;
  font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
  font-size: 15px;
  line-height: 1.5;
}`;

/** Site files kept as text; everything else is kept as base64. */
const TEXT = new Set(['.css', '.js', '.json']);
/** Files a page's URLs are replaced with data: URLs of. */
const INLINE_URL = /^(image|font)\//;

interface BundleFile {
  /** Content type. */
  t: string;
  /** Text, or */
  s?: string;
  /** base64. */
  b?: string;
}

const escapeHtml = (text: string) =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** Markers are delimited by NUL, so none may be left in the report's own text. */
const withoutNul = (text: string) => text.replace(/\0/g, '�');

const textMarker = (file: string) => `\0t:${file}\0`;
const urlMarker = (file: string) => `\0u:${file}\0`;

/** The report's files that a single file can hold, by site path. Hidden files are left out. */
async function siteFiles(root: string): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  const entries = await fs.readdir(root, {
    recursive: true,
    withFileTypes: true,
  });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const relative = path
      .relative(root, path.join(entry.parentPath, entry.name))
      .split(path.sep)
      .join('/');
    if (relative.split('/').some((part) => part.startsWith('.'))) continue;
    if (!(path.extname(relative).toLowerCase() in SITE_TYPES)) continue;
    files.set(
      relative,
      await fs.readFile(path.join(root, ...relative.split('/'))),
    );
  }
  return files;
}

const typeOf = (file: string) => SITE_TYPES[path.extname(file).toLowerCase()];

class SingleFileBuilder {
  private readonly files = new Map<string, BundleFile>();
  private readonly found: Map<string, Buffer>;

  constructor(found: Map<string, Buffer>) {
    this.found = found;
  }

  /** The site file a URL in a document at `base` refers to, if the file is in the report. */
  private resolve(ref: string, base: string): string | null {
    const value = ref.trim().replace(/&amp;/g, '&');
    if (!value || value.startsWith('#') || /^data:/i.test(value)) return null;
    let url;
    try {
      url = new URL(value, base);
    } catch {
      return null;
    }
    if (url.origin !== SITE) return null;
    let file;
    try {
      file = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    } catch {
      return null;
    }
    return this.found.has(file) ? file : null;
  }

  /** Adds a file to the bundle (once), ready for where it's used. */
  private add(file: string): void {
    if (this.files.has(file)) return;
    const content = this.found.get(file)!;
    const type = typeOf(file);
    const extension = path.extname(file).toLowerCase();
    if (!TEXT.has(extension)) {
      this.files.set(file, { t: type, b: content.toString('base64') });
      return;
    }
    let text = withoutNul(content.toString('utf8'));
    if (extension === '.js') text = text.replace(/<\/(script)/gi, '<\\/$1');
    if (extension === '.css') {
      text = this.inlineCssUrls(text, `${SITE}/${file}`).replace(
        /<\/(style)/gi,
        '<\\/$1',
      );
    }
    this.files.set(file, { t: type, s: text });
  }

  /** Marks url(...)s of images and fonts in the report, so the viewer puts them in. */
  private inlineCssUrls(css: string, base: string): string {
    return css.replace(
      /url\(\s*(['"]?)([^'")]*)\1\s*\)/gi,
      (match, _quote, ref: string) => {
        const file = this.resolve(ref, base);
        if (!file || !INLINE_URL.test(typeOf(file))) return match;
        this.add(file);
        return `url("${urlMarker(file)}")`;
      },
    );
  }

  /** A page (or the landing page) as its frame shows it, at `address` on the made-up site. */
  document(html: string, address: string, frameScript: string): string {
    const base = `${SITE}/${address}`;
    let doc = withoutNul(html);
    // Stylesheets and scripts from the report: their text, in place.
    doc = doc.replace(/<link\b[^>]*>/gi, (tag) => {
      if (!/\brel\s*=\s*["']?[^"'>]*\bstylesheet\b/i.test(tag)) return tag;
      const file = this.resolve(attribute(tag, 'href') ?? '', base);
      if (!file || path.extname(file).toLowerCase() !== '.css') return tag;
      this.add(file);
      return `<style>${textMarker(file)}</style>`;
    });
    doc = doc.replace(
      /<script\b([^>]*)>\s*<\/script\s*>/gi,
      (tag, attributes: string) => {
        const file = this.resolve(attribute(tag, 'src') ?? '', base);
        if (!file || path.extname(file).toLowerCase() !== '.js') return tag;
        this.add(file);
        const rest = attributes.replace(ATTRIBUTE('src'), '');
        return `<script${rest}>${textMarker(file)}</script>`;
      },
    );
    // Images and fonts: data: URLs.
    doc = doc.replace(
      /\b(src|href|poster)(\s*=\s*)(["'])([^"']*)\3/gi,
      (match, name: string, equals: string, quote: string, ref: string) => {
        const file = this.resolve(ref, base);
        if (!file || !INLINE_URL.test(typeOf(file))) return match;
        this.add(file);
        return `${name}${equals}${quote}${urlMarker(file)}${quote}`;
      },
    );
    doc = this.inlineCssUrls(doc, base);
    // First in the page: the <base> its URLs resolve against, then frame.js.
    const head = `<base href="${base}"><script>${withoutNul(frameScript).replace(/<\/(script)/gi, '<\\/$1')}</script>`;
    for (const opening of [
      /<head\b[^>]*>/i,
      /<html\b[^>]*>/i,
      /<!doctype[^>]*>/i,
    ]) {
      const match = opening.exec(doc);
      if (match) {
        const at = match.index + match[0].length;
        return doc.slice(0, at) + head + doc.slice(at);
      }
    }
    return head + doc;
  }

  /** Adds the files pages fetch rather than refer to: report.json and the datasets. */
  addData(report: ReportFile): void {
    this.files.set('report.json', {
      t: SITE_TYPES['.json'],
      s: JSON.stringify(report),
    });
    for (const file of this.found.keys()) {
      if (/^data\/[^/]+\.json$/.test(file)) this.add(file);
    }
  }

  bundle(): Record<string, BundleFile> {
    return Object.fromEntries(this.files);
  }
}

const ATTRIBUTE = (name: string) =>
  new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i');

function attribute(tag: string, name: string): string | null {
  const match = ATTRIBUTE(name).exec(tag);
  return match ? (match[1] ?? match[2] ?? match[3]) : null;
}

/**
 * The report in `filesDir` as one HTML file. Uses the datasets' data as it is now; refresh
 * them first.
 */
export async function buildSingleFile(
  filesDir: string,
  scripts: SingleFileScripts,
): Promise<string> {
  const root = path.join(filesDir, 'report');
  const report = await readReport(filesDir);
  const found = await siteFiles(root);
  const builder = new SingleFileBuilder(found);
  const docs: Record<string, string> = {};
  const index = found.get('index.html');
  docs.index = builder.document(
    index
      ? index.toString('utf8')
      : `<!doctype html><title>${escapeHtml(report.title)}</title>`,
    'index.html',
    scripts.frame,
  );
  // Pages whose files are missing are left out, as Publish to a folder leaves them out.
  const pages = report.pages.filter((p) => found.has(`pages/${p.id}.html`));
  for (const page of pages) {
    const html = withoutOldMenu(
      found.get(`pages/${page.id}.html`)!.toString('utf8'),
    );
    docs[page.id] = builder.document(
      html,
      `pages/${page.id}.html`,
      scripts.frame,
    );
  }
  const shown: ReportFile = { title: report.title, pages };
  builder.addData(shown);

  const packed = gzipSync(
    JSON.stringify({
      title: report.title,
      pages,
      docs,
      files: builder.bundle(),
    }),
    { level: constants.Z_BEST_COMPRESSION },
  ).toString('base64');
  const menu = menuHtml(shown, '', {
    home: '#',
    page: (id) => `#${id}`,
  }).replace(
    '<header class="pp-menu">',
    '<header class="pp-menu" id="pp-menu" hidden>',
  );
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<meta name="generator" content="PawpawBI">
<title>${escapeHtml(report.title)}</title>
<style>
${MENU_CSS}
${SHELL_CSS}
</style>
</head>
<body>
${menu}
<p id="pp-status" class="pp-status">Opening the report… If it doesn’t appear, save this file to your computer and open it in a web browser, such as Edge, Chrome, Firefox or Safari.</p>
<script type="application/octet-stream" id="pp-bundle">${packed}</script>
<script>${withoutNul(scripts.viewer).replace(/<\/(script)/gi, '<\\/$1')}</script>
</body>
</html>
`;
}
