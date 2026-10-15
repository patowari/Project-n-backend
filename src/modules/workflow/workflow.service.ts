import { Injectable } from '@nestjs/common'
import { OverrideKind, Prisma } from '@prisma/client'
import { Caller } from '../../authz/caller'
import {
  actingRoleLabel,
  approvalBlocked,
  canApprove,
  canOverride,
  canRequestExtension,
  canReview,
  canSubmit,
  phaseApprovers,
  projectRole,
  seesSupervisorOnly,
} from '../../authz/policy'
import { ApiError, conflict, forbidden, notFound, unprocessable } from '../../common/http'
import { Db } from '../../infra/db'
import { ActivityService, AuditService, JobsService, NotificationService } from '../core/core.services'
import { isoDate, LoadedProject, PersonRef, ProjectCore } from '../projects/project-core.service'
import { day } from '../projects/projects.service'

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/
const MIN_REASON = 3

type Tx = Prisma.TransactionClient

export interface SubmissionView {
  id: string
  phaseId: string
  phaseName: string
  version: number
  status: 'submitted' | 'changes_requested' | 'approved'
  submittedBy: PersonRef
  submittedAt: Date
  note: string
  files: {
    id: string
    name: string
    requirementId?: string
    mimeType: string
    sizeKb: number
    driveUrl: string
    uploadedBy: PersonRef
    uploadedAt: Date
  }[]
  aiFeedback: unknown | null
  aiSummary: unknown | null
  review: { decision: 'approved' | 'changes_requested'; by: PersonRef; actingRole: string; comment: string; at: Date } | null
}

@Injectable()
export class WorkflowService {
  constructor(
    private db: Db,
    private core: ProjectCore,
    private activity: ActivityService,
    private audit: AuditService,
    private jobs: JobsService,
    private notifications: NotificationService
  ) {}

  private get tx(): Tx {
    return this.db.tx
  }

  /* ---------------------- who to tell (escalation) ---------------------- */

  /** Dean of the faculty, Head of the department, Owner, and Institution Admins. */
  async leadership(x: LoadedProject, opts: { admins?: boolean } = {}): Promise<string[]> {
    const or: Prisma.MembershipRoleWhereInput[] = [{ role: 'supervision_owner' }]
    if (x.facts.departmentId) or.push({ role: 'head', scopeId: x.facts.departmentId })
    if (x.facts.facultyId) or.push({ role: 'dean', scopeId: x.facts.facultyId })
    if (opts.admins) or.push({ role: 'institution_admin' })
    const rows = await this.tx.membershipRole.findMany({ where: { OR: or, membership: { status: 'active' } }, select: { membership: { select: { userId: true } } } })
    return [...new Set(rows.map((r) => r.membership.userId))]
  }

  private supervisorIds(x: LoadedProject) {
    return x.facts.members.filter((m) => m.role !== 'student').map((m) => m.userId)
  }
  private studentIds(x: LoadedProject) {
    return x.facts.members.filter((m) => m.role === 'student').map((m) => m.userId)
  }

  /** "Approval blocked": no supervisor on the project holds the right (5.4). */
  private async alertBlocked(c: Caller, x: LoadedProject) {
    const to = await this.leadership(x, { admins: true })
    await this.notifications.notify(
      to,
      { kind: 'escalations', title: `Approval blocked on “${x.row.title}”`, body: 'No supervisor on this project can approve phases. A Dean can approve, restore a right, or add a supervisor.', link: `/projects/${x.row.id}`, data: { projectId: x.row.id } },
      { exclude: c.userId }
    )
  }

  /* ------------------------------ submit ------------------------------ */

