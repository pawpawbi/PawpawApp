"""Developer tools and streaming connectors, built on dlt verified sources."""

import re

from ..base import (
    DATABASES,
    DEVELOPER,
    Connector,
    Field,
    Option,
    boolean,
    date,
    integer,
    json_object,
    lines,
    required,
    text,
)


def _build_github(settings: dict):
    from verified_sources.github import github_reactions, github_repo_events, github_stargazers

    owner = required(settings, "owner", "Owner")
    repo = required(settings, "repo", "Repository")
    token = text(settings, "access_token")
    max_items = integer(settings, "max_items")
    # Only the events source works anonymously; the other two require a token.
    sources = [github_repo_events(owner, repo, access_token=token)]
    if token:
        sources = [
            github_reactions(owner, repo, access_token=token, max_items=max_items),
            *sources,
            github_stargazers(owner, repo, access_token=token, max_items=max_items),
        ]
    return [resource for source in sources for resource in source.resources.values()]


def _strapi_collection(base_url: str, token: str, collection: str):
    """One Strapi collection, a page at a time. The vendored source's helper does the same but
    only ever over https, and a self-hosted Strapi is often plain http on a local network."""
    from dlt.sources.helpers import requests

    page_size = 100  # Strapi's default upper limit
    start = 0
    while True:
        response = requests.get(
            f"{base_url}/api/{collection}",
            headers={"Authorization": f"Bearer {token}"},
            params={"pagination[start]": start, "pagination[limit]": page_size, "pagination[withCount]": 1},
        )
        body = response.json()
        rows = body.get("data") or []
        if isinstance(rows, dict):  # a single type, not a collection
            yield rows
            return
        yield from rows
        start += page_size
        if not rows or start >= body.get("meta", {}).get("pagination", {}).get("total", 0):
            return


def _build_strapi(settings: dict):
    import dlt

    domain = required(settings, "domain", "Domain").rstrip("/")
    base_url = domain if re.match(r"^https?://", domain) else f"https://{domain}"
    token = required(settings, "api_secret_key", "API token")
    endpoints = lines(settings, "endpoints")
    if not endpoints:
        raise ValueError("Collections is required.")
    return [
        dlt.resource(_strapi_collection(base_url, token, name), name=name, write_disposition="replace")
        for name in endpoints
    ]


def _build_mux(settings: dict):
    from verified_sources.mux import assets_resource, views_resource

    credentials = {
        "mux_api_access_token": required(settings, "access_token_id", "Access token ID"),
        "mux_api_secret_key": required(settings, "secret_key", "Secret key"),
    }
    return [assets_resource(**credentials), views_resource(**credentials)]


def _build_kafka(settings: dict):
    from verified_sources.kafka import KafkaCredentials, kafka_consumer

    topics = lines(settings, "topics")
    if not topics:
        raise ValueError("Topics is required.")
    credentials = KafkaCredentials()
    credentials.bootstrap_servers = required(settings, "bootstrap_servers", "Bootstrap servers")
    credentials.group_id = text(settings, "group_id", "pawpawbi")
    credentials.security_protocol = text(settings, "security_protocol", "SASL_SSL")
    credentials.sasl_mechanisms = None
    credentials.sasl_username = None
    credentials.sasl_password = None
    if credentials.security_protocol.startswith("SASL"):
        credentials.sasl_mechanisms = text(settings, "sasl_mechanisms", "PLAIN")
        credentials.sasl_username = required(settings, "sasl_username", "Username / API key")
        credentials.sasl_password = required(settings, "sasl_password", "Password / API secret")
    credentials.resolve()

    kwargs = {}
    start_from = date(settings, "start_from")
    if start_from:
        kwargs["start_from"] = start_from
    batch_size = integer(settings, "batch_size")
    if batch_size:
        kwargs["batch_size"] = batch_size
    return kafka_consumer(topics=topics, credentials=credentials, **kwargs)


