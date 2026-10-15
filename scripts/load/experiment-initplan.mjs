// Experiment on the 1M-user dataset: does wrapping RLS helper calls in (SELECT ...) fix the slow plans?
import pgpkg from 'pg'
import { ensureLoadDb } from './build-dataset.mjs'

const { pg, u } = await ensureLoadDb()
try {
  const owner = pg.getPgClient('projectn')
  await owner.connect()
  const ws = (await owner.query("select id from workspaces where name = 'Load University 1'")).rows[0].id
  const user = (await owner.query("select u.id from users u where u.email = 'load300@load.test'")).rows[0].id
  const sql = `select m.user_id from membership_roles r join memberships m on m.id = r.membership_id
    where (r.role = 'supervision_owner' or (r.role = 'dean' and r.scope_id = (select id from faculties limit 1))) and m.status = 'active'`

  const time = async (label) => {
    const app = new pgpkg.Client({ connectionString: u.app })
    await app.connect()
    await app.query('begin')
    await app.query("set local statement_timeout = '45s'")
    await app.query("select set_config('app.user_id', $1, true), set_config('app.workspace_id', $2, true)", [user, ws])
    const t0 = performance.now()
    try {
      const rows = (await app.query(`explain (analyze) ${sql}`)).rows.map((r) => r['QUERY PLAN'])
      console.log(`${label}: ${Math.round(performance.now() - t0)} ms  | ${rows.find((r) => /Execution Time/.test(r))}`)
    } catch (e) {
      console.log(`${label}: ${e.message} after ${Math.round(performance.now() - t0)} ms`)
    }
    await app.query('rollback').catch(() => undefined)
    await app.end()
  }

  await time('BEFORE (function call per row)')
  await owner.query(`ALTER POLICY roles_visible ON membership_roles USING (workspace_id = (SELECT pn_ws()) OR (SELECT pn_auth_mode()) OR membership_id IN (SELECT id FROM memberships WHERE user_id = (SELECT pn_uid())))`)
  await owner.query(`ALTER POLICY membership_visible ON memberships USING (workspace_id = (SELECT pn_ws()) OR user_id = (SELECT pn_uid()) OR (SELECT pn_auth_mode()))`)
  await time('AFTER  (InitPlan: evaluated once)')
  await owner.end()
} finally {
  await pg.stop()
}
