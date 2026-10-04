UPDATE messages m SET workspace_id = s.workspace_id FROM streams s WHERE s.id = m.stream_id;
