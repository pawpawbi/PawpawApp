"""SQL database connectors, using dlt's sql_database source (SQLAlchemy). Each database's
driver is downloaded on first use; SQLite needs nothing extra."""

from typing import Callable

from .base import DATABASES, Connector, Field, integer, json_object, lines, required, text

DOCS = "https://dlthub.com/docs/dlt-ecosystem/verified-sources/sql_database"


def _schema_and_tables(settings: dict) -> dict:
    options = {}
    if schema := text(settings, "schema"):
        options["schema"] = schema
    if tables := lines(settings, "tables"):
        options["table_names"] = tables
    return options


def _sql_source(credentials, settings: dict):
    """credentials: a SQLAlchemy URL or Engine."""
    from dlt.sources.sql_database import sql_database
    from sqlalchemy import create_engine
    from sqlalchemy.engine import URL

    # dlt takes an Engine but not a URL object. Building URLs with URL.create (rather than
    # formatting strings) keeps passwords with special characters correctly escaped.
    if isinstance(credentials, URL):
        credentials = create_engine(credentials)
    # Reflecting the schema connects to the database, so this also tests the connection.
    return sql_database(credentials=credentials, **_schema_and_tables(settings))


def _url_builder(drivername: str, default_port: int | None) -> Callable[[dict], object]:
    """For databases that take host, port, database, username and password."""

    def build(settings: dict):
        from sqlalchemy.engine import URL

        url = URL.create(
            drivername,
            username=text(settings, "username"),
            password=text(settings, "password"),
            host=required(settings, "host", "Host"),
            port=integer(settings, "port", default_port),
            database=text(settings, "database"),
        )
        return _sql_source(url, settings)

    return build


def _server_fields(default_port: int, database_required: bool = True, database_label: str = "Database") -> list[Field]:
    return [
        Field("host", "Host", required=True, placeholder="db.example.com"),
        Field("port", "Port", type="number", default=str(default_port)),
        Field("database", database_label, required=database_required),
        Field("username", "Username", required=True),
        Field("password", "Password", type="password", secret=True),
    ]


SCHEMA_FIELD = Field("schema", "Schema", advanced=True, help="Leave empty for the default schema.")
TABLES_FIELD = Field(
    "tables",
    "Only these tables",
    type="textarea",
    advanced=True,
    help="One table name per line. Leave empty to list every table; you choose which to load in the next step.",
)


def _build_sqlite(settings: dict):
    from pathlib import Path

    from sqlalchemy.engine import URL

    path = Path(required(settings, "file", "Database file"))
    if not path.is_file():
        raise ValueError(f"File not found: {path}")
    return _sql_source(URL.create("sqlite", database=str(path)), settings)


def _build_oracle(settings: dict):
    from sqlalchemy.engine import URL

    # The Database field is the service name. Put in the URL's database position it would be
    # taken for a SID, which no modern Oracle listener registers.
    url = URL.create(
        "oracle+oracledb",
        username=required(settings, "username", "Username"),
        password=text(settings, "password"),
        host=required(settings, "host", "Host"),
        port=integer(settings, "port", 1521),
        query={"service_name": required(settings, "database", "Database")},
    )
    return _sql_source(url, settings)


def _build_snowflake(settings: dict):
    from sqlalchemy.engine import URL

    database = required(settings, "database", "Database")
    if schema := text(settings, "schema"):
        database = f"{database}/{schema}"
    query = {k: v for k in ("warehouse", "role") if (v := text(settings, k))}
    url = URL.create(
        "snowflake",
        username=required(settings, "username", "Username"),
        password=text(settings, "password"),
        host=required(settings, "account", "Account identifier"),
        database=database,
        query=query,
    )
    return _sql_source(url, {**settings, "schema": None})


def _build_bigquery(settings: dict):
    from sqlalchemy import create_engine

    project = required(settings, "project", "Project ID")
    dataset = required(settings, "dataset", "Dataset")
    key = json_object(settings, "service_account")
    if key is None:
        raise ValueError("A service account key is required.")
    engine = create_engine(f"bigquery://{project}/{dataset}", credentials_info=key)
    return _sql_source(engine, settings)