def _build_kinesis(settings: dict):
    from dlt.common.configuration.specs import AwsCredentials

    from verified_sources.kinesis import kinesis_stream

    credentials = AwsCredentials()
    credentials.aws_access_key_id = required(settings, "aws_access_key_id", "Access key ID")
    credentials.aws_secret_access_key = required(settings, "aws_secret_access_key", "Secret access key")
    credentials.region_name = required(settings, "region_name", "Region")
    credentials.resolve()

    start_date = date(settings, "start_date")
    kwargs = {}
    max_messages = integer(settings, "max_number_of_messages")
    if max_messages:
        kwargs["max_number_of_messages"] = max_messages
    return kinesis_stream(
        stream_name=required(settings, "stream_name", "Stream name"),
        credentials=credentials,
        # None reads everything still retained in the stream; the source default (0) only reads new messages.
        initial_at_timestamp=start_date,
        parse_json=boolean(settings, "parse_json", True),
        **kwargs,
    )


def _build_mongodb(settings: dict):
    from verified_sources.mongodb import mongodb

    kwargs = {}
    limit = integer(settings, "limit")
    if limit:
        kwargs["limit"] = limit
    filter_ = json_object(settings, "filter")
    if filter_:
        kwargs["filter_"] = filter_
    return mongodb(
        connection_url=required(settings, "connection_url", "Connection string"),
        database=text(settings, "database"),
        collection_names=lines(settings, "collection_names") or None,
        write_disposition="replace",
        parallel=False,
        **kwargs,
    )


