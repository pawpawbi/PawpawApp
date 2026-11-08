// Checking the data source settings the model gives (source-tools.ts). No Electron imports, so
// this is tested with plain Node (tests/node/assistant-source-input.test.ts).
import type { ConnectorField } from '../shared/types';

/** One setting's value, checked against its field's type. */
function settingValue(field: ConnectorField, value: unknown): unknown {
  const wrong = (kind: string) =>
    new Error(`"${field.key}" (${field.label}) must be ${kind}.`);
  switch (field.type) {
    case 'number': {
      const number = typeof value === 'string' ? Number(value) : value;
      if (typeof number !== 'number' || !Number.isFinite(number))
        throw wrong('a number');
      return number;
    }
    case 'checkbox':
      if (typeof value !== 'boolean') throw wrong('true or false');
      return value;
    case 'files':
      if (
        !Array.isArray(value) ||
        !value.every((v) => typeof v === 'string' && v.trim())
      ) {
        throw wrong('a list of file paths');
      }
      return value.map((v: string) => v.trim());
    case 'select':
      if (!field.options.some((o) => o.value === value)) {
        throw wrong(
          `one of ${field.options.map((o) => JSON.stringify(o.value)).join(', ')}`,
        );
      }
      return value;
    default:
      if (typeof value !== 'string') throw wrong('text');
      return value.trim();
  }
}

/**
 * Settings the model gave for a connector, checked: known fields only, values of the field's
 * type, and never a secret field (passwords and keys are typed into the source's form). A value
 * of null or "" clears that setting.
 */
export function checkSettings(
  fields: ConnectorField[],
  value: unknown,
): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('"settings" must be an object of setting keys and values.');
  }
  const settings: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    const field = fields.find((f) => f.key === key);
    if (!field) {
      throw new Error(
        `There's no setting called "${key}". list_connectors shows each connector's settings.`,
      );
    }
    if (field.secret) {
      throw new Error(
        `"${field.label}" is secret: the user types it into the source's form in the app, never in the chat. Leave it out.`,
      );
    }
    settings[key] = v === null || v === '' ? '' : settingValue(field, v);
  }
  return settings;
}

/** Required settings without a value: non-secret ones in `options`, secret ones not saved. */
export function missingSettings(
  fields: ConnectorField[],
  options: Record<string, unknown>,
  savedSecrets: string[],
): ConnectorField[] {
  return fields.filter((f) =>
    !f.required
      ? false
      : f.secret
        ? !savedSecrets.includes(f.key)
        : options[f.key] === undefined ||
          options[f.key] === '' ||
          (Array.isArray(options[f.key]) &&
            !(options[f.key] as unknown[]).length),
  );
}

/** Settings as people read them, e.g. `host db.example.com, port 5432`. */
export function describeSettings(
  fields: ConnectorField[],
  settings: Record<string, unknown>,
): string {
  return Object.entries(settings)
    .map(([key, value]) => {
      const label = (
        fields.find((f) => f.key === key)?.label ?? key
      ).toLowerCase();
      if (value === '') return `no ${label}`;
      const text = Array.isArray(value) ? value.join(', ') : String(value);
      // Long values (often paths) keep their end, where the file name is.
      return `${label} ${text.length > 120 ? `${text.slice(0, 40)}…${text.slice(-79)}` : text}`;
    })
    .join(', ');
}

/** The settings in `next` that differ from `saved`. */
export function changedSettings(
  saved: Record<string, unknown>,
  next: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(next).filter(
      ([key, value]) =>
        JSON.stringify(value ?? '') !== JSON.stringify(saved[key] ?? ''),
    ),
  );
}
