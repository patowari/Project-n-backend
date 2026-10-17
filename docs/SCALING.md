# Scaling: assumptions, sizing model, bottlenecks, and what is not proven

**Goal:** a path to about **1,000,000 registered users**. That is a count of accounts in the database, not 1,000,000 people online at once. This document does not claim the system *handles* that number; it states the assumptions, turns the measured per-request cost ([LOAD_TEST.md](LOAD_TEST.md)) into a sizing *model*, and lists what must still be tested before anyone relies on it.

## 1. Workload assumptions (inputs, not measurements)

Nobody has used this system yet, so these are guesses to be replaced with production metrics as soon as they exist.

| Assumption | Low | **Base** | High |
|---|---:|---:|---:|
| Registered users | 1,000,000 | 1,000,000 | 1,000,000 |
| Daily active users (share of registered) | 5% | **10%** | 20% |
| API requests per active user per day | 30 | **40** | 60 |
| Requests per day | 1.5 M | **4 M** | 12 M |
| Average requests per second | 17 | **46** | 139 |
| Peak-to-average factor (deadline days, working hours) | 3× | **5×** | 5× |
| **Peak requests per second** | **≈ 52** | **≈ 230** | **≈ 700** |

Also assumed: about 90% reads, a few thousand submissions per day (a submission is a rare, important write), uploads go from the browser straight to Google Drive (the API never carries file bytes for large files), AI feedback runs in the background and never blocks a request.

Why a university system is spiky: load clusters at phase deadlines. The peak factor is the weakest assumption here; a deadline at midnight for 50,000 students could exceed 5×.

## 2. Measured cost per request

From [LOAD_TEST.md](LOAD_TEST.md) §4 (one Ryzen 5 3400G, mixed read profile on the 1M-user dataset):

| | CPU per request |
|---|---:|
| API process (Node, validation, serialization, Prisma, auth) | ≈ 25 ms |
| PostgreSQL (RLS, joins, index lookups) | ≈ 16 ms |
| **Total** | **≈ 40 ms** |

The heaviest list endpoints (Dean/Head project lists) cost two to three times that; `GET /me` and the unread counter cost a third. A single Node process is limited to roughly one core of JavaScript, so throughput per API instance is about `1 / 0.025 s ≈ 40 req/s` per core.

## 3. Sizing model (arithmetic on the assumptions above)

Required CPU = peak req/s × cost per request, divided by a target utilisation of 60% (headroom for bursts, garbage collection, and autovacuum).

| | Low (≈ 52 req/s) | **Base (≈ 230 req/s)** | High (≈ 700 req/s) |
|---|---:|---:|---:|
| API cores busy at peak (× 25 ms) | 1.3 | **5.8** | 17.5 |
| API vCPUs provisioned (÷ 0.6) | ~2 | **~10** | ~29 |
| PostgreSQL cores busy at peak (× 16 ms) | 0.8 | **3.7** | 11.2 |
| PostgreSQL vCPUs provisioned (÷ 0.6) | ~2 | **~6, so an 8 vCPU instance** | ~19, so 16 to 24 vCPU |
| Worker processes | 1 | 2 | 3 to 4 |

A starting point for the **base** case, to be confirmed by a test on the real hosts:

| Component | Starting size | Notes |
|---|---|---|
| API | 5 instances × 2 vCPU / 2 GB behind a load balancer | Stateless; autoscale on CPU (60% target). `render.production.yaml` starts at 2 and allows up to 8 of a 1 vCPU class: **raise the instance class or count to match this table.** |
| Worker | 2 instances × 1 vCPU / 1 GB | Independent process, safe to run many (`FOR UPDATE SKIP LOCKED`; 0 duplicates measured). |
| PostgreSQL | 8 vCPU / 32 GB RAM, SSD, point-in-time recovery | The working set (indexes of the big tables) should fit in RAM. A read replica is *not* used by the code today. |
| Connection pooling | PgBouncer in **transaction** mode | Required: ~5 API instances × 20 connections is 100 backends, which wastes memory; see §6. |
| Redis | 1 to 2 GB, with persistence off | Rate limits, cache, session revocation. If Redis is configured but unreachable, requests currently fail (see §6). |
| Object storage | none | Files live in the Lead supervisor's own Google Drive. |

