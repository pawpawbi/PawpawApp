# Vendored dlt verified sources

These folders are copied unmodified from [dlt-hub/verified-sources](https://github.com/dlt-hub/verified-sources),
licensed under the Apache License 2.0 (see `LICENSE` in this folder).

- **Commit:** `3957506893a7da821dbcc6acd51c7ca4475d1f53` (2026-07-03)
- **Copied from:** `sources/<name>/` in that repository

Each source's extra Python packages (its `requirements.txt`) are not bundled with the app. They
are installed the first time the connector is used; see `python/sidecar/connectors/`.

## Updating

Download the repository at a newer commit, replace the folders here, update the commit above,
then re-check each connector's settings in `python/sidecar/connectors/apps/` against the
source's function signature, since parameters do change between versions.

Not included: `chess` and `pokemon` (demos), `scraping` (web scraping), `unstructured_data`
(AI document pipeline), `pg_replication` (needs database-side setup), and `filesystem`,
`rest_api` and `sql_database` (these are built into dlt itself).