  /**
   * Finalize the draft as the next immutable version. The phase row is locked
   * first, so two group members pressing Submit at once produce one version
   * and one clean 409, never two.
   */
  async submit(c: Caller, phaseId: string, v: { note?: string }, idempotencyKey?: string): Promise<SubmissionView> {
    const probe = await this.tx.phase.findUnique({ where: { id: phaseId }, select: { projectId: true } })
    if (!probe) throw notFound('Phase')
    await this.db.lock('phases', phaseId)
    const phase = await this.tx.phase.findUniqueOrThrow({ where: { id: phaseId }, include: { requirements: true } })
    const x = await this.core.loadVisible(c, probe.projectId)

    if (!canSubmit(c, x.facts)) {
      throw forbidden(projectRole(c, x.facts) === 'student' ? 'only_leader_submits' : 'cannot_submit', projectRole(c, x.facts) === 'student' ? 'Only the group leader can submit this phase' : 'Only students in this project can submit')
    }
    if (x.row.status !== 'active') throw conflict('project_not_active', `The project is ${x.row.status.replace('_', ' ')}`)
    if (!['open', 'changes_requested'].includes(phase.status)) {
      throw conflict('phase_not_open', phase.status === 'submitted' ? 'This phase was already submitted and is waiting for review' : phase.status === 'approved' ? 'This phase is already approved' : 'This phase is not open yet')
    }

    const drafts = await this.tx.draftFile.findMany({ where: { phaseId }, orderBy: { uploadedAt: 'asc' } })
    if (drafts.length === 0) throw unprocessable('no_files', 'Upload at least one file before submitting')
    const missing = phase.requirements.filter((r) => !r.optional && !drafts.some((d) => d.requirementId === r.id))
    if (missing.length) {
      throw unprocessable('missing_required_documents', `Missing: ${missing.map((m) => m.name).join(', ')}`, missing.map((m) => ({ field: 'files', message: m.name })))
    }

    const settings = await this.tx.workspaceSettings.findUniqueOrThrow({ where: { workspaceId: c.workspaceId! } })
    const aiOn = settings.aiEnabled && (x.row.aiStudentFeedback || x.row.aiSupervisorSummary)
    const version = phase.latestVersion + 1

    const sub = await this.tx.submission.create({
      data: {
        workspaceId: c.workspaceId!,
        projectId: x.row.id,
        phaseId,
        version,
        submittedById: c.userId,
        note: (v.note ?? '').trim().slice(0, 2000),
        idempotencyKey: idempotencyKey ?? null,
        aiStatus: aiOn ? 'queued' : 'disabled',
      },
    })
    await this.tx.submissionFile.createMany({
      data: drafts.map((d) => ({
        workspaceId: c.workspaceId!,
        projectId: x.row.id,
        submissionId: sub.id,
        requirementId: d.requirementId,
        name: d.name,
        mimeType: d.mimeType,
        sizeBytes: d.sizeBytes,
        driveFileId: d.driveFileId,
        driveUrl: d.driveUrl,
        md5: d.md5,
        uploadedById: d.uploadedById,
        uploadedAt: d.uploadedAt,
      })),
    })
    await this.tx.draftFile.deleteMany({ where: { phaseId } })
    await this.tx.phase.update({ where: { id: phaseId }, data: { status: 'submitted', latestVersion: version } })

    // Unlock rule "on_submit": the next phase opens as soon as this one is handed in.
    if (x.row.unlockRule === 'on_submit') await this.openNext(x.row.id, phase.position)

    await this.activity.record(c, x.facts, {
      category: 'submissions',
      action: `submitted phase ${phase.position} “${phase.name}” (v${version})`,
      targetType: 'submission',
      targetId: sub.id,
      targetLabel: x.row.title,
      phaseId,
    })
    const blocked = approvalBlocked(x.facts)
    await this.notifications.notify(this.supervisorIds(x), {
      kind: 'submissions',
      title: `${c.name} submitted phase ${phase.position} (v${version})`,
      body: x.row.title,
      link: `/projects/${x.row.id}`,
      data: { projectId: x.row.id, submissionId: sub.id },
    })
    if (blocked) await this.alertBlocked(c, x)
    if (aiOn) await this.jobs.enqueue('ai.review_submission', { submissionId: sub.id }, { dedupeKey: `ai:${sub.id}` })
    await this.jobs.healthRecompute(x.row.id)
    await this.audit.log('submission.created', { actorId: c.userId, targetType: 'submission', targetId: sub.id })
    return (await this.views(c, x, [sub.id]))[0]
  }