The **free demo** (`render.yaml`: one 0.1 CPU instance, in-process worker, a sleeping database) shows the product works; it is not sized from this model and cannot serve more than a small class.

## 4. What the measurements support, and what they do not

| Claim | Status |
|---|---|
| Hot queries use indexes, no sequential scans on large tables, with RLS on, on a 1M-user dataset | **Measured** |
| Zero failed requests at 32 concurrent connections on that dataset | **Measured** (15 s bursts) |
| Per-request CPU cost ≈ 40 ms (25 API + 16 DB) on one desktop-class CPU | **Measured** once, ±15% run to run |
| Adding API instances helps because the API is stateless | **Observed** on one host (48 → 80 → 100 req/s for 1 → 2 → 4 instances), flattening at the machine's limit |
| The queue executes each job once under competition | **Measured**: 20,166 jobs, 2 runners, 0 duplicates |
| The sizing table in §3 | **Model only.** It extrapolates one desktop CPU to cloud vCPUs. A cloud vCPU is often one hyperthread, i.e. potentially slower per vCPU; if so the vCPU counts above are too low. |
| 230 req/s at peak, p99 below one second on real infrastructure | **Not tested** |
| 1,000,000 simultaneous users | **Not claimed, not designed for.** Nothing here supports it. |

## 5. Not tested at all

* Network latency to a remote database (each request makes 6 to 16 SQL statements; at 1 ms per round trip that is up to 16 ms more per request, at 5 ms it is 80 ms).
* PgBouncer, a real Redis server, TLS termination, a CDN or reverse proxy.
* Multiple API hosts, a remote worker pool, a separate PostgreSQL host, PostgreSQL replication or failover.
* Soak: hours or days of load, memory growth, autovacuum behaviour, index bloat.
* Skewed data: one tenant with 100,000+ projects, a Dean whose faculty holds tens of thousands of projects, thousands of comments on one project.
* Spiky arrival (deadline stampedes) and open-loop traffic; slow clients.
* Real Drive, Gemini and e-mail calls, which are slower and have their own quotas.
* Backup and restore time on a database of this size.

## 6. Known bottlenecks and what to do about them (in order)

1. **API CPU (≈ 25 ms per request).** Largest single cost. Options: more instances (works today); cache the per-user `GET /me` result for seconds; trim Prisma overhead on hot paths (several hot paths already use raw SQL); response compression is already on.
2. **RLS cost for users with a very large scope** (Dean/Head project lists: 120 ms of SQL per request in the profile). The policy functions are evaluated once per query, but a large faculty still joins many rows. Mitigations if it matters in practice: a materialised per-user visible-project table refreshed by the worker; or keyset pagination limits (already used) plus lower default page sizes.
3. **The student project list** (68 ms query). Likely the membership check against the largest tables; investigate before the first large tenant.
4. **Connection count.** Each API instance holds up to 20 connections. Put PgBouncer (transaction mode) in front, keeping `SET LOCAL` per transaction (which is how workspace context is set, so it is pooler-safe).
5. **`activity_log` and `audit_log` growth** (≈ 2 M rows in the test dataset). Plan: partition by month and archive once a tenant passes ~10 M rows. Not implemented.
6. **Redis outage behaviour.** If `REDIS_URL` is set but Redis is unreachable, requests that rate-limit or check session revocation return `500`. Decide between failing open (availability, weaker abuse protection and lock-out during the outage) and failing closed (current behaviour). Not changed yet; run Redis with a replica.
7. **Workers.** One queue in PostgreSQL handled ~1,270 jobs/s in the test; e-mail and AI calls are bounded by their providers' rate limits, not by the queue.
8. **Login hashing.** Argon2id at 19 MiB costs ≈ 100 ms and a lot of memory per login. A login storm (start of term, 10,000 people in 5 minutes ≈ 33/s) needs about 3 dedicated cores; the per-user and per-IP rate limits cap abuse.

## 7. Before anyone says "it scales to a million"

1. Deploy to the real infrastructure class (managed PostgreSQL, PgBouncer, Redis, 2+ API instances), load-generate from a separate machine in the same region.
2. Re-run `scripts/load` against it with the 1M dataset, then with a skewed one, then a 2-hour soak.
3. Replace §1 with real traffic numbers from production metrics (`/metrics`: request rate, latency histograms, DB time, queue depth).
4. Run the backup/restore drill on a database of production size and record how long it takes.
