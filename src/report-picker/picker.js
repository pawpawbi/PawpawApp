// PawpawBI, in the app only: lets the user point at part of a report page to tell the assistant
// about it. The app adds this script to a page when it shows it in Build visuals (src/report.ts);
// it's never part of the project or the published site. The app turns selecting on and off with
// a message; while it's on, the element under the pointer is outlined, and a click sends the app
// a short description of it instead of reaching the page.
(function () {
  'use strict';

  const MAX_PATH = 400;
  let on = false;
  let box = null;
  let cursor = null;

  /** One element in the path: its tag, with its ID, or its classes and position. */
  function step(el) {
    const name = el.localName;
    if (el.id) return `${name}#${el.id}`;
    const classes = (el.getAttribute('class') || '')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 3)
      .map((c) => `.${c}`)
      .join('');
    const same = el.parentElement
      ? Array.from(el.parentElement.children).filter(
          (c) => c.localName === name,
        )
      : [];
    const nth = same.length > 1 ? `:nth-of-type(${same.indexOf(el) + 1})` : '';
    return name + classes + nth;
  }

  function describe(el) {
    const steps = [];
    for (
      let node = el;
      node && node !== document.body && node !== document.documentElement;
      node = node.parentElement
    ) {
      steps.unshift(step(node));
    }
    if (!steps.length) steps.push(el.localName);
    // A long path keeps its end, nearest the element.
    while (steps.length > 1 && steps.join(' > ').length > MAX_PATH) {
      steps.shift();
    }
    const text =
      typeof el.innerText === 'string' ? el.innerText : el.textContent;
    return {
      path: steps.join(' > ').slice(-MAX_PATH),
      html: el
        .cloneNode(false)
        .outerHTML.replace(/<\/[^>]+>$/, '')
        .slice(0, 300),
      text: String(text || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 200),
    };
  }

  function outline(el) {
    if (!box) return;
    if (!el) {
      box.style.display = 'none';
      return;
    }
    const rect = el.getBoundingClientRect();
    box.style.display = 'block';
    box.style.left = `${rect.left}px`;
    box.style.top = `${rect.top}px`;
    box.style.width = `${rect.width}px`;
    box.style.height = `${rect.height}px`;
  }

  const target = (event) =>
    event.target instanceof Element && event.target !== box
      ? event.target
      : null;

  function swallow(event) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  const onMove = (event) => outline(target(event));
  const onLeave = () => outline(null);

  function onClick(event) {
    swallow(event);
    const el = target(event);
    stop();
    if (el) parent.postMessage({ pp: 'picked', element: describe(el) }, '*');
    else parent.postMessage({ pp: 'pick-cancelled' }, '*');
  }

  function onKey(event) {
    if (event.key !== 'Escape') return;
    swallow(event);
    stop();
    parent.postMessage({ pp: 'pick-cancelled' }, '*');
  }

  // Before the page's own handlers, so its links and charts don't react to the click.
  const LISTENERS = [
    ['mousemove', onMove],
    ['scroll', onLeave],
    ['click', onClick],
    ['auxclick', swallow],
    ['dblclick', swallow],
    ['contextmenu', swallow],
    ['pointerdown', swallow],
    ['pointerup', swallow],
    ['mousedown', swallow],
    ['mouseup', swallow],
    ['keydown', onKey],
  ];

  function start() {
    if (on) return;
    on = true;
    box = document.createElement('div');
    box.style.cssText =
      'position:fixed;z-index:2147483647;display:none;box-sizing:border-box;' +
      'margin:0;padding:0;border:2px solid #e8622a;border-radius:0;' +
      'background:rgba(232,98,42,0.12);pointer-events:none;';
    cursor = document.createElement('style');
    cursor.textContent = '* { cursor: crosshair !important; }';
    document.documentElement.append(box, cursor);
    for (const [type, listener] of LISTENERS) {
      window.addEventListener(type, listener, true);
    }
    document.documentElement.addEventListener('mouseleave', onLeave);
  }

  function stop() {
    if (!on) return;
    on = false;
    for (const [type, listener] of LISTENERS) {
      window.removeEventListener(type, listener, true);
    }
    document.documentElement.removeEventListener('mouseleave', onLeave);
    box.remove();
    cursor.remove();
    box = cursor = null;
  }

  addEventListener('message', (event) => {
    const message = event.data;
    if (event.source !== parent || !message || message.pp !== 'pick') return;
    if (message.on) start();
    else stop();
  });
})();
