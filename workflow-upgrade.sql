-- ============================================================================
-- Workflow templates upgrade — match the PageProof model:
--   each step has REVIEWERS and/or APPROVERS (by email), and a gate:
--   a step "waits for the approver to approve" when it has approvers,
--   otherwise it "flows through without waiting."
-- Run once in Supabase ▸ SQL Editor (safe to re-run).
-- ============================================================================

alter table public.workflow_stages
  add column if not exists approvers text;                    -- comma-separated approver emails
alter table public.workflow_stages
  add column if not exists waits boolean not null default false; -- step blocks until approved

-- (existing column) assignees  = REVIEWER emails, comma-separated
-- (existing column) assignee_type stays for internal/SSO vs external/link; defaults to external
