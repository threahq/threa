-- Generic label→resource assignments. `resource_type` is the polymorphic
-- discriminator ("stream" today; "message" | "user" | "attachment" later) so
-- one table/service/event path serves every labelable resource.
--
-- Viewer-scoped: `user_id` is the person who applied the label, and a row is
-- private to that user (mirrors private-label visibility). No FKs (INV-1);
-- relational integrity is enforced in the service layer.
CREATE TABLE label_assignments (
  workspace_id TEXT NOT NULL,
  label_id TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, resource_type, resource_id, label_id, user_id)
);

-- "Which labels has the viewer applied to this resource?" (header chips, picker
-- selection state). PK prefix already covers (workspace_id, resource_type,
-- resource_id); this adds user_id for the viewer filter.
CREATE INDEX idx_label_assignments_resource
  ON label_assignments (workspace_id, resource_type, resource_id, user_id);

-- Viewer's full assignment set for the workspace bootstrap.
CREATE INDEX idx_label_assignments_workspace_user
  ON label_assignments (workspace_id, user_id);

-- Cascade cleanup when a label is archived (delete all assignments for a label).
CREATE INDEX idx_label_assignments_label
  ON label_assignments (workspace_id, label_id);
