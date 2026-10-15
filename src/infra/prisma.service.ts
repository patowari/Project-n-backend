import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common'
import { PrismaClient } from '@prisma/client'
import { ENV, Env } from '../config/env'
import { dbQueries, dbQuerySeconds } from '../common/metrics'

/** API connection: the `projectn_app` role. Row Level Security applies. */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  private readonly log = new Logger('Prisma')
  constructor(@Inject(ENV) env: Env) {
    const metrics = process.env.DB_QUERY_METRICS === 'true'
    super({
      datasources: { db: { url: env.databaseUrl } },
      log: metrics ? [{ emit: 'event', level: 'query' }, 'warn', 'error'] : ['warn', 'error'],
    })
    if (metrics) {
      ;(this as unknown as { $on: (e: 'query', cb: (q: { duration: number }) => void) => void }).$on('query', (q) => {
        dbQueries.inc()
        dbQuerySeconds.observe(q.duration / 1000)
      })
    }
  }

  /**
   * Refuse to run as a role that would silently bypass Row Level Security
   * (superuser, BYPASSRLS, or the table owner).
   */
  async assertRlsEnforced(): Promise<void> {
    const rows = await this.$queryRaw<{ rolsuper: boolean; rolbypassrls: boolean; owner: boolean }[]>`
      SELECT r.rolsuper, r.rolbypassrls,
             EXISTS (SELECT 1 FROM pg_class c WHERE c.relname = 'projects' AND c.relowner = r.oid) AS owner
      FROM pg_roles r WHERE r.rolname = current_user`
    const r = rows[0]
    if (!r || r.rolsuper || r.rolbypassrls || r.owner) {
      throw new Error(
        'DATABASE_URL must use the restricted app role (not a superuser, BYPASSRLS role or table owner); otherwise Row Level Security would not apply.'
      )
    }
    const enc = await this.$queryRaw<{ server_encoding: string }[]>`SHOW server_encoding`
    if (enc[0]?.server_encoding !== 'UTF8') {
      throw new Error(`The database encoding is ${enc[0]?.server_encoding}; Project N requires UTF8 (text such as names and comments would be rejected).`)
    }
    this.log.log('database role verified: RLS is enforced for this connection')
  }

  async onModuleDestroy() {
    await this.$disconnect()
  }
}

/**
 * System connection: `projectn_system` (BYPASSRLS). Only workers and the
 * Super Admin module may inject this. It never serves tenant requests.
 */
@Injectable()
export class SystemPrismaService extends PrismaClient implements OnModuleDestroy {
  constructor(@Inject(ENV) env: Env) {
    super({ datasources: { db: { url: env.databaseSystemUrl } }, log: ['warn', 'error'] })
  }
  async onModuleDestroy() {
    await this.$disconnect()
  }
}
