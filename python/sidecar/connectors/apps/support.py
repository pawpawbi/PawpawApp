"""Customer support and HR connectors, built on dlt verified sources."""

from ..base import SUPPORT, Connector, Field, boolean, date, integer, required


def _datetime(settings: dict, key: str):
    """A date field as a pendulum DateTime at midnight UTC, or None when empty."""
    value = date(settings, key)
    if value is None:
        return None
    from dlt.common import pendulum

    return pendulum.datetime(value.year, value.month, value.day)


def _subdomain(settings: dict, key: str, label: str, host: str) -> str:
    """Accept "acme", "acme.<host>" or a full URL and return just "acme"."""
    value = required(settings, key, label).lower()
    value = value.split("://", 1)[-1].split("/", 1)[0]
    if value.endswith("." + host):
        value = value[: -len(host) - 1]
    return value


def _build_zendesk(settings: dict):
    from verified_sources.zendesk import zendesk_support, zendesk_talk
    from verified_sources.zendesk.helpers.credentials import ZendeskCredentialsToken

    credentials = ZendeskCredentialsToken(
        subdomain=_subdomain(settings, "subdomain", "Subdomain", "zendesk.com"),
        email=required(settings, "email", "Email"),
        token=required(settings, "token", "API token"),
    )
    kwargs = {}
    start = _datetime(settings, "start_date")
    if start is not None:
        kwargs["start_date"] = start
    resources = list(zendesk_support(credentials=credentials, **kwargs).resources.values())
    if boolean(settings, "include_talk"):
        resources += zendesk_talk(credentials=credentials, **kwargs).resources.values()
    return resources


def _build_freshdesk(settings: dict):
    import dlt
    from verified_sources.freshdesk import freshdesk_source

    kwargs = {}
    per_page = integer(settings, "per_page")
    if per_page is not None:
        kwargs["per_page"] = per_page
    source = freshdesk_source(
        domain=_subdomain(settings, "domain", "Domain", "freshdesk.com"),
        api_secret_key=required(settings, "api_key", "API key"),
        **kwargs,
    )
    # The source only asks for records updated since 2022 by default (and Freshdesk itself returns
    # just the last 30 days of tickets without a date), so always set an explicit start.
    start = _datetime(settings, "start_date")
    since = start.strftime("%Y-%m-%dT%H:%M:%SZ") if start is not None else "2000-01-01T00:00:00Z"
    for resource in source.resources.values():
        resource.apply_hints(incremental=dlt.sources.incremental("updated_at", initial_value=since))
    return source


def _build_personio(settings: dict):
    from verified_sources.personio import personio_source

    kwargs = {}
    per_page = integer(settings, "items_per_page")
    if per_page is not None:
        kwargs["items_per_page"] = per_page
    return personio_source(
        client_id=required(settings, "client_id", "Client ID"),
        client_secret=required(settings, "client_secret", "Client secret"),
        **kwargs,
    )


def _build_workable(settings: dict):
    from verified_sources.workable import workable_source

    kwargs = {}
    start = _datetime(settings, "start_date")
    if start is not None:
        kwargs["start_date"] = start
    return workable_source(
        access_token=required(settings, "access_token", "Access token"),
        subdomain=_subdomain(settings, "subdomain", "Subdomain", "workable.com"),
        load_details=boolean(settings, "load_details"),
        **kwargs,
    )


