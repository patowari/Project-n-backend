import { HttpStatus, Injectable } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { Caller } from '../../authz/caller'
import { canManageProject, canUpload, projectRole } from '../../authz/policy'
import { ApiError, conflict, forbidden, notFound, unprocessable } from '../../common/http'
import { Db } from '../../infra/db'
import { DriveError, DrivePort } from '../../integrations/drive.port'
import { ActivityService, JobsService } from '../core/core.services'
import { DriveService, driveToApi } from '../drive/drive.service'
import { isoDate, LoadedProject, PersonRef, ProjectCore } from '../projects/project-core.service'
import { day, reasonFor } from '../projects/projects.service'

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

export interface UploadedFile {
  originalname: string
  mimetype: string
  size: number
  buffer: Buffer
}

export interface DriveFileView {
  id: string
  name: string
  requirementId?: string
  mimeType: string
  sizeKb: number
  driveUrl: string
  uploadedBy: PersonRef
  uploadedAt: Date
}

export const cleanName = (n: string) =>
  n
    .replace(/[\\/\u0000-\u001f]/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 200) || 'file'

export const extOf = (n: string) => (n.includes('.') ? n.split('.').pop()!.toLowerCase() : '')

@Injectable()
export class PhasesService {
  constructor(
    private db: Db,
    private core: ProjectCore,
    private activity: ActivityService,
    private drives: DriveService,
    private drive: DrivePort,
    private jobs: JobsService
  ) {}

  private get tx() {
    return this.db.tx
  }

  /** Phase + its project, visible to the caller or 404. */
  async phaseCtx(c: Caller, phaseId: string) {
    const phase = await this.tx.phase.findUnique({ where: { id: phaseId } })
    if (!phase) throw notFound('Phase')
    const loaded = await this.core.loadVisible(c, phase.projectId)
    return { phase, ...loaded }
  }

  private assertEditable(l: LoadedProject) {
    if (l.row.status === 'completed' || l.row.status === 'cancelled') throw conflict('project_closed', 'This project is closed')
  }

  /* --------------------------- timeline --------------------------- */

  async updatePhase(
    c: Caller,
    id: string,
    v: { name?: string; description?: string; dueDate?: string | null; requirements?: { id?: string; name: string; optional: boolean }[]; reason?: string }
  ) {
    const x = await this.phaseCtx(c, id)
    if (!canManageProject(c, x.facts)) throw forbidden('cannot_edit_timeline', 'Only the Lead or the Dean can edit the timeline')
    this.assertEditable(x)
    await this.db.lock('phases', id)
    const phase = await this.tx.phase.findUniqueOrThrow({ where: { id } })
    const data: Prisma.PhaseUpdateInput = {}
    const changed: string[] = []
    let before: string | undefined
    let after: string | undefined

    if (v.name !== undefined || v.requirements !== undefined) {
      if (phase.status === 'approved') throw conflict('phase_approved', 'An approved phase cannot be renamed or change its documents')
    }
    if (v.name !== undefined && v.name.trim() !== phase.name) {
      data.name = v.name.trim()
      changed.push('name')
    }
    if (v.description !== undefined && v.description !== phase.description) {
      data.description = v.description
      changed.push('brief')
    }
    let dueChanged = false
    if (v.dueDate !== undefined) {
      const newDue = v.dueDate
      if (newDue !== null && !DAY_RE.test(newDue)) throw unprocessable('invalid_date', 'Use YYYY-MM-DD', [{ field: 'dueDate', message: 'Use YYYY-MM-DD' }])
      if (isoDate(phase.dueDate) !== newDue) {
        if (phase.status === 'approved') throw conflict('phase_approved', 'An approved phase has no deadline to move')
        await this.assertDueOrder(x, phase.position, newDue)
        data.dueDate = newDue ? day(newDue) : null
        before = isoDate(phase.dueDate) ?? 'none'
        after = newDue ?? 'none'
        dueChanged = true
        changed.push('due date')
      }
    }
    const why = dueChanged ? reasonFor(c, x.facts, v.reason) : null
    if (changed.length === 0 && v.requirements === undefined) return

    if (Object.keys(data).length) await this.tx.phase.update({ where: { id }, data })
    if (v.requirements) await this.replaceRequirements(id, v.requirements)

    const override = dueChanged && !!why && projectRole(c, x.facts) !== 'lead'
    if (override) {
      await this.tx.override.create({
        data: {
          workspaceId: c.workspaceId!,
          projectId: x.row.id,
          phaseId: id,
          kind: 'move_deadline',
          reason: why!,
          actorId: c.userId,
          actorRole: 'Dean',
          actorIsSupervisor: projectRole(c, x.facts) !== null,
          before: { dueDate: before },
          after: { dueDate: after },
        },
      })
    }
    await this.activity.record(c, x.facts, {
      category: 'timeline',
      action: dueChanged ? `moved the due date of phase ${phase.position} “${phase.name}”` : `edited phase ${phase.position} “${phase.name}” (${[...changed, ...(v.requirements ? ['documents'] : [])].join(', ')})`,
      targetType: 'phase',
      targetId: id,
      targetLabel: x.row.title,
      phaseId: id,
      before,
      after,
      reason: why,
      isOverride: override,
    })
    if (dueChanged) await this.jobs.healthRecompute(x.row.id)
  }

