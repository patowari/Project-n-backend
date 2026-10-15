-- 0002: database roles, constraints, triggers and Row Level Security.
--
-- Authorization is enforced in the API *and* here. A bug in a query that
-- forgets a filter must return nothing, not another tenant's data.
--
-- Request context (set per transaction with set_config(..., true)):
--   app.workspace_id  the active workspace (X-Workspace-Id)
--   app.user_id       the authenticated user
-- The workspace setting alone grants nothing: every policy goes through pn_ws(),
-- which returns it only if the user is an ACTIVE MEMBER of that workspace.
--
-- Roles:
--   projectn_app     the API. Not owner, no BYPASSRLS. RLS applies.
--   projectn_auth    NOLOGIN. The API assumes it (SET LOCAL ROLE) only inside the auth module
--                    (sign-up, login, invitations, /me) where there is no tenant yet. It can touch
--                    identity and membership tables ONLY; every other table is "permission denied".
--   projectn_system  workers and Super Admin reports. BYPASSRLS, narrow code paths.
--   (owner)          runs migrations only.
--
-- PERFORMANCE RULES (learned from the 1,000,000-user load test, docs/LOAD_TEST.md):
--   * every helper call in a policy is written (SELECT pn_xxx()) so PostgreSQL evaluates it ONCE
--     per query (InitPlan) instead of once per row, and can use it as an index key;
--   * no policy ORs in a branch an index cannot serve; auth-only access lives in policies
--     TO projectn_auth, which the app role never evaluates;
--   * write policies are split by command so they are not OR-ed into SELECT.

/* ------------------------------------------------------------------ */
/* Roles                                                               */
/* ------------------------------------------------------------------ */

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'projectn_app') THEN
    CREATE ROLE projectn_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'projectn_system') THEN
    CREATE ROLE projectn_system LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'projectn_auth') THEN
    CREATE ROLE projectn_auth NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END $$;
-- The API may SWITCH to the auth role but does not INHERIT its privileges or policies (PostgreSQL 16+).
GRANT projectn_auth TO projectn_app WITH INHERIT FALSE, SET TRUE;

/* ------------------------------------------------------------------ */
/* Context helpers                                                     */
/* ------------------------------------------------------------------ */

CREATE FUNCTION pn_uid() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT NULLIF(current_setting('app.user_id', true), '')::uuid $$;

CREATE FUNCTION pn_wid() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT NULLIF(current_setting('app.workspace_id', true), '')::uuid $$;

-- The active workspace, but ONLY if the caller is an active member of it.
-- SECURITY DEFINER: it must read memberships before any membership policy can be evaluated.
CREATE FUNCTION pn_ws() RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS
$$ SELECT m.workspace_id FROM memberships m
   WHERE m.workspace_id = pn_wid() AND m.user_id = pn_uid() AND m.status = 'active' $$;

/* ------------------------------------------------------------------ */
/* Who may see what (mirrors src/authz/policy.ts; tests assert parity)  */
/*                                                                     */
/* SECURITY DEFINER: these read projects / project_members, whose own  */
/* policies call these functions. Running as the table owner (exempt   */
/* from RLS) breaks that recursion. They only ever look at rows keyed  */
/* to the caller's own pn_uid() / pn_wid(), and pin search_path.       */
/* ------------------------------------------------------------------ */

-- Projects the caller belongs to (any project role, still active).
CREATE FUNCTION pn_member_projects() RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS
$$
  SELECT pm.project_id FROM project_members pm
  WHERE pm.workspace_id = pn_wid() AND pm.user_id = pn_uid() AND pm.left_at IS NULL
$$;

