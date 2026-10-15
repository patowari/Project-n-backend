# Operations

## 1. Environments

| Environment | API | Worker | Database | Redis |
|---|---|---|---|---|
| Local | `npm run start:dev` | `npm run start:worker` or `INLINE_WORKER=true` | Compose / any PG 16+ | optional (memory fallback) |
| Free demo (Render) | `render.yaml`: one free instance, in-process jobs | in the API | external Postgres (Neon) | none |
| Production | `render.production.yaml` or any container platform: ≥ 2 API instances | ≥ 2 worker instances | managed PostgreSQL with PITR + pooler | managed Redis |

The free demo is **not** a capacity statement: see [SCALING.md](SCALING.md). Do not size production from it.

## 2. First deployment checklist

1. Create the database with **UTF8** encoding (the API refuses to start otherwise).
2. Run migrations as the owner role: `DATABASE_MIGRATION_URL=... npx prisma migrate deploy`.
3. Set the runtime role passwords: `APP_DB_PASSWORD=... SYSTEM_DB_PASSWORD=... node scripts/db-setup.cjs` (min 16 chars).
4. Put the secrets in the platform's secret store, not in the repository: `JWT_SECRET` (≥ 32 chars), `TOKEN_ENCRYPTION_KEY` (`openssl rand -base64 32`), `CRON_SECRET`, `METRICS_TOKEN`, database URLs, Resend / Google / Gemini keys. Production start-up rejects the development defaults.
5. `DATABASE_URL` → `projectn_app`, `DATABASE_SYSTEM_URL` → `projectn_system`. If you use PgBouncer in **transaction** mode, add `?pgbouncer=true` (Prisma) — the app's `SET LOCAL` design is safe with it because every setting is transaction-scoped.
6. Create the first Super Admin: insert a user with `is_platform_admin = true` and a password hash, or run the seed in a non-production environment and promote an account (`UPDATE users SET is_platform_admin = true ...`).
7. Verify: `GET /healthz` (process), `GET /readyz` (database + cache), `GET /metrics` with the bearer token.

## 3. Migrations

* Forward-only SQL files in `prisma/migrations`. CI proves they apply to an empty database and equal `schema.prisma` (no drift).
* **Expand, then contract.** Release N adds columns/tables in a backward-compatible way; release N+1 removes what N no longer uses. Rolling deploys run old and new code side by side for a while.
* Any new table needs RLS and a grant: end the migration with `SELECT pn_grants();` and add policies (see `0002`). `verify-ci-local.mjs` fails CI if a table lacks RLS.
* `activity_log`, `reviews`, `overrides`, `audit_log` must stay append-only.

## 4. Health, metrics, logs

| Endpoint / stream | Purpose |
|---|---|
| `GET /healthz` | liveness; **no database query**, so a sleeping/failing database does not restart the API in a loop |
| `GET /readyz` | readiness: `SELECT 1` and cache ping; use for load-balancer health |
| `GET /metrics` | Prometheus: HTTP latency histogram by route/status, Node process metrics, `jobs_queue_depth{status}` |
| Logs | one JSON line per event and per request: `request_id`, `user_id`, `workspace_id`, `route`, `status`, `duration_ms`; the id is returned as `X-Request-Id` |

Suggested alerts (starting values, tune after a week of traffic):

| Signal | Threshold | Action |
|---|---|---|
| `http_request_duration_seconds` p95 | > 500 ms for 10 min | scale API out; check DB |
| 5xx rate | > 1 % for 5 min | page |
| `jobs_queue_depth{status="queued"}` | > 1,000 or growing 30 min | add workers |
| `jobs_queue_depth{status="failed"}` / dead jobs | > 0 | Super Admin → Failed jobs; read `last_error`; retry |
| DB connections | > 80 % of `max_connections` | add a pooler; lower `connection_limit` |
| Redis memory | > 80 % | raise or review key TTLs |
| Disk (PG) | > 75 % | grow volume; review `activity_log` retention |
| Google Drive `drive_disconnected` notifications | spike | provider incident or revoked consent |

## 5. Backups and restore

**What to protect:** PostgreSQL (everything). Redis holds only caches, counters and revocation markers (loss = users refresh, counters reset). Files live in the supervisors' Google Drives (outside our control by design).

| Layer | Setting |
|---|---|
| Managed PITR / WAL archiving | enabled; retention ≥ 7 days (30 recommended) |
| Logical backup | nightly `pg_dump` of the database, compressed and **encrypted** (age/GPG), off-platform bucket, 30 daily + 12 monthly kept |
| Encryption keys | `TOKEN_ENCRYPTION_KEY` (and previous ids) escrowed separately: without it Drive connections and queued e-mail cannot be decrypted |

Nightly dump (cron, GitHub Actions or the platform's cron):

```bash
pg_dump --format=custom --no-owner --dbname "$DATABASE_MIGRATION_URL" \
  | age -r "$BACKUP_PUBLIC_KEY" > projectn-$(date -u +%F).dump.age
```

Restore (into an empty UTF8 database, as the owner role):

```bash
age -d -i backup.key projectn-2026-10-15.dump.age \
  | pg_restore --no-owner --role=<owner> --dbname "$DATABASE_MIGRATION_URL" --exit-on-error
APP_DB_PASSWORD=... SYSTEM_DB_PASSWORD=... node scripts/db-setup.cjs      # roles are cluster-level: recreate passwords
psql "$DATABASE_MIGRATION_URL" -c "SELECT pn_grants()"                    # re-apply grants after restore
```

**Restore drill (monthly):** restore the latest dump into a scratch database, start the API against it, `GET /readyz`, sign in with a seeded test account, open a project, confirm `SELECT count(*) FROM activity_log` matches production within the backup window, record the time taken. Point-in-time recovery: use the platform's "restore to timestamp" into a **new** instance, verify, then switch connection strings.

## 6. Runbooks

| Situation | Steps |
|---|---|
| Dead jobs | Super Admin → Failed jobs (or `GET /admin/jobs`); read `last_error`; fix cause; `POST /admin/jobs/{id}/retry`. Handlers are idempotent, retrying is safe. |
| Queue backlog | `docker compose up --scale worker=N` / raise `numInstances`; check `WORKER_CONCURRENCY` and the database. |
| A supervisor's Drive shows "error" | the refresh token was revoked; uploads for their projects answer `409 drive_not_connected` and they are notified; they reconnect in Settings → Integrations. |
| AI bill spike | check `GET /admin/usage`; set `ai_monthly_budget_usd` to `0` to pause AI for a workspace. |
| Rotate `TOKEN_ENCRYPTION_KEY` | introduce a new key id, re-encrypt `google_drive_connections.refresh_token_enc` in a script, then retire the old key. (A rotation script is **not** included.) |
| Suspected stolen refresh token | the reuse detector already revoked the session; for a user, "Sign out of all other devices" or reset password (revokes all). |
| Lost Redis | restart it empty: rate-limit counters reset, revoked-session markers are lost for at most 15 minutes (the access-token lifetime), caches refill. |
| Restore after data loss | section 5, then run `drive.verify_files` (it flags files missing in Drive) and `health.sweep`. |

## 7. Retention

* `refresh_tokens`, revoked `sessions`, `auth_tokens`, `idempotency_keys`, read notifications (> 90 d) and succeeded jobs (> 14 d) are purged nightly (`sessions.cleanup`).
* `activity_log` and `audit_log` grow without bound. Plan: partition by month once a workspace exceeds ~10 M rows and archive old partitions (not implemented; see SCALING.md). The retention period after project completion (decision D6) is not defined, so nothing is deleted automatically.
