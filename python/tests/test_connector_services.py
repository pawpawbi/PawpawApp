"""Connectors against live test services, end to end through runner.py as the app runs it:
discover, load, check the rows and column types that arrive, load again, try one optional
setting, and try a wrong password.

Opt in by pointing PAWPAW_SERVICES_SETTINGS at a JSON file that describes the services (it holds
addresses and throwaway passwords, so it's kept with the services, not here):

    {"cases": {
        "postgres": {
            "connector": "postgres",                      # defaults to the case name
            "settings": {"host": "...", "password": "..."},   # the form values
            "tables": {"customers": 8, "events": 50000},    # tables to load, with the rows expected
            "columns": {"customers": {"signed_up": "date"}},   # column kinds expected, optional
            "optional": {"settings": {"schema": "archive"}, "tables": {"old_orders": 3}}   # optional
        }}}

Each connector runs in its own environment, built as the app builds it (see
test_connector_smoke.py). A summary is written to python/.connector-envs-test/services-report.md.
"""

import json
import os
import re
import subprocess
import time
from pathlib import Path

import pytest

import connectors
import datasets
from conftest import PYTHON_FLAGS, SIDECAR
from test_connector_smoke import ENVS, PROGRAMMING_ERRORS, environment

pytestmark = pytest.mark.services

SETTINGS_FILE = os.environ.get("PAWPAW_SERVICES_SETTINGS", "")
CASES: dict[str, dict] = {}
if SETTINGS_FILE and SETTINGS_FILE != "0" and Path(SETTINGS_FILE).exists():
    # {settings_dir} in the file stands for its own folder, for settings that are paths (key files).
    _text = Path(SETTINGS_FILE).read_text(encoding="utf-8")
    CASES = json.loads(_text.replace("{settings_dir}", Path(SETTINGS_FILE).resolve().parent.as_posix()))["cases"]
CASE_IDS = list(CASES)
JOB_TIMEOUT = 900


def connector_of(case: dict, name: str):
    return connectors.get(case.get("connector", name))


def resources_of(case: dict) -> list[str]:
    """The resources to load: the expected tables, unless the case names them ("resources"),
    as for Kafka, which lists one resource and writes a table per topic."""
    return case.get("resources", [t for t in case["tables"] if "__" not in t])


def run_job(python: Path, job: dict, dlt_dir: Path) -> list[dict]:
    env = {**os.environ, "RUNTIME__DLTHUB_TELEMETRY": "false", "DLT_DATA_DIR": str(dlt_dir)}
    result = subprocess.run(
        [str(python), *PYTHON_FLAGS, str(SIDECAR / "runner.py")],
        input=(json.dumps(job) + "\n").encode("utf-8"),
        capture_output=True,
        env=env,
        timeout=JOB_TIMEOUT,
    )
    events = [json.loads(line) for line in result.stdout.decode("utf-8").splitlines() if line.strip()]
    assert events, f"runner.py wrote no events. stderr:\n{result.stderr.decode('utf-8', 'replace')[-3000:]}"
    return events


def result_of(events: list[dict]):
    last = events[-1]
    assert last["event"] == "result", f"{last.get('message')}\n{last.get('detail', '')[-3000:]}"
    return last["result"]


def load_job(connector_id: str, settings: dict, data_dir: Path, resources, pipeline: str) -> dict:
    return {
        "action": "load",
        "connector": connector_id,
        "settings": settings,
        "data_dir": str(data_dir),
        "pipeline_name": pipeline,
        "resources": list(resources),
        "reserved_tables": [],
    }


def on_disk(data_dir: Path) -> dict[str, dict]:
    return {t["name"]: t for t in datasets.describe_tables({"data_dir": str(data_dir)})}


def _short(message: str, limit: int = 160) -> str:
    message = " ".join(message.split())
    return message if len(message) <= limit else message[: limit - 1] + "…"