  /** Deadlines stay in order and never precede the start date. */
  private async assertDueOrder(x: LoadedProject, position: number, due: string | null) {
    if (!due) return
    const phases = await this.tx.phase.findMany({ where: { projectId: x.row.id }, orderBy: { position: 'asc' }, select: { position: true, dueDate: true } })
    const prev = [...phases].reverse().find((p) => p.position < position && p.dueDate)
    const next = phases.find((p) => p.position > position && p.dueDate)
    const start = isoDate(x.row.startDate)!
    const lower = prev ? isoDate(prev.dueDate)! : start
    if (due <= lower) throw unprocessable('invalid_date', prev ? 'Must be after the previous phase' : 'Must be after the start date', [{ field: 'dueDate', message: 'Out of order' }])
    if (next && due >= isoDate(next.dueDate)!) throw unprocessable('invalid_date', 'Must be before the next phase', [{ field: 'dueDate', message: 'Out of order' }])
  }

  private async replaceRequirements(phaseId: string, reqs: { id?: string; name: string; optional: boolean }[]) {
    const cleaned = reqs.map((r, i) => ({ id: r.id, name: r.name.trim(), optional: !!r.optional, position: i })).filter((r) => r.name)
    if (cleaned.length > 20) throw unprocessable('too_many_documents', 'At most 20 required documents per phase')
    const existing = await this.tx.phaseRequirement.findMany({ where: { phaseId } })
    const keep = new Set(cleaned.filter((r) => r.id).map((r) => r.id!))
    const drop = existing.filter((e) => !keep.has(e.id)).map((e) => e.id)
    if (drop.length) {
      await this.tx.draftFile.updateMany({ where: { phaseId, requirementId: { in: drop } }, data: { requirementId: null } })
      await this.tx.phaseRequirement.deleteMany({ where: { id: { in: drop } } })
    }
    for (const r of cleaned) {
      if (r.id && existing.some((e) => e.id === r.id)) {
        await this.tx.phaseRequirement.update({ where: { id: r.id }, data: { name: r.name, optional: r.optional, position: r.position } })
      } else {
        const wid = this.db.ctx.workspaceId!
        await this.tx.phaseRequirement.create({ data: { workspaceId: wid, phaseId, name: r.name, optional: r.optional, position: r.position } })
      }
    }
  }

