import { createHash, randomBytes } from 'node:crypto'
import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common'
import { ApiError, conflict } from '../../common/http'
import { open, seal } from '../../common/crypto'
import { ENV, Env } from '../../config/env'
import { Db } from '../../infra/db'
import { KvService } from '../../infra/kv'
import { SystemPrismaService } from '../../infra/prisma.service'
import { DriveError, DrivePort } from '../../integrations/drive.port'
import { AuditService } from '../core/core.services'

export interface DriveConnectionView {
  status: 'connected' | 'disconnected' | 'error'
  account: string | null
  rootFolder: string | null
  usedGb: number
  quotaGb: number
  connectedAt: Date | null
  error: string | null
}

/** Maps Drive failures to API errors a student or supervisor can act on. */
export function driveToApi(e: unknown): never {
  if (e instanceof DriveError) {
    const map: Record<string, [number, string, string]> = {
      disconnected: [HttpStatus.CONFLICT, 'drive_disconnected', "The Lead supervisor's Google Drive is disconnected. Ask them to reconnect it"],
      quota_exceeded: [HttpStatus.INSUFFICIENT_STORAGE, 'drive_quota_exceeded', "The Lead supervisor's Google Drive is full"],
      rate_limited: [HttpStatus.TOO_MANY_REQUESTS, 'drive_rate_limited', 'Google Drive is busy. Try again in a moment'],
      not_found: [HttpStatus.NOT_FOUND, 'drive_file_not_found', 'The file was not found in Google Drive'],
      unavailable: [HttpStatus.BAD_GATEWAY, 'drive_unavailable', 'Google Drive is unavailable. Try again shortly'],
    }
    const [status, code, detail] = map[e.code] ?? map.unavailable
    throw new ApiError(status, code, detail)
  }
  throw e
}

@Injectable()
export class DriveService {
  private readonly log = new Logger('Drive')
  constructor(
    private db: Db,
    private drive: DrivePort,
    private kvs: KvService,
    private sys: SystemPrismaService,
    private audit: AuditService,
    @Inject(ENV) private env: Env
  ) {}

  private get tx() {
    return this.db.tx
  }

  /* ---------------------------- OAuth ---------------------------- */

  async startConnect(userId: string) {
    const state = randomBytes(24).toString('base64url')
    const verifier = randomBytes(32).toString('base64url')
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    await this.kvs.kv.set(`drive:oauth:${state}`, JSON.stringify({ userId, verifier }), 600)
    let url = this.drive.authorizeUrl(state, challenge)
    if (url.startsWith('/')) url = new URL(this.env.googleRedirectBase).origin + url
    return { authorizeUrl: url }
  }

  /** Browser callback from Google. Returns where to send the user next. */
  async finishConnect(state: string, code: string | undefined, error?: string): Promise<string> {
    const back = (q: string) => `${this.env.appBaseUrl}/settings/integrations?drive=${q}`
    const raw = await this.kvs.kv.get(`drive:oauth:${state}`)
    if (!raw) return back('expired')
    await this.kvs.kv.del(`drive:oauth:${state}`)
    if (error || !code) return back('denied')
    const { userId, verifier } = JSON.parse(raw) as { userId: string; verifier: string }
    try {
      const { refreshToken, email } = await this.drive.exchangeCode(code, verifier)
      const root = await this.drive.ensureFolder(refreshToken, null, 'Project N')
      const enc = new Uint8Array(seal(refreshToken, this.env.tokenEncryptionKey))
      await this.db.run({ userId }, async () => {
        await this.tx.googleDriveConnection.upsert({
          where: { userId },
          create: { userId, googleEmail: email, refreshTokenEnc: enc, keyId: this.env.tokenEncryptionKeyId, rootFolderId: root.id, rootFolderName: 'Project N' },
          update: { googleEmail: email, refreshTokenEnc: enc, keyId: this.env.tokenEncryptionKeyId, status: 'connected', error: null, rootFolderId: root.id, rootFolderName: 'Project N', connectedAt: new Date() },
        })
        await this.audit.log('drive.connected', { actorId: userId, targetType: 'user', targetId: userId })
      })
      return back('connected')
    } catch (e) {
      this.log.warn(`drive connect failed: ${e instanceof Error ? e.message : e}`)
      return back('error')
    }
  }

  async disconnect(userId: string) {
    const conn = await this.tx.googleDriveConnection.findUnique({ where: { userId } })
    if (!conn) return
    await this.drive.revoke(open(conn.refreshTokenEnc, this.env.tokenEncryptionKey).toString('utf8')).catch(() => undefined)
    await this.tx.googleDriveConnection.delete({ where: { userId } })
    await this.audit.log('drive.disconnected', { actorId: userId, targetType: 'user', targetId: userId })
  }

  async view(userId: string): Promise<DriveConnectionView> {
    const c = await this.tx.googleDriveConnection.findUnique({ where: { userId } })
    if (!c) return { status: 'disconnected', account: null, rootFolder: null, usedGb: 0, quotaGb: 0, connectedAt: null, error: null }
    let usedGb = 0
    let quotaGb = 0
    let status: DriveConnectionView['status'] = c.status
    let error = c.error
    if (c.status === 'connected') {
      const cached = await this.kvs.kv.get(`drive:usage:${userId}`)
      if (cached) ({ usedGb, quotaGb } = JSON.parse(cached) as { usedGb: number; quotaGb: number })
      else {
        try {
          const u = await this.drive.usage(open(c.refreshTokenEnc, this.env.tokenEncryptionKey).toString('utf8'))
          ;({ usedGb, quotaGb } = u)
          await this.kvs.kv.set(`drive:usage:${userId}`, JSON.stringify(u), 300)
        } catch (e) {
          if (e instanceof DriveError && e.code === 'disconnected') {
            await this.markBroken(userId, 'Google access was revoked. Reconnect to continue.')
            status = 'error'
            error = 'Google access was revoked. Reconnect to continue.'
          }
        }
      }
    }
    return { status, account: c.googleEmail, rootFolder: c.rootFolderName, usedGb, quotaGb, connectedAt: c.connectedAt, error }
  }

