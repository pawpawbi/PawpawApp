# PawpawBI server API

The PawpawBI server holds accounts, organisations and published reports, and runs the built-in
assistant. It's free to use, within fair-use limits; the assistant has a monthly allowance per
account. It never receives a report's files itself: it hands out presigned S3 URLs, the app
uploads each file straight to S3, and browsers download them from S3.

This is the contract between the server and the PawpawBI desktop app, which is built against it
(`src/pawpaw-server.ts` in the app; `scripts/pawpaw-server-stub.mjs` there implements the parts
the app uses in memory, for development and tests, standing in for S3 as well). The same file is
kept in both repositories, word for word. The server's repository is private, so this says only
what the app and the people viewing reports can rely on, nothing about how the server works
inside.

## Basics

- Base URL: `https://api.pawpawbi.com/v1`. All paths below are under it.
- Requests and responses are JSON (`Content-Type: application/json`).
- Signed-in requests send `Authorization: Bearer <token>`. A token works until it's signed
  out, or until it goes 90 days without being used. The web console uses a cookie instead
  (Browsers, below).
- Errors: an HTTP status and `{ "error": { "code": "…", "message": "…" } }`, with a message fit
  to show the user and a code the app can act on:

  | Status | `code`               | Meaning                                                                      |
  | ------ | -------------------- | ---------------------------------------------------------------------------- |
  | `400`  | `bad_request`        | Something in the request isn't valid; the message says what                  |
  | `401`  | `unauthorized`       | The token is missing or no longer valid: the app asks the user to sign in    |
  | `403`  | `forbidden`          | The user can see this but their role doesn't allow the action                |
  | `403`  | `email_not_verified` | The action needs a verified email address (see Accounts)                     |
  | `404`  | `not_found`          | No such thing, or one the user has no access to at all                       |
  | `409`  | `conflict`           | The action clashes with the current state; the message says why              |
  | `409`  | `missing_files`      | `upload_complete` found files not yet uploaded (see below)                   |
  | `429`  | `too_many_requests`  | Too many attempts or requests in a short time; wait and try again            |
  | `429`  | `allowance_used`     | This month's assistant allowance is used up; the message says when it resets |
  | `500`  | `internal`           | A problem on the server                                                      |

  A `429` may have a `Retry-After` header (seconds) when the server knows how long to wait.

### Browsers

Two web pages call the API from a browser, and CORS allows only them:

- **The web console**, `https://console.pawpawbi.com`, where people manage their account,
  organisations, members and reports. Its requests send credentials. Signing up or in from it
  (its `Origin`) sets the session as a cookie on the API's host, `HttpOnly`, `Secure` and
  `SameSite=Strict`, and the response has no `token`. The cookie counts only on requests whose
  `Origin` is the console's; anywhere else it's ignored, as if the request weren't signed in.
  Signing out from the console also clears it.
- **The report viewer** (Viewing, below) calls `GET /reports/<id>` and
  `POST /reports/<id>/pass/renew` from each report's host, without credentials, sending a pass
  for that one report when the viewer is signed in.

## Accounts

Accounts are an email address and a password. (Google and Microsoft sign-in are planned.)

| Request                         | Body                               | Response                                                         |
| ------------------------------- | ---------------------------------- | ---------------------------------------------------------------- |
| `POST /auth/sign-up`            | `{ email, password, invitation? }` | `201 { token, account }`; `409` email in use                     |
| `POST /auth/sign-in`            | `{ email, password }`              | `200 { token, account }`; `401` wrong details                    |
| `POST /auth/sign-out`           |                                    | `204`; the token stops working                                   |
| `GET /account`                  |                                    | `200 { account }`                                                |
| `PATCH /account`                | `{ name }`                         | `200 { account }`                                                |
| `POST /auth/verify-email`       | `{ token }`                        | `204`; `400` the link has expired or was used                    |
| `POST /auth/send-verification`  |                                    | `204`; `429` an email was sent too recently                      |
| `POST /auth/forgot-password`    | `{ email }`                        | `204`, whether or not there's an account                         |
| `POST /auth/reset-password`     | `{ token, password }`              | `200 { token, account }`; `400` the link has expired or was used |
| `POST /auth/change-password`    | `{ currentPassword, newPassword }` | `204`; `400` wrong current password, or too short                |
| `GET /account/sessions`         |                                    | `200 { sessions }`                                               |
| `DELETE /account/sessions/<id>` |                                    | `204`; `404` not one of the account's sessions                   |
| `DELETE /account/sessions`      |                                    | `204`; every session but this one ends                           |
| `POST /account/delete`          | `{ password }`                     | `204`; `400` wrong password; `409` the only owner of an org      |

