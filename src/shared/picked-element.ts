// Part of a report page the user selected in Build visuals to tell the assistant about. The
// description comes from the page's frame (src/report-picker/picker.js), and later from the
// saved chat, so it's untrusted: it's checked and cut to size here before it's used.
// No browser or Node APIs, so both the app and the main process use it.
import { GUID } from './ids';
import type { PickedElement } from './types';

const MAX = { path: 400, html: 300, text: 200 };

// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f\x7f]+/g;

const clean = (value: unknown, max: number) =>
  typeof value === 'string'
    ? value.replace(CONTROL, ' ').trim().slice(0, max)
    : '';

/**
 * A selection as described by the page's frame or a saved message, or null if it isn't one.
 * The page is the one given (the frame doesn't say which page it is), else the value's own.
 */
export function parsePickedElement(
  value: unknown,
  pageId?: unknown,
): PickedElement | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const page = pageId ?? v.pageId;
  const path = clean(v.path, MAX.path);
  if (typeof page !== 'string' || !GUID.test(page) || !path) return null;
  return {
    pageId: page,
    path,
    html: clean(v.html, MAX.html),
    text: clean(v.text, MAX.text),
  };
}

/** A few words for the chat: the start of the element's text, or what it is. */
export function pickedLabel(element: PickedElement): string {
  if (!element.text) return 'part of the page';
  return element.text.length > 40
    ? `“${element.text.slice(0, 40).trimEnd()}…”`
    : `“${element.text}”`;
}

/**
 * A page as the app shows it, with the script that lets the user select part of it: first in
 * the page, so it runs before the page's own scripts.
 */
export function withPicker(html: string, script: string): string {
  const tag = `<script>${script}</script>`;
  const after =
    /<head\b[^>]*>/i.exec(html) ??
    /<html\b[^>]*>/i.exec(html) ??
    /<!doctype\b[^>]*>/i.exec(html);
  if (!after) return tag + html;
  const at = after.index + after[0].length;
  return html.slice(0, at) + tag + html.slice(at);
}
