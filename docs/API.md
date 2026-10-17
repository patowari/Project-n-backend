# API reference

_Generated from the OpenAPI document by `scripts/gen-api-doc.mjs`. Do not edit by hand._
Live document: `GET /api/v1/openapi.json` (when enabled). 122 operations.

## Conventions

| Topic | Rule |
|---|---|
| Base path | `/api/v1` (versioned in the path; breaking changes go to `/api/v2`) |
| Wire format | JSON, **snake_case** keys. Dates are ISO 8601; due dates are `YYYY-MM-DD`. |
| Authentication | `Authorization: Bearer <access token>` (15 min). Web: refresh via httpOnly cookie. Native clients: send `X-Client: native` and keep the refresh token in the OS keychain. |
| Tenant | `X-Workspace-Id: <uuid>` on every workspace route. A user who is not an active member gets `403 not_a_member`. |
| Lists | Cursor pagination: `?limit=&cursor=` (max 100) returns `{ items, next_cursor }`. |
| Errors | RFC 9457 problem details (`application/problem+json`): `{ type, title, status, code, detail?, errors?[], request_id }`. Branch on `code`, never on `detail`. |
| Idempotency | `Idempotency-Key` on `POST /projects` and `POST /phases/{id}/submissions`: same key + same body returns the stored result (`Idempotent-Replay: true`); same key + different body is `422 idempotency_key_reuse`. |
| Concurrency | Project edits honour `If-Match: "v<version>"` (the `ETag` of `GET /projects/{id}`), `412 version_mismatch` on conflict. State changes (submit, review, approve, extend) take row locks and answer `409` with a specific `code` to the loser of a race. |
| Rate limits | `429 rate_limited` with `Retry-After`. Auth endpoints are limited per IP and per account. |
| Request id | `X-Request-Id` is returned on every response and appears in logs and problem bodies. |

`*` after a query parameter means required. "public" means no bearer token.


## auth

| Method | Path | Success | Request body | Response | Query |
|---|---|---|---|---|---|
| POST | `/auth/sign-up` _(public)_ | 202 | `SignUpDto` |  |  |
| POST | `/auth/login` _(public)_ | 200 | `LoginDto` | `LoginResult` |  |
| POST | `/auth/refresh` _(public)_ | 200 | `NativeTokenDto` | `RefreshResult` |  |
| POST | `/auth/logout` _(public)_ | 204 | `NativeTokenDto` |  |  |
| POST | `/auth/verify-email` _(public)_ | 200 | `TokenDto` |  |  |
| POST | `/auth/resend-verification` _(public)_ | 202 |  |  |  |
| POST | `/auth/forgot-password` _(public)_ | 202 | `EmailDto` |  |  |
| POST | `/auth/reset-password` _(public)_ | 200 | `ResetPasswordDto` |  |  |
| POST | `/auth/google/start` _(public)_ | 200 | `GoogleStartDto` | `object` |  |
| POST | `/auth/google/link` | 200 |  | `object` |  |
| DELETE | `/auth/google` | 204 |  |  |  |
| GET | `/auth/invites/{token}` _(public)_ | 200 |  |  |  |
| POST | `/auth/invites/{token}/accept` _(public)_ | 200 | `AcceptInviteDto` | `LoginResult` |  |

## me

| Method | Path | Success | Request body | Response | Query |
|---|---|---|---|---|---|
| GET | `/me` | 200 |  | `Me` |  |
| GET | `/me/profile` | 200 |  | `Profile` |  |
| PATCH | `/me/profile` | 204 |  |  |  |
| GET | `/me/security` | 200 |  | `Security` |  |
| POST | `/me/password` | 204 | `ChangePasswordDto` |  |  |
| POST | `/me/email` | 202 | `ChangeEmailDto` |  |  |
| DELETE | `/me/sessions/{id}` | 204 |  |  |  |
| POST | `/me/sessions/revoke-others` | 204 |  |  |  |
| GET | `/me/notification-preferences` | 200 |  | `NotificationPrefs` |  |
| PUT | `/me/notification-preferences` | 204 |  |  |  |
| GET | `/me/preferences` | 200 |  | `Preferences` |  |
| PUT | `/me/preferences` | 204 |  |  |  |
| GET | `/me/supervision-defaults` | 200 |  | `SupervisionDefaults` |  |
| PUT | `/me/supervision-defaults` | 204 |  |  |  |
| GET | `/me/invites` | 200 |  | `object` |  |
| POST | `/invites/{id}/accept` | 204 |  |  |  |
| POST | `/invites/{id}/decline` | 204 |  |  |  |
| GET | `/me/default-workspace` | 200 |  |  |  |
| PUT | `/me/default-workspace` | 204 | `DefaultWorkspaceDto` |  |  |
| DELETE | `/workspaces/{id}/membership` | 204 |  |  |  |
| GET | `/me/data-requests` | 200 |  |  |  |
| POST | `/me/export` | 202 |  |  |  |
| POST | `/me/deletion-request` | 202 | `DeletionDto` |  |  |
| DELETE | `/me/deletion-request` | 204 |  |  |  |

