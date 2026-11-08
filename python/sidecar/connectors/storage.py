"""Connectors for files in cloud storage, using dlt's filesystem source."""

from .base import CLOUD_STORAGE, Connector, Field, Option, gcp_service_account, integer, required, text

DLT_VERSION = "1.30.0"  # Must match python/requirements.txt.

FORMAT_FIELD = Field(
    "format",
    "File format",
    type="select",
    default="csv",
    options=[Option("csv", "CSV"), Option("jsonl", "JSON Lines"), Option("parquet", "Parquet")],
)
TABLE_FIELD = Field("table", "Table name", required=True, help="All matching files are combined into this table.")


def _pattern_field(example: str) -> Field:
    return Field(
        "pattern",
        "Files to include",
        placeholder=example,
        help="A pattern such as exports/2026/*.csv. ** includes subfolders. Defaults to every file of the chosen format.",
    )


def _load_files(bucket_url: str, settings: dict, credentials=None):
    from dlt.sources.filesystem import filesystem

    from .files import file_reader

    fmt = text(settings, "format", "csv")
    files = filesystem(
        bucket_url=bucket_url,
        credentials=credentials,
        file_glob=text(settings, "pattern", f"**/*.{fmt}"),
    )
    return (files | file_reader(fmt)).with_name(required(settings, "table", "Table name"))


def _bucket(scheme: str, settings: dict) -> str:
    bucket = required(settings, "bucket", "Bucket").strip("/")
    if "://" in bucket:
        return bucket
    return f"{scheme}://{bucket}"


def _build_s3(settings: dict):
    from dlt.common.configuration.specs import AwsCredentials

    credentials = AwsCredentials(
        aws_access_key_id=required(settings, "access_key_id", "Access key ID"),
        aws_secret_access_key=required(settings, "secret_access_key", "Secret access key"),
        region_name=text(settings, "region"),
        endpoint_url=text(settings, "endpoint_url"),
    )
    return _load_files(_bucket("s3", settings), settings, credentials)


def _build_gcs(settings: dict):
    return _load_files(_bucket("gs", settings), settings, gcp_service_account(settings, "service_account"))


def _build_azure(settings: dict):
    from dlt.common.configuration.specs import AzureCredentials

    credentials = AzureCredentials(
        azure_storage_account_name=required(settings, "account_name", "Storage account name"),
        azure_storage_account_key=text(settings, "account_key"),
        azure_storage_sas_token=text(settings, "sas_token"),
    )
    if not (credentials.azure_storage_account_key or credentials.azure_storage_sas_token):
        raise ValueError("Enter an account key or a SAS token.")
    container = required(settings, "container", "Container").strip("/")
    return _load_files(f"az://{container}", settings, credentials)


def _build_sftp(settings: dict):
    from dlt.common.configuration.specs import SFTPCredentials

    host = required(settings, "host", "Host")
    folder = text(settings, "folder", "").strip("/")
    credentials = SFTPCredentials(
        sftp_port=integer(settings, "port", 22),
        sftp_username=required(settings, "username", "Username"),
        sftp_password=text(settings, "password"),
        sftp_key_filename=text(settings, "key_file"),
        sftp_key_passphrase=text(settings, "key_passphrase"),
    )
    return _load_files(f"sftp://{host}/{folder}", settings, credentials)


CONNECTORS: list[Connector] = [
    Connector(
        id="s3",
        name="Amazon S3",
        category=CLOUD_STORAGE,
        description="Files in an S3 bucket or any S3-compatible storage (MinIO, Cloudflare R2, Wasabi…).",
        docs_url="https://dlthub.com/docs/dlt-ecosystem/verified-sources/filesystem",
        keywords=["aws", "bucket", "minio", "r2", "wasabi"],
        packages=[f"dlt[s3]=={DLT_VERSION}", "s3fs==2026.9.0"],
        fields=[
            Field("bucket", "Bucket", required=True, placeholder="my-bucket/path"),
            Field("access_key_id", "Access key ID", required=True, help="From AWS IAM: Users → Security credentials → Access keys."),
            Field("secret_access_key", "Secret access key", type="password", secret=True, required=True),
            Field("region", "Region", placeholder="ap-southeast-2", advanced=True),
            Field("endpoint_url", "Custom endpoint", placeholder="https://…", advanced=True, help="Only for S3-compatible services that aren't AWS."),
            FORMAT_FIELD,
            _pattern_field("exports/*.csv"),
            TABLE_FIELD,
        ],
        build=_build_s3,
    ),
    Connector(
        id="gcs",
        name="Google Cloud Storage",
        category=CLOUD_STORAGE,
        description="Files in a Google Cloud Storage bucket.",
        docs_url="https://dlthub.com/docs/dlt-ecosystem/verified-sources/filesystem",
        keywords=["gcp", "google", "bucket"],
        packages=[f"dlt[gs]=={DLT_VERSION}", "gcsfs==2026.10.0"],
        fields=[
            Field("bucket", "Bucket", required=True, placeholder="my-bucket/path"),
            Field(
                "service_account",
                "Service account key (JSON)",
                type="textarea",
                secret=True,
                required=True,
                help="In Google Cloud console: IAM → Service accounts → Keys → Add key → JSON. Paste the file's contents.",
            ),
            FORMAT_FIELD,
            _pattern_field("exports/*.csv"),
            TABLE_FIELD,
        ],
        build=_build_gcs,
    ),
    Connector(
        id="azure_blob",
        name="Azure Blob Storage",
        category=CLOUD_STORAGE,
        description="Files in an Azure Blob Storage or Data Lake Storage container.",
        docs_url="https://dlthub.com/docs/dlt-ecosystem/verified-sources/filesystem",
        keywords=["microsoft", "adls", "data lake", "container"],
        packages=[f"dlt[az]=={DLT_VERSION}", "adlfs==2026.8.0"],
        fields=[
            Field("account_name", "Storage account name", required=True),
            Field("container", "Container", required=True, placeholder="my-container/path"),
            Field("account_key", "Account key", type="password", secret=True, help="Storage account → Access keys. Or use a SAS token instead."),
            Field("sas_token", "SAS token", type="password", secret=True, advanced=True),
            FORMAT_FIELD,
            _pattern_field("exports/*.csv"),
            TABLE_FIELD,
        ],
        build=_build_azure,
    ),
    Connector(
        id="sftp",
        name="SFTP server",
        category=CLOUD_STORAGE,
        description="Files on an SFTP server.",
        docs_url="https://dlthub.com/docs/dlt-ecosystem/verified-sources/filesystem",
        keywords=["ssh", "ftp", "server"],
        packages=[f"dlt[sftp]=={DLT_VERSION}", "paramiko==4.0.0"],
        fields=[
            Field("host", "Host", required=True, placeholder="sftp.example.com"),
            Field("port", "Port", type="number", default="22", advanced=True),
            Field("username", "Username", required=True),
            Field("password", "Password", type="password", secret=True),
            Field("key_file", "Private key file", type="file", advanced=True, help="Use instead of a password for key-based login."),
            Field("key_passphrase", "Key passphrase", type="password", secret=True, advanced=True),
            Field("folder", "Folder", placeholder="/exports"),
            FORMAT_FIELD,
            _pattern_field("*.csv"),
            TABLE_FIELD,
        ],
        build=_build_sftp,
    ),
]
