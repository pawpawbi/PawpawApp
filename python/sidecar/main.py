"""PawpawBI Python sidecar.

Started by the Electron main process (src/python.ts). Reads one JSON request per line on
stdin, {"id": 1, "method": "info", "params": {...}}, and writes one JSON response per line
on stdout, {"id": 1, "result": ...} or {"id": 1, "error": "..."}.

stdout is reserved for responses: log with print(..., file=sys.stderr) instead.
"""

import json
import platform
import sys
from importlib.metadata import version

import connectors
import datasets
import report_data
import transforms


def info(_params):
    return {
        "version": platform.python_version(),
        "executable": sys.executable,
        "dlt": version("dlt"),
        "duckdb": version("duckdb"),
    }


METHODS = {
    "info": info,
    "catalog": connectors.catalog,
    "list_tables": datasets.list_tables,
    "describe_tables": datasets.describe_tables,
    "preview_transform": transforms.preview_transform,
    "query_tables": transforms.query_tables,
    "build_table": transforms.build_table,
    "clear_table": transforms.clear_table,
    "apply_transform": transforms.apply_transform,
    "remove_transform": transforms.remove_transform,
    "delete_table": transforms.delete_table,
    "preview_table": datasets.preview_table,
    "write_dataset": report_data.write_dataset,
}


def handle(request):
    method = METHODS.get(request.get("method"))
    if method is None:
        raise ValueError(f"Unknown method: {request.get('method')}")
    return method(request.get("params") or {})


def main():
    for line in sys.stdin:
        line = line.lstrip("﻿")  # tolerate a UTF-8 byte-order mark
        if not line.strip():
            continue
        request_id = None
        try:
            request = json.loads(line)
            request_id = request.get("id")
            response = {"id": request_id, "result": handle(request)}
        except Exception as exc:
            response = {"id": request_id, "error": f"{type(exc).__name__}: {exc}"}
        sys.stdout.write(json.dumps(response) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
