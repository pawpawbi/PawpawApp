const relativeTime = new Intl.RelativeTimeFormat(undefined, {
  numeric: 'auto',
});

/** An ISO timestamp as "5 minutes ago", "yesterday", "3 days ago". */
export function timeAgo(iso: string): string {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (minutes < 60) return relativeTime.format(-minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (hours < 24) return relativeTime.format(-hours, 'hour');
  return relativeTime.format(-Math.round(hours / 24), 'day');
}
