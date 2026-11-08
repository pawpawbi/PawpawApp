// The records of published reports: published.json in a project (enough to rebuild the list),
// and published-reports.json in userData (the list on this computer, for refreshing them).
// Projects may be someone else's, so both are cleaned on reading. File format:
// docs/pawpaw-file-format.md. No Electron imports, so this is tested with plain Node.
import { isReportUrl, REPORT_ID, REPORT_VISIBILITIES } from './pawpaw-server';
import { SAFE_ID } from './shared/ids';
import type {
  PublishedOrg,
  PublishedProject,
  PublishedReport,
  ReportVisibility,
} from './shared/types';

const time = (value: unknown) =>
  typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : null;

function cleanOrg(value: unknown): PublishedOrg | null {
  const o = value as Partial<PublishedOrg> | null;
  if (!REPORT_ID.test(String(o?.id ?? '')) || typeof o?.name !== 'string') {
    return null;
  }
  return {
    id: String(o.id),
    name: o.name.slice(0, 100),
    personal: o.personal === true,
  };
}

/** A project's published.json, or null if it's missing or not valid. */
export function cleanPublished(value: unknown): PublishedReport | null {
  const p = (value as { pawpawbi?: Partial<PublishedReport> } | null)?.pawpawbi;
  if (!REPORT_ID.test(String(p?.reportId ?? '')) || !isReportUrl(p?.url)) {
    return null;
  }
  return {
    reportId: String(p!.reportId),
    url: p!.url!,
    account: typeof p!.account === 'string' ? p!.account : '',
    org: cleanOrg(p!.org),
    visibility: REPORT_VISIBILITIES.includes(p!.visibility as ReportVisibility)
      ? (p!.visibility as ReportVisibility)
      : null,
    publishedAt: time(p!.publishedAt),
    refreshedAt: time(p!.refreshedAt),
  };
}

/** published.json's contents for a report. */
export const publishedFile = (report: PublishedReport) => ({
  pawpawbi: report,
});

/** published-reports.json, keeping only valid entries. */
export function cleanList(value: unknown): PublishedProject[] {
  const entries = (value as { projects?: unknown } | null)?.projects;
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((e): PublishedProject[] => {
    const report = cleanPublished({ pawpawbi: e });
    if (
      !report ||
      !SAFE_ID.test(String(e?.projectId ?? '')) ||
      typeof e?.projectPath !== 'string' ||
      !e.projectPath
    ) {
      return [];
    }
    return [
      {
        ...report,
        projectId: e.projectId,
        projectName: String(e.projectName ?? ''),
        projectPath: e.projectPath,
        ...(typeof e.lastError === 'string' && e.lastError
          ? { lastError: e.lastError }
          : {}),
      },
    ];
  });
}

/**
 * The list with `entry` added, replacing the entry for the same report (a moved or renamed
 * project file) and any for the same project file (which has one report: a new one replaces it),
 * sorted by project name.
 */
export function withEntry(
  list: PublishedProject[],
  entry: PublishedProject,
): PublishedProject[] {
  return [
    ...list.filter(
      (e) =>
        e.reportId !== entry.reportId && e.projectPath !== entry.projectPath,
    ),
    entry,
  ].sort((a, b) => a.projectName.localeCompare(b.projectName));
}
