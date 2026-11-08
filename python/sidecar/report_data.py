"""Report datasets: the data a report publishes (see docs/guides/report.md).

A dataset is a named SELECT query over every table as the app shows it. Its result is written
as JSON into the report folder (report/data/<name>.json), so the report is a static site that
works without PawpawBI, e.g. hosted on S3. Only what the query returns is published, so
datasets should aggregate.

The query runs in the locked-down DuckDB from engine.py like every other query. Results are
capped in rows and size. Like every query, one that runs too long is stopped.
"""

import datetime as dt
import json
import os
from pathlib import Path

import engine

MAX_ROWS = 50_000
MAX_BYTES = 10 * 1024 * 1024


def write_dataset(params):
    """Run a dataset's query and write its result to `path` (chosen and checked by the main
    process). The file is replaced only once the new one is complete."""
    name = params["name"]
    path = Path(params["path"])
    query = engine.select(params["sql"])
    con = engine.connect(Path(params["data_dir"]))
    try:
        relation, rows, truncated = engine.fetch(con, query, MAX_ROWS)
        columns = engine.columns(relation)
    finally:
        con.close()

    document = {
        "name": name,
        "generatedAt": dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "columns": columns,
        "rows": [[engine.json_value(v) for v in row] for row in rows],
        "truncated": truncated,
    }
    text = json.dumps(document, ensure_ascii=False, separators=(",", ":"))
    size = len(text.encode("utf-8"))
    if size > MAX_BYTES:
        raise ValueError(
            f"The result is {size / 1024 / 1024:.1f} MB, over the {MAX_BYTES // 1024 // 1024} MB limit for a dataset. "
            "Group or filter the data in the query so it returns less."
        )
    path.parent.mkdir(parents=True, exist_ok=True)
    staging = path.with_name(f".{path.name}.tmp")
    staging.write_text(text, encoding="utf-8")
    os.replace(staging, path)
    return {"rows": len(document["rows"]), "truncated": truncated, "bytes": size}
