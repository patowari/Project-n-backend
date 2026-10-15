import { PASSWORD, Session, sessionFor, signUpAndLogin, TestApp, uniq } from './app'

export interface World {
  t: TestApp
  workspaceId: string
  admin: Session & { workspaceId: string }
  faculty: { id: string }
  otherFaculty: { id: string }
  dept: { id: string }
  otherDept: { id: string }
  dean: Session
  head: Session
  /** approval right on */
  sup1: Session
  sup2: Session
  /** no approval right */
  sup3: Session
  students: Session[]
}

export async function joinByInvite(
  t: TestApp,
  admin: Session,
  v: { role: 'supervisor' | 'student'; name: string; departmentId: string; studentId?: string }
): Promise<Session> {
  const email = `${uniq(v.role)}@example.test`
  await admin
    .post(`/workspaces/${admin.workspaceId}/invites`, { role: v.role, name: v.name, email, department_id: v.departmentId, student_id: v.studentId })
    .expect(201)
  const [mail] = await t.mails(email, 'invite')
  const token = mail.data.link.split('/invite/')[1]
  const res = await t.http().post(`/api/v1/auth/invites/${token}/accept`).send({ password: PASSWORD }).expect(200)
  const ws = res.body.user.memberships[0].workspace.id
  const cookie = (res.headers['set-cookie'] as unknown as string[])[0].split(';')[0]
  return sessionFor(t, res.body.access_token, res.body.user.id, email, cookie, ws)
}

/** An institution with the whole cast, built through the public API. */
export async function buildInstitution(t: TestApp, studentCount = 3): Promise<World> {
  const admin = await signUpAndLogin(t, { type: 'institution', name: 'Registrar' })
  const ws = admin.workspaceId
  const faculty = (await admin.post('/org/faculties', { name: `Engineering ${uniq()}` }).expect(201)).body
  const otherFaculty = (await admin.post('/org/faculties', { name: `Science ${uniq()}` }).expect(201)).body
  const dept = (await admin.post('/org/departments', { name: `CSE ${uniq()}`, faculty_id: faculty.id }).expect(201)).body
  const otherDept = (await admin.post('/org/departments', { name: `Physics ${uniq()}`, faculty_id: otherFaculty.id }).expect(201)).body

  const dean = await joinByInvite(t, admin, { role: 'supervisor', name: 'Prof. Rahman', departmentId: dept.id })
  const head = await joinByInvite(t, admin, { role: 'supervisor', name: 'Dr. Hasan', departmentId: dept.id })
  await admin.patch(`/org/faculties/${faculty.id}`, { dean_id: dean.userId }).expect(204)
  await admin.patch(`/org/departments/${dept.id}`, { head_id: head.userId }).expect(204)

  const sup1 = await joinByInvite(t, admin, { role: 'supervisor', name: 'Dr. Karim', departmentId: dept.id })
  const sup2 = await joinByInvite(t, admin, { role: 'supervisor', name: 'Dr. Salma', departmentId: dept.id })
  const sup3 = await joinByInvite(t, admin, { role: 'supervisor', name: 'Mr. Zahid', departmentId: dept.id })
  for (const s of [dean, head, sup1, sup2]) await admin.patch(`/people/${s.userId}`, { can_approve: true }).expect(204)

  const students: Session[] = []
  for (let i = 0; i < studentCount; i++) {
    students.push(await joinByInvite(t, admin, { role: 'student', name: `Student ${i + 1}`, departmentId: dept.id, studentId: `2021-${i}` }))
  }
  return { t, workspaceId: ws, admin, faculty, otherFaculty, dept, otherDept, dean, head, sup1, sup2, sup3, students }
}

export const today = () => new Date().toISOString().slice(0, 10)
export const plusDays = (n: number, from = new Date()) => new Date(from.getTime() + n * 86400_000).toISOString().slice(0, 10)

export function projectBody(w: World, over: Record<string, unknown> = {}) {
  return {
    title: `Smart Irrigation ${uniq()}`,
    description: 'IoT based irrigation',
    department_id: w.dept.id,
    start_date: plusDays(-5),
    phases: [
      { name: 'Proposal', due_date: plusDays(10) },
      { name: 'Literature review', due_date: plusDays(25) },
      { name: 'Final report', due_date: plusDays(60) },
    ],
    unlock_rule: 'on_approval',
    lead_id: w.sup1.userId,
    co_supervisor_ids: [w.sup2.userId],
    successor_id: w.sup2.userId,
    student_ids: [w.students[0].userId, w.students[1].userId],
    group_leader_id: w.students[0].userId,
    submission_mode: 'leader_only',
    ai_student_feedback: true,
    ai_supervisor_summary: true,
    ...over,
  }
}

/** Creates a project as the Lead and returns its id. */
export async function createProject(w: World, over: Record<string, unknown> = {}, as: Session = w.sup1): Promise<string> {
  const r = await as.post('/projects', projectBody(w, over))
  if (r.status !== 201) throw new Error(`create project failed ${r.status} ${JSON.stringify(r.body)}`)
  return r.body.id
}

/* ---------------- Drive + workflow helpers ---------------- */

/** Browser consent flow against the fake Drive: connect -> callback. */
export async function connectDrive(t: TestApp, s: Session) {
  const r = await s.post('/integrations/google-drive/connect', {}, null).expect(200)
  const url = new URL(r.body.authorize_url)
  await t.http().get(`${url.pathname}${url.search}`).expect(302)
}

export function phaseIds(detail: { phases: { id: string; index: number }[] }) {
  return Object.fromEntries(detail.phases.map((p) => [p.index, p.id])) as Record<number, string>
}

export async function uploadDraft(s: Session, phaseId: string, names: string[] = ['proposal.pdf'], requirementId?: string) {
  let req = s.raw('post', `/phases/${phaseId}/draft/files`)
  names.forEach((n) => (req = req.attach('files', Buffer.from(`content of ${n}`), n)))
  if (requirementId) req = req.field('requirement_id', requirementId)
  return req
}

/** Upload one file and submit the phase. Returns the submit response. */
export async function submitPhase(s: Session, phaseId: string, note = 'ready', names: string[] = ['proposal.pdf']) {
  const up = await uploadDraft(s, phaseId, names)
  if (up.status !== 201) throw new Error(`upload failed ${up.status} ${JSON.stringify(up.body)}`)
  return s.post(`/phases/${phaseId}/submissions`, { note })
}
