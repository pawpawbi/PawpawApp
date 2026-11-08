/** A user-facing message for an error from window.api, without Electron's IPC prefix
 * ("Error invoking remote method 'data:load': Error: …"). */
export function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(
    /^Error invoking remote method '[^']+': (?:\w*Error: )?/,
    '',
  );
}
