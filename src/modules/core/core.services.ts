import { Inject, Injectable } from '@nestjs/common'
import { ActivityCategory, ActivityVisibility, Prisma } from '@prisma/client'
import { Caller } from '../../authz/caller'
import { actingRoleLabel, ProjectFacts } from '../../authz/policy'
import { sealJson } from '../../common/crypto'
import { requestMeta } from '../../common/request-meta'
import { ENV, Env } from '../../config/env'
import { Db } from '../../infra/db'

/** Anything with the `job` delegate: the request transaction or the system client. */
type JobWriter = { job: Prisma.TransactionClient['job'] }

export interface EnqueueOptions {
  runAt?: Date
  /** Enqueueing the same key twice is a no-op (safe to call from retried code). */
  dedupeKey?: string
  workspaceId?: string | null
  maxAttempts?: number
}

/**
 * Durable job queue (transactional outbox). `enqueue` writes inside the
 * caller's transaction, so a job exists if and only if the change that
 * caused it committed.
 */
@Injectable()
export class JobsService {
  constructor(
    private db: Db,
    @Inject(ENV) private env: Env
  ) {}

  async enqueue(kind: string, payload: Record<string, unknown>, opts: EnqueueOptions = {}, w?: JobWriter) {
    const client = w ?? this.db.tx
    const data = {
      kind,
      payload: payload as Prisma.InputJsonValue,
      runAt: opts.runAt ?? new Date(),
      workspaceId: opts.workspaceId ?? (this.db.active ? this.db.ctx.workspaceId : null) ?? null,
      maxAttempts: opts.maxAttempts ?? 5,
      dedupeKey: opts.dedupeKey ?? null,
    }
    if (opts.dedupeKey) {
      // The app role may INSERT but not UPDATE jobs, so use ON CONFLICT DO NOTHING.
      await (client as Prisma.TransactionClient).$executeRaw`
        INSERT INTO jobs (kind, payload, run_at, workspace_id, max_attempts, dedupe_key)
        VALUES (${data.kind}, ${JSON.stringify(data.payload)}::jsonb, ${data.runAt}, ${data.workspaceId}::uuid, ${data.maxAttempts}, ${data.dedupeKey})
        ON CONFLICT (dedupe_key) DO NOTHING`
      return
    }
    // createMany: no RETURNING, so INSERT alone suffices (the auth role has no SELECT on jobs).
    await client.job.createMany({ data: [data] })
  }

  /** Recompute at most once a minute per project (idempotent job). */
  healthRecompute(projectId: string, w?: JobWriter) {
    return this.enqueue('health.recompute', { projectId }, { dedupeKey: `health:${projectId}:${Math.floor(Date.now() / 60_000)}` }, w)
  }

  /** E-mail data is encrypted in the queue: it can contain one-time links. */
  email(to: string, template: EmailTemplate, data: Record<string, unknown>, opts: EnqueueOptions = {}, w?: JobWriter) {
    return this.enqueue('email.send', { to, template, sealed: sealJson(data, this.env.tokenEncryptionKey) }, opts, w)
  }
}

export type EmailTemplate =
  | 'verify_email'
  | 'reset_password'
  | 'password_changed'
  | 'account_exists'
  | 'invite'
  | 'change_email'
  | 'notification'
  | 'account_locked'
  | 'data_export_ready'

@Injectable()
export class AuditService {
  constructor(private db: Db) {}

  /** Security / admin record: sign-ins, resets, session revocations, role changes. */
  async log(
    action: string,
    p: { actorId?: string | null; workspaceId?: string | null; targetType?: string; targetId?: string; data?: Record<string, unknown> } = {}
  ) {
    const m = requestMeta()
    // createMany: no RETURNING, so the row need not be readable by the writer.
    await this.db.tx.auditLog.createMany({
      data: [{
        action,
        actorId: p.actorId ?? null,
        workspaceId: p.workspaceId ?? (this.db.ctx.workspaceId || null),
        targetType: p.targetType,
        targetId: p.targetId,
        ip: m.ip,
        userAgent: m.userAgent,
        data: { ...p.data, requestId: m.requestId } as Prisma.InputJsonValue,
      }],
    })
  }
}