`account` is `{ id, email, name, emailVerified }`. `name` is up to 100 characters, or `null`;
sending `null` or `""` clears it. Passwords are at least 8 characters (`400` otherwise). Sign-in
allows 10 attempts per email and 30 per IP address in 15 minutes, and sign-up 10 per IP address;
past that it's `429`.

**Verifying the email address.** Signing up emails a link to the address. The link opens the
web console, which sends its token to `POST /auth/verify-email` (no sign-in needed, so it works
in any browser); the app never handles it. A link works once, for 24 hours, and only while the
account still has the address it was sent to. `POST /auth/send-verification` emails a new link
(the old one stops working), and does nothing for an address that's already verified. An
address gets at most one email every 5 minutes and 5 a day (`429` past that). The app learns
the result from `emailVerified` (`GET /account`). Signing in doesn't need a verified address;
publishing, inviting and the assistant do (`403` `email_not_verified`).

**Forgetting the password.** `POST /auth/forgot-password` emails the address a link to the web
console, where the user chooses a new password (`POST /auth/reset-password`). It answers `204`
whether or not the address has an account, and whatever the email limits allowed, so it doesn't
say who has an account. A reset link works once, for an hour. Resetting ends every session the
account had, including the app's (its next request gets `401`), signs in with a new one, and
verifies the address. The app offers "Forgot your password?" by opening the console.

**Changing the password, and sessions.** `POST /auth/change-password` needs the current
password. A wrong one is `400`, not `401`, so the caller stays signed in, and counts towards the
sign-in limit (`429`). Changing it ends every other session, including the app's. A `session` is
`{ id, client, createdAt, lastUsedAt, current }`: `client` is `app` or `console`, `lastUsedAt`
is kept to the day, and `current` marks the session making the request, which is listed first.
The console manages sessions; for the app, a session can end from elsewhere, and its next request
gets `401`.

**Security notices.** The server emails the account when someone signs in (saying where from)
and when its password changes. Nothing in the app is needed for them.

**Deleting the account.** `POST /account/delete` needs the password (a wrong one is `400`, and
counts towards the sign-in limit). It's refused (`409`) while the account is the only owner of an
org: someone else must be made an owner, or the org deleted, first. Deleting ends every session,
removes the account from its orgs, and deletes the reports in its personal org. Reports it
published to other orgs stay with them, and their `publishedBy` stays its ID. The address can
sign up again, as a new account. The console offers this; the app doesn't.

## Organisations

Reports belong to an organisation ("org"), and people are members of orgs with a role. Each
account has a **personal** org, created with it and named "Personal", which is where reports
go unless the app says otherwise. No one else can join a personal org, and it can't be
renamed, left or deleted.

| Role     | Can                                                                                 |
| -------- | ----------------------------------------------------------------------------------- |
| `viewer` | Open the org's reports, see its members                                             |
| `editor` | Also publish reports to the org, and change or delete the ones they published       |
| `admin`  | Also change or delete any report, and add, remove and change the role of non-owners |
| `owner`  | Everything: also manage owners, rename the org and delete it                        |

An org always has at least one owner: the last owner can't leave or be demoted (`409`).
Removing someone, or someone leaving, doesn't touch the reports they published; those stay
with the org.

