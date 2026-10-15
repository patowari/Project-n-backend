-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "workspace_type" AS ENUM ('institution', 'supervision');

-- CreateEnum
CREATE TYPE "workspace_status" AS ENUM ('pending_approval', 'active', 'suspended');

-- CreateEnum
CREATE TYPE "workspace_role" AS ENUM ('institution_admin', 'dean', 'head', 'supervision_owner', 'supervisor', 'student');

-- CreateEnum
CREATE TYPE "scope_type" AS ENUM ('faculty', 'department');

-- CreateEnum
CREATE TYPE "membership_status" AS ENUM ('invited', 'active', 'deactivated');

-- CreateEnum
CREATE TYPE "invite_status" AS ENUM ('pending', 'accepted', 'declined', 'revoked');

-- CreateEnum
CREATE TYPE "user_status" AS ENUM ('active', 'deactivated');

-- CreateEnum
CREATE TYPE "auth_token_kind" AS ENUM ('verify_email', 'reset_password', 'change_email');

-- CreateEnum
CREATE TYPE "project_role" AS ENUM ('lead', 'co_supervisor', 'student');

-- CreateEnum
CREATE TYPE "project_status" AS ENUM ('active', 'on_hold', 'completed', 'cancelled');

-- CreateEnum
CREATE TYPE "project_health" AS ENUM ('on_track', 'at_risk', 'overdue', 'awaiting_review', 'completed');

-- CreateEnum
CREATE TYPE "phase_status" AS ENUM ('locked', 'open', 'submitted', 'changes_requested', 'approved');

-- CreateEnum
CREATE TYPE "unlock_rule" AS ENUM ('on_submit', 'on_approval');

-- CreateEnum
CREATE TYPE "submission_mode" AS ENUM ('leader_only', 'any_member');

-- CreateEnum
CREATE TYPE "submission_status" AS ENUM ('submitted', 'changes_requested', 'approved');

-- CreateEnum
CREATE TYPE "review_decision" AS ENUM ('approved', 'changes_requested');

-- CreateEnum
CREATE TYPE "ai_status" AS ENUM ('disabled', 'queued', 'processing', 'ready', 'failed', 'skipped_budget');

-- CreateEnum
CREATE TYPE "revocation_scope" AS ENUM ('project', 'faculty');

-- CreateEnum
CREATE TYPE "override_kind" AS ENUM ('approve_phase', 'reopen_phase', 'move_deadline', 'put_on_hold', 'resume', 'complete', 'cancel');

-- CreateEnum
CREATE TYPE "extension_status" AS ENUM ('pending', 'approved', 'rejected');

-- CreateEnum
CREATE TYPE "comment_target_type" AS ENUM ('project', 'phase', 'submission');

-- CreateEnum
CREATE TYPE "time_log_kind" AS ENUM ('hours', 'meeting');

-- CreateEnum
CREATE TYPE "activity_category" AS ENUM ('submissions', 'reviews', 'ai', 'timeline', 'project', 'people', 'governance', 'drive', 'collaboration', 'time');

-- CreateEnum
CREATE TYPE "activity_visibility" AS ENUM ('all', 'supervisors', 'leadership');

-- CreateEnum
CREATE TYPE "job_status" AS ENUM ('queued', 'running', 'succeeded', 'failed', 'dead');

-- CreateEnum
CREATE TYPE "drive_status" AS ENUM ('connected', 'disconnected', 'error');