-- Projects the caller monitors as Dean (faculty), Head (department) or
-- Supervision Owner (whole workspace). Each arm is gated by a one-time EXISTS, so a student or a
-- plain supervisor (no leader grant) never touches the projects table here, and each arm that
-- does run is an index lookup on projects(workspace_id, department_id).
CREATE FUNCTION pn_leader_projects() RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS
$$
  WITH g AS (
    SELECT r.role, r.scope_id
    FROM memberships m
    JOIN membership_roles r ON r.membership_id = m.id AND r.workspace_id = m.workspace_id
    WHERE m.workspace_id = pn_wid() AND m.user_id = pn_uid() AND m.status = 'active'
      AND r.role IN ('dean', 'head', 'supervision_owner')
  )
  SELECT p.id FROM projects p
  WHERE EXISTS (SELECT 1 FROM g WHERE role = 'supervision_owner')
    AND p.workspace_id = pn_wid() AND p.deleted_at IS NULL
  UNION ALL
  SELECT p.id FROM projects p
  WHERE EXISTS (SELECT 1 FROM g WHERE role = 'dean')
    AND p.workspace_id = pn_wid() AND p.deleted_at IS NULL
    AND p.department_id IN (SELECT d.id FROM departments d WHERE d.workspace_id = pn_wid()
                            AND d.faculty_id IN (SELECT scope_id FROM g WHERE role = 'dean'))
  UNION ALL
  SELECT p.id FROM projects p
  WHERE EXISTS (SELECT 1 FROM g WHERE role = 'head')
    AND p.workspace_id = pn_wid() AND p.deleted_at IS NULL
    AND p.department_id IN (SELECT scope_id FROM g WHERE role = 'head')
$$;

-- Everything whose CONTENT (submissions, comments, files) the caller may open.
CREATE FUNCTION pn_content_projects() RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS
$$ SELECT pn_member_projects() UNION SELECT pn_leader_projects() $$;

-- Projects where the caller is Lead/Co-supervisor or a leader: sees
-- supervisors-only (private) material.
CREATE FUNCTION pn_supervisor_projects() RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS
$$
  SELECT pm.project_id FROM project_members pm
  WHERE pm.workspace_id = pn_wid() AND pm.user_id = pn_uid() AND pm.left_at IS NULL
    AND pm.role IN ('lead', 'co_supervisor')
  UNION SELECT pn_leader_projects()
$$;

CREATE FUNCTION pn_has_role(p_role workspace_role) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS
$$
  SELECT EXISTS (
    SELECT 1 FROM memberships m
    JOIN membership_roles r ON r.membership_id = m.id AND r.workspace_id = m.workspace_id
    WHERE m.workspace_id = pn_wid() AND m.user_id = pn_uid() AND m.status = 'active'
      AND r.role = p_role)
$$;

CREATE FUNCTION pn_is_leader() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS
$$ SELECT pn_has_role('dean') OR pn_has_role('head') OR pn_has_role('supervision_owner') $$;

/* ------------------------------------------------------------------ */
/* Data-integrity constraints                                          */
/* ------------------------------------------------------------------ */

ALTER TABLE users ADD CONSTRAINT users_email_lower CHECK (email = lower(email));

ALTER TABLE membership_roles
  ADD CONSTRAINT membership_roles_scope_shape CHECK (
    (role = 'dean'  AND scope_type = 'faculty'    AND scope_id IS NOT NULL) OR
    (role = 'head'  AND scope_type = 'department' AND scope_id IS NOT NULL) OR
    (role NOT IN ('dean', 'head') AND scope_type IS NULL AND scope_id IS NULL));
