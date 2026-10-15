// Experiment: does evaluating the helper calls once (InitPlan) fix pn_supervisor_rights on the 1M-user dataset?
import pgpkg from 'pg'
import { ensureLoadDb } from './build-dataset.mjs'

const { pg, u } = await ensureLoadDb()
try {
  const owner = pg.getPgClient('projectn')
  await owner.connect()
  const ws = (await owner.query("select id from workspaces where name = 'Load University 1'")).rows[0].id
  const dean = (await owner.query("select id from users where email = 'load2@load.test'")).rows[0].id

  const time = async (label, sql) => {
    const app = new pgpkg.Client({ connectionString: u.app })
    await app.connect()
    await app.query('begin')
    await app.query("set local statement_timeout = '90s'")
    await app.query("select set_config('app.user_id', $1, true), set_config('app.workspace_id', $2, true)", [dean, ws])
    const t0 = performance.now()
    try {
      const r = (await app.query(`explain (analyze, costs off, timing off) ${sql}`)).rows.map((x) => x['QUERY PLAN'])
      console.log(`${label.padEnd(34)} ${Math.round(performance.now() - t0)} ms | ${r.find((x) => /Execution/.test(x))}`)
    } catch (e) {
      console.log(`${label.padEnd(34)} ${e.message} after ${Math.round(performance.now() - t0)} ms`)
    }
    await app.query('rollback').catch(() => undefined)
    await app.end()
  }
  const ids = `(select array_agg(id) from (select id from projects order by created_at desc, id desc limit 50) x)`
  await time('pn_leader_projects BEFORE', `select count(*) from pn_leader_projects()`)
  await time('pn_content_projects BEFORE', `select count(*) from pn_content_projects()`)
  await time('pn_supervisor_rights BEFORE', `select * from pn_supervisor_rights(${ids})`)
  await owner.query(`
    CREATE OR REPLACE FUNCTION pn_leader_projects() RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS
    $$
      WITH g AS (
        SELECT r.role, r.scope_id FROM memberships m
        JOIN membership_roles r ON r.membership_id = m.id AND r.workspace_id = m.workspace_id
        WHERE m.workspace_id = pn_wid() AND m.user_id = pn_uid() AND m.status = 'active'
          AND r.role IN ('dean', 'head', 'supervision_owner'))
      SELECT p.id FROM projects p
      WHERE p.workspace_id = pn_wid() AND p.deleted_at IS NULL AND EXISTS (SELECT 1 FROM g WHERE role = 'supervision_owner')
      UNION ALL
      SELECT p.id FROM projects p
      WHERE p.workspace_id = pn_wid() AND p.deleted_at IS NULL
        AND p.department_id IN (SELECT d.id FROM departments d WHERE d.workspace_id = pn_wid() AND d.faculty_id IN (SELECT scope_id FROM g WHERE role = 'dean'))
      UNION ALL
      SELECT p.id FROM projects p
      WHERE p.workspace_id = pn_wid() AND p.deleted_at IS NULL AND p.department_id IN (SELECT scope_id FROM g WHERE role = 'head')
    $$`)
  await time('pn_leader_projects AFTER', `select count(*) from pn_leader_projects()`)
  await time('pn_content_projects AFTER', `select count(*) from pn_content_projects()`)
  await owner.query(`
    CREATE OR REPLACE FUNCTION pn_supervisor_rights(p_projects uuid[])
    RETURNS TABLE (project_id uuid, user_id uuid, can_approve boolean)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS
    $$
      WITH ctx AS (SELECT pn_ws() AS ws, pn_uid() AS uid, pn_has_role('institution_admin') AS is_admin),
      visible AS (SELECT pn_content_projects() AS id)
      SELECT pm.project_id, pm.user_id,
             (m.can_approve AND m.status = 'active' AND NOT EXISTS (
                SELECT 1 FROM approval_revocations r
                WHERE r.user_id = pm.user_id AND r.restored_at IS NULL AND r.workspace_id = p.workspace_id
                  AND ((r.scope = 'project' AND r.project_id = p.id)
                    OR (r.scope = 'faculty' AND r.faculty_id = d.faculty_id)))) AS can_approve
      FROM ctx
      JOIN project_members pm ON pm.workspace_id = ctx.ws AND pm.project_id = ANY (p_projects)
      JOIN projects p ON p.id = pm.project_id AND p.workspace_id = pm.workspace_id
      LEFT JOIN departments d ON d.id = p.department_id AND d.workspace_id = p.workspace_id
      JOIN memberships m ON m.workspace_id = pm.workspace_id AND m.user_id = pm.user_id
      WHERE pm.left_at IS NULL AND pm.role IN ('lead', 'co_supervisor')
        AND (ctx.is_admin OR p.created_by_id = ctx.uid OR pm.project_id IN (SELECT id FROM visible))
    $$`)
  await time('pn_supervisor_rights AFTER', `select * from pn_supervisor_rights(${ids})`)
  await owner.end()
} finally {
  await pg.stop()
}
