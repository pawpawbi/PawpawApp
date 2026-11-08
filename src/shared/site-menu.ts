// The report's menu: its title and a link to every page. Pages don't contain it. The app draws
// it above the page (ReportMenu.vue) and Publish writes it into every page, from this one
// markup and stylesheet, so the published site looks exactly like the app. Its styles are fixed
// here rather than in the project's report.css for the same reason.
// No browser or Node APIs, so both the app and the main process use it.
import type { ReportFile } from './types';

export const MENU_CSS = `.pp-menu {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 24px;
  min-height: 56px;
  padding: 10px 28px;
  border-bottom: 1px solid #e4e2dc;
  background: #ffffff;
  color: #16161a;
  font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
  font-size: 15px;
  line-height: 1.5;
}
.pp-menu-title {
  color: inherit;
  font-size: 16px;
  font-weight: 900;
  letter-spacing: -0.01em;
  text-decoration: none;
}
.pp-menu-list {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.pp-menu-link {
  display: block;
  padding: 6px 12px;
  border-radius: 8px;
  color: #52514e;
  font-weight: 600;
  text-decoration: none;
}
.pp-menu-link:hover {
  background: #f6f5f2;
  color: #16161a;
}
.pp-menu-link[aria-current='page'] {
  background: #fdeee6;
  color: #16161a;
  box-shadow: inset 0 0 0 1px #e8622a;
}`;

const escape = (text: string) =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** Where the menu's links go: by default, between the files of the published site. */
export interface MenuLinks {
  home: string;
  page: (id: string) => string;
}

const SITE_LINKS: MenuLinks = {
  home: '../index.html',
  page: (id) => `${id}.html`,
};

/** The menu for a page of the published site (pages/<id>.html), with that page marked. */
export function menuHtml(
  report: ReportFile,
  currentId: string,
  links: MenuLinks = SITE_LINKS,
): string {
  const items = report.pages
    .map(
      (p) =>
        `<li><a class="pp-menu-link" href="${escape(links.page(p.id))}"${p.id === currentId ? ' aria-current="page"' : ''}>${escape(p.title)}</a></li>`,
    )
    .join('');
  return `<header class="pp-menu"><a class="pp-menu-title" href="${escape(links.home)}">${escape(report.title)}</a><ul class="pp-menu-list">${items}</ul></header>`;
}

/**
 * A page as the app shows it: without the menu pages used to draw for themselves (an empty
 * <header id="nav"> and a pawpaw.nav('#nav') call), since the app draws the menu now.
 */
export function withoutOldMenu(html: string): string {
  return html
    .replace(/<header\b[^>]*\bid=["']nav["'][^>]*>\s*<\/header>\s*/i, '')
    .replace(/^[ \t]*pawpaw\.nav\(\s*['"]#nav['"]\s*\);?[ \t]*\r?\n?/m, '');
}

/** A page as Publish writes it: the menu's styles in its head and the menu at the top. */
export function withMenu(
  html: string,
  report: ReportFile,
  currentId: string,
): string {
  let page = withoutOldMenu(html);
  const style = `<style>\n${MENU_CSS}\n</style>\n`;
  page = /<\/head>/i.test(page)
    ? page.replace(/<\/head>/i, (head) => style + head)
    : style + page;
  const menu = menuHtml(report, currentId);
  return /<body\b[^>]*>/i.test(page)
    ? page.replace(/<body\b[^>]*>/i, (body) => `${body}\n${menu}`)
    : menu + page;
}
