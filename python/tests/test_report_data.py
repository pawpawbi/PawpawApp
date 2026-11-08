"""Report datasets (python/sidecar/report_data.py): query results written as JSON for the
report. Dataset queries come from project files, so they get the same sandbox checks as
transforms."""

import json
from pathlib import Path

import pytest

import engine
import report_data
import transforms
from conftest import ESCAPE_PARAMS, SLOW, escape_query


def write(data_dir: Path, sql: str) -> dict:
    out = data_dir.parent / "report" / "data" / "sales.json"
    result = report_data.write_dataset({"data_dir": str(data_dir), "name": "sales", "sql": sql, "path": str(out)})
    return {**result, "file": json.loads(out.read_text(encoding="utf-8")) if out.exists() else None}


def test_writes_columns_and_rows(data_dir):
    result = write(data_dir, "SELECT region, sum(revenue) AS revenue FROM monthly_sales GROUP BY 1 ORDER BY 1")
    doc = result["file"]
    assert doc["name"] == "sales"
    assert doc["columns"] == [{"name": "region", "type": "VARCHAR"}, {"name": "revenue", "type": "DOUBLE"}]
    assert doc["rows"] == [["North", 3351.25], ["South", 890.0], ["West", None]]
    assert doc["truncated"] is False
    assert doc["generatedAt"].endswith("Z")
    assert result["rows"] == 3


def test_dates_are_iso_text(data_dir):
    doc = write(data_dir, "SELECT DATE '2024-03-01' AS d, TIMESTAMP '2024-03-01 06:30:00' AS t")["file"]
    assert doc["rows"] == [["2024-03-01", "2024-03-01T06:30:00"]]


def test_nan_and_infinity_become_null(data_dir):
    # JSON has no NaN or infinity; the report shows them as missing.
    doc = write(data_dir, "SELECT 'nan'::DOUBLE AS n, 'inf'::DOUBLE AS i, 1.5 AS ok")["file"]
    assert doc["rows"] == [[None, None, 1.5]]


def test_empty_result(data_dir):
    result = write(data_dir, "SELECT region FROM monthly_sales WHERE false")
    assert result["file"]["columns"] == [{"name": "region", "type": "VARCHAR"}]
    assert result["file"]["rows"] == []
    assert result == {**result, "rows": 0, "truncated": False}


def test_reads_tables_as_shown(data_dir):
    transforms.apply_transform(
        {"data_dir": str(data_dir), "table": "budget_targets", "sql": "SELECT region FROM budget_targets"}
    )
    doc = write(data_dir, "SELECT * FROM budget_targets")["file"]
    assert [c["name"] for c in doc["columns"]] == ["region"]


def test_rows_are_capped(data_dir, monkeypatch):
    monkeypatch.setattr(report_data, "MAX_ROWS", 4)
    result = write(data_dir, "SELECT * FROM range(10)")
    assert len(result["file"]["rows"]) == 4
    assert result["truncated"] is True

    monkeypatch.setattr(report_data, "MAX_ROWS", 0)
    result = write(data_dir, "SELECT * FROM range(10)")
    assert result["file"]["rows"] == []
    assert result["truncated"] is True


def test_oversized_results_are_refused_and_the_old_file_kept(data_dir, monkeypatch):
    write(data_dir, "SELECT 1 AS one")
    monkeypatch.setattr(report_data, "MAX_BYTES", 100)
    with pytest.raises(ValueError, match="over the"):
        write(data_dir, "SELECT repeat('x', 500) AS big")
    out = data_dir.parent / "report" / "data" / "sales.json"
    assert json.loads(out.read_text(encoding="utf-8"))["rows"] == [[1]]


def test_slow_queries_are_stopped(data_dir, monkeypatch):
    monkeypatch.setattr(engine, "TIME_LIMIT_SECONDS", 0.5)
    with pytest.raises(TimeoutError, match="longer than 0.5 seconds"):
        write(data_dir, SLOW)


@pytest.mark.parametrize(**ESCAPE_PARAMS)
def test_sandbox_blocks(data_dir, outside, sibling_secret, sql):
    with pytest.raises(Exception) as caught:
        write(data_dir, escape_query(sql, data_dir, outside))
    assert "hunter2" not in str(caught.value)
    assert not (data_dir.parent / "report" / "data" / "sales.json").exists()
    assert not (outside.parent / "x.csv").exists()
    assert not (outside.parent / "x.db").exists()
    assert not (outside.parent / "export").exists()
