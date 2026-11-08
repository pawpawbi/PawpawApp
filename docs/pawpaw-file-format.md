# The .pawpaw file format

**Format version:** 1
**Status:** Draft. Sections marked _not written yet_ describe files the app doesn't produce yet; they may change before it does.

A `.pawpaw` file is a standard ZIP archive containing one PawpawBI project: its data, its data model, its report and its assistant conversation. Everything inside is an ordinary file (JSON, JSON Lines, Parquet, PNG), so a project can be unzipped and inspected with everyday tools.

## Folder structure

```
Sales report.pawpaw            (ZIP archive)
├── mimetype                   Identifies the archive as a PawpawBI project
├── manifest.json              Project metadata and format version
├── published.json             Where the report is published to PawpawBI (only once it is)
├── thumbnail.png              Preview image for the start screen (optional, not written yet)
│
├── sources/                   Where the data came from
│   └── <source-id>.json       One file per data source
│
├── data/                      The data itself, as Parquet
│   ├── raw/                   Exactly as loaded by dlt
│   │   ├── <table>/           One folder per table
│   │   │   └── *.parquet
│   │   └── _dlt_*/            dlt's bookkeeping (load history, pipeline state)
│   ├── model/                 Loaded tables' in-place SQL transform results
│   │   └── <table>/
│   │       └── data.parquet
│   └── transformed/           Transformed tables, built by SQL from other tables
│       └── <table>/
│           └── data.parquet
│
├── model/                     How the data fits together
│   ├── tables/
│   │   └── <table>.json       Column types, names and descriptions for one table
│   ├── relationships.json     How tables join to each other
│   ├── diagram.json           Where each table sits on the Model data canvas
│   ├── transforms.json        In-place SQL transforms of loaded tables
│   ├── transformed.json       Transformed tables' SQL queries and dependencies
│   └── datasets.json          The report's datasets: named queries
│
├── report/                    The report: a static website, hostable as-is
│   ├── index.html             Landing page, listing the pages
│   ├── report.json            Report title and pages, in order
│   ├── pages/
│   │   └── <page-guid>.html   One page
│   ├── assets/
│   │   ├── report.css         The site's styles
│   │   └── charts.js          The chart library
│   └── data/
│       └── <dataset>.json     Each dataset's result, written by the app
│
└── chat/                      The assistant conversation
    ├── session.json           Current workflow stage
    └── messages.jsonl         Message history, one message per line
```

Only `mimetype` and `manifest.json` are required. A brand-new project contains those and the default `report/`; every other folder is optional until something is put in it. A project without `report/` is valid, and the app offers to add one.

## Archive rules

These apply to the ZIP container itself.

1. **`mimetype` comes first and is uncompressed.** It must be the first entry in the archive, stored without compression, and contain exactly this text with no trailing newline:
   ```
   application/vnd.pawpawbi.project+zip
   ```
   This lets PawpawBI (and other tools) identify a project file from its first few bytes without unzipping it. EPUB and OpenDocument files use the same trick.
