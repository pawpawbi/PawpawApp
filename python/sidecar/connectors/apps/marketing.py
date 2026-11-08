"""Marketing and web analytics connectors, built on dlt verified sources."""

import copy
import json

from ..base import (
    MARKETING,
    Connector,
    Field,
    Option,
    boolean,
    date,
    gcp_service_account,
    integer,
    lines,
    required,
    text,
)

_SERVICE_ACCOUNT_HELP = (
    "Paste the contents of a Google Cloud service account JSON key. Create one in the Google Cloud "
    "console under IAM & Admin > Service Accounts > Keys > Add key > JSON."
)


# Google Ads -------------------------------------------------------------------------------------


def _build_google_ads(settings: dict):
    from google.ads.googleads.client import GoogleAdsClient
    from verified_sources.google_ads import campaigns, change_events, customer_clients, customers

    credentials = gcp_service_account(settings, "service_account").to_native_credentials()
    credentials = credentials.with_scopes(["https://www.googleapis.com/auth/adwords"])
    impersonated_email = text(settings, "impersonated_email")
    if impersonated_email:
        credentials = credentials.with_subject(impersonated_email)

    customer_id = required(settings, "customer_id", "Customer ID").replace("-", "")
    login_customer_id = text(settings, "login_customer_id")
    # Build the client here rather than with the source's get_client, which writes the key to a
    # temporary file that can't be reopened on Windows.
    client = GoogleAdsClient(
        credentials=credentials,
        developer_token=required(settings, "dev_token", "Developer token"),
        login_customer_id=login_customer_id.replace("-", "") if login_customer_id else None,
        use_proto_plus=True,
    )
    return [
        customers(client=client, customer_id=customer_id),
        campaigns(client=client, customer_id=customer_id),
        change_events(client=client, customer_id=customer_id),
        customer_clients(client=client, customer_id=customer_id),
    ]


# Google Analytics -------------------------------------------------------------------------------

_GA_DEFAULT_REPORTS = [
    {
        "resource_name": "traffic_sources",
        "dimensions": ["sessionSource", "sessionMedium"],
        "metrics": ["sessions", "totalUsers", "newUsers", "engagedSessions", "screenPageViews"],
    },
    {
        "resource_name": "pages",
        "dimensions": ["pagePath", "pageTitle"],
        "metrics": ["screenPageViews", "totalUsers", "userEngagementDuration"],
    },
    {
        "resource_name": "countries_and_devices",
        "dimensions": ["country", "deviceCategory"],
        "metrics": ["sessions", "totalUsers", "newUsers"],
    },
]


def _build_google_analytics(settings: dict):
    from verified_sources.google_analytics import google_analytics

    reports_text = text(settings, "reports")
    if reports_text:
        try:
            queries = json.loads(reports_text)
        except json.JSONDecodeError:
            raise ValueError("Reports must be valid JSON.") from None
        if not isinstance(queries, list) or not all(
            isinstance(q, dict) and {"resource_name", "dimensions", "metrics"} <= q.keys() for q in queries
        ):
            raise ValueError('Reports must be a JSON list of {"resource_name", "dimensions", "metrics"} objects.')
    else:
        # The source appends a date dimension to each query, so never hand it the shared defaults.
        queries = copy.deepcopy(_GA_DEFAULT_REPORTS)

    kwargs = {}
    start_date = date(settings, "start_date")
    if start_date:
        kwargs["start_date"] = start_date.isoformat()
    rows_per_page = integer(settings, "rows_per_page")
    if rows_per_page:
        kwargs["rows_per_page"] = rows_per_page
    return google_analytics(
        credentials=gcp_service_account(settings, "service_account"),
        property_id=required(settings, "property_id", "Property ID"),
        queries=queries,
        **kwargs,
    )


# Facebook Ads -----------------------------------------------------------------------------------


