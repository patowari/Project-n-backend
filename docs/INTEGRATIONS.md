# Integrations

Each integration sits behind a **port** with two adapters. Development, tests and CI use the fake; production uses the real one.

| Port | Real adapter | Fake adapter | Selected by | Real adapter exercised against the live service? |
|---|---|---|---|---|
| `DrivePort` | `GoogleDriveGateway` (Drive v3 over HTTPS, `drive.file` scope) | `FakeDriveGateway` (in memory, behaves like Drive for folders, resumable sessions, revoked tokens) | `DRIVE_DRIVER=google\|fake` | **No** (no credentials available) |
| `IdentityPort` | `GoogleIdentityGateway` (OpenID Connect, `openid email profile`) | `FakeIdentityGateway` (the code carries the identity, so tests can play any Google account) | `DRIVE_DRIVER=google\|fake` (same switch, same OAuth client) | **No** (no credentials available) |
| `AiPort` | `GeminiAi` (REST, JSON schema output) | `FakeAi` (deterministic) | `AI_DRIVER=gemini\|fake` | **No** |
| `MailerPort` | `ResendMailer` | `LogMailer` (captures messages) | `MAIL_DRIVER=resend\|log` | **No** |
| Rust helper | `pn-doc-tools` | — | `DOC_TOOLS_BIN` | **Yes** (used by the AI tests) |

Because the real adapters were written against the providers' documented APIs but never run here, treat each one as **unverified until its checklist below is done once in a staging environment.**

## Google Drive

Why: the platform must not hold student files (liability and cost), so files live in the **Lead supervisor's** Drive. We store the file id and metadata only. Scope `drive.file` means the app can touch only files and folders it created, never the rest of the Drive.

Setup:

1. Google Cloud console → create a project → enable **Google Drive API**.
2. OAuth consent screen: external or internal (for a Google Workspace institution), scopes `openid`, `email`, `…/auth/drive.file`. `drive.file` is not a restricted scope.
3. Credentials → OAuth client ID (Web). Authorised redirect URI: `${GOOGLE_OAUTH_REDIRECT_BASE}/integrations/google-drive/callback`, for example `https://api.example.com/api/v1/integrations/google-drive/callback`.
4. Set `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_BASE`, `DRIVE_DRIVER=google`.
5. If the institution uses Google Workspace, its admin must allow the OAuth client (Admin console → Security → API controls).

Flow implemented: `POST /integrations/google-drive/connect` returns the Google URL (state + PKCE verifier kept in Redis for 10 minutes); Google redirects the browser to the callback; the refresh token is encrypted (AES-256-GCM) and stored; the app redirects to `${APP_BASE_URL}/settings/integrations?drive=connected`. Uploads: `POST /phases/{id}/draft/uploads` returns a resumable URL created with the caller's `Origin` so the browser can `PUT` bytes straight to Google; `…/uploads/confirm` verifies the file with Drive before recording it. Small files may also be posted to `…/draft/files` (multipart).

**Verification checklist (do once in staging):**

- [ ] Connect succeeds; the "Project N" root folder appears in the supervisor's Drive.
- [ ] A student upload (small, multipart) lands in `Project N / <workspace> / <project> / 01 <phase> / v1`.
- [ ] A 30 MB file via the resumable session works from a browser origin listed in `CORS_ORIGINS` (checks the `Origin` header handling).
- [ ] `confirm` rejects a file id that was never uploaded.
- [ ] Revoke the app in the Google account → next call answers `409 drive_disconnected`, the Settings page shows "error", the supervisor is notified.
- [ ] Changing members runs `drive.sync_permissions`: co-supervisors become writers, students readers; removed people lose access.
- [ ] A supervisor whose Drive is full gets `507 drive_quota_exceeded` on upload.
- [ ] Deleting a file in Drive is flagged by `drive.verify_files` the next night.

**Known gaps:** ownership transfer / folder copy on Lead change (decision D1) is not implemented; existing files stay in the former Lead's Drive (co-supervisors already have writer access) and new versions go to the new Lead's Drive.

## Google sign-in and sign-up

Separate from the Drive connection on purpose: sign-in asks only for `openid email profile` (name and verified e-mail), so anyone can use it; the Drive connection asks for `drive.file` and is only for supervisors. A person can do either, both, or neither.

Setup (same OAuth client as Drive; add one more redirect URI):