2. **Paths** use forward slashes, are UTF-8 and are relative to the archive root. Entries with absolute paths, drive letters, `..` segments or backslashes are invalid, and PawpawBI must refuse to open the file rather than skip them. This protects against "zip slip" attacks, where a crafted archive writes files outside the folder it's extracted into.
3. **Compression:** Parquet and PNG files are already compressed, so store them uncompressed. That makes saving faster and costs nothing in size. Compress everything else (JSON, JSONL) with Deflate.
4. **Large projects:** writers must support ZIP64 so archives and individual files can exceed 4 GB.
5. **Unknown files** are preserved. PawpawBI ignores files and folders it doesn't recognise but writes them back unchanged when saving, so newer versions can add things without older versions destroying them.
6. **No secrets.** Passwords, API keys and access tokens are never written into a `.pawpaw` file. See [Data sources](#data-sources).

## Naming rules

- **Table names** are lowercase letters, digits and underscores, starting with a letter (for example `monthly_sales`). This matches how dlt names tables, so a table's folder in `data/raw/`, its file in `model/tables/` and the name used everywhere else are identical.
- **IDs** are generated when an item is created and never changed, so renaming something never breaks what refers to it. Source IDs are 8 lowercase letters and digits (e.g. `k3f9x2ab`); page IDs are lowercase version 4 UUIDs (e.g. `3f2b8c1e-9a4d-4e7b-b6c2-5d1e8f0a7c94`).
- **Dates and times** are ISO 8601 in UTC, e.g. `2026-10-17T09:30:00Z`.

## manifest.json

Identifies the project and the format version. Required.

```json
{
  "formatVersion": 1,
  "id": "p7d2m4q8",
  "name": "Sales report",
  "createdAt": "2026-10-17T09:30:00Z",
  "modifiedAt": "2026-10-17T11:02:41Z",
  "createdWith": "PawpawBI 1.0.0",
  "modifiedWith": "PawpawBI 1.0.0"
}
```

| Field                         | Required | Meaning                                                                                                                  |
| ----------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------ |
| `formatVersion`               | Yes      | Version of this specification the file follows. See [Versioning](#versioning)                                            |
| `id`                          | Yes      | Permanent unique ID. Stays the same when the file is renamed, copied or moved; used to find the project's working folder |
| `name`                        | Yes      | Display name. Defaults to the file name when the project is created; the user can change it independently                |
| `createdAt`, `modifiedAt`     | Yes      | When the project was created and last saved                                                                              |
| `createdWith`, `modifiedWith` | Yes      | App name and version that created and last saved the file. Useful for diagnosing compatibility problems                  |

## Data sources

`sources/<source-id>.json` records where data came from, so it can be refreshed later.

```json
{
  "id": "s4h8n1",
  "type": "file",
  "name": "Monthly Sales.csv",
  "options": {
    "path": "C:/Users/Ana/Documents/Monthly Sales.csv"
  },
  "resources": ["Monthly Sales"],
  "tables": ["monthly_sales"],
  "lastLoadedAt": "2026-10-17T09:41:12Z"
}
```

| Field          | Meaning                                                                                                     |
| -------------- | ----------------------------------------------------------------------------------------------------------- |
| `type`         | Connector ID from the catalog in `python/sidecar/connectors/`, e.g. `local_files`, `postgres`, `salesforce` |
| `options`      | The connector's non-secret settings, by field key: file path, host, database name, user name and so on      |
| `resources`    | The connector resources the user chose to load. Empty means the connector's defaults                        |
| `tables`       | The tables in `data/raw/` this source produced. No two sources may produce the same table                   |
| `lastLoadedAt` | When the data was last loaded                                                                               |

**Credentials** (passwords, API keys, tokens: every connector field marked `secret`) are stored in the operating system's secure storage on the user's machine, via Electron's `safeStorage`, keyed by project ID and source ID. They are never in the file. When someone opens a project on another computer, the data and report work immediately; refreshing a source asks them to sign in again.

**File paths** in `options` point to the original location on the computer that loaded them. On another computer that path may not exist. The data already loaded is unaffected; only refreshing needs the user to locate the file again.

## data/

The project's data, stored as Parquet.

There are two kinds of table:

- **Loaded tables** come from data loads. Their data is in `raw/`.
- **Transformed tables** are built by a SQL query from other tables. Their data is in `transformed/`.

The folders:

- **`data/raw/`** is written only by dlt. Each table is a folder of one or more Parquet files that together make up the table; readers must treat the folder as a single table and never rely on file names. The `_dlt_loads`, `_dlt_pipeline_state` and `_dlt_version` folders are dlt's own records of what it loaded; keep them so loads stay consistent.
- **`data/model/<table>/data.parquet`** is a loaded table's in-place transform result (`model/transforms.json`), used in place of its `raw/` version everywhere in the app.
- **`data/transformed/<table>/data.parquet`** is a transformed table (`model/transformed.json`).

Loaded and transformed table names are unique across both kinds. Everything in `model/` and `transformed/` can be rebuilt from `raw/` plus the queries.

## model/

What the user and the assistant have worked out about the data, typically during the _Model data_ step. None of this changes the data in `raw/`; it describes how to interpret it.

### model/tables/&lt;table&gt;.json (not written yet)

One file per table (loaded or transformed). A table with no file here is used as-is.

```json
{
  "table": "monthly_sales",
  "layer": "raw",
  "displayName": "Monthly sales",
  "description": "One row per order, exported from the sales system.",
  "columns": {
    "order_date": { "type": "date", "displayName": "Order date" },
    "revenue": {
      "type": "currency",
      "currency": "AUD",
      "description": "Excludes GST"
    },
    "order_id": { "role": "key" }
  }
}
```

| Field                        | Meaning                                                                                |
| ---------------------------- | -------------------------------------------------------------------------------------- |
| `layer`                      | `raw`, `model` or `transformed`: which folder under `data/` the table is in            |
| `displayName`, `description` | How the table is labelled in the app and explained to the assistant                    |
| `columns`                    | Per-column overrides, by column name. Only columns with something to say need an entry |

Column fields, all optional:

- `type`: how to interpret values, overriding what was stored. One of `text`, `integer`, `decimal`, `currency`, `percentage`, `boolean`, `date`, `datetime`.
- `role`: `key` (uniquely identifies a row), `measure` (a number to add up or average) or `dimension` (something to group by).
- `displayName`, `description`, `hidden` (`true` to keep it out of the report builder), and `format` for display (e.g. `"0.0%"`).

### model/relationships.json (not written yet)

How tables join. The assistant proposes these and the user confirms them.

```json
{
  "relationships": [
    {
      "id": "r2k7d9",
      "from": { "table": "monthly_sales", "column": "customer_id" },
      "to": { "table": "customers", "column": "id" },
      "cardinality": "many-to-one"
    }
  ]
}
```

`cardinality` is `one-to-one`, `many-to-one` or `many-to-many`.

### published.json

Written when the project's report is published to PawpawBI (the PawpawBI server:
[pawpaw-server-api.md](pawpaw-server-api.md)). It's what the app needs to publish the same report
again and to refresh its data, and to list the project on Published projects; that list
(`published-reports.json` on each computer) can always be rebuilt from these files.

```json
{
  "pawpawbi": {
    "reportId": "k3j9xq2mtb7w4zpa",
    "url": "https://k3j9xq2mtb7w4zpa.pawpawreports.com/",
    "account": "ana@example.com",
    "org": {
      "id": "2YxAWQB0AfXP",
      "name": "Acme sales team",
      "personal": false
    },
    "visibility": "org",
    "publishedAt": "2026-10-18T10:00:00.000Z",
    "refreshedAt": "2026-10-19T07:30:00.000Z"
  }
}
```

- `reportId`: the server's ID for the report: letters, digits, `-` and `_`, at most 64.
- `url`: where it's hosted; `https:` only (or a loopback address, for the development stand-in).
- `account`: the email of the PawpawBI account it was last published from. It's for showing
  only: who may publish it again or refresh it is up to the server (the report's organisation
  and the person's role there).
- `org`: the PawpawBI organisation it belongs to: `id` (like `reportId`), `name` (at most 100
  characters) and `personal` (`true` for the account's own workspace). `null` when not known.
- `visibility`: who can open it as of the last publish or refresh: `link` (anyone with the
  link), `org` (the organisation's members) or `restricted` (its admins and owners and whoever
  published it). It can be changed in the PawpawBI web console, so it may be out of date;
  `null` when not known.
- `publishedAt`, `refreshedAt`: when the site and its data were last uploaded (or `null`).
- The file is read defensively: if `reportId` or `url` isn't valid, the project counts as
  unpublished; an `org` or `visibility` that isn't valid is read as `null`. No sign-in token is
  ever stored in the project.

### model/diagram.json

Where each table's card sits on the Model data canvas, in canvas pixels. Tables without an entry are placed automatically; entries for tables that no longer exist are ignored.

```json
{
  "tables": {
    "monthly_sales": { "x": 48, "y": 120 },
    "customers": { "x": 336, "y": 120 }
  }
}
```

### model/transforms.json

In-place transforms of loaded tables: each changes how one loaded table looks. The query's result becomes `data/model/<table>/data.parquet`.

```json
{
  "tables": {
    "monthly_sales": {
      "sql": "SELECT order_id, CAST(order_date AS DATE) AS order_date, revenue FROM monthly_sales",
      "updatedAt": "2026-10-17T11:20:00Z"
    }
  }
}
```

The query can read any **loaded** table by name and always reads their original `raw/` data, so in-place transforms never depend on each other.

### model/transformed.json

Transformed tables: new tables built from other tables. The query's result becomes `data/transformed/<table>/data.parquet`.

```json
{
  "tables": {
    "sales_by_region": {
      "sql": "SELECT region, sum(revenue) AS revenue FROM monthly_sales GROUP BY region",
      "dependsOn": ["monthly_sales"],
      "updatedAt": "2026-10-17T11:25:00Z",
      "error": null
    }
  }
}
```

| Field       | Meaning                                                               |
| ----------- | --------------------------------------------------------------------- |
| `sql`       | The query that builds the table                                       |
| `dependsOn` | The tables the query reads, worked out from the query when it's saved |
| `error`     | Why the last build failed, or `null`                                  |

- The query can read any other table by name, loaded or transformed, as the app shows it (a loaded table's in-place transform result if it has one).
- Circular references (a table that reads itself, directly or through other transformed tables) are refused when saving.
- A table can't be deleted while a transformed table, or another loaded table's in-place transform, reads it.

### Rebuilding

After data is loaded (one source or all of them), the app:

1. Re-applies every in-place transform.
2. Rebuilds every transformed table in dependency order, each after the transformed tables it reads.

A failing transformed-table query has its table's old result removed and its error recorded; tables that read a failed table fail too. A failing in-place transform keeps its previous result.

### Rules for all queries

- A query must be a **single read-only `SELECT`** (DuckDB SQL).
- Queries run in an in-memory DuckDB that can read only the project's `data/` folder: no other files, no network, no extensions, and no changing those settings. Projects can come from other people, so a query must never be able to reach anything else on the computer.
- Arbitrary code (Python and the like) is never stored here. The only code a project holds is the JavaScript in the report (`report/`), which runs only in a sandbox: in the app, a `sandbox="allow-scripts"` frame with a Content Security Policy and every web request blocked.

### model/datasets.json

The report's datasets: named queries whose results the report shows. Each result is written to `report/data/<name>.json` (see below).

```json
{
  "datasets": {
    "revenue_by_month": {
      "sql": "SELECT CAST(date_trunc('month', order_date) AS DATE) AS month, sum(revenue) AS revenue FROM monthly_sales GROUP BY 1 ORDER BY 1",
      "updatedAt": "2026-10-17T11:40:00Z",
      "rows": 18,
      "refreshedAt": "2026-10-17T11:40:01Z"
    }
  }
}
```

| Field         | Meaning                                                          |
| ------------- | ---------------------------------------------------------------- |
| `sql`         | The query, which can read any table by name, as the app shows it |
| `updatedAt`   | When the query was last changed                                  |
| `rows`        | Rows written at the last refresh                                 |
| `refreshedAt` | When the data was last written                                   |
| `error`       | Why the last refresh failed (absent if it succeeded)             |

- Names are lowercase letters, digits and underscores, starting with a letter, at most 63 characters.
- Datasets are refreshed after every data load or rebuild, and before the report is exported. A failing query keeps its previous data and records the error.
- A result is limited to 50,000 rows and 10 MB.

## report/

The report is a static website of plain HTML, CSS and JavaScript. It depends on nothing outside the folder, so the folder can be hosted as-is (for example on S3 behind a CDN) once its datasets are refreshed. A new project starts with a default report. How to write pages: [guides/report.md](guides/report.md).

| File                     | What it is                                                                                     |
| ------------------------ | ---------------------------------------------------------------------------------------------- |
| `index.html`             | The landing page: the report's title and a link to each page                                   |
| `report.json`            | The report's title and its pages, in order                                                     |
| `pages/<page-guid>.html` | One page. Any HTML; it links the shared stylesheet and chart library with relative paths       |
| `assets/report.css`      | The site's styles                                                                              |
| `assets/charts.js`       | The chart library (`window.pawpaw`). Each report has its own copy                              |
| `assets/…`               | Other files pages use: images (PNG, JPEG, GIF, WebP, SVG, ICO), fonts (WOFF2), scripts, styles |
| `data/<dataset>.json`    | Datasets' results, written by the app. Not edited by hand                                      |

**`report/report.json`**:

```json
{
  "title": "Sales report",
  "pages": [
    { "id": "3f2b8c1e-9a4d-4e7b-b6c2-5d1e8f0a7c94", "title": "Overview" },
    { "id": "8c0d5a7e-1b2f-4c3d-9e8f-7a6b5c4d3e2f", "title": "Regions" }
  ]
}
```

- `id`: the page's GUID, a lowercase version 4 UUID, generated when the page is created and never changed. The page's file is `pages/<id>.html`.
- `title`: shown in the report's menu, at most 80 characters (as is the report's `title`, which starts the menu).
- Page files don't contain the menu. The app shows it above each page and Publish writes it into each page's `<body>`, with its styles in the `<head>` (`src/shared/site-menu.ts`). Pages from older projects have an empty `<header id="nav">` and a `pawpaw.nav('#nav')` call; the app and Publish leave those out.
- Pages without a valid GUID are ignored, as is an HTML file in `pages/` that isn't listed.
- Pages, stylesheets and scripts written by the app or the assistant are at most 2 MB each.

**`report/data/<dataset>.json`**:

```json
{
  "name": "revenue_by_month",
  "generatedAt": "2026-10-17T11:40:01Z",
  "columns": [
    { "name": "month", "type": "DATE" },
    { "name": "revenue", "type": "DOUBLE" }
  ],
  "rows": [
    ["2024-01-01", 60000.0],
    ["2024-02-01", 63200.0]
  ],
  "truncated": false
}
```

Values are JSON numbers, strings, booleans or `null`; dates and timestamps are ISO 8601 text without a time zone (`2024-01-01`, `2024-01-01T06:30:00`). `truncated` is `true` if rows were left out to stay within the limits.

**Rules:**

- Pages may load only files inside the report folder, by relative path. Nothing from the internet: no external scripts, stylesheets, fonts or images (the app blocks them, and the report must work offline).
- Only files of the types listed above are part of the site. Hidden files (names starting with `.`) aren't.

## chat/

The conversation with the assistant, so it can pick up where it left off.

- **`chat/session.json`** holds where the user is in the workflow:
  ```json
  { "stage": "model" }
  ```
  `stage` is `data`, `model` or `visuals`.
- **`chat/messages.jsonl`** holds one message per line, oldest first, so new messages can be appended without rewriting the whole file. Besides what the user and assistant say, it records the assistant's work (the tools it used and their results), so the conversation can continue where it left off:

  ```json
  {"id":"m1","role":"assistant","text":"Hi! Let's build your report together…","createdAt":"2026-10-17T09:30:02Z"}
  {"id":"m2","role":"user","text":"How many orders are there by region?","createdAt":"2026-10-17T09:31:15Z"}
  {"id":"m3","role":"assistant","text":"Let me check.","toolCalls":[{"id":"toolu_1","name":"run_query","input":{"sql":"SELECT region, count(*) AS orders FROM orders GROUP BY 1"}}],"createdAt":"2026-10-17T09:31:17Z"}
  {"id":"m4","role":"tool","text":"{\"columns\":[\"region VARCHAR\",\"orders BIGINT\"],\"rows\":[[\"North\",100]],\"total_rows\":1}","toolCallId":"toolu_1","toolName":"run_query","summary":"Running a query","createdAt":"2026-10-17T09:31:17Z"}
  {"id":"m5","role":"assistant","text":"North has 100 orders.","createdAt":"2026-10-17T09:31:19Z"}
  ```

  | Field        | Meaning                                                                                      |
  | ------------ | -------------------------------------------------------------------------------------------- |
  | `id`         | A short random ID, unique within the conversation                                            |
  | `createdAt`  | When the message was saved                                                                   |
  | `role`       | `user`, `assistant` or `tool`                                                                |
  | `text`       | What was said; for a tool message, the result given to the model (at most 20,000 characters) |
  | `toolCalls`  | Assistant messages: the tools it asked to run, each with an `id`, `name` and `input`         |
  | `toolCallId` | Tool messages: the call this answers. Also `toolName` and `isError`                          |
  | `summary`    | A few words shown in the chat instead of `text`: on tool messages and event notes            |
  | `changeId`   | Tool messages that changed the project: the change (Undo works while the project is open)    |
  | `declined`   | Tool messages: `true` if the user didn't allow the change                                    |
  | `event`      | `true` on a note to the assistant about something the user did, e.g. undoing changes         |

  Tool results can contain samples of the project's data. A damaged line is skipped.

## Opening and saving

PawpawBI never edits the inside of a ZIP in place.

- **Opening:** check that the first entry is `mimetype` with the expected value, validate every path (see [Archive rules](#archive-rules)), then extract the archive into a working folder in the app's data directory, named after the project's `id` plus a short hash of the file's location (so two copies of the same project never share a folder). All work happens on those ordinary files. dlt writes to `data/raw/` there and DuckDB queries it.
- **Saving:** update `modifiedAt` and `modifiedWith`, zip the working folder into a temporary file next to the destination, then replace the original with it in one step. If anything fails partway, the original file is left untouched.
- **Crash recovery:** the working folder survives a crash. When a project is opened and its working folder contains unsaved changes newer than the file, PawpawBI offers to recover them.
- **Closing:** the working folder is deleted once the project is saved or the user discards their changes.
- **Renaming** (Edit project) changes `name` in `manifest.json`, saved with the next save; the file keeps its own name.
- **Deleting** (Edit project) moves the file to the Recycle Bin, removes it from the recent list, deletes the data sources' saved credentials on this computer and the working folder, without saving.

## Versioning

`formatVersion` in `manifest.json` is a whole number that increases only for changes older versions of PawpawBI can't safely read, such as renaming a folder or changing what a field means.

- **Adding things doesn't need a new version.** New optional files, folders or JSON fields can be added at any time; older versions ignore and preserve them (archive rule 5).
- **Opening an older format:** PawpawBI upgrades it in the working folder and writes the new format the next time it's saved.
- **Opening a newer format:** PawpawBI refuses with a message asking the user to update, rather than risk damaging the file.

## Example: a small project

```
Sales report.pawpaw
├── mimetype
├── manifest.json
├── thumbnail.png
├── sources/
│   └── s4h8n1.json
├── data/
│   └── raw/
│       ├── monthly_sales/
│       │   └── 1792192294.0710592.d4920fcdde.parquet
│       ├── _dlt_loads/…
│       ├── _dlt_pipeline_state/…
│       └── _dlt_version/…
├── model/
│   └── tables/
│       └── monthly_sales.json
└── chat/
    ├── session.json
    └── messages.jsonl
```