def _build_databricks(settings: dict):
    from sqlalchemy import create_engine
    from sqlalchemy.engine import URL

    query = {"http_path": required(settings, "http_path", "HTTP path")}
    if catalog := text(settings, "catalog"):
        query["catalog"] = catalog
    if schema := text(settings, "schema"):
        query["schema"] = schema
    url = URL.create(
        "databricks",
        username="token",
        password=required(settings, "token", "Access token"),
        host=required(settings, "host", "Server hostname"),
        query=query,
    )
    # The Databricks client retries a failed connection for up to 15 minutes by default, so a
    # wrong hostname would look like a hang. A few attempts are enough for a desktop app.
    engine = create_engine(url, connect_args={"_retry_stop_after_attempts_count": 3, "_socket_timeout": 30})
    return _sql_source(engine, {**settings, "schema": None})


def _build_trino(settings: dict):
    from sqlalchemy import create_engine
    from sqlalchemy.engine import URL

    password = text(settings, "password")
    port = integer(settings, "port", 443)
    url = URL.create(
        "trino",
        username=required(settings, "username", "Username"),
        password=password,
        host=required(settings, "host", "Host"),
        port=port,
        database=f"{required(settings, 'catalog', 'Catalog')}/{required(settings, 'schema', 'Schema')}",
    )
    # Trino only accepts a password over TLS, and its dialect doesn't take the scheme from the URL.
    scheme = "https" if password or port == 443 else "http"
    engine = create_engine(url, connect_args={"http_scheme": scheme})
    return _sql_source(engine, {**settings, "schema": None})


