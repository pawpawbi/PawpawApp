"""Every connector in the catalog, as far as it goes without an account.

For each connector this builds its Python environment exactly as the app does (src/data.ts,
prepareEnvironment), then runs runner.py jobs in it:

- discover with empty settings: our own validation message, naming the missing field;
- discover with shaped dummy settings (a closed local port, canary secrets, a throwaway Google
  key): sources that don't connect when built list their tables, which connector_resources.json
  pins down; sources that do connect fail with a connection or sign-in message, never with a
  programming error, and never echo a secret.

Opt in with PAWPAW_ENV_TESTS=1: it downloads packages into python/.connector-envs-test/ and
takes a while the first time. A summary is written to python/.connector-envs-test/report.md.
"""

import hashlib
import json
import os
import re
import shutil
import sqlite3
import subprocess
import time
from pathlib import Path

import pytest

import connectors
from conftest import PYTHON_FLAGS, ROOT, RUNTIME_PYTHON, SIDECAR

pytestmark = pytest.mark.envs

ALL = list(connectors.CONNECTORS.values())
IDS = [c.id for c in ALL]
ENVS = ROOT / "python" / ".connector-envs-test"
CONSTRAINTS = ROOT / "python" / "constraints.txt"
INSTALL_TIMEOUT = 1800
JOB_TIMEOUT = 300

# A secret value that must never appear in an error message or traceback.
CANARY = "pawpaw-canary-7f3a9d"

# Exceptions that mean a bug in the connector or a package, not a problem with the user's input.
PROGRAMMING_ERRORS = re.compile(
    r"^(ImportError|ModuleNotFoundError|TypeError|AttributeError|KeyError|NameError|IndexError"
    r"|AssertionError|NotImplementedError|UnboundLocalError|RecursionError|ZeroDivisionError):"
)

# The tables listed by connectors whose table names don't depend on the settings, with the default
# selection. Recorded the first time a connector is seen, or when PAWPAW_SNAPSHOT_UPDATE=1; a
# difference afterwards means the vendored source or the connector changed, so review it first.
SNAPSHOT = Path(__file__).with_name("connector_resources.json")
SNAPSHOT_IDS = {
    "hubspot", "pipedrive", "bing_webmaster", "matomo", "stripe_analytics", "shopify_dlt", "asana",
    "jira", "inbox", "zendesk", "freshdesk", "workable", "github", "mux", "kafka",
}


# Dummy settings ----------------------------------------------------------------------------------


def _service_account_key(tmp: Path) -> str:
    """A Google service-account JSON with a real, throwaway RSA key (so key parsing succeeds and
    the failure happens at sign-in), generated with ssh-keygen when it's available."""
    key_path = tmp / "throwaway-key"
    keygen = shutil.which("ssh-keygen") or r"C:\Windows\System32\OpenSSH\ssh-keygen.exe"
    pem = "-----BEGIN RSA PRIVATE KEY-----\nnotakey\n-----END RSA PRIVATE KEY-----\n"
    if Path(keygen).exists():
        subprocess.run(
            [keygen, "-q", "-t", "rsa", "-b", "2048", "-m", "PEM", "-N", "", "-f", str(key_path)],
            check=True,
            capture_output=True,
            timeout=60,
        )
        pem = key_path.read_text(encoding="utf-8")
    return json.dumps(
        {
            "type": "service_account",
            "project_id": "pawpaw-test",
            "private_key_id": "0" * 40,
            "private_key": pem,
            "client_email": "pawpaw-test@pawpaw-test.iam.gserviceaccount.com",
            "client_id": "1" * 21,
            "auth_uri": "https://accounts.google.com/o/oauth2/auth",
            "token_uri": "https://oauth2.googleapis.com/token",
        }
    )


def _sample_files(tmp: Path) -> dict:
    csv = tmp / "sample.csv"
    csv.write_text("id,name\n1,Ada\n", encoding="utf-8")
    db = tmp / "sample.db"
    with sqlite3.connect(db) as connection:
        connection.execute("CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT)")
    connection.close()
    folder = tmp / "folder"
    folder.mkdir(exist_ok=True)
    shutil.copy(csv, folder / "part1.csv")
    return {"csv": str(csv), "db": str(db), "folder": str(folder)}