  async addPhase(c: Caller, projectId: string, v: { name: string; dueDate: string | null }): Promise<string> {
    await this.db.lock('projects', projectId)
    const x = await this.core.loadVisible(c, projectId)
    if (!canManageProject(c, x.facts)) throw forbidden('cannot_edit_timeline')
    this.assertEditable(x)
    const last = x.phases[x.phases.length - 1]
    if (v.dueDate !== null) {
      if (!DAY_RE.test(v.dueDate)) throw unprocessable('invalid_date', 'Use YYYY-MM-DD')
      const lower = last?.dueDate ? isoDate(last.dueDate)! : isoDate(x.row.startDate)!
      if (v.dueDate <= lower) throw unprocessable('invalid_date', 'Must be after the previous phase', [{ field: 'dueDate', message: 'Out of order' }])
    }
    // The previous last phase may already be approved: the new one then opens at once.
    const allDone = x.phases.length > 0 && x.phases.every((p) => p.status === 'approved')
    const status = x.phases.length === 0 || allDone ? 'open' : 'locked'
    const p = await this.tx.phase.create({
      data: { workspaceId: c.workspaceId!, projectId, position: (last?.position ?? 0) + 1, name: v.name.trim(), dueDate: v.dueDate ? day(v.dueDate) : null, status },
    })
    if (allDone && x.row.status === 'completed') await this.tx.project.update({ where: { id: projectId }, data: { status: 'active' } })
    await this.activity.record(c, x.facts, { category: 'timeline', action: `added phase ${p.position} “${p.name}”`, targetType: 'phase', targetId: p.id, targetLabel: x.row.title, phaseId: p.id })
    await this.jobs.healthRecompute(projectId)
    return p.id
  }

  async deletePhase(c: Caller, id: string) {
    const x = await this.phaseCtx(c, id)
    if (!canManageProject(c, x.facts)) throw forbidden('cannot_edit_timeline')
    this.assertEditable(x)
    await this.db.lock('projects', x.row.id)
    const phase = await this.tx.phase.findUniqueOrThrow({ where: { id } })
    const subs = await this.tx.submission.count({ where: { phaseId: id } })
    if (subs > 0 || phase.status === 'approved') throw conflict('phase_has_work', 'A phase with submissions cannot be deleted')
    if (x.phases.length <= 1) throw conflict('last_phase', 'A project needs at least one phase')
    await this.tx.phase.delete({ where: { id } })
    // close the gap in positions, in order, so the unique (project, position) never collides
    const rest = await this.tx.phase.findMany({ where: { projectId: x.row.id }, orderBy: { position: 'asc' } })
    for (let i = 0; i < rest.length; i++) if (rest[i].position !== i + 1) await this.tx.phase.update({ where: { id: rest[i].id }, data: { position: i + 1 } })
    // if the deleted phase was the only open one, open the first locked phase
    const first = rest.find((p) => p.status !== 'approved')
    if (first && first.status === 'locked' && !rest.some((p) => ['open', 'submitted', 'changes_requested'].includes(p.status))) {
      await this.tx.phase.update({ where: { id: first.id }, data: { status: 'open' } })
    }
    await this.activity.record(c, x.facts, { category: 'timeline', action: `deleted phase “${phase.name}”`, targetType: 'phase', targetId: id, targetLabel: x.row.title, reason: reasonFor(c, x.facts, undefined) })
  }

  /** Manual lock / unlock by the Lead; the Dean needs a reason (override). */
  async setOpen(c: Caller, id: string, open: boolean, reason?: string) {
    const x = await this.phaseCtx(c, id)
    if (!canManageProject(c, x.facts)) throw forbidden('cannot_edit_timeline')
    this.assertEditable(x)
    await this.db.lock('phases', id)
    const phase = await this.tx.phase.findUniqueOrThrow({ where: { id } })
    const why = reasonFor(c, x.facts, reason)
    if (open) {
      if (phase.status !== 'locked') throw conflict('phase_not_locked', 'The phase is already open')
      await this.tx.phase.update({ where: { id }, data: { status: 'open' } })
    } else {
      if (phase.status !== 'open') throw conflict('phase_not_open', 'Only an open phase can be locked again')
      const [subs, drafts] = await Promise.all([this.tx.submission.count({ where: { phaseId: id } }), this.tx.draftFile.count({ where: { phaseId: id } })])
      if (subs + drafts > 0) throw conflict('phase_has_work', 'The group has already started this phase')
      await this.tx.phase.update({ where: { id }, data: { status: 'locked' } })
    }
    await this.activity.record(c, x.facts, {
      category: 'timeline',
      action: `${open ? 'unlocked' : 'locked'} phase ${phase.position} “${phase.name}”`,
      targetType: 'phase',
      targetId: id,
      targetLabel: x.row.title,
      phaseId: id,
      before: phase.status,
      after: open ? 'open' : 'locked',
      reason: why,
      isOverride: !!why && projectRole(c, x.facts) !== 'lead',
    })
  }

