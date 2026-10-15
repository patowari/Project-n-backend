// Applies migrations to a throw-away embedded Postgres and prints a summary.
// Used while developing the schema: node scripts/migrate-local.mjs
import { startPg } from './pg-embedded.mjs'
import { execSync } from 'node:child_process'

const pg = await startPg({ name: 'migrate-probe', port: 54331 })
try {
  const c = pg.getPgClient()
  await c.connect()
  await c.query("CREATE DATABASE projectn ENCODING 'UTF8' TEMPLATE template0")
  await c.end()
  const url = 'postgresql://postgres:postgres@localhost:54331/projectn'
  execSync('npx prisma migrate deploy', {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_MIGRATION_URL: url },
  })
  const c2 = pg.getPgClient('projectn')
  await c2.connect()
  const r = await c2.query(
    "select count(*) filter (where relrowsecurity) rls, count(*) tables from pg_class where relkind='r' and relnamespace='public'::regnamespace"
  )
  console.log('tables/rls:', r.rows[0])
  await c2.end()
} finally {
  await pg.stop()
}