CREATE UNIQUE INDEX membership_roles_unique
  ON membership_roles (membership_id, role, COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'));

CREATE UNIQUE INDEX invites_one_pending
  ON invites (workspace_id, email, role, COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'))
  WHERE status = 'pending';

-- One Lead, one group leader, one successor and one row per person (while active).
CREATE UNIQUE INDEX project_members_one_lead
  ON project_members (project_id) WHERE role = 'lead' AND left_at IS NULL;
CREATE UNIQUE INDEX project_members_one_group_leader
  ON project_members (project_id) WHERE is_group_leader AND left_at IS NULL;
CREATE UNIQUE INDEX project_members_one_successor
  ON project_members (project_id) WHERE is_successor AND left_at IS NULL;
CREATE UNIQUE INDEX project_members_one_active_row
  ON project_members (project_id, user_id) WHERE left_at IS NULL;
ALTER TABLE project_members
  ADD CONSTRAINT project_members_flag_roles CHECK (
    (NOT is_group_leader OR role = 'student') AND (NOT is_successor OR role = 'co_supervisor'));

ALTER TABLE phases ADD CONSTRAINT phases_version_nonneg CHECK (latest_version >= 0);
ALTER TABLE projects ADD CONSTRAINT projects_version_pos CHECK (version > 0);
ALTER TABLE time_logs ADD CONSTRAINT time_logs_hours_range CHECK (hours > 0 AND hours <= 24);

-- One routine decision and at most one Dean-override decision per version.
CREATE UNIQUE INDEX reviews_one_routine ON reviews (submission_id) WHERE NOT is_override;
CREATE UNIQUE INDEX reviews_one_override ON reviews (submission_id) WHERE is_override;

-- One open extension request per phase.
CREATE UNIQUE INDEX extension_requests_one_pending
  ON extension_requests (phase_id) WHERE status = 'pending';

ALTER TABLE approval_revocations
  ADD CONSTRAINT approval_revocations_scope_shape CHECK (
    (scope = 'project' AND project_id IS NOT NULL AND faculty_id IS NULL) OR
    (scope = 'faculty' AND faculty_id IS NOT NULL AND project_id IS NULL));
CREATE UNIQUE INDEX approval_revocations_one_active_project
  ON approval_revocations (user_id, project_id) WHERE restored_at IS NULL AND scope = 'project';
CREATE UNIQUE INDEX approval_revocations_one_active_faculty
  ON approval_revocations (user_id, faculty_id) WHERE restored_at IS NULL AND scope = 'faculty';

ALTER TABLE overrides ADD CONSTRAINT overrides_reason_required CHECK (length(btrim(reason)) > 0);
ALTER TABLE approval_revocations ADD CONSTRAINT revocation_reason_required CHECK (length(btrim(reason)) > 0);

ALTER TABLE jobs ADD CONSTRAINT jobs_attempts_sane CHECK (attempts >= 0 AND max_attempts >= 1);
CREATE INDEX jobs_claimable ON jobs (run_at) WHERE status = 'queued';

CREATE INDEX submissions_pending_review ON submissions (workspace_id, project_id, submitted_at)
  WHERE status = 'submitted';
CREATE INDEX notifications_unread ON notifications (user_id, created_at DESC) WHERE read_at IS NULL;

/* ------------------------------------------------------------------ */
/* Triggers: state machines and immutability                           */
/* ------------------------------------------------------------------ */

-- Phase lifecycle (architecture 10.1). Any other jump is a bug.
CREATE FUNCTION phases_status_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;
  IF (OLD.status, NEW.status) IN (
    ('locked', 'open'), ('open', 'locked'),
    ('open', 'submitted'),
    ('submitted', 'changes_requested'), ('submitted', 'approved'),
    ('changes_requested', 'submitted'),
    ('approved', 'open'),             -- Dean reopens (override)
    ('changes_requested', 'approved') -- Dean override
  ) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'illegal phase transition % -> %', OLD.status, NEW.status
    USING ERRCODE = 'check_violation';
END $$;
CREATE TRIGGER phases_status_guard BEFORE UPDATE OF status ON phases
  FOR EACH ROW EXECUTE FUNCTION phases_status_guard();

-- A submission version never changes its identity or content.
CREATE FUNCTION submissions_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.phase_id <> OLD.phase_id OR NEW.project_id <> OLD.project_id
     OR NEW.version <> OLD.version OR NEW.submitted_by_id <> OLD.submitted_by_id
     OR NEW.submitted_at <> OLD.submitted_at OR NEW.note <> OLD.note THEN
    RAISE EXCEPTION 'submission versions are immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER submissions_immutable BEFORE UPDATE ON submissions
  FOR EACH ROW EXECUTE FUNCTION submissions_immutable();

-- Reviews and the activity log are append-only.
CREATE FUNCTION append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('app.allow_purge', true) = 'on' AND TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'check_violation';
END $$;
CREATE TRIGGER activity_log_append_only BEFORE UPDATE OR DELETE ON activity_log
  FOR EACH ROW EXECUTE FUNCTION append_only();
CREATE TRIGGER reviews_append_only BEFORE UPDATE OR DELETE ON reviews
  FOR EACH ROW EXECUTE FUNCTION append_only();
CREATE TRIGGER overrides_append_only BEFORE UPDATE OR DELETE ON overrides
  FOR EACH ROW EXECUTE FUNCTION append_only();

/* ------------------------------------------------------------------ */
/* Row Level Security                                                  */
/* ------------------------------------------------------------------ */

-- Tenant-wide tables: visible only inside the active workspace.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'faculties', 'departments', 'phase_templates', 'phase_template_items',
    'workspace_settings', 'ai_usage'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant ON %I USING (workspace_id = (SELECT pn_ws())) WITH CHECK (workspace_id = (SELECT pn_ws()))$p$, t);
  END LOOP;
END $$;

-- Per command policies for tables that also have a narrower SELECT rule.
CREATE FUNCTION pn_split_write_policies(tbl text, using_expr text, check_expr text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('CREATE POLICY w_insert ON %I FOR INSERT WITH CHECK (%s)', tbl, check_expr);
  EXECUTE format('CREATE POLICY w_update ON %I FOR UPDATE USING (%s) WITH CHECK (%s)', tbl, using_expr, check_expr);
  EXECUTE format('CREATE POLICY w_delete ON %I FOR DELETE USING (%s)', tbl, using_expr);
END $$;

-- workspaces: only the active one. (The workspace list in /me goes through the auth role.)
ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
CREATE POLICY ws_select ON workspaces FOR SELECT USING (id = (SELECT pn_ws()));
CREATE POLICY ws_update ON workspaces FOR UPDATE USING (id = (SELECT pn_ws())) WITH CHECK (id = (SELECT pn_ws()));

-- memberships: the workspace's people, plus the caller's own rows everywhere. Both arms are indexed.
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
CREATE POLICY m_select ON memberships FOR SELECT USING (workspace_id = (SELECT pn_ws()) OR user_id = (SELECT pn_uid()));
SELECT pn_split_write_policies('memberships', 'workspace_id = (SELECT pn_ws())', 'workspace_id = (SELECT pn_ws())');

ALTER TABLE membership_roles ENABLE ROW LEVEL SECURITY;
CREATE POLICY mr_select ON membership_roles FOR SELECT USING (workspace_id = (SELECT pn_ws()));
SELECT pn_split_write_policies('membership_roles', 'workspace_id = (SELECT pn_ws())', 'workspace_id = (SELECT pn_ws())');

ALTER TABLE invites ENABLE ROW LEVEL SECURITY;
CREATE POLICY i_select ON invites FOR SELECT USING (workspace_id = (SELECT pn_ws()));
SELECT pn_split_write_policies('invites', 'workspace_id = (SELECT pn_ws())', 'workspace_id = (SELECT pn_ws())');

-- users: yourself, or people who share the active workspace.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
CREATE POLICY u_select ON users FOR SELECT USING (
  id = (SELECT pn_uid())
  OR EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = users.id AND m.workspace_id = (SELECT pn_ws())));
CREATE POLICY u_update ON users FOR UPDATE USING (id = (SELECT pn_uid())) WITH CHECK (id = (SELECT pn_uid()));

-- Per-user tables.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['sessions', 'auth_tokens', 'google_drive_connections', 'idempotency_keys'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY own ON %I USING (user_id = (SELECT pn_uid())) WITH CHECK (user_id = (SELECT pn_uid()))$p$, t);
  END LOOP;
END $$;
-- refresh tokens are reachable only through the auth role (no policy for the app role = no rows).
ALTER TABLE refresh_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY own ON notifications
  USING (user_id = (SELECT pn_uid()))
  WITH CHECK (workspace_id IS NULL OR workspace_id = (SELECT pn_ws()));
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_select ON audit_log FOR SELECT USING (workspace_id = (SELECT pn_ws()));
CREATE POLICY audit_insert ON audit_log FOR INSERT WITH CHECK (true);

-- Revocations carry a reason: leadership, the Admin and the person concerned only.
ALTER TABLE approval_revocations ENABLE ROW LEVEL SECURITY;
CREATE POLICY rev_select ON approval_revocations FOR SELECT USING (
  workspace_id = (SELECT pn_ws()) AND (
    user_id = (SELECT pn_uid()) OR (SELECT pn_is_leader()) OR (SELECT pn_has_role('institution_admin'))));
SELECT pn_split_write_policies('approval_revocations',
  'workspace_id = (SELECT pn_ws()) AND ((SELECT pn_is_leader()) OR (SELECT pn_has_role(''institution_admin'')))',
  'workspace_id = (SELECT pn_ws()) AND ((SELECT pn_is_leader()) OR (SELECT pn_has_role(''institution_admin'')))');

-- projects: members and leaders see them; the Institution Admin sees the row (title, health,
-- counts) but no content; creators see what they made (needed for INSERT ... RETURNING).
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_select ON projects FOR SELECT USING (
  workspace_id = (SELECT pn_ws()) AND (
    created_by_id = (SELECT pn_uid())
    OR (SELECT pn_has_role('institution_admin'))
    OR id IN (SELECT pn_content_projects())));
CREATE POLICY p_insert ON projects FOR INSERT WITH CHECK (workspace_id = (SELECT pn_ws()));
CREATE POLICY p_update ON projects FOR UPDATE
  USING (workspace_id = (SELECT pn_ws()) AND (
    created_by_id = (SELECT pn_uid()) OR (SELECT pn_has_role('institution_admin')) OR id IN (SELECT pn_content_projects())))
  WITH CHECK (workspace_id = (SELECT pn_ws()));

-- project_members: structure of projects you can open, plus your own rows; the Institution
-- Admin assigns people so sees these rows too (no content); creators see the team they built.
ALTER TABLE project_members ENABLE ROW LEVEL SECURITY;
CREATE POLICY pm_select ON project_members FOR SELECT USING (
  workspace_id = (SELECT pn_ws()) AND (
    user_id = (SELECT pn_uid())
    OR (SELECT pn_has_role('institution_admin'))
    OR project_id IN (SELECT pn_content_projects())
    OR EXISTS (SELECT 1 FROM projects p WHERE p.id = project_members.project_id AND p.created_by_id = (SELECT pn_uid()))));
SELECT pn_split_write_policies('project_members',
  $q$workspace_id = (SELECT pn_ws()) AND ((SELECT pn_has_role('institution_admin')) OR project_id IN (SELECT pn_content_projects())
     OR EXISTS (SELECT 1 FROM projects p WHERE p.id = project_members.project_id AND p.created_by_id = (SELECT pn_uid())))$q$,
  'workspace_id = (SELECT pn_ws())');

-- Content tables with a project_id: members and leaders only. NOT the Institution Admin,
-- NOT the Super Admin (no membership at all).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'draft_files', 'submissions', 'reviews', 'time_logs',
    'extension_requests', 'overrides', 'submission_files', 'ai_reviews'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY content ON %I
      USING (workspace_id = (SELECT pn_ws()) AND project_id IN (SELECT pn_content_projects()))
      WITH CHECK (workspace_id = (SELECT pn_ws()))$p$, t);
  END LOOP;
