# Adding data

How data sources work, the Add data screen, and notes on setting up each connector.

## How it works

- A **data source** is one connector and its settings. Loading it writes one or more **tables**
  into the project.
- **Every load is a full refresh:** the source's tables are replaced with what the source has
  now. After a load, the app re-applies in-place transforms, rebuilds transformed tables and
  refreshes the report's datasets.
- **Table names** come from the source (sheet, file, database table or API resource), as lowercase
  letters, digits and underscores. Nested lists in records (common in JSON and business apps)
  become extra child tables named `parent__child`. No two sources may load a table with the same
  name: a load that would overwrite another source's table is refused.
- **Secret settings** (passwords, API keys, tokens, JSON keys) are stored encrypted on this
  computer, never in the project. You can't set them: add the source without them, then the user
  types them into the source's form (Add data, then **Edit** on the source) and tells you when
  they have. Connecting to a source needs them, so wait until then.
- **Extra packages.** Some connectors download their own packages the first time they're used
  (the gallery says "Downloads on first use"). That needs the internet once and can take a
  minute.
- **On another computer**, a project keeps its data, but loading asks for passwords again, and
  file paths may need choosing again.
- Only the file connectors and SQLite have been tested with real data so far. If another
  connector fails, say what the error says and suggest checking its settings and its docs
  (**Docs ↗** in its form).

## The Add data screen

- **Data** lists the project's sources. Each has **Load** (the first time) or **Refresh**,
  **Edit** and **Remove** ("Remove this source and its tables?").
- **+ Add data source** opens **Add a data source**: every connector, with a search box and a tab
  per category. The overview also suggests common ones and **Browse all connectors**.
- Setting up a source has three steps, shown at the top of its form:
  1. **Connect:** the source's name and settings (**Show advanced settings** for rarely needed
     ones), then **Connect**.
  2. **Choose tables:** tick the tables to load (**Select all**, **None**, and a filter box when
     there are many), then **Load _n_ tables**.
  3. **Load:** progress, then the loaded tables with **Preview →**, and a reminder to save the
     project.
- Connecting, loading and Refresh all show how long they've been running and, after 5 seconds,
  a **Stop** button. Once the data has arrived it says "Data loaded, now processing…" and can't
  be stopped, so tables are never left half-written.
- A table deleted on Model data comes back the next time its source loads, unless it's unticked
  in the source's **Edit** screen.

## With your tools

1. `list_connectors` with a search finds the connector, its id and its setting keys (which are
   secret, which are required).
2. `add_source` with the connector id, a name and the non-secret settings. The user is always
   asked.
3. If it has secret settings, ask the user to enter them and wait.
4. `discover_tables` connects and lists the tables it can load (for databases, this is also the
   connection test).
5. `load_source` with the tables to load (without them, the ones chosen last time). It can't be
   undone and big sources take a while. Then say what loaded and ask what's next.

`edit_source` renames a source or changes its non-secret settings (changing settings is always
asked about). `remove_source` removes a source and its tables, and is refused while other tables
read them.

## Connector notes

Where to find credentials and what to watch for. Settings not mentioned are explained in the
connector's form.

### Files

- **Files on this computer** (`local_files`): CSV and TSV (delimiter and column types such as dates are detected), Excel `.xlsx`/`.xlsm` (one table per sheet, first row is the header, formulas give the value last calculated in Excel), JSON, JSON Lines, Parquet. Old `.xls` isn't supported: save it as `.xlsx`.
- **Folder of files** (`folder`): Combines matching files into one table (CSV, JSON Lines or Parquet).
- **File from a web address** (`url`): Format from the extension, then the server's content type, then the content. JSON wrappers like `{"data": [...]}` are unwrapped. The whole file is downloaded.

### Cloud storage

- **Amazon S3** (`s3`): Also S3-compatible services, with the custom endpoint.
- **Google Cloud Storage** (`gcs`): A service account's JSON key.
- **Azure Blob Storage** (`azure_blob`): An account key or a SAS token.
- **SFTP server** (`sftp`): A password or a private key file.

### Databases

Connecting lists the database's tables, which also tests the connection.