1. OAuth consent screen: add the scopes `openid`, `email`, `profile`.
2. Authorised redirect URIs: add `${GOOGLE_OAUTH_REDIRECT_BASE}/auth/google/callback` next to the Drive one (for local development: `http://localhost:8000/api/v1/auth/google/callback`).
3. Env as for Drive (`DRIVE_DRIVER=google`, client id and secret). `APP_BASE_URL` must be the dashboard's address: the callback sends the browser to `${APP_BASE_URL}/google-callback`.

Endpoints: `POST /auth/google/start` (public; `mode` is `sign_in` or `sign_up`, sign-up also takes `workspace_type` and `workspace_name`, optional relative `next`), `GET /auth/google/callback` (Google redirects here), `POST /auth/google/link` and `DELETE /auth/google` (signed-in users, from Settings → Security).

Rules (all tested against the fake provider, `test/google-auth.e2e-spec.ts`):

* An account is identified by Google's `sub`, never by e-mail alone. Google must report the e-mail as verified.
* First Google sign-in with an e-mail that already has an account links it. If that account's e-mail had never been verified, its password is removed and its sessions revoked (a person who pre-registered someone else's address cannot keep access).
* An account linked to one Google account is never silently re-linked to another.
* Sign-in does not create accounts (`no_account`); sign-up does, with the same workspace rules as e-mail sign-up (Supervision active at once, Institution waits for approval). Google users start with a verified e-mail and no password; they can set one with "Forgot password".
* Unlinking is refused until a password exists (`409 password_required`).
* State (10 minutes, single use), PKCE and nonce protect the redirect; `next` accepts only same-site relative paths.
* The session is delivered in the same httpOnly refresh cookie as password sign-in; web only. Native apps (React Native, Tauri) would need the system-browser flow with a custom-scheme redirect, which is not implemented.

**Verification checklist (do once in staging):**

- [ ] "Continue with Google" for a new address with sign-up creates the workspace and lands on Settings → Integrations.
- [ ] Sign-in with a Google account whose e-mail matches a password account links it; password sign-in still works.
- [ ] A Google account with an unverified e-mail is refused.
- [ ] Unlinking works for an account with a password and is refused for a Google-only one.
- [ ] Redirect URI mismatch shows Google's own error page (confirms the URI registered in the console is exactly the one the app sends).

## Gemini (AI feedback)

* Use the **paid** API tier (prompts are not used for training). Set `AI_DRIVER=gemini`, `GEMINI_API_KEY`, `GEMINI_MODEL`.
* Per call, the worker sends the phase brief, rubric (the phase's required documents), the file contents (PDF/images inline, DOCX/text as extracted text) and, for later versions, the names of the previous version's files. It receives JSON validated against a fixed schema and clipped before storage.
* Cost is estimated from token counts: `AI_PRICE_IN_PER_M` / `AI_PRICE_OUT_PER_M` (USD per million tokens, defaults are placeholders — set them from the current price list). The monthly budget per workspace is checked **before** each call.

**Verification checklist:**

- [ ] A PDF and a DOCX submission both produce non-empty `student_feedback` and `supervisor_summary`.
- [ ] A hostile document ("ignore previous instructions…") yields normal, schema-valid output.
- [ ] 429/5xx from the provider are retried; a 4xx ends as `failed` without retry loops.
- [ ] Token counts in `ai_usage` match the provider's dashboard within a few percent.

## Resend (e-mail)

* Verify the sending domain (SPF, DKIM, DMARC), set `MAIL_DRIVER=resend`, `RESEND_API_KEY`, `EMAIL_FROM`.
* Every message carries an `Idempotency-Key` (the job id), so a retried job cannot send twice within the provider's window.
* Security mail (verification, reset, password changed, invite) always sends. Other categories follow each user's preferences; digests are sent at 08:00 in the user's time zone.

**Not implemented:** bounce/complaint webhooks to mark addresses undeliverable; provider daily-cap awareness for bulk invites (invites are queued and drain at worker pace).

**Verification checklist:** [ ] a verification mail arrives and its link works; [ ] a 5xx/429 is retried (turn the key off briefly); [ ] a rejected recipient (4xx) ends the job as dead, visible under Admin → Failed jobs.

## Rust helper

Build: `cargo build --release --manifest-path rust/doc-tools/Cargo.toml`; the Dockerfile builds it and copies it to `/usr/local/bin/pn-doc-tools`. `DOC_TOOLS_BIN` overrides the path. If the binary is missing the worker logs a warning and reviews the submission without DOCX text (never fails the submission).
