# PawpawBI

A Windows desktop app for building business intelligence reports, with an assistant that guides
you through three steps: **add data** from files, databases and business apps; **model** it
(fix types, transform with SQL, and later define relationships); and **build visuals**.

Built with Electron, Vue and TypeScript, plus a bundled Python that does the data work with
[dlt](https://dlthub.com) (connecting to data) and DuckDB (querying it). Each project is a single `.pawpaw` file: a ZIP of
ordinary files and folders, defined in [docs/pawpaw-file-format.md](docs/pawpaw-file-format.md).

## Status

Early development. Working:

- **Projects:** create, open, save, crash recovery, rename and delete (Edit project).
- **Data:** 47 data connectors (the file connectors and SQLite are tested, the rest aren't yet; setup notes for
  each are in [docs/guides/data.md](docs/guides/data.md)). Loads show how long they've been running and can
  be stopped until their data has arrived.
- **Model:** the Model data canvas with dependency lines, SQL transforms of loaded tables,
  transformed tables built from other tables, and refreshing everything in dependency order.
- **Report:** a static website of charts (bars, lines, headline numbers, tables) that every new
  project starts with, fed by datasets, with a menu of its pages
  ([docs/guides/report.md](docs/guides/report.md)).
- **Publish:** to PawpawBI (an account with an email and password; the report is hosted at a
  link, in your personal workspace or an organisation you choose, open to anyone with the link
  or only to its members, who sign in to see it; its data can be refreshed later from the start screen's Published
  projects, and organisations, members and who can open each report are managed in the
  PawpawBI web console), as a single HTML file to send by email (it opens in any web browser,
  offline), or to a folder for hosting anywhere, e.g. S3. The PawpawBI server's API is
  [docs/pawpaw-server-api.md](docs/pawpaw-server-api.md); the server itself is a separate project.
- **Assistant:** chats with Claude or ChatGPT using your own API key, or a local model in Ollama.
  It can look at everything in the project, add, change, load and remove data sources, shape
  tables with SQL and build the report (pages, files and datasets), asking before each change,
  with Undo. What it's told is in [docs/guides/](docs/guides/).

Not built yet: relationships between tables. Known issues and the backlog are tracked with the PawpawBI server's.

## Getting started

Prerequisites: **Windows**, **Node.js 22** and npm. Git is recommended. You don't need Python:
the app downloads its own.

```powershell
npm install
npm start
```

The first `npm start` downloads a portable Python 3.12 (about 22 MB) into `python/runtime/` and
installs the Python packages, which takes a minute or two. Later starts skip this unless the
pinned versions change.

`npm run make` builds the Windows installer into `out/make/`, and `npm test` runs the tests.

## Documentation

- [docs/pawpaw-file-format.md](docs/pawpaw-file-format.md): the `.pawpaw` project file format.
- [docs/pawpaw-server-api.md](docs/pawpaw-server-api.md): the PawpawBI server's API, which publishing uses.
- [docs/guides/](docs/guides/): what the built-in assistant is told and reads, bundled into the app:
  its instructions, and guides to [adding data](docs/guides/data.md) (with notes on each connector),
  [modelling](docs/guides/model.md) and [the report](docs/guides/report.md) (pages, datasets and the
  chart library, also the reference for writing pages by hand).
- [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md): licences of everything the app ships.

## Licence

MIT: see [LICENSE](LICENSE). The software PawpawBI ships with is under its own licences
([THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)).
