"""The connector catalog (python/sidecar/connectors/) is well formed."""

import json
import re
import typing

import pytest

import connectors
from connectors.base import CATEGORIES, FieldType

ALL = list(connectors.CONNECTORS.values())
FIELD_TYPES = set(typing.get_args(FieldType))
# name, optional [extras], ==, version
EXACT_PIN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*(\[[A-Za-z0-9._,-]+\])?==[0-9][A-Za-z0-9.+!-]*$")


def test_catalog_serialises_to_json():
    catalog = connectors.catalog()
    assert catalog["categories"] == CATEGORIES
    assert len(catalog["connectors"]) == len(ALL) > 0
    json.dumps(catalog)  # everything the app receives is plain JSON


def test_connector_ids_are_unique():
    ids = [c.id for module in (connectors.files, connectors.storage, connectors.databases, connectors.apis)
           for c in module.CONNECTORS]
    ids += [c.id for c in connectors.apps.CONNECTORS]
    assert len(ids) == len(set(ids)), [i for i in ids if ids.count(i) > 1]


def test_bundled_connectors_are_present():
    for connector_id in ("local_files", "folder", "url", "sqlite"):
        assert connectors.get(connector_id).id == connector_id


def test_unknown_connector():
    with pytest.raises(ValueError, match="Unknown connector: nope"):
        connectors.get("nope")


def test_connector_packages_use_the_bundled_dlt_version():
    """dlt extras downloaded for a connector must match the dlt that ships with the app."""
    from conftest import ROOT

    requirements = (ROOT / "python" / "requirements.txt").read_text(encoding="utf-8")
    [pinned] = re.findall(r"^dlt(?:\[[^\]]*\])?==(\S+)$", requirements, re.MULTILINE)
    assert connectors.storage.DLT_VERSION == pinned


@pytest.mark.parametrize("connector", ALL, ids=lambda c: c.id)
def test_connector_is_well_formed(connector):
    assert re.fullmatch(r"[a-z][a-z0-9_]*", connector.id)
    assert connector.name.strip() and connector.description.strip()
    assert connector.category in CATEGORIES
    assert callable(connector.build)
    assert connector.docs_url == "" or connector.docs_url.startswith("https://")
    for package in connector.packages:
        assert EXACT_PIN.match(package), f"{package!r} is not pinned to an exact version"

    keys = [f.key for f in connector.fields]
    assert len(keys) == len(set(keys)), f"duplicate field keys in {connector.id}"
    for field in connector.fields:
        assert field.type in FIELD_TYPES, f"{connector.id}.{field.key}: unknown type {field.type}"
        assert field.label.strip()
        if field.secret:
            assert field.type in ("password", "textarea"), f"{connector.id}.{field.key}: secret shown as plain text"
        if field.type == "select":
            values = [o.value for o in field.options]
            assert values, f"{connector.id}.{field.key}: select without options"
            assert field.default in (None, *values), f"{connector.id}.{field.key}: default not an option"


def test_fields_that_look_secret_are_marked_secret():
    looks_secret = re.compile(r"(password|secret|token|api_key|private_key|account_key)$")
    unmarked = [
        f"{c.id}.{f.key}"
        for c in ALL
        for f in c.fields
        if looks_secret.search(f.key) and not f.secret
    ]
    assert unmarked == []


def test_a_request_without_params_is_handled():
    import main

    assert main.handle({"method": "catalog"})["connectors"]
    with pytest.raises(ValueError, match="Unknown method"):
        main.handle({"method": "nope"})


def test_form_value_errors_use_the_field_label():
    from connectors import base

    with pytest.raises(ValueError, match="Port must be a whole number"):
        base.integer({"port": "x"}, "port", label="Port")
    with pytest.raises(ValueError, match="Start date must be a date"):
        base.date({"start": "yesterday"}, "start", label="Start date")
    with pytest.raises(ValueError, match="Service account key must be valid JSON"):
        base.json_object({"key": "{"}, "key", label="Service account key")
    with pytest.raises(ValueError, match="Service account key must be a JSON object"):
        base.json_object({"key": "[]"}, "key", label="Service account key")
    # Without a label, messages fall back to the field key.
    with pytest.raises(ValueError, match="port must be a whole number"):
        base.integer({"port": "x"}, "port")
