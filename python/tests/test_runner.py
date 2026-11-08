"""Connector jobs, run through python/sidecar/runner.py in the bundled runtime as the app does.
Each job starts a fresh Python process, so these are the slowest tests."""

import json
import os
import subprocess

import pytest

import datasets
from conftest import PYTHON_FLAGS, RUNTIME_PYTHON, SIDECAR, error_of, result_of


def load_job(connector: str, settings: dict, data_dir, resources=(), reserved=(), pipeline="pawpaw_test"):
    return {
        "action": "load",
        "connector": connector,
        "settings": settings,
        "data_dir": str(data_dir),
        "pipeline_name": pipeline,
        "resources": list(resources),
        "reserved_tables": list(reserved),
    }


def on_disk(data_dir) -> dict:
    """table -> rows actually stored in the project's data folder."""
    return {t["name"]: t["rows"] for t in datasets.describe_tables({"data_dir": str(data_dir)})}


def test_local_files_discover_csv_and_excel_sheets(run_job, sales_csv, budget_xlsx):
    events = run_job(
        {"action": "discover", "connector": "local_files", "settings": {"files": [str(sales_csv), str(budget_xlsx)]}}
    )
    assert events[0] == {"event": "progress", "message": "Connecting…"}
    assert result_of(events) == [
        {"name": "Monthly Sales", "selected": True},
        {"name": "Budget Targets", "selected": True},
        {"name": "Budget Staff", "selected": True},
    ]


def test_local_files_load_csv_and_excel_sheets(run_job, project_data_dir, sales_csv, budget_xlsx):
    events = run_job(load_job("local_files", {"files": [str(sales_csv), str(budget_xlsx)]}, project_data_dir))
    assert result_of(events) == {
        "tables": [
            {"name": "budget_staff", "rows": 3},
            {"name": "budget_targets", "rows": 2},
            {"name": "monthly_sales", "rows": 4},
        ]
    }
    progress = [e["message"] for e in events if e["event"] == "progress"]
    assert progress == ["Connecting…", "Downloading data…", "Preparing tables…", "Saving to the project…"]
    # Once the data has arrived, the app stops offering Stop.
    received = [e.get("received", False) for e in events if e["event"] == "progress"]
    assert received == [False, False, True, True]
    assert on_disk(project_data_dir) == {"budget_staff": 3, "budget_targets": 2, "monthly_sales": 4}
    assert list((project_data_dir / "raw" / "monthly_sales").glob("*.parquet"))

    preview = datasets.preview_table({"data_dir": str(project_data_dir), "table": "budget_targets"})
    assert preview["rows"] == [["North", 5000], ["South", 4000]]


def test_local_files_csv_gets_proper_column_types(run_job, project_data_dir, sales_csv):
    """DuckDB reads CSV, so dates and numbers aren't left as text."""
    result_of(run_job(load_job("local_files", {"files": [str(sales_csv)]}, project_data_dir)))
    sales = {t["name"]: t for t in datasets.describe_tables({"data_dir": str(project_data_dir)})}["monthly_sales"]
    assert {c["name"]: c["kind"] for c in sales["columns"]} == {
        "order_id": "integer",
        "order_date": "date",
        "region": "text",
        "revenue": "decimal",
    }
    preview = datasets.preview_table({"data_dir": str(project_data_dir), "table": "monthly_sales"})
    assert preview["rows"][0] == [1001, "2026-07-03", "North", 1250.5]
    assert preview["rows"][3][3] is None  # the empty revenue cell


def test_local_files_load_json_variants(run_job, project_data_dir, json_array, json_wrapper, json_lines, json_nested):
    files = [str(p) for p in (json_array, json_wrapper, json_lines, json_nested)]
    tables = {t["name"]: t["rows"] for t in result_of(run_job(load_job("local_files", {"files": files}, project_data_dir)))["tables"]}
    assert tables == {"people": 3, "wrapped": 3, "events": 3, "orders": 2, "orders__items": 3}

    orders = {t["name"]: t for t in datasets.describe_tables({"data_dir": str(project_data_dir)})}["orders"]
    assert {"customer__name", "customer__city"} <= {c["name"] for c in orders["columns"]}


def test_local_files_selected_resources_only(run_job, project_data_dir, budget_xlsx):
    events = run_job(load_job("local_files", {"files": [str(budget_xlsx)]}, project_data_dir, resources=["Budget Staff"]))
    assert result_of(events) == {"tables": [{"name": "budget_staff", "rows": 3}]}


def test_sqlite_discover(run_job, sqlite_db):
    events = run_job({"action": "discover", "connector": "sqlite", "settings": {"file": str(sqlite_db)}})
    assert sorted(r["name"] for r in result_of(events)) == ["customers", "products"]


