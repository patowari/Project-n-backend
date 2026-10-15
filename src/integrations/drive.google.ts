import { Inject, Injectable, Logger } from '@nestjs/common'
import { ENV, Env } from '../config/env'
import { DriveError, DriveFileInfo, DrivePort } from './drive.port'

const SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/drive.file']
const FILE_FIELDS = 'id,name,mimeType,size,md5Checksum,webViewLink,trashed'

interface GoogleFile {
  id: string
  name: string
  mimeType: string
  size?: string
  md5Checksum?: string
  webViewLink?: string
  trashed?: boolean
}

/**
 * Google Drive v3 over plain HTTPS (no SDK, small memory footprint).
 *
 * Scope is `drive.file`: the app can only touch files and folders it
 * created itself, never the rest of the supervisor's Drive.
 *
 * NOTE: this adapter is written against Google's documented API but has NOT
 * been exercised against live Google endpoints in this repository (no
 * credentials are available to CI). `FakeDriveGateway` covers the behaviour
 * the application depends on. Run `docs/INTEGRATIONS.md` section
 * "Verifying Google Drive" before relying on it.
 */
@Injectable()
export class GoogleDriveGateway extends DrivePort {
  private readonly log = new Logger('GoogleDrive')
  /** access tokens by refresh token, in this process only */
  private cache = new Map<string, { token: string; exp: number }>()

  constructor(@Inject(ENV) private env: Env) {
    super()
  }

  private redirectUri() {
    return `${this.env.googleRedirectBase}/integrations/google-drive/callback`
  }

  authorizeUrl(state: string, codeChallenge: string): string {
    const q = new URLSearchParams({
      client_id: this.env.googleClientId ?? '',
      redirect_uri: this.redirectUri(),
      response_type: 'code',
      scope: SCOPES.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    })
    return `https://accounts.google.com/o/oauth2/v2/auth?${q}`
  }

