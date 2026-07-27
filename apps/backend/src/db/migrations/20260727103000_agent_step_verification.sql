-- Guardian verdict for a tier-2 tool call, carried on the step the call opened
-- rather than a step of its own: one trace row per action, with its approval
-- state attached.
--
-- Nullable on purpose, and NOT defaulted. Absent means "this step was never
-- subject to a guardian" — every tier-1 step, and every step written before
-- tiers existed. That is a different fact from "reviewed, verdict pending",
-- which is the `pending` value, so a step stuck mid-review is distinguishable
-- from an ordinary unguarded one instead of both reading as null.
--
-- TEXT rather than an enum (INV-3); values validated in code against
-- TOOL_VERIFICATION_STATUSES.
ALTER TABLE agent_session_steps
  ADD COLUMN verification_status TEXT,
  ADD COLUMN verification_reason TEXT;
