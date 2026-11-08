"""The project's query engine: DuckDB, used only to query the project's Parquet files.

Nothing is stored in DuckDB. Each request opens a fresh in-memory DuckDB with one view per
loaded table, locked so it can read only the project's data folder: no other files, no network,
no extensions, no changing settings. Projects can come from other people, so queries (which may
come from a project's SQL transforms) must never reach anything else on the computer.

Everything that reads loaded data goes through here: table info, previews, transforms, and
later relationships and visuals.

Tables on disk (see docs/pawpaw-file-format.md). There are two kinds:
    Loaded tables, from data loads:
        <data_dir>/raw/<table>/*.parquet              as loaded by dlt
        <data_dir>/model/<table>/data.parquet         its in-place SQL transform's result, if any
    Transformed tables, each built by a SQL query from other tables:
        <data_dir>/transformed/<table>/data.parquet
"""

from __future__ import annotations

import contextlib
import datetime as dt
import decimal
import math
import re
import threading
import uuid
from pathlib import Path
from typing import Literal

import duckdb
import pyarrow.parquet as pq

RAW_DATASET = "raw"
MODEL_DATASET = "model"
TRANSFORMED_DATASET = "transformed"

# A query that runs longer than this is stopped, so one slow query (e.g. one the assistant
# wrote) can't tie up the sidecar, which handles requests one at a time.
TIME_LIMIT_SECONDS = 60

# Table names become folder names, so only plain names are ever used in a path.
TABLE_NAME = re.compile(r"^[A-Za-z0-9_]+$")

# "current": every table as the app shows it: loaded tables (their in-place transform's result
#   if they have one) and transformed tables. Previews, table info and transformed tables use this.
# "raw": loaded tables' original data only. In-place transforms use this.
Layer = Literal["current", "raw"]

INTEGER_TYPES = {
    "TINYINT", "SMALLINT", "INTEGER", "BIGINT", "HUGEINT",
    "UTINYINT", "USMALLINT", "UINTEGER", "UBIGINT", "UHUGEINT",
}


def quote(name: str) -> str:
    """A SQL identifier."""
    return '"' + name.replace('"', '""') + '"'


def literal(text: str) -> str:
    """A SQL string literal."""
    return "'" + text.replace("'", "''") + "'"


def table_dir(data_dir: Path, dataset: str, table: str) -> Path:
    """<data_dir>/<dataset>/<table>, refusing any table name that isn't a plain name."""
    if not isinstance(table, str) or not TABLE_NAME.match(table):
        raise ValueError(f"Invalid table name: {table!r}")
    return data_dir / dataset / table


@contextlib.contextmanager
def time_limit(con: duckdb.DuckDBPyConnection, seconds: float | None = None):
    """Stops the queries run inside the block if they take longer than `seconds`
    (TIME_LIMIT_SECONDS by default)."""
    seconds = TIME_LIMIT_SECONDS if seconds is None else seconds
    timer = threading.Timer(seconds, con.interrupt)
    timer.start()
    try:
        yield
    except Exception:
        if not timer.is_alive():
            raise TimeoutError(f"The query took longer than {seconds:g} seconds, so it was stopped.") from None
        raise
    finally:
        timer.cancel()


def _folder_names(folder: Path) -> list[str]:
    if not folder.is_dir():
        return []
    # Leave out dlt's bookkeeping tables and our own staging folders (".name.tmp").
    return sorted(p.name for p in folder.iterdir() if p.is_dir() and not p.name.startswith(("_dlt", ".")))


def table_names(data_dir: Path) -> list[str]:
    """Every loaded table."""
    return _folder_names(data_dir / RAW_DATASET)


def transformed_table_names(data_dir: Path) -> list[str]:
    """Every transformed table that has been built."""
    return _folder_names(data_dir / TRANSFORMED_DATASET)


def is_transformed(data_dir: Path, table: str) -> bool:
    """Whether a loaded table has an in-place transform applied."""
    return (data_dir / MODEL_DATASET / table).is_dir()


def table_folders(data_dir: Path, layer: Layer = "current") -> dict[str, Path]:
    """Table name -> the folder of Parquet files to read for it, for tables that have data.
    Folders are resolved paths, so they're under the folder connect() allows."""
    data_dir = data_dir.resolve()
    candidates = {}
    for table in table_names(data_dir):
        folder = data_dir / RAW_DATASET / table
        if layer == "current" and is_transformed(data_dir, table):
            folder = data_dir / MODEL_DATASET / table
        candidates[table] = folder
    if layer == "current":
        for table in transformed_table_names(data_dir):
            candidates.setdefault(table, data_dir / TRANSFORMED_DATASET / table)
    return {t: f for t, f in candidates.items() if next(f.glob("*.parquet"), None) is not None}


