"""The test data generator (scripts/test-data/make_test_data.py): every model is 5 to 10 tables
that join by their keys, with a table of over 10,000 rows, written the same way each time."""

import csv
import hashlib
import importlib.util
import sqlite3
import sys
from pathlib import Path

import pyarrow.parquet as pq
import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "test-data" / "make_test_data.py"
spec = importlib.util.spec_from_file_location("make_test_data", SCRIPT)
make_test_data = importlib.util.module_from_spec(spec)
# Registered first: its dataclasses look themselves up by module name.
sys.modules["make_test_data"] = make_test_data
spec.loader.exec_module(make_test_data)


@pytest.mark.parametrize("model", list(make_test_data.MODELS))
def test_models_are_big_enough_and_join(model):
    tables = make_test_data.MODELS[model](make_test_data.Gen(7, False), 1.0)
    assert 5 <= len(tables) <= 10
    assert max(len(t.rows) for t in tables) > 10_000
    names = {t.name: t for t in tables}
    for t in tables:
        assert len({row[t.column_index(t.key)] for row in t.rows}) == len(t.rows), f"{t.name} keys repeat"
        for column, other, other_column in t.joins:
            keys = {row[names[other].column_index(other_column)] for row in names[other].rows}
            values = {row[t.column_index(column)] for row in t.rows} - {None}
            assert values <= keys, f"{t.name}.{column} has values with no {other} row"


def test_writes_every_format_with_keys_the_database_checks(tmp_path):
    make_test_data.main(["--scale", "0.05", "--formats", "csv,sqlite,parquet,xlsx", "--out", str(tmp_path)])
    for model in make_test_data.MODELS:
        folder = tmp_path / model
        con = sqlite3.connect(folder / f"{model}.sqlite")
        assert con.execute("PRAGMA foreign_key_check").fetchall() == []
        tables = [name for (name,) in con.execute("SELECT name FROM sqlite_master WHERE type = 'table'")]
        for table in tables:
            rows = con.execute(f'SELECT count(*) FROM "{table}"').fetchone()[0]
            with open(folder / "csv" / f"{table}.csv", encoding="utf-8", newline="") as f:
                assert sum(1 for _ in csv.reader(f)) == rows + 1
            assert pq.read_table(folder / "parquet" / f"{table}.parquet").num_rows == rows
        assert (folder / f"{model}.xlsx").stat().st_size > 0
        assert "| Table | Rows |" in (folder / "README.md").read_text(encoding="utf-8")


def test_the_same_seed_gives_the_same_data(tmp_path):
    def digest(folder: Path) -> str:
        return hashlib.sha256((folder / "retail" / "csv" / "order_items.csv").read_bytes()).hexdigest()

    for name in ("a", "b"):
        make_test_data.main(["--models", "retail", "--scale", "0.05", "--formats", "csv", "--out", str(tmp_path / name)])
    assert digest(tmp_path / "a") == digest(tmp_path / "b")


def test_messy_data_breaks_keys_on_purpose_and_says_how(tmp_path):
    make_test_data.main(["--models", "retail", "--scale", "0.2", "--messy", "--out", str(tmp_path)])
    readme = (tmp_path / "retail" / "README.md").read_text(encoding="utf-8")
    assert "point at no customers row" in readme
    assert "duplicated" in readme
    con = sqlite3.connect(tmp_path / "retail" / "retail.sqlite")
    orphans = con.execute(
        "SELECT count(*) FROM orders o LEFT JOIN customers c ON c.customer_id = o.customer_id WHERE c.customer_id IS NULL"
    ).fetchone()[0]
    assert orphans > 0