  async setRootFolder(userId: string, name: string) {
    const c = await this.tx.googleDriveConnection.findUnique({ where: { userId } })
    if (!c) throw conflict('drive_not_connected', 'Connect Google Drive first')
    const rt = open(c.refreshTokenEnc, this.env.tokenEncryptionKey).toString('utf8')
    try {
      const f = await this.drive.ensureFolder(rt, null, name)
      await this.tx.googleDriveConnection.update({ where: { userId }, data: { rootFolderName: name, rootFolderId: f.id } })
    } catch (e) {
      driveToApi(e)
    }
  }

  /* ------------------- tokens for other modules ------------------- */

  /**
   * The project Lead's decrypted refresh token, or a 409 the student can act on.
   * Read through `pn_project_drive`, which only answers for projects the caller can open.
   */
  async requireToken(projectId: string): Promise<{ refreshToken: string; rootFolderId: string | null; rootFolderName: string; leadUserId: string }> {
    const rows = await this.tx.$queryRaw<{ user_id: string; refresh_token_enc: Buffer; root_folder_id: string | null; root_folder_name: string; status: string }[]>`
      SELECT * FROM pn_project_drive(${projectId}::uuid)`
    const c = rows[0]
    if (!c || c.status !== 'connected') {
      throw new ApiError(HttpStatus.CONFLICT, 'drive_not_connected', 'The Lead supervisor has not connected Google Drive. Uploads are paused until they do')
    }
    return {
      refreshToken: open(c.refresh_token_enc, this.env.tokenEncryptionKey).toString('utf8'),
      rootFolderId: c.root_folder_id,
      rootFolderName: c.root_folder_name,
      leadUserId: c.user_id,
    }
  }

  /** Recorded outside the request transaction: it must survive the caller's rollback. */
  async markBroken(userId: string, message: string) {
    await this.sys.googleDriveConnection.updateMany({ where: { userId }, data: { status: 'error', error: message } })
  }

  /* --------------------------- folders --------------------------- */

  private async cachedFolder(key: string, make: () => Promise<{ id: string; url: string }>) {
    const hit = await this.kvs.kv.get(`drive:folder:${key}`)
    if (hit) return JSON.parse(hit) as { id: string; url: string }
    const f = await make()
    await this.kvs.kv.set(`drive:folder:${key}`, JSON.stringify(f), 86_400)
    return f
  }

  /** `Project N / <workspace> / <project>`; persisted on the project. */
  async projectFolder(p: { id: string; title: string; workspaceName: string; driveFolderId: string | null; driveFolderUrl: string | null }) {
    if (p.driveFolderId) return { id: p.driveFolderId, url: p.driveFolderUrl ?? '' }
    const { refreshToken, rootFolderId, rootFolderName, leadUserId } = await this.requireToken(p.id)
    try {
      const root = rootFolderId ? { id: rootFolderId } : await this.drive.ensureFolder(refreshToken, null, rootFolderName)
      const ws = await this.cachedFolder(`${leadUserId}:ws:${p.workspaceName}`, () => this.drive.ensureFolder(refreshToken, root.id, p.workspaceName))
      const proj = await this.drive.ensureFolder(refreshToken, ws.id, `${p.title} (${p.id.slice(0, 8)})`)
      await this.tx.project.update({ where: { id: p.id }, data: { driveFolderId: proj.id, driveFolderUrl: proj.url } })
      return proj
    } catch (e) {
      if (e instanceof DriveError && e.code === 'disconnected') await this.markBroken(leadUserId, 'Google access was revoked. Reconnect to continue.')
      return driveToApi(e)
    }
  }

  /** `<NN Phase name>/v<k>` inside the project folder. */
  async versionFolder(
    project: { id: string; title: string; workspaceName: string; driveFolderId: string | null; driveFolderUrl: string | null },
    phase: { id: string; position: number; name: string },
    version: number
  ) {
    const projectFolder = await this.projectFolder(project)
    const { refreshToken } = await this.requireToken(project.id)
    try {
      const pf = await this.cachedFolder(`${project.id}:p:${phase.id}`, () =>
        this.drive.ensureFolder(refreshToken, projectFolder.id, `${String(phase.position).padStart(2, '0')} ${phase.name}`)
      )
      return await this.cachedFolder(`${project.id}:p:${phase.id}:v${version}`, () => this.drive.ensureFolder(refreshToken, pf.id, `v${version}`))
    } catch (e) {
      return driveToApi(e)
    }
  }

  /** Phase-level folder for guides / templates. */
  async phaseFolder(
    project: { id: string; title: string; workspaceName: string; driveFolderId: string | null; driveFolderUrl: string | null },
    phase: { id: string; position: number; name: string }
  ) {
    const projectFolder = await this.projectFolder(project)
    const { refreshToken } = await this.requireToken(project.id)
    try {
      return await this.cachedFolder(`${project.id}:p:${phase.id}`, () =>
        this.drive.ensureFolder(refreshToken, projectFolder.id, `${String(phase.position).padStart(2, '0')} ${phase.name}`)
      )
    } catch (e) {
      return driveToApi(e)
    }
  }
}
