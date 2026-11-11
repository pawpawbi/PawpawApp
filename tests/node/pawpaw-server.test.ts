// The PawpawBI server client (src/pawpaw-server.ts) against the stand-in server, which also
// stands in for S3 (scripts/pawpaw-server-stub.mjs), and the published records
// (src/published-files.ts).
import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, test } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { startStubServer } from '../../scripts/pawpaw-server-stub.mjs';
import { pawpaw } from '../../src/assistant/pawpaw.ts';
import {
  isGone,
  isReportUrl,
  MissingFilesError,
  packFile,
  PawpawServerError,
  pawpawServer,
  publishTargets,
  SignedOutError,
  signedInUrl,
  uploadFiles,
  type PawpawServer,
} from '../../src/pawpaw-server.ts';
import {
  cleanList,
  cleanPublished,
  publishedFile,
  withEntry,
} from '../../src/published-files.ts';

let stub: {
  url: string;
  origin: string;
  emails: { kind: string; to: string; token: string }[];
  close: () => Promise<void>;
};

before(async () => {
  stub = await startStubServer(0);
});

after(() => stub.close());

const pack = (files: Record<string, string>) =>
  Object.entries(files).map(([path, text]) =>
    packFile(
      path,
      Buffer.from(text),
      path.endsWith('.json') ? 'application/json' : 'text/html',
    ),
  );

/** Starts a version, PUTs every file to its presigned URL and completes it, as the app does. */
async function upload(
  server: PawpawServer,
  packed: ReturnType<typeof pack>,
  start: (
    files: ReturnType<typeof pack>[number]['file'][],
  ) => ReturnType<PawpawServer['createReport']>,
) {
  const { report, version, uploads } = await start(packed.map((p) => p.file));
  for (const u of uploads) {
    await server.putFile(u, packed.find((p) => p.file.path === u.path)!.body);
  }
  return server.completeUpload(report.id, version);
}

/**
 * A GET's body, unzipped, or its status when it isn't 200. Sent to 127.0.0.1 with the URL's host
 * in the Host header: browsers send every *.localhost address to this computer themselves, but
 * Windows only resolves some of them.
 */
const fetchText = (url: string | URL) =>
  new Promise<string>((resolve, reject) => {
    const target = new URL(url);
    http
      .get(
        {
          host: '127.0.0.1',
          port: target.port,
          path: `${target.pathname}${target.search}`,
          headers: { host: target.host },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => {
            const body = Buffer.concat(chunks);
            if (response.statusCode !== 200) resolve(`${response.statusCode}`);
            else if (response.headers['content-encoding'] === 'gzip')
              resolve(gunzipSync(body).toString());
            else resolve(body.toString());
          });
        },
      )
      .on('error', reject);
  });

test('files are gzipped, with the size and checksum of what is sent', () => {
  const { file, body } = packFile(
    'index.html',
    Buffer.from('<h1>Hi</h1>'),
    'text/html',
  );
  assert.equal(gunzipSync(body).toString(), '<h1>Hi</h1>');
  assert.equal(file.size, body.length);
  assert.match(file.sha256, /^[A-Za-z0-9+/]{43}=$/);
});

test('signing up, signing in and out', async () => {
  const server = pawpawServer(stub.url);
  const { token, account } = await server.signUp(
    'ana@example.com',
    'long enough',
  );
  assert.equal(account.email, 'ana@example.com');
  await assert.rejects(
    server.signUp('ana@example.com', 'long enough'),
    /already/,
  );
  await assert.rejects(
    server.signUp('bo@example.com', 'short'),
    /8 characters/,
  );
  await assert.rejects(
    server.signIn('ana@example.com', 'wrong password'),
    SignedOutError,
  );
  const again = await server.signIn('ana@example.com', 'long enough');
  assert.equal(
    (await pawpawServer(stub.url, again.token).account()).email,
    'ana@example.com',
  );

  await pawpawServer(stub.url, token).signOut();
  await assert.rejects(pawpawServer(stub.url, token).account(), SignedOutError);
});

