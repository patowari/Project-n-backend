// Who burns the CPU during the mixed profile: the API process, PostgreSQL, or the load generator?
import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import os from 'node:os'
import autocannon from 'autocannon'
import jwt from 'jsonwebtoken'
import { ensureLoadDb } from './build-dataset.mjs'

const pgCpuSeconds = () =>
  Number(execFileSync('powershell', ['-NoProfile', '-Command', "(Get-Process postgres -ErrorAction SilentlyContinue | Measure-Object -Property CPU -Sum).Sum"], { encoding: 'utf8' }).trim() || 0)

const { pg, u } = await ensureLoadDb()
const owner = pg.getPgClient('projectn')
await owner.connect()
const q = async (sql, p = []) => (await owner.query(sql, p)).rows
const ws = (await q("select id from workspaces where name = 'Load University 1'"))[0].id
const supervisor = (await q(`select pm.user_id from project_members pm where pm.workspace_id = $1 and pm.role = 'lead' group by 1 order by count(*) desc limit 1`, [ws]))[0].user_id
const project = (await q(`select project_id id from project_members where user_id = $1 and role = 'lead' limit 1`, [supervisor]))[0].id
const student = (await q('select user_id from project_members where project_id = $1 and is_group_leader', [project]))[0].user_id
const tok = (sub) => jwt.sign({ sid: randomUUID() }, 'dev-only-secret-change-me-dev-only-secret-change-me', { algorithm: 'HS256', subject: sub, expiresIn: 3600, issuer: 'project-n' })
const H = (sub) => ({ authorization: `Bearer ${tok(sub)}`, 'x-workspace-id': ws })

const api = spawn('node', ['dist/main.js'], { env: { ...process.env, NODE_ENV: 'development', PORT: '8040', LOG_LEVEL: 'error', DATABASE_URL: `${u.app}?connection_limit=20`, DATABASE_SYSTEM_URL: u.system, RATE_LIMIT_SCALE: '1000000' }, stdio: 'ignore' })
for (let i = 0; i < 120; i++) { try { if ((await fetch('http://127.0.0.1:8040/readyz')).ok) break } catch {} await new Promise((r) => setTimeout(r, 500)) }
const metric = async (n) => Number(new RegExp(`^${n} ([0-9.e+-]+)$`, 'm').exec(await (await fetch('http://127.0.0.1:8040/metrics')).text())?.[1] ?? 0)
const apiCpu = async () => (await metric('process_cpu_user_seconds_total')) + (await metric('process_cpu_system_seconds_total'))

const reqs = [
  ...Array(4).fill(['/projects?limit=50', student]), [`/projects/${project}`, student], ['/notifications/unread-count', student], ['/me', student],
  ...Array(3).fill(['/projects?limit=50', supervisor]), [`/projects/${project}`, supervisor], ['/reviews/queue', supervisor], [`/projects/${project}/activity`, supervisor],
].map(([p, sub]) => ({ method: 'GET', path: `/api/v1${p}`, headers: H(sub) }))

const DURATION = 15
const myCpu0 = process.cpuUsage()
const a0 = await apiCpu()
const p0 = pgCpuSeconds()
const res = await autocannon({ url: 'http://127.0.0.1:8040', connections: 32, duration: DURATION, requests: reqs })
const apiSec = (await apiCpu()) - a0
const pgSec = pgCpuSeconds() - p0
const me = process.cpuUsage(myCpu0)
const out = {
  logicalCpus: os.cpus().length,
  reqPerSec: Math.round(res.requests.average),
  seconds: DURATION,
  cpuSecondsUsed: { apiProcess: +apiSec.toFixed(1), postgres: +pgSec.toFixed(1), loadGenerator: +((me.user + me.system) / 1e6).toFixed(1) },
  cpuCoresBusy: { apiProcess: +(apiSec / DURATION).toFixed(2), postgres: +(pgSec / DURATION).toFixed(2), loadGenerator: +((me.user + me.system) / 1e6 / DURATION).toFixed(2) },
}
out.cpuCoresBusy.total = +(out.cpuCoresBusy.apiProcess + out.cpuCoresBusy.postgres + out.cpuCoresBusy.loadGenerator).toFixed(2)
console.log(JSON.stringify(out, null, 2))
writeFileSync('docs/load-cpu-split.json', JSON.stringify(out, null, 2))
api.kill()
await owner.end()
await pg.stop()
process.exit(0)
