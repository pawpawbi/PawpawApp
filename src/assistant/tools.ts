// The assistant's tools. These only look at the project; nothing here changes it.
// Results go to the model provider, so they include samples of the data but never secrets.
import path from 'node:path';
import {
  catalog,
  listTransformed,
  readAllSources,
  readTransforms,
  toDataSource,
} from '../data';
import { openProject } from '../projects';
import { callPython } from '../python';
import { listDatasets } from '../report';
import { hasSite, readReport, readSiteFile } from '../report-site';
import type { TablePreview, TableSchema } from '../shared/types';
import { MAX_ROWS, rowLimit, text } from './input';
import { GUIDES } from './prompt';
import type { ToolSpec } from './types';

const dataDir = () => path.join(openProject().filesDir, 'data');

/** A preview as compact JSON: column names and types, then rows as arrays. */
const compact = (preview: TablePreview) => ({
  columns: preview.columns.map((c) => `${c.name} ${c.type}`),
  rows: preview.rows,
  total_rows: preview.row_count,
});

const describeTables = () =>
  callPython<TableSchema[]>('describe_tables', { data_dir: dataDir() });

export const READ_TOOLS: ToolSpec[] = [
  {
    name: 'list_tables',
    description:
      'Every table in the project with its kind (loaded from a data source, or transformed: built by SQL from other tables), row count and columns with types. Tables are queried by these names.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    describe: () => 'Looking at the tables',
    run: async () =>
      (await describeTables()).map((t) => ({
        name: t.name,
        kind: t.kind,
        rows: t.rows,
        has_in_place_transform: t.transformed,
        columns: t.columns.map((c) => `${c.name} ${c.type}`),
      })),
  },
  {
    name: 'preview_table',
    description: `The first rows of a table (at most ${MAX_ROWS}), as currently shown in the app.`,
    parameters: {
      type: 'object',
      properties: {
        table: { type: 'string', description: 'The table name.' },
        limit: {
          type: 'integer',
          description: `Rows to return, 1 to ${MAX_ROWS}. Default 10.`,
        },
      },
      required: ['table'],
      additionalProperties: false,
    },
    describe: (input) => `Previewing ${String(input.table ?? 'a table')}`,
    run: async (input) =>
      compact(
        await callPython<TablePreview>('preview_table', {
          data_dir: dataDir(),
          table: text(input, 'table'),
          limit: rowLimit(input, 10),
        }),
      ),
  },
  {
    name: 'run_query',
    description: `Runs one read-only SELECT query (DuckDB SQL) over the project's tables by name, and returns its columns, first rows (at most ${MAX_ROWS}) and total row count. Use it to explore data and to test SQL before suggesting it. Nothing is saved.`,
    parameters: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: 'One SELECT query.' },
        limit: {
          type: 'integer',
          description: `Rows to return, 1 to ${MAX_ROWS}. Default 20.`,
        },
      },
      required: ['sql'],
      additionalProperties: false,
    },
    describe: () => 'Running a query',
    run: async (input) =>
      compact(
        await callPython<TablePreview>('preview_transform', {
          data_dir: dataDir(),
          sql: text(input, 'sql'),
          kind: 'transformed',
          limit: rowLimit(input, 20),
        }),
      ),
  },
  {
    name: 'list_sources',
    description:
      'The data sources set up in this project: connector, non-secret settings, chosen resources, the tables each one loaded and when. Secret settings (passwords, keys) are never shown, only whether one is saved.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    describe: () => 'Looking at the data sources',
    run: async () => Promise.all((await readAllSources()).map(toDataSource)),
  },
  {
    name: 'list_connectors',
    description:
      'Connectors available for adding data (files, databases, business apps), with their settings. Filter with a search term, e.g. "csv", "postgres" or "salesforce".',
    parameters: {
      type: 'object',
      properties: {
        search: {
          type: 'string',
          description: 'Words to look for. Leave out to list them all briefly.',
        },
      },
      additionalProperties: false,
    },
    describe: (input) =>
      input.search
        ? `Looking for a ${String(input.search)} connector`
        : 'Looking at the connectors',
    run: async (input) => {
      const { connectors } = await catalog();
      const search =
        typeof input.search === 'string'
          ? input.search.toLowerCase().trim()
          : '';
      if (!search) {
        return connectors.map((c) => ({
          id: c.id,
          name: c.name,
          category: c.category,
        }));
      }
      const words = search.split(/\s+/);
      return connectors
        .filter((c) => {
          const haystack = [
            c.id,
            c.name,
            c.category,
            c.description,
            ...c.keywords,
          ]
            .join(' ')
            .toLowerCase();
          return words.every((w) => haystack.includes(w));
        })
        .map((c) => ({
          id: c.id,
          name: c.name,
          category: c.category,
          description: c.description,
          needs_download: c.packages.length > 0,
          fields: c.fields.map((f) => ({
            key: f.key,
            label: f.label,
            type: f.type,
            required: f.required,
            secret: f.secret,
            help: f.help || undefined,
            options: f.options.length
              ? f.options.map((o) => o.value)
              : undefined,
          })),
        }));
    },
  },
  {
    name: 'list_transforms',
    description:
      "The project's SQL: in-place transforms (a loaded table's query, which reads loaded tables' original data and replaces the table) and transformed tables (new tables built by a query from any tables, with the tables they read and any build error).",
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    describe: () => 'Looking at the transforms',
    run: async () => ({
      in_place: Object.entries((await readTransforms()).tables).map(
        ([table, t]) => ({
          table,
          sql: t.sql,
        }),
      ),
      transformed_tables: await listTransformed(),
    }),
  },
  {
    name: 'get_report',
    description:
      'The report: its title, its pages in order (each page is the file pages/<id>.html) and its datasets (name, SQL, rows written, any error). Pages read datasets from data/<name>.json.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    describe: () => 'Looking at the report',
    run: async () => {
      const filesDir = openProject().filesDir;
      if (!(await hasSite(filesDir))) return { exists: false };
      return {
        exists: true,
        ...(await readReport(filesDir)),
        datasets: await listDatasets(),
      };
    },
  },
  {
    name: 'read_report_file',
    description:
      'Reads a page, stylesheet or script of the report by its path in the site, e.g. "pages/<id>.html", "assets/report.css" or "index.html".',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: "The file's path in the report." },
      },
      required: ['path'],
      additionalProperties: false,
    },
    describe: (input) => `Reading ${String(input.path ?? 'a report file')}`,
    run: (input) => readSiteFile(openProject().filesDir, text(input, 'path')),
  },
  {
    name: 'read_guide',
    description: `Detailed guidance on a topic. Read it before working on that topic. Topics: ${Object.entries(
      GUIDES,
    )
      .map(([id, g]) => `"${id}" (${g.about})`)
      .join(', ')}.`,
    parameters: {
      type: 'object',
      properties: {
        topic: { type: 'string', enum: Object.keys(GUIDES) },
      },
      required: ['topic'],
      additionalProperties: false,
    },
    describe: () => 'Reading a guide',
    run: async (input) => {
      const guide = GUIDES[text(input, 'topic')];
      if (!guide)
        throw new Error(`There's no guide called ${String(input.topic)}.`);
      return guide.text;
    },
  },
];
