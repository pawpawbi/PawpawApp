"""Productivity and collaboration connectors, built on dlt verified sources."""

import re

from ..base import (
    PRODUCTIVITY,
    Connector,
    Field,
    boolean,
    date,
    gcp_service_account,
    integer,
    lines,
    required,
    text,
)


def _build_airtable(settings: dict):
    from verified_sources.airtable import airtable_source

    base_id = required(settings, "base_id", "Base ID")
    # Accept a pasted base URL as well as the bare ID.
    match = re.search(r"app[A-Za-z0-9]+", base_id)
    if match:
        base_id = match.group(0)
    return airtable_source(
        base_id=base_id,
        table_names=lines(settings, "table_names") or None,
        access_token=required(settings, "access_token", "Personal access token"),
    )


def _build_asana(settings: dict):
    from verified_sources.asana_dlt import asana_source

    token = required(settings, "access_token", "Personal access token")
    source = asana_source()
    # Every Asana resource takes the token as an argument; bind it on each one in the source.
    for resource in source.resources.values():
        resource.bind(access_token=token)
    return source


def _build_notion(settings: dict):
    from verified_sources.notion import notion_databases, notion_pages

    api_key = required(settings, "api_key", "Integration secret")
    database_ids = [{"id": i} for i in lines(settings, "database_ids")] or None
    databases = notion_databases(database_ids=database_ids, api_key=api_key)
    return [*databases.resources.values(), notion_pages(api_key=api_key)]


def _build_google_sheets(settings: dict):
    from verified_sources.google_sheets import google_spreadsheet

    return google_spreadsheet(
        spreadsheet_url_or_id=required(settings, "spreadsheet", "Spreadsheet"),
        range_names=lines(settings, "range_names"),
        credentials=gcp_service_account(settings, "credentials"),
        get_sheets=boolean(settings, "get_sheets", True),
        get_named_ranges=boolean(settings, "get_named_ranges", True),
    )


def _build_jira(settings: dict):
    from verified_sources.jira import jira, jira_search

    subdomain = required(settings, "subdomain", "Site")
    # Accept "acme", "acme.atlassian.net" or a full https://acme.atlassian.net/... URL.
    subdomain = re.sub(r"^https?://", "", subdomain).split("/")[0].removesuffix(".atlassian.net")
    credentials = {
        "subdomain": subdomain,
        "email": required(settings, "email", "Email"),
        "api_token": required(settings, "api_token", "API token"),
    }
    page_size = integer(settings, "page_size")
    if page_size:
        credentials["page_size"] = page_size

    resources = dict(jira(**credentials).resources)
    # Split on new lines only: JQL itself may contain commas, e.g. "status in (Done, Closed)".
    jql = [q.strip() for q in (text(settings, "jql") or "").splitlines() if q.strip()]
    if jql:
        # Replace the default "all issues" table with issues matching the user's JQL queries.
        resources["issues"] = jira_search(**credentials).resources["issues"].bind(jql_queries=jql)
    return list(resources.values())


def _build_slack(settings: dict):
    from verified_sources.slack import slack_source

    kwargs = {}
    start_date = date(settings, "start_date")
    if start_date:
        kwargs["start_date"] = start_date
    end_date = date(settings, "end_date")
    if end_date:
        kwargs["end_date"] = end_date
    return slack_source(
        access_token=required(settings, "access_token", "Bot token"),
        selected_channels=lines(settings, "channels") or None,
        table_per_channel=boolean(settings, "table_per_channel", True),
        replies=boolean(settings, "replies", False),
        include_private_channels=boolean(settings, "include_private_channels", False),
        **kwargs,
    )


def _get_message_with_internal_date(client, message_uid: str):
    """The inbox source's get_message_with_internal_date, reading INTERNALDATE wherever the
    server puts it in the FETCH reply. The source expects it after the message, as Gmail sends
    it; Dovecot and others send it first, which left the source with no date and a TypeError."""
    import email
    import email.utils
    import imaplib
    from time import mktime

    from dlt.common import pendulum

    status, data = client.uid("fetch", message_uid, "(RFC822 INTERNALDATE)")
    if status != "OK":
        raise client.error(data[-1])
    raw_email = next((part[1] for part in data if isinstance(part, tuple) and len(part) > 1), None)
    if raw_email is None:
        raise Exception(f"Error getting content of email with uid {message_uid}.")
    pieces = [piece for part in data for piece in (part if isinstance(part, tuple) else (part,))]
    dates = (imaplib.Internaldate2tuple(p) for p in pieces if isinstance(p, bytes) and b"INTERNALDATE" in p)
    timestruct = next((t for t in dates if t), None)
    message = email.message_from_bytes(raw_email)
    if timestruct is None and message.get("Date"):
        timestruct = email.utils.parsedate(message["Date"])
    if timestruct is None:
        timestruct = pendulum.now().timetuple()
    return message, pendulum.from_timestamp(mktime(timestruct))