test('the email address is verified through the emailed link, which the console opens', async () => {
  const { token, account } = await pawpawServer(stub.url).signUp(
    'verify@example.com',
    'long enough',
  );
  assert.equal(account.emailVerified, false);
  const email = stub.emails.findLast(
    (e) => e.kind === 'verify' && e.to === 'verify@example.com',
  );
  assert.ok(email, 'signing up emails a link');

  // What the console does with the link's token.
  const verify = (linkToken: string) =>
    fetch(`${stub.url}/auth/verify-email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: linkToken }),
    });
  assert.equal((await verify(email.token)).status, 204);
  assert.equal(
    (await pawpawServer(stub.url, token).account()).emailVerified,
    true,
  );
  assert.equal((await verify(email.token)).status, 400);
});

test('publishing uploads each file to S3, then upload_complete makes the version current', async () => {
  const { server } = await account('cy@example.com');
  const site = pack({
    'index.html': '<h1>Sales</h1>',
    'data/sales.json': '{"rows":[[1]]}',
  });

  const { report, version, uploads } = await server.createReport(
    'Sales',
    site.map((p) => p.file),
  );
  assert.ok(isReportUrl(report.url));
  // Each report on a host of its own (the stand-in's: <id>.localhost).
  assert.equal(new URL(report.url).hostname, `${report.id}.localhost`);
  assert.match(report.id, /^[a-z0-9]{16}$/);
  assert.equal(report.publishedAt, null);
  // Each file is stored under its own name with the version in it.
  const objectName = (url: string) =>
    decodeURIComponent(new URL(url).pathname).split('/').slice(-2).join('/');
  assert.deepEqual(
    uploads.map((u) => objectName(u.url)),
    [`${report.id}/index.${version}.html`, `data/sales.${version}.json`],
  );
  await server.putFile(uploads[0], site[0].body);

  // A file is missing: the server says which, and nothing changes.
  const incomplete = await server
    .completeUpload(report.id, version)
    .catch((e) => e);
  assert.ok(incomplete instanceof MissingFilesError);
  assert.deepEqual(incomplete.missing, ['data/sales.json']);
  await assert.rejects(server.getReport(report.id), /no published report/);

  await server.putFile(uploads[1], site[1].body);
  const completed = await server.completeUpload(report.id, version);
  assert.ok(completed.publishedAt);

  const current = await server.getReport(report.id);
  assert.deepEqual(current.files.map((f) => f.path).sort(), [
    'data/sales.json',
    'index.html',
  ]);
  assert.ok(
    current.files.every((f) =>
      decodeURIComponent(f.url).includes(`.${version}.`),
    ),
    'download URLs point at the versioned objects',
  );
  // Browsers get the files unzipped (Content-Encoding: gzip), from S3 or the viewer address.
  const index = current.files.find((f) => f.path === 'index.html')!;
  assert.equal(await fetchText(index.url), '<h1>Sales</h1>');
  assert.equal(await fetchText(report.url), '<h1>Sales</h1>');

  // While a new version uploads, viewers keep the current one.
  const pending = pack({ 'data/sales.json': '{"rows":[[9]]}' });
  const next = await server.updateReport(
    report.id,
    'data',
    pending.map((p) => p.file),
  );
  await server.putFile(next.uploads[0], pending[0].body);
  assert.equal(
    await fetchText(new URL('data/sales.json', report.url)),
    '{"rows":[[1]]}',
  );

  // A data refresh replaces only the data, and keeps the rest of the site.
  await upload(server, pack({ 'data/sales.json': '{"rows":[[2]]}' }), (files) =>
    server.updateReport(report.id, 'data', files),
  );
  assert.equal(
    await fetchText(new URL('data/sales.json', report.url)),
    '{"rows":[[2]]}',
  );
  assert.equal(await fetchText(report.url), '<h1>Sales</h1>');
  await assert.rejects(
    server.updateReport(
      report.id,
      'data',
      pack({ 'index.html': 'x' }).map((p) => p.file),
    ),
    /Only data files/,
  );

  // A site version replaces everything: files it doesn't list are gone.
  await upload(server, pack({ 'index.html': '<h1>New</h1>' }), (files) =>
    server.updateReport(report.id, 'site', files),
  );
  assert.equal(await fetchText(report.url), '<h1>New</h1>');
  assert.equal(await fetchText(new URL('data/sales.json', report.url)), '404');

  // The version left uncompleted above is older than the live one now: it can't come back.
  await assert.rejects(
    server.completeUpload(report.id, next.version),
    /newer version is already live/,
  );
});

test('S3 only takes the file the URL was signed for', async () => {
  const { server } = await account('di@example.com');
  const [packed] = pack({ 'index.html': 'real' });
  const { uploads } = await server.createReport('X', [packed.file]);
  const [other] = pack({ 'index.html': 'swapped' });
  await assert.rejects(
    server.putFile(uploads[0], other.body),
    /failed \(400\)/,
  );
  await assert.rejects(
    server.putFile(
      {
        ...uploads[0],
        headers: { ...uploads[0].headers, 'Content-Type': 'text/javascript' },
      },
      packed.body,
    ),
    /failed \(403\)/,
  );
});

test("other accounts can't change a report, and unsafe paths are refused", async () => {
  const owner = (await account('ed@example.com')).server;
  const report = await upload(owner, pack({ 'index.html': 'mine' }), (files) =>
    owner.createReport('Mine', files),
  );
  const other = (await account('fi@example.com')).server;
  // Anyone may open a report in a personal workspace (it's open to the link), but not change it.
  const refused = await other
    .updateReport(
      report.id,
      'site',
      pack({ 'index.html': 'theirs' }).map((p) => p.file),
    )
    .catch((e) => e);
  assert.ok(refused instanceof PawpawServerError);
  assert.equal(refused.status, 403);
  assert.equal(refused.code, 'forbidden');
  assert.match(refused.message, /only change reports you published/);
  assert.equal(isGone(refused), false);
  await assert.rejects(
    owner.createReport(
      'Bad',
      pack({ '../escape.html': 'x' }).map((p) => p.file),
    ),
    /Unsafe path/,
  );
  await assert.rejects(owner.getReport('../x'), /Invalid report ID/);
});

test('report links are HTTPS, or plain HTTP only on this computer', () => {
  assert.ok(isReportUrl('https://k3j9xq2mtb7w4zpa.pawpawreports.com/'));
  assert.ok(isReportUrl('http://k3j9xq2mtb7w4zpa.localhost:8002/'));
  assert.ok(isReportUrl('http://127.0.0.1:8790/'));
  assert.ok(!isReportUrl('http://example.com/'));
  assert.ok(!isReportUrl('http://localhost.example.com/'));
  assert.ok(!isReportUrl('javascript:alert(1)'));
  // For a report: only its own host, on the report domain (or .localhost in development).
  const id = 'k3j9xq2mtb7w4zpa';
  assert.ok(isReportUrl(`https://${id}.pawpawreports.com/`, id));
  assert.ok(
    isReportUrl(`https://${id}.pawpawreports.com/_pawpaw/signed-in`, id),
  );
  assert.ok(isReportUrl(`http://${id}.localhost:8002/`, id));
  assert.ok(!isReportUrl('https://other000000000.pawpawreports.com/', id));
  assert.ok(!isReportUrl(`https://${id}.pawpawreports.com.evil.example/`, id));
  assert.ok(!isReportUrl(`https://evil.example/${id}`, id));
  assert.ok(!isReportUrl(`http://${id}.pawpawreports.com/`, id));
  assert.ok(!isReportUrl('http://127.0.0.1:8790/', id));
});

test("a server that can't be reached says so", async () => {
  await assert.rejects(
    pawpawServer('http://127.0.0.1:9/v1').signIn('a@b.c', 'x'),
    /Couldn’t reach PawpawBI/,
  );
});

test('published records from project files are checked', () => {
  const report = {
    reportId: 'abc123',
    url: 'https://abc123.pawpawreports.com/',
    account: 'ana@example.com',
    org: { id: 'Org_1', name: 'Acme sales', personal: false },
    visibility: 'org' as const,
    publishedAt: '2026-10-18T10:00:00.000Z',
    refreshedAt: null,
  };
  assert.deepEqual(cleanPublished(publishedFile(report)), report);
  // Records from before organisations, or with nonsense in them, still load.
  const { org: _org, visibility: _visibility, ...old } = report;
  assert.deepEqual(cleanPublished({ pawpawbi: old }), {
    ...old,
    org: null,
    visibility: null,
  });
  assert.deepEqual(
    cleanPublished({
      pawpawbi: {
        ...report,
        org: { id: '../x', name: 'Bad' },
        visibility: 'everyone',
      },
    }),
    { ...report, org: null, visibility: null },
  );
  assert.equal(
    cleanPublished({ pawpawbi: { ...report, reportId: '../x' } }),
    null,
  );
  assert.equal(
    cleanPublished({ pawpawbi: { ...report, url: 'javascript:alert(1)' } }),
    null,
  );
  assert.equal(
    cleanPublished({ pawpawbi: { ...report, url: 'http://evil.example/' } }),
    null,
  );
  // Only the report's own host: not another report's, nor any other https site.
  assert.equal(
    cleanPublished({
      pawpawbi: { ...report, url: 'https://zzz999.pawpawreports.com/' },
    }),
    null,
  );
  assert.equal(
    cleanPublished({
      pawpawbi: {
        ...report,
        url: 'https://abc123.pawpawreports.com.evil.example/',
      },
    }),
    null,
  );
  assert.equal(
    cleanPublished({
      pawpawbi: { ...report, url: 'https://pawpawbi-login.example/abc123' },
    }),
    null,
  );
  assert.deepEqual(
    cleanPublished({
      pawpawbi: { ...report, url: 'http://abc123.localhost:8790/' },
    }),
    { ...report, url: 'http://abc123.localhost:8790/' },
  );
  assert.equal(cleanPublished(null), null);

  const entry = {
    ...report,
    projectId: 'p1',
    projectName: 'Sales',
    projectPath: 'C:\\Reports\\Sales.pawpaw',
  };
  assert.deepEqual(
    cleanList({ projects: [entry, { ...entry, projectId: '../x' }, 'junk'] }),
    [entry],
  );

  // The same report seen at a new path replaces its old entry.
  const moved = { ...entry, projectPath: 'D:\\Sales.pawpaw' };
  const other = {
    ...entry,
    reportId: 'zzz',
    projectName: 'Atlas',
    projectPath: 'C:\\Reports\\Atlas.pawpaw',
  };
  assert.deepEqual(withEntry(withEntry([entry], other), moved), [other, moved]);
  // A project file has one report: publishing it as a new report replaces the old entry.
  const republished = { ...moved, reportId: 'new_1' };
  assert.deepEqual(withEntry([other, moved], republished), [
    other,
    republished,
  ]);

  // A refresh schedule is kept, checked, and carried over when the entry is replaced.
  const schedule = {
    repeat: 'weekly' as const,
    days: [1, 4],
    times: ['06:00'],
  };
  const scheduled = {
    ...entry,
    schedule,
    scheduleDoneUntil: '2026-11-09T06:00:00.000Z',
  };
  assert.deepEqual(cleanList({ projects: [scheduled] }), [scheduled]);
  assert.deepEqual(
    cleanList({
      projects: [{ ...scheduled, schedule: { ...schedule, times: ['25:00'] } }],
    }),
    [entry],
  );
  assert.deepEqual(withEntry([scheduled], moved), [
    { ...moved, schedule, scheduleDoneUntil: scheduled.scheduleDoneUntil },
  ]);
  assert.deepEqual(withEntry([scheduled], { ...entry, lastError: 'x' }), [
    { ...scheduled, lastError: 'x' },
  ]);
  // Unless told it may, another file for the same report (a copy, or someone else's file
  // naming this report) doesn't take the listed file's place or its schedule.
  assert.deepEqual(withEntry([scheduled], moved, { replaceOtherFile: false }), [
    scheduled,
  ]);
  assert.deepEqual(
    withEntry(
      [scheduled],
      { ...entry, lastError: 'x' },
      { replaceOtherFile: false },
    ),
    [{ ...scheduled, lastError: 'x' }],
  );
  assert.deepEqual(withEntry([scheduled], other, { replaceOtherFile: false }), [
    other,
    scheduled,
  ]);
});

/** A signed-up account: its client and ID. */
async function account(email: string) {
  const { token, account } = await pawpawServer(stub.url).signUp(
    email,
    'long enough',
  );
  // Publishing and inviting need a verified address.
  const verified = await fetch(`${stub.url}/auth/verify-email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: lastLink('verify', email) }),
  });
  assert.equal(verified.status, 204);
  return {
    server: pawpawServer(stub.url, token),
    id: account.id,
    email,
    token,
  };
}

/** An API call the app doesn't make (setting up organisations, as the web console would). */
async function api(
  token: string,
  method: string,
  path: string,
  body?: unknown,
) {
  const response = await fetch(`${stub.url}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  assert.ok(response.ok, `${method} ${path}: ${response.status}`);
  return response.status === 204 ? null : response.json();
}

/** Opens the last link of `kind` "emailed" to `to`, as the console would. */
const lastLink = (kind: string, to: string) => {
  const email = stub.emails.findLast((e) => e.kind === kind && e.to === to);
  assert.ok(email, `a ${kind} email to ${to}`);
  return email.token;
};

/** An organisation with an owner, an admin, two editors and a viewer, who joined by invitation. */
async function team(prefix: string) {
  const owner = await account(`${prefix}-owner@example.com`);
  const { org } = await api(owner.token, 'POST', '/orgs', { name: 'Acme' });
  const members = {
    admin: await account(`${prefix}-admin@example.com`),
    editor: await account(`${prefix}-editor@example.com`),
    editor2: await account(`${prefix}-editor2@example.com`),
    viewer: await account(`${prefix}-viewer@example.com`),
  };
  for (const [role, member] of Object.entries(members)) {
    await api(owner.token, 'POST', `/orgs/${org.id}/invitations`, {
      email: member.email,
      role: role.replace(/\d$/, ''),
    });
    await api(member.token, 'POST', '/invitations/accept', {
      token: lastLink('invite', member.email),
    });
  }
  return { orgId: org.id as string, owner, ...members };
}

test('the organisations an account can publish to', async () => {
  const t = await team('targets');
  const orgs = await t.viewer.server.orgs();
  assert.deepEqual(
    orgs.map((o) => [o.name, o.personal, o.role]),
    [
      ['Personal', true, 'owner'],
      ['Acme', false, 'viewer'],
    ],
  );
  // Viewers can't publish, so only their personal workspace is offered.
  assert.deepEqual(
    publishTargets(orgs).map((o) => o.name),
    ['Personal'],
  );
  assert.deepEqual(
    publishTargets(await t.editor.server.orgs()).map((o) => o.name),
    ['Personal', 'Acme'],
  );
});

test('publishing to an organisation, and who may change the report', async () => {
  const t = await team('roles');
  const site = () => pack({ 'index.html': '<h1>Team</h1>' });

  // Personal reports default to the link; an organisation's to its members.
  const mine = await upload(t.editor.server, site(), (files) =>
    t.editor.server.createReport('Mine', files),
  );
  assert.equal(mine.visibility, 'link');
  const report = await upload(t.editor.server, site(), (files) =>
    t.editor.server.createReport('Team', files, { orgId: t.orgId }),
  );
  assert.equal(report.orgId, t.orgId);
  assert.equal(report.publishedBy, t.editor.id);
  assert.equal(report.visibility, 'org');
  const restricted = await upload(t.editor.server, site(), (files) =>
    t.editor.server.createReport('Few', files, {
      orgId: t.orgId,
      visibility: 'restricted',
    }),
  );
  assert.equal(restricted.visibility, 'restricted');

  const status = (promise: Promise<unknown>) =>
    promise.then(
      () => 'ok',
      (e) => `${e.status} ${e.code}`,
    );
  const newVersion = (who: { server: PawpawServer }, id = report.id) =>
    status(
      upload(who.server, site(), (files) =>
        who.server.updateReport(id, 'site', files),
      ),
    );

  // Viewers can't publish to it; outsiders don't see it at all.
  const outsider = await account('roles-outsider@example.com');
  for (const [who, expected] of [
    [t.viewer, '403 forbidden'],
    [outsider, '404 not_found'],
  ] as const) {
    assert.equal(
      await status(
        who.server.createReport(
          'X',
          site().map((p) => p.file),
          {
            orgId: t.orgId,
          },
        ),
      ),
      expected,
    );
  }

  // The publisher, admins and owners may change it; other members may not.
  assert.equal(await newVersion(t.editor), 'ok');
  assert.equal(await newVersion(t.admin), 'ok');
  assert.equal(await newVersion(t.owner), 'ok');
  assert.equal(await newVersion(t.editor2), '403 forbidden');
  assert.equal(await newVersion(t.viewer), '403 forbidden');
  assert.equal(await newVersion(outsider), '404 not_found');
  assert.equal(await newVersion(t.viewer, restricted.id), '404 not_found');

  // Members-only reports need signing in to open, and don't show at the link.
  await assert.rejects(
    pawpawServer(stub.url).getReport(report.id),
    SignedOutError,
  );
  assert.equal(
    (await t.viewer.server.getReport(report.id)).report.id,
    report.id,
  );
  assert.equal(await fetchText(report.url), '404');

  // A publisher who leaves loses the report: to them it's gone.
  await api(t.admin.token, 'DELETE', `/orgs/${t.orgId}/members/${t.editor.id}`);
  const left = await t.editor.server
    .updateReport(report.id, 'data', [])
    .catch((e) => e);
  assert.ok(isGone(left));

  // So is a deleted report, for everyone.
  await api(t.admin.token, 'DELETE', `/reports/${report.id}`);
  const deleted = await t.owner.server
    .updateReport(
      report.id,
      'site',
      site().map((p) => p.file),
    )
    .catch((e) => e);
  assert.ok(isGone(deleted));
});

test('errors carry the status and code the server sent', async () => {
  const error = await pawpawServer(stub.url)
    .signUp('not an email', 'long enough')
    .catch((e) => e);
  assert.ok(error instanceof PawpawServerError);
  assert.equal(error.status, 400);
  assert.equal(error.code, 'bad_request');
  assert.match(error.message, /valid email/);
});

test('uploading reports progress as each file finishes', async () => {
  const { server } = await account('gu@example.com');
  const packed = pack({
    'index.html': '<h1>A</h1>',
    'pages/a.html': '<p>a</p>',
    'data/a.json': '{"rows":[]}',
  });
  const { report, version, uploads } = await server.createReport(
    'Progress',
    packed.map((p) => p.file),
  );
  const seen: [number, number][] = [];
  await uploadFiles(server, packed, uploads, (sent, total) =>
    seen.push([sent, total]),
  );
  const total = packed.reduce((sum, p) => sum + p.body.length, 0);
  assert.deepEqual(seen[0], [0, total]);
  assert.deepEqual(seen.at(-1), [total, total]);
  assert.equal(seen.length, 4, 'a step per file');
  assert.ok((await server.completeUpload(report.id, version)).publishedAt);
});

test('a pass opens a members-only report in the browser, as the account that asked', async () => {
  const t = await team('passes');
  const report = await upload(
    t.editor.server,
    pack({ 'index.html': '<h1>Team</h1>' }),
    (files) => t.editor.server.createReport('Team', files, { orgId: t.orgId }),
  );
  const open = (pass?: string) =>
    fetch(`${stub.url}/reports/${report.id}`, {
      headers: pass ? { Authorization: `Pass ${pass}` } : {},
    });
  assert.equal((await open()).status, 401);

  const granted = await t.viewer.server.reportPass(report.id);
  assert.equal(granted.url, report.url);
  assert.equal((await open(granted.pass)).status, 200);
  // The browser goes to the viewer's own page on the report's host, the pass in the fragment.
  const address = new URL(signedInUrl(granted.url, granted.pass));
  assert.equal(address.origin, new URL(report.url).origin);
  assert.equal(address.pathname, '/_pawpaw/signed-in');
  assert.equal(address.hash, `#${granted.pass}`);

  // Renewing swaps it for a new one.
  const renewed = await fetch(`${stub.url}/reports/${report.id}/pass/renew`, {
    method: 'POST',
    headers: { Authorization: `Pass ${granted.pass}` },
  });
  assert.equal(renewed.status, 200);
  const { pass: next } = (await renewed.json()) as { pass: string };
  assert.equal((await open(granted.pass)).status, 401);
  assert.equal((await open(next)).status, 200);

  // A pass is never a session, and ends with the one that asked for it.
  const asSession = await fetch(`${stub.url}/account`, {
    headers: { Authorization: `Pass ${next}` },
  });
  assert.equal(asSession.status, 401);
  await t.viewer.server.signOut();
  assert.equal((await open(next)).status, 401);

  // Only for someone who can open the report.
  const outsider = await account('passes-outsider@example.com');
  await assert.rejects(
    outsider.server.reportPass(report.id),
    (e: PawpawServerError) => e.status === 404,
  );
});

test('the free assistant needs a verified address, replies as Claude would, and counts each reply', async () => {
  // Signed up but not verified (account() verifies).
  const email = 'assistant@example.com';
  const { token } = await pawpawServer(stub.url).signUp(email, 'long enough');
  const user = { token, email };
  const request = {
    model: '',
    system: 'Help.',
    context: '',
    turns: [{ role: 'user' as const, text: 'Hi' }],
    tools: [],
    maxTokens: 8192,
  };
  const signal = new AbortController().signal;
  await assert.rejects(
    pawpaw(stub.url, user.token).complete(request, () => {}, signal),
    /Verify your email address/,
  );

  await fetch(`${stub.url}/auth/verify-email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: lastLink('verify', user.email) }),
  });
  const provider = pawpaw(stub.url, user.token);
  const response = await provider.complete(request, () => {}, signal);
  assert.match(response.text, /stand-in server's assistant/);
  const usage = await provider.usage();
  assert.ok(usage.share > 0 && usage.share < 1, `${usage.share}`);
  assert.ok(Date.parse(usage.resetsAt) > Date.now());
});
