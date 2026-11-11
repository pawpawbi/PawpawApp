"""Runs one connector job in its own process. Started by src/connectors.ts, using the connector's
own Python environment when it needs extra packages.

Reads one job from stdin as a single line of JSON:
    {"action": "discover" | "load", "connector": "postgres", "settings": {...},
     "data_dir": "...", "pipeline_name": "...", "resources": [...], "reserved_tables": [...]}

Writes events to stdout, one JSON object per line:
    {"event": "progress", "message": "Loading data…"}
    {"event": "result", "result": ...}
    {"event": "error", "message": "...", "detail": "<traceback>"}
"""

import json
import re
import sys
import traceback
from pathlib import Path

# Where events go: stdout, which main() keeps for them alone (libraries' prints go to stderr).
_events = sys.stdout


def emit(event: str, **data):
    _events.write(json.dumps({"event": event, **data}, default=str) + "\n")
    _events.flush()


def progress(message: str, received: bool = False):
    """A step of the job. `received`: the data has all arrived and is being written, so the job
    shouldn't be stopped any more (that could leave tables half-written)."""
    emit("progress", message=message, **({"received": True} if received else {}))


def _resources(built) -> dict:
    """name -> resource, for whatever a connector's build() returned."""
    from dlt.extract.resource import DltResource
    from dlt.extract.source import DltSource

    if isinstance(built, DltSource):
        return dict(built.resources)
    if isinstance(built, DltResource):
        return {built.name: built}
    return {resource.name: resource for resource in built}


def discover(job: dict, connector) -> list[dict]:
    progress("Connecting…")
    resources = _resources(connector.build(job["settings"]))
    return [{"name": name, "selected": resource.selected} for name, resource in resources.items()]


def load(job: dict, connector) -> dict:
    import dlt
    from dlt.common.normalizers.naming.snake_case import NamingConvention
    from dlt.extract.source import DltSource

    progress("Connecting…")
    built = connector.build(job["settings"])
    resources = _resources(built)
    wanted = job.get("resources") or [name for name, r in resources.items() if r.selected]
    if missing := [name for name in wanted if name not in resources]:
        raise ValueError(f"These tables are no longer available: {', '.join(missing)}")

    naming = NamingConvention()
    reserved = set(job.get("reserved_tables") or [])
    if clashes := [name for name in wanted if naming.normalize_table_identifier(name) in reserved]:
        raise ValueError(
            f"Another data source already has a table called {', '.join(clashes)}. "
            "Remove or rename that source first."
        )

    data = built.with_resources(*wanted) if isinstance(built, DltSource) else [resources[n] for n in wanted]
    pipeline = dlt.pipeline(
        pipeline_name=job["pipeline_name"],
        destination=dlt.destinations.filesystem(bucket_url=Path(job["data_dir"]).resolve().as_uri()),
        dataset_name="raw",
    )

    # Always a full reload: replace the tables and reset any incremental state.
    progress("Downloading data…")
    pipeline.extract(data, write_disposition="replace", refresh="drop_resources", loader_file_format="parquet")
    progress("Preparing tables…", received=True)
    pipeline.normalize()
    progress("Saving to the project…", received=True)
    pipeline.load()

    row_counts = pipeline.last_trace.last_normalize_info.row_counts
    tables = [
        {"name": table, "rows": rows}
        for table, rows in sorted(row_counts.items())
        if not table.startswith("_dlt")
    ]
    return {"tables": tables}


def _friendly_message(exc: BaseException) -> str:
    """The innermost error's message: dlt wraps failures in several layers."""
    while True:
        inner = getattr(exc, "exception", None) or exc.__cause__
        if not isinstance(inner, BaseException) or inner is exc:
            break
        exc = inner
    message = str(exc).strip() or type(exc).__name__
    return message if isinstance(exc, ValueError) else f"{type(exc).__name__}: {message}"


def redact(text: str, secrets: list[str]) -> str:
    """`text` with the job's secret values, web addresses' query strings and user:password@
    parts blanked out. Error text is shown, kept with a published report's refresh status and
    sent to the assistant's model, so a password, key or token (which a library's error can
    quote, address and all) must never be in it."""
    for secret in sorted((s for s in secrets if len(s) >= 4), key=len, reverse=True):
        text = text.replace(secret, "•••")
    text = re.sub(r"(\w+://)[^/\s@]+@", r"\1•••@", text)
    return re.sub(r"\?[^\s'\")\]]*=[^\s'\")\]]*", "?•••", text)


def _secrets(job: dict | None, connector) -> list[str]:
    """The job's secret settings' values: the connector's secret fields, or (an unknown
    connector) every text setting."""
    settings = (job or {}).get("settings") or {}
    if not isinstance(settings, dict):
        return []
    keys = {f.key for f in connector.fields if f.secret} if connector else set(settings)
    return [v for k, v in settings.items() if k in keys and isinstance(v, str)]


def main():
    global _events
    # stdout carries events only; anything libraries print goes to stderr instead.
    _events = sys.stdout
    sys.stdout = sys.stderr
    job = connector = None
    try:
        job = json.loads(sys.stdin.readline().lstrip("﻿"))  # tolerate a UTF-8 byte-order mark
        import connectors

        connector = connectors.get(job["connector"])
        actions = {"discover": discover, "load": load}
        emit("result", result=actions[job["action"]](job, connector))
    except Exception as exc:
        secrets = _secrets(job, connector)
        emit(
            "error",
            message=redact(_friendly_message(exc), secrets),
            detail=redact(traceback.format_exc(), secrets),
        )
        sys.exit(1)


if __name__ == "__main__":
    main()