  /* --------------------------- resources --------------------------- */

  async addResource(c: Caller, phaseId: string, v: { kind: 'link'; name: string; url: string } | { kind: 'file'; file: UploadedFile }) {
    const x = await this.phaseCtx(c, phaseId)
    if (!canManageProject(c, x.facts)) throw forbidden('cannot_edit_timeline')
    this.assertEditable(x)
    const wid = c.workspaceId!
    if (v.kind === 'link') {
      let u: URL
      try {
        u = new URL(v.url)
      } catch {
        throw unprocessable('invalid_url', 'Enter a valid link', [{ field: 'url', message: 'Invalid URL' }])
      }
      if (u.protocol !== 'https:' && u.protocol !== 'http:') throw unprocessable('invalid_url', 'Only http(s) links are allowed')
      await this.tx.phaseResource.create({ data: { workspaceId: wid, phaseId, kind: 'link', name: v.name.trim().slice(0, 120) || u.hostname, url: u.toString(), addedById: c.userId } })
      return
    }
    const settings = await this.tx.workspaceSettings.findUniqueOrThrow({ where: { workspaceId: wid } })
    this.assertFile(v.file, settings.allowedFileTypes, settings.maxFileMb)
    const { refreshToken } = await this.drives.requireToken(x.row.id)
    const ws = await this.tx.workspace.findUniqueOrThrow({ where: { id: wid }, select: { name: true } })
    const folder = await this.drives.phaseFolder({ ...x.row, workspaceName: ws.name }, { id: x.phase.id, position: x.phase.position, name: x.phase.name })
    try {
      const f = await this.drive.uploadSmall(refreshToken, { parentId: folder.id, name: cleanName(v.file.originalname), mimeType: v.file.mimetype, data: v.file.buffer })
      await this.tx.phaseResource.create({
        data: { workspaceId: wid, phaseId, kind: 'file', name: f.name, url: f.webViewLink, sizeKb: Math.max(1, Math.ceil(f.sizeBytes / 1024)), addedById: c.userId },
      })
    } catch (e) {
      driveToApi(e)
    }
  }

  async removeResource(c: Caller, phaseId: string, resourceId: string) {
    const x = await this.phaseCtx(c, phaseId)
    if (!canManageProject(c, x.facts)) throw forbidden('cannot_edit_timeline')
    const r = await this.tx.phaseResource.deleteMany({ where: { id: resourceId, phaseId } })
    if (r.count === 0) throw notFound('Resource')
  }

  /* ----------------------------- drafts ----------------------------- */

  private assertFile(f: { originalname: string; size: number }, allowed: string[], maxMb: number) {
    const ext = extOf(f.originalname)
    if (!ext || !allowed.includes(ext)) throw unprocessable('file_type_not_allowed', `.${ext || '?'} files are not allowed. Allowed: ${allowed.join(', ')}`, [{ field: 'files', message: `Type .${ext} not allowed` }])
    if (f.size > maxMb * 1024 * 1024) throw new ApiError(HttpStatus.PAYLOAD_TOO_LARGE, 'file_too_large', `Files can be at most ${maxMb} MB`)
    if (f.size <= 0) throw unprocessable('empty_file', 'The file is empty')
  }

