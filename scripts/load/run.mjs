// Load test against the real API (compiled), real PostgreSQL 18 with Row Level Security enforced,
// and the 1,000,000-user dataset. Everything runs on THIS machine, so numbers are a floor for the
// API/DB work itself and say nothing about network, Redis, or a production-sized database host.
//
//   node scripts/load/build-dataset.mjs     # once
//   npm run build && node scripts/load/run.mjs
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import autocannon from 'autocannon'
import jwt from 'jsonwebtoken'
import pgpkg from 'pg'
import * as argon2 from 'argon2'
import { ensureLoadDb } from './build-dataset.mjs'

const DURATION = Number(process.env.LT_DURATION ?? 15)
const CONNECTIONS = Number(process.env.LT_CONNECTIONS ?? 32)
const JWT_SECRET = 'dev-only-secret-change-me-dev-only-secret-change-me'
const PORT = 8010

const { pg, u } = await ensureLoadDb()
const owner = pg.getPgClient('projectn')
await owner.connect()
const q = async (sql, p = []) => (await owner.query(sql, p)).rows

/* ---- actors: workspace 1 ---- */
const ws = (await q("select id from workspaces where name = 'Load University 1'"))[0].id
const user = async (idx) => (await q("select u.id from users u join memberships m on m.user_id = u.id where m.workspace_id = $1 and u.email = $2", [ws, `load${idx}@load.test`]))[0].id
const admin = await user(1)
const dean = await user(2)
const head = await user(5)
// a supervisor who leads projects, and the leader of one of their groups
const supRow = (await q(`select pm.user_id, count(*) n from project_members pm join projects p on p.id = pm.project_id where pm.workspace_id = $1 and pm.role = 'lead' group by 1 order by n desc limit 1`, [ws]))[0]
const supervisor = supRow.user_id
const project = (await q(`select p.id from projects p join project_members pm on pm.project_id = p.id and pm.user_id = $1 and pm.role = 'lead' where p.workspace_id = $2 limit 1`, [supervisor, ws]))[0].id
const student = (await q(`select user_id from project_members where project_id = $1 and is_group_leader`, [project]))[0].user_id
const phase = (await q(`select id from phases where project_id = $1 and status = 'open' limit 1`, [project]))[0]?.id
const submissionId = (await q(`select id from submissions where project_id = $1 limit 1`, [project]))[0]?.id

const token = (sub) => jwt.sign({ sid: randomUUID() }, JWT_SECRET, { algorithm: 'HS256', subject: sub, expiresIn: 3600, issuer: 'project-n' })
const headers = (sub) => ({ authorization: `Bearer ${token(sub)}`, 'x-workspace-id': ws, 'content-type': 'application/json' })
const H = { admin: headers(admin), dean: headers(dean), head: headers(head), supervisor: headers(supervisor), student: headers(student) }

/* ---- a user with a real argon2 password, for the login scenario ---- */
const pw = 'correct-horse-battery-9'
await q('update users set password_hash = $1 where id = $2', [await argon2.hash(pw, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 }), student])
const studentEmail = (await q('select email from users where id = $1', [student]))[0].email