def test_sqlite_reload_replaces_rather_than_duplicates(run_job, project_data_dir, sqlite_db):
    job = load_job("sqlite", {"file": str(sqlite_db)}, project_data_dir, resources=["customers"], reserved=["monthly_sales"])
    assert result_of(run_job(job)) == {"tables": [{"name": "customers", "rows": 3}]}
    assert on_disk(project_data_dir) == {"customers": 3}

    assert result_of(run_job(job)) == {"tables": [{"name": "customers", "rows": 3}]}
    assert on_disk(project_data_dir) == {"customers": 3}


def test_folder_combines_files_into_one_table(run_job, project_data_dir, csv_folder):
    settings = {"folder": str(csv_folder), "format": "csv", "table": "all_sales"}
    assert result_of(run_job(load_job("folder", settings, project_data_dir))) == {"tables": [{"name": "all_sales", "rows": 4}]}
    assert on_disk(project_data_dir) == {"all_sales": 4}


def test_table_name_clash_with_another_source_is_rejected(run_job, project_data_dir, sqlite_db):
    job = load_job("sqlite", {"file": str(sqlite_db)}, project_data_dir, resources=["customers"], reserved=["customers"])
    assert error_of(run_job(job)) == (
        "Another data source already has a table called customers. Remove or rename that source first."
    )
    assert not (project_data_dir / "raw" / "customers").exists()


def test_clash_check_uses_normalised_table_names(run_job, project_data_dir, sales_csv):
    """"Monthly Sales" becomes the table monthly_sales, so it clashes with that name."""
    job = load_job("local_files", {"files": [str(sales_csv)]}, project_data_dir, reserved=["monthly_sales"])
    assert "already has a table called Monthly Sales" in error_of(run_job(job))


def test_missing_file_gives_friendly_error(run_job, tmp_path):
    missing = tmp_path / "nope.csv"
    events = run_job({"action": "discover", "connector": "local_files", "settings": {"files": [str(missing)]}})
    assert error_of(events) == f"File not found: {missing}"
    assert "Traceback" in events[-1]["detail"]


def test_no_files_chosen(run_job):
    assert error_of(run_job({"action": "discover", "connector": "local_files", "settings": {"files": []}})) == (
        "Choose at least one file."
    )


def test_resource_no_longer_available(run_job, tmp_path, sqlite_db):
    job = load_job("sqlite", {"file": str(sqlite_db)}, tmp_path / "data", resources=["customers", "gone"])
    assert error_of(run_job(job)) == "These tables are no longer available: gone"


def test_unknown_connector(run_job):
    assert error_of(run_job({"action": "discover", "connector": "nope", "settings": {}})) == "Unknown connector: nope"


def test_bom_prefixed_job_line_is_accepted(run_job, sales_csv):
    job = json.dumps({"action": "discover", "connector": "local_files", "settings": {"files": [str(sales_csv)]}})
    assert result_of(run_job("﻿" + job)) == [{"name": "Monthly Sales", "selected": True}]


def test_invalid_job_line(run_job):
    # JSONDecodeError is a ValueError, so it's shown without the class name.
    assert error_of(run_job("not json")) == "Expecting value: line 1 column 1 (char 0)"


def test_sidecar_rpc_after_load(run_job, tmp_path, project_data_dir, budget_xlsx):
    """The main sidecar (main.py) reads what runner.py loaded, over its JSON-lines protocol."""
    result_of(run_job(load_job("local_files", {"files": [str(budget_xlsx)]}, project_data_dir)))
    requests = [
        {"id": 1, "method": "list_tables", "params": {"data_dir": str(project_data_dir)}},
        {"id": 2, "method": "preview_table", "params": {"data_dir": str(project_data_dir), "table": "budget_targets", "limit": 5}},
        {"id": 3, "method": "nope"},
        {"id": 4, "method": "catalog"},
    ]
    proc = subprocess.run(
        [str(RUNTIME_PYTHON), *PYTHON_FLAGS, str(SIDECAR / "main.py")],
        input=("﻿" + "".join(json.dumps(r) + "\n" for r in requests)).encode("utf-8"),
        capture_output=True,
        env={**os.environ, "RUNTIME__DLTHUB_TELEMETRY": "false", "DLT_DATA_DIR": str(tmp_path / "dlt-state")},
        timeout=120,
    )
    responses = [json.loads(line) for line in proc.stdout.decode("utf-8").splitlines()]
    assert [r["id"] for r in responses] == [1, 2, 3, 4]
    assert responses[0]["result"] == ["budget_staff", "budget_targets"]
    assert responses[1]["result"]["rows"] == [["North", 5000], ["South", 4000]]
    assert responses[2]["error"] == "ValueError: Unknown method: nope"
    assert any(c["id"] == "local_files" for c in responses[3]["result"]["connectors"])


@pytest.mark.network
def test_url_loads_json_api(run_job, project_data_dir):
    settings = {"url": "https://jsonplaceholder.typicode.com/comments"}
    assert result_of(run_job(load_job("url", settings, project_data_dir))) == {"tables": [{"name": "comments", "rows": 500}]}
