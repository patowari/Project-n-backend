import { PrismaClient } from '@prisma/client'
import { createTestApp, signUpAndLogin, TestApp, uniq } from './helpers/app'
import { buildInstitution, connectDrive, createProject, phaseIds, submitPhase, World } from './helpers/world'

/**
 * Runs a query as the restricted app role, with exactly the settings the API
 * would set, but WITHOUT any application-level filtering. If RLS is wrong,
 * these tests see data they should not.
 */
async function asDb<T>(
  app: PrismaClient,
  ctx: { user?: string; workspace?: string },
  fn: (q: PrismaClient['$queryRawUnsafe']) => Promise<T>
): Promise<T> {
  return app.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT set_config('app.user_id', ${ctx.user ?? ''}, true), set_config('app.workspace_id', ${ctx.workspace ?? ''}, true)`
    return fn(tx.$queryRawUnsafe.bind(tx))
  })
}

describe('access control: private discussion, Super Admin, Institution Admin, tenants', () => {
  let t: TestApp
  let w: World
  let app: PrismaClient
  let projectId: string
  let phases: Record<number, string>

  beforeAll(async () => {
    t = await createTestApp()
    w = await buildInstitution(t, 3)
    await connectDrive(t, w.sup1)
    app = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL! } } })
    projectId = await createProject(w)
    phases = phaseIds((await w.sup1.get(`/projects/${projectId}`)).body)
    await submitPhase(w.students[0], phases[1])
  })
  afterAll(async () => {
    await app.$disconnect()
    await t.close()
  })

  const comment = (who: typeof w.sup1, body: string, over: Record<string, unknown> = {}) =>
    who.post('/comments', { project_id: projectId, body, supervisors_only: false, target: { type: 'project', id: projectId, label: '' }, ...over })

  describe('private (supervisors-only) discussion', () => {
    let privateId: string
    beforeAll(async () => {
      await comment(w.students[0], 'Hello supervisors, question about scope').expect(201)
      privateId = (await comment(w.sup1, 'Student seems to be behind, keep an eye', { supervisors_only: true }).expect(201)).body.id
    })

    it('supervisors, the Dean and the Head see it; students do not', async () => {
      const bodies = async (s: typeof w.sup1) => (await s.get(`/comments?project_id=${projectId}`).expect(200)).body.items.map((c: any) => c.body)
      expect(await bodies(w.sup1)).toContain('Student seems to be behind, keep an eye')
      expect(await bodies(w.sup2)).toContain('Student seems to be behind, keep an eye')
      expect(await bodies(w.dean)).toContain('Student seems to be behind, keep an eye')
      expect(await bodies(w.head)).toContain('Student seems to be behind, keep an eye')
      const student = await bodies(w.students[0])
      expect(student).toContain('Hello supervisors, question about scope')
      expect(student).not.toContain('Student seems to be behind, keep an eye')
    })

    it('students cannot post private comments', async () => {
      const r = await comment(w.students[0], 'sneaky', { supervisors_only: true })
      expect(r.status).toBe(403)
      expect(r.body.code).toBe('private_not_allowed')
    })

    it('a reply never escapes a private thread', async () => {
      const reply = await comment(w.sup2, 'Agreed, will nudge them', { parent_id: privateId, supervisors_only: false }).expect(201)
      const row = await t.sys.comment.findUnique({ where: { id: reply.body.id } })
      expect(row?.supervisorsOnly).toBe(true)
      const student = (await w.students[0].get(`/comments?project_id=${projectId}`)).body.items
      expect(JSON.stringify(student)).not.toContain('nudge')
    })

    it('the database itself hides it: a student querying comments with NO filter sees only public rows', async () => {
      const rows = await asDb(app, { user: w.students[0].userId, workspace: w.workspaceId }, (q) => q<{ supervisors_only: boolean }[]>('SELECT supervisors_only FROM comments'))
      expect(rows.length).toBeGreaterThan(0)
      expect(rows.every((r) => r.supervisors_only === false)).toBe(true)
    })

    it('the database refuses a student INSERT of a private comment', async () => {
      await expect(
        asDb(app, { user: w.students[0].userId, workspace: w.workspaceId }, (q) =>
          q(`INSERT INTO comments (workspace_id, project_id, author_id, acting_role, body, target_type, target_id, supervisors_only) VALUES ($1::uuid,$2::uuid,$3::uuid,'Student','x','project',$2::uuid,true)`, w.workspaceId, projectId, w.students[0].userId)
        )
      ).rejects.toThrow(/row-level security/)
    })

    it('mentions notify only people who may read the comment', async () => {
      await comment(w.sup1, `Please look at this @${(await t.sys.user.findUniqueOrThrow({ where: { id: w.students[0].userId } })).name} and @Dr. Salma`, { supervisors_only: true }).expect(201)
      const stud = await t.sys.notification.findMany({ where: { userId: w.students[0].userId, kind: 'comments' } })
      expect(stud.some((n) => n.body.includes('Please look at this'))).toBe(false)
      const sup = await t.sys.notification.findMany({ where: { userId: w.sup2.userId, kind: 'comments' } })
      expect(sup.some((n) => n.title.includes('mentioned you'))).toBe(true)
    })
  })

  describe('Institution Admin: structure and people, never project content', () => {
    it('API: sees the project row but no submissions, comments, files or timeline', async () => {
      expect((await w.admin.get(`/projects/${projectId}`)).status).toBe(200)
      expect((await w.admin.get(`/projects/${projectId}/submissions`)).body.items).toEqual([])
      expect((await w.admin.get(`/comments?project_id=${projectId}`)).body.items).toEqual([])
      expect((await w.admin.get(`/phases/${phases[1]}/draft`)).status).toBe(404)
    })

    it('database: even a raw SELECT * returns zero content rows for the Admin', async () => {
      const ctx = { user: w.admin.userId, workspace: w.workspaceId }
      for (const table of ['submissions', 'submission_files', 'comments', 'phases', 'draft_files', 'reviews', 'time_logs']) {
        const rows = await asDb(app, ctx, (q) => q<unknown[]>(`SELECT 1 FROM ${table}`))
        expect([table, rows.length]).toEqual([table, 0])
      }
      expect((await asDb(app, ctx, (q) => q<unknown[]>('SELECT 1 FROM projects'))).length).toBeGreaterThan(0)
    })

    it('activity: only setup categories (people, project, governance, drive)', async () => {
      const items = (await w.admin.get('/activity?limit=100').expect(200)).body.items
      expect(items.length).toBeGreaterThan(0)
      expect(items.every((i: any) => ['project', 'people', 'governance', 'drive'].includes(i.category))).toBe(true)
    })
  })

  describe('Super Admin and outsiders see no content at all', () => {
    it('a platform admin with no membership gets nothing from tenant tables, even with a workspace id set', async () => {
      const root = await t.sys.user.create({ data: { email: `${uniq('root')}@example.test`, name: 'Root', isPlatformAdmin: true, emailVerifiedAt: new Date() } })
      for (const table of ['projects', 'submissions', 'comments', 'phases', 'memberships', 'activity_log', 'faculties']) {
        const rows = await asDb(app, { user: root.id, workspace: w.workspaceId }, (q) => q<unknown[]>(`SELECT 1 FROM ${table}`))
        expect([table, rows.length]).toEqual([table, 0])
      }
    })

    it('no context at all: every tenant table is empty', async () => {
      for (const table of ['projects', 'project_members', 'submissions', 'comments', 'activity_log', 'phases', 'faculties', 'departments', 'invites', 'notifications', 'sessions']) {
        const rows = await asDb(app, {}, (q) => q<unknown[]>(`SELECT 1 FROM ${table}`))
        expect([table, rows.length]).toEqual([table, 0])
      }
    })

    it('another institution cannot read or write this one (API and database)', async () => {
      const other = await signUpAndLogin(t, { type: 'institution' })
      expect((await other.get(`/projects/${projectId}`)).status).toBe(404)
      expect((await other.get('/projects')).body.items).toEqual([])
      // wrong workspace header
      expect((await other.get('/projects', w.workspaceId)).status).toBe(403)
      // database: the other tenant's context still sees nothing of ours
      const rows = await asDb(app, { user: other.userId, workspace: other.workspaceId }, (q) => q<unknown[]>('SELECT 1 FROM projects UNION ALL SELECT 1 FROM submissions UNION ALL SELECT 1 FROM comments'))
      expect(rows.length).toBe(0)
      // and cannot INSERT into our workspace
      await expect(
        asDb(app, { user: other.userId, workspace: other.workspaceId }, (q) => q(`INSERT INTO faculties (workspace_id, name) VALUES ($1::uuid, 'Injected')`, w.workspaceId))
      ).rejects.toThrow(/row-level security/)
    })

    it('a user cannot smuggle another tenant\'s id into a request body', async () => {
      const other = await signUpAndLogin(t, { type: 'institution' })
      await other.post('/org/faculties', { name: 'Theirs' }).expect(201)
      const r = await other.post('/projects', { title: 'Cross tenant', department_id: w.dept.id, start_date: '2026-10-01', phases: [{ name: 'A', due_date: null }], unlock_rule: 'on_submit', lead_id: w.sup1.userId, co_supervisor_ids: [], successor_id: null, student_ids: [], group_leader_id: null, submission_mode: 'leader_only', ai_student_feedback: false, ai_supervisor_summary: false })
      expect([403, 404, 422]).toContain(r.status)
    })
  })

  describe('integrity enforced by the database, not just the API', () => {
    it('composite tenant foreign keys: a phase cannot point at another workspace\'s project', async () => {
      const other = await signUpAndLogin(t, { type: 'institution' })
      await expect(
        t.sys.$executeRaw`INSERT INTO phases (workspace_id, project_id, position, name, updated_at) VALUES (${other.workspaceId}::uuid, ${projectId}::uuid, 99, 'Smuggled', now())`
      ).rejects.toThrow(/foreign key/i)
    })

    it('a project member must be a member of the same workspace', async () => {
      const other = await signUpAndLogin(t, { type: 'institution' })
      await expect(
        t.sys.$executeRaw`INSERT INTO project_members (workspace_id, project_id, user_id, role) VALUES (${w.workspaceId}::uuid, ${projectId}::uuid, ${other.userId}::uuid, 'student')`
      ).rejects.toThrow(/foreign key/i)
    })

    it('the app role cannot rewrite or delete history', async () => {
      const ctx = { user: w.dean.userId, workspace: w.workspaceId }
      await expect(asDb(app, ctx, (q) => q(`UPDATE activity_log SET action = 'x'`))).rejects.toThrow(/permission denied/)
      await expect(asDb(app, ctx, (q) => q(`DELETE FROM activity_log`))).rejects.toThrow(/permission denied/)
      await expect(asDb(app, ctx, (q) => q(`DELETE FROM reviews`))).rejects.toThrow(/permission denied/)
      await expect(asDb(app, ctx, (q) => q(`UPDATE jobs SET status = 'succeeded'`))).rejects.toThrow(/permission denied/)
    })

    it('RLS context is transaction-local: it never leaks to the next pooled use', async () => {
      await asDb(app, { user: w.dean.userId, workspace: w.workspaceId }, (q) => q('SELECT 1 FROM projects'))
      const leaked = await app.$queryRaw<{ ws: string | null; usr: string | null }[]>`SELECT current_setting('app.workspace_id', true) AS ws, current_setting('app.user_id', true) AS usr`
      expect(leaked[0].ws ?? '').toBe('')
      expect(leaked[0].usr ?? '').toBe('')
    })
  })

  describe('the auth role (sign-up, login, invitations) is contained', () => {
    const asAuthRole = async (sql: string) =>
      app.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL ROLE projectn_auth')
        return tx.$queryRawUnsafe<unknown[]>(sql)
      })

    it('the API role does not inherit it: refresh tokens are invisible and unwritable without SET ROLE', async () => {
      const rows = await asDb(app, { user: w.dean.userId, workspace: w.workspaceId }, (q) => q<unknown[]>('SELECT 1 FROM refresh_tokens'))
      expect(rows.length).toBe(0)
      await expect(
        asDb(app, { user: w.dean.userId, workspace: w.workspaceId }, (q) =>
          q(`INSERT INTO refresh_tokens (session_id, token_hash, expires_at) VALUES (gen_random_uuid(), 'x', now())`)
        )
      ).rejects.toThrow(/row-level security|violates foreign key/)
    })

    it('once assumed, it reads identity data but gets "permission denied" on every project table', async () => {
      expect((await asAuthRole('SELECT 1 FROM users LIMIT 1')).length).toBe(1)
      for (const table of ['projects', 'project_members', 'phases', 'submissions', 'submission_files', 'comments', 'activity_log', 'draft_files', 'notifications', 'google_drive_connections', 'idempotency_keys', 'approval_revocations']) {
        await expect(asAuthRole(`SELECT 1 FROM ${table} LIMIT 1`)).rejects.toThrow(/permission denied/)
      }
      await expect(asAuthRole('SELECT 1 FROM jobs LIMIT 1')).rejects.toThrow(/permission denied/) // can enqueue, not read the queue
    })

    it('it cannot rewrite history either', async () => {
      await expect(asAuthRole(`UPDATE audit_log SET action = 'x'`)).rejects.toThrow(/permission denied/)
    })

    it('a request leaves no role behind: the next transaction on the pooled connection is the plain API role', async () => {
      await w.dean.get('/me', null).expect(200) // /me assumes the auth role internally
      const r = await app.$queryRaw<{ u: string }[]>`SELECT current_user AS u`
      expect(r[0].u).toBe('projectn_app')
    })
  })

  describe('activity log (10.3) and exports', () => {
    it('students see their project\'s log without supervisor-only entries', async () => {
      const items = (await w.students[0].get(`/projects/${projectId}/activity`).expect(200)).body.items
      expect(items.length).toBeGreaterThan(0)
      expect(items.some((i: any) => i.action.startsWith('commented on'))).toBe(true)
      const dean = (await w.dean.get(`/projects/${projectId}/activity`)).body.items
      expect(dean.length).toBeGreaterThan(items.length - 1)
    })

    it('filters by type and person; pages with a cursor; newest first', async () => {
      const subs = (await w.sup1.get('/activity?type=submissions').expect(200)).body.items
      expect(subs.every((i: any) => i.category === 'submissions')).toBe(true)
      const p1 = (await w.dean.get('/activity?limit=2').expect(200)).body
      expect(p1.items.length).toBe(2)
      const p2 = (await w.dean.get(`/activity?limit=2&cursor=${p1.next_cursor}`).expect(200)).body
      expect(p2.items[0].occurred_at <= p1.items[1].occurred_at).toBe(true)
      expect((await w.dean.get('/activity?type=bogus')).status).toBe(422)
    })

    it('CSV export: Dean/Head only, and spreadsheet formulas are neutralised', async () => {
      await w.sup1.post('/comments', { project_id: projectId, body: 'x', target: { type: 'project', id: projectId, label: '=HYPERLINK("http://evil")' }, supervisors_only: false }).expect(201)
      expect((await w.students[0].get('/activity/export.csv')).status).toBe(403)
      expect((await w.sup1.get('/activity/export.csv')).status).toBe(403)
      const csv = await w.dean.get(`/activity/export.csv?project=${projectId}`).expect(200)
      expect(csv.headers['content-type']).toMatch(/text\/csv/)
      expect(csv.text.split('\n')[0]).toBe('occurred_at,actor,acting_role,category,action,project,before,after,reason,override')
      expect(csv.text).not.toMatch(/,"=HYPERLINK/)
    })
  })

  describe('calendar, queue and reports', () => {
    it('calendar lists phase deadlines in range for the project members only', async () => {
      const from = new Date(Date.now() - 20 * 86400_000).toISOString().slice(0, 10)
      const to = new Date(Date.now() + 90 * 86400_000).toISOString().slice(0, 10)
      const mine = (await w.students[0].get(`/calendar?from=${from}&to=${to}`).expect(200)).body.items
      expect(mine.filter((e: any) => e.kind === 'deadline').length).toBeGreaterThanOrEqual(3)
      const stranger = (await w.students[2].get(`/calendar?from=${from}&to=${to}`).expect(200)).body.items
      expect(stranger.filter((e: any) => e.project_id === projectId)).toEqual([])
      expect((await w.students[0].get(`/calendar?from=2026-01-01&to=2028-12-31`)).status).toBe(422)
    })

    it('the review queue shows pending versions to the Lead and not to strangers', async () => {
      const q = (await w.sup1.get('/reviews/queue').expect(200)).body.items
      const item = q.find((i: any) => i.project.id === projectId)
      expect(item).toMatchObject({ status: 'submitted', version: 1, approval_blocked: false })
      expect((await w.sup3.get('/reviews/queue').expect(200)).body.items.find((i: any) => i.project.id === projectId)).toBeUndefined()
      const mine = (await w.students[0].get('/submissions?mine=true').expect(200)).body.items
      expect(mine.some((i: any) => i.project.id === projectId)).toBe(true)
    })

    it('reports are for leadership and scoped to their area', async () => {
      expect((await w.students[0].get('/reports/summary')).status).toBe(403)
      expect((await w.sup1.get('/reports/summary')).status).toBe(403)
      const r = (await w.dean.get('/reports/summary').expect(200)).body
      expect(Object.keys(r.health).sort()).toEqual(['at_risk', 'awaiting_review', 'completed', 'on_track', 'overdue'])
      expect(r.workload.length).toBeGreaterThan(0)
      expect(r.submissions_by_day.length).toBe(30)
      const dist = Object.values(r.projects_by_status as Record<string, number>).reduce((a, b) => a + b, 0)
      expect(dist).toBeGreaterThan(0)
      // another faculty's Head would see nothing of ours
      const overview = (await w.dean.get('/supervisors/overview').expect(200)).body
      expect(overview.some((o: any) => o.supervisor.id === w.sup1.userId && o.projects.length > 0)).toBe(true)
    })
  })

  describe('notifications', () => {
    it('lists, counts and marks as read', async () => {
      const count = (await w.sup1.get('/notifications/unread-count').expect(200)).body.count
      expect(count).toBeGreaterThan(0)
      const list = (await w.sup1.get('/notifications?limit=2').expect(200)).body
      expect(list.items.length).toBe(2)
      await w.sup1.post('/notifications/read', { ids: [list.items[0].id] }).expect(204)
      expect((await w.sup1.get('/notifications/unread-count')).body.count).toBe(count - 1)
      await w.sup1.post('/notifications/read', { all: true }).expect(204)
      expect((await w.sup1.get('/notifications/unread-count')).body.count).toBe(0)
      // never another user's notifications
      expect((await w.sup2.get('/notifications/unread-count')).body.count).toBeGreaterThan(0)
    })
  })
})