  /** locked -> open for the phase after `position`. */
  private async openNext(projectId: string, position: number) {
    const next = await this.tx.phase.findFirst({ where: { projectId, position: { gt: position }, status: 'locked' }, orderBy: { position: 'asc' } })
    if (next) await this.tx.phase.update({ where: { id: next.id }, data: { status: 'open' } })
  }

  /* --------------------------- read versions --------------------------- */

  async list(c: Caller, projectId: string): Promise<SubmissionView[]> {
    const x = await this.core.loadVisible(c, projectId, { phases: false })
    const rows = await this.tx.submission.findMany({ where: { projectId }, orderBy: [{ submittedAt: 'desc' }, { version: 'desc' }], take: 200, select: { id: true } })
    return this.views(c, x, rows.map((r) => r.id))
  }

  async views(c: Caller, x: LoadedProject, ids: string[]): Promise<SubmissionView[]> {
    if (ids.length === 0) return []
    const rows = await this.tx.submission.findMany({
      where: { id: { in: ids } },
      include: { files: { orderBy: { uploadedAt: 'asc' } }, reviews: { orderBy: { createdAt: 'desc' }, take: 1 }, aiReview: true, phase: { select: { name: true } } },
    })
    const byId = new Map(rows.map((r) => [r.id, r]))
    const people = await this.core.people(rows.flatMap((r) => [r.submittedById, ...r.files.map((f) => f.uploadedById), ...r.reviews.map((rv) => rv.reviewerId)]))
    const ref = (id: string) => people.get(id) ?? { id, name: 'Unknown' }
    const supervisorView = seesSupervisorOnly(c, x.facts)
    return ids
      .map((id) => byId.get(id))
      .filter((r): r is NonNullable<typeof r> => !!r)
      .map((r) => ({
        id: r.id,
        phaseId: r.phaseId,
        phaseName: r.phase.name,
        version: r.version,
        status: r.status,
        submittedBy: ref(r.submittedById),
        submittedAt: r.submittedAt,
        note: r.note,
        files: r.files.map((f) => ({
          id: f.id,
          name: f.name,
          ...(f.requirementId ? { requirementId: f.requirementId } : {}),
          mimeType: f.mimeType,
          sizeKb: Math.max(1, Math.ceil(Number(f.sizeBytes) / 1024)),
          driveUrl: f.driveUrl,
          uploadedBy: ref(f.uploadedById),
          uploadedAt: f.uploadedAt,
        })),
        // Student feedback is hidden from students until released (7.2).
        aiFeedback: r.aiReview?.studentFeedback && (supervisorView || r.aiReleased) ? r.aiReview.studentFeedback : null,
        // Supervisor summaries never reach students.
        aiSummary: supervisorView ? (r.aiReview?.supervisorSummary ?? null) : null,
        review: r.reviews[0] ? { decision: r.reviews[0].decision, by: ref(r.reviews[0].reviewerId), actingRole: r.reviews[0].actingRole, comment: r.reviews[0].comment, at: r.reviews[0].createdAt } : null,
      }))
  }

  /* ------------------------------ review ------------------------------ */

