"""Finance and commerce connectors, built on dlt verified sources."""

from ..base import COMMERCE, Connector, Field, Option, date, integer, lines, required, text

_STRIPE_DEFAULT_OBJECTS = [
    "Subscription",
    "Account",
    "Coupon",
    "Customer",
    "Invoice",
    "Product",
    "Price",
    "Event",
    "BalanceTransaction",
]


def _build_stripe_analytics(settings: dict):
    from dlt.common.time import ensure_pendulum_datetime
    from verified_sources.stripe_analytics import stripe_source

    kwargs = {}
    start_date = date(settings, "start_date")
    if start_date:
        kwargs["start_date"] = ensure_pendulum_datetime(start_date)
    end_date = date(settings, "end_date")
    if end_date:
        kwargs["end_date"] = ensure_pendulum_datetime(end_date)
    return stripe_source(
        endpoints=tuple(lines(settings, "endpoints") or _STRIPE_DEFAULT_OBJECTS),
        stripe_secret_key=required(settings, "stripe_secret_key", "Secret key"),
        **kwargs,
    )


def _build_shopify_dlt(settings: dict):
    from verified_sources.shopify_dlt import shopify_source

    shop_url = required(settings, "shop_url", "Shop URL")
    if "://" not in shop_url:
        shop_url = "https://" + shop_url

    kwargs = {}
    start_date = date(settings, "start_date")
    if start_date:
        kwargs["start_date"] = start_date.isoformat()
    end_date = date(settings, "end_date")
    if end_date:
        kwargs["end_date"] = end_date.isoformat()
    created_at_min = date(settings, "created_at_min")
    if created_at_min:
        kwargs["created_at_min"] = created_at_min.isoformat()
    order_status = text(settings, "order_status")
    if order_status:
        kwargs["order_status"] = order_status
    api_version = text(settings, "api_version")
    if api_version:
        kwargs["api_version"] = api_version
    items_per_page = integer(settings, "items_per_page")
    if items_per_page:
        kwargs["items_per_page"] = items_per_page
    return shopify_source(
        private_app_password=required(settings, "private_app_password", "Admin API access token"),
        shop_url=shop_url,
        **kwargs,
    )


CONNECTORS: list[Connector] = [
    Connector(
        id="stripe_analytics",
        name="Stripe",
        category=COMMERCE,
        description="Customers, subscriptions, invoices, products, prices, coupons, balance transactions and events from Stripe.",
        docs_url="https://dlthub.com/docs/dlt-ecosystem/verified-sources/stripe",
        keywords=["payments", "billing", "subscriptions", "invoices", "revenue"],
        fields=[
            Field(
                "stripe_secret_key",
                "Secret key",
                type="password",
                required=True,
                secret=True,
                placeholder="rk_live_...",
                help="In the Stripe Dashboard, open Developers > API keys. A restricted key with read-only access is safest.",
            ),
            Field("start_date", "Created on or after", type="date", help="Only load objects created on or after this date."),
            Field("end_date", "Created before", type="date", advanced=True, help="Only load objects created before this date."),
            Field(
                "endpoints",
                "Objects to load",
                type="textarea",
                advanced=True,
                default="\n".join(_STRIPE_DEFAULT_OBJECTS),
                help="Stripe API object names, one per line (e.g. Charge, PaymentIntent, Refund). Each becomes a table.",
            ),
        ],
        packages=["stripe==15.6.1"],
        build=_build_stripe_analytics,
    ),
    Connector(
        id="shopify_dlt",
        name="Shopify",
        category=COMMERCE,
        description="Orders, products and customers from a Shopify store.",
        docs_url="https://dlthub.com/docs/dlt-ecosystem/verified-sources/shopify",
        keywords=["ecommerce", "store", "orders", "products", "customers"],
        fields=[
            Field(
                "shop_url",
                "Shop URL",
                required=True,
                placeholder="https://my-shop.myshopify.com",
                help="Your store's myshopify.com address.",
            ),
            Field(
                "private_app_password",
                "Admin API access token",
                type="password",
                required=True,
                secret=True,
                placeholder="shpat_...",
                help="In Shopify admin, open Settings > Apps and sales channels > Develop apps, create an app with read access to orders, products and customers, install it, and copy its Admin API access token.",
            ),
            Field("start_date", "Updated on or after", type="date", help="Only load items updated on or after this date."),
            Field("end_date", "Updated before", type="date", advanced=True, help="Only load items updated before this date."),
            Field("created_at_min", "Created on or after", type="date", advanced=True, help="Only load items created on or after this date."),
            Field(
                "order_status",
                "Order status",
                type="select",
                advanced=True,
                default="any",
                options=[
                    Option("any", "Any"),
                    Option("open", "Open"),
                    Option("closed", "Closed"),
                    Option("cancelled", "Cancelled"),
                ],
            ),
            Field("api_version", "API version", advanced=True, placeholder="2023-10", help="The Shopify Admin API version, e.g. 2025-01."),
            Field("items_per_page", "Items per page", type="number", advanced=True, placeholder="250"),
        ],
        packages=[],
        build=_build_shopify_dlt,
    ),
]
