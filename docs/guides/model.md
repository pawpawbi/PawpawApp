# Modelling data

Shaping tables with SQL: the two kinds of table, when they're rebuilt, the Model data screen, and
DuckDB SQL that comes up often.

## Two kinds of table

- **Loaded tables** come from data sources. Each can have one **in-place transform**: a SELECT
  query whose result replaces the table everywhere in the app (previews, other queries, datasets).
  It reads loaded tables' **original** data by name, so it can join other loaded tables, but never
  sees another transform's result: in-place transforms don't build on each other. Use them to fix
  a table: change types, rename or drop columns, filter rows, clean values.
- **Transformed tables** are new tables built by a SELECT query from any tables as currently shown
  (loaded tables with their transforms applied, and other transformed tables). Use them for joins,
  totals and anything built from several tables. Datasets can then read them.

Rules for both:

- Names are lowercase letters, digits and underscores, starting with a letter, and unique across
  both kinds. Tables can't be renamed.
- A query can't read itself, directly or through other tables (refused when saving).
- A table can't be deleted while another table's query or in-place transform reads it. Datasets
  aren't checked: one that reads a deleted table, or a column that's gone, fails at its next
  refresh. Check the report's datasets (`get_report`) before deleting or changing a table.
- A table you delete can be undone from the chat (one deleted with the Delete button can't). A
  deleted loaded table comes back the next time its source loads, unless it's unticked in the
  source's Edit screen.

## When tables are rebuilt

After every load (one source, or **Refresh all data**), the app:

1. re-applies every in-place transform;
2. rebuilds every transformed table in dependency order, each after the tables it reads;
3. refreshes the report's datasets.

Saving a transform or a transformed table rebuilds the tables built from it, and the datasets.
If a transformed table's query fails, its old data is removed and its error recorded, and tables
built from it fail too. A failing in-place transform keeps its previous result.

## The Model data screen

A canvas with a card for each table: loaded tables in orange, transformed tables in purple
("Transformed from …"), with arrows from each table to the tables built from it. Cards can be
dragged; **Fit** fits them all in view.

- A loaded table's card has **Transform** (**Transformed** when it has one) and **Delete**.
- A transformed table's card has **Edit SQL** and **Delete**.
- **New transformed table** and **Refresh all data** (load every source again and rebuild
  everything) are on the canvas.
- The SQL editor has **Run preview** (Ctrl+Enter). For an in-place transform: **Apply transform**
  and **Remove transform**. For a transformed table: its **Table name**, then **Create table**
  (or **Save changes**).

## With your tools

- `list_tables` shows every table's kind, rows, columns and types; `list_transforms` the existing
  SQL and any errors.
- `run_query` runs a SELECT and returns at most 50 rows. Test every query with it before saving.
- `set_transform` (table, sql) gives a loaded table an in-place transform or changes it;
  `remove_transform` (table) removes it.
- `save_table` (name, sql) creates a transformed table or changes its query.
- `delete_table` (table) deletes a table, as the Delete button does.

## SQL

Every query is **one read-only SELECT** in DuckDB SQL (`WITH` is fine). It can read only the
project's tables, by name: no files, no network, no other databases. Queries stop after 60
seconds.

- **Column names** from data sources are lowercase with underscores (`Order Date` becomes
  `order_date`). Check them with `list_tables`; quote unusual names with double quotes.
- **Types:** `CAST(x AS DATE)`; `TRY_CAST(x AS DOUBLE)` gives `NULL` instead of failing on bad
  values. Dates in other formats: `CAST(strptime(text_col, '%d/%m/%Y') AS DATE)`.
- **Dates:** `CAST(date_trunc('month', d) AS DATE)` for the month, `strftime(d, '%Y-%m')` for
  text, `d - INTERVAL 30 DAY`, `current_date`.
- **Text:** `trim`, `lower`, `upper`, `replace`, `regexp_replace(s, pattern, replacement, 'g')`,
  `a || ' ' || b`, `split_part(s, ',', 1)`.
- **Empty values:** `coalesce(x, 0)`, `nullif(x, '')`.
- **Columns:** `SELECT * EXCLUDE (internal_id)`; `SELECT * REPLACE (CAST(amount AS DOUBLE) AS
amount)` changes one column and keeps the rest.
- **Totals:** `GROUP BY ALL` groups by every column that isn't aggregated. `/` divides with
  decimals, `//` gives whole numbers.
- **Latest row per key:** `QUALIFY row_number() OVER (PARTITION BY customer_id ORDER BY
updated_at DESC) = 1`.
- **Joins:** check the join columns' types match, and look at row counts before and after
  (`run_query` with `count(*)`) to catch duplicated rows.