export interface ActivityInput {
  category: ActivityCategory
  action: string
  targetType?: string
  targetId?: string
  targetLabel?: string
  phaseId?: string
  before?: string | null
  after?: string | null
  reason?: string | null
  isOverride?: boolean
  visibility?: ActivityVisibility
}

/**
 * User-facing, append-only history (architecture 10.3). Written in the same
 * transaction as the change, with snapshots (names, labels) so the entry
 * stays readable after renames or removals.
 */
@Injectable()
export class ActivityService {
  constructor(private db: Db) {}

  async record(caller: Caller, project: (Pick<ProjectFacts, 'id' | 'departmentId' | 'facultyId'> & Partial<ProjectFacts>) | null, e: ActivityInput) {
    const role = project && project.members ? actingRoleLabel(caller, project as ProjectFacts) : 'Member'
    await this.db.tx.activityLog.createMany({
      data: [{
        workspaceId: caller.workspaceId!,
        facultyId: project?.facultyId ?? null,
        departmentId: project?.departmentId ?? null,
        projectId: project?.id ?? null,
        phaseId: e.phaseId,
        actorId: caller.userId,
        actorName: caller.name,
        actingRole: role,
        category: e.category,
        action: e.action,
        targetType: e.targetType,
        targetId: e.targetId,
        targetLabel: e.targetLabel ?? '',
        before: e.before ?? null,
        after: e.after ?? null,
        reason: e.reason ?? null,
        isOverride: e.isOverride ?? false,
        visibility: e.visibility ?? 'all',
      }],
    })
  }

  /** Entries written by the system (health changes, reminders, jobs). */
  async recordSystem(
    w: Pick<Prisma.TransactionClient, 'activityLog'>,
    workspaceId: string,
    project: { id: string; departmentId: string | null; facultyId: string | null },
    e: ActivityInput
  ) {
    await w.activityLog.createMany({
      data: [{
        workspaceId,
        facultyId: project.facultyId,
        departmentId: project.departmentId,
        projectId: project.id,
        phaseId: e.phaseId,
        actorId: null,
        actorName: 'System',
        actingRole: 'System',
        category: e.category,
        action: e.action,
        targetType: e.targetType,
        targetId: e.targetId,
        targetLabel: e.targetLabel ?? '',
        before: e.before ?? null,
        after: e.after ?? null,
        reason: e.reason ?? null,
        isOverride: false,
        visibility: e.visibility ?? 'all',
      }],
    })
  }
}

export interface NotifyInput {
  kind: string
  title: string
  body?: string
  link?: string
  data?: Record<string, unknown>
}

@Injectable()
export class NotificationService {
  constructor(
    private db: Db,
    private jobs: JobsService
  ) {}

  /** Same as notify(), for workers that run without a request transaction. */
  async notifyWith(w: Pick<Prisma.TransactionClient, 'notification' | 'job'>, workspaceId: string, userIds: string[], n: NotifyInput) {
    const targets = [...new Set(userIds)]
    if (targets.length === 0) return
    await w.notification.createMany({
      data: targets.map((userId) => ({ userId, workspaceId, kind: n.kind, title: n.title, body: n.body ?? '', link: n.link, data: (n.data ?? {}) as Prisma.InputJsonValue })),
    })
    await this.jobs.enqueue('notify.email', { userIds: targets, ...n, workspaceId }, { workspaceId }, w)
  }

  /** In-app notifications always; e-mail follows each user's preferences (worker). */
  async notify(userIds: string[], n: NotifyInput, opts: { exclude?: string } = {}) {
    const targets = [...new Set(userIds)].filter((id) => id !== opts.exclude)
    if (targets.length === 0) return
    const workspaceId = this.db.ctx.workspaceId ?? null
    await this.db.tx.notification.createMany({
      data: targets.map((userId) => ({
        userId,
        workspaceId,
        kind: n.kind,
        title: n.title,
        body: n.body ?? '',
        link: n.link,
        data: (n.data ?? {}) as Prisma.InputJsonValue,
      })),
    })
    await this.jobs.enqueue('notify.email', { userIds: targets, ...n, workspaceId })
  }
}