END $$;
-- Phases: members and leaders; creators may add the first phases before they are members.
ALTER TABLE phases ENABLE ROW LEVEL SECURITY;
CREATE POLICY content ON phases
  USING (workspace_id = (SELECT pn_ws()) AND (
    project_id IN (SELECT pn_content_projects())
    OR EXISTS (SELECT 1 FROM projects p WHERE p.id = phases.project_id AND p.created_by_id = (SELECT pn_uid()))))
  WITH CHECK (workspace_id = (SELECT pn_ws()));
-- Small children reach their project through the (already protected) phase.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['phase_requirements', 'phase_resources'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY via_phase ON %I
      USING (workspace_id = (SELECT pn_ws()) AND phase_id IN (SELECT id FROM phases))
      WITH CHECK (workspace_id = (SELECT pn_ws()))$p$, t);
  END LOOP;
END $$;

-- Private discussion: supervisors-only comments are invisible to students.
ALTER TABLE comments ENABLE ROW LEVEL SECURITY;
CREATE POLICY comments_select ON comments FOR SELECT USING (
  workspace_id = (SELECT pn_ws()) AND project_id IN (SELECT pn_content_projects())
  AND (NOT supervisors_only OR project_id IN (SELECT pn_supervisor_projects())));
CREATE POLICY comments_insert ON comments FOR INSERT WITH CHECK (
  workspace_id = (SELECT pn_ws()) AND project_id IN (SELECT pn_content_projects())
  AND author_id = (SELECT pn_uid())
  AND (NOT supervisors_only OR project_id IN (SELECT pn_supervisor_projects())));
