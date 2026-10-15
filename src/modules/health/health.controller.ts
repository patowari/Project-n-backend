import { Controller, Get, Headers, HttpCode, Inject, Res, ServiceUnavailableException } from '@nestjs/common'
import { ApiExcludeController } from '@nestjs/swagger'
import type { Response } from 'express'
import { Public } from '../../common/http'
import { ENV, Env } from '../../config/env'
import { jobsGauge, registry } from '../../common/metrics'
import { PrismaService } from '../../infra/prisma.service'
import { KvService } from '../../infra/kv'

@ApiExcludeController()
@Public()
@Controller()
export class HealthController {
  constructor(
    private prisma: PrismaService,
    private kvs: KvService,
    @Inject(ENV) private env: Env
  ) {}

  /** Liveness: the process answers. Deliberately no database query (lets a sleeping DB stay asleep). */
  @Get('healthz')
  live() {
    return { status: 'ok' }
  }

  /** Readiness: database and cache reachable. */
  @Get('readyz')
  async ready() {
    try {
      await this.prisma.$queryRaw`SELECT 1`
      if (!(await this.kvs.kv.ping())) throw new Error('kv')
    } catch {
      throw new ServiceUnavailableException({ status: 'unavailable' })
    }
    return { status: 'ready', cache: this.kvs.kv.kind }
  }

  /** Prometheus scrape. Protected by METRICS_TOKEN when set. */
  @Get('metrics')
  @HttpCode(200)
  async metrics(@Headers('authorization') auth: string | undefined, @Res() res: Response) {
    const token = process.env.METRICS_TOKEN
    if (token && auth !== `Bearer ${token}`) {
      res.status(401).json({ code: 'unauthenticated' })
      return
    }
    try {
      const rows = await this.prisma.$queryRaw<{ status: string; n: bigint }[]>`SELECT status::text, count(*) AS n FROM jobs GROUP BY status`
      jobsGauge.reset()
      for (const r of rows) jobsGauge.set({ status: r.status }, Number(r.n))
    } catch {
      /* metrics must never fail the scrape */
    }
    res.setHeader('Content-Type', registry.contentType)
    res.send(await registry.metrics())
  }
}
