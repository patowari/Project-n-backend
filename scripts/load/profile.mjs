// Where does a request spend its time? CPU of the API process, SQL statements per request,
// and statement time, for a few representative endpoints on the 1M-user dataset.
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import autocannon from 'autocannon'
import jwt from 'jsonwebtoken'
import { ensureLoadDb } from './build-dataset.mjs'

const { pg, u } = await ensureLoadDb()
const owner = pg.getPgClient('projectn')
await owner.connect()
const q = async (sql, p = []) => (await owner.query(sql, p)).rows
const ws = (await q("select id from workspaces where name = 'Load University 1'"))[0].id
const who = async (idx) => (await q('select u.id from users u where u.email = $1', [`load${idx}@load.test`]))[0].id
const dean = await who(2)
const supervisor = (await q(`select pm.user_id from project_members pm where pm.workspace_id = $1 and pm.role = 'lead' group by 1 order by count(*) desc limit 1`, [ws]))[0].user_id
const project = (await q(`select project_id id from project_members where user_id = $1 and role = 'lead' limit 1`, [supervisor]))[0].id
const student = (await q('select user_id from project_members where project_id = $1 and is_group_leader', [project]))[0].user_id
const tok = (sub) => jwt.sign({ sid: randomUUID() }, 'dev-only-secret-change-me-dev-only-secret-change-me', { algorithm: 'HS256', subject: sub, expiresIn: 3600, issuer: 'project-n' })
const H = (sub) => ({ authorization: `Bearer ${tok(sub)}`, 'x-workspace-id': ws })

const port = 8011
const api = spawn('node', ['dist/main.js'], { env: { ...process.env, NODE_ENV: 'development', PORT: String(port), LOG_LEVEL: 'warn', DB_QUERY_METRICS: 'true', DATABASE_URL: `${u.app}?connection_limit=20`, DATABASE_SYSTEM_URL: u.system, RATE_LIMIT_SCALE: '1000000' }, stdio: ['ignore', 'inherit', 'inherit'] })
for (let i = 0; i < 100; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/readyz`)).ok) break } catch {} await new Promise((r) => setTimeout(r, 500)) }

const metric = async (name) => Number(new RegExp(`^${name} ([0-9.e+-]+)$`, 'm').exec(await (await fetch(`http://127.0.0.1:${port}/metrics`)).text())?.[1] ?? 0)
const out = []
for (const [label, path, sub] of [
  ['GET /me', '/me', student], ['GET /projects (student)', '/projects?limit=50', student], ['GET /projects (supervisor)', '/projects?limit=50', supervisor],
  ['GET /projects (dean)', '/projects?limit=50', dean], ['GET /projects/{id}', `/projects/${project}`, supervisor], ['GET /activity (dean)', '/activity?limit=50', dean],
]) {
  await fetch(`http://127.0.0.1:${port}/api/v1${path}`, { headers: H(sub) })
  const c0 = await metric('process_cpu_user_seconds_total') + await metric('process_cpu_system_seconds_total')
  const q0 = await metric('db_queries_total')
  const d0 = await metric('db_query_duration_seconds_sum')
  const res = await autocannon({ url: `http://127.0.0.1:${port}/api/v1${path}`, connections: 16, duration: 8, headers: H(sub) })
  const n = res.requests.total
  const cpu = (await metric('process_cpu_user_seconds_total') + await metric('process_cpu_system_seconds_total')) - c0
  const queries = (await metric('db_queries_total')) - q0
  const dbSec = (await metric('db_query_duration_seconds_sum')) - d0
  out.push({ endpoint: label, reqPerSec: Math.round(res.requests.average), apiCpuMsPerReq: +((cpu * 1000) / n).toFixed(2), sqlPerReq: +(queries / n).toFixed(1), sqlMsPerReq: +((dbSec * 1000) / n).toFixed(2), p50: res.latency.p50 })
}
console.table(out)
api.kill()
await owner.end()
await pg.stop()
import('node:fs').then((fs) => fs.writeFileSync('docs/load-profile.json', JSON.stringify(out, null, 2)))
process.exit(0)
