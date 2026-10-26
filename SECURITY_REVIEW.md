# Security review — 2026-10-22

Read-only review in four areas (sign-in and permissions, untrusted input
and files, money logic, deployment), each finding then checked against the
code before fixing. Fixes are in the commit that adds this file; each was
tested against a real server and Postgres (see WORKLOG.md).

Severity: **High** = an outsider or low-rights user can take over accounts
or money; **Medium** = real loss or abuse with some effort or insider help;
**Low** = defence in depth, small leaks, or needs unusual conditions.
Nothing High was found.

## Fixed

| # | Sev | Finding | Fix |
|---|-----|---------|-----|
| 1 | Medium | A role with "manage staff" could give any account the ADMIN role, and suspend or demote the real admin (`user_service.go` SetRole/updateUser). | You can only hand out a role whose permissions you hold, and only change accounts that don't hold permissions you lack (`missingPermissions`; book_online doesn't count, any customer has it). |
| 2 | Medium | Refunds treated a slip nobody had approved as money received: cancel-with-refund (and every court closure) recorded a refund for any uploaded image; a rejected (fake) slip could still be refunded. | Only an approved payment counts as received. For any other, the manager must tick "I checked the bank account" (`bank_checked`); without it the hours are cancelled but no refund is recorded and the screen says to check first. Browser-only demo mode asks the same before the refund button records anything (2026-10-22). |
| 3 | Medium | Unlimited slip re-uploads: every upload is a file kept on disk, so a script could fill the disk (and the database's disk with it). | At most 5 slips per payment and 20 per customer per day (`SaveSlip`, new `payments.slip_uploads`). |
| 4 | Medium | No Content-Security-Policy, HSTS or Permissions-Policy (the login token is in localStorage, so any future XSS = account takeover). | Headers added in `deploy/Caddyfile`, CSP checked against the real production bundle. |
| 5 | Medium | Backups readable by every account on the server, unencrypted, inside the code folder; secrets not backed up. | `backup.sh` uses `umask 077`/`chmod 700`; DEPLOY.md: back up to `/var/backups/arena`, encrypt before copying off the server (rclone crypt), keep the `.env` files in a password manager. |
| 6 | Medium | The server started in production with the example PromptPay ID (customers' QR payments would go to someone else). | Release mode refuses to start without the shop's own `PROMPTPAY_ID`; `.env.example` ships it empty. |
| 7 | Medium | `docker compose up --build` never refreshes Postgres/Caddy/Alpine images, so security fixes never arrive. | DEPLOY.md update step: `docker compose pull && docker compose build --pull && docker compose up -d`, monthly. |
| 8 | Low | Staff could approve the slip of their own online booking. | Refused: another staff member or a manager approves it. |
| 9 | Low | Blind cash count defeated by the close-shift error ("the count is -5230.00 THB off"). | Staff without report rights only get "the count doesn't match". |
| 10 | Low | Slip type checked by file name only (HTML/SVG renamed .jpg accepted; a tiny file declaring a huge image could freeze the review screen). | Content must match the extension; JPEG/PNG over 40 megapixels refused. |
| 11 | Low | Request logs contained signed slip links (valid 1-2 h) and member searches by phone. | Logs no longer include query strings; Docker logs rotate (10 MB × 5). |
| 12 | Low | Release mode accepted `SEED_DEMO_USERS=true` (admin with password 123456) and a short `JWT_SECRET`. | Both refuse to start in release mode. |
| 13 | Low | `make-admin <phone>` promoted whoever had registered that phone (phones aren't verified). | It now shows the account (name, email, registration time) and only acts with `--yes`; DEPLOY.md says to register right after going live and check. |
| 14 | Low | CORS allowed every origin (any site could script sign-up/login attempts from its visitors). | Empty `CORS_ALLOWED_ORIGINS` now sends no CORS headers (the app is same-origin). |
| 15 | Low | `TRUSTED_PROXIES` trusted the whole Docker subnet. | Caddy has a fixed address and only it is trusted. |
| 16 | Low | Containers had no limits or hardening. | `no-new-privileges`, memory/pid limits, read-only backend filesystem. |
| 17 | Low | Bad request bodies returned Go internals ("cannot unmarshal ... into Go struct field ..."). | Plain "invalid request body: wrong type for X". |
| 18 | Low | No length limit on notes and reasons (1 MB each). | 500 characters. |
| 19 | Low | Stale `bun.lock` pinned xlsx 0.18.5 (known CVEs). | Deleted; `package-lock.json` (0.20.3) is the only lockfile. |
| 20 | Low | DEPLOY.md: no SSH hardening or automatic updates; Docker ports bypass ufw. | Steps added (key-only SSH, unattended-upgrades, never publish db/backend ports). |

## Follow-up: regressions found in the fixes (fixed 2026-10-22)

| # | Problem caused by the fixes above | Fix |
|---|---|---|
| R1 | (from #2) A refund asked for an unapproved slip was not recorded, and the payment then left the slip queue (REJECTED) - no screen could refund it later, though the message said to. | The request is kept: `payments.refund_check_pending`; the slip tab lists these ("รอตรวจยอดในบัญชีก่อนคืนเงิน", `GET /staff/payments?status=REFUND_CHECK`) with "refund" (asks for the bank check) and "no money arrived" (`POST /admin/payments/:id/no-refund`, reason, audit `REFUND_NOT_NEEDED`). Also covers a partial cancellation whose slip stays in the queue. |
| R2 | (from #10) A real image whose name didn't match its content (a chat app's JPEG saved as `.png`, a file with no extension) was refused - the customer could not send the slip. | The type is decided by the content only (JPEG/PNG/WEBP) and the stored file gets that extension; the name is ignored. HTML/SVG/PDF are still refused. |
| R3 | 11 of the new server messages appeared in English on the Thai screens; three became a generic "no permission". | Thai texts for all of them in `errorText.ts` (tested). |
| R4 | (from #14) The documented dev setup with `VITE_API_BASE_URL=http://localhost:8080/api/v1` stopped working (no CORS headers by default). | README and `.env.example`: set `CORS_ALLOWED_ORIGINS` to the page's address in that setup. |

## Found in the full code recheck (fixed 2026-10-23)

| Severity | Problem | Fix |
|---|---|---|
| High | **Role editing could escalate:** creating or editing a role never compared its permissions with the editor's, so an account whose role held only "manage roles" could give its own role every permission (or strip the Admin role). | A role can only hold permissions its editor has, and nobody edits a role with permissions they lack (`role_service.go` checkRoleEditable); the admin screen offers only roles the admin may grant. Live: 403 for all three attempts. |
| Low | Admin user search with a digit in a name ("somchai1") matched every phone containing that digit. | Phone matching only for phone-like searches. |
| Low | Blind cash count: staff without `view_reports` can still add up today's cash from the order and booking lists they need for their work. | Not changed - a limit of the blind count (hiding sales from the counter would break it). |

## Not fixed — need a decision or a bigger change (listed in TODO.md)

| Sev | Finding | Options |
|-----|---------|---------|
| Medium | **Slip reuse with a changed copy:** the duplicate check only catches byte-identical files, so one real transfer re-saved as a new screenshot can be approved for two bookings, and the slip's amount is never checked. Depends on staff noticing. | Staff type the bank reference and amount when approving (reference stored unique; amount must cover the booking) - a small workflow change at the counter; later a bank slip-verification API. |
| Medium | **Courts held with junk slips:** a slip waiting for review never expires, so fake accounts (sign-up isn't phone-verified) can each hold 9 court-hours until staff reject them one by one. | A review deadline (e.g. auto-reject or flag a waiting slip N hours before the hour starts), and/or phone OTP at sign-up (needs SMS, TODO section 4). |
| Medium | **Phone numbers aren't verified:** someone can register another person's number first and collect the points of the walk-ins staff record for it. | Phone OTP at sign-up (SMS provider) or LINE login. |
| Low-Med | **Anyone can lock any account** (incl. the admin) for 15 min with 20 wrong passwords from a few IPs. | Already an open owner decision (section 0, login lockout): e.g. let a correct password through the account-wide lock and keep the hard lock per (account, IP). |
| Low | **Sessions can't be revoked:** a stolen token works for up to 48 h after logout; there's no "log out everywhere". | `token_version` on users, checked per request, bumped on logout-all / password change / suspension - do together with "forgot password". |
| ~~Low~~ decided 2026-10-23 | A manager can cancel and refund an hour that is being played or just finished. | Owner: allowed, with a log - the cancel's audit entry records how many of the hours had already started (`started_hours`). |
| ~~Low~~ fixed 2026-10-22 | The opening float isn't checked against the previous shift's count. | Done: the screen shows the last count ("ใช้ยอดนี้"); a different float needs a note (server and browser-only mode), kept on the shift and in the audit log. |
| ~~Low~~ fixed 2026-10-22 | Counter staff can book through a closure (`override_closure`). | Done: needs `manage_closures` (403 otherwise); the counter screen says so instead of offering it. |
| Low | Registration reveals whether a phone/email is registered. | Normal for sign-up; goes away with OTP-first sign-up. |

## Checked and fine (summary)

JWT pinned to HS256 with expiry; the user, status and role are re-read on
every request; every route's permission matches its handler; no IDOR found
(ids from the token, ownership checks on slips); login gives the same error
and timing for unknown users; idempotency keys are bound to user and route;
all SQL is parameterised; slip files are named by the server, served only
through HMAC-signed expiring links with nosniff; body size limits and
number ranges are enforced; prices, discounts and the PromptPay amount come
only from the server; points, vouchers, refunds, stock and cash are
serialised by row locks and backed by CHECK constraints; no
`dangerouslySetInnerHTML`/`innerHTML`; CSV export guards against formulas;
only Caddy publishes ports; no secrets in git or images; the production
bundle has no demo accounts or source maps.