def _build_facebook_ads(settings: dict):
    from verified_sources.facebook_ads import facebook_ads_source, facebook_insights_source

    account_id = required(settings, "account_id", "Ad account ID")
    account_id = account_id.removeprefix("act_")
    access_token = required(settings, "access_token", "Access token")

    insights_kwargs = {}
    days = integer(settings, "initial_load_past_days")
    if days is not None:
        insights_kwargs["initial_load_past_days"] = days
    time_increment = integer(settings, "time_increment_days")
    if time_increment:
        insights_kwargs["time_increment_days"] = time_increment
    level = text(settings, "level")
    if level:
        insights_kwargs["level"] = level
    breakdowns = text(settings, "breakdowns")
    if breakdowns:
        insights_kwargs["breakdowns"] = breakdowns

    return [
        *facebook_ads_source(account_id=account_id, access_token=access_token).resources.values(),
        *facebook_insights_source(
            account_id=account_id, access_token=access_token, **insights_kwargs
        ).resources.values(),
    ]


# Bing Webmaster ---------------------------------------------------------------------------------


def _bing_site_for_page(page: str, site_urls: list[str]) -> str:
    for site in site_urls:
        host = site.split("://")[-1].strip("/").removeprefix("www.")
        if host and host in page:
            return site
    return site_urls[0]


def _build_bing_webmaster(settings: dict):
    from verified_sources.bing_webmaster import page_query_stats, page_stats

    api_key = required(settings, "api_key", "API key")
    site_urls = lines(settings, "site_urls")
    if not site_urls:
        raise ValueError("Add at least one site.")
    resources = [page_stats(site_urls, api_key=api_key)]
    pages = [p for p in (text(settings, "pages") or "").splitlines() if p.strip()]
    if pages:
        site_url_pages = [
            {"site_url": _bing_site_for_page(p.strip(), site_urls), "page": p.strip()} for p in pages
        ]
        resources.append(page_query_stats(site_url_pages, api_key=api_key))
    return resources


# Matomo -----------------------------------------------------------------------------------------

_MATOMO_DEFAULT_METHODS = [
    "VisitsSummary.get",
    "Actions.get",
    "Referrers.getReferrerType",
    "UserCountry.getCountry",
    "DevicesDetection.getType",
]


def _build_matomo(settings: dict):
    from verified_sources.matomo import matomo_reports, matomo_visits

    url = required(settings, "url", "Matomo URL")
    if "://" not in url:
        url = "https://" + url
    # The client joins "index.php" onto the URL, which drops the last path segment without a slash.
    if not url.endswith("/"):
        url += "/"
    api_token = required(settings, "api_token", "API token")
    site_id = integer(settings, "site_id")
    if site_id is None:
        raise ValueError("Site ID is required.")

    query = {
        "resource_name": "reports",
        "methods": lines(settings, "methods") or list(_MATOMO_DEFAULT_METHODS),
        "period": text(settings, "period", "day"),
        "extra_params": {},
    }
    start_date = date(settings, "start_date")
    if start_date:
        query["date"] = start_date.isoformat()

    visits_kwargs = {}
    days = integer(settings, "initial_load_past_days")
    if days is not None:
        visits_kwargs["initial_load_past_days"] = days
    if boolean(settings, "get_live_event_visitors"):
        visits_kwargs["get_live_event_visitors"] = True

    return [
        *matomo_reports(api_token=api_token, url=url, queries=[query], site_id=site_id).resources.values(),
        *matomo_visits(
            api_token=api_token, url=url, live_events_site_id=site_id, **visits_kwargs
        ).resources.values(),
    ]