| Request                                  | Who                    | Body              | Response                                        |
| ---------------------------------------- | ---------------------- | ----------------- | ----------------------------------------------- |
| `GET /orgs`                              | Signed in              |                   | `200 { orgs }`: the user's orgs, personal first |
| `POST /orgs`                             | Signed in              | `{ name }`        | `201 { org }`; the user is its owner            |
| `GET /orgs/<id>`                         | Members                |                   | `200 { org }`                                   |
| `PATCH /orgs/<id>`                       | Owners                 | `{ name }`        | `200 { org }`                                   |
| `DELETE /orgs/<id>`                      | Owners                 |                   | `204`; `409` while it has reports               |
| `GET /orgs/<id>/members`                 | Members                |                   | `200 { members }`                               |
| `GET /orgs/<id>/invitations`             | Admins, owners         |                   | `200 { invitations }`: pending ones             |
| `POST /orgs/<id>/invitations`            | Admins, owners         | `{ email, role }` | `201 { invitation }`; `409` already a member    |
| `DELETE /orgs/<id>/invitations/<id>`     | Admins, owners         |                   | `204`; the link stops working                   |
| `POST /invitations/open`                 | Anyone with the link   | `{ token }`       | `200 { invitation }`: what it's for             |
| `POST /invitations/accept`               | The invited address    | `{ token }`       | `200 { org }`; `403` signed in as someone else  |
| `PATCH /orgs/<id>/members/<account id>`  | Admins, owners         | `{ role }`        | `200 { member }`                                |
| `DELETE /orgs/<id>/members/<account id>` | Admins, owners; or you |                   | `204`. Your own account ID leaves the org       |
| `GET /orgs/<id>/reports`                 | Members                |                   | `200 { reports }`: those the user can open      |

- **`org`** is `{ id, name, personal, role, createdAt }`; `role` is the signed-in user's.
- **`member`** is `{ id, email, name, role, joinedAt }`, where `id` is the account's.
- `name` is 1 to 100 characters. `role` is `owner`, `admin`, `editor` or `viewer`; admins can't
  give or take away `owner`.
- **Invitations.** People join an org by invitation: an email with a link to the web console,
  where they accept it by signing in with the invited address, or by creating an account for it
  (`POST /auth/sign-up` with the link's `invitation` token, which joins the org at once). Either
  way the address counts as verified. An invitation works once, for 7 days; inviting the same
  address again replaces it. Inviting needs a verified address of one's own (`403`
  `email_not_verified`), and is limited to 50 invitations a day per account, and one email
  every 5 minutes per address (`429`). Admins can't invite owners. The app doesn't handle
  invitations.
- **`invitation`**, to admins, is `{ id, email, role, invitedBy, createdAt, expiresAt }`, where
  `invitedBy` is an account ID or `null`. From its link, it's
  `{ org: { id, name }, email, role, invitedBy: { email, name } | null, expiresAt, accountExists }`.
  A link that's been used, cancelled or has expired is `400`.
- An org someone isn't a member of is `404` to them.
- Deleting an org needs its reports deleted first. Deleted reports take an hour or two to be
  removed completely, and until then deleting the org is also `409`.
- `GET /orgs/<id>/reports` is most recently refreshed first.

## Reports

| Request                              | Who                                | Body                                    | Response                                      |
| ------------------------------------ | ---------------------------------- | --------------------------------------- | --------------------------------------------- |
| `POST /reports`                      | Editors, admins, owners of the org | `{ title, files, orgId?, visibility? }` | `201 { report, version, uploads, expiresAt }` |
| `POST /reports/<id>`                 | Can change it (below)              | `{ scope, files }`                      | `200 { report, version, uploads, expiresAt }` |
| `POST /reports/<id>/upload_complete` | Can change it                      | `{ version }`                           | `200 { report }`; `409` files missing         |
| `PATCH /reports/<id>`                | Can change it                      | `{ title?, visibility? }`               | `200 { report }`                              |
| `DELETE /reports/<id>`               | Can change it                      |                                         | `204`                                         |
| `GET /reports/<id>`                  | Can open it (below)                |                                         | `200 { report, files, expiresAt }`            |
| `POST /reports/<id>/pass`            | Can open it                        |                                         | `200 { pass, url, expiresAt }`                |
| `POST /reports/<id>/pass/renew`      | A pass for it (Viewing)            |                                         | `200 { pass, url, expiresAt }`                |

**`report`** is `{ id, title, url, orgId, publishedBy, visibility, publishedAt, refreshedAt }`:

- `id`: letters, digits, `-` and `_`, at most 64.
- `url`: the report's viewer page (`https:`), to share; see Viewing below.
- `orgId`: the org it belongs to. `POST /reports` puts it in the user's personal org when
  `orgId` is left out.
- `publishedBy`: the account ID of whoever created it. Editors may change only their own.
- `visibility`: who can open it.
  - `link`: anyone with the link, signed in or not.
  - `org`: members of its org.
  - `restricted`: its org's admins and owners, and the member who published it.

  It defaults to `link` in a personal org and `org` in any other.

