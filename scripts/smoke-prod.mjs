// Production-mode smoke test of the COMPILED artifacts (what the Docker image runs), on a real PostgreSQL.
//   npm run build && node scripts/smoke-prod.mjs
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { startPg } from './pg-embedded.mjs'
import { bootstrapDb } from './db-bootstrap.mjs'

const port = 54380
const API = 8021
const pg = await startPg({ name: 'smoke', port })
let failed = false
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`)
  if (!ok) failed = true
}
const children = []
try {
  const u = await bootstrapDb(pg, port)
  const secrets = { JWT_SECRET: randomBytes(48).toString('base64'), TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('base64'), CRON_SECRET: randomBytes(24).toString('hex'), METRICS_TOKEN: randomBytes(16).toString('hex') }
  const env = {
    ...process.env, NODE_ENV: 'production', PORT: String(API), LOG_LEVEL: 'warn', ...secrets,
    DATABASE_URL: u.app, DATABASE_SYSTEM_URL: u.system, APP_BASE_URL: 'https://app.example.com', CORS_ORIGINS: 'https://app.example.com',
    MAIL_DRIVER: 'log', DRIVE_DRIVER: 'fake', AI_DRIVER: 'fake', INLINE_WORKER: 'true', RATE_LIMIT_SCALE: '100', TRUST_PROXY: 'true',
  }

  // 1. production refuses development secrets
  const bad = spawnSync('node', ['dist/main.js'], { env: { ...env, JWT_SECRET: 'dev-only-secret-change-me-dev-only-secret-change-me' }, encoding: 'utf8', timeout: 20000 })
  check('production refuses the development JWT secret', bad.status !== 0 && /Development secrets/.test(bad.stderr + bad.stdout))
  const badCors = spawnSync('node', ['dist/main.js'], { env: { ...env, CORS_ORIGINS: 'http://localhost:5173' }, encoding: 'utf8', timeout: 20000 })
  check('production refuses localhost CORS origins', badCors.status !== 0)

  // 2. refuses a database role that could bypass RLS
  const owner = spawnSync('node', ['dist/main.js'], { env: { ...env, DATABASE_URL: u.system }, encoding: 'utf8', timeout: 30000 })
  check('refuses to start as a role that bypasses RLS', owner.status !== 0 && /restricted app role/.test(owner.stderr + owner.stdout))

  // 3. boots with the app role, in-process worker
  const api = spawn('node', ['dist/main.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(api)
  let log = ''
  api.stdout.on('data', (d) => (log += d))
  api.stderr.on('data', (d) => (log += d))
  let ready = false
  for (let i = 0; i < 80 && !ready; i++) {
    try { ready = (await fetch(`http://127.0.0.1:${API}/readyz`)).ok } catch { await new Promise((r) => setTimeout(r, 500)) }
  }
  check('API boots in production mode and /readyz is OK', ready)
  const base = `http://127.0.0.1:${API}`
  check('/healthz answers without touching the database', (await fetch(`${base}/healthz`)).ok)
  const hdr = (await fetch(`${base}/healthz`)).headers
  check('security headers present (helmet)', hdr.get('x-content-type-options') === 'nosniff' && !hdr.get('x-powered-by'))
  const m1 = await fetch(`${base}/metrics`)
  const m2 = await fetch(`${base}/metrics`, { headers: { authorization: `Bearer ${secrets.METRICS_TOKEN}` } })
  check('/metrics requires the token', m1.status === 401 && m2.ok, `without=${m1.status} with=${m2.status} ${m2.ok ? '' : (await m2.text()).slice(0, 120)}`)
  check('OpenAPI is not exposed in production by default', (await fetch(`${base}/api/v1/openapi.json`)).status === 404)
  const cors = await fetch(`${base}/api/v1/me`, { method: 'OPTIONS', headers: { origin: 'https://app.example.com', 'access-control-request-method': 'GET' } })
  check('CORS allows the app origin with credentials', cors.headers.get('access-control-allow-origin') === 'https://app.example.com' && cors.headers.get('access-control-allow-credentials') === 'true')
  const evil = await fetch(`${base}/api/v1/me`, { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' } })
  check('CORS does not allow other origins', !evil.headers.get('access-control-allow-origin'))
  const unauth = await fetch(`${base}/api/v1/projects`)
  check('unauthenticated request gets problem+json 401', unauth.status === 401 && /problem\+json/.test(unauth.headers.get('content-type') ?? ''))

  // 4. in-process worker delivers the verification e-mail job
  const email = `smoke-${Date.now()}@example.test`
  const su = await fetch(`${base}/api/v1/auth/sign-up`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Smoke Test', email, password: 'correct-horse-battery-9', workspace_type: 'supervision', workspace_name: 'Smoke WS' }) })
  check('sign-up works (202)', su.status === 202)
  const c = pg.getPgClient('projectn')
  await c.connect()
  let done = false
  for (let i = 0; i < 40 && !done; i++) {
    done = Number((await c.query("select count(*) n from jobs where kind = 'email.send' and status = 'succeeded'")).rows[0].n) > 0
    if (!done) await new Promise((r) => setTimeout(r, 500))
  }
  check('in-process worker (INLINE_WORKER) delivered the e-mail job', done)
  const login = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'correct-horse-battery-9' }) })
  const cookie = login.headers.get('set-cookie') ?? ''
  check('login sets a Secure httpOnly SameSite=Lax refresh cookie', login.ok && /pn_refresh=/.test(cookie) && /Secure/i.test(cookie) && /HttpOnly/i.test(cookie) && /SameSite=Lax/i.test(cookie))
  api.kill()

  // 5. the standalone worker drains and exits
  await c.query("insert into jobs (kind) values ('sessions.cleanup')")
  const w = spawnSync('node', ['dist/worker.js', '--drain'], { env: { ...env, INLINE_WORKER: 'false' }, encoding: 'utf8', timeout: 60000 })
  const left = Number((await c.query("select count(*) n from jobs where status in ('queued','running') and run_at <= now()")).rows[0].n)
  check('standalone worker (`node dist/worker.js --drain`) exits cleanly with nothing left due', w.status === 0 && left === 0, w.status !== 0 ? (w.stderr || w.stdout).slice(0, 200) : '')
  await c.end()
} finally {
  children.forEach((ch) => ch.kill())
  await pg.stop()
}
process.exit(failed ? 1 : 0)