-- CreateEnum
CREATE TYPE "idempotency_state" AS ENUM ('in_progress', 'completed');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "password_hash" TEXT,
    "email_verified_at" TIMESTAMPTZ(6),
    "is_platform_admin" BOOLEAN NOT NULL DEFAULT false,
    "status" "user_status" NOT NULL DEFAULT 'active',
    "avatar_url" TEXT,
    "title" TEXT NOT NULL DEFAULT '',
    "phone" TEXT NOT NULL DEFAULT '',
    "profile" JSONB NOT NULL DEFAULT '{}',
    "notification_prefs" JSONB NOT NULL DEFAULT '{}',
    "preferences" JSONB NOT NULL DEFAULT '{}',
    "supervision_defaults" JSONB NOT NULL DEFAULT '{}',
    "failed_login_count" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(6),
    "password_changed_at" TIMESTAMPTZ(6),
    "default_workspace_id" UUID,
    "deletion_requested_at" TIMESTAMPTZ(6),
    "deletion_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "device_label" TEXT NOT NULL DEFAULT 'Unknown device',
    "ip" TEXT,
    "user_agent" TEXT,
    "location" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(6),
    "revoked_reason" TEXT,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "session_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "issued_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "replaced_by_id" UUID,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_tokens" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "kind" "auth_token_kind" NOT NULL,
    "token_hash" TEXT NOT NULL,
    "payload" JSONB,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plans" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ai_monthly_budget_usd" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "max_users" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspaces" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "short_name" TEXT NOT NULL DEFAULT '',
    "type" "workspace_type" NOT NULL,
    "status" "workspace_status" NOT NULL DEFAULT 'active',
    "plan_id" UUID,
    "time_zone" TEXT NOT NULL DEFAULT 'Asia/Dhaka',
    "logo_url" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "workspaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_settings" (
    "workspace_id" UUID NOT NULL,
    "new_supervisors_can_approve" BOOLEAN NOT NULL DEFAULT false,
    "supervisors_can_create_projects" BOOLEAN NOT NULL DEFAULT true,
    "ai_enabled" BOOLEAN NOT NULL DEFAULT true,
    "ai_monthly_budget_usd" DECIMAL(10,2) NOT NULL DEFAULT 5,
    "allowed_file_types" TEXT[] DEFAULT ARRAY['pdf', 'docx', 'pptx', 'xlsx', 'zip', 'png', 'jpg', 'txt']::TEXT[],
    "max_file_mb" INTEGER NOT NULL DEFAULT 50,
    "max_files_per_submission" INTEGER NOT NULL DEFAULT 10,
    "at_risk_after_days" INTEGER NOT NULL DEFAULT 14,
    "awaiting_review_after_days" INTEGER NOT NULL DEFAULT 3,
    "escalate_overdue_after_days" INTEGER NOT NULL DEFAULT 3,
    "default_submission_mode" "submission_mode" NOT NULL DEFAULT 'leader_only',
    "default_unlock_rule" "unlock_rule" NOT NULL DEFAULT 'on_submit',
    "term" JSONB NOT NULL DEFAULT '{}',
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "workspace_settings_pkey" PRIMARY KEY ("workspace_id")
);