CREATE POLICY comments_update ON comments FOR UPDATE
  USING (workspace_id = (SELECT pn_ws()) AND author_id = (SELECT pn_uid())) WITH CHECK (workspace_id = (SELECT pn_ws()));
ALTER TABLE comment_mentions ENABLE ROW LEVEL SECURITY;
CREATE POLICY via_comment ON comment_mentions
  USING (workspace_id = (SELECT pn_ws()) AND comment_id IN (SELECT id FROM comments))
  WITH CHECK (workspace_id = (SELECT pn_ws()));

-- Activity log: same reach as the project, narrowed by each entry's visibility.
-- The Institution Admin sees setup entries (people, project, governance, drive)
-- but not submissions, reviews or comments.
ALTER TABLE activity_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY activity_select ON activity_log FOR SELECT USING (
  workspace_id = (SELECT pn_ws()) AND (
    (project_id IS NOT NULL AND project_id IN (SELECT pn_content_projects()) AND (
        visibility = 'all'
        OR (visibility = 'supervisors' AND project_id IN (SELECT pn_supervisor_projects()))
        OR (visibility = 'leadership' AND project_id IN (SELECT pn_leader_projects()))))
    OR (category IN ('project', 'people', 'governance', 'drive') AND (SELECT pn_has_role('institution_admin')))
    OR (project_id IS NULL AND (SELECT pn_is_leader()))));
