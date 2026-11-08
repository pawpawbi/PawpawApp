// Checking a tool's input, which comes from the model. No Electron imports.

/** The most rows a tool returns to the model at once. */
export const MAX_ROWS = 50;

/** A required text field. */
export function text(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`"${key}" is required.`);
  }
  return value;
}

/** A text field that may be left out (then ''). */
export function optionalText(
  input: Record<string, unknown>,
  key: string,
): string {
  const value = input[key];
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new Error(`"${key}" must be text.`);
  return value;
}

/** The `limit` field as a row count between 1 and MAX_ROWS, or `fallback`. */
export function rowLimit(
  input: Record<string, unknown>,
  fallback: number,
): number {
  const value = Number(input.limit ?? fallback);
  return Number.isFinite(value)
    ? Math.max(1, Math.min(MAX_ROWS, Math.floor(value)))
    : fallback;
}
