import { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { PrismaClient } from '@prisma/client'
import request from 'supertest'
import { AppModule } from '../../src/app.module'
import { openJson } from '../../src/common/crypto'
import { configureApp } from '../../src/configure-app'
import { loadEnv } from '../../src/config/env'
import { setupOpenApi } from '../../src/openapi'

export interface TestApp {
  app: INestApplication
  /** Raw HTTP, no cookies */
  http: () => ReturnType<typeof request>
  /** System connection (BYPASSRLS): for assertions and arrange steps only. */
  sys: PrismaClient
  /** Decrypts the queued e-mail for `to` (latest first). */
  mails: (to: string, template?: string) => Promise<{ template: string; data: Record<string, any> }[]>
  close: () => Promise<void>
}

export async function createTestApp(): Promise<TestApp> {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile()
  const app = mod.createNestApplication()
  const env = loadEnv()
  configureApp(app, env)
  setupOpenApi(app, env)
  await app.init()
  const sys = new PrismaClient({ datasources: { db: { url: env.databaseSystemUrl } } })

  return {
    app,
    http: () => request(app.getHttpServer()),
    sys,
    async mails(to, template) {
      const rows = await sys.job.findMany({ where: { kind: 'email.send' }, orderBy: { createdAt: 'desc' }, take: 200 })
      return rows
        .map((j) => j.payload as { to: string; template: string; sealed: string })
        .filter((p) => p.to === to && (!template || p.template === template))
        .map((p) => ({ template: p.template, data: openJson<Record<string, any>>(p.sealed, env.tokenEncryptionKey) }))
    },
    async close() {
      await sys.$disconnect()
      await app.close()
    },
  }
}

let counter = 0
export const uniq = (p = 'x') => `${p}${Date.now().toString(36)}${(counter++).toString(36)}`
export const PASSWORD = 'correct-horse-battery-9'

export interface Session {
  token: string
  userId: string
  email: string
  cookie: string
  workspaceId?: string
  /** supertest helpers carrying the bearer token and workspace header */
  get: (path: string, ws?: string | null) => request.Test
  post: (path: string, body?: object, ws?: string | null) => request.Test
  put: (path: string, body?: object, ws?: string | null) => request.Test
  patch: (path: string, body?: object, ws?: string | null) => request.Test
  del: (path: string, ws?: string | null) => request.Test
  /** No body attached (multipart uploads) */
  raw: (method: 'get' | 'post' | 'put' | 'patch' | 'delete', path: string, ws?: string | null) => request.Test
}

export function sessionFor(t: TestApp, token: string, userId: string, email: string, cookie = '', workspaceId?: string): Session {
  const base = (m: 'get' | 'post' | 'put' | 'patch' | 'delete', path: string, ws?: string | null) => {
    const r = (t.http() as any)[m](`/api/v1${path}`).set('Authorization', `Bearer ${token}`)
    const w = ws === undefined ? workspaceId : ws
    return w ? r.set('X-Workspace-Id', w) : r
  }
  return {
    token,
    userId,
    email,
    cookie,
    workspaceId,
    get: (p, ws) => base('get', p, ws),
    post: (p, b, ws) => base('post', p, ws).send(b ?? {}),
    put: (p, b, ws) => base('put', p, ws).send(b ?? {}),
    patch: (p, b, ws) => base('patch', p, ws).send(b ?? {}),
    del: (p, ws) => base('delete', p, ws),
    raw: (m, p, ws) => base(m, p, ws),
  }
}

/** Sign up + verify + login. Returns a session scoped to the new workspace. */
export async function signUpAndLogin(
  t: TestApp,
  opts: { type?: 'institution' | 'supervision'; name?: string; verify?: boolean } = {}
): Promise<Session & { workspaceId: string }> {
  const email = `${uniq('u')}@example.test`
  const type = opts.type ?? 'supervision'
  const r = await t.http().post('/api/v1/auth/sign-up').send({
    name: opts.name ?? 'Test User',
    email,
    password: PASSWORD,
    workspace_type: type,
    workspace_name: `${type} ${uniq('ws')}`,
  })
  if (r.status !== 202) throw new Error(`sign-up failed: ${r.status} ${JSON.stringify(r.body)}`)
  if (opts.verify !== false) {
    const [mail] = await t.mails(email, 'verify_email')
    const token = new URL(mail.data.link).searchParams.get('token')
    await t.http().post('/api/v1/auth/verify-email').send({ token }).expect(200)
  }
  if (type === 'institution') {
    // a Super Admin approves new institutions; tests do it directly
    await t.sys.workspace.updateMany({ where: { memberships: { some: { user: { email } } } }, data: { status: 'active' } })
  }
  return login(t, email) as Promise<Session & { workspaceId: string }>
}

export async function login(t: TestApp, email: string, password = PASSWORD): Promise<Session> {
  const res = await t.http().post('/api/v1/auth/login').send({ email, password }).expect(200)
  const cookie = (res.headers['set-cookie'] as unknown as string[] | undefined)?.find((c) => c.startsWith('pn_refresh=')) ?? ''
  const me = res.body.user
  const ws = me.memberships?.[0]?.workspace?.id as string | undefined
  return sessionFor(t, res.body.access_token, me.id, email, cookie.split(';')[0], ws)
}

/** A platform owner. They hold no membership in any workspace. */
export async function makePlatformAdmin(t: TestApp): Promise<Session> {
  const argon2 = await import('argon2')
  const email = `${uniq('root')}@example.test`
  await t.sys.user.create({
    data: { email, name: 'Platform Owner', isPlatformAdmin: true, emailVerifiedAt: new Date(), passwordHash: await argon2.hash(PASSWORD, { type: argon2.argon2id, memoryCost: 4096, timeCost: 1 }) },
  })
  return login(t, email)
}
