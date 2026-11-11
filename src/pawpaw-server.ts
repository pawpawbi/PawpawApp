// Talking to the PawpawBI server: accounts, organisations and published reports. The server
// hands out presigned S3 URLs; report files go straight to S3, gzipped. The API is in
// docs/pawpaw-server-api.md. No Electron imports, so this is tested with plain Node against the
// stand-in server (scripts/pawpaw-server-stub.mjs, tests/node/pawpaw-server.test.ts).
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import type { PublishTarget, ReportVisibility } from './shared/types';

export interface ServerAccount {
  id: string;
  email: string;
  /** Whether the address has been verified, through the link emailed to it. */
  emailVerified: boolean;
}

export interface ServerReport {
  id: string;
  title: string;
  url: string;
  /** The organisation it belongs to, and the account that published it (null if not sent). */
  orgId: string | null;
  publishedBy: string | null;
  visibility: ReportVisibility | null;
  publishedAt: string | null;
  refreshedAt: string | null;
}

export const REPORT_VISIBILITIES: readonly ReportVisibility[] = [
  'link',
  'org',
  'restricted',
];

const ROLES = ['viewer', 'editor', 'admin', 'owner'] as const;
type Role = (typeof ROLES)[number];

/** An organisation the account is a member of, with its role there. */
export interface ServerOrg {
  id: string;
  name: string;
  personal: boolean;
  role: Role;
}

/** A file to upload, as the server is told about it. */
export interface UploadFile {
  path: string;
  contentType: string;
  /** Bytes, gzipped. */
  size: number;
  /** SHA-256 of the gzipped bytes, base64. */
  sha256: string;
}

/** Where to PUT one file, and the headers the URL is signed with. */
export interface Upload {
  path: string;
  url: string;
  headers: Record<string, string>;
}

/** A report's current files: a presigned download URL for each. */
export interface ReportFiles {
  report: ServerReport;
  files: { path: string; url: string }[];
  expiresAt: string;
}

/** A report, organisation or account ID from the server, safe to put in a URL path. */
export const REPORT_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** What the server refused, with its status and error code (the API's error table). */
export class PawpawServerError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = 'PawpawServerError';
    this.status = status;
    this.code = code;
  }
}

/** upload_complete found files of the version missing from S3: upload them again. */
export class MissingFilesError extends PawpawServerError {
  readonly missing: string[];

  constructor(message: string, missing: string[]) {
    super(message, 409, 'missing_files');
    this.name = 'MissingFilesError';
    this.missing = missing;
  }
}

/** The server said the token is missing or no longer valid: sign in again. */
export class SignedOutError extends PawpawServerError {
  constructor(message = 'Sign in to PawpawBI again.') {
    super(message, 401, 'unauthorized');
    this.name = 'SignedOutError';
  }
}

/**
 * The report isn't there for this account any more: deleted, or the account lost access to it
 * (the server answers both with 404, so IDs can't be probed).
 */
export const isGone = (error: unknown) =>
  error instanceof PawpawServerError && error.status === 404;

/** The error code for a status, when the server didn't send one. */
const CODES: Record<number, string> = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  429: 'too_many_requests',
};

/** A report's pass: random, base64url. */
const PASS = /^[A-Za-z0-9_-]{20,200}$/;

/**
 * Where a browser opens a report signed in: the viewer's own page on the report's host, with the
 * pass in the fragment, which never leaves the browser (docs/pawpaw-server-api.md, "Signing in to
 * view").
 */
export function signedInUrl(reportUrl: string, pass: string): string {
  const url = new URL('_pawpaw/signed-in', reportUrl);
  url.hash = pass;
  return url.href;
}

/** Where published reports are viewed: each on its own host, `https://<report id>.<this>/`. */
export const REPORT_DOMAIN = 'pawpawreports.com';

/**
 * A web address the app may open, show or send to: https, or loopback (the stand-in). With
 * `reportId`, only that report's own host (or `<id>.localhost` in development): a project
 * file's `published.json` can't make the app open some other site as "the report".
 */
export function isReportUrl(
  value: unknown,
  reportId?: string,
): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    if (reportId !== undefined) {
      const host = `${reportId.toLowerCase()}.`;
      return (
        (url.protocol === 'https:' && url.hostname === host + REPORT_DOMAIN) ||
        (url.protocol === 'http:' && url.hostname === host + 'localhost')
      );
    }
    // Plain HTTP only on this computer (development: reports are at <id>.localhost).
    return (
      url.protocol === 'https:' ||
      (url.protocol === 'http:' &&
        (url.hostname === '127.0.0.1' ||
          url.hostname === 'localhost' ||
          url.hostname.endsWith('.localhost')))
    );
  } catch {
    return false;
  }
}

