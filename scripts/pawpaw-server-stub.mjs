// A stand-in for the PawpawBI server (docs/pawpaw-server-api.md), for development and tests: the
// parts the app uses (accounts, publishing, refreshing), plus enough of organisations (roles,
// members by invitation, report visibility) to try who may do what, and verifying the email
// address. The "emails" (verification links and invitations) are kept in `emails` and printed when
// run on its own; there's no console to open their links. Not the web console's cookie, password
// resets or sessions. Its assistant gives the same short reply every time, within a pretend
// allowance of ASSISTANT_REPLIES replies, and needs a verified address. It gives out and renews passes for reports, and GET
// /reports/<id> takes them, but its viewer doesn't: there, only reports open to anyone with the
// link show. It also stands in for S3: it signs its own upload and download URLs
// (/s3/...), checks the signed headers and checksum on uploads, makes a version current on
// upload_complete once all its files are there, and serves a report that's open to anyone with
// the link at its own address, http://<id>.localhost:<port>/, directly, which the real viewer does
// with a service worker on https://<id>.<report domain>/. Everything is kept in memory and lost
// when it stops. Not for real use.
//
//   npm run server:stub          listens on http://127.0.0.1:8790 (PAWPAW_STUB_PORT to change)
//   then start the app with      PAWPAW_SERVER=http://127.0.0.1:8790/v1
import {
  createHash,
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
import http from 'node:http';
import { pathToFileURL } from 'node:url';

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const URL_LIFETIME = 15 * 60_000;
/** How long a pass opens its report, and how long it can be renewed for, from the first. */
const PASS_LIFETIME = 12 * 60 * 60_000;
const PASS_RENEWABLE_FOR = 7 * 24 * 60 * 60_000;
const ROLES = ['viewer', 'editor', 'admin', 'owner'];
const VISIBILITIES = ['link', 'org', 'restricted'];
const CODES = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
};
const newId = () => randomBytes(9).toString('base64url');

/** The assistant's one model, and how many replies an account gets (a month, for the real one). */
const ASSISTANT_MODEL = 'claude-sonnet-5-5';
const ASSISTANT_REPLIES = 20;
const ASSISTANT_MAX_TOKENS = 8192;