CREATE POLICY activity_insert ON activity_log FOR INSERT WITH CHECK (workspace_id = (SELECT pn_ws()));

-- The auth role: identity and membership tables only, all rows (it runs before a tenant exists).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'users', 'sessions', 'refresh_tokens', 'auth_tokens', 'workspaces', 'workspace_settings',
    'faculties', 'departments', 'memberships', 'membership_roles', 'invites'
  ] LOOP
    EXECUTE format('CREATE POLICY auth_all ON %I TO projectn_auth USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;

DROP FUNCTION pn_split_write_policies(text, text, text);

/* ------------------------------------------------------------------ */
/* Effective approval rights (architecture 5.4)                        */
/* ------------------------------------------------------------------ */

-- A supervisor can approve on a project when the Institution Admin granted the
-- permission AND no active revocation (this project, or their whole faculty)
-- applies. Revocation rows (with reasons) are restricted to leadership, so
-- everyone else learns only the boolean through this function.
CREATE FUNCTION pn_supervisor_rights(p_projects uuid[])
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
$$;

/* ------------------------------------------------------------------ */
/* The Lead's Drive token, for people working on the Lead's project    */
/* ------------------------------------------------------------------ */

-- Students upload into the LEAD's Google Drive, but RLS (rightly) hides other
-- users' google_drive_connections rows. This function returns the Lead's
-- connection only for a project the caller can open, and nothing else.
CREATE FUNCTION pn_project_drive(p_project uuid)
RETURNS TABLE (user_id uuid, refresh_token_enc bytea, root_folder_id text, root_folder_name text, status drive_status)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS
$$
  SELECT c.user_id, c.refresh_token_enc, c.root_folder_id, c.root_folder_name, c.status
  FROM project_members pm
  JOIN google_drive_connections c ON c.user_id = pm.user_id
  WHERE pm.project_id = p_project AND pm.role = 'lead' AND pm.left_at IS NULL
    AND pm.workspace_id = pn_ws()
    AND p_project IN (SELECT pn_content_projects())
$$;

/* ------------------------------------------------------------------ */
/* Grants                                                              */
/* ------------------------------------------------------------------ */

-- Re-run at the end of every later migration that adds a table.
CREATE FUNCTION pn_grants() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  GRANT USAGE ON SCHEMA public TO projectn_app, projectn_system, projectn_auth;
  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO projectn_app, projectn_system;
  GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO projectn_app, projectn_system, projectn_auth;
  -- Append-only: nobody updates history. Only the system role may purge (retention).
  REVOKE UPDATE, DELETE ON activity_log, reviews, overrides FROM projectn_app, projectn_system;
  GRANT DELETE ON activity_log, reviews, overrides TO projectn_system;
  REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM projectn_app;
  -- The API only enqueues jobs; workers (system) claim and finish them.
  REVOKE UPDATE, DELETE ON jobs FROM projectn_app;
  REVOKE TRUNCATE ON ALL TABLES IN SCHEMA public FROM projectn_app, projectn_system;
  -- Prisma bookkeeping stays with the owner.
  IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
    REVOKE ALL ON TABLE _prisma_migrations FROM projectn_app, projectn_system;
  END IF;
  -- The auth role: least privilege, nothing about projects, submissions or comments.
  REVOKE ALL ON ALL TABLES IN SCHEMA public FROM projectn_auth;
  GRANT SELECT, INSERT, UPDATE ON users, sessions, auth_tokens, workspaces, workspace_settings, memberships, membership_roles, invites TO projectn_auth;
  GRANT SELECT, INSERT, UPDATE, DELETE ON refresh_tokens TO projectn_auth;
  GRANT SELECT ON faculties, departments TO projectn_auth;
  GRANT INSERT ON audit_log, jobs TO projectn_auth;
END $$;
SELECT pn_grants();
