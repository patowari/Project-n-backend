// Synthetic dataset for load tests: 100 institutions x 10,000 users = 1,000,000 users.
// Set-based SQL (generate_series) as the SYSTEM role, so it bypasses RLS and is fast.
// Row counts (defaults): users 1.0M, memberships 1.0M, roles 1.0M, projects 250k,
// project_members 1.25M, phases 1.0M, submissions ~400k, files ~800k, activity 2.0M,
// comments 500k, notifications 500k.

export const SHAPE = { workspaces: 100, usersPerWorkspace: 10000, projectsPerWorkspace: 2500, faculties: 3, deptsPerFaculty: 5, supervisorsFrom: 20, supervisorsTo: 250, studentsFrom: 251 }

export async function generate(c, log = console.log, shape = SHAPE) {
  const S = shape
  const t0 = Date.now()
  const step = async (name, sql, params = []) => {
    const t = Date.now()
    const r = await c.query(sql, params)
    log(`  ${name.padEnd(34)} ${String(r.rowCount ?? '').padStart(9)} rows  ${((Date.now() - t) / 1000).toFixed(1)}s`)
  }
  await c.query("SET synchronous_commit = off; SET maintenance_work_mem = '512MB'; SET work_mem = '128MB'")

  await step('workspaces', `INSERT INTO workspaces (id, name, short_name, type, status, updated_at)
    SELECT gen_random_uuid(), 'Load University '||g, 'LU'||g, 'institution', 'active', now() FROM generate_series(1,$1) g`, [S.workspaces])
  await c.query(`CREATE TEMP TABLE ws_map AS SELECT substring(name from '\\d+')::int AS n, id FROM workspaces WHERE name LIKE 'Load University %'`)
  await step('workspace_settings', `INSERT INTO workspace_settings (workspace_id, updated_at) SELECT id, now() FROM ws_map`)
  await step('faculties', `INSERT INTO faculties (id, workspace_id, name) SELECT gen_random_uuid(), m.id, 'Faculty '||f FROM ws_map m CROSS JOIN generate_series(1,$1) f`, [S.faculties])
  await c.query(`CREATE TEMP TABLE fac_map AS SELECT m.n AS ws_n, substring(f.name from '\\d+')::int AS f_n, f.id, f.workspace_id FROM faculties f JOIN ws_map m ON m.id = f.workspace_id`)
  await step('departments', `INSERT INTO departments (id, workspace_id, faculty_id, name) SELECT gen_random_uuid(), workspace_id, id, 'Dept '||d FROM fac_map CROSS JOIN generate_series(1,$1) d`, [S.deptsPerFaculty])
  await c.query(`CREATE TEMP TABLE dept_map AS
    SELECT fm.ws_n, ((fm.f_n-1)*$1 + substring(d.name from '\\d+')::int) AS d_n, d.id, d.faculty_id, d.workspace_id, fm.f_n
    FROM departments d JOIN fac_map fm ON fm.id = d.faculty_id`, [S.deptsPerFaculty])

  const total = S.workspaces * S.usersPerWorkspace
  await c.query(`CREATE TEMP TABLE seed_users AS SELECT g AS n, gen_random_uuid() AS id, ((g-1)/$1)+1 AS ws_n, ((g-1)%$1)+1 AS idx FROM generate_series(1,$2) g`, [S.usersPerWorkspace, total])
  await c.query('CREATE INDEX ON seed_users (ws_n, idx)')
  await step('users', `INSERT INTO users (id, email, name, email_verified_at, updated_at) SELECT id, 'load'||n||'@load.test', 'User '||n, now(), now() FROM seed_users`)

  await c.query('CREATE INDEX ON dept_map (ws_n, d_n)')
  await c.query('CREATE INDEX ON ws_map (n)')
  await c.query('ANALYZE seed_users; ANALYZE dept_map; ANALYZE ws_map')
  await c.query(`CREATE TEMP TABLE seed_members AS
    SELECT gen_random_uuid() AS mid, u.id AS user_id, u.ws_n, u.idx, wm.id AS ws_id, dm.id AS dept_id
    FROM seed_users u JOIN ws_map wm ON wm.n = u.ws_n
    JOIN dept_map dm ON dm.ws_n = u.ws_n AND dm.d_n = (u.idx % 15) + 1`)
  await c.query('CREATE INDEX ON seed_members (ws_n, idx)')
  await step('memberships', `INSERT INTO memberships (id, workspace_id, user_id, status, can_approve, department_id, joined_at, updated_at)
    SELECT mid, ws_id, user_id, 'active', (idx BETWEEN $1 AND $2), CASE WHEN idx = 1 THEN NULL ELSE dept_id END, now(), now() FROM seed_members`, [S.supervisorsFrom, S.supervisorsTo])
  // roles
  await step('roles: institution admin', `INSERT INTO membership_roles (workspace_id, membership_id, role) SELECT ws_id, mid, 'institution_admin' FROM seed_members WHERE idx = 1`)
  await step('roles: deans', `INSERT INTO membership_roles (workspace_id, membership_id, role, scope_type, scope_id)
    SELECT sm.ws_id, sm.mid, 'dean', 'faculty', fm.id FROM seed_members sm JOIN fac_map fm ON fm.ws_n = sm.ws_n AND fm.f_n = sm.idx - 1 WHERE sm.idx BETWEEN 2 AND 4`)
  await step('roles: heads', `INSERT INTO membership_roles (workspace_id, membership_id, role, scope_type, scope_id)
    SELECT sm.ws_id, sm.mid, 'head', 'department', dm.id FROM seed_members sm JOIN dept_map dm ON dm.ws_n = sm.ws_n AND dm.d_n = sm.idx - 4 WHERE sm.idx BETWEEN 5 AND 19`)
  await step('roles: supervisors', `INSERT INTO membership_roles (workspace_id, membership_id, role) SELECT ws_id, mid, 'supervisor' FROM seed_members WHERE idx BETWEEN 2 AND $1`, [S.supervisorsTo])
  await step('roles: students', `INSERT INTO membership_roles (workspace_id, membership_id, role) SELECT ws_id, mid, 'student' FROM seed_members WHERE idx >= $1`, [S.studentsFrom])

  // projects
  await c.query(`CREATE TEMP TABLE seed_projects AS
    SELECT gen_random_uuid() AS id, w.n AS ws_n, p AS p_idx, w.id AS ws_id, dm.id AS dept_id,
           (ARRAY['on_track','on_track','on_track','at_risk','overdue','awaiting_review'])[1 + (p % 6)]::project_health AS health,
           now() - ((p % 50) || ' days')::interval AS created
    FROM ws_map w CROSS JOIN generate_series(1,$1) p
    JOIN dept_map dm ON dm.ws_n = w.n AND dm.d_n = (p % 15) + 1`, [S.projectsPerWorkspace])
  await c.query('CREATE INDEX ON seed_projects (ws_n, p_idx)')
  await c.query('ANALYZE seed_projects; ANALYZE seed_members')
  await step('projects', `INSERT INTO projects (id, workspace_id, title, department_id, health, start_date, created_by_id, created_at, updated_at)
    SELECT sp.id, sp.ws_id, 'Project '||sp.ws_n||'-'||sp.p_idx, sp.dept_id, sp.health, current_date - 60, sm.user_id, sp.created, sp.created
    FROM seed_projects sp JOIN seed_members sm ON sm.ws_n = sp.ws_n AND sm.idx = 1`)
  await step('project_members: leads', `INSERT INTO project_members (workspace_id, project_id, user_id, role)
    SELECT sp.ws_id, sp.id, sm.user_id, 'lead' FROM seed_projects sp JOIN seed_members sm ON sm.ws_n = sp.ws_n AND sm.idx = $1 + (sp.p_idx % 231)`, [S.supervisorsFrom])
  await step('project_members: co-supervisors', `INSERT INTO project_members (workspace_id, project_id, user_id, role)
    SELECT sp.ws_id, sp.id, sm.user_id, 'co_supervisor' FROM seed_projects sp JOIN seed_members sm ON sm.ws_n = sp.ws_n AND sm.idx = $1 + ((sp.p_idx + 7) % 231)`, [S.supervisorsFrom])
  await step('project_members: students', `INSERT INTO project_members (workspace_id, project_id, user_id, role, is_group_leader)
    SELECT sp.ws_id, sp.id, sm.user_id, 'student', (k = 0) FROM seed_projects sp CROSS JOIN generate_series(0,2) k
    JOIN seed_members sm ON sm.ws_n = sp.ws_n AND sm.idx = $1 + ((sp.p_idx * 3 + k) % 9750)`, [S.studentsFrom])

  // phases: 4 per project
  await step('phases', `INSERT INTO phases (id, workspace_id, project_id, position, name, status, due_date, latest_version, approved_at, updated_at)
    SELECT gen_random_uuid(), sp.ws_id, sp.id, k, (ARRAY['Proposal','Literature review','Draft','Final report'])[k],
           (CASE k WHEN 1 THEN 'approved' WHEN 2 THEN (CASE WHEN sp.p_idx % 2 = 0 THEN 'submitted' ELSE 'open' END) ELSE 'locked' END)::phase_status,
           current_date + (k * 20 - 50),
           CASE WHEN k = 1 OR (k = 2 AND sp.p_idx % 2 = 0) THEN 1 ELSE 0 END,
           CASE WHEN k = 1 THEN now() - interval '30 days' END, now()
    FROM seed_projects sp CROSS JOIN generate_series(1,4) k`)
  await step('submissions', `INSERT INTO submissions (id, workspace_id, project_id, phase_id, version, status, submitted_by_id, submitted_at, note, ai_status)
    SELECT gen_random_uuid(), ph.workspace_id, ph.project_id, ph.id, 1, (CASE ph.status WHEN 'approved' THEN 'approved' ELSE 'submitted' END)::submission_status,
           (SELECT pm.user_id FROM project_members pm WHERE pm.project_id = ph.project_id AND pm.is_group_leader LIMIT 1),
           now() - ((ph.position * 10) || ' days')::interval, 'seed', 'disabled'
    FROM phases ph WHERE ph.latest_version = 1`)
  await step('submission_files', `INSERT INTO submission_files (workspace_id, project_id, submission_id, name, mime_type, size_bytes, drive_file_id, drive_url, uploaded_by_id)
    SELECT s.workspace_id, s.project_id, s.id, 'file'||k||'.pdf', 'application/pdf', 120000, 'drv-'||s.id||k, 'https://drive.fake/'||s.id||k, s.submitted_by_id
    FROM submissions s CROSS JOIN generate_series(1,2) k`)
  await step('reviews', `INSERT INTO reviews (workspace_id, project_id, submission_id, decision, comment, reviewer_id, acting_role, created_at)
    SELECT s.workspace_id, s.project_id, s.id, 'approved', 'ok', (SELECT pm.user_id FROM project_members pm WHERE pm.project_id = s.project_id AND pm.role = 'lead' LIMIT 1), 'Supervisor', s.submitted_at + interval '2 days'
    FROM submissions s WHERE s.status = 'approved'`)
  await step('activity_log (2M)', `INSERT INTO activity_log (workspace_id, occurred_at, department_id, project_id, actor_name, acting_role, category, action, target_label, visibility)
    SELECT sp.ws_id, now() - (random() * interval '60 days'), sp.dept_id, sp.id, 'User '||k, (ARRAY['Student','Supervisor','Dean'])[1 + (k % 3)],
           (ARRAY['submissions','reviews','timeline','collaboration','people','governance','time','project'])[1 + (k % 8)]::activity_category,
           'did something '||k, 'Project '||sp.ws_n||'-'||sp.p_idx, (CASE WHEN k % 8 = 5 THEN 'supervisors' ELSE 'all' END)::activity_visibility
    FROM seed_projects sp CROSS JOIN generate_series(1,8) k`)
  await step('comments', `INSERT INTO comments (workspace_id, project_id, author_id, acting_role, body, target_type, target_id, target_label, supervisors_only, created_at)
    SELECT sp.ws_id, sp.id, pm.user_id, 'Supervisor', 'Seed comment '||k, 'project', sp.id, 'Project', (k = 2), now() - (random() * interval '30 days')
    FROM seed_projects sp CROSS JOIN generate_series(1,2) k
    JOIN project_members pm ON pm.project_id = sp.id AND pm.role = 'lead'`)
  await step('notifications', `INSERT INTO notifications (workspace_id, user_id, kind, title, body, created_at)
    SELECT sm.ws_id, sm.user_id, 'submissions', 'Seed notification '||k, '', now() - (random() * interval '14 days')
    FROM seed_members sm CROSS JOIN generate_series(1,20) k WHERE sm.idx BETWEEN $1 AND $2`, [S.supervisorsFrom, S.supervisorsTo])

  await c.query('ANALYZE')
  log(`dataset ready in ${((Date.now() - t0) / 1000).toFixed(0)}s`)
}

export async function counts(c) {
  const tables = ['users', 'memberships', 'membership_roles', 'projects', 'project_members', 'phases', 'submissions', 'submission_files', 'reviews', 'activity_log', 'comments', 'notifications']
  const out = {}
  for (const t of tables) out[t] = Number((await c.query(`SELECT reltuples::bigint AS n FROM pg_class WHERE relname = $1`, [t])).rows[0].n)
  return out
}
