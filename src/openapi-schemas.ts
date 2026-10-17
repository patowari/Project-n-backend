/**
 * Response contract for the OpenAPI document and the generated clients.
 *
 * Property names are camelCase here; `buildOpenApi` rewrites them to the
 * snake_case that is actually on the wire. test/contract.e2e-spec.ts asserts
 * that live responses carry these keys.
 */
type S = Record<string, unknown>

const str: S = { type: 'string' }
const num: S = { type: 'number' }
const int: S = { type: 'integer' }
const bool: S = { type: 'boolean' }
const date: S = { type: 'string', format: 'date' }
const dateTime: S = { type: 'string', format: 'date-time' }
const nullable = (s: S): S => ({ ...s, nullable: true })
const arr = (items: S): S => ({ type: 'array', items })
const ref = (name: string): S => ({ $ref: `#/components/schemas/${name}` })
const en = (...v: string[]): S => ({ type: 'string', enum: v })
const obj = (properties: Record<string, S>, optional: string[] = []): S => ({
  type: 'object',
  properties,
  required: Object.keys(properties).filter((k) => !optional.includes(k)),
})
const page = (item: S): S => obj({ items: arr(item), nextCursor: nullable(str) })

export const SCHEMAS: Record<string, S> = {
  Problem: obj({ type: str, title: str, status: int, code: str, detail: str, errors: arr(obj({ field: str, message: str }, ['field'])), requestId: str }, ['detail', 'errors', 'requestId']),
  PersonRef: obj({ id: str, name: str, avatarUrl: str }, ['avatarUrl']),
  NamedRef: obj({ id: str, name: str }),
  Role: en('institution_admin', 'dean', 'head', 'supervision_owner', 'supervisor', 'student'),
  Me: obj({
    id: str, name: str, email: str, avatarUrl: str, isPlatformAdmin: bool, emailVerified: bool,
    memberships: arr(obj({
      workspace: obj({ id: str, name: str, type: en('institution', 'supervision'), status: en('pending_approval', 'active', 'suspended') }),
      roles: arr(obj({ role: ref('Role'), scope: obj({ type: en('faculty', 'department'), id: str, name: str }) }, ['scope'])),
      canApprove: bool,
    })),
  }, ['avatarUrl']),
  LoginResult: obj({ accessToken: str, refreshToken: str, user: ref('Me') }, ['refreshToken']),
  RefreshResult: obj({ accessToken: str, refreshToken: str }, ['refreshToken']),
  ProjectSummary: obj({
    id: str, title: str, department: nullable(ref('NamedRef')),
    status: en('active', 'on_hold', 'completed', 'cancelled'),
    health: en('on_track', 'at_risk', 'overdue', 'awaiting_review', 'completed'),
    healthReason: str,
    currentPhase: nullable(obj({ id: str, name: str, index: int, status: ref('PhaseStatus'), dueDate: nullable(date) })),
    phaseCount: int, phasesApproved: int, lead: nullable(ref('PersonRef')), coSupervisors: arr(ref('PersonRef')), students: arr(ref('PersonRef')),
    groupLeader: nullable(ref('PersonRef')), myRole: nullable(en('lead', 'co_supervisor', 'student')),
    flags: arr(en('approval_blocked', 'needs_supervisor')),
  }, ['healthReason']),
  PhaseStatus: en('locked', 'open', 'submitted', 'changes_requested', 'approved'),
  Capabilities: obj({
    seesContent: bool, seesSupervisorOnly: bool, canComment: bool, canReview: bool, canApprove: bool, canSubmit: bool,
    canUpload: bool, canRequestExtension: bool, canLogTime: bool, canOverride: bool, canManageGroup: bool, canEditTimeline: bool,
  }),
  Phase: obj({
    id: str, name: str, description: str,
    requirements: arr(obj({ id: str, name: str, optional: bool })),
    resources: arr(obj({ id: str, name: str, kind: en('file', 'link'), url: str, sizeKb: int, addedBy: ref('PersonRef'), addedAt: dateTime }, ['sizeKb'])),
    index: int, status: ref('PhaseStatus'), dueDate: nullable(date), latestVersion: nullable(int), approvedAt: nullable(dateTime), approvedBy: nullable(ref('PersonRef')), extensionPending: bool,
  }),
  ProjectDetail: {
    allOf: [ref('ProjectSummary'), obj({
      description: str, startDate: date, unlockRule: en('on_submit', 'on_approval'), submissionMode: en('leader_only', 'any_member'),
      aiStudentFeedback: bool, aiSupervisorSummary: bool, phases: arr(ref('Phase')),
      supervisors: arr(obj({ id: str, name: str, avatarUrl: str, email: str, role: en('lead', 'co_supervisor'), canApprove: bool, isSuccessor: bool }, ['avatarUrl', 'email'])),
      driveFolderUrl: nullable(str), viewer: ref('Capabilities'), version: int,
    })],
  },
  DriveFile: obj({ id: str, name: str, requirementId: str, mimeType: str, sizeKb: int, driveUrl: str, uploadedBy: ref('PersonRef'), uploadedAt: dateTime }, ['requirementId']),
  Submission: obj({
    id: str, phaseId: str, phaseName: str, version: int, status: en('submitted', 'changes_requested', 'approved'), submittedBy: ref('PersonRef'), submittedAt: dateTime, note: str,
    files: arr(ref('DriveFile')),
    aiFeedback: nullable(obj({ strengths: arr(str), improvements: arr(str), rubric: arr(obj({ criterion: str, met: bool })) })),
    aiSummary: nullable(obj({ keyPoints: arr(str), changes: arr(str) })),
    review: nullable(obj({ decision: en('approved', 'changes_requested'), by: ref('PersonRef'), actingRole: str, comment: str, at: dateTime })),
  }),
  ReviewItem: obj({
    id: str, project: ref('NamedRef'), phase: ref('NamedRef'), version: int, status: en('submitted', 'changes_requested', 'approved'),
    submittedBy: ref('PersonRef'), submittedAt: dateTime, dueDate: nullable(date), aiSummaryReady: bool, approvalBlocked: bool,
  }),
  Comment: obj({
    id: str, author: ref('PersonRef'), actingRole: str, body: str, at: dateTime,
    target: obj({ type: en('project', 'phase', 'submission'), id: str, label: str }), supervisorsOnly: bool,
    replies: arr(obj({ id: str, author: ref('PersonRef'), actingRole: str, body: str, at: dateTime, supervisorsOnly: bool })),
  }),
  TimeLog: obj({ id: str, person: ref('PersonRef'), kind: en('hours', 'meeting'), hours: num, note: str, date }),
  ActivityEntry: obj({
    id: str, occurredAt: dateTime, projectId: str, actorName: str, actingRole: str,
    category: en('submissions', 'reviews', 'ai', 'timeline', 'project', 'people', 'governance', 'drive', 'collaboration', 'time'),
    action: str, targetLabel: str, phaseId: str, reason: str, before: str, after: str, isOverride: bool,
  }, ['projectId', 'phaseId', 'reason', 'before', 'after', 'isOverride']),
  CalendarEvent: obj({ id: str, date, kind: en('deadline', 'meeting'), projectId: str, projectTitle: str, phaseId: str, title: str, status: ref('PhaseStatus') }, ['phaseId', 'status']),
  Notification: obj({ id: str, kind: str, title: str, body: str, link: nullable(str), read: bool, createdAt: dateTime, data: nullable({ type: 'object' }) }),
  ReportSummary: obj({
    health: { type: 'object', additionalProperties: int }, projectsByStatus: { type: 'object', additionalProperties: int },
    phasesApproved: int, firstReviewApprovalRate: num, filesUploaded: int, comments: int,
    submissionsByDay: arr(obj({ date, submissions: int })),
    workload: arr(obj({ supervisor: ref('PersonRef'), projects: int, pendingReviews: int, avgTurnaroundDays: num })),
    deanOverridesOnOwnProjects: int,
  }),
  Faculty: obj({ id: str, name: str, dean: nullable(ref('PersonRef')), departments: int, supervisors: int, students: int, activeProjects: int }),
  Department: obj({ id: str, name: str, faculty: ref('NamedRef'), head: nullable(ref('PersonRef')), supervisors: int, students: int, activeProjects: int }),
  Member: obj({
    id: str, name: str, email: str, avatarUrl: str, department: ref('NamedRef'), faculty: ref('NamedRef'), canApprove: bool, studentId: str,
    status: en('active', 'invited', 'deactivated'), activeProjects: int, titles: arr(str),
  }, ['avatarUrl', 'department', 'faculty', 'canApprove', 'studentId']),
  SupervisorOverview: obj({ supervisor: ref('Member'), projects: arr({ allOf: [ref('ProjectSummary'), obj({ roleOnProject: en('lead', 'co_supervisor') })] }), pendingReviews: int, avgTurnaroundDays: nullable(num) }),
  PhaseTemplate: obj({ id: str, name: str, phases: arr(obj({ name: str, durationDays: int })) }),
  Profile: obj({ name: str, email: str, title: str, phone: str, studentId: str, batch: str, researchInterests: str, officeHours: str, bio: str, avatarUrl: nullable(str) }),
  Security: obj({
    passwordChangedAt: nullable(dateTime), googleLinked: bool, pendingEmail: nullable(str),
    sessions: arr(obj({ id: str, device: str, location: str, lastActiveAt: dateTime, current: bool })),
  }),
  NotificationPrefs: obj({
    events: { type: 'object', additionalProperties: obj({ email: bool, inApp: bool }) }, delivery: en('instant', 'daily', 'weekly'), reminderDays: int,
  }),
  Preferences: obj({ timeZone: str, weekStartsOn: en('saturday', 'sunday', 'monday') }),
  SupervisionDefaults: obj({ unlockRule: en('on_submit', 'on_approval'), submissionMode: en('leader_only', 'any_member'), aiStudentFeedback: bool, aiRelease: en('immediate', 'after_review'), aiSupervisorSummary: bool, reviewWithinDays: int }),
  DriveConnection: obj({ status: en('connected', 'disconnected', 'error'), account: nullable(str), rootFolder: nullable(str), usedGb: num, quotaGb: num, connectedAt: nullable(dateTime), error: nullable(str) }),
  WorkspaceSettings: obj({
    name: str, shortName: str, logoUrl: nullable(str), newSupervisorsCanApprove: bool, supervisorsCanCreateProjects: bool, aiEnabled: bool,
    aiMonthlyBudgetUsd: num, aiSpentUsd: num, allowedFileTypes: arr(str), maxFileMb: int, atRiskAfterDays: int, escalateOverdueAfterDays: int,
    currentTerm: obj({ name: str, start: str, end: str }),
  }),
  Invite: obj({ id: str, workspaceName: str, role: str, invitedBy: str, expiresAt: dateTime }),
  AdminInstitution: obj({
    id: str, name: str, type: en('institution', 'supervision'), status: en('pending_approval', 'active', 'suspended'), createdAt: dateTime,
    plan: nullable(obj({ key: str, name: str })), members: int, projects: int, admins: arr(obj({ name: str, email: str })),
  }),
  AdminJob: obj({ id: str, kind: str, status: str, attempts: int, maxAttempts: int, lastError: nullable(str), runAt: dateTime, createdAt: dateTime, finishedAt: nullable(dateTime), workspaceId: nullable(str) }),
}

