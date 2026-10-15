/**
 * Typed, validated configuration. Secrets only ever come from the
 * environment (never from the frontend bundle or the repository).
 */
export interface Env {
  nodeEnv: 'development' | 'test' | 'production'
  isProd: boolean
  port: number
  /** App role: not owner, no BYPASSRLS. Row Level Security applies. */
  databaseUrl: string
  /** System role (BYPASSRLS): workers and the Super Admin module only. */
  databaseSystemUrl: string
  redisUrl: string | null
  jwtSecret: string
  accessTokenTtlSec: number
  refreshTokenTtlSec: number
  /** 32 bytes, base64. Encrypts Google refresh tokens and queued e-mail data. */
  tokenEncryptionKey: Buffer
  tokenEncryptionKeyId: string
  appBaseUrl: string
  corsOrigins: string[]
  cookieSecure: boolean
  cookieDomain: string | undefined
  cronSecret: string
  mailDriver: 'log' | 'resend'
  resendApiKey: string | null
  emailFrom: string
  driveDriver: 'fake' | 'google'
  googleClientId: string | null
  googleClientSecret: string | null
  googleRedirectBase: string
  aiDriver: 'fake' | 'gemini'
  geminiApiKey: string | null
  geminiModel: string
  docToolsBin: string
  /** Run the job loop inside the API process (free-tier demo). */
  inlineWorker: boolean
  logLevel: string
  /** Trust X-Forwarded-For (behind Render / a load balancer). */
  trustProxy: boolean
  argon: { memoryCost: number; timeCost: number }
  /** Multiplies every rate limit (tests run with a large value; production leaves it at 1). */
  rateLimitScale: number
}

function str(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback
  if (v === undefined || v === '') throw new Error(`Missing environment variable ${name}`)
  return v
}
const opt = (name: string) => (process.env[name] ? process.env[name]! : null)
const bool = (name: string, fallback: boolean) =>
  process.env[name] === undefined ? fallback : ['1', 'true', 'yes'].includes(process.env[name]!.toLowerCase())
const int = (name: string, fallback: number) => (process.env[name] ? parseInt(process.env[name]!, 10) : fallback)

export function loadEnv(): Env {
  const nodeEnv = (process.env.NODE_ENV as Env['nodeEnv']) ?? 'development'
  const isProd = nodeEnv === 'production'
  const devSecret = 'dev-only-secret-change-me-dev-only-secret-change-me'
  const jwtSecret = str('JWT_SECRET', isProd ? undefined : devSecret)
  if (isProd && jwtSecret.length < 32) throw new Error('JWT_SECRET must be at least 32 characters')

  const rawKey = str(
    'TOKEN_ENCRYPTION_KEY',
    isProd ? undefined : Buffer.alloc(32, 7).toString('base64')
  )
  const key = Buffer.from(rawKey, 'base64')
  if (key.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY must be 32 bytes, base64 encoded')

  const databaseUrl = str('DATABASE_URL')
  const env: Env = {
    nodeEnv,
    isProd,
    port: int('PORT', 8000),
    databaseUrl,
    databaseSystemUrl: str('DATABASE_SYSTEM_URL', databaseUrl),
    redisUrl: opt('REDIS_URL'),
    jwtSecret,
    accessTokenTtlSec: int('ACCESS_TOKEN_TTL_SEC', 15 * 60),
    refreshTokenTtlSec: int('REFRESH_TOKEN_TTL_SEC', 30 * 24 * 3600),
    tokenEncryptionKey: key,
    tokenEncryptionKeyId: str('TOKEN_ENCRYPTION_KEY_ID', 'k1'),
    appBaseUrl: str('APP_BASE_URL', 'http://localhost:5173').replace(/\/$/, ''),
    corsOrigins: str('CORS_ORIGINS', 'http://localhost:5173,http://localhost:5174')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    cookieSecure: bool('COOKIE_SECURE', isProd),
    cookieDomain: opt('COOKIE_DOMAIN') ?? undefined,
    cronSecret: str('CRON_SECRET', isProd ? undefined : 'dev-cron-secret'),
    mailDriver: (process.env.MAIL_DRIVER as Env['mailDriver']) ?? (isProd ? 'resend' : 'log'),
    resendApiKey: opt('RESEND_API_KEY'),
    emailFrom: str('EMAIL_FROM', 'Project N <no-reply@localhost>'),
    driveDriver: (process.env.DRIVE_DRIVER as Env['driveDriver']) ?? (isProd ? 'google' : 'fake'),
    googleClientId: opt('GOOGLE_OAUTH_CLIENT_ID'),
    googleClientSecret: opt('GOOGLE_OAUTH_CLIENT_SECRET'),
    googleRedirectBase: str('GOOGLE_OAUTH_REDIRECT_BASE', 'http://localhost:8000/api/v1'),
    aiDriver: (process.env.AI_DRIVER as Env['aiDriver']) ?? (isProd ? 'gemini' : 'fake'),
    geminiApiKey: opt('GEMINI_API_KEY'),
    geminiModel: str('GEMINI_MODEL', 'gemini-2.5-flash'),
    docToolsBin: str('DOC_TOOLS_BIN', 'pn-doc-tools'),
    inlineWorker: bool('INLINE_WORKER', false),
    logLevel: str('LOG_LEVEL', nodeEnv === 'test' ? 'silent' : 'info'),
    trustProxy: bool('TRUST_PROXY', isProd),
    rateLimitScale: Number(process.env.RATE_LIMIT_SCALE ?? 1),
    argon: {
      // OWASP minimum for Argon2id: 19 MiB, 2 iterations, 1 lane.
      memoryCost: int('ARGON_MEMORY_KIB', 19456),
      timeCost: int('ARGON_TIME_COST', 2),
    },
  }
  if (isProd) {
    // Values from .env.example / development defaults must never reach production.
    const devKey = Buffer.alloc(32, 7).toString('base64')
    if (/^dev-only/.test(env.jwtSecret) || rawKey === devKey || env.cronSecret.startsWith('dev-')) {
      throw new Error('Development secrets detected: set real JWT_SECRET, TOKEN_ENCRYPTION_KEY and CRON_SECRET')
    }
    if (env.corsOrigins.some((o) => /localhost|127\.0\.0\.1/.test(o))) throw new Error('CORS_ORIGINS must not contain localhost in production')
    if (env.mailDriver === 'resend' && !env.resendApiKey) throw new Error('RESEND_API_KEY is required')
    if (env.driveDriver === 'google' && (!env.googleClientId || !env.googleClientSecret))
      throw new Error('GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET are required')
    if (env.aiDriver === 'gemini' && !env.geminiApiKey) throw new Error('GEMINI_API_KEY is required')
    if (!env.redisUrl) {
      // eslint-disable-next-line no-console
      console.warn('[config] REDIS_URL is not set: rate limits, caches and session revocation are per-instance only')
    }
  }
  return env
}

export const ENV = Symbol('ENV')