## organization

| Method | Path | Success | Request body | Response | Query |
|---|---|---|---|---|---|
| GET | `/org/faculties` | 200 |  | `object` |  |
| POST | `/org/faculties` | 201 | `SaveFacultyDto` |  |  |
| PATCH | `/org/faculties/{id}` | 204 | `SaveFacultyDto` |  |  |
| DELETE | `/org/faculties/{id}` | 204 |  |  |  |
| GET | `/org/departments` | 200 |  | `object` | expand |
| POST | `/org/departments` | 201 | `SaveDepartmentDto` |  |  |
| PATCH | `/org/departments/{id}` | 204 | `SaveDepartmentDto` |  |  |
| DELETE | `/org/departments/{id}` | 204 |  |  |  |
| GET | `/people` | 200 |  | `object` | role*, expand, q |
| PATCH | `/people/{id}` | 204 | `UpdateMemberDto` |  |  |
| POST | `/people/{id}/resend-invite` | 204 |  |  |  |
| POST | `/workspaces/{id}/invites` | 201 | `InviteDto` |  |  |
| POST | `/workspaces/{id}/invites/import` | 200 | `ImportDto` |  |  |
| GET | `/workspaces/{id}/settings` | 200 |  | `WorkspaceSettings` |  |
| PATCH | `/workspaces/{id}/settings` | 204 |  |  |  |
| GET | `/phase-templates` | 200 |  | `object` |  |
| POST | `/phase-templates` | 201 | `TemplateDto` |  |  |
| PUT | `/phase-templates/{id}` | 204 | `TemplateDto` |  |  |
| DELETE | `/phase-templates/{id}` | 204 |  |  |  |

## projects

| Method | Path | Success | Request body | Response | Query |
|---|---|---|---|---|---|
| GET | `/projects` | 200 |  | `object` | scope, q, cursor, limit |
| POST | `/projects` | 201 | `CreateProjectDto` | `ProjectSummary` |  |
| GET | `/projects/{id}` | 200 |  | `ProjectDetail` |  |
| PATCH | `/projects/{id}` | 200 | `PatchProjectDto` |  |  |
| POST | `/projects/{id}/students` | 204 | `AddStudentsDto` |  |  |
| DELETE | `/projects/{id}/students/{studentId}` | 204 | `RemoveStudentDto` |  |  |
| PUT | `/projects/{id}/group-leader` | 204 | `GroupLeaderDto` |  |  |

## phases

| Method | Path | Success | Request body | Response | Query |
|---|---|---|---|---|---|
| POST | `/projects/{id}/phases` | 201 | `AddPhaseDto` |  |  |
| PATCH | `/phases/{id}` | 204 | `PatchPhaseDto` |  |  |
| DELETE | `/phases/{id}` | 204 |  |  |  |
| POST | `/phases/{id}/unlock` | 204 | `PhaseReasonDto` |  |  |
| POST | `/phases/{id}/lock` | 204 | `PhaseReasonDto` |  |  |
| POST | `/phases/{id}/resources` | 201 | `ResourceDto` |  |  |
| DELETE | `/phases/{id}/resources/{resourceId}` | 204 |  |  |  |
| GET | `/phases/{id}/draft` | 200 |  | `object` |  |
| POST | `/phases/{id}/draft/files` | 201 | `multipart/object` |  |  |
| POST | `/phases/{id}/draft/uploads` | 201 | `UploadSessionDto` |  |  |
| POST | `/phases/{id}/draft/uploads/confirm` | 201 | `ConfirmUploadDto` |  |  |
| DELETE | `/phases/{id}/draft/files/{fileId}` | 204 |  |  |  |

## workflow

