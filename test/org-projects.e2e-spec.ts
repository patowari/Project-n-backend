import { createTestApp, TestApp } from './helpers/app'
import { buildInstitution, createProject, plusDays, projectBody, World } from './helpers/world'

describe('organization and projects', () => {
  let t: TestApp
  let w: World
  beforeAll(async () => {
    t = await createTestApp()
    w = await buildInstitution(t)
  })
  afterAll(() => t.close())

  describe('roles and scoped authority', () => {
    it('/me reports stacked, scoped roles', async () => {
      const me = (await w.dean.get('/me', null).expect(200)).body
      const roles = me.memberships[0].roles
      expect(roles.map((r: any) => r.role).sort()).toEqual(['dean', 'supervisor'])
      expect(roles.find((r: any) => r.role === 'dean').scope).toMatchObject({ type: 'faculty', id: w.faculty.id })
    })

    it('only the Institution Admin can create faculties', async () => {
      const r = await w.dean.post('/org/faculties', { name: 'Nope' })
      expect(r.status).toBe(403)
    })

    it('one Dean per faculty: assigning a new Dean replaces the old one', async () => {
      await w.admin.patch(`/org/faculties/${w.faculty.id}`, { dean_id: w.sup3.userId }).expect(204)
      const list = (await w.admin.get('/org/faculties').expect(200)).body.items
      expect(list.find((f: any) => f.id === w.faculty.id).dean.id).toBe(w.sup3.userId)
      const me = (await w.dean.get('/me', null)).body
      expect(me.memberships[0].roles.map((r: any) => r.role)).not.toContain('dean')
      await w.admin.patch(`/org/faculties/${w.faculty.id}`, { dean_id: w.dean.userId }).expect(204)
    })

    it('the Admin controls approval permission per supervisor', async () => {
      const list = (await w.admin.get('/people?role=supervisor&expand=counts').expect(200)).body.items
      expect(list.find((p: any) => p.id === w.sup3.userId).can_approve).toBe(false)
      expect(list.find((p: any) => p.id === w.sup1.userId).can_approve).toBe(true)
    })

    it('a student cannot list people or departments counts', async () => {
      expect((await w.students[0].get('/people?role=student')).status).toBe(403)
    })
  })

  describe('invites', () => {
    it('imports CSV rows, reports bad ones with their row number, and never duplicates', async () => {
      const rows = [
        { role: 'student', name: 'Import One', email: `imp1-${Date.now()}@example.test`, departmentId: w.dept.id },
        { role: 'student', name: 'X', email: 'bad-email', departmentId: w.dept.id },
        { role: 'student', name: 'Import Two', email: `imp2-${Date.now()}@example.test`, departmentId: w.dept.id },
        { role: 'student', name: 'No Dept', email: `imp3-${Date.now()}@example.test` },
      ]
      const snake = rows.map((r) => ({ ...r, department_id: r.departmentId }))
      const res = await w.admin.post(`/workspaces/${w.workspaceId}/invites/import`, { rows: snake }).expect(200)
      expect(res.body.created).toBe(2)
      expect(res.body.errors.map((e: any) => e.row).sort()).toEqual([3, 5])
      const again = await w.admin.post(`/workspaces/${w.workspaceId}/invites/import`, { rows: snake.slice(0, 1) }).expect(200)
      expect(again.body.created).toBe(0)
      expect(again.body.errors[0].message).toMatch(/pending invitation/)
    })

    it('a Dean may invite only into their own faculty', async () => {
      const r = await w.dean.post(`/workspaces/${w.workspaceId}/invites`, {
        role: 'student', name: 'Out Of Scope', email: `oos-${Date.now()}@example.test`, department_id: w.otherDept.id,
      })
      expect(r.status).toBe(422)
    })

    it('an invitation link is single-use', async () => {
      const email = `single-${Date.now()}@example.test`
      await w.admin.post(`/workspaces/${w.workspaceId}/invites`, { role: 'student', name: 'Single Use', email, department_id: w.dept.id }).expect(201)
      const [mail] = await t.mails(email, 'invite')
      const token = mail.data.link.split('/invite/')[1]
      await t.http().post(`/api/v1/auth/invites/${token}/accept`).send({ password: 'correct-horse-battery-9' }).expect(200)
      const second = await t.http().post(`/api/v1/auth/invites/${token}/accept`).send({ password: 'correct-horse-battery-9' })
      expect([409, 410]).toContain(second.status)
    })
  })

  describe('creating projects', () => {
    it('a supervisor creates a project with phases, a lead, co-supervisor, group and leader', async () => {
      const r = await w.sup1.post('/projects', projectBody(w)).expect(201)
      expect(r.body.lead.id).toBe(w.sup1.userId)
      expect(r.body.co_supervisors.map((c: any) => c.id)).toEqual([w.sup2.userId])
      expect(r.body.students.length).toBe(2)
      expect(r.body.group_leader.id).toBe(w.students[0].userId)
      expect(r.body.phase_count).toBe(3)
      expect(r.body.current_phase).toMatchObject({ name: 'Proposal', index: 1, status: 'open' })
      expect(r.body.my_role).toBe('lead')
      expect(r.body.flags).toEqual([])
    })

    it('validates the group rules from the architecture', async () => {
      const noLeader = await w.sup1.post('/projects', projectBody(w, { group_leader_id: null }))
      expect(noLeader.status).toBe(422)
      expect(noLeader.body.errors.some((e: any) => e.field === 'groupLeaderId')).toBe(true)

      const badSuccessor = await w.sup1.post('/projects', projectBody(w, { successor_id: w.sup3.userId }))
      expect(badSuccessor.status).toBe(422)

      const badDates = await w.sup1.post('/projects', projectBody(w, { phases: [{ name: 'A', due_date: plusDays(20) }, { name: 'B', due_date: plusDays(10) }] }))
      expect(badDates.status).toBe(422)

      const dup = await w.sup1.post('/projects', projectBody(w, { co_supervisor_ids: [w.sup1.userId], successor_id: null }))
      expect(dup.status).toBe(422)
    })

    it('students cannot create projects; the Admin cannot either (product decision)', async () => {
      expect((await w.students[0].post('/projects', projectBody(w))).status).toBe(403)
      expect((await w.admin.post('/projects', projectBody(w))).status).toBe(403)
    })

    it('the project department must be inside the creator\'s area', async () => {
      const r = await w.sup1.post('/projects', projectBody(w, { department_id: w.otherDept.id }))
      expect(r.status).toBe(403)
    })

    it('Idempotency-Key makes a retried create return the same project', async () => {
      const key = `create-${Date.now()}`
      const body = projectBody(w)
      const a = await w.sup1.post('/projects', body).set('Idempotency-Key', key).expect(201)
      const b = await w.sup1.post('/projects', body).set('Idempotency-Key', key).expect(201)
      expect(b.body.id).toBe(a.body.id)
      expect(b.headers['idempotent-replay']).toBe('true')
      const other = await w.sup1.post('/projects', projectBody(w)).set('Idempotency-Key', key)
      expect(other.status).toBe(422)
      expect(other.body.code).toBe('idempotency_key_reuse')
    })
  })

  describe('who can see a project (RLS + policy)', () => {
    let id: string
    beforeAll(async () => {
      id = await createProject(w)
    })

    it.each([
      ['lead', () => w.sup1, 200],
      ['co-supervisor', () => w.sup2, 200],
      ['group leader', () => w.students[0], 200],
      ['group member', () => w.students[1], 200],
      ['Dean of the faculty', () => w.dean, 200],
      ['Head of the department', () => w.head, 200],
      ['Institution Admin (metadata only)', () => w.admin, 200],
      ['unrelated supervisor', () => w.sup3, 404],
      ['unrelated student', () => w.students[2], 404],
    ])('%s -> %d', async (_name, who, status) => {
      expect((await who().get(`/projects/${id}`)).status).toBe(status)
    })

    it('the Institution Admin sees no timeline, content or capabilities', async () => {
      const d = (await w.admin.get(`/projects/${id}`).expect(200)).body
      expect(d.viewer.sees_content).toBe(false)
      expect(d.phases).toEqual([])
      expect(d.description).toBe('')
    })

    it('capabilities reflect role, approval right and group rules', async () => {
      const lead = (await w.sup1.get(`/projects/${id}`)).body.viewer
      expect(lead).toMatchObject({ can_review: true, can_approve: true, can_edit_timeline: true, can_override: false, can_submit: false })
      const co = (await w.sup2.get(`/projects/${id}`)).body.viewer
      expect(co).toMatchObject({ can_review: true, can_approve: false })
      const leader = (await w.students[0].get(`/projects/${id}`)).body.viewer
      expect(leader).toMatchObject({ can_submit: true, can_request_extension: true, sees_supervisor_only: false })
      const member = (await w.students[1].get(`/projects/${id}`)).body.viewer
      expect(member).toMatchObject({ can_submit: false, can_upload: true, can_request_extension: false })
      const dean = (await w.dean.get(`/projects/${id}`)).body.viewer
      expect(dean).toMatchObject({ can_override: true, sees_supervisor_only: true, can_review: false })
      const head = (await w.head.get(`/projects/${id}`)).body.viewer
      expect(head).toMatchObject({ can_override: false, can_comment: true, sees_supervisor_only: true })
    })

    it('lists show each person only their own scope, with cursor pagination', async () => {
      const mine = (await w.students[2].get('/projects')).body
      expect(mine.items.length).toBe(0)
      const leader = (await w.students[0].get('/projects')).body
      expect(leader.items.every((p: any) => p.my_role === 'student')).toBe(true)

      const page1 = (await w.dean.get('/projects?limit=2').expect(200)).body
      expect(page1.items.length).toBe(2)
      expect(page1.next_cursor).toBeTruthy()
      const page2 = (await w.dean.get(`/projects?limit=2&cursor=${page1.next_cursor}`).expect(200)).body
      expect(page2.items.map((p: any) => p.id)).not.toEqual(expect.arrayContaining(page1.items.map((p: any) => p.id)))
      const bad = await w.dean.get('/projects?cursor=not-a-cursor')
      expect(bad.status).toBe(400)
    })
  })

  describe('group management (5.7)', () => {
    let id: string
    beforeEach(async () => {
      id = await createProject(w)
    })

    it('the Lead changes the group leader; a member cannot', async () => {
      await w.students[1].put(`/projects/${id}/group-leader`, { student_id: w.students[1].userId }).expect(403)
      await w.sup1.put(`/projects/${id}/group-leader`, { student_id: w.students[1].userId }).expect(204)
      const d = (await w.sup1.get(`/projects/${id}`)).body
      expect(d.group_leader.id).toBe(w.students[1].userId)
      expect(d.students.length).toBe(2)
    })

    it('the Dean needs a reason; the change is logged as an override', async () => {
      const noReason = await w.dean.put(`/projects/${id}/group-leader`, { student_id: w.students[1].userId })
      expect(noReason.status).toBe(422)
      expect(noReason.body.code).toBe('reason_required')
      await w.dean.put(`/projects/${id}/group-leader`, { student_id: w.students[1].userId, note: 'Leader unavailable' }).expect(204)
      const log = await t.sys.activityLog.findFirst({ where: { projectId: id, action: 'changed the group leader' } })
      expect(log).toMatchObject({ isOverride: true, reason: 'Leader unavailable', actingRole: 'Dean' })
    })

    it('removing the leader never blocks the group: any member may then submit', async () => {
      await w.sup1.del(`/projects/${id}/students/${w.students[0].userId}`).send({ reason: 'left course' }).expect(204)
      const d = (await w.students[1].get(`/projects/${id}`)).body
      expect(d.group_leader).toBeNull()
      expect(d.viewer.can_submit).toBe(true)
    })

    it('one group leader per project is enforced by the database', async () => {
      await expect(
        t.sys.projectMember.updateMany({ where: { projectId: id, role: 'student', leftAt: null }, data: { isGroupLeader: true } })
      ).rejects.toThrow()
    })

    it('If-Match prevents lost updates', async () => {
      const get = await w.sup1.get(`/projects/${id}`)
      const etag = get.headers['etag']
      await w.sup1.patch(`/projects/${id}`, { description: 'first' }).set('If-Match', etag).expect(200)
      const stale = await w.sup1.patch(`/projects/${id}`, { description: 'second' }).set('If-Match', etag)
      expect(stale.status).toBe(412)
      expect(stale.body.code).toBe('version_mismatch')
    })
  })
})
