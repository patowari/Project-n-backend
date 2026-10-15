export interface DriveFileInfo {
  id: string
  name: string
  mimeType: string
  sizeBytes: number
  md5: string | null
  webViewLink: string
  trashed?: boolean
}

export type DriveErrorCode = 'disconnected' | 'quota_exceeded' | 'not_found' | 'rate_limited' | 'unavailable'

export class DriveError extends Error {
  constructor(
    readonly code: DriveErrorCode,
    message?: string
  ) {
    super(message ?? code)
  }
}

/**
 * Everything the app needs from Google Drive. File bytes never pass through
 * the API for large files: the browser uploads straight to the resumable
 * session URL (architecture 6.4).
 *
 * Implementations: `GoogleDriveGateway` (production, `drive.file` scope) and
 * `FakeDriveGateway` (development, tests, demos).
 */
export abstract class DrivePort {
  abstract authorizeUrl(state: string, codeChallenge: string): string
  abstract exchangeCode(code: string, codeVerifier: string): Promise<{ refreshToken: string; email: string }>
  abstract usage(refreshToken: string): Promise<{ usedGb: number; quotaGb: number }>
  /** Find-or-create (idempotent): safe to call from retried jobs. */
  abstract ensureFolder(refreshToken: string, parentId: string | null, name: string): Promise<{ id: string; url: string }>
  abstract createUploadSession(
    refreshToken: string,
    p: { parentId: string; name: string; mimeType: string; sizeBytes: number; origin: string }
  ): Promise<{ uploadUrl: string }>
  abstract getFile(refreshToken: string, id: string): Promise<DriveFileInfo | null>
  abstract uploadSmall(
    refreshToken: string,
    p: { parentId: string; name: string; mimeType: string; data: Buffer }
  ): Promise<DriveFileInfo>
  abstract download(refreshToken: string, id: string, maxBytes: number): Promise<Buffer>
  abstract deleteFile(refreshToken: string, id: string): Promise<void>
  abstract syncPermissions(refreshToken: string, folderId: string, who: { writers: string[]; readers: string[] }): Promise<void>
  abstract revoke(refreshToken: string): Promise<void>
}
