-- What a trace step wrote, as an array of AgentToolEffect descriptors.
-- Nullable: absent on read-only steps, on steps written before this existed,
-- and on sealed (enclave) streams, where plaintext labels would defeat the
-- point of sealing the step's content.
ALTER TABLE agent_session_steps ADD COLUMN effects JSONB;
