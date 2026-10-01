-- Bridge for the workspace_id rollout. A replica that predates the column
-- inserts without it, so each table that gains workspace_id also gets a BEFORE
-- INSERT trigger that fills it from the row's parent. A missing parent leaves
-- NULL and the NOT NULL constraint rejects the insert (INV-11). The triggers
-- and these functions are dropped once no old replica is running.
CREATE OR REPLACE FUNCTION workspace_id_from_stream()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  SELECT s.workspace_id INTO NEW.workspace_id FROM streams s WHERE s.id = NEW.stream_id;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION workspace_id_from_message()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  SELECT m.workspace_id INTO NEW.workspace_id FROM messages m WHERE m.id = NEW.message_id;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION workspace_id_from_agent_session()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  SELECT a.workspace_id INTO NEW.workspace_id FROM agent_sessions a WHERE a.id = NEW.session_id;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION workspace_id_from_user()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  SELECT u.workspace_id INTO NEW.workspace_id FROM users u WHERE u.id = NEW.user_id;
  RETURN NEW;
END;
$$;
