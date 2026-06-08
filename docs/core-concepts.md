# Core Concepts

This document provides detailed explanations of Threa's core domain concepts: Streams, Memos (GAM), and Personas.

## Streams

Everything that can send messages is a stream. Streams are the fundamental communication primitive in Threa.

### Stream Types

#### Scratchpad

- **Purpose**: Personal notes + AI companion (primary entry point for solo users)
- **Naming**: Auto-named from first message content
- **Visibility**: Always private to the owner
- **Companion**: Can have AI companion enabled
- **Use case**: Solo founders treating Threa as personal knowledge base

#### Channel

- **Purpose**: Public or private team channels
- **Naming**: Requires unique slug per workspace (e.g., `#general`, `#engineering`)
- **Visibility**: Public (visible to all workspace members) or Private (invite-only)
- **Companion**: Optional AI companion
- **Use case**: Team communication, topic-based discussions

#### DM (Direct Message)

- **Purpose**: Private conversations between members
- **Members**: Exactly two members
- **Naming**: Viewer-dependent virtual name of the other member
- **Creation**: Special flow, not standard stream creation API
- **Lifecycle**: Stream is created lazily on the first message
- **Visibility**: Always private
- **Companion**: Can have AI companion
- **Use case**: Private one-on-one conversations

#### Thread

- **Purpose**: Nested discussions within any stream
- **Depth**: Unlimited nesting depth, graph structure
- **Visibility**: Inherited from `rootStreamId` (topmost non-thread ancestor)
- **Parent**: Points to parent stream (can be another thread)
- **Root**: Points to root stream (always a non-thread stream)
- **Use case**: Focused sub-discussions without cluttering main conversation

### Stream Properties

All streams have:

- `visibility`: `public` or `private`
- `companionMode`: `on` or `off`
- `companionPersonaId`: Optional reference to AI persona (if companion mode is on)
- `workspaceId`: Workspace ownership (sharding boundary)

## Memos (GAM - General Agentic Memory)

Memos are Threa's core differentiator: semantic pointers that preserve knowledge without copying messages.

### Philosophy

Instead of copying message content, memos store:

- **Abstract**: Concise summary of the knowledge
- **sourceMessageIds**: Array of message IDs for navigation back to originals
- **Context**: Enough metadata to understand and retrieve the knowledge

This approach:

- Preserves context (original conversation thread)
- Avoids content duplication
- Enables navigation to source material
- Supports versioning and evolution of understanding

### Memo Pipeline

Memo creation is fully automated and runs off conversations, not raw messages.
Implementation detail lives in
[`docs/features/architecture/memo-pipeline.md`](features/architecture/memo-pipeline.md).

#### 1. Boundary extraction (message to conversation)

- Each user `message:created` event triggers a boundary-extraction job
- **Model**: `openrouter:openai/gpt-5.4-nano` (temperature 0.2)
- Decides which conversation(s) the message joins, can move earlier messages it
  now sees were misfiled, and names a new conversation when one starts
- Creating or updating a conversation emits a `conversation:created` /
  `conversation:updated` event
- Lives in `features/conversations/boundary-extraction/`, separate from memos

#### 2. Accumulation (per-stream debounce)

- `MemoAccumulatorHandler` listens for conversation events and queues the
  conversation in `memo_pending_items`
- **Quiet**: process after 30s of no activity in the stream
- **Cap**: process at most once every 5 minutes under sustained activity
- A `memo.batch-check` job (every 30s) dispatches a per-stream
  `memo.batch-process` job once the debounce has elapsed

#### 3. Classifier

- **Model**: `openrouter:openai/gpt-5.4-nano` (temperature 0.1)
- **Task**: decide whether a conversation holds durable knowledge, and whether
  existing memos for it need revision
- **Output**: `isKnowledgeWorthy`, `shouldReviseExisting`, `confidence`
- Conversations below the 0.7 confidence floor are skipped

#### 4. Memorizer

- **Model**: `openrouter:openai/gpt-5.4-nano` (temperature 0.3)
- **Task**: extract structured knowledge from the conversation (capped at 5 memos)
- **Output** per memo:
  - `title`: short, descriptive title
  - `abstract`: one-paragraph summary
  - `keyPoints`: up to 3 supporting points
  - `tags`: up to 5 topic tags
  - `sourceMessageIds`: ids of the messages that informed the memo
  - `knowledgeType`: one of the five knowledge types

