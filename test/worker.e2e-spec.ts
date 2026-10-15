import { FakeAi } from '../src/integrations/ai'
import { LogMailer } from '../src/integrations/mail'
import { computeHealth } from '../src/modules/workflow/health.service'
import { Handlers } from '../src/worker/handlers'
import { JobRunner } from '../src/worker/runner'
import { SystemPrismaService } from '../src/infra/prisma.service'
import { ENV } from '../src/config/env'
import { createTestApp, makePlatformAdmin, signUpAndLogin, TestApp, uniq } from './helpers/app'
import { docx } from './helpers/docx'
import { buildInstitution, connectDrive, createProject, phaseIds, plusDays, submitPhase, uploadDraft, World } from './helpers/world'

describe('background jobs, e-mail, AI, health, Super Admin', () => {
  let t: TestApp
  let w: World
  let runner: JobRunner
  let mailer: LogMailer
  let ai: FakeAi

  beforeAll(async () => {
    t = await createTestApp()
    runner = t.app.get(JobRunner)
    mailer = t.app.get(LogMailer)
    ai = t.app.get(FakeAi)
    w = await buildInstitution(t, 3)
    await connectDrive(t, w.sup1)
    await runner.drain() // flush the invitation e-mails etc.
  })
  afterAll(() => t.close())

  const detail = async (id: string, who = w.sup1) => (await who.get(`/projects/${id}`).expect(200)).body
  const sentTo = (to: string, subject?: RegExp) => mailer.outbox.filter((m) => m.to === to && (!subject || subject.test(m.subject)))

  describe('durable queue', () => {
    it('sends queued e-mail once, then scrubs the one-time link from the job row', async () => {
      const email = `${uniq('mail')}@example.test`
      await t.http().post('/api/v1/auth/sign-up').send({ name: 'Mail Test', email, password: 'correct-horse-battery-9', workspace_type: 'supervision', workspace_name: 'Mail WS' }).expect(202)
      await runner.drain()
      const mails = sentTo(email, /Verify/)
      expect(mails).toHaveLength(1)
      expect(mails[0].html).toContain('/verify-email?token=')
      // delivered jobs keep neither the recipient nor the one-time link
      const done = await t.sys.job.findMany({ where: { kind: 'email.send', status: 'succeeded' } })
      expect(done.length).toBeGreaterThan(0)
      expect(done.every((j) => !JSON.stringify(j.payload).includes('sealed') && !JSON.stringify(j.payload).includes(email))).toBe(true)
      await runner.drain()
      expect(sentTo(email, /Verify/)).toHaveLength(1) // running again changes nothing
    })

    it('retries with backoff, then succeeds; a permanent failure goes dead and is visible to the Super Admin', async () => {
      const email = `${uniq('retry')}@example.test`
      await t.http().post('/api/v1/auth/forgot-password').send({ email }).expect(202) // unknown: no mail
      const target = await signUpAndLogin(t)
      await runner.drain() // flush the sign-up e-mail so the armed failure hits the reset e-mail
      mailer.failNext = new Error('smtp down')
      await t.http().post('/api/v1/auth/forgot-password').send({ email: target.email }).expect(202)
      await runner.drain()
      const job = await t.sys.job.findFirstOrThrow({ where: { kind: 'email.send', payload: { path: ['to'], equals: target.email }, status: 'queued', attempts: 1 } })
      expect(job.lastError).toContain('smtp down')
      expect(job.runAt.getTime()).toBeGreaterThan(Date.now() + 30_000) // backoff, not immediate
      await runner.drain()
      expect(sentTo(target.email, /Reset/)).toHaveLength(0) // not yet due
      await t.sys.job.update({ where: { id: job.id }, data: { runAt: new Date() } })
      await runner.drain()
      expect(sentTo(target.email, /Reset/)).toHaveLength(1)

      await t.sys.job.create({ data: { kind: 'no.such.handler', maxAttempts: 3 } })
      await runner.drain()
      const dead = await t.sys.job.findFirstOrThrow({ where: { kind: 'no.such.handler' } })
      expect(dead.status).toBe('dead')
      expect(dead.attempts).toBe(1) // non-retryable errors are not retried
    })

    it('a job that exhausts its attempts goes dead', async () => {
      const j = await t.sys.job.create({ data: { kind: 'health.recompute', payload: {}, maxAttempts: 2 } }) // payload without projectId throws
      await runner.drain()
      await t.sys.job.update({ where: { id: j.id }, data: { runAt: new Date() } })
      await runner.drain()
      expect((await t.sys.job.findUniqueOrThrow({ where: { id: j.id } })).status).toBe('dead')
    })

    it('two workers never run the same job (SKIP LOCKED); a crashed worker\'s job is reclaimed', async () => {
      const other = new JobRunner(t.app.get(SystemPrismaService), t.app.get(Handlers), t.app.get(ENV))
      const before = mailer.outbox.length
      const to = Array.from({ length: 12 }, () => `${uniq('par')}@example.test`)
      for (const e of to) await t.sys.job.create({ data: { kind: 'notify.email', payload: { userIds: [], kind: 'x', title: e } } })
      const claims = await Promise.all([runner.claim(8), other.claim(8)])
      const ids = claims.flat().map((j) => j.id)
      expect(new Set(ids).size).toBe(ids.length) // no overlap
      expect(ids.length).toBe(12)
      // simulate a crash: claimed but never finished, lock timed out
      const stuck = claims[0][0]
      await t.sys.$executeRaw`UPDATE jobs SET locked_at = now() - interval '10 minutes' WHERE id = ${stuck.id}::uuid`
      const again = await other.claim(5)
      expect(again.map((j) => j.id)).toContain(stuck.id)
      await Promise.all([...claims.flat(), ...again].map((j) => runner.execute(j)))
      void before
    })

    it('enqueueing the same dedupe key twice creates one job (retried requests do not double up)', async () => {
      const a = `dedupe-${Date.now()}`
      await runner['sys'].$executeRaw`INSERT INTO jobs (kind, dedupe_key) VALUES ('sessions.cleanup', ${a}) ON CONFLICT (dedupe_key) DO NOTHING`
      await runner['sys'].$executeRaw`INSERT INTO jobs (kind, dedupe_key) VALUES ('sessions.cleanup', ${a}) ON CONFLICT (dedupe_key) DO NOTHING`
      expect(await t.sys.job.count({ where: { dedupeKey: a } })).toBe(1)
      await runner.schedule()
      await runner.schedule()
      const hourly = await t.sys.job.count({ where: { dedupeKey: { startsWith: `sched:health.sweep:${new Date().toISOString().slice(0, 13)}` } } })
      expect(hourly).toBe(1)
    })

    it('a business change and its jobs commit together: a failed request leaves no job behind', async () => {
      const s = await signUpAndLogin(t)
      const before = await t.sys.job.count()
      const r = await s.post('/org/faculties', { name: 'x' }) // supervision owner: 403, nothing queued
      expect(r.status).toBe(403)
      expect(await t.sys.job.count()).toBe(before)
    })
  })

  describe('notification e-mail follows preferences', () => {
    it('instant by default; a muted category sends none; digests wait', async () => {
      const id = await createProject(w)
      const ph = phaseIds(await detail(id))
      mailer.outbox.length = 0
      await submitPhase(w.students[0], ph[1])
      await runner.drain()
      expect(sentTo(w.sup1.email, /submitted phase 1/)).toHaveLength(1)

      await w.sup2.put('/me/notification-preferences', { events: { submissions: { email: false, in_app: true } }, delivery: 'instant', reminder_days: 3 }, null).expect(204)
      const id2 = await createProject(w)
      const ph2 = phaseIds(await detail(id2))
      await runner.drain()
      mailer.outbox.length = 0
      await submitPhase(w.students[0], ph2[1])
      await runner.drain()
      expect(sentTo(w.sup2.email)).toHaveLength(0)
      expect(await t.sys.notification.count({ where: { userId: w.sup2.userId, title: { contains: 'submitted phase 1' } } })).toBeGreaterThan(0) // in-app still created

      await w.sup3.put('/me/notification-preferences', { events: {}, delivery: 'weekly', reminder_days: 3 }, null).expect(204)
      const id3 = await createProject(w, { lead_id: w.sup3.userId, co_supervisor_ids: [], successor_id: null })
      await connectDrive(t, w.sup3)
      await runner.drain()
      mailer.outbox.length = 0
      await submitPhase(w.students[1], phaseIds(await detail(id3, w.sup3))[1])
      await runner.drain()
      expect(sentTo(w.sup3.email)).toHaveLength(0)
    })

    it('rejects invalid preference payloads', async () => {
      expect((await w.sup1.put('/me/notification-preferences', { events: {}, delivery: 'hourly', reminder_days: 3 }, null)).status).toBe(422)
      expect((await w.sup1.put('/me/notification-preferences', { events: {}, delivery: 'daily', reminder_days: 99 }, null)).status).toBe(422)
    })
  })

  describe('AI feedback (7)', () => {
    let id: string
    let ph: Record<number, string>
    beforeAll(async () => {
      await w.admin.patch(`/workspaces/${w.workspaceId}/settings`, { allowed_file_types: ['pdf', 'docx', 'txt'], ai_enabled: true, ai_monthly_budget_usd: 50 }).expect(204)
    })
    beforeEach(async () => {
      id = await createProject(w)
      ph = phaseIds(await detail(id))
    })

    const submitDocx = async (paragraphs: string[]) => {
      const up = await w.students[0].raw('post', `/phases/${ph[1]}/draft/files`).attach('files', docx(paragraphs), { filename: 'report.docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })
      expect(up.status).toBe(201)
      return (await w.students[0].post(`/phases/${ph[1]}/submissions`, { note: 'for AI' }).expect(201)).body
    }

    it('runs in the background: the submission returns at once with status queued', async () => {
      const v = await submitDocx(['Introduction', 'We study irrigation.'])
      expect((await t.sys.submission.findUniqueOrThrow({ where: { id: v.id } })).aiStatus).toBe('queued')
      await runner.drain()
      expect((await t.sys.submission.findUniqueOrThrow({ where: { id: v.id } })).aiStatus).toBe('ready')
    })

    it('reads the DOCX through the Rust helper and meters usage', async () => {
      const v = await submitDocx(['Smart irrigation', 'A long paragraph with several words for counting purposes'])
      await runner.drain()
      const review = await t.sys.aiReview.findFirstOrThrow({ where: { submissionId: v.id } })
      const strengths = (review.studentFeedback as { strengths: string[] }).strengths.join(' ')
      expect(strengths).toMatch(/Readable text found \(\d+ words\)/) // text came from the Rust extractor
      const usage = await t.sys.aiUsage.findMany({ where: { submissionId: v.id } })
      expect(usage).toHaveLength(1)
      expect(usage[0].tokensIn).toBeGreaterThan(0)
    })

    it('students see feedback only after release; supervisor summaries never reach students', async () => {
      const v = await submitDocx(['Draft text'])
      await runner.drain()
      const supervisorView = (await w.sup1.get(`/projects/${id}/submissions`)).body.items[0]
      expect(supervisorView.ai_summary).toMatchObject({ key_points: expect.any(Array) })
      expect(supervisorView.ai_feedback).toBeTruthy()
      let student = (await w.students[0].get(`/projects/${id}/submissions`)).body.items[0]
      expect(student.ai_feedback).toBeNull()
      expect(student.ai_summary).toBeNull()

      expect((await w.students[0].post(`/submissions/${v.id}/ai/release`)).status).toBe(403)
      await w.sup1.post(`/submissions/${v.id}/ai/release`).expect(204)
      student = (await w.students[0].get(`/projects/${id}/submissions`)).body.items[0]
      expect(student.ai_feedback).toMatchObject({ strengths: expect.any(Array), rubric: expect.any(Array) })
      expect(student.ai_summary).toBeNull()
    })

    it('is idempotent: running the job twice stores one review and bills once', async () => {
      const v = await submitDocx(['Once only'])
      await runner.drain()
      const job = await t.sys.job.findFirstOrThrow({ where: { kind: 'ai.review_submission', payload: { path: ['submissionId'], equals: v.id } } })
      const calls = ai.calls
      await t.sys.submission.update({ where: { id: v.id }, data: { aiStatus: 'queued' } })
      await runner.execute({ ...job, attempts: 1, status: 'running' })
      expect(await t.sys.aiReview.count({ where: { submissionId: v.id } })).toBe(1)
      expect(await t.sys.aiUsage.count({ where: { submissionId: v.id } })).toBe(1)
      void calls
    })

    it('transient provider errors retry; the result lands on the next attempt', async () => {
      ai.failNext = new Error('503 from model')
      const v = await submitDocx(['Retry me'])
      await runner.drain()
      expect((await t.sys.submission.findUniqueOrThrow({ where: { id: v.id } })).aiStatus).toBe('processing')
      const job = await t.sys.job.findFirstOrThrow({ where: { kind: 'ai.review_submission', payload: { path: ['submissionId'], equals: v.id } } })
      expect(job.status).toBe('queued')
      await t.sys.job.update({ where: { id: job.id }, data: { runAt: new Date() } })
      await runner.drain()
      expect((await t.sys.submission.findUniqueOrThrow({ where: { id: v.id } })).aiStatus).toBe('ready')
    })

    it('a permanently failing review ends as "failed" and the submission is unaffected', async () => {
      const v = await submitDocx(['Doomed'])
      const job = await t.sys.job.findFirstOrThrow({ where: { kind: 'ai.review_submission', payload: { path: ['submissionId'], equals: v.id } } })
      await t.sys.job.update({ where: { id: job.id }, data: { maxAttempts: 1 } })
      ai.failNext = new Error('boom')
      await runner.drain()
      const sub = await t.sys.submission.findUniqueOrThrow({ where: { id: v.id } })
      expect(sub.aiStatus).toBe('failed')
      expect(sub.status).toBe('submitted')
      expect((await w.sup1.post(`/submissions/${v.id}/reviews`, { decision: 'approved' })).status).toBe(201)
    })

    it('stops spending when the monthly budget is reached', async () => {
      await w.admin.patch(`/workspaces/${w.workspaceId}/settings`, { ai_monthly_budget_usd: 0.01 }).expect(204)
      await t.sys.$executeRaw`INSERT INTO ai_usage (workspace_id, model, tokens_in, tokens_out, cost_usd, job_id) VALUES (${w.workspaceId}::uuid, 'm', 1, 1, 5, gen_random_uuid())`
      const calls = ai.calls
      const v = await submitDocx(['Over budget'])
      await runner.drain()
      expect((await t.sys.submission.findUniqueOrThrow({ where: { id: v.id } })).aiStatus).toBe('skipped_budget')
      expect(ai.calls).toBe(calls)
      await w.admin.patch(`/workspaces/${w.workspaceId}/settings`, { ai_monthly_budget_usd: 50 }).expect(204)
      await t.sys.$executeRaw`DELETE FROM ai_usage WHERE workspace_id = ${w.workspaceId}::uuid AND model = 'm'`.catch(() => undefined)
    })

    it('switched off per project: no job is queued at all', async () => {
      const off = await createProject(w, { ai_student_feedback: false, ai_supervisor_summary: false })
      const p = phaseIds(await detail(off))
      const before = await t.sys.job.count({ where: { kind: 'ai.review_submission' } })
      const v = (await submitPhase(w.students[0], p[1], 'x', ['a.txt'])).body
      expect(await t.sys.job.count({ where: { kind: 'ai.review_submission' } })).toBe(before)
      expect((await t.sys.submission.findUniqueOrThrow({ where: { id: v.id } })).aiStatus).toBe('disabled')
    })

    it('a hostile "DOCX" is contained by the Rust helper (zip bomb / garbage never crash the worker)', async () => {
      const up = await w.students[0].raw('post', `/phases/${ph[1]}/draft/files`).attach('files', Buffer.from('this is not a zip'), { filename: 'fake.docx' })
      expect(up.status).toBe(201)
      await w.students[0].raw('post', `/phases/${ph[1]}/draft/files`).attach('files', Buffer.from('plain readable notes'), { filename: 'notes.txt' }).expect(201)
      const v = (await w.students[0].post(`/phases/${ph[1]}/submissions`, { note: '' }).expect(201)).body
      await runner.drain()
      expect((await t.sys.submission.findUniqueOrThrow({ where: { id: v.id } })).aiStatus).toBe('ready') // garbage skipped, notes.txt reviewed
    })
  })

  describe('health (10.2)', () => {
    const base = { now: new Date('2026-10-15T12:00:00Z'), projectStatus: 'active', lastStudentActivity: new Date('2026-10-14T12:00:00Z'), pendingSince: null, changesRequestedRounds: 0, atRiskAfterDays: 14, awaitingReviewAfterDays: 3 }
    const ph = (over: object = {}) => ({ position: 1, status: 'open' as const, dueDate: new Date('2026-11-30'), latestVersion: 0, ...over })

    it.each([
      ['all approved -> completed', { phases: [ph({ status: 'approved' })] }, 'completed'],
      ['due yesterday, not submitted -> overdue', { phases: [ph({ dueDate: new Date('2026-10-14') })] }, 'overdue'],
      ['unreviewed for 5 days -> awaiting_review', { phases: [ph({ status: 'submitted' })], pendingSince: new Date('2026-10-10T00:00:00Z') }, 'awaiting_review'],
      ['due in 2 days, not submitted -> at_risk', { phases: [ph({ dueDate: new Date('2026-10-17') })] }, 'at_risk'],
      ['14 days without student activity -> at_risk', { phases: [ph()], lastStudentActivity: new Date('2026-09-30T00:00:00Z') }, 'at_risk'],
      ['two change rounds -> at_risk', { phases: [ph({ status: 'changes_requested' })], changesRequestedRounds: 2 }, 'at_risk'],
      ['otherwise on_track', { phases: [ph()] }, 'on_track'],
      ['overdue beats awaiting_review (first match wins)', { phases: [ph({ dueDate: new Date('2026-10-01') })], pendingSince: new Date('2026-10-01T00:00:00Z') }, 'overdue'],
      ['a submitted phase past its due date is not overdue', { phases: [ph({ status: 'submitted', dueDate: new Date('2026-10-01') })], pendingSince: new Date('2026-10-14T00:00:00Z') }, 'on_track'],
    ])('%s', (_n, over, expected) => {
      expect(computeHealth({ ...base, ...(over as object) } as Parameters<typeof computeHealth>[0]).health).toBe(expected)
    })

    it('recomputes from events and escalates: supervisors on at_risk, Head and Dean on overdue', async () => {
      const id = await createProject(w, { start_date: plusDays(-20), phases: [{ name: 'Late', due_date: plusDays(-2) }, { name: 'Next', due_date: plusDays(30) }] })
      await runner.drain()
      expect((await detail(id)).health).toBe('overdue')
      expect((await detail(id)).health_reason).toMatch(/due 2 days ago/)
      const dean = await t.sys.notification.findMany({ where: { userId: w.dean.userId, kind: 'escalations' } })
      expect(dean.some((n) => n.title.includes('is overdue'))).toBe(true)
      const log = await t.sys.activityLog.findFirst({ where: { projectId: id, actorName: 'System' } })
      expect(log?.action).toMatch(/is now overdue/)
      const lead = await t.sys.notification.findMany({ where: { userId: w.sup1.userId, kind: 'escalations' } })
      expect(lead.some((n) => n.body.includes('due 2 days ago'))).toBe(true)
      // running again changes nothing (idempotent, no duplicate alerts)
      const before = await t.sys.notification.count({ where: { userId: w.dean.userId } })
      await t.sys.job.create({ data: { kind: 'health.recompute', payload: { projectId: id } } })
      await runner.drain()
      expect(await t.sys.notification.count({ where: { userId: w.dean.userId } })).toBe(before)
    })

    it('hourly sweep fans out in batches', async () => {
      await t.sys.job.create({ data: { kind: 'health.sweep' } })
      await runner.drain()
      expect(await t.sys.job.count({ where: { kind: 'health.recompute_batch', status: 'succeeded' } })).toBeGreaterThan(0)
    })
  })

  describe('reminders', () => {
    it('one reminder per phase, person and day count, even when the sweep runs repeatedly', async () => {
      const id = await createProject(w, { start_date: plusDays(-5), phases: [{ name: 'Soon', due_date: plusDays(3) }, { name: 'Later', due_date: plusDays(40) }] })
      for (let i = 0; i < 3; i++) {
        await t.sys.job.create({ data: { kind: 'reminders.deadlines' } })
        await runner.drain()
      }
      const n = await t.sys.notification.findMany({ where: { userId: w.students[0].userId, kind: 'deadlines', title: { contains: 'due in 3 days' } } })
      expect(n.filter((x) => (x.data as { projectId?: string })?.projectId === id)).toHaveLength(1)
    })
  })

  describe('housekeeping and privacy jobs', () => {
    it('cleanup removes expired tokens and finished jobs but keeps live sessions', async () => {
      const s = await signUpAndLogin(t)
      await t.sys.$executeRaw`UPDATE refresh_tokens SET expires_at = now() - interval '3 days' WHERE session_id IN (SELECT id FROM sessions WHERE user_id = ${s.userId}::uuid)`
      await t.sys.job.create({ data: { kind: 'sessions.cleanup' } })
      await runner.drain()
      expect(await t.sys.refreshToken.count({ where: { session: { userId: s.userId } } })).toBe(0)
      expect(await t.sys.session.count({ where: { userId: s.userId, revokedAt: null } })).toBe(1)
    })

    it('account deletion: requested, cancellable, then anonymised after the grace period', async () => {
      const s = await signUpAndLogin(t, { name: 'Leaving Person' })
      await s.post('/me/deletion-request', { reason: 'no longer needed' }, null).expect(202)
      expect((await s.get('/me/data-requests', null)).body.deletion).toMatchObject({ reason: 'no longer needed' })
      await s.del('/me/deletion-request', null).expect(204)
      expect((await s.get('/me/data-requests', null)).body.deletion).toBeNull()

      await s.post('/me/deletion-request', { reason: 'final' }, null).expect(202)
      await t.sys.user.update({ where: { id: s.userId }, data: { deletionRequestedAt: new Date(Date.now() - 15 * 86_400_000) } })
      await t.sys.job.create({ data: { kind: 'users.purge' } })
      await runner.drain()
      const u = await t.sys.user.findUniqueOrThrow({ where: { id: s.userId } })
      expect(u).toMatchObject({ name: 'Deleted user', status: 'deactivated', passwordHash: null })
      expect(u.email).toMatch(/^deleted\+/)
      expect((await s.get('/me', null)).status).toBe(401)
    })

    it('data export e-mails the person their data as an attachment', async () => {
      const s = await signUpAndLogin(t)
      await s.post('/me/export', {}, null).expect(202)
      await runner.drain()
      const m = sentTo(s.email, /data export/i)
      expect(m).toHaveLength(1)
      expect(m[0].attachments?.[0].filename).toBe('project-n-export.json')
      expect(JSON.parse(m[0].attachments![0].content).account.email).toBe(s.email)
    })
  })

  describe('Super Admin (5.3)', () => {
    it('approves institutions, manages plans and sees failed jobs, but cannot reach any tenant', async () => {
      const root = await makePlatformAdmin(t)
      const inst = await t.http().post('/api/v1/auth/sign-up').send({ name: 'Rect', email: `${uniq('rect')}@example.test`, password: 'correct-horse-battery-9', workspace_type: 'institution', workspace_name: 'Pending Uni' }).expect(202)
      expect(inst.body.workspace_status).toBe('pending_approval')

      const pending = (await root.get('/admin/institutions?status=pending_approval', null).expect(200)).body.items
      const mine = pending.find((p: any) => p.name === 'Pending Uni')
      expect(mine).toMatchObject({ type: 'institution', status: 'pending_approval', members: 1, projects: 0 })
      expect(mine.admins[0].email).toBeTruthy()

      await root.patch(`/admin/institutions/${mine.id}/status`, { status: 'active' }, null).expect(204)
      await runner.drain()
      expect(sentTo(mine.admins[0].email, /approved/)).toHaveLength(1)
      expect((await t.sys.workspace.findUniqueOrThrow({ where: { id: mine.id } })).status).toBe('active')
      await root.patch(`/admin/institutions/${mine.id}/status`, { status: 'suspended' }, null).expect(204)

      const plan = await root.post('/admin/plans', { key: `pro-${uniq()}`, name: 'Pro', ai_monthly_budget_usd: 25 }, null).expect(201)
      await root.put(`/admin/institutions/${w.workspaceId}/plan`, { plan_id: plan.body.id }, null).expect(204)
      expect(Number((await t.sys.workspaceSettings.findUniqueOrThrow({ where: { workspaceId: w.workspaceId } })).aiMonthlyBudgetUsd)).toBe(25)

      // failed jobs are listed without payloads and can be retried
      const dead = await t.sys.job.create({ data: { kind: 'x.y', status: 'dead', lastError: 'broke', payload: { secret: 'link' } } })
      const jobs = (await root.get('/admin/jobs', null).expect(200)).body.items
      const row = jobs.find((j: any) => j.id === dead.id)
      expect(row).toMatchObject({ kind: 'x.y', last_error: 'broke' })
      expect(JSON.stringify(jobs)).not.toContain('secret')
      await root.post(`/admin/jobs/${dead.id}/retry`, {}, null).expect(204)
      expect((await root.post(`/admin/jobs/${dead.id}/retry`, {}, null)).status).toBe(409)

      const overview = (await root.get('/admin/overview', null).expect(200)).body
      expect(overview.institutions.active).toBeGreaterThan(0)
      const usage = (await root.get('/admin/usage', null).expect(200)).body.items
      expect(usage.every((u: any) => !('title' in u) && !('projects_list' in u))).toBe(true)

      // never project content, in any form
      const id = await createProject(w)
      expect((await root.get(`/projects/${id}`, w.workspaceId)).status).toBe(403)
      expect((await root.get('/projects', w.workspaceId)).status).toBe(403)
      expect((await root.get(`/comments?project_id=${id}`, w.workspaceId)).status).toBe(403)
    })

    it('everyone else is refused', async () => {
      const norm = await signUpAndLogin(t)
      expect((await norm.get('/admin/overview', null)).status).toBe(403)
      expect((await w.dean.get('/admin/jobs', null)).status).toBe(403)
    })

    it('a suspended institution cannot be used', async () => {
      const s = await signUpAndLogin(t)
      await t.sys.workspace.update({ where: { id: s.workspaceId }, data: { status: 'suspended' } })
      const r = await s.get('/projects')
      expect(r.status).toBe(403)
      expect(r.body.code).toBe('workspace_suspended')
    })
  })
})
