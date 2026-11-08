// PawpawBI single-file report: the viewer, the one page that holds the whole report (built by
// src/report-single-file.ts). The report's pages, files and data are in #pp-bundle, gzipped
// JSON in base64:
//
//   { title, pages: [{ id, title }], docs: { index: html, <page id>: html },
//     files: { "<site path>": { t: type, s: text } | { t: type, b: base64 } } }
//
// Each page is shown in a sandboxed frame (frame.js runs first in it), like the app shows it.
// Its stylesheets and scripts are in the bundle once and put in where a page marks them
// (\0t:<path>\0 for a file's text, \0u:<path>\0 for a data: URL). The address's #<page id>
// says which page is shown, so the browser's Back button works.
(function () {
  'use strict';

  const status = document.getElementById('pp-status');
  const menu = document.getElementById('pp-menu');
  let bundle = null;
  let frame = null;

  function fromBase64(base64) {
    const text = atob(base64);
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
    return bytes;
  }

  async function unpack() {
    const encoded = document
      .getElementById('pp-bundle')
      .textContent.replace(/\s+/g, '');
    const stream = new Blob([fromBase64(encoded)])
      .stream()
      .pipeThrough(new DecompressionStream('gzip'));
    return JSON.parse(await new Response(stream).text());
  }

  const fileOf = (path) =>
    Object.prototype.hasOwnProperty.call(bundle.files, path)
      ? bundle.files[path]
      : null;

  function asText(path) {
    const file = fileOf(path);
    return file && typeof file.s === 'string' ? file.s : '';
  }

  function asUrl(path) {
    const file = fileOf(path);
    if (!file) return '';
    return typeof file.s === 'string'
      ? `data:${file.t.replace(/\s+/g, '')},${encodeURIComponent(file.s)}`
      : `data:${file.t.replace(/\s+/g, '')};base64,${file.b}`;
  }

  // eslint-disable-next-line no-control-regex
  const TEXT_MARKER = /\u0000t:([^\u0000]*)\u0000/g;
  // eslint-disable-next-line no-control-regex
  const URL_MARKER = /\u0000u:([^\u0000]*)\u0000/g;

  /** A page's HTML with its files put in. Text first: stylesheets can mark images. */
  const documentFor = (id) =>
    (bundle.docs[id] || '')
      .replace(TEXT_MARKER, (_, path) => asText(path))
      .replace(URL_MARKER, (_, path) => asUrl(path));

  function show() {
    let id = decodeURIComponent(location.hash.slice(1));
    const page = bundle.pages.find((p) => p.id === id) || null;
    if (!page) id = '';
    // A new frame each time, so changing pages doesn't add a second entry to the history.
    const next = document.createElement('iframe');
    next.className = 'pp-frame';
    next.setAttribute(
      'sandbox',
      'allow-scripts allow-popups allow-popups-to-escape-sandbox',
    );
    next.title = page ? page.title : bundle.title;
    next.srcdoc = documentFor(page ? id : 'index');
    if (frame) frame.replaceWith(next);
    else document.body.append(next);
    frame = next;
    menu.hidden = !page;
    for (const link of menu.querySelectorAll('.pp-menu-link')) {
      if (link.getAttribute('href') === `#${id}`)
        link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
    document.title = page ? `${page.title} · ${bundle.title}` : bundle.title;
  }

  addEventListener('message', (event) => {
    if (!frame || event.source !== frame.contentWindow) return;
    const message = event.data;
    if (!message || typeof message !== 'object') return;
    if (message.pp === 'get' && typeof message.path === 'string') {
      event.source.postMessage(
        { pp: 'file', id: message.id, file: fileOf(message.path) },
        '*',
      );
    } else if (message.pp === 'go' && typeof message.page === 'string') {
      location.hash = message.page;
    }
  });

  unpack().then(
    (unpacked) => {
      bundle = unpacked;
      status.remove();
      addEventListener('hashchange', show);
      show();
    },
    () => {
      status.textContent =
        'This report couldn’t be opened. Open the file in an up-to-date web browser, such as Edge, Chrome, Firefox or Safari.';
    },
  );
})();
