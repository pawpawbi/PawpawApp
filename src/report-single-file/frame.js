// PawpawBI single-file report: the script that runs first in each page (see viewer.js and
// src/report-single-file.ts). The page is shown in a sandboxed frame with a <base> on a made-up
// site, https://report.invalid/, laid out like the published site, so the page's own relative
// URLs and the chart library's requests resolve exactly as they would when hosted. Requests
// for that site's files (data/<name>.json, report.json, ...) are answered by the viewer from
// the file; nothing is fetched from anywhere, and the file's Content Security Policy blocks
// anything else. Links between pages tell the viewer to show the other page.
(function () {
  'use strict';

  const SITE = 'https://report.invalid';
  const waiting = new Map();
  let nextId = 0;

  addEventListener('message', (event) => {
    const message = event.data;
    if (event.source !== parent || !message || message.pp !== 'file') return;
    const resolve = waiting.get(message.id);
    if (!resolve) return;
    waiting.delete(message.id);
    resolve(message.file);
  });

  /** One of the report's files from the viewer: { t: type, s: text } or { t, b: base64 }, or null. */
  function siteFile(path) {
    return new Promise((resolve) => {
      const id = ++nextId;
      waiting.set(id, resolve);
      parent.postMessage({ pp: 'get', id, path }, '*');
    });
  }

  function fromBase64(base64) {
    const text = atob(base64);
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
    return bytes;
  }

  const browserFetch = window.fetch.bind(window);
  window.fetch = async function (input, init) {
    const url = new URL(
      input instanceof Request ? input.url : String(input),
      document.baseURI,
    );
    if (url.origin !== SITE) return browserFetch(input, init);
    const file = await siteFile(
      decodeURIComponent(url.pathname).replace(/^\/+/, ''),
    );
    if (!file) {
      return new Response('Not found', {
        status: 404,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }
    return new Response(
      typeof file.s === 'string' ? file.s : fromBase64(file.b),
      {
        headers: { 'Content-Type': file.t },
      },
    );
  };

  const go = (page) => parent.postMessage({ pp: 'go', page }, '*');

  document.addEventListener('click', (event) => {
    if (event.defaultPrevented) return;
    const link =
      event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!link) return;
    const url = new URL(link.href);
    if (url.origin === SITE) {
      event.preventDefault();
      const here = new URL(document.baseURI);
      if (url.pathname === here.pathname) {
        const target = url.hash
          ? document.getElementById(decodeURIComponent(url.hash.slice(1)))
          : null;
        if (target) target.scrollIntoView();
        else if (!url.hash) scrollTo(0, 0);
        return;
      }
      const page = /^\/pages\/([0-9a-f-]{36})\.html$/.exec(url.pathname);
      if (page) go(page[1]);
      else if (url.pathname === '/' || url.pathname === '/index.html') go('');
      return;
    }
    // Links to other websites open in a new tab, not inside the report.
    if (/^(https?|mailto):$/.test(url.protocol)) {
      event.preventDefault();
      window.open(url.href, '_blank', 'noopener');
    }
  });
})();