  async review(c: Caller, submissionId: string, v: { decision: 'approved' | 'changes_requested'; comment?: string }) {
    const probe = await this.tx.submission.findUnique({ where: { id: submissionId }, select: { phaseId: true, projectId: true } })
    if (!probe) throw notFound('Submission')
    // Lock order is always phase -> submission, so concurrent reviewers cannot deadlock.
    await this.db.lock('phases', probe.phaseId)
    await this.db.lock('submissions', submissionId)
    const sub = await this.tx.submission.findUniqueOrThrow({ where: { id: submissionId } })
    const phase = await this.tx.phase.findUniqueOrThrow({ where: { id: sub.phaseId } })
    const x = await this.core.loadVisible(c, sub.projectId)

    if (!canReview(c, x.facts)) throw forbidden('not_a_reviewer', 'Only supervisors on this project can review submissions')
    if (x.row.status !== 'active') throw conflict('project_not_active', `The project is ${x.row.status.replace('_', ' ')}`)
    if (sub.status !== 'submitted') throw conflict('already_reviewed', 'This version has already been reviewed')
    if (phase.latestVersion !== sub.version || phase.status !== 'submitted') throw conflict('stale_version', 'A newer version exists or the phase changed')

    const comment = (v.comment ?? '').trim()
    if (v.decision === 'approved') {
      if (approvalBlocked(x.facts)) throw forbidden('approval_blocked', 'No supervisor on this project can approve. A Dean can approve or restore a right')
      if (!canApprove(c, x.facts)) {
        throw forbidden('approval_not_permitted', projectRole(c, x.facts) === 'co_supervisor' ? 'The Lead signs off this phase, or a co-supervisor when the Lead cannot' : 'You do not have the approval right. You can request changes instead')
      }
    } else if (comment.length < MIN_REASON) {
      throw unprocessable('comment_required', 'Say what needs to change', [{ field: 'comment', message: 'Required' }])
    }
    await this.applyDecision(c, x, sub, phase, v.decision, comment, actingRoleLabel(c, x.facts), false)
    return (await this.views(c, x, [submissionId]))[0]
  }

  /** Shared by routine review and the Dean's approve override. */
  private async applyDecision(
    c: Caller,
    x: LoadedProject,
    sub: { id: string; version: number },
    phase: { id: string; position: number; name: string },
    decision: 'approved' | 'changes_requested',
    comment: string,
    actingRole: string,
    isOverride: boolean
  ) {
    await this.tx.review.create({
      data: { workspaceId: c.workspaceId!, projectId: x.row.id, submissionId: sub.id, decision, comment, reviewerId: c.userId, actingRole, isOverride },
    })
    await this.tx.submission.update({ where: { id: sub.id }, data: { status: decision } })
    await this.tx.phase.update({
      where: { id: phase.id },
      data:
        decision === 'approved'
          ? { status: 'approved', approvedAt: new Date(), approvedById: c.userId, approvedByRole: actingRole }
          : { status: 'changes_requested' },
    })
    let completed = false
    if (decision === 'approved') {
      await this.openNext(x.row.id, phase.position)
      const left = await this.tx.phase.count({ where: { projectId: x.row.id, status: { not: 'approved' } } })
      if (left === 0) {
        completed = true
        await this.tx.project.update({ where: { id: x.row.id }, data: { status: 'completed', version: { increment: 1 } } })
      }
      // "after_review" release: students see the AI feedback once a supervisor has looked.
      await this.tx.submission.update({ where: { id: sub.id }, data: { aiReleased: true } })
    }
    await this.activity.record(c, x.facts, {
      category: 'reviews',
      action: decision === 'approved' ? `approved phase ${phase.position} “${phase.name}” (v${sub.version})` : `requested changes on phase ${phase.position} (v${sub.version})`,
      targetType: 'submission',
      targetId: sub.id,
      targetLabel: x.row.title,
      phaseId: phase.id,
      reason: isOverride ? comment : undefined,
      isOverride,
    })
    await this.notifications.notify(
      this.studentIds(x),
      {
        kind: 'reviews',
        title: decision === 'approved' ? `Phase ${phase.position} approved` : `Changes requested on phase ${phase.position}`,
        body: comment || x.row.title,
        link: `/projects/${x.row.id}`,
        data: { projectId: x.row.id, submissionId: sub.id },
      },
      { exclude: c.userId }
    )
    if (completed) {
      await this.activity.record(c, x.facts, { category: 'project', action: 'completed the project (all phases approved)', targetType: 'project', targetId: x.row.id, targetLabel: x.row.title })
      await this.notifications.notify([...this.studentIds(x), ...this.supervisorIds(x)], { kind: 'reviews', title: `“${x.row.title}” is complete`, link: `/projects/${x.row.id}` }, { exclude: c.userId })
    }
    await this.jobs.healthRecompute(x.row.id)
    await this.audit.log(isOverride ? 'governance.override_approve' : 'review.decided', { actorId: c.userId, targetType: 'submission', targetId: sub.id, data: { decision } })
  }

