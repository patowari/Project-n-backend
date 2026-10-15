# Status: implemented, tested, and still open

Last verified: see the "How this was verified" table. "Tested" means an automated test exercises the behaviour on a real PostgreSQL 18 with the restricted application role. Nothing here is claimed from memory.

## 1. The brief, item by item

| Requirement | State | Evidence |
|---|---|---|
| Node.js + TypeScript + NestJS + PostgreSQL + Prisma | **Done** | `src/`, `prisma/` |
| Rust only where clearly justified | **Done**: sandboxed DOCX extractor | `rust/doc-tools` (7 Rust tests, clippy clean), used by the AI tests; rationale in ARCHITECTURE §6 |
| One versioned REST API for web, React Native, Tauri | **Done** | `/api/v1`; native clients get the refresh token in the body (`X-Client: native`); `packages/api-client` |
| Authentication, e-mail verification, password reset, rotating refresh tokens, device sessions | **Done, tested** | `auth.e2e-spec` (rotation, reuse detection, double-tab race, lock-out, native flow, sessions) |
| Institution and Supervision workspaces, strict tenant isolation | **Done, tested** | RLS + composite FKs; `access.e2e-spec`: raw `SELECT *` as another tenant / as no one returns zero rows |
| Scoped, stackable roles (Student, Supervisor, Head, Dean, Institution Admin, Supervision Owner, Super Admin) | **Done, tested** | `org-projects`, `contract` (TypeScript rules == SQL rules for every person × project) |
| Projects, groups, group leaders, multiple supervisors, succession | **Done, tested** | `org-projects`, `governance` (offboarding, successor, "needs supervisor", Lead swap, single-Lead race) |
| Phase-locked timelines, versioned submissions, reviews, approval rights, extensions, Dean overrides | **Done, tested** | `workflow`, `governance` (state machine in the database, immutable versions, approval blocked, overrides with reasons) |
| Google Drive uploads | **Done against a fake; Google adapter unverified** | port + `FakeDriveGateway` tested (`workflow`); `GoogleDriveGateway` written to the documented API, **never run against Google** (checklist in INTEGRATIONS.md) |
| Comments, notifications, activity logs, reports | **Done, tested** | `access`, `contract` |
| Asynchronous AI feedback | **Pipeline done and tested; Gemini adapter unverified** | `worker.e2e-spec` (queued → ready, budget, retries, idempotent billing, release control, hostile DOCX); `GeminiAi` never run against the live API |
| Preserve access restrictions: private discussions, Super Admin visibility | **Done, tested at the database level** | students cannot read *or write* supervisor-only comments even with raw SQL; Super Admin gets nothing from any tenant table and `403` from every tenant route |
| Growth path to ~1,000,000 registered users, without claiming capacity | **Measured, with limits** | [LOAD_TEST.md](LOAD_TEST.md) (1M-user dataset, real API, real PostgreSQL); [SCALING.md](SCALING.md) states assumptions and what is *not* proven |
| Modular monolith, independently deployable workers, stateless API, pooling, indexes, pagination | **Done** | one image, two entrypoints; keyset pagination; every hot query has a plan check in the load test |
| Redis caching and rate limiting | **Written; tested against an emulator only** | `RedisKv` passes the shared contract through `ioredis-mock`; **never run against a real Redis server** (none available here). Memory fallback is tested and is what the suites use. |
| Durable, retryable, idempotent jobs | **Done, tested** | `worker.e2e-spec`; 2 competing runners executed 20,186 jobs with 0 duplicates (LOAD_TEST.md) |
| Authorization authoritative in PostgreSQL + RLS with transaction-scoped context | **Done, tested** | `SET LOCAL` per request; `pn_ws()` demands active membership; the API refuses to start as a role that could bypass RLS |
| Transactions, concurrency control, idempotency, constraints | **Done, tested** | row locks, partial unique indexes, triggers; race tests for submit, review, refresh, Lead swap, idempotency keys |
| Secrets server-side; session storage per client | **Done, documented** | SECURITY.md, packages/api-client/README.md |
| OpenAPI, generated TypeScript client | **Done, tested** | 119 operations; `verify-openapi.mjs`; `packages/api-client` type-checks with typed responses |
| Migrations, seed data | **Done, tested** | `prisma/migrations` (CI drift check reproduced locally), `npm run seed` (idempotent) |
| Docker Compose, CI checks | **Written; not executed here** | no Docker daemon or GitHub runner was available. The checks CI performs were re-run locally: `verify-ci-local.mjs`, `smoke-prod.mjs`, `verify-openapi.mjs`, `cargo fmt/clippy/test`, `npm audit`. **First real run of `docker compose up` and the workflow is still to do.** |
| Structured logs, monitoring, health checks | **Done, tested** | JSON logs with request/user/workspace ids; `/metrics` (HTTP, DB, queue); `/healthz` `/readyz`; `health-kv.e2e-spec`, `smoke-prod` |
| Backup and restore instructions | **Documented; commands not executed** | `pg_dump`/`pg_restore` are not available in this environment. The restore drill in OPERATIONS.md must be run once before go-live. |
| Render deployment; free demo vs production | **Done (files)** | `render.yaml` (demo, labelled with what the free tier cannot do) and `render.production.yaml` (sized from the model, not from free limits); neither was deployed |
| Tests: tenant isolation, permissions, submissions, approvals, concurrency | **Done** | see below |

