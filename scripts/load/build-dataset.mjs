// Builds (once) a persistent PostgreSQL with the 1,000,000-user dataset, then stops.
//   node scripts/load/build-dataset.mjs        (several minutes; ~6 GB on disk)
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { startPg } from '../pg-embedded.mjs'
import { bootstrapDb, urls } from '../db-bootstrap.mjs'
import { counts, generate } from './dataset.mjs'

export const LOAD_PORT = 54360

/**
 * Re-applies the `pn_*` SQL functions exactly as written in migration 0002 (CREATE OR REPLACE), so a
 * long-lived load database can pick up function-body changes without a 16-minute rebuild.
 * Policies, tables and indexes are NOT touched: a change to those needs a rebuild.
 */
async function syncFunctions(pg) {
  const sql = readFileSync('prisma/migrations/0002_rls_roles_constraints/migration.sql', 'utf8').split('\r\n').join('\n')
  const owner = pg.getPgClient('projectn')
  await owner.connect()
  try {
    for (const m of sql.matchAll(/CREATE FUNCTION (pn_\w+)\([\s\S]*?\$\$;/g)) {
      await owner.query(m[0].replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION'))
    }
  } finally {
    await owner.end()
  }
}

export async function ensureLoadDb() {
  const pg = await startPg({ name: 'load', port: LOAD_PORT, fresh: false })
  const admin = pg.getPgClient()
  await admin.connect()
  const exists = (await admin.query("select 1 from pg_database where datname = 'projectn'")).rowCount > 0
  await admin.end()
  if (!exists) await bootstrapDb(pg, LOAD_PORT)
  const u = urls(LOAD_PORT)
  await syncFunctions(pg)
  const t0 = Date.now()
  const out = execSync('npx prisma migrate deploy', { env: { ...process.env, DATABASE_MIGRATION_URL: u.owner } }).toString()
  if (/Applying migration/.test(out)) console.log(`applied pending migrations in ${((Date.now() - t0) / 1000).toFixed(1)}s (on the 1M-user dataset)`)
  return { pg, u }
}

if (process.argv[1] && process.argv[1].endsWith('build-dataset.mjs')) {
  const { pg, u } = await ensureLoadDb()
  try {
    const c = pg.getPgClient('projectn')
    await c.connect()
    const have = Number((await c.query('select count(*) n from users')).rows[0].n)
    if (have >= 1_000_000) console.log('dataset already present:', await counts(c))
    else {
      if (have > 0) throw new Error('partial dataset present; delete .pgdata/load and re-run')
      console.log('generating dataset ...')
      await generate(c)
      console.log(await counts(c))
    }
    await c.end()
  } finally {
    await pg.stop()
  }
}
