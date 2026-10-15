import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common'
import Redis from 'ioredis'
import { ENV, Env } from '../config/env'

/**
 * Small key-value port used for rate limits, caches and session revocation.
 * Redis in any multi-instance deployment; an in-process Map for single
 * instance development, tests and the free demo (documented trade-off).
 */
export interface Kv {
  readonly kind: 'redis' | 'memory'
  incr(key: string, ttlSec: number): Promise<number>
  get(key: string): Promise<string | null>
  set(key: string, value: string, ttlSec: number): Promise<void>
  del(...keys: string[]): Promise<void>
  ping(): Promise<boolean>
}

export class MemoryKv implements Kv {
  readonly kind = 'memory' as const
  private m = new Map<string, { v: string; exp: number }>()
  private live(k: string) {
    const e = this.m.get(k)
    if (!e) return undefined
    if (e.exp <= Date.now()) {
      this.m.delete(k)
      return undefined
    }
    return e
  }
  async incr(key: string, ttlSec: number) {
    const e = this.live(key)
    if (!e) {
      this.m.set(key, { v: '1', exp: Date.now() + ttlSec * 1000 })
      this.gc()
      return 1
    }
    e.v = String(Number(e.v) + 1)
    return Number(e.v)
  }
  async get(key: string) {
    return this.live(key)?.v ?? null
  }
  async set(key: string, value: string, ttlSec: number) {
    this.m.set(key, { v: value, exp: Date.now() + ttlSec * 1000 })
    this.gc()
  }
  async del(...keys: string[]) {
    keys.forEach((k) => this.m.delete(k))
  }
  async ping() {
    return true
  }
  private gc() {
    if (this.m.size < 50_000) return
    const now = Date.now()
    for (const [k, e] of this.m) if (e.exp <= now) this.m.delete(k)
  }
}

export class RedisKv implements Kv {
  readonly kind = 'redis' as const
  constructor(private r: Redis) {}
  async incr(key: string, ttlSec: number) {
    const res = await this.r.multi().incr(key).expire(key, ttlSec, 'NX').exec()
    return Number(res?.[0]?.[1] ?? 0)
  }
  get(key: string) {
    return this.r.get(key)
  }
  async set(key: string, value: string, ttlSec: number) {
    await this.r.set(key, value, 'EX', ttlSec)
  }
  async del(...keys: string[]) {
    if (keys.length) await this.r.del(...keys)
  }
  async ping() {
    return (await this.r.ping()) === 'PONG'
  }
}

@Injectable()
export class KvService implements OnModuleDestroy {
  private readonly log = new Logger('Kv')
  readonly kv: Kv
  private redis?: Redis

  constructor(@Inject(ENV) env: Env) {
    if (env.redisUrl) {
      this.redis = new Redis(env.redisUrl, { maxRetriesPerRequest: 2, enableOfflineQueue: false })
      this.redis.on('error', (e) => this.log.warn(`redis error: ${e.message}`))
      this.kv = new RedisKv(this.redis)
    } else {
      this.kv = new MemoryKv()
    }
  }

  async onModuleDestroy() {
    await this.redis?.quit().catch(() => undefined)
  }
}
