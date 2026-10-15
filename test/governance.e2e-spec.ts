import { createTestApp, TestApp } from './helpers/app'
import { buildInstitution, connectDrive, createProject, joinByInvite, phaseIds, submitPhase, World } from './helpers/world'

describe('governance: approval rights, succession, offboarding', () => {
  let t: TestApp
  let w: World
  beforeAll(async () => {
    t = await createTestApp()
    w = await buildInstitution(t, 4)
    await connectDrive(t, w.sup1)
    await connectDrive(t, w.sup2)
  })
  afterAll(() => t.close())

  const detail = async (id: string, who = w.sup1) => (await who.get(`/projects/${id}`).expect(200)).body

  describe('revoking and restoring approval rights (5.4)', () => {
    it('the Dean revokes a Lead\'s right on one project; the co-supervisor takes over; restore reverses it', async () => {
      const id = await createProject(w)
      const ph = phaseIds(await detail(id))
      const v1 = (await submitPhase(w.students[0], ph[1])).body

      expect((await w.sup2.post(`/people/${w.sup1.userId}/approval-revocations`, { scope: 'project', project_id: id, reason: 'x' })).status).toBe(403)
      expect((await w.dean.post(`/people/${w.sup1.userId}/approval-revocations`, { scope: 'project', project_id: id, reason: '' })).status).toBe(422)
      const rev = await w.dean.post(`/people/${w.sup1.userId}/approval-revocations`, { scope: 'project', project_id: id, reason: 'Conflict of interest' }).expect(201)

      expect((await detail(id)).viewer.can_approve).toBe(false)
      expect((await detail(id, w.sup2)).viewer.can_approve).toBe(true)
      // the revoked supervisor can still review: request changes works, approve does not
      const denied = await w.sup1.post(`/submissions/${v1.id}/reviews`, { decision: 'approved' })
      expect(denied.status).toBe(403)
      // reason is visible to leadership but never to students (database policy)
      const list = (await w.dean.get(`/people/${w.sup1.userId}/approval-revocations`).expect(200)).body.items
      expect(list[0]).toMatchObject({ reason: 'Conflict of interest', scope: 'project' })
      const direct = await t.sys.approvalRevocation.findMany({ where: { projectId: id } })
      expect(direct.length).toBe(1)

      await w.dean.post(`/approval-revocations/${rev.body.id}/restore`, { reason: 'Resolved' }).expect(204)
      expect((await detail(id)).viewer.can_approve).toBe(true)
      expect((await detail(id, w.sup2)).viewer.can_approve).toBe(false)
      // history keeps both
      const log = (await w.dean.get(`/projects/${id}/activity`)).body.items.filter((e: any) => e.category === 'governance')
      expect(log.map((e: any) => e.action).join('|')).toMatch(/revoked.*approval right/)
      expect(log.map((e: any) => e.action).join('|')).toMatch(/restored.*approval right/)
    })

    it('students cannot read revocation reasons, not even straight from the database', async () => {
      const id = await createProject(w)
      await w.dean.post(`/people/${w.sup2.userId}/approval-revocations`, { scope: 'project', project_id: id, reason: 'Private reason' }).expect(201)
      const { PrismaClient } = await import('@prisma/client')
      const app = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL! } } })
      try {
        const rows = await app.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT set_config('app.user_id', ${w.students[0].userId}, true), set_config('app.workspace_id', ${w.workspaceId}, true)`
          return tx.$queryRawUnsafe<unknown[]>('SELECT 1 FROM approval_revocations')
        })
        expect(rows.length).toBe(0)
      } finally {
        await app.$disconnect()
      }
    })

    it('a faculty-wide revocation covers every project of that supervisor and alerts leadership when one becomes blocked', async () => {
      const rv = await joinByInvite(t, w.admin, { role: 'supervisor', name: 'Dr. Revoked', departmentId: w.dept.id })
      await w.admin.patch(`/people/${rv.userId}`, { can_approve: true }).expect(204)
      const id = await createProject(w, { lead_id: rv.userId, co_supervisor_ids: [], successor_id: null })
      expect((await detail(id, rv)).viewer.can_approve).toBe(true)
      const before = await t.sys.notification.count({ where: { userId: w.admin.userId, kind: 'escalations' } })

      await w.dean.post(`/people/${rv.userId}/approval-revocations`, { scope: 'faculty', faculty_id: w.faculty.id, reason: 'Review pending' }).expect(201)
      expect((await detail(id, rv)).viewer.can_approve).toBe(false)
      const listed = (await w.dean.get('/projects').expect(200)).body.items.find((p: any) => p.id === id)
      expect(listed.flags).toContain('approval_blocked')
      expect(await t.sys.notification.count({ where: { userId: w.admin.userId, kind: 'escalations' } })).toBeGreaterThan(before)
      // the database computed the same answer the API reports
      const [row] = await t.sys.$queryRaw<{ can_approve: boolean }[]>`
        SELECT can_approve FROM (SELECT pm.user_id,
          (m.can_approve AND NOT EXISTS (SELECT 1 FROM approval_revocations r WHERE r.user_id = pm.user_id AND r.restored_at IS NULL)) AS can_approve
          FROM project_members pm JOIN memberships m ON m.user_id = pm.user_id AND m.workspace_id = pm.workspace_id
          WHERE pm.project_id = ${id}::uuid AND pm.role = 'lead') x`
      expect(row.can_approve).toBe(false)
    })

    it('a Dean cannot revoke in another faculty', async () => {
      const r = await w.dean.post(`/people/${w.sup1.userId}/approval-revocations`, { scope: 'faculty', faculty_id: w.otherFaculty.id, reason: 'Not mine' })
      expect(r.status).toBe(403)
    })

    it('only one active revocation per scope (database constraint)', async () => {
      const id = await createProject(w)
      await w.dean.post(`/people/${w.sup2.userId}/approval-revocations`, { scope: 'project', project_id: id, reason: 'first' }).expect(201)
      const dup = await w.dean.post(`/people/${w.sup2.userId}/approval-revocations`, { scope: 'project', project_id: id, reason: 'again' })
      expect(dup.status).toBe(409)
    })
  })

  describe('supervisor succession and offboarding (5.6)', () => {
    it('the designated successor becomes Lead; pending work follows; the Dean is told', async () => {
      const leaver = await joinByInvite(t, w.admin, { role: 'supervisor', name: 'Dr. Leaver', departmentId: w.dept.id })
      await w.admin.patch(`/people/${leaver.userId}`, { can_approve: true }).expect(204)
      await connectDrive(t, leaver)
      const id = await createProject(w, { lead_id: leaver.userId, co_supervisor_ids: [w.sup2.userId, w.sup3.userId], successor_id: w.sup3.userId })
      const ph = phaseIds(await detail(id, leaver))
      const v1 = (await submitPhase(w.students[0], ph[1])).body

      const preview = (await w.admin.get(`/people/${leaver.userId}/offboard-preview`).expect(200)).body.items
      expect(preview).toHaveLength(1)
      expect(preview[0]).toMatchObject({ role: 'lead', effect: 'successor_becomes_lead' })
      expect(preview[0].successor.id).toBe(w.sup3.userId)

      expect((await w.sup2.post(`/people/${leaver.userId}/offboard`, { reason: 'trying it' })).status).toBe(403)
      await w.admin.post(`/people/${leaver.userId}/offboard`, { reason: 'Left the university' }).expect(200)

      const d = await detail(id, w.sup3)
      expect(d.lead.id).toBe(w.sup3.userId)
      expect(d.flags).not.toContain('needs_supervisor')
      // the version waiting for review now sits in the new Lead's queue: nothing was copied or lost
      const queue = (await w.sup3.get('/reviews/queue').expect(200)).body.items
      expect(queue.some((q: any) => q.id === v1.id)).toBe(true)
      // the person who left no longer gets in
      expect((await leaver.get(`/projects/${id}`)).status).toBe(403)
      const log = await t.sys.activityLog.findFirst({ where: { projectId: id, action: { contains: 'changed the Lead supervisor' } } })
      expect(log?.reason).toBe('Left the university')
      expect((await t.sys.notification.findMany({ where: { userId: w.dean.userId } })).some((n) => n.title.includes('New Lead'))).toBe(true)
      expect((await t.sys.notification.findMany({ where: { userId: w.sup3.userId } })).some((n) => n.title.includes('now Lead supervisor'))).toBe(true)
    })

    it('without a co-supervisor the project is flagged "needs supervisor"; the Admin assigns a new Lead', async () => {
      const leaver = await joinByInvite(t, w.admin, { role: 'supervisor', name: 'Dr. OnLeave', departmentId: w.dept.id })
      const id = await createProject(w, { lead_id: leaver.userId, co_supervisor_ids: [], successor_id: null })
      const r = (await w.dean.post(`/people/${leaver.userId}/offboard`, { reason: 'Long leave' }).expect(200)).body.items
      expect(r.find((x: any) => x.project.id === id)).toMatchObject({ effect: 'needs_supervisor' })
      const p = (await w.dean.get('/projects').expect(200)).body.items.find((x: any) => x.id === id)
      expect(p.flags).toContain('needs_supervisor')
      expect(p.lead).toBeNull()

      expect((await w.sup3.put(`/projects/${id}/lead`, { user_id: w.sup3.userId, reason: 'self' })).status).toBe(404) // not on the project: invisible
      await w.admin.put(`/projects/${id}/lead`, { user_id: w.sup3.userId }).expect(204)
      const d = await detail(id, w.sup3)
      expect(d.lead.id).toBe(w.sup3.userId)
      expect(d.flags).not.toContain('needs_supervisor')
    })

    it('a Dean may not offboard someone outside their faculty', async () => {
      const other = await joinByInvite(t, w.admin, { role: 'supervisor', name: 'Dr. Elsewhere', departmentId: w.otherDept.id })
      expect((await w.dean.post(`/people/${other.userId}/offboard`, { reason: 'trying' })).status).toBe(403)
    })

    it('the Lead and the Dean designate a successor; it must be a co-supervisor', async () => {
      const id = await createProject(w, { lead_id: w.sup1.userId, co_supervisor_ids: [w.sup2.userId], successor_id: null })
      expect((await w.sup1.put(`/projects/${id}/successor`, { user_id: w.sup3.userId })).status).toBe(422)
      await w.sup1.put(`/projects/${id}/successor`, { user_id: w.sup2.userId }).expect(204)
      const s = (await detail(id)).supervisors.find((x: any) => x.id === w.sup2.userId)
      expect(s.is_successor).toBe(true)
      expect((await w.students[0].put(`/projects/${id}/successor`, { user_id: w.sup2.userId })).status).toBe(403)
    })

    it('a person with a database-enforced single Lead: two simultaneous reassignments leave exactly one', async () => {
      const id = await createProject(w, { lead_id: w.sup1.userId, co_supervisor_ids: [w.sup2.userId], successor_id: null })
      await Promise.all([
        w.dean.put(`/projects/${id}/lead`, { user_id: w.sup2.userId, reason: 'Rotation A' }),
        w.admin.put(`/projects/${id}/lead`, { user_id: w.sup3.userId }),
      ])
      const leads = await t.sys.projectMember.count({ where: { projectId: id, role: 'lead', leftAt: null } })
      expect(leads).toBe(1)
    })
  })
})
