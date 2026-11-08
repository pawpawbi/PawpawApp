"""A generic connector for any JSON REST API, using dlt's rest_api source."""

import re

from .base import DEVELOPER, Connector, Field, Option, lines, required, text


def _endpoint(line: str) -> dict:
    """'orders: /v1/orders' or just '/v1/orders' -> a rest_api resource config."""
    name, separator, path = line.partition(":")
    if not separator or name.strip().lower() in ("http", "https"):
        name, path = "", line  # No table name given (a full URL's "https:" isn't one).
    path = path.strip()
    name = name.strip() or re.sub(r"[^a-zA-Z0-9]+", "_", path.split("?")[0]).strip("_") or "data"
    return {"name": name, "endpoint": {"path": path.lstrip("/")}}


def _auth(settings: dict) -> dict | None:
    kind = text(settings, "auth", "none")
    if kind == "bearer":
        return {"type": "bearer", "token": required(settings, "token", "Token")}
    if kind == "api_key":
        return {
            "type": "api_key",
            "name": text(settings, "api_key_name", "X-API-Key"),
            "api_key": required(settings, "token", "API key"),
            "location": text(settings, "api_key_location", "header"),
        }
    if kind == "http_basic":
        return {
            "type": "http_basic",
            "username": required(settings, "username", "Username"),
            "password": text(settings, "password", ""),
        }
    return None


def _build_rest_api(settings: dict):
    from dlt.sources.rest_api import rest_api_source

    endpoints = [_endpoint(line) for line in lines(settings, "endpoints")]
    if not endpoints:
        raise ValueError("Add at least one endpoint.")
    if selector := text(settings, "data_selector"):
        for endpoint in endpoints:
            endpoint["endpoint"]["data_selector"] = selector

    client: dict = {"base_url": required(settings, "base_url", "Base URL").rstrip("/") + "/"}
    if auth := _auth(settings):
        client["auth"] = auth
    return rest_api_source({"client": client, "resources": endpoints})


CONNECTORS: list[Connector] = [
    Connector(
        id="rest_api",
        name="REST API",
        category=DEVELOPER,
        description="Any web service with a JSON API. Pagination is detected automatically for most APIs.",
        docs_url="https://dlthub.com/docs/dlt-ecosystem/verified-sources/rest_api",
        keywords=["http", "json", "web service", "custom", "api"],
        fields=[
            Field("base_url", "Base URL", required=True, placeholder="https://api.example.com/v1"),
            Field(
                "endpoints",
                "Endpoints",
                type="textarea",
                required=True,
                placeholder="orders: /orders\ncustomers: /customers",
                help="One per line, as table name: path. Each endpoint becomes a table.",
            ),
            Field(
                "auth",
                "Authentication",
                type="select",
                default="none",
                options=[
                    Option("none", "None"),
                    Option("bearer", "Bearer token"),
                    Option("api_key", "API key"),
                    Option("http_basic", "Username and password"),
                ],
            ),
            Field("token", "Token or API key", type="password", secret=True, help="For bearer token or API key authentication."),
            Field("username", "Username", help="For username and password authentication."),
            Field("password", "Password", type="password", secret=True),
            Field("api_key_name", "API key name", placeholder="X-API-Key", advanced=True, help="The header or query parameter that carries the API key."),
            Field(
                "api_key_location",
                "Send API key in",
                type="select",
                default="header",
                advanced=True,
                options=[Option("header", "Header"), Option("query", "Query string")],
            ),
            Field(
                "data_selector",
                "Records are in",
                placeholder="data.items",
                advanced=True,
                help="Where the list of records sits in each response, e.g. data or results. Detected automatically when empty.",
            ),
        ],
        build=_build_rest_api,
    ),
]