CONNECTORS: list[Connector] = [
    Connector(
        id="github",
        name="GitHub",
        category=DEVELOPER,
        description="Issues, pull requests, reactions, comments, stargazers and recent events for a repository.",
        docs_url="https://dlthub.com/docs/dlt-ecosystem/verified-sources/github",
        keywords=["git", "issues", "pull requests", "repository"],
        fields=[
            Field("owner", "Owner", required=True, placeholder="dlt-hub", help="The user or organisation that owns the repository."),
            Field("repo", "Repository", required=True, placeholder="dlt"),
            Field(
                "access_token",
                "Access token",
                type="password",
                secret=True,
                help="A GitHub personal access token. Needed for private repositories and for issues, pull requests, reactions and stargazers; without one only a public repository's recent events load.",
            ),
            Field("max_items", "Maximum items per table", type="number", advanced=True, help="Leave empty to load everything."),
        ],
        build=_build_github,
    ),
    Connector(
        id="strapi",
        name="Strapi",
        category=DEVELOPER,
        description="Entries from the Strapi CMS collections you choose, one table per collection.",
        docs_url="https://dlthub.com/docs/dlt-ecosystem/verified-sources/strapi",
        keywords=["cms", "headless cms", "content"],
        fields=[
            Field(
                "domain",
                "Domain",
                required=True,
                placeholder="cms.example.com",
                help="The address of your Strapi server. Start it with http:// if the server has no HTTPS.",
            ),
            Field(
                "api_secret_key",
                "API token",
                type="password",
                required=True,
                secret=True,
                help="In the Strapi admin panel go to Settings > API Tokens and create a read-only token.",
            ),
            Field(
                "endpoints",
                "Collections",
                type="textarea",
                required=True,
                placeholder="articles\ncategories",
                help="The API IDs (plural) of the collections to load, one per line, as they appear in /api/<name>.",
            ),
        ],
        build=_build_strapi,
    ),
    Connector(
        id="mux",
        name="Mux",
        category=DEVELOPER,
        description="Video assets and yesterday's video views from Mux Video and Mux Data.",
        docs_url="https://dlthub.com/docs/dlt-ecosystem/verified-sources/mux",
        keywords=["video", "streaming", "views"],
        fields=[
            Field(
                "access_token_id",
                "Access token ID",
                required=True,
                help="In the Mux dashboard go to Settings > Access Tokens and create a token with Mux Video and Mux Data read access.",
            ),
            Field("secret_key", "Secret key", type="password", required=True, secret=True, help="Shown once, when you create the access token."),
        ],
        build=_build_mux,
    ),
    Connector(
        id="kafka",
        name="Kafka",
        category=DEVELOPER,
        description="Messages currently stored in Kafka topics (including Confluent Cloud), one table per topic.",
        docs_url="https://dlthub.com/docs/dlt-ecosystem/verified-sources/kafka",
        keywords=["streaming", "events", "confluent", "messages", "topics"],
        fields=[
            Field(
                "bootstrap_servers",
                "Bootstrap servers",
                required=True,
                placeholder="pkc-xxxxx.us-east-1.aws.confluent.cloud:9092",
                help="Host and port of one or more brokers, comma-separated. In Confluent Cloud it's under Cluster settings.",
            ),
            Field(
                "topics",
                "Topics",
                type="textarea",
                required=True,
                help="Topic names, one per line.",
            ),
            Field(
                "security_protocol",
                "Security protocol",
                type="select",
                default="SASL_SSL",
                options=[
                    Option("SASL_SSL", "SASL_SSL (Confluent Cloud and most hosted Kafka)"),
                    Option("SASL_PLAINTEXT", "SASL_PLAINTEXT"),
                    Option("SSL", "SSL"),
                    Option("PLAINTEXT", "PLAINTEXT (no authentication)"),
                ],
            ),
            Field(
                "sasl_mechanisms",
                "SASL mechanism",
                type="select",
                default="PLAIN",
                options=[
                    Option("PLAIN", "PLAIN"),
                    Option("SCRAM-SHA-256", "SCRAM-SHA-256"),
                    Option("SCRAM-SHA-512", "SCRAM-SHA-512"),
                ],
                help="Only used with SASL protocols.",
                advanced=True,
            ),
            Field("sasl_username", "Username / API key", help="For Confluent Cloud, a cluster API key."),
            Field("sasl_password", "Password / API secret", type="password", secret=True),
            Field("start_from", "Messages from", type="date", help="Leave empty to read every message the topics still hold."),
            Field("group_id", "Consumer group ID", default="pawpawbi", placeholder="pawpawbi", advanced=True),
            Field("batch_size", "Batch size", type="number", placeholder="3000", advanced=True),
        ],
        packages=["confluent-kafka==2.15.1"],
        build=_build_kafka,
    ),
    Connector(
        id="kinesis",
        name="Amazon Kinesis",
        category=DEVELOPER,
        description="Messages retained in an Amazon Kinesis data stream, parsed from JSON into columns.",
        docs_url="https://dlthub.com/docs/dlt-ecosystem/verified-sources/amazon_kinesis",
        keywords=["aws", "amazon", "streaming", "events", "data streams"],
        fields=[
            Field("stream_name", "Stream name", required=True),
            Field("region_name", "Region", required=True, placeholder="us-east-1"),
            Field(
                "aws_access_key_id",
                "Access key ID",
                required=True,
                help="Create an access key for an IAM user with Kinesis read permissions (e.g. AmazonKinesisReadOnlyAccess) in the AWS console under IAM > Users > Security credentials.",
            ),
            Field("aws_secret_access_key", "Secret access key", type="password", required=True, secret=True),
            Field("start_date", "Messages from", type="date", help="Leave empty to read every message the stream still retains."),
            Field("max_number_of_messages", "Maximum messages", type="number", advanced=True, help="Leave empty for no limit."),
            Field(
                "parse_json",
                "Messages are JSON",
                type="checkbox",
                default=True,
                help="Turn off to load the raw message bytes in a \"data\" column.",
                advanced=True,
            ),
        ],
        packages=["botocore==1.43.108"],
        build=_build_kinesis,
    ),
    Connector(
        id="mongodb",
        name="MongoDB",
        category=DATABASES,
        description="Documents from every collection (or the collections you choose) in a MongoDB database.",
        docs_url="https://dlthub.com/docs/dlt-ecosystem/verified-sources/mongodb",
        keywords=["mongo", "atlas", "nosql", "documents", "database"],
        fields=[
            Field(
                "connection_url",
                "Connection string",
                type="password",
                required=True,
                secret=True,
                placeholder="mongodb+srv://user:password@cluster0.example.mongodb.net/mydb",
                help="In MongoDB Atlas click Connect > Drivers on your cluster and copy the connection string, filling in your password.",
            ),
            Field("database", "Database", help="Leave empty to use the database named in the connection string."),
            Field(
                "collection_names",
                "Collections",
                type="textarea",
                help="One per line. Leave empty to load every collection.",
            ),
            Field("limit", "Maximum documents per collection", type="number", advanced=True, help="Leave empty to load everything."),
            Field(
                "filter",
                "Filter (JSON)",
                type="textarea",
                placeholder='{"status": "active"}',
                help="A MongoDB query filter applied to every collection.",
                advanced=True,
            ),
        ],
        packages=["pymongo==4.18.2"],
        build=_build_mongodb,
    ),
]
