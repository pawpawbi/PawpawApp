"""Catalog of data connectors. See base.py for how a connector is described."""

from . import apis, apps, databases, files, storage
from .base import CATEGORIES, Connector

CONNECTORS: dict[str, Connector] = {
    c.id: c
    for c in [
        *files.CONNECTORS,
        *storage.CONNECTORS,
        *databases.CONNECTORS,
        *apps.CONNECTORS,
        *apis.CONNECTORS,
    ]
}


def get(connector_id: str) -> Connector:
    connector = CONNECTORS.get(connector_id)
    if connector is None:
        raise ValueError(f"Unknown connector: {connector_id}")
    return connector


def catalog(_params=None) -> dict:
    return {
        "categories": CATEGORIES,
        "connectors": [c.to_json() for c in CONNECTORS.values()],
    }