| Method | Path | Success | Request body | Response | Query |
|---|---|---|---|---|---|
| POST | `/phases/{id}/submissions` | 201 | `SubmitDto` | `Submission` |  |
| GET | `/projects/{id}/submissions` | 200 |  | `object` |  |
| POST | `/submissions/{id}/reviews` | 201 | `ReviewDto` | `Submission` |  |
| POST | `/submissions/{id}/ai/release` | 204 |  |  |  |
| POST | `/phases/{id}/extensions` | 201 | `ExtensionDto` |  |  |
| POST | `/extensions/{id}/decision` | 204 | `DecisionDto` |  |  |
| GET | `/projects/{id}/extensions` | 200 |  |  |  |
| POST | `/projects/{id}/overrides` | 201 | `OverrideDto` |  |  |

## governance

| Method | Path | Success | Request body | Response | Query |
|---|---|---|---|---|---|
| POST | `/people/{id}/approval-revocations` | 201 | `RevokeDto` |  |  |
| GET | `/people/{id}/approval-revocations` | 200 |  |  |  |
| POST | `/approval-revocations/{id}/restore` | 204 | `RestoreDto` |  |  |
| GET | `/people/{id}/offboard-preview` | 200 |  |  |  |
| POST | `/people/{id}/offboard` | 200 | `OffboardDto` |  |  |
| PUT | `/projects/{id}/lead` | 204 | `LeadDto` |  |  |
| PUT | `/projects/{id}/successor` | 204 | `SuccessorDto` |  |  |
| POST | `/projects/{id}/supervisors` | 204 | `CoSupervisorDto` |  |  |
| DELETE | `/projects/{id}/supervisors/{userId}` | 204 | `OptionalReasonDto` |  |  |

## insights

| Method | Path | Success | Request body | Response | Query |
|---|---|---|---|---|---|
| GET | `/comments` | 200 |  | `object` | project_id* |
| POST | `/comments` | 201 | `CommentDto` |  |  |
| GET | `/time-logs` | 200 |  | `object` | project_id* |
| POST | `/time-logs` | 201 | `TimeLogDto` |  |  |
| GET | `/notifications` | 200 |  | `object` | unread, cursor, limit |
| GET | `/notifications/unread-count` | 200 |  | `object` |  |
| POST | `/notifications/read` | 204 | `ReadDto` |  |  |
| GET | `/activity` | 200 |  | `object` | from, to, project, person, type, department, overrides_only, cursor, limit |
| GET | `/projects/{id}/activity` | 200 |  | `object` | cursor |
| GET | `/activity/export.csv` | 200 |  |  | from, to, project, person, type, department, overrides_only |
| GET | `/calendar` | 200 |  | `object` | from*, to* |
| GET | `/reviews/queue` | 200 |  | `object` |  |
| GET | `/submissions` | 200 |  | `object` | mine |
| GET | `/reports/summary` | 200 |  | `ReportSummary` |  |
| GET | `/supervisors/overview` | 200 |  | `object` |  |

## integrations

| Method | Path | Success | Request body | Response | Query |
|---|---|---|---|---|---|
| GET | `/integrations/google-drive` | 200 |  | `DriveConnection` |  |
| DELETE | `/integrations/google-drive` | 204 |  |  |  |
| PATCH | `/integrations/google-drive` | 204 | `FolderDto` |  |  |
| POST | `/integrations/google-drive/connect` | 200 |  | `object` |  |

## admin

| Method | Path | Success | Request body | Response | Query |
|---|---|---|---|---|---|
| GET | `/admin/overview` | 200 |  |  |  |
| GET | `/admin/institutions` | 200 |  | `object` | status, type, q, cursor, limit |
| POST | `/admin/institutions` | 201 | `CreateInstitutionDto` |  |  |
| PATCH | `/admin/institutions/{id}/status` | 204 | `StatusDto` |  |  |
| PUT | `/admin/institutions/{id}/plan` | 204 | `AssignPlanDto` |  |  |
| GET | `/admin/plans` | 200 |  |  |  |
| POST | `/admin/plans` | 201 | `PlanDto` |  |  |
| PUT | `/admin/plans/{id}` | 204 | `PlanDto` |  |  |
| GET | `/admin/usage` | 200 |  |  |  |
| GET | `/admin/jobs` | 200 |  | `object` | status, limit |
| POST | `/admin/jobs/{id}/retry` | 204 |  |  |  |
