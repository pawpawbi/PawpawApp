"""SQL transforms (python/sidecar/transforms.py): running, saving and removing them, and the
lockdown that stops a transform from reaching anything outside the project's data folder."""

from pathlib import Path

import pytest

import datasets
import engine
import transforms
from conftest import ESCAPE_PARAMS, SLOW, describe, escape_query


def preview(data_dir: Path, sql: str, **extra):
    return transforms.preview_transform({"data_dir": str(data_dir), "sql": sql, **extra})


CLEAN_SALES = (
    "SELECT order_id, CAST(order_date AS DATE) AS order_date, upper(region) AS region, "
    "coalesce(revenue, 0) AS revenue, revenue > 1000 AS big FROM monthly_sales"
)


# Running and saving transforms ------------------------------------------------------------------


def test_preview_aggregates_a_table(data_dir):
    result = preview(
        data_dir, "SELECT region, sum(revenue) AS revenue FROM monthly_sales GROUP BY region ORDER BY region;"
    )
    assert [c["name"] for c in result["columns"]] == ["region", "revenue"]
    assert result["rows"] == [["North", 3351.25], ["South", 890.0], ["West", None]]
    assert result["row_count"] == 3


def test_preview_reads_every_parquet_file_of_a_table(data_dir):
    assert len(list((data_dir / "raw" / "monthly_sales").glob("*.parquet"))) == 2
    assert preview(data_dir, "SELECT count(*) AS n FROM monthly_sales")["rows"] == [[4]]


def test_preview_hides_dlt_columns(data_dir):
    columns = [c["name"] for c in preview(data_dir, "SELECT * FROM monthly_sales")["columns"]]
    assert columns == ["order_id", "order_date", "region", "revenue"]


def test_preview_limit_caps_rows_but_not_row_count(data_dir):
    result = preview(data_dir, "SELECT * FROM monthly_sales", limit=2)
    assert len(result["rows"]) == 2
    assert result["row_count"] == 4


def test_preview_joins_tables(data_dir):
    result = preview(
        data_dir,
        """SELECT s.order_id, s.region, t.budget, s.revenue / t.budget AS pct
           FROM monthly_sales s LEFT JOIN budget_targets t USING (region) ORDER BY s.order_id""",
    )
    assert result["rows"] == [
        [1001, "North", 5000, 0.2501],
        [1002, "South", 4000, 0.2225],
        [1003, "North", 5000, 0.42015],
        [1004, "West", None, None],
    ]


def test_preview_makes_dates_json_safe(data_dir):
    result = preview(data_dir, "SELECT CAST(order_date AS DATE) AS d FROM monthly_sales ORDER BY d LIMIT 1")
    assert result["rows"][0][0].startswith("2026-07-03")


def test_apply_saves_transformed_copy_and_describe_shows_it(data_dir):
    assert transforms.apply_transform({"data_dir": str(data_dir), "table": "monthly_sales", "sql": CLEAN_SALES}) == {
        "rows": 4
    }
    assert (data_dir / "model" / "monthly_sales" / "data.parquet").is_file()
    assert not list((data_dir / "model").glob(".*.tmp")), "staging folder cleaned up"

    sales = describe(data_dir)["monthly_sales"]
    assert sales["transformed"] is True
    assert sales["rows"] == 4
    assert [(c["name"], c["kind"]) for c in sales["columns"]] == [
        ("order_id", "integer"),
        ("order_date", "date"),
        ("region", "text"),
        ("revenue", "decimal"),
        ("big", "boolean"),
    ]
    assert describe(data_dir)["budget_targets"]["transformed"] is False


def test_preview_table_uses_transformed_copy(data_dir):
    transforms.apply_transform({"data_dir": str(data_dir), "table": "monthly_sales", "sql": CLEAN_SALES})
    result = datasets.preview_table({"data_dir": str(data_dir), "table": "monthly_sales", "limit": 2})
    assert [c["name"] for c in result["columns"]] == ["order_id", "order_date", "region", "revenue", "big"]
    assert [row[2] for row in result["rows"]] == ["NORTH", "SOUTH"]
    assert result["row_count"] == 4