/* ---- start API instance(s) ---- */
function startApi(port) {
  const child = spawn('node', ['dist/main.js'], {
    env: { ...process.env, NODE_ENV: 'development', PORT: String(port), LOG_LEVEL: 'warn', DATABASE_URL: `${u.app}?connection_limit=${process.env.LT_POOL ?? 20}`, DATABASE_SYSTEM_URL: u.system, RATE_LIMIT_SCALE: '1000000', ARGON_MEMORY_KIB: '19456', ARGON_TIME_COST: '2' },
    stdio: ['ignore', 'inherit', 'inherit'],
  })
  return child
}
async function waitReady(port) {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/readyz`)).ok) return
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('API did not start')
}
const api = startApi(PORT)
await waitReady(PORT)
const base = `http://127.0.0.1:${PORT}/api/v1`

/* ---- scenarios ---- */
const week = (n) => new Date(Date.now() + n * 86400_000).toISOString().slice(0, 10)
const scenarios = [
  ['GET /me (student)', 'GET', '/me', 'student'],
  ['GET /projects?limit=50 (student: 1 project)', 'GET', '/projects?limit=50', 'student'],
  ['GET /projects?limit=50 (supervisor)', 'GET', '/projects?limit=50', 'supervisor'],
  ['GET /projects?limit=50 (head: department)', 'GET', '/projects?limit=50', 'head'],
  ['GET /projects?limit=50 (dean: faculty, ~830 visible)', 'GET', '/projects?limit=50', 'dean'],
  ['GET /projects?limit=50 (institution admin: 2,500 rows)', 'GET', '/projects?limit=50', 'admin'],
  ['GET /projects/{id} (supervisor, detail)', 'GET', `/projects/${project}`, 'supervisor'],
  ['GET /projects/{id}/activity (supervisor)', 'GET', `/projects/${project}/activity`, 'supervisor'],
  ['GET /activity?limit=50 (dean, faculty scope)', 'GET', '/activity?limit=50', 'dean'],
  ['GET /reviews/queue (supervisor)', 'GET', '/reviews/queue', 'supervisor'],
  ['GET /calendar (student, 30 days)', 'GET', `/calendar?from=${week(-15)}&to=${week(15)}`, 'student'],
  ['GET /notifications/unread-count (supervisor)', 'GET', '/notifications/unread-count', 'supervisor'],
  ['GET /reports/summary (dean, cached 60 s)', 'GET', '/reports/summary', 'dean'],
  ['POST /comments (student)', 'POST', '/comments', 'student', JSON.stringify({ project_id: project, body: 'load test comment', supervisors_only: false, target: { type: 'project', id: project, label: '' } })],
]

async function run(title, reqs, opts = {}) {
  const res = await autocannon({ url: base, connections: opts.connections ?? CONNECTIONS, duration: opts.duration ?? DURATION, requests: reqs, timeout: 30 })
  return {
    title, connections: res.connections, durationS: res.duration,
    reqPerSec: Math.round(res.requests.average), latencyMs: { p50: res.latency.p50, p90: res.latency.p90, p97_5: res.latency.p97_5, p99: res.latency.p99, max: res.latency.max },
    total: res.requests.total, non2xx: res.non2xx, errors: res.errors, timeouts: res.timeouts, bytesPerSec: Math.round(res.throughput.average),
  }
}
const toReq = (s) => ({ method: s[1], path: `/api/v1${s[2]}`.replace('/api/v1/api/v1', '/api/v1'), headers: H[s[3]], ...(s[4] ? { body: s[4] } : {}) })

// verify every scenario answers 2xx before measuring
for (const s of scenarios) {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/v1${s[2]}`, { method: s[1], headers: H[s[3]], body: s[4] })
  if (r.status >= 300) throw new Error(`${s[0]} -> ${r.status} ${(await r.text()).slice(0, 200)}`)
}

const results = { startedAt: new Date().toISOString(), machine: { cpus: os.cpus().length, cpu: os.cpus()[0].model, memGb: Math.round(os.totalmem() / 2 ** 30), platform: `${os.platform()} ${os.release()}`, node: process.version }, postgres: (await q('show server_version'))[0].server_version, config: { connections: CONNECTIONS, durationS: DURATION, dbPool: Number(process.env.LT_POOL ?? 20) }, scenarios: [], cold: [], login: null, mixed: null, plans: [] }

for (const s of scenarios) {
  console.log(`> ${s[0]}`)
  results.scenarios.push(await run(s[0], [toReq(s)]))
}

console.log('> mixed realistic profile (80% reads, 20% writes, 5 personas)')
const mix = [
  ...Array(4).fill(['GET', '/projects?limit=50', 'student']), ['GET', `/projects/${project}`, 'student'], ['GET', '/notifications/unread-count', 'student'], ['GET', '/me', 'student'],
  ...Array(3).fill(['GET', '/projects?limit=50', 'supervisor']), ['GET', `/projects/${project}`, 'supervisor'], ['GET', '/reviews/queue', 'supervisor'], ['GET', `/projects/${project}/activity`, 'supervisor'],
  ['GET', '/activity?limit=50', 'dean'], ['GET', '/reports/summary', 'dean'], ['GET', '/projects?limit=50', 'dean'],
  ['POST', '/comments', 'student', JSON.stringify({ project_id: project, body: 'mixed', supervisors_only: false, target: { type: 'project', id: project, label: '' } })],
  ['POST', '/comments', 'supervisor', JSON.stringify({ project_id: project, body: 'reply', supervisors_only: false, target: { type: 'project', id: project, label: '' } })],
  ['POST', '/time-logs', 'student', JSON.stringify({ project_id: project, kind: 'hours', hours: 1, note: 'load', date: week(0) })],
]
results.mixed = await run('mixed profile', mix.map((m) => ({ method: m[0], path: `/api/v1${m[1]}`, headers: H[m[2]], ...(m[3] ? { body: m[3] } : {}) })))

console.log('> login (argon2id 19 MiB, t=2), 4 connections')
results.login = await run('POST /auth/login', [{ method: 'POST', path: '/api/v1/auth/login', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: studentEmail, password: pw }) }], { connections: 4, duration: 10 })

console.log('> cold reports/summary for 8 different deans (cache miss, 250k-project database)')
for (let f = 1; f <= 8; f++) {
  const d = await user(2 + (f % 3))
  const wsn = (await q("select id from workspaces where name = $1", [`Load University ${f}`]))[0].id
  const dn = (await q(`select m.user_id from memberships m join membership_roles r on r.membership_id = m.id and r.role = 'dean' where m.workspace_id = $1 limit 1`, [wsn]))[0].user_id
  const t0 = performance.now()
  const r = await fetch(`${base}/reports/summary`, { headers: { authorization: `Bearer ${token(dn)}`, 'x-workspace-id': wsn } })
  results.cold.push({ workspace: f, status: r.status, ms: Math.round(performance.now() - t0) })
  void d
}

const metrics = await (await fetch(`http://127.0.0.1:${PORT}/metrics`)).text()
const rss = Number(/process_resident_memory_bytes (\d+)/.exec(metrics)?.[1] ?? 0)
const conns = (await q("select count(*) n from pg_stat_activity where datname = 'projectn' and usename like 'projectn_%'"))[0].n
results.apiRssMb = Math.round(rss / 2 ** 20)
results.dbConnectionsAfter = Number(conns)

/* ---- worker paths (system role, no workspace filter): health recompute and the job queue ---- */
{
  const { createRequire } = await import('node:module')
  const require = createRequire(import.meta.url)
  require('reflect-metadata')
  const { PrismaClient } = require('@prisma/client')
  const { HealthService } = require('../../dist/modules/workflow/health.service.js')
  const { ActivityService, NotificationService, JobsService } = require('../../dist/modules/core/core.services.js')
  const { JobRunner } = require('../../dist/worker/runner.js')
  const sys = new PrismaClient({ datasources: { db: { url: u.system } } })
  const jobs = new JobsService({ active: false, ctx: {} }, { tokenEncryptionKey: Buffer.alloc(32, 7) })
  const health = new HealthService(new ActivityService({}), new NotificationService({}, jobs), jobs)
  const ids = (await q("select id from projects tablesample system (0.5) limit 400")).map((r) => r.id)
  const times = []
  for (const id of ids) {
    const t0 = performance.now()
    await health.recompute(sys, id)
    times.push(performance.now() - t0)
  }
  times.sort((a, b) => a - b)
  const pct = (p) => Math.round(times[Math.min(times.length - 1, Math.floor(times.length * p))] * 10) / 10
  results.worker = { healthRecompute: { projects: times.length, avgMs: Math.round((times.reduce((a, b) => a + b, 0) / times.length) * 10) / 10, p50Ms: pct(0.5), p95Ms: pct(0.95), p99Ms: pct(0.99) } }

  // queue claim throughput with 20,000 queued no-op jobs, two competing runners
  await q("delete from jobs where kind = 'bench.noop'")
  await q("insert into jobs (kind, payload) select 'bench.noop', '{}' from generate_series(1, 20000)")
  const handlers = { run: async () => undefined, onDead: async () => undefined }
  const env = { }
  const r1 = new JobRunner(sys, handlers, env)
  const r2 = new JobRunner(sys, handlers, env)
  const t0 = performance.now()
  let done = 0
  await Promise.all([r1, r2].map(async (r) => {
    for (;;) {
      const n = await r.runOnce(50)
      if (n === 0) break
      done += n
    }
  }))
  const secs = (performance.now() - t0) / 1000
  const dupes = Number((await q("select count(*) n from jobs where kind = 'bench.noop' and attempts <> 1"))[0].n)
  results.worker.queue = { jobs: done, seconds: Math.round(secs * 10) / 10, jobsPerSec: Math.round(done / secs), runnersCompeting: 2, executedMoreThanOnce: dupes }
  await q("delete from jobs where kind = 'bench.noop'")
  await sys.$disconnect()
}

/* ---- query plans under RLS (as the restricted app role, with the real settings) ---- */
const { Client } = pgpkg
const app = new Client({ connectionString: u.app })
await app.connect()
async function explain(name, userId, sql) {
  await app.query('begin')
  await app.query("select set_config('app.user_id', $1, true), set_config('app.workspace_id', $2, true)", [userId, ws])
  const plan = (await app.query(`explain (analyze, buffers, format json) ${sql}`)).rows[0]['QUERY PLAN'][0]
  await app.query('rollback')
  const nodes = JSON.stringify(plan.Plan)
  results.plans.push({ name, executionMs: Math.round(plan['Execution Time'] * 10) / 10, planningMs: Math.round(plan['Planning Time'] * 10) / 10, seqScansOnBigTables: [...nodes.matchAll(/"Node Type":"Seq Scan","[^}]*?"Relation Name":"(\w+)"/g)].map((m) => m[1]).filter((t) => ['projects', 'activity_log', 'submissions', 'phases', 'project_members', 'memberships', 'users', 'comments'].includes(t)), sharedHit: plan.Plan['Shared Hit Blocks'], sharedRead: plan.Plan['Shared Read Blocks'] })
}
await explain('projects page: student', student, 'select id, title from projects where deleted_at is null order by created_at desc, id desc limit 51')
await explain('projects page: supervisor', supervisor, 'select id, title from projects where deleted_at is null order by created_at desc, id desc limit 51')
await explain('projects page: dean (faculty scope)', dean, 'select id, title from projects where deleted_at is null order by created_at desc, id desc limit 51')
await explain('projects page: institution admin', admin, 'select id, title from projects where deleted_at is null order by created_at desc, id desc limit 51')
await explain('activity feed: dean', dean, 'select id from activity_log order by occurred_at desc, id desc limit 51')
await explain('activity feed: project (student)', student, `select id from activity_log where project_id = '${project}' order by occurred_at desc, id desc limit 51`)
await explain('pending reviews (supervisor)', supervisor, "select id from submissions where status = 'submitted' order by submitted_at desc limit 300")
await explain('comments for a project (student)', student, `select id from comments where project_id = '${project}' and deleted_at is null order by created_at limit 500`)
await app.end()

api.kill()
await owner.end()
await pg.stop()

mkdirSync('docs', { recursive: true })
writeFileSync('docs/load-results.json', JSON.stringify(results, null, 2))
console.log('\nwritten docs/load-results.json')
for (const s of [...results.scenarios, results.mixed, results.login]) console.log(`${s.title.padEnd(58)} ${String(s.reqPerSec).padStart(6)} req/s   p50 ${String(s.latencyMs.p50).padStart(5)}  p99 ${String(s.latencyMs.p99).padStart(5)} ms   non2xx ${s.non2xx} err ${s.errors}`)
void submissionId
void phase
process.exit(0)
