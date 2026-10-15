import { Inject, Injectable, Logger } from '@nestjs/common'
import { Job, Prisma } from '@prisma/client'
import { open, openJson } from '../common/crypto'
import { ENV, Env } from '../config/env'
import { SystemPrismaService } from '../infra/prisma.service'
import { AiInputFile, AiPermanentError, AiPort, DocTools } from '../integrations/ai'
import { DriveError, DrivePort } from '../integrations/drive.port'
import { renderEmail } from '../integrations/email-templates'
import { MailerPort, PermanentMailError } from '../integrations/mail'
import { ActivityService, EmailTemplate, JobsService, NotificationService } from '../modules/core/core.services'
import { DEFAULT_NOTIFICATIONS, DEFAULT_PREFERENCES, DEFAULT_SUPERVISION } from '../modules/me/me.service'
import { HealthService } from '../modules/workflow/health.service'

/** Retrying will not help (bad input, permanent provider rejection). */
export class NonRetryable extends Error {}

const DAY = 86_400_000
const abs = (env: Env, link?: string | null) => (link ? (/^https?:\/\//.test(link) ? link : `${env.appBaseUrl}${link}`) : undefined)
const merge = <T extends object>(d: T, saved: unknown): T => ({ ...d, ...((saved as object) ?? {}) })

@Injectable()
export class Handlers {
  private readonly log = new Logger('Handlers')

  constructor(
    private sys: SystemPrismaService,
    private mailer: MailerPort,
    private ai: AiPort,
    private docs: DocTools,
    private drive: DrivePort,
    private health: HealthService,
    private activity: ActivityService,
    private notifications: NotificationService,
    private jobs: JobsService,
    @Inject(ENV) private env: Env
  ) {}

  async run(job: Job): Promise<void> {
    const p = (job.payload ?? {}) as Record<string, any>
    switch (job.kind) {
      case 'email.send':
        return this.emailSend(job, p as { to: string; template: EmailTemplate; sealed: string })
      case 'notify.email':
        return this.notifyEmail(job, p as { userIds: string[]; kind: string; title: string; body?: string; link?: string })
      case 'health.recompute':
        await this.health.recompute(this.sys, p.projectId)
        return
      case 'health.recompute_batch':
        for (const id of p.projectIds as string[]) await this.health.recompute(this.sys, id)
        return
      case 'health.sweep':
        await this.health.enqueueSweep(this.sys)
        return
      case 'reminders.deadlines':
        return this.deadlineReminders()
      case 'digest.send':
        return this.digest()
      case 'ai.review_submission':
        return this.aiReview(job, p.submissionId)
      case 'drive.sync_permissions':
        return this.driveSync(p.projectId)
      case 'drive.delete_file':
        return this.driveDelete(p.projectId, p.driveFileId)
      case 'drive.verify_files':
        return this.driveVerify()
      case 'governance.reassign_queue':
        // Queues are derived from roles, never copied, so there is nothing to move.
        // Re-evaluate health for the person's projects so alerts reflect the new rights.
        return this.reassign(p.userId, p.workspaceId)
      case 'sessions.cleanup':
        return this.cleanup()
      case 'users.purge':
        return this.purgeUsers()
      case 'data.export':
        return this.dataExport(p.userId)
      default:
        throw new NonRetryable(`unknown job kind ${job.kind}`)
    }
  }

  /** Called once when a job runs out of attempts. */
  async onDead(job: Job, message: string): Promise<void> {
    if (job.kind !== 'ai.review_submission') return
    const id = (job.payload as { submissionId?: string }).submissionId
    if (!id) return
    const sub = await this.sys.submission.findUnique({ where: { id } })
    if (!sub) return
    await this.sys.submission.update({ where: { id }, data: { aiStatus: 'failed' } })
    await this.sys.aiReview.upsert({
      where: { workspaceId_submissionId: { workspaceId: sub.workspaceId, submissionId: id } },
      create: { workspaceId: sub.workspaceId, projectId: sub.projectId, submissionId: id, error: message.slice(0, 300) },
      update: { error: message.slice(0, 300) },
    })
  }

  /* ------------------------------- e-mail ------------------------------- */

  private async emailSend(job: Job, p: { to: string; template: EmailTemplate; sealed: string }) {
    if (!p.sealed) return // already delivered and scrubbed by a previous run
    const data = openJson<Record<string, unknown>>(p.sealed, this.env.tokenEncryptionKey)
    const r = renderEmail(p.template, data)
    try {
      await this.mailer.send({
        to: p.to, ...r, idempotencyKey: `job-${job.id}`,
        ...(data.attachment ? { attachments: [data.attachment as { filename: string; content: string }] } : {}),
      })
    } catch (e) {
      if (e instanceof PermanentMailError) throw new NonRetryable(e.message)
      throw e
    }
  }

  /** In-app notifications already exist; e-mail follows each person's preferences. */
  private async notifyEmail(job: Job, p: { userIds: string[]; kind: string; title: string; body?: string; link?: string }) {
    const users = await this.sys.user.findMany({
      where: { id: { in: p.userIds }, status: 'active', emailVerifiedAt: { not: null } },
      select: { id: true, email: true, name: true, notificationPrefs: true },
    })
    for (const u of users) {
      const prefs = merge(DEFAULT_NOTIFICATIONS, u.notificationPrefs) as typeof DEFAULT_NOTIFICATIONS
      const ev = prefs.events[p.kind]
      if (ev && ev.email === false) continue
      if (prefs.delivery !== 'instant') continue // goes into the digest
      const r = renderEmail('notification', { title: p.title, body: p.body, link: abs(this.env, p.link) })
      await this.mailer.send({ to: u.email, ...r, idempotencyKey: `notify-${job.id}-${u.id}` })
    }
  }

  private localParts(date: Date, tz: string) {
    const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit' })
    const parts = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]))
    return { hour: Number(parts.hour), weekday: parts.weekday, day: `${parts.year}-${parts.month}-${parts.day}` }
  }

  /** Daily / weekly digests at 08:00 in the person's time zone. */
  private async digest() {
    const now = new Date()
    const users = await this.sys.user.findMany({ where: { status: 'active', emailVerifiedAt: { not: null } }, select: { id: true, email: true, name: true, notificationPrefs: true, preferences: true } })
    for (const u of users) {
      const prefs = merge(DEFAULT_NOTIFICATIONS, u.notificationPrefs) as typeof DEFAULT_NOTIFICATIONS
      if (prefs.delivery === 'instant') continue
      const tz = (merge(DEFAULT_PREFERENCES, u.preferences) as typeof DEFAULT_PREFERENCES).timeZone
      const lp = this.localParts(now, tz)
      if (lp.hour !== 8) continue
      if (prefs.delivery === 'weekly' && lp.weekday !== 'Mon') continue
      const since = new Date(now.getTime() - (prefs.delivery === 'weekly' ? 7 : 1) * DAY)
      const unread = await this.sys.notification.findMany({ where: { userId: u.id, readAt: null, createdAt: { gte: since } }, orderBy: { createdAt: 'desc' }, take: 30 })
      const wanted = unread.filter((n) => prefs.events[n.kind]?.email !== false)
      if (wanted.length === 0) continue
      const r = renderEmail('notification', { title: `Your ${prefs.delivery} digest (${wanted.length})`, body: wanted.map((n) => `• ${n.title}`).join(' ') })
      await this.mailer.send({ to: u.email, ...r, idempotencyKey: `digest-${u.id}-${lp.day}-${prefs.delivery}` })
    }
  }

  /* ----------------------------- reminders ----------------------------- */

  /** "3 days and 1 day before a phase due date" (architecture 8). One reminder per phase, person and day count. */
  private async deadlineReminders() {
    const today = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()))
    const phases = await this.sys.phase.findMany({
      where: { status: { in: ['open', 'changes_requested'] }, dueDate: { gte: today, lte: new Date(today.getTime() + 14 * DAY) }, project: { status: 'active', deletedAt: null } },
      select: { id: true, position: true, name: true, dueDate: true, project: { select: { id: true, title: true, workspaceId: true, members: { where: { leftAt: null, role: 'student' }, select: { userId: true } } } } },
      take: 2000,
    })
    for (const ph of phases) {
      const daysLeft = Math.round((ph.dueDate!.getTime() - today.getTime()) / DAY)
      const users = await this.sys.user.findMany({ where: { id: { in: ph.project.members.map((m) => m.userId) }, status: 'active' }, select: { id: true, notificationPrefs: true } })
      for (const u of users) {
        const prefs = merge(DEFAULT_NOTIFICATIONS, u.notificationPrefs) as typeof DEFAULT_NOTIFICATIONS
        if (prefs.reminderDays <= 0) continue
        if (daysLeft !== prefs.reminderDays && daysLeft !== 1) continue
        const key = `deadline:${ph.id}:${u.id}:${daysLeft}`
        const seen = await this.sys.notification.findFirst({ where: { userId: u.id, kind: 'deadlines', data: { path: ['dedupe'], equals: key } }, select: { id: true } })
        if (seen) continue
        await this.notifications.notifyWith(this.sys, ph.project.workspaceId, [u.id], {
          kind: 'deadlines',
          title: daysLeft === 1 ? `Phase ${ph.position} is due tomorrow` : `Phase ${ph.position} is due in ${daysLeft} days`,
          body: `${ph.project.title} · ${ph.name}`,
          link: `/projects/${ph.project.id}`,
          data: { dedupe: key, projectId: ph.project.id, phaseId: ph.id },
        })
      }
    }
  }

  private async reassign(userId: string, workspaceId: string) {
    const ms = await this.sys.projectMember.findMany({ where: { userId, workspaceId, leftAt: null, role: { in: ['lead', 'co_supervisor'] } }, select: { projectId: true } })
    for (const m of ms) await this.health.recompute(this.sys, m.projectId)
  }

  /* --------------------------------- AI --------------------------------- */

  private leadToken(conn: { refreshTokenEnc: Uint8Array }) {
    return open(conn.refreshTokenEnc, this.env.tokenEncryptionKey).toString('utf8')
  }

  private async aiReview(job: Job, submissionId: string) {
    const sub = await this.sys.submission.findUnique({
      where: { id: submissionId },
      include: { files: true, phase: { include: { requirements: true } }, project: true },
    })
    if (!sub) throw new NonRetryable('submission no longer exists')
    if (sub.aiStatus === 'ready' || sub.aiStatus === 'disabled') return // already done: idempotent
    const wid = sub.workspaceId
    const settings = await this.sys.workspaceSettings.findUnique({ where: { workspaceId: wid } })
    const project = sub.project
    const wantStudent = project.aiStudentFeedback
    const wantSupervisor = project.aiSupervisorSummary
    const lead = await this.sys.projectMember.findFirst({ where: { projectId: project.id, role: 'lead', leftAt: null } })
    const coords = (await this.sys.projectMember.findMany({ where: { projectId: project.id, leftAt: null, role: { in: ['lead', 'co_supervisor'] } }, select: { userId: true } })).map((m) => m.userId)

    // Budget: checked before spending anything (architecture 7.2).
    const spent = await this.sys.aiUsage.aggregate({ where: { workspaceId: wid, createdAt: { gte: new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)) } }, _sum: { costUsd: true } })
    const budget = Number(settings?.aiMonthlyBudgetUsd ?? 0)
    if (!settings?.aiEnabled || Number(spent._sum.costUsd ?? 0) >= budget) {
      await this.sys.submission.update({ where: { id: sub.id }, data: { aiStatus: settings?.aiEnabled ? 'skipped_budget' : 'disabled' } })
      if (settings?.aiEnabled) {
        await this.activity.recordSystem(this.sys, wid, { id: project.id, departmentId: project.departmentId, facultyId: null }, { category: 'ai', action: `skipped AI review of v${sub.version} (monthly budget reached)`, targetType: 'submission', targetId: sub.id, targetLabel: project.title, phaseId: sub.phaseId, visibility: 'supervisors' })
        await this.notifications.notifyWith(this.sys, wid, coords, { kind: 'submissions', title: 'AI review skipped: monthly budget reached', body: project.title, link: `/projects/${project.id}` })
      }
      return
    }

    await this.sys.submission.update({ where: { id: sub.id }, data: { aiStatus: 'processing' } })

    // Files come from the Lead's Drive, are held in memory only, and are never written to disk.
    const inputs: AiInputFile[] = []
    const skipped: string[] = []
    const conn = lead ? await this.sys.googleDriveConnection.findUnique({ where: { userId: lead.userId } }) : null
    if (!conn || conn.status !== 'connected') throw new Error("Lead's Google Drive is not connected")
    const token = this.leadToken(conn)
    const MAX = 20 * 1024 * 1024
    for (const f of sub.files) {
      if (Number(f.sizeBytes) > MAX) { skipped.push(f.name); continue }
      const lower = f.name.toLowerCase()
      try {
        if (lower.endsWith('.pdf') || /\.(png|jpe?g)$/.test(lower)) {
          inputs.push({ name: f.name, mimeType: f.mimeType, data: await this.drive.download(token, f.driveFileId, MAX) })
        } else if (lower.endsWith('.docx')) {
          const t = await this.docs.docxText(await this.drive.download(token, f.driveFileId, MAX))
          if (t) inputs.push({ name: f.name, mimeType: f.mimeType, text: t.text })
          else skipped.push(f.name)
        } else if (/\.(txt|md|csv|py|js|ts|java|c|cpp|rs|go)$/.test(lower)) {
          inputs.push({ name: f.name, mimeType: 'text/plain', text: (await this.drive.download(token, f.driveFileId, 2 * 1024 * 1024)).toString('utf8').slice(0, 120_000) })
        } else skipped.push(f.name)
      } catch (e) {
        if (e instanceof DriveError && e.code === 'not_found') { skipped.push(f.name); continue }
        if (e instanceof DriveError && e.code === 'disconnected') {
          await this.sys.googleDriveConnection.update({ where: { userId: lead!.userId }, data: { status: 'error', error: 'Google access was revoked. Reconnect to continue.' } })
          throw new NonRetryable('Drive access revoked')
        }
        throw e
      }
    }
    if (inputs.length === 0) {
      await this.sys.submission.update({ where: { id: sub.id }, data: { aiStatus: 'failed' } })
      await this.sys.aiReview.upsert({ where: { workspaceId_submissionId: { workspaceId: wid, submissionId: sub.id } }, create: { workspaceId: wid, projectId: project.id, submissionId: sub.id, error: 'No readable files' }, update: { error: 'No readable files' } })
      return
    }
    const prev = await this.sys.submission.findFirst({ where: { phaseId: sub.phaseId, version: sub.version - 1 }, include: { files: true } })

    let result
    try {
      result = await this.ai.review({
        projectTitle: project.title, phaseName: sub.phase.name, phaseBrief: sub.phase.description,
        criteria: sub.phase.requirements.map((r) => r.name), version: sub.version, files: inputs,
        previous: prev ? { version: prev.version, files: prev.files.map((f) => f.name) } : undefined,
        wantStudent, wantSupervisor,
      })
    } catch (e) {
      if (e instanceof AiPermanentError) throw new NonRetryable(e.message)
      throw e
    }

    const inPrice = Number(process.env.AI_PRICE_IN_PER_M ?? 0.3)
    const outPrice = Number(process.env.AI_PRICE_OUT_PER_M ?? 2.5)
    const cost = (result.usage.tokensIn * inPrice + result.usage.tokensOut * outPrice) / 1_000_000
    const leadDefaults = lead ? merge(DEFAULT_SUPERVISION, (await this.sys.user.findUnique({ where: { id: lead.userId }, select: { supervisionDefaults: true } }))?.supervisionDefaults) : DEFAULT_SUPERVISION
    const release = (leadDefaults as typeof DEFAULT_SUPERVISION).aiRelease === 'immediate'

    // One transaction: result, metering and status commit together; the unique
    // jobId on ai_usage makes a second run of the same job a harmless no-op.
    await this.sys.$transaction(async (tx) => {
      await tx.aiReview.upsert({
        where: { workspaceId_submissionId: { workspaceId: wid, submissionId: sub.id } },
        create: { workspaceId: wid, projectId: project.id, submissionId: sub.id, studentFeedback: (result.studentFeedback ?? undefined) as Prisma.InputJsonValue | undefined, supervisorSummary: (result.supervisorSummary ?? undefined) as Prisma.InputJsonValue | undefined, model: result.usage.model },
        update: { studentFeedback: (result.studentFeedback ?? undefined) as Prisma.InputJsonValue | undefined, supervisorSummary: (result.supervisorSummary ?? undefined) as Prisma.InputJsonValue | undefined, model: result.usage.model, error: null },
      })
      await tx.$executeRaw`INSERT INTO ai_usage (workspace_id, project_id, submission_id, model, tokens_in, tokens_out, cost_usd, job_id)
        VALUES (${wid}::uuid, ${project.id}::uuid, ${sub.id}::uuid, ${result.usage.model}, ${result.usage.tokensIn}, ${result.usage.tokensOut}, ${cost}::numeric, ${job.id}::uuid) ON CONFLICT (job_id) DO NOTHING`
      await tx.submission.update({ where: { id: sub.id }, data: { aiStatus: 'ready', ...(release && wantStudent ? { aiReleased: true } : {}) } })
      await this.activity.recordSystem(tx, wid, { id: project.id, departmentId: project.departmentId, facultyId: null }, {
        category: 'ai', action: `AI feedback is ready for v${sub.version}${skipped.length ? ` (${skipped.length} file(s) not readable)` : ''}`,
        targetType: 'submission', targetId: sub.id, targetLabel: project.title, phaseId: sub.phaseId, visibility: 'supervisors',
      })
      await this.notifications.notifyWith(tx, wid, coords, { kind: 'submissions', title: `AI summary ready for v${sub.version}`, body: project.title, link: `/projects/${project.id}` })
      if (release && wantStudent) {
        const students = await tx.projectMember.findMany({ where: { projectId: project.id, leftAt: null, role: 'student' }, select: { userId: true } })
        await this.notifications.notifyWith(tx, wid, students.map((s) => s.userId), { kind: 'reviews', title: 'AI feedback is ready', body: project.title, link: `/projects/${project.id}` })
      }
    })
  }

  /* -------------------------------- Drive -------------------------------- */

  private async tokenForProject(projectId: string) {
    const lead = await this.sys.projectMember.findFirst({ where: { projectId, role: 'lead', leftAt: null } })
    const conn = lead ? await this.sys.googleDriveConnection.findUnique({ where: { userId: lead.userId } }) : null
    return lead && conn && conn.status === 'connected' ? { token: this.leadToken(conn), leadId: lead.userId } : null
  }

  private async driveSync(projectId: string) {
    const project = await this.sys.project.findUnique({ where: { id: projectId }, include: { members: { where: { leftAt: null } } } })
    if (!project?.driveFolderId) return // folder is created on the first upload; permissions follow then
    const auth = await this.tokenForProject(projectId)
    if (!auth) return
    const users = await this.sys.user.findMany({ where: { id: { in: project.members.map((m) => m.userId) } }, select: { id: true, email: true } })
    const email = new Map(users.map((u) => [u.id, u.email]))
    const emails = (role: string) => project.members.filter((m) => m.role === role).map((m) => email.get(m.userId)!).filter(Boolean)
    try {
      await this.drive.syncPermissions(auth.token, project.driveFolderId, { writers: emails('co_supervisor'), readers: emails('student') })
    } catch (e) {
      if (e instanceof DriveError && e.code === 'disconnected') {
        await this.sys.googleDriveConnection.update({ where: { userId: auth.leadId }, data: { status: 'error', error: 'Google access was revoked. Reconnect to continue.' } })
        await this.notifications.notifyWith(this.sys, project.workspaceId, [auth.leadId], { kind: 'escalations', title: 'Google Drive disconnected', body: 'Reconnect it so students can keep uploading.', link: '/settings/integrations' })
        return
      }
      throw e
    }
  }

  private async driveDelete(projectId: string, driveFileId: string) {
    const auth = await this.tokenForProject(projectId)
    if (!auth) return
    try {
      await this.drive.deleteFile(auth.token, driveFileId)
    } catch (e) {
      if (e instanceof DriveError && (e.code === 'not_found' || e.code === 'disconnected')) return
      throw e
    }
  }

  /** Nightly: files a supervisor deleted in Drive are flagged, history stays intact. */
  private async driveVerify() {
    const files = await this.sys.submissionFile.findMany({
      where: { missingInDrive: false, uploadedAt: { gte: new Date(Date.now() - 30 * DAY) } },
      include: { submission: { select: { projectId: true, version: true, phaseId: true, project: { select: { title: true, workspaceId: true, departmentId: true } } } } },
      orderBy: { id: 'asc' },
      take: 300,
    })
    const tokens = new Map<string, Awaited<ReturnType<Handlers['tokenForProject']>>>()
    for (const f of files) {
      const pid = f.submission.projectId
      if (!tokens.has(pid)) tokens.set(pid, await this.tokenForProject(pid))
      const auth = tokens.get(pid)
      if (!auth) continue
      let info
      try {
        info = await this.drive.getFile(auth.token, f.driveFileId)
      } catch (e) {
        if (e instanceof DriveError) continue
        throw e
      }
      if (info) continue
      await this.sys.submissionFile.update({ where: { id: f.id }, data: { missingInDrive: true } })
      await this.activity.recordSystem(this.sys, f.workspaceId, { id: pid, departmentId: f.submission.project.departmentId, facultyId: null }, {
        category: 'drive', action: `file “${f.name}” (v${f.submission.version}) is missing in Google Drive`, targetType: 'submission', targetId: f.submissionId, targetLabel: f.submission.project.title, phaseId: f.submission.phaseId, visibility: 'supervisors',
      })
    }
  }

  /* ------------------------------ housekeeping ------------------------------ */

  /** Expired tokens, revoked sessions, spent keys, old read notifications, finished jobs. */
  private async cleanup() {
    const del = (sql: Prisma.Sql) => this.sys.$executeRaw(sql)
    await del(Prisma.sql`DELETE FROM refresh_tokens WHERE expires_at < now() - interval '1 day'`)
    await del(Prisma.sql`DELETE FROM sessions WHERE revoked_at < now() - interval '30 days'`)
    await del(Prisma.sql`DELETE FROM auth_tokens WHERE expires_at < now() - interval '7 days'`)
    await del(Prisma.sql`DELETE FROM idempotency_keys WHERE expires_at < now()`)
    await del(Prisma.sql`DELETE FROM notifications WHERE read_at < now() - interval '90 days'`)
    await del(Prisma.sql`DELETE FROM jobs WHERE status = 'succeeded' AND finished_at < now() - interval '14 days'`)
    await del(Prisma.sql`UPDATE invites SET status = 'revoked' WHERE status = 'pending' AND expires_at < now() - interval '30 days'`)
  }

  /** Deletion requests older than 14 days become anonymised accounts. History keeps names as snapshots only until retention removes them. */
  private async purgeUsers() {
    const cutoff = new Date(Date.now() - 14 * DAY)
    const users = await this.sys.user.findMany({ where: { deletionRequestedAt: { lte: cutoff }, status: 'active' }, select: { id: true }, take: 50 })
    for (const u of users) {
      await this.sys.$transaction(async (tx) => {
        await tx.session.updateMany({ where: { userId: u.id, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: 'account_deleted' } })
        await tx.googleDriveConnection.deleteMany({ where: { userId: u.id } })
        await tx.projectMember.updateMany({ where: { userId: u.id, leftAt: null }, data: { leftAt: new Date(), leftReason: 'account_deleted', isGroupLeader: false, isSuccessor: false } })
        await tx.membership.updateMany({ where: { userId: u.id }, data: { status: 'deactivated' } })
        await tx.notification.deleteMany({ where: { userId: u.id } })
        await tx.user.update({
          where: { id: u.id },
          data: { status: 'deactivated', name: 'Deleted user', email: `deleted+${u.id}@invalid.example`, passwordHash: null, avatarUrl: null, phone: '', title: '', profile: {}, notificationPrefs: {}, preferences: {}, supervisionDefaults: {}, deletionReason: null },
        })
      })
    }
  }

  private async dataExport(userId: string) {
    const u = await this.sys.user.findUnique({ where: { id: userId } })
    if (!u || u.status !== 'active') return
    const [memberships, comments, logs, subs] = await Promise.all([
      this.sys.membership.findMany({ where: { userId }, include: { roles: true, workspace: { select: { name: true } } } }),
      this.sys.comment.findMany({ where: { authorId: userId, supervisorsOnly: false }, select: { body: true, createdAt: true, projectId: true }, take: 5000 }),
      this.sys.timeLog.findMany({ where: { userId }, select: { kind: true, hours: true, note: true, date: true, projectId: true }, take: 5000 }),
      this.sys.submission.findMany({ where: { submittedById: userId }, select: { version: true, submittedAt: true, note: true, phaseId: true, projectId: true }, take: 5000 }),
    ])
    const doc = {
      exportedAt: new Date().toISOString(),
      account: { id: u.id, name: u.name, email: u.email, title: u.title, phone: u.phone, profile: u.profile, createdAt: u.createdAt },
      memberships: memberships.map((m) => ({ workspace: m.workspace.name, status: m.status, roles: m.roles.map((r) => r.role) })),
      comments, timeLogs: logs, submissions: subs,
    }
    await this.jobs.email(u.email, 'data_export_ready', { name: u.name, attachment: { filename: 'project-n-export.json', content: JSON.stringify(doc, null, 2) } }, {}, this.sys)
  }
}