@pytest.fixture(scope="module")
def report():
    rows: dict[str, dict] = {}
    yield rows
    if not rows:
        return
    ENVS.mkdir(parents=True, exist_ok=True)
    lines = [
        "# Connector services test report",
        "",
        f"Run on {time.strftime('%Y-%m-%d %H:%M')} against {SETTINGS_FILE}.",
        "",
        "| Case | Discover | Load | Reload | Optional setting | Wrong password |",
        "|---|---|---|---|---|---|",
    ]
    for name in CASE_IDS:
        row = rows.get(name, {})
        cells = [str(row.get(c, "")).replace("|", "\\|") for c in ("discover", "load", "reload", "optional", "wrong")]
        lines.append(f"| `{name}` | " + " | ".join(cells) + " |")
    (ENVS / "services-report.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


@pytest.fixture(scope="module")
def work(tmp_path_factory):
    return tmp_path_factory.mktemp("services")


@pytest.mark.parametrize("name", CASE_IDS)
def test_discover_lists_the_expected_tables(name, report, work):
    case = CASES[name]
    connector = connector_of(case, name)
    python = environment(connector, {})
    started = time.monotonic()
    events = run_job(python, {"action": "discover", "connector": connector.id, "settings": case["settings"]}, work / "dlt")
    listed = {r["name"] for r in result_of(events)}
    report.setdefault(name, {})["discover"] = f"{len(listed)} tables in {time.monotonic() - started:.0f} s"
    missing = set(case.get("discover_lists", resources_of(case))) - listed
    assert not missing, f"{name}: discover didn't list {sorted(missing)}; it listed {sorted(listed)}"


@pytest.mark.parametrize("name", CASE_IDS)
def test_load_rows_types_and_reload(name, report, work):
    case = CASES[name]
    connector = connector_of(case, name)
    python = environment(connector, {})
    data_dir = work / name / "data"
    job = load_job(connector.id, case["settings"], data_dir, resources_of(case), f"services_{name}")
    row = report.setdefault(name, {})

    started = time.monotonic()
    loaded = {t["name"]: t["rows"] for t in result_of(run_job(python, job, work / "dlt"))["tables"]}
    seconds = time.monotonic() - started
    row["load"] = f"{sum(loaded.values())} rows in {seconds:.0f} s"
    for table, rows in case["tables"].items():
        assert loaded.get(table) == rows, f"{name}: {table} loaded {loaded.get(table)} rows, expected {rows}; got {loaded}"

    stored = on_disk(data_dir)
    for table, rows in case["tables"].items():
        assert stored[table]["rows"] == rows, f"{name}: {table} has {stored[table]['rows']} rows on disk"
    mismatches = []
    for table, columns in case.get("columns", {}).items():
        kinds = {c["name"]: c["kind"] for c in stored[table]["columns"]}
        for column, kind in columns.items():
            if kinds.get(column) != kind:
                mismatches.append(f"{table}.{column} is {kinds.get(column)}, expected {kind}")
    row["load"] += "; " + ("types ok" if not mismatches else "; ".join(mismatches))
    assert not mismatches, f"{name}: " + "; ".join(mismatches)

    # Loading again replaces, so nothing is duplicated.
    reloaded = {t["name"]: t["rows"] for t in result_of(run_job(python, job, work / "dlt"))["tables"]}
    stored_again = {t: d["rows"] for t, d in on_disk(data_dir).items()}
    row["reload"] = "same rows" if reloaded == loaded and all(stored_again[t] == r for t, r in case["tables"].items()) else f"CHANGED: {reloaded}"
    assert reloaded == loaded, f"{name}: a second load changed the counts: {loaded} -> {reloaded}"
    for table, rows in case["tables"].items():
        assert stored_again[table] == rows, f"{name}: {table} has {stored_again[table]} rows after reloading"


@pytest.mark.parametrize("name", CASE_IDS)
def test_optional_setting(name, report, work):
    case = CASES[name]
    optional = case.get("optional")
    if not optional:
        pytest.skip(f"{name}: no optional setting to try")
    connector = connector_of(case, name)
    python = environment(connector, {})
    data_dir = work / name / "optional"
    settings = {**case["settings"], **optional["settings"]}
    resources = optional.get("resources", case.get("resources", [t for t in optional["tables"] if "__" not in t]))
    job = load_job(connector.id, settings, data_dir, resources, f"services_{name}_optional")
    loaded = {t["name"]: t["rows"] for t in result_of(run_job(python, job, work / "dlt"))["tables"]}
    report.setdefault(name, {})["optional"] = f"{optional['settings']} -> {loaded}"
    for table, rows in optional["tables"].items():
        assert loaded.get(table) == rows, f"{name}: with {optional['settings']}, {table} loaded {loaded.get(table)} rows, expected {rows}"


@pytest.mark.parametrize("name", CASE_IDS)
def test_wrong_password_fails_cleanly(name, report, work):
    """T7 with a real server: the wrong secret must give a sign-in message, never a traceback."""
    case = CASES[name]
    connector = connector_of(case, name)
    secrets = [f.key for f in connector.fields if f.secret and case["settings"].get(f.key)]
    if not secrets:
        pytest.skip(f"{name}: no secret to get wrong")
    python = environment(connector, {})
    wrong = "definitely-wrong-password"
    settings = {**case["settings"], **{key: wrong for key in secrets}}
    if connector.id == "mongodb":  # the password is inside the connection string
        settings["connection_url"] = re.sub(r"://([^:]+):[^@]+@", rf"://\1:{wrong}@", case["settings"]["connection_url"])
    events = run_job(python, {"action": "discover", "connector": connector.id, "settings": settings}, work / "dlt")
    last = events[-1]
    if last["event"] == "result":
        # Sources that only connect when loading (the file connectors) need a load to notice.
        job = load_job(connector.id, settings, work / name / "wrong", resources_of(case), f"services_{name}_wrong")
        last = run_job(python, job, work / "dlt")[-1]
    row = report.setdefault(name, {})
    if last["event"] == "result":
        row["wrong"] = "ACCEPTED a wrong password"
        pytest.fail(f"{name} connected with a wrong password")
    row["wrong"] = _short(last["message"])
    assert not PROGRAMMING_ERRORS.match(last["message"]), last["message"]
    assert wrong not in last["message"], f"{name} echoes the password in its error message"
    assert wrong not in last.get("detail", ""), f"{name} echoes the password in its traceback"