def _overrides(tmp: Path) -> dict[str, dict]:
    """Settings a generic rule can't shape: URLs, IDs with a format, and conditional fields."""
    files = _sample_files(tmp)
    aws_key = "AKIA" + "X" * 16
    return {
        "local_files": {"files": [files["csv"]]},
        "folder": {"folder": files["folder"], "table": "x_table"},
        "url": {"url": "http://127.0.0.1:1/data.csv"},
        "sqlite": {"file": files["db"]},
        "s3": {"bucket": "pawpaw-test-bucket", "access_key_id": aws_key, "table": "x_table"},
        "gcs": {"bucket": "pawpaw-test-bucket", "table": "x_table"},
        "azure_blob": {"account_name": "pawpawtest", "container": "x", "account_key": CANARY, "table": "x_table"},
        "sftp": {"password": CANARY, "table": "x_table"},
        "rest_api": {"base_url": "http://127.0.0.1:1/", "endpoints": "items: /items"},
        "strapi": {"domain": "127.0.0.1:1", "endpoints": "items"},
        "matomo": {"url": "http://127.0.0.1:1/", "site_id": "1"},
        "shopify_dlt": {"shop_url": "pawpaw-test.myshopify.com"},
        "jira": {"subdomain": "pawpaw-test"},
        "zendesk": {"subdomain": "pawpaw-test"},
        "workable": {"subdomain": "pawpaw-test"},
        "freshdesk": {"domain": "pawpaw-test"},
        "kafka": {"bootstrap_servers": "127.0.0.1:1", "topics": "x", "sasl_username": "x", "sasl_password": CANARY},
        "kinesis": {"region_name": "us-east-1", "stream_name": "x", "aws_access_key_id": aws_key},
        "mongodb": {"connection_url": f"mongodb://x:{CANARY}@127.0.0.1:1/x?serverSelectionTimeoutMS=2000"},
        "github": {"owner": "dlt-hub", "repo": "dlt"},
        "google_ads": {"customer_id": "1234567890"},
        "google_analytics": {"property_id": "123456"},
        "bigquery": {"project": "pawpaw-test", "dataset": "x"},
        "google_sheets": {"spreadsheet": "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefg"},
        "facebook_ads": {"account_id": "123456789"},
        "airtable": {"base_id": "appXXXXXXXXXXXXXX"},
        "databricks": {"http_path": "/sql/1.0/warehouses/x"},
        "snowflake": {"account": "pawpaw-test", "database": "x"},
        "bing_webmaster": {"site_urls": "https://example.com/"},
        "salesforce": {"user_name": "x@example.com"},
    }


def _generic_value(field) -> object:
    key = field.key
    if field.secret:
        return CANARY
    if field.type == "checkbox":
        return False
    if "host" in key:
        return "127.0.0.1"
    if key == "port":
        return "1"  # nothing listens here, so connections are refused at once
    if "email" in key:
        return "x@example.com"
    return "x"


def dummy_settings(connector, overrides: dict, service_account: str) -> dict:
    """Shaped dummy settings: defaults, then every required field, then the connector's overrides."""
    settings = {}
    for field in connector.fields:
        if field.default not in (None, ""):
            settings[field.key] = field.default
        if field.key in ("service_account", "credentials") and field.type == "textarea":
            settings[field.key] = service_account
        elif field.required or field.secret or field.key == "port":
            # Secrets even when optional: a database with no password set fails before connecting.
            settings[field.key] = _generic_value(field)
    settings.update(overrides.get(connector.id, {}))
    return settings


# Environments, as the app builds them -------------------------------------------------------------


def _folder_size(path: Path) -> int:
    return sum(p.stat().st_size for p in path.rglob("*") if p.is_file())


def _env_python(env_dir: Path) -> Path:
    return env_dir / "Scripts" / "python.exe" if os.name == "nt" else env_dir / "bin" / "python3"


