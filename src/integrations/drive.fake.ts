import { createHash, randomUUID } from 'node:crypto'
import { Injectable } from '@nestjs/common'
import { DriveError, DriveFileInfo, DrivePort } from './drive.port'

/**
 * In-memory Google Drive for development, demos and tests. Behaves like the
 * real thing where the application depends on it: folders are find-or-create,
 * resumable sessions must be completed before the file exists, revoked
 * tokens fail with `disconnected`.
 */
@Injectable()
export class FakeDriveGateway extends DrivePort {
  readonly files = new Map<string, DriveFileInfo & { parentId: string | null; data?: Buffer }>()
  readonly folders = new Map<string, { id: string; name: string; parentId: string | null }>()
  readonly sessions = new Map<string, { parentId: string; name: string; mimeType: string; sizeBytes: number }>()
  readonly permissions = new Map<string, { writers: string[]; readers: string[] }>()
  readonly revokedTokens = new Set<string>()
  /** Test hook: next calls fail with this error code. */
  failNext: DriveError | null = null

  private guard(token: string) {
    if (this.failNext) {
      const e = this.failNext
      this.failNext = null
      throw e
    }
    if (this.revokedTokens.has(token)) throw new DriveError('disconnected', 'invalid_grant')
  }

  authorizeUrl(state: string): string {
    // The "consent screen" is our own callback with a deterministic code.
    return `/api/v1/integrations/google-drive/callback?state=${encodeURIComponent(state)}&code=fake-code`
  }

  async exchangeCode(code: string): Promise<{ refreshToken: string; email: string }> {
    if (!code.startsWith('fake-code')) throw new DriveError('disconnected', 'bad code')
    return { refreshToken: `fake-refresh-${randomUUID()}`, email: 'supervisor@gmail.test' }
  }

  async usage(token: string) {
    this.guard(token)
    return { usedGb: 0.2, quotaGb: 15 }
  }

  async ensureFolder(token: string, parentId: string | null, name: string) {
    this.guard(token)
    const found = [...this.folders.values()].find((f) => f.parentId === parentId && f.name === name)
    const f = found ?? { id: `fake-folder-${randomUUID()}`, name, parentId }
    this.folders.set(f.id, f)
    return { id: f.id, url: `https://drive.fake/folders/${f.id}` }
  }

  async createUploadSession(token: string, p: { parentId: string; name: string; mimeType: string; sizeBytes: number }) {
    this.guard(token)
    const id = randomUUID()
    this.sessions.set(id, p)
    return { uploadUrl: `https://drive.fake/upload/${id}` }
  }

  /** Test hook: the browser finishing a resumable upload. */
  completeUpload(uploadUrl: string, data: Buffer): DriveFileInfo {
    const sid = uploadUrl.split('/').pop()!
    const s = this.sessions.get(sid)
    if (!s) throw new Error('unknown upload session')
    const id = `fake-file-${randomUUID()}`
    const info: DriveFileInfo = {
      id,
      name: s.name,
      mimeType: s.mimeType,
      sizeBytes: data.length,
      md5: createHash('md5').update(data).digest('hex'),
      webViewLink: `https://drive.fake/file/${id}`,
    }
    this.files.set(id, { ...info, parentId: s.parentId, data })
    return info
  }

  async getFile(token: string, id: string) {
    this.guard(token)
    const f = this.files.get(id)
    if (!f || f.trashed) return null
    const { parentId: _p, data: _d, ...info } = f
    return info
  }

  async uploadSmall(token: string, p: { parentId: string; name: string; mimeType: string; data: Buffer }) {
    this.guard(token)
    const id = `fake-file-${randomUUID()}`
    const info: DriveFileInfo = {
      id,
      name: p.name,
      mimeType: p.mimeType,
      sizeBytes: p.data.length,
      md5: createHash('md5').update(p.data).digest('hex'),
      webViewLink: `https://drive.fake/file/${id}`,
    }
    this.files.set(id, { ...info, parentId: p.parentId, data: p.data })
    return info
  }

  async download(token: string, id: string, maxBytes: number) {
    this.guard(token)
    const f = this.files.get(id)
    if (!f?.data) throw new DriveError('not_found')
    if (f.data.length > maxBytes) throw new DriveError('unavailable', 'too large')
    return f.data
  }

  async deleteFile(token: string, id: string) {
    this.guard(token)
    this.files.delete(id)
  }

  async syncPermissions(token: string, folderId: string, who: { writers: string[]; readers: string[] }) {
    this.guard(token)
    this.permissions.set(folderId, who)
  }

  async revoke(token: string) {
    this.revokedTokens.add(token)
  }
}
