"""Reading loaded tables: their names, columns and rows. Queries run through engine.py (DuckDB).

A table with a SQL transform is read from its transformed copy (see transforms.py).
"""

from pathlib import Path

import engine


def list_tables(params):
    return engine.table_names(Path(params["data_dir"]))


def describe_tables(params):
    """Every table's kind, columns (dlt's _dlt_* columns left out) and row count. "transformed"
    is True for a loaded table with an in-place transform applied."""
    data_dir = Path(params["data_dir"])
    folders = engine.table_folders(data_dir)
    if not folders:
        return []
    loaded = set(engine.table_names(data_dir))
    con = engine.connect(data_dir, folders=folders)
    try:
        tables = []
        for name in folders:
            relation = con.sql(f"SELECT * FROM {engine.quote(name)}")
            # count(*) over Parquet comes from file metadata, so it's quick.
            rows = con.sql(f"SELECT count(*) FROM {engine.quote(name)}").fetchone()[0]
            tables.append(
                {
                    "name": name,
                    "kind": "loaded" if name in loaded else "transformed",
                    "rows": rows,
                    "columns": engine.columns(relation, kinds=True),
                    "transformed": engine.is_transformed(data_dir, name),
                }
            )
        return tables
    finally:
        con.close()


def preview_table(params):
    """A table's columns, first rows and total row count, reading only the rows shown."""
    data_dir = Path(params["data_dir"])
    table = params["table"]
    folders = engine.table_folders(data_dir)
    if table not in folders:
        raise ValueError(f'No table called "{table}".')
    con = engine.connect(data_dir, folders=folders)
    try:
        return engine.preview(con, f"SELECT * FROM {engine.quote(table)}", int(params.get("limit", 50)))
    finally:
        con.close()
