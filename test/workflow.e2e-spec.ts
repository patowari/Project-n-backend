import { createTestApp, TestApp } from './helpers/app'
import { buildInstitution, connectDrive, createProject, phaseIds, plusDays, submitPhase, uploadDraft, World } from './helpers/world'

describe('phases, submissions, reviews and approvals', () => {
  let t: TestApp
  let w: World
  beforeAll(async () => {
    t = await createTestApp()
    w = await buildInstitution(t, 4)
    await connectDrive(t, w.sup1)
  })
  afterAll(() => t.close())

  const detail = async (id: string, who = w.sup1) => (await who.get(`/projects/${id}`).expect(200)).body

  describe('drafts and Drive', () => {
    it('uploads wait for the Lead to connect Google Drive', async () => {
      const id = await createProject(w, { lead_id: w.sup2.userId, co_supervisor_ids: [w.sup1.userId], successor_id: w.sup1.userId }) // Lead sup2 has not connected Drive
      const phases = phaseIds(await detail(id, w.sup2))
      const r = await uploadDraft(w.students[0], phases[1])
      expect(r.status).toBe(409)
      expect(r.body.code).toBe('drive_not_connected')
    })

    it('stores only metadata; files land in the Lead\'s Drive tree', async () => {
      const id = await createProject(w)
      const phases = phaseIds(await detail(id))
      await uploadDraft(w.students[1], phases[1], ['proposal.pdf', 'budget.xlsx']).then((r) => expect([r.status, r.body.code, r.body.detail]).toEqual([201, undefined, undefined]))
      const draft = (await w.students[0].get(`/phases/${phases[1]}/draft`).expect(200)).body
      expect(draft.files.map((f: any) => f.name).sort()).toEqual(['budget.xlsx', 'proposal.pdf'])
      expect(draft.files[0].uploaded_by.id).toBe(w.students[1].userId)
      // file bytes are not in our database
      const cols = await t.sys.$queryRaw<{ column_name: string }[]>`SELECT column_name FROM information_schema.columns WHERE table_name = 'draft_files'`
      expect(cols.map((c) => c.column_name)).not.toContain('content')
      const d = await detail(id)
      expect(d.drive_folder_url).toMatch(/drive\.fake\/folders\//)
    })

    it('rejects disallowed file types and oversize files', async () => {
      const id = await createProject(w)
      const phases = phaseIds(await detail(id))
      const exe = await uploadDraft(w.students[0], phases[1], ['virus.exe'])
      expect(exe.status).toBe(422)
      expect(exe.body.code).toBe('file_type_not_allowed')
      await w.admin.patch(`/workspaces/${w.workspaceId}/settings`, { max_file_mb: 1 }).expect(204)
      const big = await w.students[0].post(`/phases/${phases[1]}/draft/uploads`, { name: 'big.pdf', size_bytes: 5 * 1024 * 1024, mime_type: 'application/pdf' })
      expect(big.status).toBe(413)
      await w.admin.patch(`/workspaces/${w.workspaceId}/settings`, { max_file_mb: 50 }).expect(204)
    })

    it('locked phases accept no files', async () => {
      const id = await createProject(w)
      const phases = phaseIds(await detail(id))
      const r = await uploadDraft(w.students[0], phases[2])
      expect(r.status).toBe(409)
      expect(r.body.code).toBe('phase_not_open')
    })

    it('direct-to-Drive: a resumable session, then confirm after the browser uploaded', async () => {
      const id = await createProject(w)
      const phases = phaseIds(await detail(id))
      const sess = await w.students[0].post(`/phases/${phases[1]}/draft/uploads`, { name: 'thesis.pdf', size_bytes: 12, mime_type: 'application/pdf' }).expect(201)
      expect(sess.body.upload_url).toMatch(/drive\.fake\/upload\//)
      const fake = t.app.get(require('../src/integrations/drive.fake').FakeDriveGateway)
      const file = fake.completeUpload(sess.body.upload_url, Buffer.from('twelve bytes'))
      await w.students[0].post(`/phases/${phases[1]}/draft/uploads/confirm`, { drive_file_id: file.id }).expect(201)
      const bogus = await w.students[0].post(`/phases/${phases[1]}/draft/uploads/confirm`, { drive_file_id: 'does-not-exist' })
      expect(bogus.status).toBe(404)
      expect(bogus.body.code).toBe('drive_file_not_found')
    })
  })

  describe('submitting (5.7, 10.1)', () => {
    it('only the group leader submits in leader_only mode; any member in any_member mode', async () => {
      const id = await createProject(w, { student_ids: [w.students[0].userId, w.students[1].userId], group_leader_id: w.students[0].userId })
      const phases = phaseIds(await detail(id))
      await uploadDraft(w.students[1], phases[1])
      const member = await w.students[1].post(`/phases/${phases[1]}/submissions`, { note: 'x' })
      expect(member.status).toBe(403)
      expect(member.body.code).toBe('only_leader_submits')
      await w.sup1.patch(`/projects/${id}`, { submission_mode: 'any_member' }).expect(200)
      const ok = await w.students[1].post(`/phases/${phases[1]}/submissions`, { note: 'now allowed' })
      expect(ok.status).toBe(201)
    })

    it('requires at least one file and every required document', async () => {
      const id = await createProject(w)
      const phases = phaseIds(await detail(id))
      const none = await w.students[0].post(`/phases/${phases[1]}/submissions`, { note: '' })
      expect(none.status).toBe(422)
      expect(none.body.code).toBe('no_files')

      await w.sup1.patch(`/phases/${phases[1]}`, { requirements: [{ id: 'new', name: 'Proposal', optional: false }, { id: 'new2', name: 'Slides', optional: true }] }).expect(204)
      const reqs = (await detail(id)).phases[0].requirements
      await uploadDraft(w.students[0], phases[1], ['slides.pdf'], reqs.find((r: any) => r.name === 'Slides').id)
      const miss = await w.students[0].post(`/phases/${phases[1]}/submissions`, { note: '' })
      expect(miss.status).toBe(422)
      expect(miss.body.code).toBe('missing_required_documents')
      await uploadDraft(w.students[0], phases[1], ['proposal.pdf'], reqs.find((r: any) => r.name === 'Proposal').id)
      await w.students[0].post(`/phases/${phases[1]}/submissions`, { note: '' }).expect(201)
    })

    it('creates immutable, numbered versions and moves the draft into them', async () => {
      const id = await createProject(w)
      const phases = phaseIds(await detail(id))
      const v1 = (await submitPhase(w.students[0], phases[1], 'first', ['a.pdf'])).body
      expect(v1).toMatchObject({ version: 1, status: 'submitted', phase_name: 'Proposal' })
      expect(v1.files.map((f: any) => f.name)).toEqual(['a.pdf'])
      expect((await w.students[0].get(`/phases/${phases[1]}/draft`)).body.files).toEqual([])
      // the database refuses edits to a submitted version
      await expect(t.sys.$executeRaw`UPDATE submissions SET note = 'tampered' WHERE id = ${v1.id}::uuid`).rejects.toThrow(/immutable/)
      const again = await w.students[0].post(`/phases/${phases[1]}/submissions`, { note: 'again' })
      expect(again.status).toBe(409)
      expect(again.body.code).toBe('phase_not_open') // waiting for review
    })

    it('on_approval keeps the next phase locked; on_submit opens it immediately', async () => {
      const a = await createProject(w, { unlock_rule: 'on_approval' })
      const pa = phaseIds(await detail(a))
      await submitPhase(w.students[0], pa[1])
      expect((await detail(a)).phases[1].status).toBe('locked')

      const b = await createProject(w, { unlock_rule: 'on_submit' })
      const pb = phaseIds(await detail(b))
      await submitPhase(w.students[0], pb[1])
      expect((await detail(b)).phases[1].status).toBe('open')
    })
  })

  describe('review and approval (5.4)', () => {
    it('request changes -> resubmit v2 -> approve -> next phase unlocks; history is kept', async () => {
      const id = await createProject(w)
      const ph = phaseIds(await detail(id))
      const v1 = (await submitPhase(w.students[0], ph[1])).body
      const noComment = await w.sup1.post(`/submissions/${v1.id}/reviews`, { decision: 'changes_requested' })
      expect(noComment.status).toBe(422)
      await w.sup1.post(`/submissions/${v1.id}/reviews`, { decision: 'changes_requested', comment: 'Add a budget section' }).expect(201)
      expect((await detail(id)).phases[0].status).toBe('changes_requested')

      const v2 = (await submitPhase(w.students[0], ph[1], 'revised', ['proposal-v2.pdf'])).body
      expect(v2.version).toBe(2)
      const stale = await w.sup1.post(`/submissions/${v1.id}/reviews`, { decision: 'approved' })
      expect(stale.status).toBe(409)

      const approved = await w.sup1.post(`/submissions/${v2.id}/reviews`, { decision: 'approved', comment: 'Good' }).expect(201)
      expect(approved.body.review).toMatchObject({ decision: 'approved', acting_role: 'Supervisor' })
      const d = await detail(id)
      expect(d.phases[0]).toMatchObject({ status: 'approved', latest_version: 2 })
      expect(d.phases[0].approved_by.id).toBe(w.sup1.userId)
      expect(d.phases[1].status).toBe('open')
      const all = (await w.sup1.get(`/projects/${id}/submissions`)).body.items
      expect(all.map((s: any) => [s.version, s.status])).toEqual([[2, 'approved'], [1, 'changes_requested']])
    })

    it('a co-supervisor may request changes, but only signs off when the Lead cannot', async () => {
      const id = await createProject(w)
      const ph = phaseIds(await detail(id))
      const v1 = (await submitPhase(w.students[0], ph[1])).body
      const r = await w.sup2.post(`/submissions/${v1.id}/reviews`, { decision: 'approved' })
      expect(r.status).toBe(403)
      expect(r.body.code).toBe('approval_not_permitted')
      expect((await w.sup2.get(`/projects/${id}`)).body.viewer.can_approve).toBe(false)

      // Institution Admin removes the Lead's right -> the co-supervisor (who has it) takes over
      await w.admin.patch(`/people/${w.sup1.userId}`, { can_approve: false }).expect(204)
      expect((await w.sup2.get(`/projects/${id}`)).body.viewer.can_approve).toBe(true)
      expect((await w.sup1.get(`/projects/${id}`)).body.viewer.can_approve).toBe(false)
      const lead = await w.sup1.post(`/submissions/${v1.id}/reviews`, { decision: 'approved' })
      expect(lead.status).toBe(403)
      await w.sup2.post(`/submissions/${v1.id}/reviews`, { decision: 'approved' }).expect(201)
      await w.admin.patch(`/people/${w.sup1.userId}`, { can_approve: true }).expect(204)
    })

    it('with nobody able to approve the phase is "approval blocked" and the Dean steps in', async () => {
      await connectDrive(t, w.sup3)
      const id = await createProject(w, { lead_id: w.sup3.userId, co_supervisor_ids: [], successor_id: null })
      const ph = phaseIds(await detail(id, w.sup3))
      const summary = (await w.sup3.get(`/projects`)).body.items.find((p: any) => p.id === id)
      expect(summary.flags).toContain('approval_blocked')
      const v1 = (await submitPhase(w.students[0], ph[1])).body
      // leadership got an alert
      const alerts = await t.sys.notification.findMany({ where: { userId: w.dean.userId, kind: 'escalations' } })
      expect(alerts.some((a) => a.title.includes('Approval blocked'))).toBe(true)

      const blocked = await w.sup3.post(`/submissions/${v1.id}/reviews`, { decision: 'approved' })
      expect(blocked.status).toBe(403)
      expect(blocked.body.code).toBe('approval_blocked')
      // requesting changes stays possible
      const noReason = await w.dean.post(`/projects/${id}/overrides`, { kind: 'approve_phase', target: { type: 'phase', id: ph[1] } })
      expect(noReason.status).toBe(422)
      await w.dean.post(`/projects/${id}/overrides`, { kind: 'approve_phase', target: { type: 'phase', id: ph[1] }, reason: 'Lead has no approval right' }).expect(201)
      const d = await detail(id, w.dean)
      expect(d.phases[0]).toMatchObject({ status: 'approved' })
      expect(d.phases[0].approved_by.id).toBe(w.dean.userId)
      const sub = (await w.dean.get(`/projects/${id}/submissions`)).body.items[0]
      expect(sub.review).toMatchObject({ decision: 'approved', acting_role: 'Dean' })
    })

    it('a student cannot review; an unrelated supervisor cannot even see the submission', async () => {
      const id = await createProject(w)
      const ph = phaseIds(await detail(id))
      const v1 = (await submitPhase(w.students[0], ph[1])).body
      expect((await w.students[0].post(`/submissions/${v1.id}/reviews`, { decision: 'approved' })).status).toBe(403)
      expect((await w.sup3.post(`/submissions/${v1.id}/reviews`, { decision: 'approved' })).status).toBe(404)
    })

    it('approving the last phase completes the project', async () => {
      const id = await createProject(w, { phases: [{ name: 'Only', due_date: plusDays(20) }] })
      const ph = phaseIds(await detail(id))
      const v1 = (await submitPhase(w.students[0], ph[1])).body
      await w.sup1.post(`/submissions/${v1.id}/reviews`, { decision: 'approved' }).expect(201)
      const d = await detail(id)
      expect(d.status).toBe('completed')
      const closed = await w.students[0].post(`/phases/${ph[1]}/submissions`, { note: 'x' })
      expect(closed.status).toBe(409)
    })
  })

  describe('concurrency and idempotency', () => {
    it('two group members submitting at once create exactly one version', async () => {
      const id = await createProject(w, { submission_mode: 'any_member', student_ids: [w.students[0].userId, w.students[1].userId], group_leader_id: w.students[0].userId })
      const ph = phaseIds(await detail(id))
      await uploadDraft(w.students[0], ph[1])
      const [a, b] = await Promise.all([
        w.students[0].post(`/phases/${ph[1]}/submissions`, { note: 'A' }),
        w.students[1].post(`/phases/${ph[1]}/submissions`, { note: 'B' }),
      ])
      expect([a.status, b.status].sort()).toEqual([201, 409])
      const count = await t.sys.submission.count({ where: { phaseId: ph[1] } })
      expect(count).toBe(1)
    })

    it('approving the same version twice at once (two tabs): one wins, one gets a clean 409', async () => {
      const id = await createProject(w)
      const ph = phaseIds(await detail(id))
      const v1 = (await submitPhase(w.students[0], ph[1])).body
      const [a, b] = await Promise.all([
        w.sup1.post(`/submissions/${v1.id}/reviews`, { decision: 'approved' }),
        w.sup1.post(`/submissions/${v1.id}/reviews`, { decision: 'approved' }),
      ])
      expect([a.status, b.status].sort()).toEqual([201, 409])
      expect(await t.sys.review.count({ where: { submissionId: v1.id } })).toBe(1)
      expect((await detail(id)).phases[1].status).toBe('open')
    })

    it('Idempotency-Key: a retried submit returns the same version, never a second one', async () => {
      const id = await createProject(w)
      const ph = phaseIds(await detail(id))
      await uploadDraft(w.students[0], ph[1])
      const key = `submit-${Date.now()}`
      const a = await w.students[0].post(`/phases/${ph[1]}/submissions`, { note: 'once' }).set('Idempotency-Key', key).expect(201)
      const b = await w.students[0].post(`/phases/${ph[1]}/submissions`, { note: 'once' }).set('Idempotency-Key', key).expect(201)
      expect(b.body.id).toBe(a.body.id)
      expect(b.headers['idempotent-replay']).toBe('true')
      expect(await t.sys.submission.count({ where: { phaseId: ph[1] } })).toBe(1)
    })

    it('concurrent identical retries with one key still create one version', async () => {
      const id = await createProject(w)
      const ph = phaseIds(await detail(id))
      await uploadDraft(w.students[0], ph[1])
      const key = `race-${Date.now()}`
      const rs = await Promise.all([1, 2, 3, 4].map(() => w.students[0].post(`/phases/${ph[1]}/submissions`, { note: 'race' }).set('Idempotency-Key', key)))
      expect(rs.every((r) => r.status === 201)).toBe(true)
      expect(new Set(rs.map((r) => r.body.id)).size).toBe(1)
      expect(await t.sys.submission.count({ where: { phaseId: ph[1] } })).toBe(1)
    })

    it('the database state machine refuses an illegal phase jump', async () => {
      const id = await createProject(w)
      const ph = phaseIds(await detail(id))
      await expect(t.sys.$executeRaw`UPDATE phases SET status = 'approved' WHERE id = ${ph[1]}::uuid`).rejects.toThrow(/illegal phase transition/)
    })
  })

  describe('extensions', () => {
    it('the group leader requests, the Lead decides, the deadline moves', async () => {
      const id = await createProject(w)
      const ph = phaseIds(await detail(id))
      const before = (await detail(id)).phases[0].due_date
      expect((await w.students[1].post(`/phases/${ph[1]}/extensions`, { until: plusDays(20), reason: 'lab closed' })).status).toBe(403)
      const r = await w.students[0].post(`/phases/${ph[1]}/extensions`, { until: plusDays(20), reason: 'lab closed' }).expect(201)
      expect((await detail(id)).phases[0].extension_pending).toBe(true)
      expect((await w.students[0].post(`/phases/${ph[1]}/extensions`, { until: plusDays(21), reason: 'again' })).status).toBe(409)
      const tooEarly = await w.students[0].post(`/phases/${ph[2]}/extensions`, { until: plusDays(1), reason: 'x' })
      expect([409, 422]).toContain(tooEarly.status)

      expect((await w.sup2.post(`/extensions/${r.body.id}/decision`, { decision: 'approved' })).status).toBe(403)
      await w.sup1.post(`/extensions/${r.body.id}/decision`, { decision: 'approved' }).expect(204)
      const after = (await detail(id)).phases[0]
      expect(after.due_date).toBe(plusDays(20))
      expect(after.due_date).not.toBe(before)
      expect(after.extension_pending).toBe(false)
    })
  })

  describe('Dean overrides (5.5)', () => {
    let id: string
    beforeEach(async () => {
      id = await createProject(w)
    })

    it('only the Dean of the faculty can override; the Head and supervisors cannot', async () => {
      const body = { kind: 'put_on_hold', reason: 'Funding frozen' }
      expect((await w.head.post(`/projects/${id}/overrides`, body)).status).toBe(403)
      expect((await w.sup1.post(`/projects/${id}/overrides`, body)).status).toBe(403)
      expect((await w.students[0].post(`/projects/${id}/overrides`, body)).status).toBe(403)
      await w.dean.post(`/projects/${id}/overrides`, body).expect(201)
    })

    it('put on hold blocks submissions; resume restores them; every step needs a reason and is logged', async () => {
      const ph = phaseIds(await detail(id))
      expect((await w.dean.post(`/projects/${id}/overrides`, { kind: 'put_on_hold', reason: 'x' })).status).toBe(422)
      await w.dean.post(`/projects/${id}/overrides`, { kind: 'put_on_hold', reason: 'Supervisor on leave' }).expect(201)
      expect((await detail(id)).status).toBe('on_hold')
      await uploadDraft(w.students[0], ph[1])
      const held = await w.students[0].post(`/phases/${ph[1]}/submissions`, { note: 'x' })
      expect(held.status).toBe(409)
      expect(held.body.code).toBe('project_not_active')
      await w.dean.post(`/projects/${id}/overrides`, { kind: 'resume', reason: 'Back from leave' }).expect(201)
      await w.students[0].post(`/phases/${ph[1]}/submissions`, { note: 'ok' }).expect(201)

      const rows = await t.sys.override.findMany({ where: { projectId: id }, orderBy: { createdAt: 'asc' } })
      expect(rows.map((r) => [r.kind, r.reason])).toEqual([['put_on_hold', 'Supervisor on leave'], ['resume', 'Back from leave']])
      const log = await t.sys.activityLog.findMany({ where: { projectId: id, isOverride: true } })
      expect(log.length).toBe(2)
      expect(log.every((l) => l.actingRole === 'Dean' && l.category === 'governance')).toBe(true)
      // supervisors are told
      const n = await t.sys.notification.findMany({ where: { userId: w.sup1.userId, kind: 'escalations' } })
      expect(n.some((x) => x.title.includes('put the project on hold'))).toBe(true)
    })

    it('reopen an approved phase and move a deadline, with ordering rules', async () => {
      const ph = phaseIds(await detail(id))
      const v1 = (await submitPhase(w.students[0], ph[1])).body
      await w.sup1.post(`/submissions/${v1.id}/reviews`, { decision: 'approved' }).expect(201)
      await w.dean.post(`/projects/${id}/overrides`, { kind: 'reopen_phase', target: { type: 'phase', id: ph[1] }, reason: 'Missing citations' }).expect(201)
      expect((await detail(id)).phases[0].status).toBe('open')

      const bad = await w.dean.post(`/projects/${id}/overrides`, { kind: 'move_deadline', target: { type: 'phase', id: ph[1] }, reason: 'Lab closure', due_date: plusDays(40) })
      expect(bad.status).toBe(422) // would pass the next phase's deadline
      await w.dean.post(`/projects/${id}/overrides`, { kind: 'move_deadline', target: { type: 'phase', id: ph[1] }, reason: 'Lab closure', due_date: plusDays(15) }).expect(201)
      const log = await t.sys.activityLog.findFirst({ where: { projectId: id, action: { contains: 'moved the due date' } } })
      expect(log?.reason).toBe('Lab closure')
    })

    it('a Dean who also supervises the project is flagged and the Institution Admin is told', async () => {
      const own = await createProject(w, { lead_id: w.dean.userId, co_supervisor_ids: [], successor_id: null }, w.dean)
      await w.dean.post(`/projects/${own}/overrides`, { kind: 'put_on_hold', reason: 'Self review' }).expect(201)
      const o = await t.sys.override.findFirst({ where: { projectId: own } })
      expect(o?.actorIsSupervisor).toBe(true)
      const n = await t.sys.notification.findMany({ where: { userId: w.admin.userId } })
      expect(n.some((x) => x.title.includes('Dean override on a project they supervise'))).toBe(true)
    })

    it('audit rows cannot be altered, even by the system role', async () => {
      await w.dean.post(`/projects/${id}/overrides`, { kind: 'put_on_hold', reason: 'Audit me' }).expect(201)
      await expect(t.sys.$executeRaw`UPDATE overrides SET reason = 'edited' WHERE project_id = ${id}::uuid`).rejects.toThrow()
      await expect(t.sys.$executeRaw`UPDATE activity_log SET action = 'edited' WHERE project_id = ${id}::uuid`).rejects.toThrow()
    })
  })
})
