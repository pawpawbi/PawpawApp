// The assistant's tools for data sources: adding, editing and removing them, finding their
// tables, and loading data. Passwords and keys are never handled here: the user types them into the
// source's form. Adding a source or changing its settings is always asked about (`alwaysAsk`),
// even when the user allows changes without asking, because a source's settings say where the
// app connects and what it reads: a shared project's content mustn't be able to point a saved
// password, or a request carrying the user's data, somewhere else. Loads can't be undone.
import {
  connector,
  dependentsOf,
  discover,
  loadStoppable,
  readSource,
  removeSource,
  saveSource,
  stopLoad,
  toDataSource,
} from '../data';
import { newId } from '../shared/ids';
import { text } from './input';
import {
  changedSettings,
  checkSettings,
  describeSettings,
  missingSettings,
} from './source-input';
import type { ToolContext, ToolSpec } from './types';

const sourceFile = (id: string) => ({ file: `sources/${id}.json` });

async function sourceOf(input: Record<string, unknown>) {
  const id = text(input, 'source_id').trim();
  try {
    return await readSource(id);
  } catch {
    throw new Error(
      `There's no data source with the ID ${id}. list_sources lists them.`,
    );
  }
}

/** What the user still has to enter in the source's form before it can connect. */
const formNote = (name: string, missing: string[]) =>
  `Ask the user to open Add data, choose Edit on "${name}" and enter: ${missing.join(', ')}. It can't connect until they have. Never ask for these in the chat.`;

/** The connector, the settings checked against it, and a name, for add_source. */
async function newSource(input: Record<string, unknown>) {
  const info = await connector(text(input, 'connector').trim()).catch(() => {
    throw new Error(
      `There's no connector called ${String(input.connector)}. list_connectors lists them.`,
    );
  });
  const settings = checkSettings(info.fields, input.settings);
  const name =
    typeof input.name === 'string' && input.name.trim()
      ? input.name.trim()
      : info.name;
  return { info, settings, name };
}

/** A source's settings after edit_source: what changes, and everything as it will be saved. */
async function editedSource(input: Record<string, unknown>) {
  const source = await sourceOf(input);
  const info = await connector(source.type);
  const changes = changedSettings(
    source.options,
    checkSettings(info.fields, input.settings),
  );
  const name =
    typeof input.name === 'string' && input.name.trim()
      ? input.name.trim()
      : source.name;
  return { source, info, changes, name };
}

