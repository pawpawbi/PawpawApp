"""Connectors for business apps and services, built on the dlt verified sources vendored in
python/sidecar/verified_sources/."""

from . import commerce, developer, marketing, productivity, sales, support

CONNECTORS = [
    *sales.CONNECTORS,
    *marketing.CONNECTORS,
    *commerce.CONNECTORS,
    *productivity.CONNECTORS,
    *support.CONNECTORS,
    *developer.CONNECTORS,
]