-- CreateTable
CREATE TABLE "faculties" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "faculties_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "departments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "faculty_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "departments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memberships" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "status" "membership_status" NOT NULL DEFAULT 'active',
    "can_approve" BOOLEAN NOT NULL DEFAULT false,
    "department_id" UUID,
    "student_code" TEXT,
    "joined_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "membership_roles" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "membership_id" UUID NOT NULL,
    "role" "workspace_role" NOT NULL,
    "scope_type" "scope_type",
    "scope_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "membership_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invites" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "role" "workspace_role" NOT NULL,
    "scope_type" "scope_type",
    "scope_id" UUID,
    "department_id" UUID,
    "student_code" TEXT,
    "can_approve" BOOLEAN,
    "token_hash" TEXT NOT NULL,
    "status" "invite_status" NOT NULL DEFAULT 'pending',
    "invited_by_id" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "accepted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "department_id" UUID,
    "status" "project_status" NOT NULL DEFAULT 'active',
    "health" "project_health" NOT NULL DEFAULT 'on_track',
    "health_reason" TEXT,
    "health_updated_at" TIMESTAMPTZ(6),
    "unlock_rule" "unlock_rule" NOT NULL DEFAULT 'on_submit',
    "submission_mode" "submission_mode" NOT NULL DEFAULT 'leader_only',
    "ai_student_feedback" BOOLEAN NOT NULL DEFAULT true,
    "ai_supervisor_summary" BOOLEAN NOT NULL DEFAULT true,
    "start_date" DATE NOT NULL,
    "needs_supervisor" BOOLEAN NOT NULL DEFAULT false,
    "drive_folder_id" TEXT,
    "drive_folder_url" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_members" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "project_role" NOT NULL,
    "is_group_leader" BOOLEAN NOT NULL DEFAULT false,
    "is_successor" BOOLEAN NOT NULL DEFAULT false,
    "joined_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "left_at" TIMESTAMPTZ(6),
    "left_reason" TEXT,

    CONSTRAINT "project_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "phase_templates" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "phase_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "phase_template_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "template_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "duration_days" INTEGER NOT NULL,

    CONSTRAINT "phase_template_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "phases" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "status" "phase_status" NOT NULL DEFAULT 'locked',
    "due_date" DATE,
    "latest_version" INTEGER NOT NULL DEFAULT 0,
    "approved_at" TIMESTAMPTZ(6),
    "approved_by_id" UUID,
    "approved_by_role" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "phases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "phase_requirements" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "phase_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "optional" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "phase_requirements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "phase_resources" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "phase_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "size_kb" INTEGER,
    "added_by_id" UUID NOT NULL,
    "added_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "phase_resources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "draft_files" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "phase_id" UUID NOT NULL,
    "requirement_id" UUID,
    "name" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "drive_file_id" TEXT NOT NULL,
    "drive_url" TEXT NOT NULL,
    "md5" TEXT,
    "uploaded_by_id" UUID NOT NULL,
    "uploaded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "draft_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "submissions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "phase_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "submission_status" NOT NULL DEFAULT 'submitted',
    "submitted_by_id" UUID NOT NULL,
    "submitted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT NOT NULL DEFAULT '',
    "idempotency_key" TEXT,
    "ai_status" "ai_status" NOT NULL DEFAULT 'disabled',
    "ai_released" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "submissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "submission_files" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "submission_id" UUID NOT NULL,
    "requirement_id" UUID,
    "name" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "drive_file_id" TEXT NOT NULL,
    "drive_url" TEXT NOT NULL,
    "md5" TEXT,
    "uploaded_by_id" UUID NOT NULL,
    "uploaded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "missing_in_drive" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "submission_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reviews" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "submission_id" UUID NOT NULL,
    "decision" "review_decision" NOT NULL,
    "comment" TEXT NOT NULL DEFAULT '',
    "reviewer_id" UUID NOT NULL,
    "acting_role" TEXT NOT NULL,
    "is_override" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_reviews" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "submission_id" UUID NOT NULL,
    "student_feedback" JSONB,
    "supervisor_summary" JSONB,
    "model" TEXT,
    "error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_usage" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "project_id" UUID,
    "submission_id" UUID,
    "model" TEXT NOT NULL,
    "tokens_in" INTEGER NOT NULL DEFAULT 0,
    "tokens_out" INTEGER NOT NULL DEFAULT 0,
    "cost_usd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "job_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_usage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_revocations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "scope" "revocation_scope" NOT NULL,
    "project_id" UUID,
    "faculty_id" UUID,
    "reason" TEXT NOT NULL,
    "revoked_by_id" UUID NOT NULL,
    "revoked_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "restored_at" TIMESTAMPTZ(6),
    "restored_by_id" UUID,
    "restore_reason" TEXT,

    CONSTRAINT "approval_revocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "overrides" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "phase_id" UUID,
    "kind" "override_kind" NOT NULL,
    "reason" TEXT NOT NULL,
    "actor_id" UUID NOT NULL,
    "actor_role" TEXT NOT NULL,
    "actor_is_supervisor" BOOLEAN NOT NULL DEFAULT false,
    "before" JSONB,
    "after" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "overrides_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "extension_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "phase_id" UUID NOT NULL,
    "requested_by_id" UUID NOT NULL,
    "until" DATE NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "extension_status" NOT NULL DEFAULT 'pending',
    "decided_by_id" UUID,
    "decided_at" TIMESTAMPTZ(6),
    "decision_note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "extension_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "comments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "author_id" UUID NOT NULL,
    "acting_role" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "target_type" "comment_target_type" NOT NULL,
    "target_id" UUID NOT NULL,
    "target_label" TEXT NOT NULL DEFAULT '',
    "parent_id" UUID,
    "supervisors_only" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "comment_mentions" (
    "workspace_id" UUID NOT NULL,
    "comment_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,

    CONSTRAINT "comment_mentions_pkey" PRIMARY KEY ("comment_id","user_id")
);

