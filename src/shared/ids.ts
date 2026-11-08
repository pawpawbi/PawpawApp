// IDs and names, and the rules for them. Anything read from a project file is untrusted, so a
// value is matched against its rule before it's used in a path.

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** A short random ID of lowercase letters and digits, e.g. "k3f9x2ab". */
export function newId(length = 8): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (byte) => ALPHABET[byte % ALPHABET.length]).join('');
}

/** A project or source ID (from newId), as used in folder and file names. */
export const SAFE_ID = /^[a-z0-9]{1,32}$/;

/** A table name as a folder name: loaded tables are named by dlt, so any plain name. */
export const SAFE_TABLE = /^[A-Za-z0-9_]+$/;

/** A name the user gives: transformed tables and datasets. */
export const NAME = /^[a-z][a-z0-9_]{0,62}$/;
export const NAME_RULE =
  'Use lowercase letters, digits and underscores, starting with a letter.';

/** A report page ID: a lowercase version 4 UUID. */
export const GUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The longest project name allowed. */
export const MAX_PROJECT_NAME = 100;