def test_transform_reads_original_data_after_apply(data_dir):
    transforms.apply_transform({"data_dir": str(data_dir), "table": "monthly_sales", "sql": CLEAN_SALES})
    assert preview(data_dir, "SELECT region FROM monthly_sales ORDER BY order_id LIMIT 1")["rows"] == [["North"]]


def test_apply_again_replaces_previous_result(data_dir):
    params = {"data_dir": str(data_dir), "table": "monthly_sales"}
    transforms.apply_transform({**params, "sql": CLEAN_SALES})
    assert transforms.apply_transform({**params, "sql": "SELECT region FROM monthly_sales LIMIT 1"}) == {"rows": 1}
    assert describe(data_dir)["monthly_sales"]["rows"] == 1


def test_failed_apply_keeps_previous_result(data_dir):
    params = {"data_dir": str(data_dir), "table": "monthly_sales"}
    transforms.apply_transform({**params, "sql": CLEAN_SALES})
    with pytest.raises(Exception):
        transforms.apply_transform({**params, "sql": "SELECT nope FROM monthly_sales"})
    assert describe(data_dir)["monthly_sales"]["rows"] == 4
    assert not list((data_dir / "model").glob(".*.tmp"))


def test_apply_to_unknown_table_is_rejected(data_dir):
    with pytest.raises(ValueError, match='No table called "nope"'):
        transforms.apply_transform({"data_dir": str(data_dir), "table": "nope", "sql": "SELECT 1"})


def test_remove_transform_goes_back_to_original(data_dir):
    transforms.apply_transform({"data_dir": str(data_dir), "table": "monthly_sales", "sql": CLEAN_SALES})
    transforms.remove_transform({"data_dir": str(data_dir), "table": "monthly_sales"})
    sales = describe(data_dir)["monthly_sales"]
    assert sales["transformed"] is False
    assert [c["name"] for c in sales["columns"]] == ["order_id", "order_date", "region", "revenue"]
    # Removing a transform that doesn't exist is fine.
    transforms.remove_transform({"data_dir": str(data_dir), "table": "monthly_sales"})


def test_delete_table_removes_original_and_transformed_copy(data_dir):
    transforms.apply_transform(
        {"data_dir": str(data_dir), "table": "budget_staff", "sql": "SELECT * FROM budget_staff"}
    )
    transforms.delete_table({"data_dir": str(data_dir), "table": "budget_staff"})
    assert datasets.list_tables({"data_dir": str(data_dir)}) == ["budget_targets", "monthly_sales"]
    assert not (data_dir / "raw" / "budget_staff").exists()
    assert not (data_dir / "model" / "budget_staff").exists()
    with pytest.raises(ValueError, match='No table called "budget_staff"'):
        transforms.delete_table({"data_dir": str(data_dir), "table": "budget_staff"})


def test_table_named_like_a_sql_keyword(data_dir):
    from conftest import _write_raw

    _write_raw(data_dir, "order", {"x": [1]})
    assert preview(data_dir, 'SELECT x FROM "order"')["rows"] == [[1]]


# Sandbox: a transform can only read the project's data folder -------------------------------------
# (the queries, ESCAPES, are in conftest.py; report datasets run the same ones)


@pytest.mark.parametrize(**ESCAPE_PARAMS)
def test_sandbox_blocks(data_dir, outside, sibling_secret, sql):
    with pytest.raises(Exception) as caught:
        preview(data_dir, escape_query(sql, data_dir, outside))
    assert "hunter2" not in str(caught.value)

    # Nothing was written or changed.
    assert not (outside.parent / "x.csv").exists()
    assert not (outside.parent / "x.db").exists()
    assert not (outside.parent / "export").exists()
    assert preview(data_dir, "SELECT count(*) FROM monthly_sales")["rows"] == [[4]]