/** The stand-in assistant's reply, as Anthropic's event stream. */
function assistantReply() {
  const text =
    "This is the stand-in server's assistant. It gives this reply to every message.";
  const event = (type, data) =>
    `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  return [
    event('message_start', {
      message: {
        id: `msg_${newId()}`,
        type: 'message',
        role: 'assistant',
        model: ASSISTANT_MODEL,
        content: [],
        usage: { input_tokens: 10, output_tokens: 1 },
      },
    }),
    event('content_block_start', {
      index: 0,
      content_block: { type: 'text', text: '' },
    }),
    event('content_block_delta', {
      index: 0,
      delta: { type: 'text_delta', text },
    }),
    event('content_block_stop', { index: 0 }),
    event('message_delta', {
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: 20 },
    }),
    event('message_stop', {}),
  ].join('');
}
/** A report's ID, which is its host's first label: lowercase letters and digits. */
const newReportId = () => {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return [...randomBytes(16)]
    .map((b) => alphabet[b % alphabet.length])
    .join('');
};
const hash = (password, salt) => scryptSync(password, salt, 32);
const atLeast = (role, needed) =>
  role != null && ROLES.indexOf(role) >= ROLES.indexOf(needed);
/** An error the API answers with this status (and its code). */
const refuse = (status, message) =>
  Object.assign(new Error(message), { status });

/** A path relative to the site's root: no leading slash, backslash, "." or ".." parts. */
const safePath = (path) =>
  typeof path === 'string' &&
  path.length > 0 &&
  !path.startsWith('/') &&
  !path.includes('\\') &&
  path.split('/').every((part) => part && part !== '.' && part !== '..');

/** A file's object name: the version before its extension (data/sales.json -> data/sales.<v>.json). */
const versionedName = (path, version) =>
  path.replace(/(\.[^./]+)?$/, (extension) => `.${version}${extension}`);

/** `onEmail` is called with each email "sent": its kind ('verify' or 'invite'), who to, and the token its link would carry. */
export function startStubServer(port = 0, { onEmail = () => {} } = {}) {
  const secret = randomBytes(32);
  const users = new Map(); // email -> { id, salt, hash, verified }
  const tokens = new Map(); // token -> email
  const assistantReplies = new Map(); // email -> replies so far
  const links = new Map(); // email verification token -> email
  const invitations = new Map(); // invitation token -> { id, orgId, email, role, invitedBy, createdAt }
  const passes = new Map(); // pass -> { reportId, email, session (its token), expires, renewableUntil }
  const emails = []; // { kind, to, token }, oldest first
  const orgs = new Map(); // id -> { name, personalOf (user id or null), members: Map(user id -> role) }
  const objects = new Map(); // S3 key -> { body (gzipped), contentType }
  // id -> { orgId, publishedBy, visibility, title, versions, current, deleted, publishedAt, refreshedAt }
  const reports = new Map();
  let origin = '';
  let listening = 0; // the port it's on

  const sign = (method, key, expires, extra = '') =>
    createHmac('sha256', secret)
      .update(`${method}\n${key}\n${expires}\n${extra}`)
      .digest('base64url');
  const presign = (method, key, extra = '') => {
    const expires = Date.now() + URL_LIFETIME;
    return `${origin}/s3/${encodeURIComponent(key)}?${new URLSearchParams({
      expires: String(expires),
      sig: sign(method, key, expires, extra),
    })}`;
  };
  const expiresAt = () => new Date(Date.now() + URL_LIFETIME).toISOString();

  // --- Who may do what (the server's src/authz.rs rules) ----------------------------------

  const roleIn = (orgId, userId) =>
    (userId && orgs.get(orgId)?.members.get(userId)) ?? null;

  /** The org if `userId` is a member with at least `needed`: 404 for outsiders, 403 below it. */
  const orgFor = (orgId, userId, needed, refusal) => {
    const org = ID.test(String(orgId)) ? orgs.get(orgId) : undefined;
    const role = org ? roleIn(orgId, userId) : null;
    if (!role) throw refuse(404, 'There’s no organisation with that ID.');
    if (!atLeast(role, needed)) throw refuse(403, refusal);
    return { org, role };
  };

  /**
   * The report if `userId` (null: not signed in) may view or edit it. No access at all is 404
   * (401 when not signed in); seeing it without the right role is 403.
   */
  const reportFor = (id, userId, action) => {
    const entry = ID.test(id) ? reports.get(id) : undefined;
    if (!entry || entry.deleted)
      throw refuse(404, 'There’s no report with that ID.');
    const role = roleIn(entry.orgId, userId);
    const publisher = role != null && entry.publishedBy === userId;
    const canView =
      entry.visibility === 'link' ||
      (entry.visibility === 'org' && role != null) ||
      (entry.visibility === 'restricted' &&
        (publisher || atLeast(role, 'admin')));
    if (!canView)
      throw userId
        ? refuse(404, 'There’s no report with that ID.')
        : refuse(401, 'Sign in to open this report.');
    if (
      action === 'edit' &&
      !(atLeast(role, 'admin') || (role === 'editor' && publisher))
    )
      throw refuse(
        403,
        'You can only change reports you published. Ask an admin of the organisation.',
      );
    return entry;
  };

  // --- Reports and their versions ---------------------------------------------------------

  /**
   * upload_complete: makes `version` current if all its new files are in S3. Returns the paths
   * still missing (nothing changes then).
   */
  const complete = (entry, version) => {
    const index = entry.versions.findIndex((v) => v.id === version);
    if (index === -1) throw refuse(400, 'That isn’t a version of this report.');
    if (index < entry.current)
      throw refuse(409, 'A newer version is already live.');
    const v = entry.versions[index];
    const missing = [...v.table]
      .filter(([, key]) => v.fresh.has(key) && !objects.has(key))
      .map(([path]) => path);
    if (missing.length) return missing;
    if (index > entry.current) {
      const now = new Date().toISOString();
      if (v.scope === 'site') entry.publishedAt = now;
      entry.refreshedAt = now;
      entry.current = index;
    }
    return [];
  };
  const reportOf = (id, entry) => ({
    id,
    title: entry.title,
    url: `http://${id}.localhost:${listening}/`,
    orgId: entry.orgId,
    publishedBy: entry.publishedBy,
    visibility: entry.visibility,
    publishedAt: entry.publishedAt ?? null,
    refreshedAt: entry.refreshedAt ?? null,
  });

  /** Adds a version: its file table (path -> key), and the uploads for its new files. */
  const newVersion = (id, entry, scope, files) => {
    if (!Array.isArray(files) || files.length === 0)
      throw refuse(400, 'List the files to upload.');
    if (files.length > 1000)
      throw refuse(400, 'At most 1,000 files per version.');
    const version = newId();
    const table = new Map(
      scope === 'data' ? entry.versions[entry.current].table : [],
    );
    const fresh = new Set();
    const uploads = [];
    for (const f of files) {
      if (!safePath(f?.path)) throw refuse(400, `Unsafe path: ${f?.path}`);
      if (scope === 'data' && !/^data\/[^/]+\.json$/.test(f.path))
        throw refuse(400, `Only data files can be refreshed: ${f.path}`);
      if (typeof f.sha256 !== 'string' || typeof f.contentType !== 'string')
        throw refuse(400, `Give a content type and checksum for ${f.path}.`);
      if (!(f.size > 0 && f.size <= 25 * 1024 * 1024))
        throw refuse(400, `${f.path} is too big.`);
      const key = `reports/${id}/${versionedName(f.path, version)}`;
      table.set(f.path, key);
      fresh.add(key);
      uploads.push({
        path: f.path,
        url: presign('PUT', key, `${f.contentType}\n${f.sha256}`),
        headers: {
          'Content-Type': f.contentType,
          'Content-Encoding': 'gzip',
          'x-amz-checksum-sha256': f.sha256,
        },
      });
    }
    entry.versions.push({ id: version, scope, table, fresh });
    return { version, uploads };
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, origin);
    const send = (
      status,
      body,
      headers = { 'Content-Type': 'application/json' },
    ) => {
      res.writeHead(status, headers);
      res.end(Buffer.isBuffer(body) ? body : JSON.stringify(body));
    };
    const fail = (status, message) =>
      send(status, { error: { code: CODES[status] ?? 'internal', message } });
    const noContent = () => res.writeHead(204).end();
    const body = async () => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      return Buffer.concat(chunks);
    };
    const json = async () => {
      try {
        return JSON.parse((await body()).toString('utf8') || '{}');
      } catch {
        return {};
      }
    };
    // Like S3's CORS rule for the viewer: anyone may read a report's files.
    const serveObject = (object) =>
      send(200, object.body, {
        'Content-Type': object.contentType,
        'Content-Encoding': 'gzip',
        'Access-Control-Allow-Origin': '*',
      });

    try {
      // --- The stand-in for S3 --------------------------------------------------------------
      const s3 = /^\/s3\/(.+)$/.exec(url.pathname);
      if (s3) {
        const key = decodeURIComponent(s3[1]);
        const expires = Number(url.searchParams.get('expires'));
        if (!(expires > Date.now())) return fail(403, 'Request has expired.');
        if (req.method === 'PUT') {
          const type = req.headers['content-type'] ?? '';
          const sha = req.headers['x-amz-checksum-sha256'] ?? '';
          if (
            url.searchParams.get('sig') !==
            sign('PUT', key, expires, `${type}\n${sha}`)
          )
            return fail(403, 'Signature does not match.');
          if (req.headers['content-encoding'] !== 'gzip')
            return fail(400, 'Content-Encoding must be gzip.');
          const data = await body();
          if (createHash('sha256').update(data).digest('base64') !== sha)
            return fail(400, 'Checksum does not match.');
          objects.set(key, { body: data, contentType: type });
          return send(200, Buffer.alloc(0), {});
        }
        if (req.method === 'GET') {
          if (url.searchParams.get('sig') !== sign('GET', key, expires))
            return fail(403, 'Signature does not match.');
          const object = objects.get(key);
          return object ? serveObject(object) : fail(404, 'No such key.');
        }
      }

      // --- The viewer: http://<id>.localhost:<port>/<path>, from the current version ---------
      // Viewers don't sign in, so only reports open to anyone with the link show.
      const viewed = /^([a-z0-9]{1,63})\.localhost(:\d+)?$/.exec(
        req.headers.host ?? '',
      );
      if (req.method === 'GET' && viewed) {
        const entry = reports.get(viewed[1]);
        const path = decodeURIComponent(url.pathname.slice(1));
        const key =
          entry &&
          !entry.deleted &&
          entry.visibility === 'link' &&
          entry.current >= 0
            ? entry.versions[entry.current].table.get(path || 'index.html')
            : undefined;
        const object = key && objects.get(key);
        return object ? serveObject(object) : fail(404, 'Not found.');
      }

      // --- The API --------------------------------------------------------------------------
      const route = url.pathname.replace(/^\/v1/, '');
      const accountOf = (email) => ({
        id: users.get(email).id,
        email,
        name: null,
        emailVerified: users.get(email).verified,
      });
      /** "Emails" a new verification link; the old one stops working. */
      const sendLink = (email) => {
        for (const [token, to] of links) if (to === email) links.delete(token);
        const token = randomBytes(24).toString('base64url');
        links.set(token, email);
        emails.push({ kind: 'verify', to: email, token });
        onEmail({ kind: 'verify', to: email, token });
      };
      const signIn = (email) => {
        const token = randomBytes(24).toString('hex');
        tokens.set(token, email);
        return { token, account: accountOf(email) };
      };
      if (req.method === 'POST' && route === '/auth/sign-up') {
        const { email, password } = await json();
        if (typeof email !== 'string' || !/^\S+@\S+\.\S+$/.test(email))
          return fail(400, 'Enter a valid email address.');
        if (typeof password !== 'string' || password.length < 8)
          return fail(400, 'Use a password of at least 8 characters.');
        if (users.has(email))
          return fail(409, 'There’s already an account with that email.');
        const salt = randomBytes(16);
        const id = newId();
        users.set(email, {
          id,
          salt,
          hash: hash(password, salt),
          verified: false,
        });
        // Every account has a personal workspace.
        orgs.set(newId(), {
          name: 'Personal',
          personalOf: id,
          members: new Map([[id, 'owner']]),
        });
        sendLink(email);
        return send(201, signIn(email));
      }
      if (req.method === 'POST' && route === '/auth/sign-in') {
        const { email, password } = await json();
        const user = users.get(email);
        if (
          !user ||
          typeof password !== 'string' ||
          !timingSafeEqual(user.hash, hash(password, user.salt))
        )
          return fail(401, 'That email and password don’t match an account.');
        return send(200, signIn(email));
      }

      // The console, with a link's token; no sign-in needed.
      if (req.method === 'POST' && route === '/auth/verify-email') {
        const { token } = await json();
        const email = links.get(token);
        if (!email)
          return fail(
            400,
            'This link has expired or has already been used. Sign in to send a new one.',
          );
        users.get(email).verified = true;
        links.delete(token);
        return noContent();
      }

      // Every other request: signed in, or (only for opening a report) not. A report's pass is
      // never a session; only GET /reports/<id> and renewing it read one.
      const header = req.headers.authorization;
      const pass = header?.startsWith('Pass ') ? header.slice(5).trim() : null;
      const email =
        header && !pass
          ? tokens.get(header.replace(/^Bearer /, ''))
          : undefined;
      if (header && !pass && !email)
        return fail(401, 'Sign in to PawpawBI again.');
      const userId = email ? users.get(email).id : null;
      /** Who a pass stands for on report `id`, if it's good to 'open' it or 'renew' it. */
      const passHolder = (id, use) => {
        const held = pass ? passes.get(pass) : undefined;
        if (!held || held.reportId !== id || !tokens.has(held.session))
          return null;
        const until = use === 'renew' ? held.renewableUntil : held.expires;
        return Date.now() < until ? held : null;
      };
      const newPass = (reportId, holder, session, renewableUntil) => {
        const until = renewableUntil ?? Date.now() + PASS_RENEWABLE_FOR;
        const expires = Math.min(Date.now() + PASS_LIFETIME, until);
        const value = randomBytes(32).toString('base64url');
        passes.set(value, {
          reportId,
          email: holder,
          session,
          expires,
          renewableUntil: until,
        });
        return {
          pass: value,
          url: `http://${reportId}.localhost:${listening}/`,
          expiresAt: new Date(expires).toISOString(),
        };
      };

      const reportRoute = /^\/reports\/([^/]+)$/.exec(route);
      if (req.method === 'GET' && reportRoute) {
        res.setHeader('Access-Control-Allow-Origin', '*');
        // A pass that no longer works counts as no sign-in.
        const holder = passHolder(reportRoute[1], 'open');
        const viewer = holder ? users.get(holder.email).id : userId;
        const entry = reportFor(reportRoute[1], viewer, 'view');
        if (entry.current < 0)
          return fail(404, 'There’s no published report with that ID.');
        return send(200, {
          report: reportOf(reportRoute[1], entry),
          files: [...entry.versions[entry.current].table].map(
            ([path, key]) => ({
              path,
              url: presign('GET', key),
            }),
          ),
          expiresAt: expiresAt(),
        });
      }

      const renewRoute = /^\/reports\/([^/]+)\/pass\/renew$/.exec(route);
      if (req.method === 'POST' && renewRoute) {
        const holder = passHolder(renewRoute[1], 'renew');
        if (!holder) return fail(401, 'Sign in to open this report.');
        reportFor(renewRoute[1], users.get(holder.email).id, 'view');
        passes.delete(pass);
        return send(
          200,
          newPass(
            renewRoute[1],
            holder.email,
            holder.session,
            holder.renewableUntil,
          ),
        );
      }

      if (!email) return fail(401, 'Sign in to PawpawBI again.');
      const passRoute = /^\/reports\/([^/]+)\/pass$/.exec(route);
      if (req.method === 'POST' && passRoute) {
        reportFor(passRoute[1], userId, 'view');
        return send(
          200,
          newPass(passRoute[1], email, header.replace(/^Bearer /, '')),
        );
      }
      if (req.method === 'POST' && route === '/auth/sign-out') {
        tokens.delete(header.replace(/^Bearer /, ''));
        return noContent();
      }
      if (req.method === 'GET' && route === '/account') {
        return send(200, { account: accountOf(email) });
      }
      if (req.method === 'POST' && route === '/auth/send-verification') {
        if (!users.get(email).verified) sendLink(email);
        return noContent();
      }

      // --- The assistant ---
      const nextMonth = () => {
        const now = new Date();
        return new Date(
          Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
        ).toISOString();
      };
      if (req.method === 'GET' && route === '/assistant') {
        const used = assistantReplies.get(email) ?? 0;
        return send(200, {
          models: [ASSISTANT_MODEL],
          maxTokens: ASSISTANT_MAX_TOKENS,
          usage: {
            share: Math.min(1, used / ASSISTANT_REPLIES),
            resetsAt: nextMonth(),
          },
        });
      }
      if (req.method === 'POST' && route === '/assistant/messages') {
        if (!users.get(email).verified) {
          return send(403, {
            error: {
              code: 'email_not_verified',
              message:
                'Verify your email address first: open the link we emailed you.',
            },
          });
        }
        const request = await json();
        if (
          request.model !== ASSISTANT_MODEL ||
          request.stream !== true ||
          !(request.max_tokens <= ASSISTANT_MAX_TOKENS) ||
          !Array.isArray(request.messages)
        ) {
          return fail(400, 'The request needs the model, stream and messages.');
        }
        const used = assistantReplies.get(email) ?? 0;
        if (used >= ASSISTANT_REPLIES) {
          return send(429, {
            error: {
              code: 'allowance_used',
              message: "You've used this month's free assistant.",
            },
          });
        }
        assistantReplies.set(email, used + 1);
        return send(200, Buffer.from(assistantReply()), {
          'Content-Type': 'text/event-stream',
        });
      }

      // --- Organisations and members ---
      const orgOut = (id, org) => ({
        id,
        name: org.name,
        personal: org.personalOf != null,
        role: org.members.get(userId),
        createdAt: new Date(0).toISOString(),
      });
      if (req.method === 'GET' && route === '/orgs') {
        const mine = [...orgs]
          .filter(([, org]) => org.members.has(userId))
          .map(([id, org]) => orgOut(id, org))
          .sort(
            (a, b) =>
              Number(b.personal) - Number(a.personal) ||
              a.name.localeCompare(b.name),
          );
        return send(200, { orgs: mine });
      }
      if (req.method === 'POST' && route === '/orgs') {
        const { name } = await json();
        if (typeof name !== 'string' || !name.trim() || name.length > 100)
          return fail(
            400,
            'Give the organisation a name of up to 100 characters.',
          );
        const id = newId();
        const org = {
          name: name.trim(),
          personalOf: null,
          members: new Map([[userId, 'owner']]),
        };
        orgs.set(id, org);
        return send(201, { org: orgOut(id, org) });
      }
      const memberRoute = /^\/orgs\/([^/]+)\/members\/([^/]+)$/.exec(route);
      const manage = (orgId) => {
        const found = orgFor(
          orgId,
          userId,
          'admin',
          'Only admins and owners can manage members.',
        );
        if (found.org.personalOf)
          throw refuse(403, 'Your personal workspace is just for you.');
        return found;
      };
      const assignable = (actor, from, to) =>
        actor === 'owner' || (from !== 'owner' && to !== 'owner');
      const invitationsRoute = /^\/orgs\/([^/]+)\/invitations$/.exec(route);
      if (req.method === 'POST' && invitationsRoute) {
        const { org, role } = manage(invitationsRoute[1]);
        if (!users.get(email).verified)
          return send(403, {
            error: {
              code: 'email_not_verified',
              message: 'Verify your email address first.',
            },
          });
        const { email: invited, role: given } = await json();
        if (typeof invited !== 'string' || !/^\S+@\S+\.\S+$/.test(invited))
          return fail(400, 'Enter a valid email address.');
        if (!ROLES.includes(given)) return fail(400, 'Choose a role.');
        if (!assignable(role, null, given))
          return fail(403, 'Only owners can invite owners.');
        const to = invited.trim().toLowerCase();
        if (users.has(to) && org.members.has(users.get(to).id))
          return fail(409, 'They’re already a member.');
        for (const [token, i] of invitations)
          if (i.orgId === invitationsRoute[1] && i.email === to)
            invitations.delete(token);
        const token = randomBytes(24).toString('base64url');
        const invitation = {
          id: newId(),
          orgId: invitationsRoute[1],
          email: to,
          role: given,
          invitedBy: userId,
          createdAt: new Date().toISOString(),
        };
        invitations.set(token, invitation);
        emails.push({ kind: 'invite', to, token });
        onEmail({ kind: 'invite', to, token });
        return send(201, {
          invitation: {
            id: invitation.id,
            email: to,
            role: given,
            invitedBy: userId,
            createdAt: invitation.createdAt,
            expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
          },
        });
      }
      if (req.method === 'POST' && route === '/invitations/accept') {
        const { token } = await json();
        const invitation = invitations.get(token);
        if (!invitation)
          return fail(
            400,
            'This invitation has expired, been used or been cancelled.',
          );
        if (invitation.email !== email)
          return fail(
            403,
            `This invitation is for ${invitation.email}. Sign in with that address to accept it.`,
          );
        const org = orgs.get(invitation.orgId);
        if (!org.members.has(userId)) org.members.set(userId, invitation.role);
        users.get(email).verified = true;
        invitations.delete(token);
        return send(200, { org: orgOut(invitation.orgId, org) });
      }
      if (req.method === 'PATCH' && memberRoute) {
        const { org, role } = manage(memberRoute[1]);
        const { role: given } = await json();
        const current = org.members.get(memberRoute[2]);
        if (!current) return fail(404, 'They’re not a member.');
        if (!ROLES.includes(given)) return fail(400, 'Choose a role.');
        if (!assignable(role, current, given))
          return fail(403, 'Only owners can change an owner’s role.');
        org.members.set(memberRoute[2], given);
        return send(200, { member: { id: memberRoute[2], role: given } });
      }
      if (req.method === 'DELETE' && memberRoute) {
        const leaving = memberRoute[2] === userId;
        const { org, role } = leaving
          ? orgFor(memberRoute[1], userId, 'viewer', '')
          : manage(memberRoute[1]);
        const current = org.members.get(memberRoute[2]);
        if (!current) return fail(404, 'They’re not a member.');
        if (!leaving && current === 'owner' && role !== 'owner')
          return fail(403, 'Only owners can remove an owner.');
        const owners = [...org.members.values()].filter((r) => r === 'owner');
        if (current === 'owner' && owners.length === 1)
          return fail(409, 'An organisation needs an owner.');
        org.members.delete(memberRoute[2]);
        return noContent();
      }

      // --- Reports ---
      /** Publishing needs a verified address, like the assistant. */
      const unverified = () =>
        send(403, {
          error: {
            code: 'email_not_verified',
            message:
              'Verify your email address first: open the link we emailed you.',
          },
        });
      if (req.method === 'POST' && route === '/reports') {
        if (!users.get(email).verified) return unverified();
        const { title, files, orgId, visibility } = await json();
        const personal = [...orgs].find(([, o]) => o.personalOf === userId)[0];
        const where = orgId ?? personal;
        const { org } = orgFor(
          where,
          userId,
          'editor',
          'Viewers can’t publish reports. Ask an admin to make you an editor.',
        );
        if (visibility !== undefined && !VISIBILITIES.includes(visibility))
          return fail(400, 'visibility must be "link", "org" or "restricted".');
        const id = newReportId();
        const entry = {
          orgId: where,
          publishedBy: userId,
          visibility: visibility ?? (org.personalOf ? 'link' : 'org'),
          title: String(title ?? 'Report').slice(0, 200),
          versions: [],
          current: -1,
        };
        const { version, uploads } = newVersion(id, entry, 'site', files);
        reports.set(id, entry);
        return send(201, {
          report: reportOf(id, entry),
          version,
          uploads,
          expiresAt: expiresAt(),
        });
      }
      if (req.method === 'POST' && reportRoute) {
        if (!users.get(email).verified) return unverified();
        const entry = reportFor(reportRoute[1], userId, 'edit');
        const { scope, files } = await json();
        if (scope !== 'site' && scope !== 'data')
          return fail(400, 'scope must be "site" or "data".');
        if (scope === 'data' && entry.current < 0)
          return fail(409, 'Publish the site before refreshing its data.');
        const { version, uploads } = newVersion(
          reportRoute[1],
          entry,
          scope,
          files,
        );
        return send(200, {
          report: reportOf(reportRoute[1], entry),
          version,
          uploads,
          expiresAt: expiresAt(),
        });
      }
      if (req.method === 'PATCH' && reportRoute) {
        const entry = reportFor(reportRoute[1], userId, 'edit');
        const { title, visibility } = await json();
        if (visibility !== undefined && !VISIBILITIES.includes(visibility))
          return fail(400, 'visibility must be "link", "org" or "restricted".');
        if (title !== undefined) entry.title = String(title).slice(0, 200);
        if (visibility !== undefined) entry.visibility = visibility;
        return send(200, { report: reportOf(reportRoute[1], entry) });
      }
      if (req.method === 'DELETE' && reportRoute) {
        reportFor(reportRoute[1], userId, 'edit').deleted = true;
        return noContent();
      }
      const completeRoute = /^\/reports\/([^/]+)\/upload_complete$/.exec(route);
      if (req.method === 'POST' && completeRoute) {
        const entry = reportFor(completeRoute[1], userId, 'edit');
        const { version } = await json();
        const missing = complete(entry, version);
        if (missing.length) {
          return send(409, {
            error: {
              code: 'missing_files',
              message: `${missing.length} ${missing.length === 1 ? 'file hasn’t' : 'files haven’t'} been uploaded yet.`,
              missing,
            },
          });
        }
        return send(200, { report: reportOf(completeRoute[1], entry) });
      }
      return fail(404, 'Not found.');
    } catch (error) {
      return fail(error.status ?? 400, error.message);
    }
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      listening = server.address().port;
      origin = `http://127.0.0.1:${listening}`;
      resolve({
        url: `${origin}/v1`,
        origin,
        emails,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { url } = await startStubServer(
    Number(process.env.PAWPAW_STUB_PORT ?? 8790),
    {
      onEmail: ({ kind, to, token }) =>
        console.log(
          kind === 'invite'
            ? `Invitation to ${to}: accept, signed in as them, with POST /v1/invitations/accept {"token": "${token}"}`
            : `Email to ${to}: verify with POST /v1/auth/verify-email {"token": "${token}"}`,
        ),
    },
  );
  console.log(`Stand-in PawpawBI server: ${url}`);
  console.log(`Start the app with PAWPAW_SERVER=${url}`);
}