- `publishedAt`: when the current version's site was uploaded; `refreshedAt`: when its data
  was. ISO timestamps, or `null` before the first upload completes.

**Who can change a report** (new versions, title, visibility, deleting it): its org's admins
and owners, and the editor who published it while they're still an editor there. Others who
can open it get `403`.

**Who can open it** is set by `visibility`. `GET /reports/<id>` without a token on a report that
isn't `link` is `401`; with the token of someone who can't open it, `404`, as if it didn't
exist. In a browser, a pass stands in for the token (Viewing, below).

**Deleting** a report makes it `404` at once. Its files are removed from S3 an hour or two
later.

**Uploading.** `POST /reports` creates a report and `POST /reports/<id>` uploads a new version
of one. Both need a verified email address (`403` `email_not_verified`), and an account may
start at most 60 uploads an hour (`429` `too_many_requests`). Both list the files to upload, and
get a presigned URL for each:

- `files`: `[{ path, contentType, size, sha256 }]`. `path` is relative to the site's root
  (`index.html`, `pages/<guid>.html`, `assets/report.css`, `data/<dataset>.json`): no `..`,
  no leading `/`, no `\`. `contentType` is the file's type. `size` is the length of the
  gzipped file in bytes and `sha256` its SHA-256, base64.
- `scope` (`POST /reports/<id>` only): `site` replaces the whole site with exactly these files;
  `data` replaces only data files (every path must be `data/<name>.json`) and keeps the rest.
  `POST /reports` is always `site`.
- `version`: the new version's ID (letters, digits, `-` and `_`), for `upload_complete`.
- `uploads`: `[{ path, url, headers }]`, one per file. The app gzips each file and sends it
  with `PUT <url>`, the gzipped bytes as the body and exactly the given `headers`:
  `Content-Type`, `Content-Encoding: gzip` and `x-amz-checksum-sha256`, which the URL is signed
  with, so S3 refuses a different file. URLs work until `expiresAt` (at least 15 minutes).

**Versions.** Each upload is a new version of the report: its file list, where `data` keeps the
current version's other files. Viewers keep getting the current version while a new one
uploads, so they never see a half-uploaded report. Once the app has uploaded every file, it
calls `POST /reports/<id>/upload_complete` with the `version`. The server checks that every new
file of that version is in S3 (with the size it was told), then makes it the report's current
version: `publishedAt` (for `site`) and `refreshedAt` are set to now, and the response's `report`
shows them. If any file is missing, it's `409` with `{ error: { message, missing: [path…] } }`
and nothing changes; the app uploads those files again and calls it again. Completing a version
older than the current one is refused (`409`). The server deletes files the current version no
longer uses some time after it becomes current, and abandons a version that's never completed.

An upload never overwrites a file the current version is using, and an uploaded file never
changes. Pages link to each other by their plain paths (`../data/sales.json`) whatever version
each file was uploaded in.

**Downloading.** `GET /reports/<id>` returns the current version: `files` is
`[{ path, url }]`, a presigned S3 `GET` URL per file, valid until `expiresAt`. The files are
stored gzipped with `Content-Encoding: gzip`, so browsers unzip them as they download. A report
with no complete version yet returns `404`. Who can call it depends on the report's
`visibility` (above). (Row-level security, which is planned, will narrow what
each person sees.)

Limits (the server returns `400` past them): at most 1,000 files per version, 25 MB per
gzipped file.

## Viewing

A report's `url` is where people view it: `https://<id>.pawpawreports.com/`. Each report has
a host of its own, on a domain of its own, because its pages run their author's JavaScript: the
browser keeps reports apart from each other and from PawpawBI's website, console and API. Report
IDs are lowercase letters and digits, so they work in a host name. There:

- `<url>` shows `index.html`, and `<url><path>` shows the file at `<path>`, so the report's
  relative links (`../assets/report.css`, `../data/sales.json`) work as they do in the app. A
  path that isn't in the report is "Page not found".
