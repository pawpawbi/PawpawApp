// The files a new report site starts with (src/report-template/), and the scripts of the report
// as a single file (src/report-single-file/), bundled into the app.
import type { SingleFileScripts } from './report-single-file';
import frame from './report-single-file/frame.js?raw';
import viewer from './report-single-file/viewer.js?raw';
import type { SiteTemplates } from './report-site';
import charts from './report-template/assets/charts.js?raw';
import css from './report-template/assets/report.css?raw';
import index from './report-template/index.html?raw';
import page from './report-template/page.html?raw';

export const SITE_TEMPLATES: SiteTemplates = { index, page, css, charts };

export const SINGLE_FILE_SCRIPTS: SingleFileScripts = { viewer, frame };