CONNECTORS: list[Connector] = [
    Connector(
        id="google_ads",
        name="Google Ads",
        category=MARKETING,
        description="Customer accounts, campaigns, managed client accounts and recent account changes from Google Ads.",
        docs_url="https://dlthub.com/docs/dlt-ecosystem/verified-sources/google_ads",
        keywords=["adwords", "ppc", "advertising", "campaigns", "google"],
        fields=[
            Field(
                "service_account",
                "Service account key (JSON)",
                type="textarea",
                required=True,
                secret=True,
                help=_SERVICE_ACCOUNT_HELP
                + " Enable the Google Ads API for its project, then add the service account's email as a user in your Google Ads account.",
            ),
            Field(
                "dev_token",
                "Developer token",
                type="password",
                required=True,
                secret=True,
                help="In Google Ads, open Tools > API Center (in a manager account) to find or apply for your developer token.",
            ),
            Field(
                "customer_id",
                "Customer ID",
                required=True,
                placeholder="123-456-7890",
                help="The account number shown in the top right corner of Google Ads.",
            ),
            Field(
                "login_customer_id",
                "Manager account ID",
                advanced=True,
                placeholder="123-456-7890",
                help="Only needed when you access the account through a manager (MCC) account.",
            ),
            Field(
                "impersonated_email",
                "Impersonated user email",
                advanced=True,
                help="Only for Google Workspace domain-wide delegation: the user the service account acts as.",
            ),
        ],
        packages=["google-ads==33.0.0", "google-api-python-client==2.201.0"],
        build=_build_google_ads,
    ),
    Connector(
        id="google_analytics",
        name="Google Analytics",
        category=MARKETING,
        description="Daily Google Analytics 4 reports on traffic sources, pages, countries and devices, plus the list of available metrics and dimensions.",
        docs_url="https://dlthub.com/docs/dlt-ecosystem/verified-sources/google_analytics",
        keywords=["ga4", "web analytics", "traffic", "sessions", "google"],
        fields=[
            Field(
                "service_account",
                "Service account key (JSON)",
                type="textarea",
                required=True,
                secret=True,
                help=_SERVICE_ACCOUNT_HELP
                + " Enable the Google Analytics Data API for its project, then add the service account's email as a Viewer in Google Analytics (Admin > Property access management).",
            ),
            Field(
                "property_id",
                "Property ID",
                type="number",
                required=True,
                placeholder="123456789",
                help="A number found in Google Analytics under Admin > Property details. Not the G-XXXX measurement ID.",
            ),
            Field("start_date", "Start date", type="date", help="Load reports from this date. Leave empty to start from 2015-08-14."),
            Field(
                "reports",
                "Reports (JSON)",
                type="textarea",
                advanced=True,
                default=json.dumps(_GA_DEFAULT_REPORTS, indent=2),
                help='A list of reports, each {"resource_name": table name, "dimensions": [...], "metrics": [...]}. A date dimension is added automatically. Leave empty for the default reports.',
            ),
            Field("rows_per_page", "Rows per page", type="number", advanced=True, placeholder="1000", help="Up to 100000."),
        ],
        packages=[
            "google-analytics-data==0.23.3",
            "google-api-python-client==2.201.0",
            "google-auth-oauthlib==1.5.0",
            "requests-oauthlib==2.0.0",
        ],
        build=_build_google_analytics,
    ),
    Connector(
        id="facebook_ads",
        name="Facebook Ads",
        category=MARKETING,
        description="Campaigns, ad sets, ads, creatives, leads and daily performance insights from a Facebook (Meta) ad account.",
        docs_url="https://dlthub.com/docs/dlt-ecosystem/verified-sources/facebook_ads",
        keywords=["meta", "instagram", "advertising", "campaigns", "insights"],
        fields=[
            Field(
                "account_id",
                "Ad account ID",
                required=True,
                placeholder="1234567890",
                help="The number shown in Meta Ads Manager's account selector (with or without the act_ prefix).",
            ),
            Field(
                "access_token",
                "Access token",
                type="password",
                required=True,
                secret=True,
                help="A Marketing API access token with ads_read permission, e.g. a system user token from Meta Business Settings > Users > System users > Generate new token.",
            ),
            Field(
                "initial_load_past_days",
                "Insights: days to load",
                type="number",
                advanced=True,
                placeholder="30",
                help="How many past days of insights to load. Each day is a separate report, so long ranges take a while.",
            ),
            Field(
                "level",
                "Insights: level",
                type="select",
                advanced=True,
                default="ad",
                options=[
                    Option("ad", "Ad"),
                    Option("adset", "Ad set"),
                    Option("campaign", "Campaign"),
                    Option("account", "Account"),
                ],
            ),
            Field(
                "breakdowns",
                "Insights: breakdown",
                type="select",
                advanced=True,
                default="",
                options=[
                    Option("", "None"),
                    Option("ads_insights_age_and_gender", "Age and gender"),
                    Option("ads_insights_country", "Country"),
                    Option("ads_insights_region", "Region"),
                    Option("ads_insights_dma", "DMA region"),
                    Option("ads_insights_platform_and_device", "Platform and device"),
                    Option("ads_insights_hourly_advertiser", "Hour of day"),
                ],
            ),
            Field(
                "time_increment_days",
                "Insights: days per row",
                type="number",
                advanced=True,
                placeholder="1",
                help="Use 7 for weekly rows.",
            ),
        ],
        packages=["facebook-business==26.0.2"],
        build=_build_facebook_ads,
    ),
    Connector(
        id="bing_webmaster",
        name="Bing Webmaster Tools",
        category=MARKETING,
        description="Weekly Bing search clicks, impressions and positions for your site's top pages, and optionally the search queries for chosen pages.",
        docs_url="https://dlthub.com/docs/dlt-ecosystem/verified-sources/bing_webmaster",
        keywords=["seo", "search", "bing", "organic traffic", "microsoft"],
        fields=[
            Field(
                "api_key",
                "API key",
                type="password",
                required=True,
                secret=True,
                help="In Bing Webmaster Tools, click the settings (cog) icon > API access > API key.",
            ),
            Field(
                "site_urls",
                "Sites",
                type="textarea",
                required=True,
                placeholder="example.com",
                help="One verified site per line, as it appears in Bing Webmaster Tools.",
            ),
            Field(
                "pages",
                "Pages for query statistics",
                type="textarea",
                advanced=True,
                placeholder="https://example.com/pricing",
                help="Optional. One full page URL per line to also load the search queries that led to each page.",
            ),
        ],
        packages=[],
        build=_build_bing_webmaster,
    ),
    Connector(
        id="matomo",
        name="Matomo",
        category=MARKETING,
        description="Matomo web analytics reports (visits, actions, referrers, countries, devices) and individual visits for a site.",
        docs_url="https://dlthub.com/docs/dlt-ecosystem/verified-sources/matomo",
        keywords=["piwik", "web analytics", "visits", "traffic"],
        fields=[
            Field(
                "url",
                "Matomo URL",
                required=True,
                placeholder="https://example.matomo.cloud/",
                help="The address you use to open Matomo in your browser.",
            ),
            Field(
                "api_token",
                "API token",
                type="password",
                required=True,
                secret=True,
                help="In Matomo, open Administration (cog icon) > Personal > Security > Auth tokens > Create new token.",
            ),
            Field(
                "site_id",
                "Site ID",
                type="number",
                required=True,
                placeholder="1",
                help="Shown in Administration > Websites > Manage, next to each website.",
            ),
            Field("start_date", "Reports start date", type="date", help="Load reports from this date. Leave empty to start from 2000-01-01."),
            Field(
                "period",
                "Report period",
                type="select",
                default="day",
                options=[Option("day", "Day"), Option("week", "Week"), Option("month", "Month"), Option("year", "Year")],
            ),
            Field(
                "methods",
                "Report methods",
                type="textarea",
                advanced=True,
                default="\n".join(_MATOMO_DEFAULT_METHODS),
                help="Matomo API report methods, one per line. Each becomes its own table.",
            ),
            Field(
                "initial_load_past_days",
                "Visits: days to load",
                type="number",
                advanced=True,
                placeholder="10",
                help="How many past days of individual visits to load.",
            ),
            Field(
                "get_live_event_visitors",
                "Also load visitor profiles",
                type="checkbox",
                advanced=True,
                default=False,
            ),
        ],
        packages=[],
        build=_build_matomo,
    ),
]
