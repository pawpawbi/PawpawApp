"""Building blocks for describing a connector: its settings form and how to build a dlt source.

The app renders each connector's `fields` as a form. When the user loads data, the values they
entered are passed to `build` as one dict (`settings`), keyed by field `key`. Values arrive as
strings (or lists of strings for "files", booleans for "checkbox"); use the helpers below to
convert them. Fields marked `secret` are stored encrypted on the user's computer and never
written into the .pawpaw project file.

`build` may return a dlt source, a single resource, or a list of resources. Each resource
becomes one table (plus child tables for nested data). The user picks which resources to load.

Import connector-specific packages *inside* `build`: they're only installed (see `packages`)
when the connector is first used, so importing them at module level would break the catalog.
"""

from __future__ import annotations

import datetime as _dt
import json
from dataclasses import dataclass, field
from typing import Any, Callable, Literal

FieldType = Literal[
    "text", "password", "number", "textarea", "select", "checkbox", "date", "file", "files", "folder"
]


@dataclass
class Option:
    value: str
    label: str


@dataclass
class Field:
    key: str
    label: str
    type: FieldType = "text"
    required: bool = False
    # Stored encrypted on this computer, never in the project file.
    secret: bool = False
    help: str = ""
    placeholder: str = ""
    default: Any = None
    # For "select" fields.
    options: list[Option] = field(default_factory=list)
    # For "file" and "files" fields, e.g. [("Data files", ["csv", "xlsx"])].
    file_filters: list[tuple[str, list[str]]] = field(default_factory=list)
    # Shown under an "Advanced" toggle.
    advanced: bool = False

    def to_json(self) -> dict:
        return {
            "key": self.key,
            "label": self.label,
            "type": self.type,
            "required": self.required,
            "secret": self.secret,
            "help": self.help,
            "placeholder": self.placeholder,
            "default": self.default,
            "options": [{"value": o.value, "label": o.label} for o in self.options],
            "fileFilters": [{"name": n, "extensions": e} for n, e in self.file_filters],
            "advanced": self.advanced,
        }


@dataclass
class Connector:
    id: str
    name: str
    category: str
    description: str
    build: Callable[[dict], Any]
    fields: list[Field] = field(default_factory=list)
    # pip requirements (exact versions) installed the first time the connector is used.
    packages: list[str] = field(default_factory=list)
    docs_url: str = ""
    # Extra words to match when searching the catalog.
    keywords: list[str] = field(default_factory=list)

    def to_json(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "category": self.category,
            "description": self.description,
            "fields": [f.to_json() for f in self.fields],
            "packages": self.packages,
            "docsUrl": self.docs_url,
            "keywords": self.keywords,
        }


# Categories, in the order the catalog shows them.
FILES = "Files"
CLOUD_STORAGE = "Cloud storage"
DATABASES = "Databases"
SALES = "Sales & CRM"
MARKETING = "Marketing & analytics"
COMMERCE = "Finance & commerce"
PRODUCTIVITY = "Productivity"
SUPPORT = "Support & HR"
DEVELOPER = "Developer & streaming"

CATEGORIES = [FILES, CLOUD_STORAGE, DATABASES, SALES, MARKETING, COMMERCE, PRODUCTIVITY, SUPPORT, DEVELOPER]


# Helpers for converting form values -------------------------------------------------------------


def text(settings: dict, key: str, default: str | None = None) -> str | None:
    """A trimmed string, or default when the field is empty."""
    value = settings.get(key)
    if value is None:
        return default
    value = str(value).strip()
    return value or default


def required(settings: dict, key: str, label: str | None = None) -> str:
    value = text(settings, key)
    if not value:
        raise ValueError(f"{label or key} is required.")
    return value


def integer(settings: dict, key: str, default: int | None = None, label: str | None = None) -> int | None:
    value = text(settings, key)
    if value is None:
        return default
    try:
        return int(value)
    except ValueError:
        raise ValueError(f"{label or key} must be a whole number.") from None


def boolean(settings: dict, key: str, default: bool = False) -> bool:
    value = settings.get(key)
    if value is None or value == "":
        return default
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in ("1", "true", "yes", "on")


def lines(settings: dict, key: str) -> list[str]:
    """Split a textarea (or comma-separated text) into a list of non-empty items."""
    value = settings.get(key)
    if not value:
        return []
    if isinstance(value, list):
        return [str(v).strip() for v in value if str(v).strip()]
    parts = str(value).replace(",", "\n").splitlines()
    return [p.strip() for p in parts if p.strip()]


def date(
    settings: dict, key: str, default: _dt.date | None = None, label: str | None = None
) -> _dt.date | None:
    value = text(settings, key)
    if value is None:
        return default
    try:
        return _dt.date.fromisoformat(value)
    except ValueError:
        raise ValueError(f"{label or key} must be a date like 2026-01-31.") from None


def json_object(settings: dict, key: str, label: str | None = None) -> dict | None:
    """Parse a pasted JSON object, e.g. a Google service account key."""
    value = text(settings, key)
    if value is None:
        return None
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        raise ValueError(f"{label or key} must be valid JSON.") from None
    if not isinstance(parsed, dict):
        raise ValueError(f"{label or key} must be a JSON object.")
    return parsed


def gcp_service_account(settings: dict, key: str):
    """dlt GcpServiceAccountCredentials from a pasted service account JSON key."""
    from dlt.common.configuration.specs import GcpServiceAccountCredentials

    info = json_object(settings, key)
    if info is None:
        raise ValueError("A service account key is required.")
    if missing := [k for k in ("project_id", "client_email", "private_key") if not info.get(k)]:
        raise ValueError(
            f"The service account key has no {', '.join(missing)}. "
            "Paste the whole JSON key file downloaded from Google Cloud."
        )
    credentials = GcpServiceAccountCredentials()
    # dlt parses the key from its JSON text (a dict is rejected as the wrong type).
    credentials.parse_native_representation(json.dumps(info))
    return credentials
