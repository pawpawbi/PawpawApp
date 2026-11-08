// The assistant's tools for changing tables: in-place transforms, transformed tables, and
// deleting tables. Every change runs through `ctx.change` (reply.ts), so it can be undone; the
// change's targets are the SQL files (and, to delete a loaded table, its original data), and
// undo rebuilds the data from them (undo.ts).
import path from 'node:path';
import {
  applyTransform,
  deleteTable,
  deletion,
  listTransformed,
  readTransforms,
  removeTransform,
  removeUnaccountedData,
  saveTransformed,
  sourceTables,
} from '../data';
import { openProject } from '../projects';
import { callPython } from '../python';
import type { TableSchema } from '../shared/types';
import type { Target } from './changes';
import { text } from './input';
import type { ToolCall, ToolContext, ToolSpec } from './types';

/** The files that define what's built from the data. */
const SQL_FILES: Target[] = [
  { file: 'model/transforms.json' },
  { file: 'model/transformed.json' },
];

const dataDir = () => path.join(openProject().filesDir, 'data');

const describeTables = () =>
  callPython<TableSchema[]>('describe_tables', { data_dir: dataDir() });

async function loadedTable(input: Record<string, unknown>) {
  const table = text(input, 'table').trim();
  const found = (await describeTables()).find((t) => t.name === table);
  if (!found) {
    throw new Error(
      `There's no table called ${table}. list_tables lists the tables.`,
    );
  }
  if (found.kind !== 'loaded') {
    throw new Error(
      `${table} is a transformed table: change its query with save_table instead.`,
    );
  }
  return table;
}

/**
 * Runs a change to tables. If it fails part-way, the journal puts the SQL files back; this also
 * removes any data they no longer account for (e.g. a table built just before the failure).
 */
async function tableChange<T>(
  ctx: ToolContext,
  call: ToolCall,
  summary: string,
  targets: Target[],
  operation: () => Promise<T>,
): Promise<T> {
  const before = await sourceTables();
  try {
    const result = await ctx.change(call, summary, targets, operation, [
      'sources',
      'model',
      'report',
    ]);
    ctx.show('model');
    return result;
  } catch (error) {
    await removeUnaccountedData(before).catch(() => {});
    throw error;
  }
}

export function modelTools(ctx: ToolContext): ToolSpec[] {
  return [
    {
      name: 'set_transform',
      description:
        "Gives a loaded table an in-place transform, or changes it: a SELECT query whose result replaces the table everywhere in the app (the original data is kept). The query reads loaded tables' original data by name, not transformed tables. Test it with run_query first. Tables built from this one are rebuilt.",
      parameters: {
        type: 'object',
        properties: {
          table: { type: 'string', description: 'The loaded table.' },
          sql: {
            type: 'string',
            description: 'One SELECT query (DuckDB SQL).',
          },
        },
        required: ['table', 'sql'],
        additionalProperties: false,
      },
      change: true,
      describe: async (input) => {
        const table = String(input.table ?? 'a table');
        return table in (await readTransforms()).tables
          ? `Change the transform of ${table}`
          : `Transform ${table}`;
      },
      run: async (input, call) => {
        const table = await loadedTable(input);
        const sql = text(input, 'sql');
        const had = table in (await readTransforms()).tables;
        const result = await tableChange(
          ctx,
          call,
          had
            ? `Changed the transform of ${table}`
            : `Added a transform to ${table}`,
          SQL_FILES,
          () => applyTransform(table, sql),
        );
        return { table, rows: result.rows };
      },
    },
    {
      name: 'remove_transform',
      description:
        "Removes a loaded table's in-place transform, so the app shows its original data again. Tables built from it are rebuilt.",
      parameters: {
        type: 'object',
        properties: {
          table: { type: 'string', description: 'The loaded table.' },
        },
        required: ['table'],
        additionalProperties: false,
      },
      change: true,
      describe: (input) =>
        `Remove the transform of ${String(input.table ?? 'a table')}`,
      run: async (input, call) => {
        const table = await loadedTable(input);
        if (!(table in (await readTransforms()).tables)) {
          return `${table} has no transform.`;
        }
        await tableChange(
          ctx,
          call,
          `Removed the transform of ${table}`,
          SQL_FILES,
          () => removeTransform(table),
        );
        return `Removed. ${table} shows its original data again.`;
      },
    },
    {
      name: 'save_table',
      description:
        'Creates a transformed table, or changes its query: a new table built by a SELECT query from any tables (loaded or transformed) by name. Test the query with run_query first. Tables built from this one are rebuilt.',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description:
              'Lowercase letters, digits and underscores, starting with a letter, e.g. sales_by_region. Not the name of another table.',
          },
          sql: {
            type: 'string',
            description: 'One SELECT query (DuckDB SQL).',
          },
        },
        required: ['name', 'sql'],
        additionalProperties: false,
      },
      change: true,
      describe: async (input) => {
        const name = String(input.name ?? 'a table');
        return (await listTransformed()).some((t) => t.name === name)
          ? `Change the table ${name}`
          : `Create the table ${name}`;
      },
      run: async (input, call) => {
        const name = text(input, 'name').trim();
        const sql = text(input, 'sql');
        const isNew = !(await listTransformed()).some((t) => t.name === name);
        const result = await tableChange(
          ctx,
          call,
          isNew ? `Created the table ${name}` : `Changed the table ${name}`,
          SQL_FILES,
          () => saveTransformed({ name, sql, isNew }),
        );
        return { table: name, rows: result.rows };
      },
    },
    {
      name: 'delete_table',
      description:
        "Deletes a table. A transformed table's query goes with it; a loaded table's data, nested tables (name__child) and transform go, and it comes back if its source is loaded again with it chosen. Refused while other tables read it.",
      parameters: {
        type: 'object',
        properties: {
          table: { type: 'string', description: 'The table.' },
        },
        required: ['table'],
        additionalProperties: false,
      },
      change: true,
      describe: (input) =>
        `Delete the table ${String(input.table ?? 'a table')}`,
      run: async (input, call) => {
        const table = text(input, 'table').trim();
        if (!(await describeTables()).some((t) => t.name === table)) {
          throw new Error(
            `There's no table called ${table}. list_tables lists the tables.`,
          );
        }
        const { doomed, owner, transformed } = await deletion(table);
        // A loaded table's data can't be rebuilt from SQL, so Undo keeps a copy of it.
        const targets: Target[] = [
          ...SQL_FILES,
          ...(owner ? [{ file: `sources/${owner.id}.json` }] : []),
          ...(table in transformed.tables
            ? []
            : doomed.map((t) => ({ dir: `data/raw/${t}` }))),
        ];
        const others = doomed.filter((t) => t !== table);
        await tableChange(
          ctx,
          call,
          `Deleted the table ${table}${others.length ? ` (and ${others.join(', ')})` : ''}`,
          targets,
          // Its place on the canvas is kept, so Undo puts it back where it was.
          () => deleteTable(table, { keepLayout: true }),
        );
        return `Deleted ${doomed.join(', ')}.`;
      },
    },
  ];
}