## 2. How this was verified

| Check | Result | Command |
|---|---|---|
| Strict type-check | clean | `npm run typecheck` |
| End-to-end suites (real PostgreSQL 18, restricted role) | **TESTS_TOTAL passing** in SUITES_TOTAL suites | `npm test` |
| Rust helper | 7 tests passing; `cargo fmt --check`, `clippy -D warnings` clean | `cd rust/doc-tools && cargo test` |
| Migrations apply to an empty DB and match `schema.prisma` | pass | `node scripts/verify-ci-local.mjs` |
| Every table has RLS and a policy; every `SECURITY DEFINER` function pins `search_path`; `projectn_app` cannot bypass RLS; `projectn_auth` is contained; history tables have no UPDATE/DELETE grant | pass | same script |
| Production-mode smoke of the compiled API and worker (refuses dev secrets, refuses a bypass-RLS role, `/metrics` token, CORS, cookies, in-process worker, `worker --drain`) | 15/15 | `node scripts/smoke-prod.mjs` |
| Exported OpenAPI is usable by generated clients | 8/8 | `node scripts/verify-openapi.mjs` |
| Load test on 1,000,000 users | see LOAD_TEST.md | `node scripts/load/run.mjs` |
| Dependency audit | 5 advisories (2 moderate, 3 high) in build-time tooling, reviewed in SECURITY.md §5; none critical | `npm audit --omit=dev` |

Defects found by this verification and fixed (kept here because they show what the tests are for): infinite RLS recursion; students could not reach the Lead's Drive token; `pn_ws()` called once per row made a membership query take 20 s on 1M users (policies rewritten to evaluate once per query, auth flows moved to a dedicated narrow role); a bad plan made `POST /comments` take 50 s on 1M users; `/metrics` rejected the scraper's token; the database defaulted to a non-UTF-8 encoding; a dead-job path that tried to update an append-only table; npm audit flagged build tooling.

## 3. Integration notes for the existing frontend (`dashboard-ui`), which was not modified

| # | Observation | Effect | Fix |
|---|---|---|---|
| 1 | The frontend camel-cases **every** key, including dictionary keys. `GET /reports/summary` returns `health: { on_track, at_risk, ... }` and `projects_by_status: { on_hold, ... }`; after conversion they become `onTrack`, `onHold`, but `health-summary.tsx` reads `health['on_track']`. | The dashboard health tiles would show 0 against the real API (mock data bypasses the converter). | Frontend: look up `camel(key)`, or stop converting dictionary values. Backend keeps the documented enum keys. Pinned by a contract test. |
| 2 | `PATCH /phases/{id}` from the Dean needs a `reason`; the phase editor does not send one. | Dean edits of due dates return `422 reason_required`. | Frontend: add a reason field, or route Dean edits through `POST /projects/{id}/overrides` (`move_deadline`). |
| 3 | The frontend's refresh call sends no `X-Requested-With`. | Would be refused by a header-only CSRF rule. | **Handled in the backend**: an allow-listed browser `Origin` is accepted instead (a cross-site request carries the attacker's origin). Tested. |
| 4 | Real sign-up returns `202` and requires e-mail verification, then sign-in. The mock signs in at once. | Sign-up UX differs. | Frontend flow already routes to the "check your e-mail" state. |
| 5 | Uploads: the UI posts multipart to `/phases/{id}/draft/files` (supported, ≤ 50 MB through the API). For large files use `POST …/draft/uploads` (resumable URL) + `…/confirm`. | Memory use on the API for big files. | Optional UI change; both paths are tested. |
| 6 | The Institution Admin cannot create projects (the frontend's own newest product decision) although the earlier design document allowed it. | `403 cannot_create_projects`. | One constant (`Roles(...)` on `POST /projects`) if the decision changes. |
| 7 | Endpoints without UI yet: notifications, revocations, offboarding, lead/successor/co-supervisor management, Super Admin screens, phase-template CRUD. | n/a | API is ready and tested. |

## 4. Not done, or open (honest list)

* **Run once in staging:** Google Drive, Gemini and Resend adapters; a real Redis; `docker compose up`; the GitHub Actions workflow; the Render blueprints; the backup/restore drill. Each has a checklist.
* **Capacity beyond what was measured:** see SCALING.md §5. Notably untested: network latency to a remote database, PgBouncer, Redis, multiple API instances on separate hosts, sustained multi-hour soak, a single tenant with 100k+ projects.
* Former Lead's 30-day read-only access (decision D11), ownership transfer / folder copy of Drive files on Lead change (D1), retention policy (D6), 2FA (D4), SSO (D5).
* Google sign-in (only the Drive connection uses Google).
* Bounce/complaint webhooks for e-mail; malware scanning of uploads; `TOKEN_ENCRYPTION_KEY` rotation script.
* `activity_log` / `audit_log` partitioning and archival (planned above ~10 M rows per tenant).
* No linter beyond strict TypeScript; no penetration test.
* Prisma 7 migration (removes two audit advisories in build tooling).