CONNECTORS: list[Connector] = [
    Connector(
        id="zendesk",
        name="Zendesk",
        category=SUPPORT,
        description="Tickets, ticket events and metrics, users, organizations, groups, satisfaction ratings and other Zendesk Support data, plus optional Zendesk Talk calls.",
        docs_url="https://dlthub.com/docs/dlt-ecosystem/verified-sources/zendesk",
        keywords=["tickets", "helpdesk", "customer service", "talk", "calls"],
        fields=[
            Field(
                "subdomain",
                "Subdomain",
                required=True,
                placeholder="yourcompany",
                help="The first part of your Zendesk address, e.g. yourcompany for yourcompany.zendesk.com.",
            ),
            Field("email", "Email", required=True, placeholder="you@company.com", help="The email address of the Zendesk agent or admin the API token belongs to."),
            Field(
                "token",
                "API token",
                type="password",
                required=True,
                secret=True,
                help="In Zendesk Admin Center go to Apps and integrations > APIs > Zendesk API, enable token access and add an API token.",
            ),
            Field(
                "include_talk",
                "Include Zendesk Talk",
                type="checkbox",
                default=False,
                help="Also load phone calls, call legs, numbers and greetings. Only tick this if your account has Zendesk Talk.",
            ),
            Field(
                "start_date",
                "Load records updated since",
                type="date",
                advanced=True,
                help="Only load tickets, events and calls updated on or after this date. Leave empty to load everything since 2000.",
            ),
        ],
        build=_build_zendesk,
    ),
    Connector(
        id="freshdesk",
        name="Freshdesk",
        category=SUPPORT,
        description="Tickets, contacts, companies, agents, groups and roles from Freshdesk.",
        docs_url="https://dlthub.com/docs/dlt-ecosystem/verified-sources/freshdesk",
        keywords=["tickets", "helpdesk", "customer service", "freshworks"],
        fields=[
            Field(
                "domain",
                "Domain",
                required=True,
                placeholder="yourcompany",
                help="The first part of your Freshdesk address, e.g. yourcompany for yourcompany.freshdesk.com.",
            ),
            Field(
                "api_key",
                "API key",
                type="password",
                required=True,
                secret=True,
                help="In Freshdesk, click your profile picture > Profile settings; your API key is shown on the right.",
            ),
            Field(
                "start_date",
                "Load records updated since",
                type="date",
                advanced=True,
                help="Only load tickets and contacts updated on or after this date. Leave empty to load everything since 2000.",
            ),
            Field("per_page", "Page size", type="number", advanced=True, placeholder="100", help="Records fetched per request, up to 100."),
        ],
        build=_build_freshdesk,
    ),
    Connector(
        id="personio",
        name="Personio",
        category=SUPPORT,
        description="Employees, absences, absence types and balances, attendances, projects, document categories and custom reports from Personio.",
        docs_url="https://dlthub.com/docs/dlt-ecosystem/verified-sources/personio",
        keywords=["hr", "employees", "absences", "attendance", "people"],
        fields=[
            Field(
                "client_id",
                "Client ID",
                required=True,
                help="In Personio go to Settings > Integrations > API credentials, generate new credentials with read access, and copy the client ID.",
            ),
            Field("client_secret", "Client secret", type="password", required=True, secret=True, help="Shown together with the client ID when you generate the API credentials."),
            Field("items_per_page", "Page size", type="number", advanced=True, placeholder="200", help="Records fetched per request."),
        ],
        build=_build_personio,
    ),
    Connector(
        id="workable",
        name="Workable",
        category=SUPPORT,
        description="Jobs, candidates, stages, members, recruiters, requisitions and events from Workable, with optional per-job and per-candidate details.",
        docs_url="https://dlthub.com/docs/dlt-ecosystem/verified-sources/workable",
        keywords=["recruiting", "hiring", "ats", "candidates", "jobs", "hr"],
        fields=[
            Field(
                "subdomain",
                "Subdomain",
                required=True,
                placeholder="yourcompany",
                help="The first part of your Workable address, e.g. yourcompany for yourcompany.workable.com.",
            ),
            Field(
                "access_token",
                "Access token",
                type="password",
                required=True,
                secret=True,
                help="In Workable go to Settings > Integrations > Apps and click Generate API token.",
            ),
            Field(
                "load_details",
                "Load job and candidate details",
                type="checkbox",
                default=False,
                advanced=True,
                help="Also load activities, questions, application forms and offers for every job and candidate. Makes many more requests.",
            ),
            Field(
                "start_date",
                "Load records created since",
                type="date",
                advanced=True,
                help="Only load records created (or candidates updated) on or after this date. Leave empty to load everything since 2000.",
            ),
        ],
        build=_build_workable,
    ),
]
