// Seeds a throw-away real PostgreSQL (twice, to prove idempotence).
//   npm run build && node scripts/seed-local.mjs
import { execSync } from 'node:child_process'
import { startPg } from './pg-embedded.mjs'
import { bootstrapDb } from './db-bootstrap.mjs'

const port = 54340
const pg = await startPg({ name: 'seed', port })
try {
  const u = await bootstrapDb(pg, port)
  const env = { ...process.env, DATABASE_SYSTEM_URL: u.system }
  execSync('node dist/seed.js', { stdio: 'inherit', env })
  execSync('node dist/seed.js', { stdio: 'inherit', env })
} finally {
  await pg.stop()
}
