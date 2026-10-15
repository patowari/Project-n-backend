// Re-runs the CI "migrations" job against a throw-away PostgreSQL, so the same
// checks are available on a laptop without Docker.
import { execSync } from 'node:child_process'
import { startPg } from './pg-embedded.mjs'
import { bootstrapDb } from './db-bootstrap.mjs'

const port = 54350
const pg = await startPg({ name: 'ci', port })
let failed = false
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`)
  if (!ok) failed = true
}
try {
  const u = await bootstrapDb(pg, port)
  // 1. migrations == schema.prisma
  try {
    execSync(`npx prisma migrate diff --from-url "${u.owner}" --to-schema-datamodel prisma/schema.prisma --exit-code`, { stdio: 'pipe', env: { ...process.env, DATABASE_MIGRATION_URL: u.owner } })
    check('no drift between migrations and prisma/schema.prisma', true)
  } catch (e) {
    check('no drift between migrations and prisma/schema.prisma', false, String(e.stdout ?? e).slice(0, 400))
  }
  const c = pg.getPgClient('projectn')
  await c.connect()
  const roles = (await c.query("select rolname, rolsuper, rolbypassrls from pg_roles where rolname in ('projectn_app','projectn_system') order by 1")).rows
  check('projectn_app: not superuser, NOBYPASSRLS', roles.find((r) => r.rolname === 'projectn_app')?.rolsuper === false && roles.find((r) => r.rolname === 'projectn_app')?.rolbypassrls === false)
  check('projectn_system: not superuser, BYPASSRLS', roles.find((r) => r.rolname === 'projectn_system')?.rolsuper === false && roles.find((r) => r.rolname === 'projectn_system')?.rolbypassrls === true)
  const auth = (await c.query("select rolcanlogin, rolbypassrls, rolsuper from pg_roles where rolname = 'projectn_auth'")).rows[0]
  check('projectn_auth: NOLOGIN, NOBYPASSRLS, not superuser', auth && !auth.rolcanlogin && !auth.rolbypassrls && !auth.rolsuper)
  const mem = (await c.query("select inherit_option, set_option from pg_auth_members where roleid = 'projectn_auth'::regrole and member = 'projectn_app'::regrole")).rows[0]
  check('projectn_app can SET ROLE projectn_auth but does NOT inherit it', mem && mem.inherit_option === false && mem.set_option === true)
  const tp = (await c.query("select has_table_privilege('projectn_auth','projects','SELECT') p, has_table_privilege('projectn_auth','submissions','SELECT') s, has_table_privilege('projectn_auth','comments','SELECT') c, has_table_privilege('projectn_auth','jobs','SELECT') j, has_table_privilege('projectn_auth','users','SELECT') u")).rows[0]
  check('projectn_auth sees identity tables only (no projects/submissions/comments/jobs)', !tp.p && !tp.s && !tp.c && !tp.j && tp.u)
  const noRls = (await c.query("select tablename from pg_tables where schemaname='public' and tablename not in ('plans','jobs','_prisma_migrations') and not rowsecurity")).rows
  check('every table except plans/jobs has Row Level Security enabled', noRls.length === 0, noRls.map((r) => r.tablename).join(','))
  const unmapped = (await c.query("select tablename from pg_tables t where schemaname='public' and tablename not in ('_prisma_migrations') and not exists (select 1 from pg_policies p where p.tablename=t.tablename) and tablename not in ('plans','jobs')")).rows
  check('every RLS table has at least one policy', unmapped.length === 0, unmapped.map((r) => r.tablename).join(','))
  const def = (await c.query("select proname from pg_proc where proname like 'pn\_%' and prosecdef order by 1")).rows.map((r) => r.proname)
  console.log('      SECURITY DEFINER functions (reviewed list):', def.join(', '))
  const noPath = (await c.query("select proname from pg_proc where proname like 'pn\_%' and prosecdef and not (proconfig::text like '%search_path%')")).rows
  check('every SECURITY DEFINER function pins search_path', noPath.length === 0, noPath.map((r) => r.proname).join(','))
  const appCanWriteLog = (await c.query("select has_table_privilege('projectn_app','activity_log','UPDATE') u, has_table_privilege('projectn_app','activity_log','DELETE') d, has_table_privilege('projectn_app','reviews','UPDATE') r")).rows[0]
  check('app role has no UPDATE/DELETE on activity_log or UPDATE on reviews', !appCanWriteLog.u && !appCanWriteLog.d && !appCanWriteLog.r)
  await c.end()
  // 2. db-setup script
  execSync('node scripts/db-setup.cjs', { stdio: 'pipe', env: { ...process.env, DATABASE_MIGRATION_URL: u.owner, APP_DB_PASSWORD: 'ci-app-password-123456', SYSTEM_DB_PASSWORD: 'ci-system-password-123456' } })
  check('scripts/db-setup.cjs sets the runtime role passwords', true)
} finally {
  await pg.stop()
}
process.exit(failed ? 1 : 0)