CONNECTORS: list[Connector] = [
    Connector(
        id="postgres",
        name="PostgreSQL",
        category=DATABASES,
        description="Tables and views from a PostgreSQL database, including Supabase, Neon and Amazon RDS/Aurora.",
        docs_url=DOCS,
        keywords=["postgres", "sql", "supabase", "neon", "rds", "aurora"],
        packages=["psycopg2-binary==2.9.13"],
        fields=[*_server_fields(5432), SCHEMA_FIELD, TABLES_FIELD],
        build=_url_builder("postgresql+psycopg2", 5432),
    ),
    Connector(
        id="mysql",
        name="MySQL / MariaDB",
        category=DATABASES,
        description="Tables and views from a MySQL or MariaDB database, including Amazon RDS and PlanetScale.",
        docs_url=DOCS,
        keywords=["mysql", "mariadb", "sql", "rds", "planetscale"],
        packages=["pymysql==1.2.3"],
        fields=[*_server_fields(3306), TABLES_FIELD],
        build=_url_builder("mysql+pymysql", 3306),
    ),
    Connector(
        id="sqlserver",
        name="Microsoft SQL Server",
        category=DATABASES,
        description="Tables and views from SQL Server or Azure SQL Database.",
        docs_url=DOCS,
        keywords=["mssql", "azure sql", "microsoft", "sql"],
        packages=["pymssql==2.4.2"],
        fields=[*_server_fields(1433), SCHEMA_FIELD, TABLES_FIELD],
        build=_url_builder("mssql+pymssql", 1433),
    ),
    Connector(
        id="oracle",
        name="Oracle Database",
        category=DATABASES,
        description="Tables and views from an Oracle database. No Oracle client installation needed.",
        docs_url=DOCS,
        keywords=["oracle", "sql"],
        packages=["oracledb==26.0.1"],
        fields=[*_server_fields(1521, database_label="Service name"), SCHEMA_FIELD, TABLES_FIELD],
        build=_build_oracle,
    ),
    Connector(
        id="sqlite",
        name="SQLite",
        category=DATABASES,
        description="Tables from a SQLite database file.",
        docs_url=DOCS,
        keywords=["sqlite", "db file", "sql"],
        fields=[
            Field("file", "Database file", type="file", required=True, file_filters=[("SQLite databases", ["db", "sqlite", "sqlite3"]), ("All files", ["*"])]),
            TABLES_FIELD,
        ],
        build=_build_sqlite,
    ),
    Connector(
        id="snowflake",
        name="Snowflake",
        category=DATABASES,
        description="Tables and views from a Snowflake data warehouse.",
        docs_url=DOCS,
        keywords=["warehouse", "snowflake", "sql"],
        packages=["snowflake-sqlalchemy==1.11.1"],
        fields=[
            Field("account", "Account identifier", required=True, placeholder="myorg-myaccount", help="From your Snowflake URL: <account>.snowflakecomputing.com."),
            Field("username", "Username", required=True),
            Field("password", "Password", type="password", secret=True),
            Field("database", "Database", required=True),
            Field("schema", "Schema", placeholder="PUBLIC"),
            Field("warehouse", "Warehouse"),
            Field("role", "Role", advanced=True),
            TABLES_FIELD,
        ],
        build=_build_snowflake,
    ),
    Connector(
        id="bigquery",
        name="Google BigQuery",
        category=DATABASES,
        description="Tables from a BigQuery dataset.",
        docs_url=DOCS,
        keywords=["google", "gcp", "warehouse", "bigquery"],
        packages=["sqlalchemy-bigquery==1.17.3"],
        fields=[
            Field("project", "Project ID", required=True),
            Field("dataset", "Dataset", required=True),
            Field(
                "service_account",
                "Service account key (JSON)",
                type="textarea",
                secret=True,
                required=True,
                help="In Google Cloud console: IAM → Service accounts → Keys → Add key → JSON. The account needs BigQuery Data Viewer and Job User roles.",
            ),
            TABLES_FIELD,
        ],
        build=_build_bigquery,
    ),
    Connector(
        id="redshift",
        name="Amazon Redshift",
        category=DATABASES,
        description="Tables and views from an Amazon Redshift data warehouse.",
        docs_url=DOCS,
        keywords=["aws", "warehouse", "redshift"],
        packages=["sqlalchemy-redshift==1.0.0", "psycopg2-binary==2.9.13"],
        fields=[*_server_fields(5439), SCHEMA_FIELD, TABLES_FIELD],
        build=_url_builder("redshift+psycopg2", 5439),
    ),
    Connector(
        id="databricks",
        name="Databricks",
        category=DATABASES,
        description="Tables from a Databricks SQL warehouse or cluster.",
        docs_url=DOCS,
        keywords=["lakehouse", "spark", "unity catalog", "delta"],
        packages=["databricks-sqlalchemy==2.0.10"],
        fields=[
            Field("host", "Server hostname", required=True, placeholder="adb-1234567890.1.azuredatabricks.net", help="SQL warehouse → Connection details."),
            Field("http_path", "HTTP path", required=True, placeholder="/sql/1.0/warehouses/abc123"),
            Field("token", "Access token", type="password", secret=True, required=True, help="User settings → Developer → Access tokens."),
            Field("catalog", "Catalog"),
            Field("schema", "Schema"),
            TABLES_FIELD,
        ],
        build=_build_databricks,
    ),
    Connector(
        id="clickhouse",
        name="ClickHouse",
        category=DATABASES,
        description="Tables from a ClickHouse database, including ClickHouse Cloud.",
        docs_url=DOCS,
        keywords=["clickhouse", "olap"],
        packages=["clickhouse-connect==1.9.0"],
        fields=[*_server_fields(8443), TABLES_FIELD],
        build=_url_builder("clickhousedb", 8443),
    ),
    Connector(
        id="trino",
        name="Trino / Starburst",
        category=DATABASES,
        description="Tables from a Trino or Starburst cluster.",
        docs_url=DOCS,
        keywords=["presto", "starburst", "trino", "federated"],
        packages=["trino[sqlalchemy]==0.340.0"],
        fields=[
            Field("host", "Host", required=True),
            Field("port", "Port", type="number", default="443"),
            Field("username", "Username", required=True),
            Field("password", "Password", type="password", secret=True),
            Field("catalog", "Catalog", required=True),
            Field(
                "schema",
                "Schema",
                required=True,
                placeholder="default",
                help="The schema in that catalog, such as default or public. Trino has no default schema.",
            ),
            TABLES_FIELD,
        ],
        build=_build_trino,
    ),
    Connector(
        id="cockroachdb",
        name="CockroachDB",
        category=DATABASES,
        description="Tables and views from a CockroachDB database.",
        docs_url=DOCS,
        keywords=["cockroach", "postgres", "sql"],
        packages=["sqlalchemy-cockroachdb==2.0.4", "psycopg2-binary==2.9.13"],
        fields=[*_server_fields(26257), SCHEMA_FIELD, TABLES_FIELD],
        build=_url_builder("cockroachdb+psycopg2", 26257),
    ),
]
