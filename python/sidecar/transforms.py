"""SQL transforms. Two kinds, both a single SELECT query run in the locked-down DuckDB from
engine.py:

- In-place transforms change how a loaded table looks. The query reads loaded tables' original
  data and its result is written to <data_dir>/model/<table>/, used in place of the original.
- Transformed tables are new tables built from any other tables, loaded or transformed, as the
  app currently shows them. The result is written to <data_dir>/transformed/<table>/.

The main process (src/data.ts) decides what to build and in which order, using the tables each
query reads (query_tables) to avoid circular references.
"""

import shutil
from pathlib import Path

import pyarrow.parquet as pq

import engine

BATCH_ROWS = 100_000


def _layer(params) -> engine.Layer:
    """In-place transforms read original data; transformed tables read the current tables."""
    return "current" if params.get("kind") == "transformed" else "raw"


def preview_transform(params):
    """Run a query and return its first rows, without saving anything."""
    query = engine.select(params["sql"])
    con = engine.connect(Path(params["data_dir"]), layer=_layer(params))
    try:
        return engine.preview(con, query, int(params.get("limit", 200)))
    finally:
        con.close()


def query_tables(params) -> list[str]:
    """The tables a query reads (including in subqueries; CTE names aren't tables).

    DuckDB checks it's a single SELECT. The table names come from sqlglot's parser (bundled with
    dlt), because DuckDB's get_table_names resolves views to the files behind them, and without
    the views it can't bind queries such as JOIN ... USING.
    """
    import sqlglot
    from sqlglot import exp

    query = engine.select(params["sql"])
    try:
        tree = sqlglot.parse_one(query, dialect="duckdb")
    except sqlglot.errors.ParseError as exc:
        raise ValueError(f"Couldn't read the query: {exc}") from None
    ctes = {cte.alias_or_name for cte in tree.find_all(exp.CTE)}
    return sorted({t.name for t in tree.find_all(exp.Table) if t.name and t.name not in ctes})


def _write_result(data_dir: Path, sql: str, layer: engine.Layer, dataset: str, table: str) -> int:
    """Run a query and save its result as <data_dir>/<dataset>/<table>/data.parquet, swapping
    in the new result only once it's complete. Returns the row count."""
    target = engine.table_dir(data_dir, dataset, table)
    target_root = target.parent
    target_root.mkdir(parents=True, exist_ok=True)
    staging = target_root / f".{table}.tmp"
    shutil.rmtree(staging, ignore_errors=True)
    staging.mkdir()

    query = engine.select(sql)
    con = engine.connect(data_dir, layer=layer)
    try:
        with engine.time_limit(con):
            reader = con.sql(query).to_arrow_reader(BATCH_ROWS)
            rows = 0
            with pq.ParquetWriter(staging / "data.parquet", reader.schema) as writer:
                for batch in reader:
                    writer.write_batch(batch)
                    rows += batch.num_rows
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    finally:
        con.close()

    shutil.rmtree(target, ignore_errors=True)
    staging.rename(target)
    return rows


def apply_transform(params):
    """Apply a loaded table's in-place transform."""
    data_dir = Path(params["data_dir"])
    table = params["table"]
    if table not in engine.table_names(data_dir):
        raise ValueError(f'No table called "{table}".')
    return {"rows": _write_result(data_dir, params["sql"], "raw", engine.MODEL_DATASET, table)}


def remove_transform(params):
    """Remove a loaded table's in-place transform result, so it shows its original data."""
    shutil.rmtree(engine.table_dir(Path(params["data_dir"]), engine.MODEL_DATASET, params["table"]), ignore_errors=True)


def build_table(params):
    """Build (or rebuild) a transformed table from its query."""
    data_dir = Path(params["data_dir"])
    table = params["table"]
    if table in engine.table_names(data_dir):
        raise ValueError(f"There's already a loaded table called {table}.")
    return {"rows": _write_result(data_dir, params["sql"], "current", engine.TRANSFORMED_DATASET, table)}


def clear_table(params):
    """Remove a transformed table's built data (its definition is kept by the main process)."""
    shutil.rmtree(engine.table_dir(Path(params["data_dir"]), engine.TRANSFORMED_DATASET, params["table"]), ignore_errors=True)


def delete_table(params):
    """Delete a table's data: a loaded table's original and in-place result, or a transformed
    table's built data."""
    data_dir = Path(params["data_dir"])
    table = params["table"]
    if table not in engine.table_names(data_dir) and table not in engine.transformed_table_names(data_dir):
        raise ValueError(f'No table called "{table}".')
    for dataset in (engine.RAW_DATASET, engine.MODEL_DATASET, engine.TRANSFORMED_DATASET):
        shutil.rmtree(engine.table_dir(data_dir, dataset, table), ignore_errors=True)
