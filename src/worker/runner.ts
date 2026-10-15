import { randomUUID } from 'node:crypto'
import { Inject, Injectable, Logger } from '@nestjs/common'
import { Job, Prisma } from '@prisma/client'
import { ENV, Env } from '../config/env'
import { SystemPrismaService } from '../infra/prisma.service'
import { Handlers, NonRetryable } from './handlers'

/** 1 min, 5 min, 30 min, 2 h, then 6 h (architecture 9). */
export const BACKOFF_MS = [60_000, 300_000, 1_800_000, 7_200_000, 21_600_000]
/** A job still "running" after this long belonged to a crashed worker. */
export const LOCK_TIMEOUT_SEC = 300

export interface RunnerOptions {
  concurrency?: number
  pollMs?: number
}

/**
 * Durable queue on PostgreSQL (transactional outbox).
 *
 *   enqueue  INSERT inside the same transaction as the business change
 *   claim    UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED)
 *   finish   succeeded | queued again with backoff | dead (visible to Super Admin)
 *
 * Delivery is AT LEAST ONCE: a worker can die after doing the work and before
 * recording it. Every handler is therefore idempotent (dedupe keys, unique
 * constraints, provider idempotency keys, "already done" checks).
 */
@Injectable()
export class JobRunner {
  private readonly log = new Logger('Jobs')
  readonly workerId = `w-${randomUUID().slice(0, 8)}`
  private running = false
  private loop?: Promise<void>
  private timer?: NodeJS.Timeout

  constructor(
    private sys: SystemPrismaService,
    private handlers: Handlers,
    @Inject(ENV) private env: Env
  ) {}

  /** Claim up to `limit` due jobs. Safe to call from many workers at once. */
  async claim(limit: number): Promise<Job[]> {
    // Give up on crash loops first: a job that keeps killing its worker must not run forever.
    await this.sys.$executeRaw`
      UPDATE jobs SET status = 'dead', last_error = 'worker crashed repeatedly', finished_at = now()
      WHERE status = 'running' AND locked_at < now() - make_interval(secs => ${LOCK_TIMEOUT_SEC}) AND attempts >= max_attempts`
    const rows = await this.sys.$queryRaw<
      { id: string; kind: string; payload: Prisma.JsonValue; workspace_id: string | null; run_at: Date; attempts: number; max_attempts: number; status: Job['status']; locked_at: Date | null; locked_by: string | null; last_error: string | null; dedupe_key: string | null; created_at: Date; finished_at: Date | null }[]
    >`
      UPDATE jobs SET status = 'running', locked_at = now(), locked_by = ${this.workerId}, attempts = attempts + 1
      WHERE id IN (
        SELECT id FROM jobs
        WHERE (status = 'queued' AND run_at <= now())
           OR (status = 'running' AND locked_at < now() - make_interval(secs => ${LOCK_TIMEOUT_SEC}))
        ORDER BY run_at
        FOR UPDATE SKIP LOCKED
        LIMIT ${limit})
      RETURNING *`
    return rows.map((r) => ({
      id: r.id, kind: r.kind, payload: r.payload, workspaceId: r.workspace_id, runAt: r.run_at, attempts: r.attempts, maxAttempts: r.max_attempts,
      status: r.status, lockedAt: r.locked_at, lockedBy: r.locked_by, lastError: r.last_error, dedupeKey: r.dedupe_key, createdAt: r.created_at, finishedAt: r.finished_at,
    }))
  }

  async execute(job: Job): Promise<'succeeded' | 'retry' | 'dead'> {
    try {
      await this.handlers.run(job)
      const scrub = job.kind === 'email.send' ? { payload: { template: (job.payload as { template?: string })?.template ?? '' } } : {}
      await this.sys.job.update({ where: { id: job.id }, data: { status: 'succeeded', finishedAt: new Date(), lastError: null, lockedAt: null, lockedBy: null, ...scrub } })
      return 'succeeded'
    } catch (e) {
      const message = (e instanceof Error ? e.message : String(e)).slice(0, 500)
      const permanent = e instanceof NonRetryable
      if (permanent || job.attempts >= job.maxAttempts) {
        await this.sys.job.update({ where: { id: job.id }, data: { status: 'dead', lastError: message, finishedAt: new Date(), lockedAt: null, lockedBy: null } })
        await this.handlers.onDead(job, message).catch((err) => this.log.error(`onDead(${job.kind}) failed: ${err}`))
        this.log.error(`job ${job.kind} ${job.id} is dead: ${message}`)
        return 'dead'
      }
      const delay = BACKOFF_MS[Math.min(job.attempts - 1, BACKOFF_MS.length - 1)]
      await this.sys.job.update({ where: { id: job.id }, data: { status: 'queued', runAt: new Date(Date.now() + delay), lastError: message, lockedAt: null, lockedBy: null } })
      this.log.warn(`job ${job.kind} ${job.id} failed (attempt ${job.attempts}/${job.maxAttempts}), retry in ${Math.round(delay / 1000)}s: ${message}`)
      return 'retry'
    }
  }

  /** Claim and run once. Returns how many jobs ran. */
  async runOnce(limit = 10): Promise<number> {
    const jobs = await this.claim(limit)
    await Promise.all(jobs.map((j) => this.execute(j)))
    return jobs.length
  }

  /** Run until nothing is due (tests, one-shot `worker --drain`). */
  async drain(maxRounds = 50): Promise<number> {
    let total = 0
    for (let i = 0; i < maxRounds; i++) {
      const n = await this.runOnce(20)
      if (n === 0) break
      total += n
    }
    return total
  }

  /** Enqueue the periodic jobs. Dedupe keys make this safe on every worker, every minute. */
  async schedule(now = new Date()): Promise<void> {
    const hour = now.toISOString().slice(0, 13)
    const date = now.toISOString().slice(0, 10)
    const periodic: [string, string][] = [
      ['health.sweep', `sched:health.sweep:${hour}`],
      ['reminders.deadlines', `sched:reminders:${hour}`],
      ['digest.send', `sched:digest:${hour}`],
      ['users.purge', `sched:purge:${hour}`],
      ['sessions.cleanup', `sched:cleanup:${date}`],
      ['drive.verify_files', `sched:verify:${date}`],
    ]
    for (const [kind, key] of periodic) {
      await this.sys.$executeRaw`INSERT INTO jobs (kind, dedupe_key, max_attempts) VALUES (${kind}, ${key}, 3) ON CONFLICT (dedupe_key) DO NOTHING`
    }
  }

  start(opts: RunnerOptions = {}) {
    if (this.running) return
    this.running = true
    const concurrency = opts.concurrency ?? Number(process.env.WORKER_CONCURRENCY ?? 4)
    const pollMs = opts.pollMs ?? 1000
    let lastSchedule = 0
    this.loop = (async () => {
      let idle = 0
      while (this.running) {
        try {
          if (Date.now() - lastSchedule > 60_000) {
            lastSchedule = Date.now()
            await this.schedule()
          }
          const n = await this.runOnce(concurrency)
          idle = n === 0 ? Math.min(idle + 1, 5) : 0
          if (n === 0) await new Promise<void>((r) => (this.timer = setTimeout(r, pollMs * idle + Math.random() * 250)))
        } catch (e) {
          this.log.error(`runner loop error: ${e instanceof Error ? e.message : e}`)
          await new Promise<void>((r) => (this.timer = setTimeout(r, 5000)))
        }
      }
    })()
    this.log.log(`worker ${this.workerId} started (concurrency ${concurrency})`)
  }

  async stop() {
    this.running = false
    if (this.timer) clearTimeout(this.timer)
    await this.loop
  }
}