def build_environment(connector, report: dict) -> Path:
    """The Python to run `connector` with: the bundled runtime, or a venv over it holding the
    connector's packages. Mirrors prepareEnvironment in src/data.ts, including the stamp that
    skips a rebuild when nothing changed."""
    row = report.setdefault(connector.id, {})
    if not connector.packages:
        row["install"] = "bundled"
        return RUNTIME_PYTHON

    env_dir = ENVS / connector.id
    python = _env_python(env_dir)
    constraints = CONSTRAINTS.read_text(encoding="utf-8") if CONSTRAINTS.exists() else ""
    stamp = hashlib.sha256("\n".join([str(RUNTIME_PYTHON), *connector.packages, constraints]).encode()).hexdigest()
    stamp_path = env_dir / ".pawpaw-stamp"
    if stamp_path.exists() and stamp_path.read_text() == stamp:
        row["install"] = f"cached, {_folder_size(env_dir) / 2**20:.0f} MB"
        return python

    started = time.monotonic()
    shutil.rmtree(env_dir, ignore_errors=True)
    subprocess.run(
        [str(RUNTIME_PYTHON), *PYTHON_FLAGS, "-m", "venv", "--system-site-packages", "--without-pip", str(env_dir)],
        check=True,
        capture_output=True,
        timeout=120,
    )
    pip = subprocess.run(
        [
            str(python),
            *PYTHON_FLAGS,
            "-m",
            "pip",
            "install",
            "--disable-pip-version-check",
            "--no-input",
            "--no-warn-script-location",
            "--uploaded-prior-to",
            "P14D",
            *(["-c", str(CONSTRAINTS)] if constraints else []),
            *connector.packages,
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=INSTALL_TIMEOUT,
    )
    seconds = time.monotonic() - started
    if pip.returncode != 0:
        stderr = [line.strip() for line in pip.stderr.strip().splitlines() if line.strip()]
        explanation = [line for line in stderr if not line.startswith("ERROR: ResolutionImpossible")]
        row["install"] = f"FAILED after {seconds:.0f} s: " + " / ".join(explanation[-4:])
        raise AssertionError(f"pip install failed for {connector.id} ({connector.packages}):\n" + "\n".join(stderr[-25:]))
    stamp_path.write_text(stamp)
    row["install"] = f"{seconds:.0f} s, {_folder_size(env_dir) / 2**20:.0f} MB"
    return python


_ENVIRONMENTS: dict[str, Path | BaseException] = {}


def environment(connector, report: dict) -> Path:
    if connector.id not in _ENVIRONMENTS:
        try:
            _ENVIRONMENTS[connector.id] = build_environment(connector, report)
        except BaseException as exc:  # remembered so later tests for this connector explain why they can't run
            _ENVIRONMENTS[connector.id] = exc
    result = _ENVIRONMENTS[connector.id]
    if isinstance(result, BaseException):
        pytest.skip(f"environment for {connector.id} didn't build: {result}")
    return result


# Running the runner --------------------------------------------------------------------------------


def run_discover(python: Path, connector, settings: dict, dlt_dir: Path) -> tuple[list[dict], float]:
    """Runs a discover job in `python`, returning the runner's events and how long it took."""
    env = {**os.environ, "RUNTIME__DLTHUB_TELEMETRY": "false", "DLT_DATA_DIR": str(dlt_dir)}
    job = {"action": "discover", "connector": connector.id, "settings": settings}
    started = time.monotonic()
    try:
        result = subprocess.run(
            [str(python), *PYTHON_FLAGS, str(SIDECAR / "runner.py")],
            input=(json.dumps(job) + "\n").encode("utf-8"),
            capture_output=True,
            env=env,
            timeout=JOB_TIMEOUT,
        )
    except subprocess.TimeoutExpired:
        return [{"event": "error", "message": f"TIMEOUT: no answer after {JOB_TIMEOUT} s", "detail": ""}], JOB_TIMEOUT
    seconds = time.monotonic() - started
    events = [json.loads(line) for line in result.stdout.decode("utf-8").splitlines() if line.strip()]
    assert events, f"runner.py wrote no events. stderr:\n{result.stderr.decode('utf-8', 'replace')[-3000:]}"
    return events, seconds


def _short(message: str, limit: int = 160) -> str:
    message = " ".join(message.split())
    return message if len(message) <= limit else message[: limit - 1] + "…"


# Fixtures -----------------------------------------------------------------------------------------


@pytest.fixture(scope="module")
def report(tmp_path_factory):
    """connector id -> findings, written as a Markdown table when the module finishes."""
    rows: dict[str, dict] = {}
    yield rows
    ENVS.mkdir(parents=True, exist_ok=True)
    columns = ["install", "empty", "dummy", "message"]
    lines = [
        "# Connector smoke test report",
        "",
        f"Run on {time.strftime('%Y-%m-%d %H:%M')} with {len(rows)} connectors.",
        "",
        "| Connector | Install | Empty settings | Dummy settings | Message |",
        "|---|---|---|---|---|",
    ]
    for connector_id in IDS:
        row = rows.get(connector_id, {})
        cells = [str(row.get(c, "")).replace("|", "\\|") for c in columns]
        lines.append(f"| `{connector_id}` | " + " | ".join(cells) + " |")
    (ENVS / "report.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


@pytest.fixture(scope="module")
def shaped(tmp_path_factory):
    tmp = tmp_path_factory.mktemp("dummy")
    return {"overrides": _overrides(tmp), "service_account": _service_account_key(tmp), "dlt_dir": tmp / "dlt"}


# Tests ----------------------------------------------------------------------------------------------


@pytest.mark.parametrize("connector", ALL, ids=IDS)
def test_environment_installs(connector, report):
    """T1: the connector's packages resolve and install under the app's constraints."""
    environment(connector, report)


@pytest.mark.parametrize("connector", ALL, ids=IDS)
def test_empty_settings_give_our_own_message(connector, report, shaped):
    """Building with nothing filled in fails with our validation message, not a library's."""
    python = environment(connector, report)
    events, _ = run_discover(python, connector, {}, shaped["dlt_dir"])
    last = events[-1]
    row = report.setdefault(connector.id, {})
    assert last["event"] == "error", f"{connector.id} built with empty settings: {last}"
    row["empty"] = _short(last["message"], 60)
    assert not PROGRAMMING_ERRORS.match(last["message"]), last["message"]
    assert not re.match(r"^[A-Z]\w+(Error|Exception):", last["message"]), (
        f"{connector.id}: empty settings reached a library instead of our validation: {last['message']}"
    )


@pytest.mark.parametrize("connector", ALL, ids=IDS)
def test_dummy_settings_list_tables_or_fail_cleanly(connector, report, shaped):
    """T2/T7 without an account: lazy sources list their tables; the rest fail like a bad sign-in."""
    python = environment(connector, report)
    settings = dummy_settings(connector, shaped["overrides"], shaped["service_account"])
    events, seconds = run_discover(python, connector, settings, shaped["dlt_dir"])
    last = events[-1]
    row = report.setdefault(connector.id, {})

    if last["event"] == "result":
        resources = {r["name"]: r["selected"] for r in last["result"]}
        row["dummy"] = f"lists {len(resources)} tables in {seconds:.0f} s"
        row["message"] = _short(", ".join(resources))
        assert resources, f"{connector.id} listed no tables"
        if connector.id in SNAPSHOT_IDS:
            snapshot = json.loads(SNAPSHOT.read_text(encoding="utf-8")) if SNAPSHOT.exists() else {}
            if connector.id not in snapshot or os.environ.get("PAWPAW_SNAPSHOT_UPDATE") == "1":
                snapshot[connector.id] = resources
                SNAPSHOT.write_text(json.dumps(snapshot, indent=2, sort_keys=True) + "\n", encoding="utf-8")
            assert resources == snapshot[connector.id], f"{connector.id} lists different tables than the snapshot"
        return

    message, detail = last["message"], last.get("detail", "")
    row["dummy"] = f"error in {seconds:.0f} s"
    row["message"] = _short(message)
    assert not message.startswith("TIMEOUT"), f"{connector.id}: {message}"
    assert not PROGRAMMING_ERRORS.match(message), f"{connector.id}: {message}\n{detail[-2000:]}"
    assert CANARY not in message, f"{connector.id} echoes a secret in its error message: {message}"
    assert CANARY not in detail, f"{connector.id} echoes a secret in its traceback (logged by the app)"