def test_sandbox_blocks_apply_too(data_dir, outside):
    with pytest.raises(Exception):
        transforms.apply_transform(
            {"data_dir": str(data_dir), "table": "monthly_sales", "sql": f"SELECT * FROM read_text('{outside.as_posix()}')"}
        )
    assert describe(data_dir)["monthly_sales"]["transformed"] is False


def test_sandbox_rejects_non_select_with_friendly_message(data_dir):
    with pytest.raises(ValueError, match="Only SELECT queries are allowed"):
        preview(data_dir, "DROP VIEW monthly_sales")
    with pytest.raises(ValueError, match="Enter just one query"):
        preview(data_dir, "SELECT 1; SELECT 2")
    with pytest.raises(ValueError, match="Enter one SELECT query"):
        preview(data_dir, "")


def test_sandbox_settings_are_locked(data_dir):
    rows = preview(
        data_dir,
        "SELECT name, value FROM duckdb_settings() WHERE name IN "
        "('enable_external_access', 'lock_configuration', 'autoinstall_known_extensions', "
        "'autoload_known_extensions') ORDER BY name",
    )["rows"]
    assert rows == [
        ["autoinstall_known_extensions", "false"],
        ["autoload_known_extensions", "false"],
        ["enable_external_access", "false"],
        ["lock_configuration", "true"],
    ]


def test_sandbox_still_allows_reading_inside_data_dir(data_dir):
    (data_dir / "notes.csv").write_text("a\n1\n", encoding="utf-8")
    assert preview(data_dir, f"SELECT * FROM read_csv('{data_dir.as_posix()}/notes.csv')")["rows"] == [[1]]


# Regression test: DuckDB adds its temp directory (<working dir>/.tmp/) to allowed_directories
# unless temp_directory is cleared, which let a transform read files there.
def test_sandbox_blocks_duckdb_temp_directory_in_working_dir(data_dir, tmp_path, monkeypatch):
    cwd = tmp_path / "cwd"
    (cwd / ".tmp").mkdir(parents=True)
    (cwd / ".tmp" / "secret.csv").write_text("secret\nhunter2\n", encoding="utf-8")
    monkeypatch.chdir(cwd)
    with pytest.raises(Exception):
        preview(data_dir, "SELECT * FROM read_csv('.tmp/secret.csv')")


# Time limits and name checks -------------------------------------------------------------------


def test_slow_previews_are_stopped(data_dir, monkeypatch):
    monkeypatch.setattr(engine, "TIME_LIMIT_SECONDS", 0.5)
    with pytest.raises(TimeoutError, match="longer than 0.5 seconds"):
        preview(data_dir, SLOW)
    # The connection is closed and the next request works.
    assert preview(data_dir, "SELECT 1 AS one")["rows"] == [[1]]


def test_slow_builds_are_stopped_and_leave_nothing_behind(data_dir, monkeypatch):
    monkeypatch.setattr(engine, "TIME_LIMIT_SECONDS", 0.5)
    with pytest.raises(TimeoutError):
        transforms.build_table({"data_dir": str(data_dir), "table": "slow", "sql": SLOW})
    assert not (data_dir / "transformed" / "slow").exists()
    assert not (data_dir / "transformed" / ".slow.tmp").exists()


@pytest.mark.parametrize("table", ["../secret", "..", "a/b", "x y", ""])
def test_table_names_are_checked_before_touching_folders(data_dir, outside, table):
    for method in (transforms.remove_transform, transforms.clear_table, transforms.delete_table):
        with pytest.raises(ValueError):
            method({"data_dir": str(data_dir), "table": table})
    with pytest.raises(ValueError):
        transforms.build_table({"data_dir": str(data_dir), "table": table, "sql": "SELECT 1"})
    assert outside.exists()
