// How the app describes where a published report lives on PawpawBI and who can open it, the same
// words as the web console uses.
import { errorMessage } from './errors';
import type { PublishedOrg, ReportVisibility } from './shared/types';

/** "Your personal workspace", or the organisation's name. */
export const orgLabel = (org: PublishedOrg) =>
  org.personal ? 'Your personal workspace' : org.name;

/** Who can open a report with this visibility, in `org` (null: not known). */
export function visibilityLabel(
  visibility: ReportVisibility,
  org: PublishedOrg | null,
): string {
  if (visibility === 'link') return 'Anyone with the link';
  if (org?.personal) return 'Only you';
  return visibility === 'org'
    ? org
      ? `Members of ${org.name}`
      : 'Members of its organisation'
    : 'Admins, owners and whoever published it';
}

/** What people opening the link of a report that isn't open to anyone with it need to do. */
export const PRIVATE_LINK_NOTE =
  'People opening the link sign in with their PawpawBI account to see it. Opened from here, it’s signed in as you.';

/**
 * Opens a published report in the browser, signed in as this app's account if it is. Resolves
 * to what went wrong when it can't be opened (a report this account can't reach), else null.
 */
export async function openReport(report: {
  reportId: string;
  url: string;
}): Promise<string | null> {
  try {
    await window.api.account.openReport(report.reportId, report.url);
    return null;
  } catch (error) {
    return errorMessage(error);
  }
}