  /** Lead releases AI feedback to students (7.2). */
  async releaseAi(c: Caller, submissionId: string) {
    const sub = await this.tx.submission.findUnique({ where: { id: submissionId } })
    if (!sub) throw notFound('Submission')
    const x = await this.core.loadVisible(c, sub.projectId, { phases: false })
    if (projectRole(c, x.facts) !== 'lead' && !canOverride(c, x.facts)) throw forbidden('cannot_release_ai')
    if (sub.aiStatus !== 'ready') throw conflict('ai_not_ready', 'AI feedback is not ready yet')
    await this.tx.submission.update({ where: { id: submissionId }, data: { aiReleased: true } })
    await this.activity.record(c, x.facts, { category: 'ai', action: `released AI feedback for v${sub.version} to students`, targetType: 'submission', targetId: sub.id, targetLabel: x.row.title, phaseId: sub.phaseId })
    await this.notifications.notify(this.studentIds(x), { kind: 'reviews', title: 'AI feedback is ready', body: x.row.title, link: `/projects/${x.row.id}` }, { exclude: c.userId })
  }

  /* ----------------------------- extensions ----------------------------- */

  async requestExtension(c: Caller, phaseId: string, v: { until: string; reason: string }) {
    const probe = await this.tx.phase.findUnique({ where: { id: phaseId }, select: { projectId: true } })
    if (!probe) throw notFound('Phase')
    await this.db.lock('phases', phaseId)
    const phase = await this.tx.phase.findUniqueOrThrow({ where: { id: phaseId } })
    const x = await this.core.loadVisible(c, probe.projectId)
    if (!canRequestExtension(c, x.facts)) throw forbidden('only_leader_requests_extension', 'The group leader requests extensions for the group')
    if (x.row.status !== 'active') throw conflict('project_not_active', 'The project is not active')
    if (!['open', 'changes_requested'].includes(phase.status)) throw conflict('phase_not_open', 'Extensions apply to the phase you are working on')
    if (!DAY_RE.test(v.until)) throw unprocessable('invalid_date', 'Use YYYY-MM-DD', [{ field: 'until', message: 'Invalid date' }])
    const due = isoDate(phase.dueDate)
    if (due && v.until <= due) throw unprocessable('invalid_date', 'The new date must be after the current due date', [{ field: 'until', message: 'Must be later' }])
    if (v.reason.trim().length < MIN_REASON) throw unprocessable('reason_required', 'Explain why you need more time', [{ field: 'reason', message: 'Required' }])
    const pending = await this.tx.extensionRequest.findFirst({ where: { phaseId, status: 'pending' } })
    if (pending) throw conflict('extension_pending', 'An extension request is already waiting for a decision')

    const ext = await this.tx.extensionRequest.create({
      data: { workspaceId: c.workspaceId!, projectId: x.row.id, phaseId, requestedById: c.userId, until: day(v.until), reason: v.reason.trim() },
    })
    await this.activity.record(c, x.facts, {
      category: 'reviews',
      action: `requested an extension for phase ${phase.position} “${phase.name}”`,
      targetType: 'extension',
      targetId: ext.id,
      targetLabel: x.row.title,
      phaseId,
      before: due ?? 'none',
      after: v.until,
      reason: v.reason.trim(),
    })
    const approvers = phaseApprovers(x.facts)
    if (approvers.length) {
      await this.notifications.notify(approvers, { kind: 'extensions', title: `Extension requested: ${x.row.title}`, body: v.reason.trim(), link: `/projects/${x.row.id}`, data: { extensionId: ext.id } })
    } else {
      await this.alertBlocked(c, x)
    }
    return { id: ext.id }
  }

