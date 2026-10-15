// Creates the database, applies migrations as the OWNER role, and sets the
// passwords of the two runtime roles. Shared by tests, the seed and the load test.
import { execSync } from 'node:child_process'

export const urls = (port, db = 'projectn') => ({
  owner: `postgresql://postgres:postgres@localhost:${port}/${db}`,
  app: `postgresql://projectn_app:app_pw@localhost:${port}/${db}`,
  system: `postgresql://projectn_system:system_pw@localhost:${port}/${db}`,
})

export async function bootstrapDb(pg, port, db = 'projectn') {
  const admin = pg.getPgClient()
  await admin.connect()
  await admin.query(`CREATE DATABASE ${db} ENCODING 'UTF8' TEMPLATE template0`)
  await admin.end()
  const u = urls(port, db)
  execSync('npx prisma migrate deploy', {
    stdio: process.env.VERBOSE ? 'inherit' : 'pipe',
    env: { ...process.env, DATABASE_MIGRATION_URL: u.owner },
  })
  const c = pg.getPgClient(db)
  await c.connect()
  await c.query(`ALTER ROLE projectn_app PASSWORD 'app_pw'`)
  await c.query(`ALTER ROLE projectn_system PASSWORD 'system_pw'`)
  await c.end()
  return u
}