/** `METHOD /path` (as registered, with {param} placeholders) -> response schema. */
export const RESPONSES: Record<string, { status?: number; schema: S }> = {
  'POST /api/v1/auth/login': { status: 200, schema: ref('LoginResult') },
  'POST /api/v1/auth/refresh': { status: 200, schema: ref('RefreshResult') },
  'POST /api/v1/auth/invites/{token}/accept': { status: 200, schema: ref('LoginResult') },
  'GET /api/v1/me': { schema: ref('Me') },
  'GET /api/v1/me/profile': { schema: ref('Profile') },
  'GET /api/v1/me/security': { schema: ref('Security') },
  'GET /api/v1/me/notification-preferences': { schema: ref('NotificationPrefs') },
  'GET /api/v1/me/preferences': { schema: ref('Preferences') },
  'GET /api/v1/me/supervision-defaults': { schema: ref('SupervisionDefaults') },
  'GET /api/v1/me/invites': { schema: arr(ref('Invite')) },
  'POST /api/v1/integrations/google-drive/connect': { status: 200, schema: obj({ authorizeUrl: str }) },
  'POST /api/v1/auth/google/start': { status: 200, schema: obj({ authorizeUrl: str }) },
  'POST /api/v1/auth/google/link': { status: 200, schema: obj({ authorizeUrl: str }) },
  'GET /api/v1/integrations/google-drive': { schema: ref('DriveConnection') },
  'GET /api/v1/workspaces/{id}/settings': { schema: ref('WorkspaceSettings') },
  'GET /api/v1/org/faculties': { schema: page(ref('Faculty')) },
  'GET /api/v1/org/departments': { schema: page({ oneOf: [ref('Department'), ref('NamedRef')] }) },
  'GET /api/v1/people': { schema: page(ref('Member')) },
  'GET /api/v1/phase-templates': { schema: page(ref('PhaseTemplate')) },
  'GET /api/v1/supervisors/overview': { schema: arr(ref('SupervisorOverview')) },
  'GET /api/v1/projects': { schema: page(ref('ProjectSummary')) },
  'POST /api/v1/projects': { status: 201, schema: ref('ProjectSummary') },
  'GET /api/v1/projects/{id}': { schema: ref('ProjectDetail') },
  'GET /api/v1/projects/{id}/submissions': { schema: page(ref('Submission')) },
  'GET /api/v1/projects/{id}/activity': { schema: page(ref('ActivityEntry')) },
  'GET /api/v1/phases/{id}/draft': { schema: obj({ phaseId: str, files: arr(ref('DriveFile')) }) },
  'POST /api/v1/phases/{id}/submissions': { status: 201, schema: ref('Submission') },
  'POST /api/v1/submissions/{id}/reviews': { status: 201, schema: ref('Submission') },
  'GET /api/v1/submissions': { schema: page(ref('ReviewItem')) },
  'GET /api/v1/reviews/queue': { schema: page(ref('ReviewItem')) },
  'GET /api/v1/comments': { schema: page(ref('Comment')) },
  'GET /api/v1/time-logs': { schema: page(ref('TimeLog')) },
  'GET /api/v1/activity': { schema: page(ref('ActivityEntry')) },
  'GET /api/v1/calendar': { schema: page(ref('CalendarEvent')) },
  'GET /api/v1/notifications': { schema: page(ref('Notification')) },
  'GET /api/v1/notifications/unread-count': { schema: obj({ count: int }) },
  'GET /api/v1/reports/summary': { schema: ref('ReportSummary') },
  'GET /api/v1/admin/institutions': { schema: page(ref('AdminInstitution')) },
  'GET /api/v1/admin/jobs': { schema: page(ref('AdminJob')) },
}