  /** Lead (or a co-supervisor when the Lead cannot); the Dean decides when nobody can (5.4, 5.5). */
  async decideExtension(c: Caller, extensionId: string, v: { decision: 'approved' | 'rejected'; note?: string }) {
    const probe = await this.tx.extensionRequest.findUnique({ where: { id: extensionId }, select: { phaseId: true, projectId: true } })
    if (!probe) throw notFound('Extension request')
    await this.db.lock('phases', probe.phaseId)
    await this.db.lock('extension_requests', extensionId)
    const ext = await this.tx.extensionRequest.findUniqueOrThrow({ where: { id: extensionId } })
    const phase = await this.tx.phase.findUniqueOrThrow({ where: { id: ext.phaseId } })
    const x = await this.core.loadVisible(c, ext.projectId)
    if (ext.status !== 'pending') throw conflict('already_decided', 'This request was already decided')

    const routine = canApprove(c, x.facts)
    const override = !routine && canOverride(c, x.facts)
    if (!routine && !override) throw forbidden('approval_not_permitted', 'Only an approving supervisor, or the Dean, decides extensions')
    const note = (v.note ?? '').trim()
    if (override && note.length < MIN_REASON) throw unprocessable('reason_required', 'A reason is required when deciding as Dean', [{ field: 'note', message: 'Required' }])

    if (v.decision === 'approved') {
      const next = await this.tx.phase.findFirst({ where: { projectId: ext.projectId, position: { gt: phase.position }, dueDate: { not: null } }, orderBy: { position: 'asc' } })
      if (next?.dueDate && isoDate(ext.until)! >= isoDate(next.dueDate)!) {
        throw unprocessable('overlaps_next_phase', 'The new date reaches the next phase deadline. Move that deadline first', [{ field: 'until', message: 'Overlaps next phase' }])
      }
      await this.tx.phase.update({ where: { id: phase.id }, data: { dueDate: ext.until } })
    }
    await this.tx.extensionRequest.update({
      where: { id: extensionId },
      data: { status: v.decision, decidedById: c.userId, decidedAt: new Date(), decisionNote: note || null },
    })
    if (override) {
      await this.tx.override.create({
        data: {
          workspaceId: c.workspaceId!, projectId: x.row.id, phaseId: phase.id, kind: 'move_deadline', reason: note, actorId: c.userId, actorRole: actingRoleLabel(c, x.facts),
          actorIsSupervisor: projectRole(c, x.facts) !== null,
          before: { dueDate: isoDate(phase.dueDate) }, after: { dueDate: v.decision === 'approved' ? isoDate(ext.until) : isoDate(phase.dueDate), extension: v.decision },
        },
      })
    }
    await this.activity.record(c, x.facts, {
      category: 'reviews',
      action: `${v.decision === 'approved' ? 'approved' : 'rejected'} the extension for phase ${phase.position}`,
      targetType: 'extension',
      targetId: extensionId,
      targetLabel: x.row.title,
      phaseId: phase.id,
      before: isoDate(phase.dueDate) ?? 'none',
      after: v.decision === 'approved' ? isoDate(ext.until)! : isoDate(phase.dueDate) ?? 'none',
      reason: note || undefined,
      isOverride: override,
    })
    await this.notifications.notify([ext.requestedById, ...this.studentIds(x)], { kind: 'extensions', title: `Extension ${v.decision}`, body: note || x.row.title, link: `/projects/${x.row.id}` }, { exclude: c.userId })
    await this.jobs.healthRecompute(x.row.id)
  }

  async listExtensions(c: Caller, projectId: string) {
    await this.core.loadVisible(c, projectId, { phases: false })
    const rows = await this.tx.extensionRequest.findMany({ where: { projectId }, orderBy: { createdAt: 'desc' }, take: 50 })
    const who = await this.core.people(rows.flatMap((r) => [r.requestedById, ...(r.decidedById ? [r.decidedById] : [])]))
    return rows.map((r) => ({
      id: r.id, phaseId: r.phaseId, until: isoDate(r.until), reason: r.reason, status: r.status, createdAt: r.createdAt,
      requestedBy: who.get(r.requestedById) ?? { id: r.requestedById, name: 'Unknown' },
      decidedBy: r.decidedById ? (who.get(r.decidedById) ?? null) : null, decidedAt: r.decidedAt, decisionNote: r.decisionNote,
    }))
  }