  private draftView(d: Prisma.DraftFileGetPayload<object>, who: Map<string, PersonRef>): DriveFileView {
    return {
      id: d.id,
      name: d.name,
      ...(d.requirementId ? { requirementId: d.requirementId } : {}),
      mimeType: d.mimeType,
      sizeKb: Math.max(1, Math.ceil(Number(d.sizeBytes) / 1024)),
      driveUrl: d.driveUrl,
      uploadedBy: who.get(d.uploadedById) ?? { id: d.uploadedById, name: 'Unknown' },
      uploadedAt: d.uploadedAt,
    }
  }

  async draft(c: Caller, phaseId: string) {
    await this.phaseCtx(c, phaseId)
    const files = await this.tx.draftFile.findMany({ where: { phaseId }, orderBy: { uploadedAt: 'asc' } })
    const who = await this.core.people(files.map((f) => f.uploadedById))
    return { phaseId, files: files.map((f) => this.draftView(f, who)) }
  }

  /** The group may add files while the next version is open for work. */
  private async assertUploadable(c: Caller, x: Awaited<ReturnType<PhasesService['phaseCtx']>>) {
    if (!canUpload(c, x.facts)) throw forbidden('cannot_upload', 'Only students in this project can upload')
    this.assertEditable(x)
    if (!['open', 'changes_requested'].includes(x.phase.status)) {
      throw conflict('phase_not_open', x.phase.status === 'locked' ? 'This phase is not open yet' : 'This phase is not accepting files right now')
    }
  }

  private async assertRequirement(phaseId: string, requirementId?: string) {
    if (!requirementId) return
    const r = await this.tx.phaseRequirement.findFirst({ where: { id: requirementId, phaseId } })
    if (!r) throw unprocessable('invalid_requirement', 'That document is not part of this phase')
  }

  /** Multipart path (small files through the API). Large files should use `uploadSession`. */
  async uploadDraft(c: Caller, phaseId: string, files: UploadedFile[], requirementId?: string): Promise<void> {
    if (files.length === 0) throw unprocessable('no_files', 'Choose at least one file')
    const x = await this.phaseCtx(c, phaseId)
    await this.assertUploadable(c, x)
    await this.assertRequirement(phaseId, requirementId)
    const settings = await this.tx.workspaceSettings.findUniqueOrThrow({ where: { workspaceId: c.workspaceId! } })
    files.forEach((f) => this.assertFile(f, settings.allowedFileTypes, settings.maxFileMb))
    const have = await this.tx.draftFile.count({ where: { phaseId } })
    if (have + files.length > settings.maxFilesPerSubmission) throw unprocessable('too_many_files', `A submission can hold at most ${settings.maxFilesPerSubmission} files`)

    const { refreshToken, leadUserId: leadId } = await this.drives.requireToken(x.row.id)
    const ws = await this.tx.workspace.findUniqueOrThrow({ where: { id: c.workspaceId! }, select: { name: true } })
    const folder = await this.drives.versionFolder({ ...x.row, workspaceName: ws.name }, { id: x.phase.id, position: x.phase.position, name: x.phase.name }, x.phase.latestVersion + 1)
    for (const f of files) {
      try {
        const info = await this.drive.uploadSmall(refreshToken, { parentId: folder.id, name: cleanName(f.originalname), mimeType: f.mimetype, data: f.buffer })
        await this.recordDraft(c, x, info, requirementId)
      } catch (e) {
        if (e instanceof DriveError && e.code === 'disconnected' && leadId) await this.drives.markBroken(leadId, 'Google access was revoked. Reconnect to continue.')
        driveToApi(e)
      }
    }
  }

