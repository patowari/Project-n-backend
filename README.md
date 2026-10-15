# Project N backend

NestJS + TypeScript API for the Project & Assignment Tracking System, on PostgreSQL (Row Level Security) with Redis, Prisma, durable background jobs and one small Rust helper. One versioned REST API (`/api/v1`) serves the React web app, a React Native app and a Tauri desktop app.

> **Status in one paragraph.** Every workflow in the product brief is implemented and covered by automated tests that run against a real PostgreSQL 18 with the restricted application role (so Row Level Security is genuinely enforced): 150+ tests plus 7 Rust tests. Google Drive, Gemini and Resend are behind ports with fakes for development and tests; the **real adapters are written but have not been run against the live services** (no credentials here). Docker, Compose, Render and GitHub Actions files are written but **could not be executed in the authoring environment** (no Docker daemon); the checks they perform were reproduced locally where possible. Capacity is **measured, not claimed**: see [docs/LOAD_TEST.md](docs/LOAD_TEST.md). Read [docs/STATUS.md](docs/STATUS.md) for the honest list of what is done, tested and still open.

## Quick start (no Docker needed)

Requires Node 22+. Tests and the load test use an embedded real PostgreSQL 18, so nothing else has to be installed.

```bash
cd backend
npm install
npm test                       # builds a throw-away PostgreSQL, applies migrations, runs every suite (~1 min)
```

Run the API against your own PostgreSQL and Redis:

```bash
cp .env.example .env           # development defaults: fake Drive / AI, e-mail logged
docker compose up postgres redis -d      # or any PostgreSQL 16+ and Redis 7
npm run build
DATABASE_MIGRATION_URL=postgresql://postgres:postgres@localhost:5432/projectn npx prisma migrate deploy
APP_DB_PASSWORD=... SYSTEM_DB_PASSWORD=... DATABASE_MIGRATION_URL=... node scripts/db-setup.cjs
npm run seed                   # demo data: City University, Dr. Karim, Nadia Islam ...  (password: Demo-pass-12345)
npm run start:dev              # API on :8000
npm run start:worker           # in another terminal (or INLINE_WORKER=true for a single process)
```

Everything in one command with Docker:

```bash
cp .env.example .env && docker compose up --build
docker compose --profile tools run --rm seed
```

Point the existing React app at it: `VITE_USE_MOCKS=false`, `VITE_API_URL=http://localhost:8000/api/v1` in `dashboard-ui/.env`.

## What is where

```
prisma/
  schema.src.prisma            source schema (camelCase). `npm run schema:build` -> schema.prisma (snake_case maps)
  migrations/0001_init         tables, composite tenant foreign keys (generated)
  migrations/0002_rls_...      roles, RLS policies, SQL authorization functions, constraints, triggers, grants
src/
  authz/                       caller model + pure policy functions (mirrors the SQL rules; a test asserts parity)
  common/                      request transaction, problem+json, idempotency, pagination, wire format, rate limits
  infra/                       Prisma clients (app role / system role), tenant transaction (SET LOCAL), Redis-or-memory KV
  integrations/                ports + adapters: Drive (Google/fake), AI (Gemini/fake), mail (Resend/log), Rust bridge
  modules/                     auth, me, org, projects, phases, workflow, governance, collab, insights, drive, admin
  worker/                      durable job runner, scheduler, handlers (runs as its own process or inline)
rust/doc-tools/                sandboxed DOCX text extractor (zip-bomb and XML limits), 7 tests
packages/api-client/           generated types + a small fetch client shared by web / React Native / Tauri
test/                          e2e suites on real PostgreSQL (tenant isolation, permissions, submissions, approvals, concurrency)
scripts/load/                  1,000,000-user dataset generator and the load test
docs/                          ARCHITECTURE, SCHEMA, API, SECURITY, OPERATIONS, SCALING, LOAD_TEST, INTEGRATIONS, STATUS
```

## Scripts

| Script | What it does |
|---|---|
| `npm test` | Throw-away PostgreSQL 18 + migrations + all Jest suites |
| `npm run typecheck` | Strict TypeScript |
| `npm run build` | Schema build, Prisma client, Nest build |
| `npm run migrate:deploy` | Apply migrations (owner role) |
| `npm run seed` | Demo data (refuses production unless `SEED_ALLOW=yes`) |
| `npm run openapi:export` | Writes `openapi.json` from the compiled app |
| `npm run client:generate` | OpenAPI → `packages/api-client/src/schema.d.ts` |
| `node scripts/gen-api-doc.mjs` | OpenAPI → `docs/API.md` |
| `node scripts/verify-ci-local.mjs` | The CI "migrations" job on the embedded PostgreSQL |
| `node scripts/load/build-dataset.mjs` then `node scripts/load/run.mjs` | Build the 1M-user dataset, run the load test |

## The three database roles

| Role | Used by | Can bypass RLS |
|---|---|---|
| owner | `prisma migrate deploy` only | n/a (owns the tables) |
| `projectn_app` | the API | **No**. The API refuses to start if its role could (superuser, BYPASSRLS, or table owner) or if the database is not UTF-8. |
| `projectn_system` | workers and Super Admin reports | Yes, in a few audited code paths |

## Licence

MIT, like the rest of the repository.