  /* ------------------------------ overrides ------------------------------ */

  /**
   * Dean / Supervision Owner authority (5.5). Every override carries a reason,
   * writes an immutable record + activity entry, and tells the supervisors
   * (and the Institution Admin when the Dean also supervises the project).
   */
  async override(c: Caller, projectId: string, v: { kind: OverrideKind; target?: { type: 'phase' | 'project'; id: string }; reason: string; dueDate?: string }) {
    await this.db.lock('projects', projectId)
    const x = await this.core.loadVisible(c, projectId)
    if (!canOverride(c, x.facts)) throw forbidden('cannot_override', 'Only the Dean of the faculty (or the Supervision Owner) can override')
    const reason = v.reason.trim()
    if (reason.length < MIN_REASON) throw unprocessable('reason_required', 'A short reason is required for every override', [{ field: 'reason', message: 'Required' }])

    const needsPhase: OverrideKind[] = ['approve_phase', 'reopen_phase', 'move_deadline']
    let phaseId: string | undefined
    if (needsPhase.includes(v.kind)) {
      if (v.target?.type !== 'phase') throw unprocessable('target_required', 'Choose a phase', [{ field: 'target', message: 'Required' }])
      phaseId = v.target.id
      await this.db.lock('phases', phaseId)
    }
    const phase = phaseId ? await this.tx.phase.findFirst({ where: { id: phaseId, projectId } }) : null
    if (phaseId && !phase) throw notFound('Phase')

    let before: Prisma.InputJsonValue = {}
    let after: Prisma.InputJsonValue = {}
    let summary = ''
    let tellStudents = true
    let approveTarget: { id: string; version: number } | null = null
    const role = actingRoleLabel(c, x.facts)
    const isSupervisor = projectRole(c, x.facts) === 'lead' || projectRole(c, x.facts) === 'co_supervisor'

    switch (v.kind) {
      case 'approve_phase': {
        if (!phase || !['submitted', 'changes_requested'].includes(phase.status)) throw conflict('nothing_to_approve', 'There is no submitted version to approve on this phase')
        const latest = await this.tx.submission.findFirst({ where: { phaseId: phase.id, version: phase.latestVersion } })
        if (!latest) throw conflict('nothing_to_approve', 'There is no submitted version to approve on this phase')
        await this.db.lock('submissions', latest.id)
        approveTarget = latest
        before = { phaseStatus: phase.status }
        after = { phaseStatus: 'approved' }
        summary = `approved phase ${phase.position} “${phase.name}” as an override`
        break
      }
      case 'reopen_phase': {
        if (!phase || phase.status !== 'approved') throw conflict('not_approved', 'Only an approved phase can be reopened')
        await this.tx.phase.update({ where: { id: phase.id }, data: { status: 'open', approvedAt: null, approvedById: null, approvedByRole: null } })
        if (x.row.status === 'completed') await this.tx.project.update({ where: { id: projectId }, data: { status: 'active' } })
        before = { phaseStatus: 'approved' }
        after = { phaseStatus: 'open' }
        summary = `reopened phase ${phase.position} “${phase.name}”`
        break
      }
      case 'move_deadline': {
        if (!phase) throw notFound('Phase')
        if (!v.dueDate || !DAY_RE.test(v.dueDate)) throw unprocessable('invalid_date', 'Pick the new date', [{ field: 'dueDate', message: 'Required' }])
        if (phase.status === 'approved') throw conflict('phase_approved', 'An approved phase has no deadline to move')
        const others = await this.tx.phase.findMany({ where: { projectId }, orderBy: { position: 'asc' }, select: { position: true, dueDate: true } })
        const prev = [...others].reverse().find((p) => p.position < phase.position && p.dueDate)
        const next = others.find((p) => p.position > phase.position && p.dueDate)
        if (v.dueDate <= (prev ? isoDate(prev.dueDate)! : isoDate(x.row.startDate)!)) throw unprocessable('invalid_date', 'Must be after the previous phase', [{ field: 'dueDate', message: 'Out of order' }])
        if (next && v.dueDate >= isoDate(next.dueDate)!) throw unprocessable('invalid_date', 'Must be before the next phase', [{ field: 'dueDate', message: 'Out of order' }])
        await this.tx.phase.update({ where: { id: phase.id }, data: { dueDate: day(v.dueDate) } })
        before = { dueDate: isoDate(phase.dueDate) }
        after = { dueDate: v.dueDate }
        summary = `moved the due date of phase ${phase.position}`
        break
      }
      case 'put_on_hold': {
        if (x.row.status !== 'active') throw conflict('invalid_state', 'Only an active project can be put on hold')
        await this.tx.project.update({ where: { id: projectId }, data: { status: 'on_hold', version: { increment: 1 } } })
        before = { status: 'active' }; after = { status: 'on_hold' }; summary = 'put the project on hold'
        break
      }
      case 'resume': {
        if (x.row.status === 'active') throw conflict('invalid_state', 'The project is already active')
        await this.tx.project.update({ where: { id: projectId }, data: { status: 'active', version: { increment: 1 } } })
        before = { status: x.row.status }; after = { status: 'active' }; summary = 'resumed the project'
        break
      }
      case 'complete': {
        if (!['active', 'on_hold'].includes(x.row.status)) throw conflict('invalid_state', 'Only an active or on-hold project can be completed')
        await this.tx.project.update({ where: { id: projectId }, data: { status: 'completed', version: { increment: 1 } } })
        before = { status: x.row.status }; after = { status: 'completed' }; summary = 'marked the project completed'
        break
      }
      case 'cancel': {
        if (!['active', 'on_hold'].includes(x.row.status)) throw conflict('invalid_state', 'Only an active or on-hold project can be cancelled')
        await this.tx.project.update({ where: { id: projectId }, data: { status: 'cancelled', version: { increment: 1 } } })
        before = { status: x.row.status }; after = { status: 'cancelled' }; summary = 'cancelled the project'
        break
      }
    }

    const record = await this.tx.override.create({
      data: { workspaceId: c.workspaceId!, projectId, phaseId: phaseId ?? null, kind: v.kind, reason, actorId: c.userId, actorRole: role, actorIsSupervisor: isSupervisor, before, after },
    })

    if (v.kind === 'approve_phase' && phase && approveTarget) {
      // submitted/changes_requested -> approved is allowed by the phase state machine trigger.
      await this.applyDecision(c, x, approveTarget, phase, 'approved', reason, role, true)
    } else {
      await this.activity.record(c, x.facts, {
        category: 'governance',
        action: summary,
        targetType: v.kind.includes('phase') || v.kind === 'move_deadline' ? 'phase' : 'project',
        targetId: phaseId ?? projectId,
        targetLabel: x.row.title,
        phaseId,
        before: JSON.stringify(before),
        after: JSON.stringify(after),
        reason,
        isOverride: true,
      })
    }
    const to = [...this.supervisorIds(x), ...(tellStudents ? this.studentIds(x) : [])]
    await this.notifications.notify(to, { kind: 'escalations', title: `Dean override: ${summary}`, body: `${x.row.title} — reason: ${reason}`, link: `/projects/${x.row.id}`, data: { projectId, overrideId: record.id } }, { exclude: c.userId })
    if (isSupervisor) {
      // A Dean who also supervises here: flagged in reports, Institution Admins are told (overview).
      const admins = await this.tx.membershipRole.findMany({ where: { role: 'institution_admin', membership: { status: 'active' } }, select: { membership: { select: { userId: true } } } })
      await this.notifications.notify(admins.map((a) => a.membership.userId), { kind: 'escalations', title: 'Dean override on a project they supervise', body: `${x.row.title}: ${summary}`, link: `/projects/${x.row.id}` })
    }
    await this.jobs.healthRecompute(projectId)
    await this.audit.log('governance.override', { actorId: c.userId, targetType: 'project', targetId: projectId, data: { kind: v.kind, reason } })
    return { id: record.id }
  }
}

export { ApiError }