export function sourceTools(ctx: ToolContext): ToolSpec[] {
  return [
    {
      name: 'add_source',
      description:
        "Adds a data source: a connector and its settings. Use list_connectors (with a search) to find the connector and its setting keys first. Never include secret settings (passwords, keys, tokens): the user types those into the source's form. The user is always asked first. Then use discover_tables and load_source.",
      parameters: {
        type: 'object',
        properties: {
          connector: {
            type: 'string',
            description: "The connector's id from list_connectors.",
          },
          name: {
            type: 'string',
            description: 'A name for the source, e.g. "Sales database".',
          },
          settings: {
            type: 'object',
            description:
              'Setting key -> value for its non-secret settings, e.g. {"host": "db.example.com"}.',
          },
        },
        required: ['connector'],
        additionalProperties: false,
      },
      change: true,
      alwaysAsk: () => true,
      describe: async (input) => {
        const { info, settings, name } = await newSource(input);
        const details = describeSettings(info.fields, settings);
        return `Add the data source "${name}" (${info.name})${details ? `: ${details}` : ''}`;
      },
      run: async (input, call) => {
        const { info, settings, name } = await newSource(input);
        const missing = missingSettings(info.fields, settings, []);
        const unsetPlain = missing.filter((f) => !f.secret);
        if (unsetPlain.length) {
          throw new Error(
            `These settings are required: ${unsetPlain.map((f) => `"${f.key}" (${f.label})`).join(', ')}.`,
          );
        }
        const id = newId();
        const saved = await ctx.change(
          call,
          `Added the data source ${name}`,
          [sourceFile(id)],
          () => saveSource({ type: info.id, name, settings }, id),
          ['sources'],
        );
        ctx.show('data');
        return {
          source_id: saved.id,
          name: saved.name,
          ...(missing.length
            ? {
                note: formNote(
                  saved.name,
                  missing.map((f) => f.label),
                ),
              }
            : {}),
        };
      },
    },
    {
      name: 'edit_source',
      description:
        'Renames a data source or changes its non-secret settings (only the ones given change; null clears one). Changing settings is always asked about. Its saved passwords stay as they are; never include secret settings. Load it again afterwards for the change to reach its tables.',
      parameters: {
        type: 'object',
        properties: {
          source_id: { type: 'string', description: 'From list_sources.' },
          name: { type: 'string', description: 'A new name.' },
          settings: {
            type: 'object',
            description: 'Setting key -> new value.',
          },
        },
        required: ['source_id'],
        additionalProperties: false,
      },
      change: true,
      // Renaming is harmless; changing where it connects or what it reads isn't.
      alwaysAsk: async (input) =>
        Object.keys((await editedSource(input)).changes).length > 0,
      describe: async (input) => {
        const { source, info, changes, name } = await editedSource(input);
        const parts = [
          ...(name !== source.name ? [`rename it to "${name}"`] : []),
          ...(Object.keys(changes).length
            ? [`set ${describeSettings(info.fields, changes)}`]
            : []),
        ];
        const secrets = (await toDataSource(source)).savedSecrets.length;
        return `Change the data source "${source.name}": ${parts.join('; ') || 'nothing'}${
          secrets && Object.keys(changes).length
            ? '. Its saved password or key will be used with the new settings'
            : ''
        }`;
      },
      run: async (input, call) => {
        const { source, changes, name } = await editedSource(input);
        if (name === source.name && !Object.keys(changes).length) {
          return 'Nothing to change: those are its settings already.';
        }
        await ctx.change(
          call,
          `Changed the data source ${name}`,
          [sourceFile(source.id)],
          () =>
            saveSource({
              id: source.id,
              type: source.type,
              name,
              settings: { ...source.options, ...changes },
            }),
          ['sources'],
        );
        ctx.show('data');
        return Object.keys(changes).length
          ? 'Changed. Load it again (load_source) for its tables to reflect the new settings.'
          : 'Renamed.';
      },
    },
    {
      name: 'discover_tables',
      description:
        'Connects to a data source and lists the tables (resources) it can load, and which are chosen. The first use of some connectors downloads their software, which takes a minute.',
      parameters: {
        type: 'object',
        properties: {
          source_id: { type: 'string', description: 'From list_sources.' },
        },
        required: ['source_id'],
        additionalProperties: false,
      },
      describe: async (input) =>
        `Connecting to ${(await sourceOf(input).catch(() => null))?.name ?? 'a data source'}`,
      run: async (input) => {
        const source = await sourceOf(input);
        const info = await connector(source.type);
        const { savedSecrets } = await toDataSource(source);
        const missing = missingSettings(
          info.fields,
          source.options,
          savedSecrets,
        );
        if (missing.length) {
          throw new Error(
            formNote(
              source.name,
              missing.map((f) => f.label),
            ),
          );
        }
        return (await discover(source.id)).map((r) => ({
          name: r.name,
          chosen: source.resources.length
            ? source.resources.includes(r.name)
            : r.selected,
        }));
      },
    },
    {
      name: 'remove_source',
      description:
        "Removes a data source with its loaded tables and their in-place transforms. Refused while other tables read its tables. Undo brings the source and its data back, but not its saved password or key, which the user would enter again in the source's form.",
      parameters: {
        type: 'object',
        properties: {
          source_id: { type: 'string', description: 'From list_sources.' },
        },
        required: ['source_id'],
        additionalProperties: false,
      },
      change: true,
      // Checked here so the user isn't asked about a removal that would be refused.
      describe: async (input) => {
        const source = await sourceOf(input);
        const users = await dependentsOf(source.tables);
        if (users.length) {
          throw new Error(
            `${users.join(', ')} ${users.length === 1 ? 'reads' : 'read'} tables from "${source.name}". Change or delete ${users.length === 1 ? 'it' : 'them'} first.`,
          );
        }
        return `Remove the data source "${source.name}"${
          source.tables.length
            ? ` and its ${source.tables.length === 1 ? 'table' : 'tables'} ${source.tables.join(', ')}`
            : ''
        }`;
      },
      run: async (input, call) => {
        const source = await sourceOf(input);
        const { savedSecrets } = await toDataSource(source);
        // A loaded table's data can't be rebuilt from SQL, so Undo keeps a copy of it.
        await ctx.change(
          call,
          `Removed the data source ${source.name}`,
          [
            sourceFile(source.id),
            { file: 'model/transforms.json' },
            ...source.tables.map((t) => ({ dir: `data/raw/${t}` })),
          ],
          () => removeSource(source.id),
          ['sources', 'model', 'report'],
        );
        ctx.show('data');
        return savedSecrets.length
          ? "Removed. Its saved password or key was deleted too: if this is undone, the user enters it again in the source's form."
          : 'Removed.';
      },
    },
    {
      name: 'load_source',
      description:
        "Loads data from a source: the tables given (from discover_tables) or, without them, the ones chosen last time. It replaces those tables' data, re-applies transforms and rebuilds the tables and report data built from them. Loading can't be undone, and can take a while for big sources.",
      parameters: {
        type: 'object',
        properties: {
          source_id: { type: 'string', description: 'From list_sources.' },
          tables: {
            type: 'array',
            items: { type: 'string' },
            description: 'The resources to load, by name.',
          },
        },
        required: ['source_id'],
        additionalProperties: false,
      },
      change: true,
      permanent: true,
      describe: async (input) => {
        const source = await sourceOf(input);
        const tables = Array.isArray(input.tables)
          ? input.tables.map(String)
          : source.resources;
        return `Load data from "${source.name}"${tables.length ? ` (${tables.join(', ')})` : ''}`;
      },
      run: async (input, _call, signal) => {
        const source = await sourceOf(input);
        const tables = Array.isArray(input.tables)
          ? input.tables.filter((t): t is string => typeof t === 'string')
          : source.resources;
        if (!tables.length) {
          throw new Error(
            'Say which tables to load: discover_tables lists them.',
          );
        }
        // Stop in the chat stops the load too, until its data has arrived.
        const stop = () => stopLoad(source.id);
        signal?.addEventListener('abort', stop);
        try {
          return (await loadStoppable(source.id, tables)).map((t) => ({
            table: t.name,
            rows: t.rows,
            ...(t.transformError ? { transform_error: t.transformError } : {}),
          }));
        } finally {
          signal?.removeEventListener('abort', stop);
          // Even a failed load may have changed some tables.
          await ctx.changed(['sources', 'model', 'report']);
          ctx.show('data');
        }
      },
    },
  ];
}