def _build_inbox(settings: dict):
    from dlt.common import pendulum

    import verified_sources.inbox as inbox
    from verified_sources.inbox import inbox_source

    inbox.get_message_with_internal_date = _get_message_with_internal_date

    kwargs = {}
    start_date = date(settings, "start_date")
    if start_date:
        kwargs["start_date"] = pendulum.datetime(start_date.year, start_date.month, start_date.day)
    senders = lines(settings, "filter_emails")
    if senders:
        kwargs["filter_emails"] = senders
    mime_types = lines(settings, "filter_by_mime_type")
    if mime_types:
        kwargs["filter_by_mime_type"] = mime_types
    gmail_group = text(settings, "gmail_group")
    if gmail_group:
        kwargs["gmail_group"] = gmail_group
    return inbox_source(
        host=required(settings, "host", "IMAP server"),
        email_account=required(settings, "email_account", "Email address"),
        password=required(settings, "password", "Password"),
        folder=text(settings, "folder", "INBOX"),
        **kwargs,
    )


CONNECTORS: list[Connector] = [
    Connector(
        id="airtable",
        name="Airtable",
        category=PRODUCTIVITY,
        description="Records from every table (or the tables you choose) in an Airtable base.",
        docs_url="https://dlthub.com/docs/dlt-ecosystem/verified-sources/airtable",
        keywords=["base", "spreadsheet", "database", "no-code"],
        fields=[
            Field(
                "base_id",
                "Base ID",
                required=True,
                placeholder="appXXXXXXXXXXXXXX",
                help="Starts with \"app\". Open the base in your browser and copy it from the address bar (you can paste the whole URL).",
            ),
            Field(
                "access_token",
                "Personal access token",
                type="password",
                required=True,
                secret=True,
                help="Create one at airtable.com/create/tokens with the data.records:read and schema.bases:read scopes, and give it access to this base.",
            ),
            Field(
                "table_names",
                "Tables",
                type="textarea",
                placeholder="Customers\nOrders",
                help="Table names or IDs (starting with \"tbl\"), one per line. Leave empty to load every table in the base.",
            ),
        ],
        packages=["pyairtable==2.3.7"],
        build=_build_airtable,
    ),
    Connector(
        id="asana",
        name="Asana",
        category=PRODUCTIVITY,
        description="Workspaces, projects, sections, tasks, task comments (stories), tags, teams and users from Asana.",
        docs_url="https://dlthub.com/docs/dlt-ecosystem/verified-sources/asana",
        keywords=["tasks", "projects", "project management", "work management"],
        fields=[
            Field(
                "access_token",
                "Personal access token",
                type="password",
                required=True,
                secret=True,
                help="In Asana open My settings > Apps > Developer apps (or app.asana.com/0/my-apps) and create a personal access token.",
            ),
        ],
        packages=["asana==3.2.3"],
        build=_build_asana,
    ),
    Connector(
        id="notion",
        name="Notion",
        category=PRODUCTIVITY,
        description="Rows from Notion databases (one table per database) and the content blocks of pages shared with your integration.",
        docs_url="https://dlthub.com/docs/dlt-ecosystem/verified-sources/notion",
        keywords=["wiki", "docs", "notes", "databases"],
        fields=[
            Field(
                "api_key",
                "Integration secret",
                type="password",
                required=True,
                secret=True,
                help="Create an internal integration at notion.so/my-integrations and copy its secret. Then share each page or database with the integration (••• > Connections).",
            ),
            Field(
                "database_ids",
                "Database IDs",
                type="textarea",
                help="One per line: the 32-character ID from the database's URL. Leave empty to load every database shared with the integration.",
            ),
        ],
        build=_build_notion,
    ),
    Connector(
        id="google_sheets",
        name="Google Sheets",
        category=PRODUCTIVITY,
        description="Tabs and named ranges from a Google spreadsheet, each loaded as a table using the first row as headers.",
        docs_url="https://dlthub.com/docs/dlt-ecosystem/verified-sources/google_sheets",
        keywords=["spreadsheet", "google", "gsheets", "excel"],
        fields=[
            Field(
                "spreadsheet",
                "Spreadsheet URL or ID",
                required=True,
                placeholder="https://docs.google.com/spreadsheets/d/.../edit",
            ),
            Field(
                "credentials",
                "Service account key (JSON)",
                type="textarea",
                required=True,
                secret=True,
                help="In Google Cloud Console enable the Google Sheets API, create a service account, add a JSON key and paste the file's contents here. Then share the spreadsheet with the service account's email address.",
            ),
            Field(
                "range_names",
                "Ranges",
                type="textarea",
                placeholder="Sheet1\nSales!A1:F200\nMyNamedRange",
                help="Tab names, named ranges or A1 ranges to load, one per line. Leave empty to load the options below.",
            ),
            Field("get_sheets", "Load every tab", type="checkbox", default=True, help="Used when no ranges are listed."),
            Field(
                "get_named_ranges",
                "Load every named range",
                type="checkbox",
                default=True,
                help="Used when no ranges are listed.",
                advanced=True,
            ),
        ],
        packages=["google-api-python-client==2.201.0"],
        build=_build_google_sheets,
    ),
    Connector(
        id="jira",
        name="Jira",
        category=PRODUCTIVITY,
        description="Issues, projects, users and workflows from Jira Cloud.",
        docs_url="https://dlthub.com/docs/dlt-ecosystem/verified-sources/jira",
        keywords=["atlassian", "issues", "tickets", "agile", "projects"],
        fields=[
            Field(
                "subdomain",
                "Site",
                required=True,
                placeholder="your-company",
                help="The first part of your Jira address, e.g. \"your-company\" for your-company.atlassian.net.",
            ),
            Field("email", "Email", required=True, help="The email address you sign in to Jira with."),
            Field(
                "api_token",
                "API token",
                type="password",
                required=True,
                secret=True,
                help="Create one at id.atlassian.com/manage-profile/security/api-tokens.",
            ),
            Field(
                "jql",
                "Issue filters (JQL)",
                type="textarea",
                placeholder="project = SALES AND created >= -90d",
                help="One JQL query per line to load only matching issues. Leave empty to load all issues.",
                advanced=True,
            ),
            Field("page_size", "Page size", type="number", placeholder="50", advanced=True),
        ],
        build=_build_jira,
    ),
    Connector(
        id="slack",
        name="Slack",
        category=PRODUCTIVITY,
        description="Channels, users and channel messages (optionally with thread replies) from a Slack workspace.",
        docs_url="https://dlthub.com/docs/dlt-ecosystem/verified-sources/slack",
        keywords=["chat", "messages", "channels", "team"],
        fields=[
            Field(
                "access_token",
                "Bot token",
                type="password",
                required=True,
                secret=True,
                placeholder="xoxb-...",
                help="Create an app at api.slack.com/apps, add the channels:history, channels:read and users:read bot scopes, install it to your workspace and copy the Bot User OAuth Token. Invite the bot to the channels you want to load.",
            ),
            Field(
                "channels",
                "Channels",
                type="textarea",
                placeholder="general\nsales",
                help="Channel names or IDs, one per line. Leave empty to load every channel.",
            ),
            Field("start_date", "Messages from", type="date", help="Leave empty to load all history."),
            Field("end_date", "Messages until", type="date", advanced=True),
            Field("replies", "Include thread replies", type="checkbox", default=False, advanced=True),
            Field(
                "table_per_channel",
                "One table per channel",
                type="checkbox",
                default=True,
                help="Turn off to put all messages in a single \"messages\" table.",
                advanced=True,
            ),
            Field(
                "include_private_channels",
                "Include private channels and group messages",
                type="checkbox",
                default=False,
                help="Needs the groups:read, groups:history, mpim:read and mpim:history scopes.",
                advanced=True,
            ),
        ],
        build=_build_slack,
    ),
    Connector(
        id="inbox",
        name="Email inbox (IMAP)",
        category=PRODUCTIVITY,
        description="Email messages and attachments from a mailbox folder over IMAP (Gmail, Outlook, and most mail providers).",
        docs_url="https://dlthub.com/docs/dlt-ecosystem/verified-sources/inbox",
        keywords=["email", "imap", "gmail", "outlook", "mail", "attachments"],
        fields=[
            Field(
                "host",
                "IMAP server",
                required=True,
                placeholder="imap.gmail.com",
                help="Your mail provider's IMAP server, e.g. imap.gmail.com or outlook.office365.com.",
            ),
            Field("email_account", "Email address", required=True),
            Field(
                "password",
                "Password",
                type="password",
                required=True,
                secret=True,
                help="For Gmail and most providers with two-step verification, create an app password in your account's security settings and use it here.",
            ),
            Field("folder", "Folder", default="INBOX", placeholder="INBOX"),
            Field("start_date", "Emails since", type="date", help="Leave empty to load the whole folder."),
            Field(
                "filter_emails",
                "Only from these senders",
                type="textarea",
                help="Email addresses, one per line.",
                advanced=True,
            ),
            Field(
                "filter_by_mime_type",
                "Attachment types",
                type="textarea",
                placeholder="application/pdf\ntext/csv",
                help="MIME types of attachments to load, one per line. Leave empty for all.",
                advanced=True,
            ),
            Field(
                "gmail_group",
                "Google Group address",
                help="Only load emails sent to this Google Group.",
                advanced=True,
            ),
        ],
        build=_build_inbox,
    ),
]