/** A site file ready to upload: what the server is told, and the gzipped body to PUT. */
export function packFile(
  path: string,
  contents: Uint8Array,
  contentType: string,
): { file: UploadFile; body: Buffer } {
  const body = gzipSync(contents);
  return {
    file: {
      path,
      contentType,
      size: body.length,
      sha256: createHash('sha256').update(body).digest('base64'),
    },
    body,
  };
}

const bad = (what: string) =>
  new Error(`PawpawBI sent ${what} the app doesn’t understand.`);

function cleanAccount(value: unknown): ServerAccount {
  const a = value as Partial<ServerAccount> | null;
  if (typeof a?.id !== 'string' || typeof a?.email !== 'string') {
    throw bad('an account');
  }
  return { id: a.id, email: a.email, emailVerified: a.emailVerified === true };
}

function cleanReport(value: unknown): ServerReport {
  const r = value as Partial<ServerReport> | null;
  if (
    !REPORT_ID.test(String(r?.id ?? '')) ||
    !isReportUrl(r?.url, String(r!.id))
  ) {
    throw bad('a report');
  }
  const time = (t: unknown) => (typeof t === 'string' ? t : null);
  const id = (v: unknown) =>
    typeof v === 'string' && REPORT_ID.test(v) ? v : null;
  return {
    id: String(r!.id),
    title: String(r!.title ?? ''),
    url: r!.url!,
    orgId: id(r!.orgId),
    publishedBy: id(r!.publishedBy),
    visibility: REPORT_VISIBILITIES.includes(r!.visibility as ReportVisibility)
      ? (r!.visibility as ReportVisibility)
      : null,
    publishedAt: time(r!.publishedAt),
    refreshedAt: time(r!.refreshedAt),
  };
}

/** The organisations in a GET /orgs answer, skipping any that don't make sense. */
function cleanOrgs(value: unknown): ServerOrg[] {
  const orgs = Array.isArray(value) ? value : [];
  return orgs.flatMap((o): ServerOrg[] =>
    REPORT_ID.test(String(o?.id ?? '')) &&
    typeof o?.name === 'string' &&
    ROLES.includes(o?.role)
      ? [
          {
            id: o.id,
            name: o.name.slice(0, 100),
            personal: o.personal === true,
            role: o.role,
          },
        ]
      : [],
  );
}

/** The organisations an account may publish to: editor or above. */
export const publishTargets = (orgs: ServerOrg[]): PublishTarget[] =>
  orgs.flatMap((o) =>
    o.role === 'viewer'
      ? []
      : [{ ...o, role: o.role as PublishTarget['role'] }],
  );

/** The uploads for `files`: one each, to an https URL, with only string headers. */
function cleanUploads(value: unknown, files: UploadFile[]): Upload[] {
  const uploads = Array.isArray(value) ? value : [];
  return files.map((file) => {
    const u = uploads.find((x) => x?.path === file.path);
    if (!u || !isReportUrl(u.url)) throw bad('an upload');
    const headers = Object.fromEntries(
      Object.entries((u.headers ?? {}) as Record<string, unknown>).filter(
        (h): h is [string, string] => typeof h[1] === 'string',
      ),
    );
    return { path: file.path, url: u.url, headers };
  });
}

