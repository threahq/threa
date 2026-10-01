UPDATE stream_events e SET workspace_id = s.workspace_id FROM streams s WHERE s.id = e.stream_id;