  /** Direct-to-Drive path: returns a resumable URL; the browser PUTs the bytes to Google. */
  async uploadSession(c: Caller, phaseId: string, f: { name: string; sizeBytes: number; mimeType: string }, origin: string) {
    const x = await this.phaseCtx(c, phaseId)
    await this.assertUploadable(c, x)
    const settings = await this.tx.workspaceSettings.findUniqueOrThrow({ where: { workspaceId: c.workspaceId! } })
    this.assertFile({ originalname: f.name, size: f.sizeBytes }, settings.allowedFileTypes, settings.maxFileMb)
    const have = await this.tx.draftFile.count({ where: { phaseId } })
    if (have >= settings.maxFilesPerSubmission) throw unprocessable('too_many_files', `A submission can hold at most ${settings.maxFilesPerSubmission} files`)
    const { refreshToken, leadUserId: leadId } = await this.drives.requireToken(x.row.id)
    const ws = await this.tx.workspace.findUniqueOrThrow({ where: { id: c.workspaceId! }, select: { name: true } })
    const folder = await this.drives.versionFolder({ ...x.row, workspaceName: ws.name }, { id: x.phase.id, position: x.phase.position, name: x.phase.name }, x.phase.latestVersion + 1)
    try {
      const s = await this.drive.createUploadSession(refreshToken, { parentId: folder.id, name: cleanName(f.name), mimeType: f.mimeType, sizeBytes: f.sizeBytes, origin })
      return { uploadUrl: s.uploadUrl, folderId: folder.id }
    } catch (e) {
      return driveToApi(e)
    }
  }

  /** After the browser finished the upload: verify with Drive, then record the file. */
  async confirmUpload(c: Caller, phaseId: string, v: { driveFileId: string; requirementId?: string }) {
    const x = await this.phaseCtx(c, phaseId)
    await this.assertUploadable(c, x)
    await this.assertRequirement(phaseId, v.requirementId)
    const { refreshToken } = await this.drives.requireToken(x.row.id)
    try {
      const info = await this.drive.getFile(refreshToken, v.driveFileId)
      if (!info) throw new DriveError('not_found')
      const settings = await this.tx.workspaceSettings.findUniqueOrThrow({ where: { workspaceId: c.workspaceId! } })
      this.assertFile({ originalname: info.name, size: info.sizeBytes }, settings.allowedFileTypes, settings.maxFileMb)
      await this.recordDraft(c, x, info, v.requirementId)
    } catch (e) {
      driveToApi(e)
    }
  }

  private async recordDraft(
    c: Caller,
    x: Awaited<ReturnType<PhasesService['phaseCtx']>>,
    info: { id: string; name: string; mimeType: string; sizeBytes: number; md5: string | null; webViewLink: string },
    requirementId?: string
  ) {
    const dup = await this.tx.draftFile.findFirst({ where: { phaseId: x.phase.id, driveFileId: info.id } })
    if (dup) return
    await this.tx.draftFile.create({
      data: {
        workspaceId: c.workspaceId!,
        projectId: x.row.id,
        phaseId: x.phase.id,
        requirementId: requirementId ?? null,
        name: info.name,
        mimeType: info.mimeType,
        sizeBytes: BigInt(info.sizeBytes),
        driveFileId: info.id,
        driveUrl: info.webViewLink,
        md5: info.md5,
        uploadedById: c.userId,
      },
    })
    await this.activity.record(c, x.facts, {
      category: 'submissions',
      action: `uploaded “${info.name}” to phase ${x.phase.position}`,
      targetType: 'phase',
      targetId: x.phase.id,
      targetLabel: x.row.title,
      phaseId: x.phase.id,
    })
  }

  async removeDraftFile(c: Caller, phaseId: string, fileId: string) {
    const x = await this.phaseCtx(c, phaseId)
    if (!canUpload(c, x.facts) && !canManageProject(c, x.facts)) throw forbidden('cannot_upload')
    if (!['open', 'changes_requested'].includes(x.phase.status)) throw conflict('phase_not_open', 'The phase is not accepting changes')
    const f = await this.tx.draftFile.findFirst({ where: { id: fileId, phaseId } })
    if (!f) throw notFound('File')
    await this.tx.draftFile.delete({ where: { id: fileId } })
    // The Drive file itself is removed by a worker: a flaky Drive must not block the student.
    await this.jobs.enqueue('drive.delete_file', { projectId: x.row.id, driveFileId: f.driveFileId }, { dedupeKey: `drive-del:${f.driveFileId}` })
  }
}