export function pawpawServer(
  baseUrl: string,
  token: string | null = null,
  fetchImpl: typeof fetch = fetch,
) {
  const base = baseUrl.replace(/\/+$/, '');

  async function call(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Record<string, unknown> | null> {
    let response: Response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        method,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new Error(
        'Couldn’t reach PawpawBI. Check your internet connection and try again.',
      );
    }
    if (response.status === 204) return null;
    let json: Record<string, unknown> | null = null;
    try {
      json = await response.json();
    } catch {
      // Not JSON: described by the status below.
    }
    if (!response.ok) {
      const error = (json?.error ?? {}) as {
        message?: unknown;
        code?: unknown;
        missing?: unknown;
      };
      const text =
        typeof error.message === 'string' && error.message
          ? error.message
          : `PawpawBI had a problem (${response.status}). Try again in a moment.`;
      if (response.status === 401) throw new SignedOutError(text);
      if (response.status === 409 && Array.isArray(error.missing)) {
        throw new MissingFilesError(
          text,
          error.missing.filter((m): m is string => typeof m === 'string'),
        );
      }
      throw new PawpawServerError(
        text,
        response.status,
        typeof error.code === 'string'
          ? error.code
          : (CODES[response.status] ?? 'internal'),
      );
    }
    return json;
  }

  const signedIn = async (request: Promise<Record<string, unknown> | null>) => {
    const body = await request;
    if (typeof body?.token !== 'string' || !body.token) {
      throw new Error('PawpawBI didn’t send a sign-in token.');
    }
    return { token: body.token, account: cleanAccount(body.account) };
  };

  const checkedId = (id: string) => {
    if (!REPORT_ID.test(id)) throw new Error('Invalid report ID.');
    return id;
  };

  const withUploads = (
    body: Record<string, unknown> | null,
    files: UploadFile[],
  ) => ({
    report: cleanReport(body?.report),
    version: checkedId(String(body?.version ?? '')),
    uploads: cleanUploads(body?.uploads, files),
  });

  return {
    signUp: (email: string, password: string) =>
      signedIn(call('POST', '/auth/sign-up', { email, password })),
    signIn: (email: string, password: string) =>
      signedIn(call('POST', '/auth/sign-in', { email, password })),
    signOut: async () => {
      await call('POST', '/auth/sign-out');
    },
    account: async () => cleanAccount((await call('GET', '/account'))?.account),

    /** The account's organisations, its personal workspace first. */
    orgs: async () => cleanOrgs((await call('GET', '/orgs'))?.orgs),

    /**
     * A pass that opens report `id` in a browser as the signed-in account, and the report's
     * address it goes to (POST /reports/<id>/pass). 404 if the account can't open the report.
     */
    reportPass: async (id: string) => {
      const body = await call('POST', `/reports/${checkedId(id)}/pass`);
      const pass = body?.pass;
      const url = body?.url;
      if (
        typeof pass !== 'string' ||
        !PASS.test(pass) ||
        !isReportUrl(url, id)
      ) {
        throw new Error(
          'PawpawBI sent an unexpected answer. Try again in a moment.',
        );
      }
      return { pass, url };
    },

    /**
     * Creates a report, with upload URLs for its site's files: in `where.orgId` (the personal
     * workspace when left out), open to `where.visibility` (the server's default when left out).
     */
    createReport: async (
      title: string,
      files: UploadFile[],
      where: { orgId?: string; visibility?: ReportVisibility } = {},
    ) =>
      withUploads(
        await call('POST', '/reports', {
          title,
          files,
          ...(where.orgId ? { orgId: checkedId(where.orgId) } : {}),
          ...(where.visibility ? { visibility: where.visibility } : {}),
        }),
        files,
      ),

    /** A new version of a report: the whole site, or only its data files. */
    updateReport: async (
      id: string,
      scope: 'site' | 'data',
      files: UploadFile[],
    ) =>
      withUploads(
        await call('POST', `/reports/${checkedId(id)}`, { scope, files }),
        files,
      ),

    /**
     * Tells the server every file of `version` is uploaded: it checks they're all in S3 and makes
     * it the report's current version. Throws MissingFilesError if some aren't there.
     */
    completeUpload: async (id: string, version: string) =>
      cleanReport(
        (
          await call('POST', `/reports/${checkedId(id)}/upload_complete`, {
            version: checkedId(version),
          })
        )?.report,
      ),

    /** The report's current version, with a download URL per file. */
    getReport: async (id: string): Promise<ReportFiles> => {
      const body = await call('GET', `/reports/${checkedId(id)}`);
      const files = Array.isArray(body?.files) ? body.files : [];
      return {
        report: cleanReport(body?.report),
        files: files.filter(
          (f): f is { path: string; url: string } =>
            typeof f?.path === 'string' && isReportUrl(f?.url),
        ),
        expiresAt: String(body?.expiresAt ?? ''),
      };
    },

    /** PUTs one gzipped file to its presigned URL (S3: no sign-in token is sent). */
    putFile: async (upload: Upload, body: Uint8Array) => {
      let response: Response;
      try {
        response = await fetchImpl(upload.url, {
          method: 'PUT',
          headers: upload.headers,
          body: new Uint8Array(body),
          signal: AbortSignal.timeout(300_000),
        });
      } catch {
        throw new Error(
          `Couldn’t upload ${upload.path}. Check your internet connection and try again.`,
        );
      }
      if (!response.ok) {
        throw new Error(
          `Uploading ${upload.path} failed (${response.status}). Try publishing again.`,
        );
      }
    },
  };
}

export type PawpawServer = ReturnType<typeof pawpawServer>;

/**
 * PUTs every file of `uploads` (the files in `packed`) to its presigned URL, a few at a time,
 * reporting the bytes sent so far as each file finishes.
 */
export async function uploadFiles(
  server: PawpawServer,
  packed: { file: UploadFile; body: Uint8Array }[],
  uploads: Upload[],
  onProgress: (sent: number, total: number) => void = () => {},
  concurrency = 4,
) {
  const bodies = new Map(packed.map((p) => [p.file.path, p.body]));
  const queue = [...uploads];
  const total = queue.reduce((sum, u) => sum + bodies.get(u.path)!.length, 0);
  let sent = 0;
  onProgress(0, total);
  const worker = async () => {
    for (let upload = queue.shift(); upload; upload = queue.shift()) {
      const body = bodies.get(upload.path)!;
      await server.putFile(upload, body);
      sent += body.length;
      onProgress(sent, total);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
}