#### 5. Enrichment

- Embeds each abstract for semantic search (one batched call per conversation)
- **Model**: `openrouter:openai/text-embedding-3-small`, stored in a `vector(1536)`
  column with an HNSW index

### Memo Types

- **decision**: Choices made and rationale
- **learning**: New knowledge or insights gained
- **procedure**: How-to knowledge or processes
- **context**: Background information or explanations
- **reference**: Links, resources, or external references

### Status Lifecycle

```
draft → active → archived | superseded
```

- **draft**: Being created, not yet finalized
- **active**: Published and current
- **archived**: Superseded by newer version or no longer relevant
- **superseded**: Replaced by a newer memo (tracks versioning)

Today the write path only creates memos as `active`. When a conversation gains new
knowledge, revision adds fresh memos rather than superseding the old ones; the
`draft` / `archived` / `superseded` states and the `version` column are supported by
the schema but not yet exercised.

### Use Cases

- Preserve decision rationale ("Why did we choose PostgreSQL?")
- Capture tribal knowledge ("How do we handle X?")
- Index important discussions ("That thread about scaling")
- Build organizational memory over time

## Personas

AI agents in Threa are data-driven personas, not hardcoded implementations. This enables:

- Dynamic agent creation by users
- Flexible tool assignment
- Persona evolution without code changes

### System vs Workspace Personas

#### System Personas

- **Scope**: Available to all workspaces
- **Management**: `managedBy="system"`, created by platform
- **Workspace ID**: `NULL` (not tied to specific workspace)
- **Example**: Ariadne (default system persona: `persona_system_ariadne`)
- **Use case**: Standard capabilities all users should have

#### Workspace Personas

- **Scope**: Single workspace only
- **Management**: `managedBy="workspace"`, created by workspace admins
- **Workspace ID**: Specific workspace ID
- **Example**: Custom personas for team-specific needs
- **Use case**: Domain-specific agents, custom workflows

### Invocation Methods

#### Stream-Level Companion Mode

```typescript
{
  companionMode: "on",
  companionPersonaId: "persona_system_ariadne"
}
```

- AI automatically participates in conversation
- Responds to messages in the stream
- Context-aware of entire conversation history

#### Mention-Based

```
@ariadne what's the status of the project?
```

- Invoke persona by mentioning `@persona-slug`
- One-off interactions
- Persona has access to conversation context

#### Agent Sessions

- Explicit agent invocation via API
- Long-running agent tasks
- Multi-step workflows

### Enabled Tools

Each persona has `enabledTools[]` array controlling available capabilities:

- `send_message`: Post messages to streams
- `web_search`: Search the web
- `read_url`: Fetch and read web content
- `create_memo`: Create knowledge memos
- `search_memos`: Search existing memos
- (extensible: more tools can be added)

Tools are declarative - adding a tool to the array grants the capability without code changes.

### Default Persona: Ariadne

Ariadne (`persona_system_ariadne`) is the default system persona:

- Available in all workspaces
- General-purpose assistant
- Full tool access
- Named after the Greek mythological figure who helped Theseus navigate the labyrinth (fitting for a knowledge navigation assistant)

## Relationships Between Concepts

### Streams + Memos

- Messages in streams are analyzed for memo creation
- Memos reference source messages in streams
- Streams are the input to the GAM system

### Streams + Personas

- Streams can have companion personas enabled
- Personas send messages to streams
- Stream visibility controls persona access

### Memos + Personas

- Personas use memos for knowledge retrieval
- Personas create memos from conversations
- Memos form the "memory" that personas access

## Implementation Notes

### Database Tables

- `streams`: Stream metadata and configuration
- `stream_members`: Membership and permissions
- `stream_events`: Event-sourced message history
- `messages`: Projection of current message state
- `memos`: Memo metadata and content
- `memo_sources`: Many-to-many: memos ↔ messages
- `personas`: Persona configuration
- `persona_tools`: Many-to-many: personas ↔ enabled tools

### Key Constraints

- Workspace is the sharding boundary (all resources scoped to workspace)
- Stream slugs must be unique within workspace
- DMs have exactly 2 members
- DMs are uniquely constrained by ordered member pair within a workspace
- Thread visibility always matches root stream
- System personas have `workspaceId=NULL`

### Event-Driven Architecture

- All state changes go through event sourcing
- Events published to outbox for async processing
- Projections derived from events
- Enables audit trail and time-travel debugging
