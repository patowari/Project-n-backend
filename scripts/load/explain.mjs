// Ad-hoc EXPLAIN ANALYZE under the restricted app role with the real RLS settings, on the 1M-user dataset.
//   node scripts/load/explain.mjs "<sql>" [dean|student|supervisor|admin|head]
import pgpkg from 'pg'
import { ensureLoadDb } from './build-dataset.mjs'

const [, , sql, persona = 'student'] = process.argv
const { pg, u } = await ensureLoadDb()
try {
  const owner = pg.getPgClient('projectn')
  await owner.connect()
  const ws = (await owner.query("select id from workspaces where name = 'Load University 1'")).rows[0].id
  const byIdx = { admin: 1, dean: 2, head: 5, supervisor: 20, student: 300 }
  const user = (await owner.query("select u.id from users u join memberships m on m.user_id = u.id where m.workspace_id = $1 and u.email = $2", [ws, `load${byIdx[persona]}@load.test`])).rows[0].id
  await owner.end()
  const app = new pgpkg.Client({ connectionString: u.app })
  await app.connect()
  await app.query('begin')
  await app.query("select set_config('app.user_id', $1, true), set_config('app.workspace_id', $2, true)", [user, ws])
  const t0 = performance.now()
  const rows = (await app.query(`explain (analyze, buffers) ${sql}`)).rows.map((r) => r['QUERY PLAN'])
  console.log(rows.join('\n'))
  console.log(`\nwall: ${Math.round(performance.now() - t0)} ms`)
  await app.query('rollback')
  await app.end()
} finally {
  await pg.stop()
}
