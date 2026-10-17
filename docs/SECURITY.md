# Security

What is enforced, where, and what is still open. Verification references point at automated tests.

## 1. Identity and sessions

| Concern | Implementation | Verified by |
|---|---|---|
| Passwords | Argon2id (19 MiB, t=2, p=1, OWASP minimum), rehash on login if parameters change; min 10 chars, local common-password list, no e-mail name inside | `auth.e2e-spec` |
| Account discovery | sign-up, forgot-password and login give the **same answer** for known and unknown e-mails; unknown accounts burn the same CPU (dummy hash) | `auth.e2e-spec` |
| Brute force | per-IP and per-e-mail limits (Redis), then lock for 15 min after 10 failures and e-mail the owner | `auth.e2e-spec`, `rate-limit.e2e-spec` |
| Access token | JWT HS256, 15 min, `iss`, `sub`, `sid`; verified with a pinned algorithm | |
| Refresh token | 32 random bytes, only the SHA-256 is stored; **rotated on every use**; presenting a used token later than a 10 s grace window revokes the whole session; 30-day sliding expiry | `auth.e2e-spec` (rotation, reuse, double refresh) |
| Immediate revocation | revoking a session writes `revoked:sid:<id>` to Redis for the token lifetime; the very next request is refused | `auth.e2e-spec` |
| Sign out everywhere | password change/reset revokes all sessions; "revoke others" keeps the current one | `auth.e2e-spec` |
| CSRF | the cookie is `SameSite=Lax`, scoped to `/api/v1/auth`, and `refresh`/`logout` additionally require `X-Requested-With`. Every other call needs the bearer token, which a cross-site request cannot attach. Native clients send the token in the body instead (no ambient credentials). | `auth.e2e-spec` |
| Verification and reset tokens | 32 random bytes, hashed at rest, single use, 24 h / 30 min, a new token invalidates older ones | `auth.e2e-spec` |
| Unverified users | can sign in and read, cannot write (`403 email_not_verified`) | `auth.e2e-spec` |

**Google sign-in** is implemented (OpenID Connect, PKCE, state, nonce; account rules in INTEGRATIONS.md) and tested against a fake provider only. **Not implemented:** TOTP / two-factor (decision D4), institution SSO (D5).

## 2. Tenancy and authorization

See [ARCHITECTURE.md §3](ARCHITECTURE.md). Key properties, all tested in `access.e2e-spec` and `contract.e2e-spec`:

* A user who sets someone else's `X-Workspace-Id` is refused (`403`), **and** even if the application had a bug, the database policy `workspace_id = pn_ws()` returns nothing because `pn_ws()` demands an active membership.
* Raw `SELECT *` on every tenant table as another tenant, as a Super Admin, or with no context at all returns zero rows.
* The Institution Admin and Super Admin cannot read submissions, comments, files or timelines, even with a raw query.
* Students cannot read, or write, supervisor-only comments, even with a raw query.
* The application role cannot update or delete history (`activity_log`, `reviews`, `overrides`), and the API **refuses to start** if its role is a superuser, has `BYPASSRLS`, or owns the tables.

### Permission matrix (routes)

| Capability | Who | Notes |
|---|---|---|
| View a project's content | its members; Dean (faculty), Head (department), Owner (workspace) | otherwise `404`, never `403`, so existence is not leaked |
| Comment | anyone who can view content | `supervisors_only` only for supervisors and leadership |
| Submit a phase | group leader; any member if `any_member`; anyone in a leaderless or single-student group | `only_leader_submits` otherwise |
| Review (request changes) | Lead, Co-supervisors | |
| Approve a phase | Lead if they hold the right, else a co-supervisor who does; nobody → "approval blocked" | right = Admin permission minus revocations, computed in SQL |
| Override | Dean of the faculty, Supervision Owner | reason mandatory; immutable record; supervisors notified |
| Revoke / restore approval right | Institution Admin, Dean (own faculty), Owner | |
| Offboard / assign Lead | Institution Admin, Dean (own faculty), Owner | |
| Create projects | Dean, Owner, Supervisor (if the workspace allows) | **not** the Institution Admin |
| Platform admin endpoints | `is_platform_admin` only | metadata, plans, usage, failed jobs |

## 3. Data protection

| Data | Protection |
|---|---|
| Google refresh tokens | AES-256-GCM, key id stored for rotation, never returned by any endpoint; read only through `pn_project_drive()` for the Lead's own projects |
| One-time links in queued e-mail | encrypted in the job row, scrubbed after delivery |
| Student files | **not stored**: Drive file id and metadata only |
| AI | files held in memory for one call, never written to disk or database; paid-tier Gemini recommended (no training on prompts) |
| Logs | structured JSON; passwords, tokens and cookies redacted; bodies never logged |
| Backups | see [OPERATIONS.md](OPERATIONS.md) |
| Account deletion | requested → 14-day grace → anonymised (name, e-mail, profile, sessions, Drive link). Activity snapshots keep a name until retention removes them; this is documented, not hidden. |

## 4. Input and output hardening

* DTO validation on every body (whitelist, type, length); uploads checked for extension, size and count against workspace settings; names sanitised. File **content** is not scanned for malware (files sit in Drive and are never executed server-side).
* Path ids must be UUIDs, otherwise `404`.
* E-mail templates HTML-escape every dynamic value; links only `http(s)`.
* CSV export neutralises cells starting with `= + - @`.
* AI prompts place submission text inside a delimited, untrusted block; the model has no tools; output is validated against a schema and clipped before storage (`validateAiOutput`).
* `helmet` headers, strict CORS allow-list with credentials, request-size limit 2 MB for JSON, 200 MB hard cap for multipart (workspace limit, default 50 MB, is enforced in the service).
* Dev secrets from `.env.example` are rejected in production at start-up.

## 5. Known advisories (accepted, reviewed)

`npm audit --omit=dev` reports, as of the last run:

| Package | Via | Severity | Why accepted |
|---|---|---|---|
| `deepmerge-ts` < 8 | `prisma` CLI (6.x) | high | Used only by the CLI at migrate time on trusted config, never on request data. Fix requires Prisma 7 (breaking); tracked in STATUS.md. |
| `js-yaml` 5.0–5.4 | `@nestjs/swagger` | moderate | Used to render YAML docs we do not serve; we only emit JSON. |

CI fails on `critical` and prints the rest.

## 6. Open items

* Malware scanning of uploads; content-type sniffing beyond the extension.
* Per-workspace SSO and 2FA (product decisions).
* Rate-limit headers (`RateLimit-*`) are not sent, only `Retry-After`.
* A penetration test has **not** been performed.
