"""Reading loaded tables back (python/sidecar/datasets.py)."""

import datetime as dt

import pyarrow as pa
import pyarrow.parquet as pq
import pytest

import datasets


def test_list_tables_skips_dlt_bookkeeping(data_dir):
    assert datasets.list_tables({"data_dir": str(data_dir)}) == ["budget_staff", "budget_targets", "monthly_sales"]


def test_list_tables_of_empty_project(tmp_path):
    assert datasets.list_tables({"data_dir": str(tmp_path / "nothing")}) == []
    assert datasets.describe_tables({"data_dir": str(tmp_path / "nothing")}) == []


def test_describe_tables_hides_dlt_columns_and_counts_rows(data_dir):
    tables = {t["name"]: t for t in datasets.describe_tables({"data_dir": str(data_dir)})}
    assert sorted(tables) == ["budget_staff", "budget_targets", "monthly_sales"]
    sales = tables["monthly_sales"]
    assert sales["rows"] == 4  # across both Parquet files
    assert sales["transformed"] is False
    assert [c["name"] for c in sales["columns"]] == ["order_id", "order_date", "region", "revenue"]
    assert not any(c["name"].startswith("_dlt") for t in tables.values() for c in t["columns"])


def test_describe_tables_column_kinds(tmp_path):
    folder = tmp_path / "raw" / "kinds"
    folder.mkdir(parents=True)
    table = pa.table(
        {
            "flag": pa.array([True]),
            "count": pa.array([1], pa.int32()),
            "big": pa.array([1], pa.int64()),
            "ratio": pa.array([0.5]),
            "price": pa.array([1], pa.decimal128(10, 2)),
            "at": pa.array([dt.datetime(2026, 10, 17, 9, 30)], pa.timestamp("us", tz="UTC")),
            "on": pa.array([dt.date(2026, 10, 17)]),
            "time": pa.array([dt.time(9, 30)]),
            "name": pa.array(["x"]),
            "long_name": pa.array(["x"], pa.large_string()),
            "tags": pa.array([["a", "b"]]),
            "address": pa.array([{"city": "Hobart"}]),
            "blob": pa.array([b"x"]),
            "_dlt_id": pa.array(["id0"]),
        }
    )
    pq.write_table(table, folder / "1.parquet")
    [described] = datasets.describe_tables({"data_dir": str(tmp_path)})
    assert {c["name"]: c["kind"] for c in described["columns"]} == {
        "flag": "boolean",
        "count": "integer",
        "big": "integer",
        "ratio": "decimal",
        "price": "decimal",
        "at": "datetime",
        "on": "date",
        "time": "time",
        "name": "text",
        "long_name": "text",
        "tags": "nested",
        "address": "nested",
        "blob": "other",
    }


def test_preview_table_rows_are_json_safe(data_dir):
    result = datasets.preview_table({"data_dir": str(data_dir), "table": "monthly_sales", "limit": 10})
    assert result["row_count"] == 4
    assert [c["name"] for c in result["columns"]] == ["order_id", "order_date", "region", "revenue"]
    # Missing values (NaN) become null.
    assert result["rows"][-1] == [1004, "2026-08-19", "West", None]


def test_preview_table_limit(data_dir):
    result = datasets.preview_table({"data_dir": str(data_dir), "table": "monthly_sales", "limit": 1})
    assert len(result["rows"]) == 1
    assert result["row_count"] == 4


def test_preview_unknown_table(data_dir):
    with pytest.raises(ValueError, match='No table called "nope"'):
        datasets.preview_table({"data_dir": str(data_dir), "table": "nope"})