def connect(
    data_dir: Path, layer: Layer = "current", folders: dict[str, Path] | None = None
) -> duckdb.DuckDBPyConnection:
    """An in-memory DuckDB with one view per table, locked to the project's data folder.
    `folders` is table_folders(data_dir, layer), for callers that already have it."""
    data_dir = data_dir.resolve()
    if folders is None:
        folders = table_folders(data_dir, layer)
    con = duckdb.connect(":memory:")
    try:
        for table, folder in folders.items():
            # Leave out dlt's own bookkeeping columns.
            first_file = next(folder.glob("*.parquet"))
            columns = [f.name for f in pq.read_schema(first_file) if not f.name.startswith("_dlt")]
            pattern = (folder / "*.parquet").as_posix()
            con.execute(
                f"CREATE VIEW {quote(table)} AS "
                f"SELECT {', '.join(map(quote, columns))} "
                f"FROM read_parquet({literal(pattern)}, union_by_name = true)"
            )
        # The views must exist before locking. DuckDB quietly adds its temp directory
        # (<working dir>/.tmp) to the allowed directories, which would let a query read files
        # there, so turn it off; the cost is that queries can't spill to disk.
        con.execute("SET temp_directory = ''")
        con.execute(f"SET allowed_directories = [{literal(data_dir.as_posix())}]")
        con.execute("SET enable_external_access = false")
        con.execute("SET autoinstall_known_extensions = false")
        con.execute("SET autoload_known_extensions = false")
        con.execute("SET lock_configuration = true")
    except Exception:
        con.close()
        raise
    return con


def select(sql: str) -> str:
    """The query, checked to be exactly one read-only SELECT statement. This only parses (on
    DuckDB's default connection); the query then runs on a locked connection from connect()."""
    statements = duckdb.extract_statements(sql)
    if len(statements) != 1:
        raise ValueError("Enter one SELECT query." if not statements else "Enter just one query.")
    if statements[0].type != duckdb.StatementType.SELECT:
        raise ValueError("Only SELECT queries are allowed: a query reads data, it can't change it.")
    return statements[0].query.strip().rstrip(";")


def column_kind(type_name: str) -> str:
    """A broad kind for a DuckDB column type, for display."""
    t = type_name.upper()
    if t.endswith("]") or t.startswith(("STRUCT", "MAP", "UNION", "JSON")):
        return "nested"
    if t == "BOOLEAN":
        return "boolean"
    if t in INTEGER_TYPES:
        return "integer"
    if t in ("FLOAT", "DOUBLE") or t.startswith("DECIMAL"):
        return "decimal"
    if t.startswith("TIMESTAMP"):
        return "datetime"
    if t == "DATE":
        return "date"
    if t.startswith("TIME"):
        return "time"
    if t in ("VARCHAR", "UUID"):
        return "text"
    return "other"


def json_value(value):
    """A value from DuckDB as something JSON can carry."""
    if value is None or isinstance(value, (bool, int, str)):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, decimal.Decimal):
        return float(value) if value.is_finite() else None
    if isinstance(value, (dt.datetime, dt.date, dt.time)):
        return value.isoformat()
    if isinstance(value, dt.timedelta):
        return str(value)
    if isinstance(value, (bytes, bytearray, memoryview)):
        return f"<{len(value)} bytes>"
    if isinstance(value, uuid.UUID):
        return str(value)
    if isinstance(value, dict):
        return {str(k): json_value(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_value(v) for v in value]
    return str(value)


def columns(relation: duckdb.DuckDBPyRelation, kinds: bool = False) -> list[dict]:
    """A relation's columns as [{name, type: DuckDB type}], plus each column's broad `kind`
    when asked (see TablePreview and TableSchema in src/shared/types.ts)."""
    result = []
    for name, type_ in zip(relation.columns, relation.types):
        column = {"name": name, "type": str(type_)}
        if kinds:
            column["kind"] = column_kind(str(type_))
        result.append(column)
    return result


def fetch(con: duckdb.DuckDBPyConnection, query: str, limit: int) -> tuple[duckdb.DuckDBPyRelation, list, bool]:
    """Run a query under the time limit: its relation (for the columns), its first `limit` rows,
    and whether there were more."""
    with time_limit(con):
        relation = con.sql(query)
        rows = relation.fetchmany(limit + 1)
    return relation, rows[:limit], len(rows) > limit


def preview(con: duckdb.DuckDBPyConnection, query: str, limit: int) -> dict:
    """A query's columns, its first `limit` rows and its total row count."""
    relation, rows, truncated = fetch(con, query, limit)
    row_count = len(rows)
    if truncated:
        with time_limit(con):
            row_count = con.sql(f"SELECT count(*) FROM ({query})").fetchone()[0]
    return {
        "columns": columns(relation),
        "rows": [[json_value(v) for v in row] for row in rows],
        "row_count": row_count,
    }