- `<url>_pawpaw/` is the viewer's own; a report's files can't use that folder (`400`).
- A refreshed report shows its new data on the next page load.
- The report's own scripts run under a Content Security Policy like the app's (`SITE_CSP` in the
  app's `src/report.ts`): they can't load anything from elsewhere.
- A report that isn't `link` shows "This report is private" with **Sign in to view**, which
  goes to the console's `#/open/<id>` page. That signs the visitor in if they aren't, and
  brings them back to the page they were on, signed in for that report.

Treat `url` as opaque: the stand-in server's reports are at `http://<id>.localhost:<port>/`.

### Signing in to view: passes

A browser never holds a session on a report's host, since the report's scripts could use it.
It holds a **pass** instead: a token that opens one report, as one account.

- `POST /reports/<id>/pass`, signed in (a token, or the console's cookie), by someone who can
  open the report (else `404`), returns `{ pass, url, expiresAt }`. `url` is the report's `url`,
  the only place the pass goes.
- **Opening the report with it:** go to `<url>_pawpaw/signed-in#<pass>`, which hands the pass
  to the viewer, takes it out of the address and opens the report. `?page=<path>` opens that
  page of the report instead of `index.html`. The console does this after `#/open/<id>`; the
  app does it to open a report in the browser, with its own token.
- The viewer sends it as `Authorization: Pass <pass>` on `GET /reports/<id>`. Every other
  endpoint ignores it (`401`).
- A pass works for 12 hours (`expiresAt`), and until the session that asked for it ends:
  signing out, the session expiring or being ended, or a password change or reset. Each use
  checks again that its account may open the report.
- **Renewing:** `POST /reports/<id>/pass/renew`, with the pass as `Authorization: Pass`,
  returns a new pass, and the old one stops working. The viewer does this in the background,
  before its pass expires or when it finds it expired. An expired pass can still be renewed for
  a week from the first one, while its session lasts; after that it's `401`, and the viewer
  goes back to the console, which sends a signed-in visitor straight back with a new pass.
  `404` if the account can no longer open the report.
- A pass that no longer works counts as no sign-in at all: a `link` report still opens, and
  any other is `401`.
- At most 120 passes, new or renewed, per account an hour (`429`).

## Assistant

The built-in assistant is Claude, reached through the server, which holds the Anthropic key:
the app never sees it. It needs a signed-in account with a verified email address, and each
account has a free monthly allowance.

| Request                    | Body               | Response                                                 |
| -------------------------- | ------------------ | -------------------------------------------------------- |
| `GET /assistant`           |                    | `200 { models, maxTokens, usage }`                       |
| `POST /assistant/messages` | A Messages request | `200` an event stream; `400`, `403` or `429` (see below) |

- `models`: the model IDs the account may use, the default first.
- `maxTokens`: the largest `max_tokens` a request may ask for.
- `usage`: `{ share, resetsAt }`. `share` is how much of this month's allowance is used, from
  0 to 1 (a reply already running when it reaches 1 is finished, so it can go a little over).
  `resetsAt` is when it starts again (ISO timestamp).

**Replies.** `POST /assistant/messages` takes the body of
[Anthropic's Messages API](https://docs.anthropic.com/en/api/messages) and returns its
[event stream](https://docs.anthropic.com/en/api/messages-streaming) unchanged, so the app reads
it as it reads Anthropic's. The body may only have `model` (one of `models`), `max_tokens` (at
most `maxTokens`), `stream` (`true`), `system` (text, or text blocks), `messages` (`user` and
`assistant` messages of text, `tool_use` and `tool_result` blocks; a tool result's content is
text) and `tools` (the app's own: `name`, `description` and `input_schema`, never Anthropic's
server tools), and is at most 4 MB. Any block or tool may have `cache_control`
`{"type": "ephemeral"}`. Anything else is `400`. The app sends
`Authorization: Bearer <token>` instead of an API key; `anthropic-version` and other Anthropic
headers are ignored. A problem after the stream has started (e.g. Anthropic is overloaded)
arrives as the stream's `error` event.

Refused before a reply starts:

- `403` `email_not_verified`: the account's email address isn't verified yet.
- `429` `allowance_used`: this month's allowance is used up; the message says when it resets.
- `429` `too_many_requests`: too many requests in a short time, a reply is already running for
  this account (one at a time), the assistant is busy, or the free assistant has reached its daily
  limit for everyone, with `Retry-After`.

Every reply counts against the allowance, including one the user stops partway (closing the
connection stops it; what was generated still counts) or leaves before it starts (the request
still counts). The server keeps no conversation: it
doesn't store or log requests or replies, only how many tokens each reply used, its model and
when.