  async exchangeCode(code: string, codeVerifier: string) {
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: this.env.googleClientId ?? '',
        client_secret: this.env.googleClientSecret ?? '',
        redirect_uri: this.redirectUri(),
        grant_type: 'authorization_code',
        code_verifier: codeVerifier,
      }),
    })
    const j = (await r.json()) as { refresh_token?: string; id_token?: string; error?: string }
    if (!r.ok || !j.refresh_token || !j.id_token) throw new DriveError('disconnected', j.error ?? 'token exchange failed')
    const payload = JSON.parse(Buffer.from(j.id_token.split('.')[1], 'base64url').toString('utf8')) as { email?: string }
    return { refreshToken: j.refresh_token, email: payload.email ?? '' }
  }

  private async access(refreshToken: string): Promise<string> {
    const hit = this.cache.get(refreshToken)
    if (hit && hit.exp > Date.now() + 30_000) return hit.token
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        refresh_token: refreshToken,
        client_id: this.env.googleClientId ?? '',
        client_secret: this.env.googleClientSecret ?? '',
        grant_type: 'refresh_token',
      }),
    })
    const j = (await r.json()) as { access_token?: string; expires_in?: number; error?: string }
    if (!r.ok || !j.access_token) {
      // invalid_grant: revoked or expired. The caller marks the connection broken.
      throw new DriveError(j.error === 'invalid_grant' ? 'disconnected' : 'unavailable', j.error)
    }
    this.cache.set(refreshToken, { token: j.access_token, exp: Date.now() + (j.expires_in ?? 3000) * 1000 })
    return j.access_token
  }

  private async call<T>(refreshToken: string, url: string, init: RequestInit = {}): Promise<{ res: Response; json: T | null }> {
    const token = await this.access(refreshToken)
    const res = await fetch(url, { ...init, headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${token}` } })
    if (res.status === 401) {
      this.cache.delete(refreshToken)
      throw new DriveError('disconnected')
    }
    if (res.status === 404) return { res, json: null }
    if (res.status === 429) throw new DriveError('rate_limited')
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: { errors?: { reason?: string }[]; message?: string } }
      const reason = body.error?.errors?.[0]?.reason
      if (reason === 'storageQuotaExceeded') throw new DriveError('quota_exceeded')
      if (reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded') throw new DriveError('rate_limited')
      this.log.warn(`drive ${res.status}: ${body.error?.message}`)
      throw new DriveError('unavailable', body.error?.message)
    }
    const ct = res.headers.get('content-type') ?? ''
    return { res, json: ct.includes('json') ? ((await res.json()) as T) : null }
  }

  private info(f: GoogleFile): DriveFileInfo {
    return {
      id: f.id,
      name: f.name,
      mimeType: f.mimeType,
      sizeBytes: Number(f.size ?? 0),
      md5: f.md5Checksum ?? null,
      webViewLink: f.webViewLink ?? `https://drive.google.com/file/d/${f.id}/view`,
      trashed: f.trashed,
    }
  }

  async usage(rt: string) {
    const { json } = await this.call<{ storageQuota?: { usage?: string; limit?: string } }>(rt, 'https://www.googleapis.com/drive/v3/about?fields=storageQuota')
    const GB = 1024 ** 3
    return { usedGb: Number(json?.storageQuota?.usage ?? 0) / GB, quotaGb: Number(json?.storageQuota?.limit ?? 0) / GB }
  }

  async ensureFolder(rt: string, parentId: string | null, name: string) {
    const esc = name.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    const q = `name='${esc}' and mimeType='application/vnd.google-apps.folder' and trashed=false and ${parentId ? `'${parentId}' in parents` : "'root' in parents"}`
    const found = await this.call<{ files: GoogleFile[] }>(rt, `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,webViewLink)&pageSize=1`)
    const hit = found.json?.files?.[0]
    if (hit) return { id: hit.id, url: hit.webViewLink ?? `https://drive.google.com/drive/folders/${hit.id}` }
    const created = await this.call<GoogleFile>(rt, 'https://www.googleapis.com/drive/v3/files?fields=id,webViewLink', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', ...(parentId ? { parents: [parentId] } : {}) }),
    })
    return { id: created.json!.id, url: created.json!.webViewLink ?? `https://drive.google.com/drive/folders/${created.json!.id}` }
  }

  async createUploadSession(rt: string, p: { parentId: string; name: string; mimeType: string; sizeBytes: number; origin: string }) {
    const token = await this.access(rt)
    const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=' + FILE_FIELDS, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': p.mimeType,
        'X-Upload-Content-Length': String(p.sizeBytes),
        // lets the browser PUT to the session URL (CORS)
        Origin: p.origin,
      },
      body: JSON.stringify({ name: p.name, parents: [p.parentId] }),
    })
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: { errors?: { reason?: string }[] } }
      if (body.error?.errors?.[0]?.reason === 'storageQuotaExceeded') throw new DriveError('quota_exceeded')
      throw new DriveError(res.status === 401 ? 'disconnected' : 'unavailable')
    }
    const uploadUrl = res.headers.get('location')
    if (!uploadUrl) throw new DriveError('unavailable', 'no session url')
    return { uploadUrl }
  }

  async getFile(rt: string, id: string) {
    const { json } = await this.call<GoogleFile>(rt, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?fields=${FILE_FIELDS}`)
    return json && !json.trashed ? this.info(json) : null
  }

  async uploadSmall(rt: string, p: { parentId: string; name: string; mimeType: string; data: Buffer }) {
    const boundary = `pn-${Date.now().toString(36)}`
    const meta = JSON.stringify({ name: p.name, parents: [p.parentId] })
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${p.mimeType}\r\n\r\n`),
      p.data,
      Buffer.from(`\r\n--${boundary}--`),
    ])
    const { json } = await this.call<GoogleFile>(rt, `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=${FILE_FIELDS}`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    })
    return this.info(json!)
  }

  async download(rt: string, id: string, maxBytes: number) {
    const token = await this.access(rt)
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media`, { headers: { Authorization: `Bearer ${token}` } })
    if (res.status === 404) throw new DriveError('not_found')
    if (!res.ok) throw new DriveError('unavailable')
    const len = Number(res.headers.get('content-length') ?? 0)
    if (len > maxBytes) throw new DriveError('unavailable', 'file too large')
    return Buffer.from(await res.arrayBuffer())
  }

  async deleteFile(rt: string, id: string) {
    await this.call(rt, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}`, { method: 'DELETE' })
  }

  async syncPermissions(rt: string, folderId: string, who: { writers: string[]; readers: string[] }) {
    const { json } = await this.call<{ permissions: { id: string; emailAddress?: string; role: string }[] }>(
      rt,
      `https://www.googleapis.com/drive/v3/files/${folderId}/permissions?fields=permissions(id,emailAddress,role)`
    )
    const current = json?.permissions ?? []
    const want = new Map<string, 'writer' | 'reader'>([...who.readers.map((e) => [e.toLowerCase(), 'reader'] as const), ...who.writers.map((e) => [e.toLowerCase(), 'writer'] as const)])
    for (const p of current) {
      const email = p.emailAddress?.toLowerCase()
      if (!email || p.role === 'owner') continue
      if (!want.has(email)) await this.call(rt, `https://www.googleapis.com/drive/v3/files/${folderId}/permissions/${p.id}`, { method: 'DELETE' })
    }
    for (const [email, role] of want) {
      const has = current.find((p) => p.emailAddress?.toLowerCase() === email)
      if (has?.role === role) continue
      if (has) await this.call(rt, `https://www.googleapis.com/drive/v3/files/${folderId}/permissions/${has.id}`, { method: 'DELETE' })
      await this.call(rt, `https://www.googleapis.com/drive/v3/files/${folderId}/permissions?sendNotificationEmail=false`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'user', role, emailAddress: email }),
      })
    }
  }

  async revoke(rt: string) {
    await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(rt)}`, { method: 'POST' }).catch(() => undefined)
    this.cache.delete(rt)
  }
}