- **SQLite** (`sqlite`): A database file on this computer.
- **MySQL / MariaDB** (`mysql`), **PostgreSQL** (`postgres`), **Amazon Redshift** (`redshift`), **CockroachDB** (`cockroachdb`): Host, port, database, username and password. MySQL and MariaDB `BOOLEAN` columns arrive as 0/1 integers, which is how those servers store them.
- **Trino / Starburst** (`trino`): Host, port, username, password, a catalog and a schema in it (Trino has no default schema).
- **Microsoft SQL Server** (`sqlserver`): No ODBC driver needed.
- **Oracle Database** (`oracle`): No Oracle client needed. The Database field takes the service name. Whole-number `NUMBER(n)` columns arrive as decimals.
- **Snowflake** (`snowflake`): Username and password only (no key pair or single sign-on).
- **Google BigQuery** (`bigquery`): A service account's JSON key.
- **Databricks** (`databricks`): A personal access token.
- **ClickHouse** (`clickhouse`): The HTTP(S) interface; the default port is 8443.
- **MongoDB** (`mongodb`): A connection string; optionally which collections, a row limit and a JSON filter. Nested documents become `parent__field` columns and arrays become child tables; `Decimal128` values arrive as text (cast them in a transform).

### Business apps and APIs

- **Salesforce** (`salesforce`): Username, password and security token. Sandbox orgs aren't supported.
- **HubSpot** (`hubspot`): A private app's access token. Web analytics events aren't loaded.
- **Pipedrive** (`pipedrive`): A personal API token.
- **Google Ads** (`google_ads`): A service account plus a developer token. Campaigns have only IDs and labels.
- **Google Analytics** (`google_analytics`): A service account. Three reports by default (traffic sources, pages, countries and devices), editable as JSON under advanced settings.
- **Facebook Ads** (`facebook_ads`): An access token with `ads_read`; the leads table also needs `leads_retrieval`.
- **Bing Webmaster Tools** (`bing_webmaster`): An API key and the sites. Query stats only when page addresses are given.
- **Matomo** (`matomo`): Reports and visits. Without a start date, reports go back to 2000, which is slow with the daily period: set one.
- **Stripe** (`stripe_analytics`): A restricted, read-only key is best. Stripe keeps events for 30 days only.
- **Shopify** (`shopify_dlt`): An Admin API token. The default API version is too old for Shopify now: if loads fail, set a newer one under advanced settings.
- **Airtable** (`airtable`): A personal access token.
- **Asana** (`asana`): A personal access token.
- **Notion** (`notion`): An integration secret. Pages must be shared with the integration. Loading pages can be slow on large workspaces.
- **Google Sheets** (`google_sheets`): A service account: share the sheet with its email address. Loads every tab and named range unless told otherwise.
- **Jira** (`jira`): The site, an email and an API token. An optional JQL query replaces the issues table.
- **Slack** (`slack`): A bot token. Access logs need a paid Slack plan.
- **Email inbox** (`inbox`): IMAP, with an app password rather than the account's password. The attachments table includes the files' contents.
- **Zendesk** (`zendesk`): An agent's email and an API token. Talk is optional; Zendesk Chat isn't available.
- **Freshdesk** (`freshdesk`): An API key.
- **Personio** (`personio`): A client ID and secret.
- **Workable** (`workable`): Optionally loads job and candidate details.
- **REST API** (`rest_api`): Any JSON API: a base address, endpoints, and a bearer token, API key or user name and password. Pagination is detected.
- **GitHub** (`github`): Without a token, only a public repository's recent events load. A token adds issues, pull requests, reactions, comments and stargazers, and private repositories.
- **Strapi** (`strapi`): An API token and the collection names.
- **Mux** (`mux`): Loads only the first 100 assets and yesterday's views.
- **Kafka** (`kafka`): Reads up to the messages that exist when the load starts. Connect shows one entry, `kafka_messages`, but the load writes one table per topic, named after the topic. Each row is one message: its text in `_kafka__data` (JSON stays as text; parse it in a transform), with `_kafka__topic`, `_kafka__partition`, `_kafka__offset` and the time in `_kafka__ts__value`.
- **Amazon Kinesis** (`kinesis`): Without a start date, reads everything the stream still keeps.

Not available: web scraping, Postgres change data capture, Zendesk Chat, old `.xls` files.
