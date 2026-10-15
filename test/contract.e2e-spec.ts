import { PrismaClient } from '@prisma/client'
import { Caller, RoleGrant } from '../src/authz/caller'
import { canViewContent, canViewMetadata, ProjectFacts, seesSupervisorOnly } from '../src/authz/policy'
import { toSnake } from '../src/common/case'
import { createTestApp, TestApp } from './helpers/app'
import { buildInstitution, connectDrive, createProject, phaseIds, submitPhase, World } from './helpers/world'

const snake = (keys: string[]) => keys.map(toSnake)
const has = (obj: object, keys: string[]) => expect(Object.keys(obj)).toEqual(expect.arrayContaining(snake(keys)))

describe('policy parity (TypeScript rules == SQL rules) and the frontend contract', () => {
  let t: TestApp
  let w: World
  let app: PrismaClient
  let projectIds: string[] = []

  beforeAll(async () => {
    t = await createTestApp()
    w = await buildInstitution(t, 4)
    await connectDrive(t, w.sup1)
    app = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL! } } })
    projectIds = [
      await createProject(w),
      await createProject(w, { lead_id: w.sup2.userId, co_supervisor_ids: [w.sup3.userId], successor_id: null, student_ids: [w.students[2].userId], group_leader_id: null }),
      await createProject(w, { lead_id: w.dean.userId, co_supervisor_ids: [], successor_id: null, student_ids: [w.students[3].userId], group_leader_id: null }),
      await createProject(w, { lead_id: w.head.userId, co_supervisor_ids: [w.sup1.userId], successor_id: w.sup1.userId, student_ids: [], group_leader_id: null }),
    ]
  })
  afterAll(async () => {
    await app.$disconnect()
    await t.close()
  })

  describe('parity', () => {
    it('for every person and every project, TypeScript and SQL agree on content, private and metadata access', async () => {
      const people = [w.admin, w.dean, w.head, w.sup1, w.sup2, w.sup3, ...w.students]
      const ids = projectIds
      const projects = await t.sys.project.findMany({ where: { id: { in: ids } }, include: { department: true, members: { where: { leftAt: null } } } })
      let compared = 0
      for (const s of people) {
        const membership = await t.sys.membership.findFirstOrThrow({ where: { userId: s.userId, workspaceId: w.workspaceId }, include: { roles: true } })
        const grants: RoleGrant[] = membership.roles.map((r) => ({ role: r.role, scopeType: r.scopeType, scopeId: r.scopeId }))
        const caller: Caller = { userId: s.userId, name: '', email: '', emailVerified: true, isPlatformAdmin: false, sessionId: 'x', workspaceId: w.workspaceId, workspaceType: 'institution', workspaceStatus: 'active', membershipId: membership.id, canApprove: membership.canApprove, grants }

        const sql = await app.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT set_config('app.user_id', ${s.userId}, true), set_config('app.workspace_id', ${w.workspaceId}, true)`
          const content = (await tx.$queryRawUnsafe<{ id: string }[]>('SELECT * FROM pn_content_projects() AS id')).map((r) => (r as unknown as Record<string, string>).pn_content_projects ?? Object.values(r)[0])
          const priv = (await tx.$queryRawUnsafe<unknown[]>('SELECT * FROM pn_supervisor_projects()')).map((r) => Object.values(r as object)[0] as string)
          const meta = (await tx.$queryRawUnsafe<{ id: string }[]>('SELECT id FROM projects')).map((r) => r.id)
          return { content: new Set(content as string[]), priv: new Set(priv), meta: new Set(meta) }
        })

        for (const p of projects) {
          const facts: ProjectFacts = {
            id: p.id, workspaceId: p.workspaceId, status: p.status, departmentId: p.departmentId, facultyId: p.department?.facultyId ?? null, createdById: p.createdById, submissionMode: p.submissionMode,
            members: p.members.map((m) => ({ userId: m.userId, role: m.role, isGroupLeader: m.isGroupLeader, isSuccessor: m.isSuccessor, joinedAt: m.joinedAt })),
            approvalRights: new Map(),
          }
          expect([s.email, p.id, 'content', canViewContent(caller, facts)]).toEqual([s.email, p.id, 'content', sql.content.has(p.id)])
          expect([s.email, p.id, 'private', seesSupervisorOnly(caller, facts)]).toEqual([s.email, p.id, 'private', sql.priv.has(p.id)])
          expect([s.email, p.id, 'metadata', canViewMetadata(caller, facts)]).toEqual([s.email, p.id, 'metadata', sql.meta.has(p.id)])
          compared += 3
        }
      }
      expect(compared).toBe(people.length * projects.length * 3)
    })

    it('the SQL approval-right function matches the API for every supervisor', async () => {
      await w.dean.post(`/people/${w.sup2.userId}/approval-revocations`, { scope: 'project', project_id: projectIds[1], reason: 'parity check' }).expect(201)
      for (const id of projectIds) {
        const detail = (await w.dean.get(`/projects/${id}`).expect(200)).body
        const rows = await app.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT set_config('app.user_id', ${w.dean.userId}, true), set_config('app.workspace_id', ${w.workspaceId}, true)`
          return tx.$queryRawUnsafe<{ user_id: string; can_approve: boolean }[]>('SELECT user_id, can_approve FROM pn_supervisor_rights(ARRAY[$1::uuid])', id)
        })
        for (const sup of detail.supervisors) expect([id, sup.id, sup.can_approve]).toEqual([id, sup.id, rows.find((r) => r.user_id === sup.id)?.can_approve])
      }
    })
  })

  describe('the shapes the existing frontend reads (dashboard-ui/src/api/types.ts)', () => {
    let id: string
    let phases: Record<number, string>
    beforeAll(async () => {
      id = projectIds[0]
      phases = phaseIds((await w.sup1.get(`/projects/${id}`)).body)
      await submitPhase(w.students[0], phases[1])
    })

    it('Me', async () => {
      const me = (await w.dean.get('/me', null)).body
      has(me, ['id', 'name', 'email', 'isPlatformAdmin', 'memberships'])
      has(me.memberships[0], ['workspace', 'roles', 'canApprove'])
      has(me.memberships[0].workspace, ['id', 'name', 'type'])
      has(me.memberships[0].roles[0], ['role'])
    })

    it('ProjectSummary and ProjectDetail (+ capabilities, phases, supervisors)', async () => {
      const list = (await w.sup1.get('/projects')).body
      has(list, ['items', 'nextCursor'])
      has(list.items[0], ['id', 'title', 'department', 'status', 'health', 'currentPhase', 'phaseCount', 'phasesApproved', 'lead', 'coSupervisors', 'students', 'groupLeader', 'myRole', 'flags'])
      const d = (await w.sup1.get(`/projects/${id}`)).body
      has(d, ['description', 'startDate', 'unlockRule', 'submissionMode', 'aiStudentFeedback', 'aiSupervisorSummary', 'phases', 'supervisors', 'driveFolderUrl', 'viewer'])
      has(d.viewer, ['seesContent', 'seesSupervisorOnly', 'canComment', 'canReview', 'canApprove', 'canSubmit', 'canUpload', 'canRequestExtension', 'canLogTime', 'canOverride', 'canManageGroup', 'canEditTimeline'])
      has(d.phases[0], ['id', 'name', 'description', 'requirements', 'resources', 'index', 'status', 'dueDate', 'latestVersion', 'approvedAt', 'approvedBy', 'extensionPending'])
      has(d.supervisors[0], ['id', 'name', 'role', 'canApprove', 'isSuccessor'])
      expect(d.phases[0].due_date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(d.start_date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    })

    it('Submission, files, ReviewItem', async () => {
      const subs = (await w.sup1.get(`/projects/${id}/submissions`)).body.items
      has(subs[0], ['id', 'phaseId', 'phaseName', 'version', 'status', 'submittedBy', 'submittedAt', 'note', 'files', 'aiFeedback', 'aiSummary', 'review'])
      has(subs[0].files[0], ['id', 'name', 'mimeType', 'sizeKb', 'driveUrl', 'uploadedBy', 'uploadedAt'])
      has((await w.sup1.get('/reviews/queue')).body.items[0], ['id', 'project', 'phase', 'version', 'status', 'submittedBy', 'submittedAt', 'dueDate', 'aiSummaryReady', 'approvalBlocked'])
      expect((await w.students[0].get(`/phases/${phases[1]}/draft`)).body).toEqual({ phase_id: phases[1], files: [] })
    })

    it('comments, time logs, activity, calendar', async () => {
      await w.sup1.post('/comments', { project_id: id, body: 'hi', supervisors_only: false, target: { type: 'project', id, label: '' } }).expect(201)
      await w.students[0].post('/time-logs', { project_id: id, kind: 'hours', hours: 2, note: 'reading', date: new Date().toISOString().slice(0, 10) }).expect(201)
      has((await w.sup1.get(`/comments?project_id=${id}`)).body.items[0], ['id', 'author', 'actingRole', 'body', 'at', 'target', 'supervisorsOnly', 'replies'])
      has((await w.sup1.get(`/time-logs?project_id=${id}`)).body.items[0], ['id', 'person', 'kind', 'hours', 'note', 'date'])
      const a = (await w.sup1.get('/activity')).body.items[0]
      has(a, ['id', 'occurredAt', 'actorName', 'actingRole', 'category', 'action', 'targetLabel'])
      const day = (n: number) => new Date(Date.now() + n * 86400_000).toISOString().slice(0, 10)
      const cal = (await w.sup1.get(`/calendar?from=${day(-30)}&to=${day(120)}`)).body.items[0]
      has(cal, ['id', 'date', 'kind', 'projectId', 'projectTitle', 'title'])
    })

    it('reports, faculties, departments, people, supervisor overview, templates', async () => {
      const r = (await w.dean.get('/reports/summary')).body
      has(r, ['health', 'projectsByStatus', 'phasesApproved', 'firstReviewApprovalRate', 'filesUploaded', 'comments', 'submissionsByDay', 'workload'])
      has(r.workload[0], ['supervisor', 'projects', 'pendingReviews', 'avgTurnaroundDays'])
      has((await w.admin.get('/org/faculties')).body.items[0], ['id', 'name', 'dean', 'departments', 'supervisors', 'students', 'activeProjects'])
      has((await w.admin.get('/org/departments?expand=counts')).body.items[0], ['id', 'name', 'faculty', 'head', 'supervisors', 'students', 'activeProjects'])
      has((await w.admin.get('/people?role=supervisor&expand=counts')).body.items[0], ['id', 'name', 'email', 'status', 'canApprove', 'activeProjects', 'titles'])
      has((await w.sup1.get('/people?role=student')).body.items[0], ['id', 'name', 'email'])
      has((await w.dean.get('/supervisors/overview')).body[0], ['supervisor', 'projects', 'pendingReviews', 'avgTurnaroundDays'])
      await w.admin.post('/phase-templates', { name: 'Thesis', phases: [{ name: 'Proposal', duration_days: 14 }] }).expect(201)
      has((await w.sup1.get('/phase-templates')).body.items[0], ['id', 'name', 'phases'])
    })

    it('settings pages', async () => {
      has((await w.sup1.get('/me/profile', null)).body, ['name', 'email', 'title', 'phone', 'studentId', 'batch', 'researchInterests', 'officeHours', 'bio', 'avatarUrl'])
      const sec = (await w.sup1.get('/me/security', null)).body
      has(sec, ['passwordChangedAt', 'googleLinked', 'pendingEmail', 'sessions'])
      has(sec.sessions[0], ['id', 'device', 'location', 'lastActiveAt', 'current'])
      const np = (await w.sup1.get('/me/notification-preferences', null)).body
      has(np, ['events', 'delivery', 'reminderDays'])
      has(np.events.submissions, ['email', 'inApp'])
      has((await w.sup1.get('/me/preferences', null)).body, ['timeZone', 'weekStartsOn'])
      has((await w.sup1.get('/me/supervision-defaults', null)).body, ['unlockRule', 'submissionMode', 'aiStudentFeedback', 'aiRelease', 'aiSupervisorSummary', 'reviewWithinDays'])
      has((await w.sup1.get('/integrations/google-drive', null)).body, ['status', 'account', 'rootFolder', 'usedGb', 'quotaGb', 'connectedAt', 'error'])
      has((await w.sup1.get('/me/data-requests', null)).body, ['exports', 'deletion'])
      has((await w.admin.get(`/workspaces/${w.workspaceId}/settings`)).body, ['name', 'shortName', 'logoUrl', 'newSupervisorsCanApprove', 'supervisorsCanCreateProjects', 'aiEnabled', 'aiMonthlyBudgetUsd', 'aiSpentUsd', 'allowedFileTypes', 'maxFileMb', 'atRiskAfterDays', 'escalateOverdueAfterDays', 'currentTerm'])
      expect((await w.sup1.get('/me/invites', null)).body).toEqual([])
      expect(await w.sup1.get('/me/default-workspace', null).then((r) => typeof r.body)).toBe('string')
    })

    it('problem+json errors carry code, status and field errors', async () => {
      const r = await w.sup1.post('/projects', { title: 'x' })
      expect(r.status).toBe(422)
      has(r.body, ['type', 'title', 'status', 'code'])
      expect(r.body.errors.length).toBeGreaterThan(0)
      expect(r.headers['x-request-id']).toBeTruthy()
    })

    it('KNOWN FRONTEND MISMATCH: enum-keyed dictionaries use the stored (snake_case) keys', async () => {
      // The frontend camelizes every key it receives, which turns `on_track`
      // into `onTrack`, while health-summary.tsx reads `report.health['on_track']`.
      // The API keeps the documented enum values as keys; see docs/STATUS.md.
      const r = (await w.dean.get('/reports/summary')).body
      expect(Object.keys(r.health)).toContain('on_track')
      expect(Object.keys(r.projects_by_status)).toContain('on_hold')
    })
  })
})