-- CreateTable
CREATE TABLE "time_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "kind" "time_log_kind" NOT NULL,
    "hours" DECIMAL(5,2) NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "date" DATE NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "time_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID,
    "user_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL DEFAULT '',
    "link" TEXT,
    "data" JSONB,
    "read_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "activity_log" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "faculty_id" UUID,
    "department_id" UUID,
    "project_id" UUID,
    "phase_id" UUID,
    "actor_id" UUID,
    "actor_name" TEXT NOT NULL,
    "acting_role" TEXT NOT NULL,
    "category" "activity_category" NOT NULL,
    "action" TEXT NOT NULL,
    "target_type" TEXT,
    "target_id" UUID,
    "target_label" TEXT NOT NULL DEFAULT '',
    "before" TEXT,
    "after" TEXT,
    "reason" TEXT,
    "is_override" BOOLEAN NOT NULL DEFAULT false,
    "visibility" "activity_visibility" NOT NULL DEFAULT 'all',

    CONSTRAINT "activity_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID,
    "actor_id" UUID,
    "action" TEXT NOT NULL,
    "target_type" TEXT,
    "target_id" TEXT,
    "ip" TEXT,
    "user_agent" TEXT,
    "data" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "google_drive_connections" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "google_email" TEXT NOT NULL,
    "refresh_token_enc" BYTEA NOT NULL,
    "key_id" TEXT NOT NULL,
    "status" "drive_status" NOT NULL DEFAULT 'connected',
    "root_folder_name" TEXT NOT NULL DEFAULT 'Project N',
    "root_folder_id" TEXT,
    "error" TEXT,
    "connected_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "google_drive_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jobs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "workspace_id" UUID,
    "run_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 5,
    "status" "job_status" NOT NULL DEFAULT 'queued',
    "locked_at" TIMESTAMPTZ(6),
    "locked_by" TEXT,
    "last_error" TEXT,
    "dedupe_key" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(6),

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_keys" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "state" "idempotency_state" NOT NULL DEFAULT 'in_progress',
    "response_status" INTEGER,
    "response_body" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "sessions_user_id_revoked_at_idx" ON "sessions"("user_id", "revoked_at");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_tokens_session_id_idx" ON "refresh_tokens"("session_id");

-- CreateIndex
CREATE INDEX "refresh_tokens_expires_at_idx" ON "refresh_tokens"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "auth_tokens_token_hash_key" ON "auth_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "auth_tokens_user_id_kind_idx" ON "auth_tokens"("user_id", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "plans_key_key" ON "plans"("key");

-- CreateIndex
CREATE UNIQUE INDEX "faculties_workspace_id_id_key" ON "faculties"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "faculties_workspace_id_name_key" ON "faculties"("workspace_id", "name");

-- CreateIndex
CREATE INDEX "departments_workspace_id_faculty_id_idx" ON "departments"("workspace_id", "faculty_id");

-- CreateIndex
CREATE UNIQUE INDEX "departments_workspace_id_id_key" ON "departments"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "departments_workspace_id_faculty_id_name_key" ON "departments"("workspace_id", "faculty_id", "name");

-- CreateIndex
CREATE INDEX "memberships_user_id_idx" ON "memberships"("user_id");

-- CreateIndex
CREATE INDEX "memberships_workspace_id_department_id_idx" ON "memberships"("workspace_id", "department_id");

-- CreateIndex
CREATE UNIQUE INDEX "memberships_workspace_id_id_key" ON "memberships"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "memberships_workspace_id_user_id_key" ON "memberships"("workspace_id", "user_id");

-- CreateIndex
CREATE INDEX "membership_roles_workspace_id_membership_id_idx" ON "membership_roles"("workspace_id", "membership_id");

-- CreateIndex
CREATE INDEX "membership_roles_workspace_id_role_scope_id_idx" ON "membership_roles"("workspace_id", "role", "scope_id");

