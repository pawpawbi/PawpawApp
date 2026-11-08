"""Sales and CRM connectors, built on dlt verified sources."""

from ..base import SALES, Connector, Field, boolean, date, required


def _datetime(settings: dict, key: str):
    """A date field as a pendulum DateTime at midnight UTC, or None when empty."""
    value = date(settings, key)
    if value is None:
        return None
    from dlt.common import pendulum

    return pendulum.datetime(value.year, value.month, value.day)


def _build_salesforce(settings: dict):
    from verified_sources.salesforce import salesforce_source
    from verified_sources.salesforce.helpers.client import SecurityTokenAuth

    credentials = SecurityTokenAuth(
        user_name=required(settings, "user_name", "Username"),
        password=required(settings, "password", "Password"),
        security_token=required(settings, "security_token", "Security token"),
    )
    return salesforce_source(credentials=credentials)


def _build_hubspot(settings: dict):
    from verified_sources.hubspot import hubspot

    return hubspot(
        api_key=required(settings, "api_key", "Access token"),
        include_history=boolean(settings, "include_history"),
        soft_delete=boolean(settings, "soft_delete"),
        include_custom_props=boolean(settings, "include_custom_props", default=True),
    )


def _build_pipedrive(settings: dict):
    from verified_sources.pipedrive import pipedrive_source

    kwargs = {}
    since = _datetime(settings, "since_date")
    if since is not None:
        kwargs["since_timestamp"] = since
    return pipedrive_source(pipedrive_api_key=required(settings, "api_key", "API token"), **kwargs)


CONNECTORS: list[Connector] = [
    Connector(
        id="salesforce",
        name="Salesforce",
        category=SALES,
        description="Accounts, contacts, leads, opportunities, campaigns, products, price books, tasks, events and users from Salesforce.",
        docs_url="https://dlthub.com/docs/dlt-ecosystem/verified-sources/salesforce",
        keywords=["crm", "sfdc", "opportunities", "leads", "accounts"],
        fields=[
            Field("user_name", "Username", required=True, placeholder="you@company.com", help="The username you sign in to Salesforce with."),
            Field("password", "Password", type="password", required=True, secret=True),
            Field(
                "security_token",
                "Security token",
                type="password",
                required=True,
                secret=True,
                help="In Salesforce, open your profile settings and choose Reset My Security Token; the token is emailed to you.",
            ),
        ],
        packages=["simple-salesforce==1.12.10"],
        build=_build_salesforce,
    ),
    Connector(
        id="hubspot",
        name="HubSpot",
        category=SALES,
        description="Contacts, companies, deals, tickets, products, quotes, owners and pipelines from HubSpot CRM.",
        docs_url="https://dlthub.com/docs/dlt-ecosystem/verified-sources/hubspot",
        keywords=["crm", "deals", "contacts", "companies", "marketing"],
        fields=[
            Field(
                "api_key",
                "Access token",
                type="password",
                required=True,
                secret=True,
                placeholder="pat-...",
                help="Create a private app in HubSpot (Settings > Integrations > Private Apps) with read access to the CRM objects you need, then copy its access token.",
            ),
            Field(
                "include_custom_props",
                "Include custom properties",
                type="checkbox",
                default=True,
                advanced=True,
                help="Load the custom properties you've added to contacts, companies, deals and other objects.",
            ),
            Field(
                "include_history",
                "Include property history",
                type="checkbox",
                default=False,
                advanced=True,
                help="Also load the history of property changes into separate tables. Can be slow for large accounts.",
            ),
            Field(
                "soft_delete",
                "Include archived records",
                type="checkbox",
                default=False,
                advanced=True,
                help="Also load archived (deleted) records, marked with is_deleted.",
            ),
        ],
        build=_build_hubspot,
    ),
    Connector(
        id="pipedrive",
        name="Pipedrive",
        category=SALES,
        description="Deals, leads, persons, organizations, activities, notes, products, pipelines, stages and users from Pipedrive.",
        docs_url="https://dlthub.com/docs/dlt-ecosystem/verified-sources/pipedrive",
        keywords=["crm", "deals", "leads", "pipeline"],
        fields=[
            Field(
                "api_key",
                "API token",
                type="password",
                required=True,
                secret=True,
                help="In Pipedrive, open your profile menu > Personal preferences > API and copy your personal API token.",
            ),
            Field(
                "since_date",
                "Load records changed since",
                type="date",
                advanced=True,
                help="Only load records added or updated on or after this date. Leave empty to load everything.",
            ),
        ],
        build=_build_pipedrive,
    ),
]
