import { AsyncLocalStorage } from 'node:async_hooks'
import { Injectable } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { PrismaService } from './prisma.service'

export type Tx = Prisma.TransactionClient

export interface DbCtx {
  workspaceId?: string | null
  userId?: string | null
  /** Auth module only (login, sign-up, invite acceptance): no user yet. */
  authMode?: boolean
}

interface Store {
  tx: Tx
  ctx: DbCtx
}
const als = new AsyncLocalStorage<Store>()

/**
 * Every tenant-scoped query runs inside ONE transaction that first sets the
 * transaction-local settings the RLS policies read:
 *
 *   SELECT set_config('app.workspace_id', $1, true), ...   -- true = SET LOCAL
 *
 * Transaction-local settings are discarded at COMMIT/ROLLBACK, so they cannot
 * leak to the next request on a pooled connection.
 */
@Injectable()
export class Db {
  constructor(readonly prisma: PrismaService) {}

  /** The current transaction. Throws outside `run`, which is a bug. */
  get tx(): Tx {
    const s = als.getStore()
    if (!s) throw new Error('Database access outside a tenant transaction')
    return s.tx
  }

  get ctx(): DbCtx {
    const s = als.getStore()
    if (!s) throw new Error('Database access outside a tenant transaction')
    return s.ctx
  }

  get active(): boolean {
    return !!als.getStore()
  }

  async run<T>(ctx: DbCtx, fn: () => Promise<T>, opts?: { retries?: number; timeoutMs?: number }): Promise<T> {
    const existing = als.getStore()
    if (existing) {
      const a = existing.ctx
      if (a.workspaceId === ctx.workspaceId && a.userId === ctx.userId && !!a.authMode === !!ctx.authMode) {
        return fn()
      }
      throw new Error('Nested transaction with a different tenant context')
    }
    const attempts = (opts?.retries ?? 0) + 1
    for (let i = 1; ; i++) {
      try {
        return await this.prisma.$transaction(
          async (tx) => {
            await tx.$queryRaw`SELECT
              set_config('app.workspace_id', ${ctx.workspaceId ?? ''}, true),
              set_config('app.user_id', ${ctx.userId ?? ''}, true)`
            // Pre-tenant work (sign-up, login, invitations) assumes the narrowly granted auth role.
            if (ctx.authMode) await tx.$executeRawUnsafe('SET LOCAL ROLE projectn_auth')
            return als.run({ tx, ctx }, fn)
          },
          { timeout: opts?.timeoutMs ?? 20_000, maxWait: 5_000 }
        )
      } catch (e) {
        // Deadlock / serialization failure: retry the WHOLE unit of work.
        const err = e as { code?: string; meta?: { code?: string } }
        const retryable = err.code === 'P2034' || err.meta?.code === '40P01' || err.meta?.code === '40001'
        if (!retryable || i >= attempts) throw e
        await new Promise((r) => setTimeout(r, 25 * i + Math.random() * 25))
      }
    }
  }

  /** Auth module work. Inside a request transaction this elevates in place. */
  asAuth<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active) return this.withAuthMode(fn)
    return this.run({ authMode: true }, fn)
  }

  /** Temporarily assume the auth role (identity + membership tables only). */
  async withAuthMode<T>(fn: () => Promise<T>): Promise<T> {
    const s = als.getStore()
    if (!s) throw new Error('Database access outside a tenant transaction')
    if (s.ctx.authMode) return fn()
    await s.tx.$executeRawUnsafe('SET LOCAL ROLE projectn_auth')
    s.ctx.authMode = true
    try {
      return await fn()
    } finally {
      // If the transaction is already aborted this fails; the rollback discards the role anyway.
      await s.tx.$executeRawUnsafe('RESET ROLE').catch(() => undefined)
      s.ctx.authMode = false
    }
  }

  /** Point the transaction at another workspace (sign-up just created one). */
  async setWorkspace(workspaceId: string): Promise<void> {
    const s = als.getStore()
    if (!s) throw new Error('Database access outside a tenant transaction')
    await s.tx.$queryRaw`SELECT set_config('app.workspace_id', ${workspaceId}, true)`
    s.ctx.workspaceId = workspaceId
  }

  /** Run `fn` against another workspace, then restore the request's own context. */
  async inWorkspace<T>(workspaceId: string, fn: () => Promise<T>): Promise<T> {
    const s = als.getStore()
    if (!s) throw new Error('Database access outside a tenant transaction')
    const prev = s.ctx.workspaceId ?? ''
    await this.setWorkspace(workspaceId)
    try {
      return await fn()
    } finally {
      await s.tx.$queryRaw`SELECT set_config('app.workspace_id', ${prev}, true)`
      s.ctx.workspaceId = prev || null
    }
  }

  setUser(userId: string): Promise<void> {
    const s = als.getStore()
    if (!s) throw new Error('Database access outside a tenant transaction')
    s.ctx.userId = userId
    return s.tx.$queryRaw`SELECT set_config('app.user_id', ${userId}, true)`.then(() => undefined)
  }

  /** Row lock for check-then-act sequences (one statement, one winner). */
  async lock(table: 'projects' | 'phases' | 'submissions' | 'extension_requests', id: string): Promise<void> {
    const rows = await this.tx.$queryRawUnsafe<{ id: string }[]>(
      `SELECT id FROM ${table} WHERE id = $1::uuid FOR UPDATE`,
      id
    )
    if (rows.length === 0) throw new RowNotVisible(table, id)
  }
}

/** Raised when a row is missing OR hidden by RLS: callers answer 404. */
export class RowNotVisible extends Error {
  constructor(
    readonly table: string,
    readonly id: string
  ) {
    super(`${table} ${id} not found`)
  }
}
