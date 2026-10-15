// Does throughput grow when API instances are added? 1, 2 and 4 stateless API processes, the same
// database, the same mixed profile, one load generator per instance, results summed.
// Caveat printed in the report: everything shares this machine's CPUs, so this shows that the API is
// stateless and the database is not the first limit; it is NOT a proof of linear multi-host scaling.
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import os from 'node:os'
import autocannon from 'autocannon'
import jwt from 'jsonwebtoken'
import { ensureLoadDb } from './build-dataset.mjs'

const { pg, u } = await ensureLoadDb()
const owner = pg.getPgClient('projectn')
await owner.connect()
const q = async (sql, p = []) => (await owner.query(sql, p)).rows
const ws = (await q("select id from workspaces where name = 'Load University 1'"))[0].id
const supervisor = (await q(`select pm.user_id from project_members pm where pm.workspace_id = $1 and pm.role = 'lead' group by 1 order by count(*) desc limit 1`, [ws]))[0].user_id
const project = (await q(`select project_id id from project_members where user_id = $1 and role = 'lead' limit 1`, [supervisor]))[0].id
const student = (await q('select user_id from project_members where project_id = $1 and is_group_leader', [project]))[0].user_id
const dean = (await q("select id from users where email = 'load2@load.test'"))[0].id
const tok = (sub) => jwt.sign({ sid: randomUUID() }, 'dev-only-secret-change-me-dev-only-secret-change-me', { algorithm: 'HS256', subject: sub, expiresIn: 3600, issuer: 'project-n' })
const H = (sub) => ({ authorization: `Bearer ${tok(sub)}`, 'x-workspace-id': ws, 'content-type': 'application/json' })
const today = new Date().toISOString().slice(0, 10)
const body = (p) => JSON.stringify(p)
const mix = [
  ...Array(4).fill(['GET', '/projects?limit=50', student]), ['GET', `/projects/${project}`, student], ['GET', '/notifications/unread-count', student], ['GET', '/me', student],
  ...Array(3).fill(['GET', '/projects?limit=50', supervisor]), ['GET', `/projects/${project}`, supervisor], ['GET', '/reviews/queue', supervisor], ['GET', `/projects/${project}/activity`, supervisor],
  ['GET', '/activity?limit=50', dean], ['GET', '/reports/summary', dean],
  ['POST', '/comments', student, body({ project_id: project, body: 'scale', supervisors_only: false, target: { type: 'project', id: project, label: '' } })],
  ['POST', '/time-logs', student, body({ project_id: project, kind: 'hours', hours: 1, note: 'scale', date: today })],
]
const reqs = mix.map((m) => ({ method: m[0], path: `/api/v1${m[1]}`, headers: H(m[2]), ...(m[3] ? { body: m[3] } : {}) }))

const results = []
for (const n of [1, 2, 4]) {
  const ports = Array.from({ length: n }, (_, i) => 8030 + i)
  const procs = ports.map((port) => spawn('node', ['dist/main.js'], { env: { ...process.env, NODE_ENV: 'development', PORT: String(port), LOG_LEVEL: 'error', DATABASE_URL: `${u.app}?connection_limit=15`, DATABASE_SYSTEM_URL: u.system, RATE_LIMIT_SCALE: '1000000' }, stdio: 'ignore' }))
  for (const port of ports) for (let i = 0; i < 120; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/readyz`)).ok) break } catch {} await new Promise((r) => setTimeout(r, 500)) }
  const runs = await Promise.all(ports.map((port) => autocannon({ url: `http://127.0.0.1:${port}`, connections: 32, duration: 15, requests: reqs, timeout: 30 })))
  const total = runs.reduce((a, r) => a + r.requests.average, 0)
  const failed = runs.reduce((a, r) => a + r.non2xx + r.errors + r.timeouts, 0)
  results.push({ instances: n, reqPerSec: Math.round(total), p50: Math.max(...runs.map((r) => r.latency.p50)), p99: Math.max(...runs.map((r) => r.latency.p99)), failed })
  console.log(results.at(-1))
  procs.forEach((p) => p.kill())
  await new Promise((r) => setTimeout(r, 2000))
}
writeFileSync('docs/load-scaleout.json', JSON.stringify({ machine: { cpus: os.cpus().length, cpu: os.cpus()[0].model }, results }, null, 2))
await owner.end()
await pg.stop()
process.exit(0)