-- CreateIndex
CREATE UNIQUE INDEX "membership_roles_workspace_id_id_key" ON "membership_roles"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "invites_token_hash_key" ON "invites"("token_hash");

-- CreateIndex
CREATE INDEX "invites_workspace_id_email_status_idx" ON "invites"("workspace_id", "email", "status");

-- CreateIndex
CREATE UNIQUE INDEX "invites_workspace_id_id_key" ON "invites"("workspace_id", "id");

-- CreateIndex
CREATE INDEX "projects_workspace_id_status_health_idx" ON "projects"("workspace_id", "status", "health");

-- CreateIndex
CREATE INDEX "projects_workspace_id_department_id_idx" ON "projects"("workspace_id", "department_id");

-- CreateIndex
CREATE INDEX "projects_workspace_id_created_by_id_idx" ON "projects"("workspace_id", "created_by_id");

-- CreateIndex
CREATE INDEX "projects_workspace_id_created_at_idx" ON "projects"("workspace_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "projects_workspace_id_id_key" ON "projects"("workspace_id", "id");

-- CreateIndex
CREATE INDEX "project_members_workspace_id_project_id_idx" ON "project_members"("workspace_id", "project_id");

-- CreateIndex
CREATE INDEX "project_members_workspace_id_user_id_idx" ON "project_members"("workspace_id", "user_id");

-- CreateIndex
CREATE INDEX "project_members_project_id_idx" ON "project_members"("project_id");

-- CreateIndex
CREATE INDEX "project_members_user_id_idx" ON "project_members"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "project_members_workspace_id_id_key" ON "project_members"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "phase_templates_workspace_id_id_key" ON "phase_templates"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "phase_templates_workspace_id_name_key" ON "phase_templates"("workspace_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "phase_template_items_template_id_position_key" ON "phase_template_items"("template_id", "position");

-- CreateIndex
CREATE INDEX "phases_workspace_id_due_date_idx" ON "phases"("workspace_id", "due_date");

-- CreateIndex
CREATE UNIQUE INDEX "phases_workspace_id_id_key" ON "phases"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "phases_project_id_position_key" ON "phases"("project_id", "position");

-- CreateIndex
CREATE INDEX "phase_requirements_workspace_id_phase_id_idx" ON "phase_requirements"("workspace_id", "phase_id");

-- CreateIndex
CREATE UNIQUE INDEX "phase_requirements_workspace_id_id_key" ON "phase_requirements"("workspace_id", "id");

-- CreateIndex
CREATE INDEX "phase_resources_workspace_id_phase_id_idx" ON "phase_resources"("workspace_id", "phase_id");

-- CreateIndex
CREATE UNIQUE INDEX "phase_resources_workspace_id_id_key" ON "phase_resources"("workspace_id", "id");

-- CreateIndex
CREATE INDEX "draft_files_workspace_id_phase_id_idx" ON "draft_files"("workspace_id", "phase_id");

-- CreateIndex
CREATE INDEX "draft_files_project_id_uploaded_at_idx" ON "draft_files"("project_id", "uploaded_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "draft_files_workspace_id_id_key" ON "draft_files"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "draft_files_phase_id_drive_file_id_key" ON "draft_files"("phase_id", "drive_file_id");

-- CreateIndex
CREATE INDEX "submissions_workspace_id_project_id_submitted_at_idx" ON "submissions"("workspace_id", "project_id", "submitted_at" DESC);

-- CreateIndex
CREATE INDEX "submissions_workspace_id_status_submitted_at_idx" ON "submissions"("workspace_id", "status", "submitted_at");

-- CreateIndex
CREATE INDEX "submissions_project_id_submitted_at_idx" ON "submissions"("project_id", "submitted_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "submissions_workspace_id_id_key" ON "submissions"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "submissions_phase_id_version_key" ON "submissions"("phase_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "submissions_workspace_id_submitted_by_id_idempotency_key_key" ON "submissions"("workspace_id", "submitted_by_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "submission_files_workspace_id_submission_id_idx" ON "submission_files"("workspace_id", "submission_id");

-- CreateIndex
CREATE INDEX "submission_files_project_id_idx" ON "submission_files"("project_id");

-- CreateIndex
CREATE UNIQUE INDEX "submission_files_workspace_id_id_key" ON "submission_files"("workspace_id", "id");

-- CreateIndex
CREATE INDEX "reviews_workspace_id_submission_id_idx" ON "reviews"("workspace_id", "submission_id");

-- CreateIndex
CREATE INDEX "reviews_workspace_id_project_id_created_at_idx" ON "reviews"("workspace_id", "project_id", "created_at");

-- CreateIndex
CREATE INDEX "reviews_submission_id_idx" ON "reviews"("submission_id");

-- CreateIndex
CREATE UNIQUE INDEX "reviews_workspace_id_id_key" ON "reviews"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ai_reviews_workspace_id_id_key" ON "ai_reviews"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ai_reviews_workspace_id_submission_id_key" ON "ai_reviews"("workspace_id", "submission_id");

-- CreateIndex
CREATE UNIQUE INDEX "ai_usage_job_id_key" ON "ai_usage"("job_id");

-- CreateIndex
CREATE INDEX "ai_usage_workspace_id_created_at_idx" ON "ai_usage"("workspace_id", "created_at");

-- CreateIndex
CREATE INDEX "approval_revocations_workspace_id_user_id_restored_at_idx" ON "approval_revocations"("workspace_id", "user_id", "restored_at");

-- CreateIndex
CREATE UNIQUE INDEX "approval_revocations_workspace_id_id_key" ON "approval_revocations"("workspace_id", "id");

-- CreateIndex
CREATE INDEX "overrides_workspace_id_project_id_created_at_idx" ON "overrides"("workspace_id", "project_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "overrides_workspace_id_id_key" ON "overrides"("workspace_id", "id");

-- CreateIndex
CREATE INDEX "extension_requests_workspace_id_project_id_status_idx" ON "extension_requests"("workspace_id", "project_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "extension_requests_workspace_id_id_key" ON "extension_requests"("workspace_id", "id");

-- CreateIndex
CREATE INDEX "comments_workspace_id_project_id_created_at_idx" ON "comments"("workspace_id", "project_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "comments_workspace_id_target_type_target_id_created_at_idx" ON "comments"("workspace_id", "target_type", "target_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "comments_workspace_id_id_key" ON "comments"("workspace_id", "id");

-- CreateIndex
CREATE INDEX "time_logs_workspace_id_project_id_date_idx" ON "time_logs"("workspace_id", "project_id", "date" DESC);

-- CreateIndex
CREATE INDEX "time_logs_project_id_created_at_idx" ON "time_logs"("project_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "time_logs_workspace_id_id_key" ON "time_logs"("workspace_id", "id");

-- CreateIndex
CREATE INDEX "notifications_user_id_read_at_created_at_idx" ON "notifications"("user_id", "read_at", "created_at" DESC);

-- CreateIndex
CREATE INDEX "activity_log_workspace_id_occurred_at_idx" ON "activity_log"("workspace_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "activity_log_project_id_occurred_at_idx" ON "activity_log"("project_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "activity_log_workspace_id_faculty_id_occurred_at_idx" ON "activity_log"("workspace_id", "faculty_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "activity_log_workspace_id_department_id_occurred_at_idx" ON "activity_log"("workspace_id", "department_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "audit_log_workspace_id_created_at_idx" ON "audit_log"("workspace_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_log_actor_id_created_at_idx" ON "audit_log"("actor_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "google_drive_connections_user_id_key" ON "google_drive_connections"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "jobs_dedupe_key_key" ON "jobs"("dedupe_key");

-- CreateIndex
CREATE INDEX "jobs_status_run_at_idx" ON "jobs"("status", "run_at");

-- CreateIndex
CREATE INDEX "jobs_kind_status_idx" ON "jobs"("kind", "status");

-- CreateIndex
CREATE INDEX "idempotency_keys_expires_at_idx" ON "idempotency_keys"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_keys_user_id_key_method_path_key" ON "idempotency_keys"("user_id", "key", "method", "path");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_tokens" ADD CONSTRAINT "auth_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_settings" ADD CONSTRAINT "workspace_settings_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "faculties" ADD CONSTRAINT "faculties_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "departments" ADD CONSTRAINT "departments_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "departments" ADD CONSTRAINT "departments_workspace_id_faculty_id_fkey" FOREIGN KEY ("workspace_id", "faculty_id") REFERENCES "faculties"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_workspace_id_department_id_fkey" FOREIGN KEY ("workspace_id", "department_id") REFERENCES "departments"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership_roles" ADD CONSTRAINT "membership_roles_workspace_id_membership_id_fkey" FOREIGN KEY ("workspace_id", "membership_id") REFERENCES "memberships"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invites" ADD CONSTRAINT "invites_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_workspace_id_department_id_fkey" FOREIGN KEY ("workspace_id", "department_id") REFERENCES "departments"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_workspace_id_project_id_fkey" FOREIGN KEY ("workspace_id", "project_id") REFERENCES "projects"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_workspace_id_user_id_fkey" FOREIGN KEY ("workspace_id", "user_id") REFERENCES "memberships"("workspace_id", "user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "phase_template_items" ADD CONSTRAINT "phase_template_items_workspace_id_template_id_fkey" FOREIGN KEY ("workspace_id", "template_id") REFERENCES "phase_templates"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "phases" ADD CONSTRAINT "phases_workspace_id_project_id_fkey" FOREIGN KEY ("workspace_id", "project_id") REFERENCES "projects"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "phase_requirements" ADD CONSTRAINT "phase_requirements_workspace_id_phase_id_fkey" FOREIGN KEY ("workspace_id", "phase_id") REFERENCES "phases"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "phase_resources" ADD CONSTRAINT "phase_resources_workspace_id_phase_id_fkey" FOREIGN KEY ("workspace_id", "phase_id") REFERENCES "phases"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "draft_files" ADD CONSTRAINT "draft_files_workspace_id_phase_id_fkey" FOREIGN KEY ("workspace_id", "phase_id") REFERENCES "phases"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_workspace_id_project_id_fkey" FOREIGN KEY ("workspace_id", "project_id") REFERENCES "projects"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_workspace_id_phase_id_fkey" FOREIGN KEY ("workspace_id", "phase_id") REFERENCES "phases"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submission_files" ADD CONSTRAINT "submission_files_workspace_id_submission_id_fkey" FOREIGN KEY ("workspace_id", "submission_id") REFERENCES "submissions"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_workspace_id_submission_id_fkey" FOREIGN KEY ("workspace_id", "submission_id") REFERENCES "submissions"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_reviews" ADD CONSTRAINT "ai_reviews_workspace_id_submission_id_fkey" FOREIGN KEY ("workspace_id", "submission_id") REFERENCES "submissions"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_revocations" ADD CONSTRAINT "approval_revocations_workspace_id_project_id_fkey" FOREIGN KEY ("workspace_id", "project_id") REFERENCES "projects"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "overrides" ADD CONSTRAINT "overrides_workspace_id_project_id_fkey" FOREIGN KEY ("workspace_id", "project_id") REFERENCES "projects"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "extension_requests" ADD CONSTRAINT "extension_requests_workspace_id_project_id_fkey" FOREIGN KEY ("workspace_id", "project_id") REFERENCES "projects"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "extension_requests" ADD CONSTRAINT "extension_requests_workspace_id_phase_id_fkey" FOREIGN KEY ("workspace_id", "phase_id") REFERENCES "phases"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_workspace_id_project_id_fkey" FOREIGN KEY ("workspace_id", "project_id") REFERENCES "projects"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comment_mentions" ADD CONSTRAINT "comment_mentions_workspace_id_comment_id_fkey" FOREIGN KEY ("workspace_id", "comment_id") REFERENCES "comments"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_logs" ADD CONSTRAINT "time_logs_workspace_id_project_id_fkey" FOREIGN KEY ("workspace_id", "project_id") REFERENCES "projects"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "google_drive_connections" ADD CONSTRAINT "google_drive_connections_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

