"""Transformed tables: new tables built by SQL from other tables (python/sidecar/transforms.py).
Ordering and cycle checks live in the main process and are tested in tests/node."""

from pathlib import Path

import pytest

import datasets
import engine
import transforms
from conftest import describe

BY_REGION = "SELECT region, sum(revenue) AS revenue, count(*) AS orders FROM monthly_sales GROUP BY region"


def build(data_dir: Path, table: str, sql: str):
    return transforms.build_table({"data_dir": str(data_dir), "table": table, "sql": sql})


def query_tables(data_dir: Path, sql: str, kind="transformed"):
    return transforms.query_tables({"data_dir": str(data_dir), "sql": sql, "kind": kind})


def test_query_tables_lists_what_a_query_reads(data_dir):
    sql = """
        WITH targets AS (SELECT * FROM budget_targets)
        SELECT s.region, t.budget FROM monthly_sales s JOIN targets t USING (region)
        WHERE s.region IN (SELECT 'North' FROM budget_staff)
    """
    # The CTE name isn't a table; subqueries count.
    assert query_tables(data_dir, sql) == ["budget_staff", "budget_targets", "monthly_sales"]


def test_query_tables_includes_transformed_tables(data_dir):
    build(data_dir, "by_region", BY_REGION)
    assert query_tables(data_dir, "SELECT * FROM by_region") == ["by_region"]


def test_query_tables_rejects_non_select(data_dir):
    with pytest.raises(ValueError, match="Only SELECT"):
        query_tables(data_dir, "DROP VIEW monthly_sales")


def test_build_table_writes_the_result(data_dir):
    assert build(data_dir, "by_region", BY_REGION) == {"rows": 3}
    assert (data_dir / "transformed" / "by_region" / "data.parquet").is_file()
    table = describe(data_dir)["by_region"]
    assert table["kind"] == "transformed"
    assert table["rows"] == 3
    assert [c["name"] for c in table["columns"]] == ["region", "revenue", "orders"]
    # Loaded tables keep their kind.
    assert describe(data_dir)["monthly_sales"]["kind"] == "loaded"


def test_transformed_tables_can_read_other_transformed_tables(data_dir):
    build(data_dir, "by_region", BY_REGION)
    build(data_dir, "top_region", "SELECT region FROM by_region ORDER BY revenue DESC LIMIT 1")
    preview = datasets.preview_table({"data_dir": str(data_dir), "table": "top_region"})
    assert preview["rows"] == [["North"]]


def test_transformed_tables_see_in_place_transform_results(data_dir):
    transforms.apply_transform(
        {"data_dir": str(data_dir), "table": "monthly_sales", "sql": "SELECT upper(region) AS region FROM monthly_sales"}
    )
    build(data_dir, "regions", "SELECT DISTINCT region FROM monthly_sales ORDER BY region")
    preview = datasets.preview_table({"data_dir": str(data_dir), "table": "regions"})
    assert preview["rows"] == [["NORTH"], ["SOUTH"], ["WEST"]]


def test_in_place_transforms_still_read_original_data(data_dir):
    build(data_dir, "by_region", BY_REGION)
    # Transformed tables aren't visible to in-place transforms.
    with pytest.raises(Exception, match="by_region"):
        transforms.preview_transform({"data_dir": str(data_dir), "sql": "SELECT * FROM by_region"})
    assert transforms.preview_transform(
        {"data_dir": str(data_dir), "sql": "SELECT * FROM by_region", "kind": "transformed"}
    )["row_count"] == 3


def test_rebuilding_replaces_the_result(data_dir):
    build(data_dir, "by_region", BY_REGION)
    assert build(data_dir, "by_region", "SELECT 1 AS one") == {"rows": 1}
    assert [c["name"] for c in describe(data_dir)["by_region"]["columns"]] == ["one"]


def test_failed_build_keeps_the_previous_result(data_dir):
    build(data_dir, "by_region", BY_REGION)
    with pytest.raises(Exception):
        build(data_dir, "by_region", "SELECT * FROM nope")
    assert describe(data_dir)["by_region"]["rows"] == 3
    assert not list((data_dir / "transformed").glob(".*"))  # no staging folder left behind


def test_build_table_refuses_a_loaded_table_name(data_dir):
    with pytest.raises(ValueError, match="already a loaded table"):
        build(data_dir, "monthly_sales", BY_REGION)


def test_clear_and_delete(data_dir):
    build(data_dir, "by_region", BY_REGION)
    transforms.clear_table({"data_dir": str(data_dir), "table": "by_region"})
    assert "by_region" not in describe(data_dir)
    build(data_dir, "by_region", BY_REGION)
    transforms.delete_table({"data_dir": str(data_dir), "table": "by_region"})
    assert engine.transformed_table_names(data_dir) == []


def test_transformed_table_queries_are_sandboxed(data_dir, tmp_path):
    secret = tmp_path / "secret.txt"
    secret.write_text("hunter2", encoding="utf-8")
    with pytest.raises(Exception):
        build(data_dir, "stolen", f"SELECT * FROM read_text('{secret.as_posix()}')")
    with pytest.raises(Exception):
        transforms.preview_transform(
            {"data_dir": str(data_dir), "sql": "SELECT * FROM read_csv('C:/Windows/win.ini')", "kind": "transformed"}
        )
