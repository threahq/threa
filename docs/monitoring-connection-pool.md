# Connection Pool Monitoring Guide

## Overview

The application has comprehensive connection pool instrumentation to help diagnose and prevent pool exhaustion issues.

## Components

### 1. Pool Monitor (`src/lib/observability/pool-monitor.ts`)

Tracks health metrics for all database pools:

- **Total connections**: Current number of connections in the pool
- **Idle connections**: Connections available for use
- **Waiting clients**: Clients waiting for a connection (⚠️ indicates pool exhaustion)
- **Utilization**: Percentage of pool capacity in use

**Default behavior:**

- Logs pool stats every 30 seconds at `info` level
- Automatically escalates to `warn` when:
  - Utilization exceeds 80%
  - Any clients are waiting for connections

### 2. Liveness Endpoint (`GET /health`)

Public endpoint (no auth required) for process liveness:

```bash
curl http://localhost:3001/health | jq
```

**Response:**

```json
{
  "status": "ok"
}
```

### 3. Readiness Endpoint (`GET /readyz`)

Internal ops endpoint with detailed pool readiness stats.

Access is restricted to internal network IPs by `opsAccess` middleware.

```bash
curl http://localhost:3001/readyz | jq
```

**Response:**

```json
{
  "status": "ok",
  "timestamp": "2024-01-20T10:30:00.000Z",
  "pools": [
    {
      "poolName": "main",
      "totalCount": 15,
      "idleCount": 10,
      "waitingCount": 0,
      "utilizationPercent": 17,
      "timestamp": "2024-01-20T10:30:00.000Z"
    },
    {
      "poolName": "listen",
      "totalCount": 9,
      "idleCount": 0,
      "waitingCount": 0,
      "utilizationPercent": 100,
      "timestamp": "2024-01-20T10:30:00.000Z"
    }
  ]
}
```

**Note:** The listen pool utilization is expected to be 100% during normal operation (9 outbox handlers holding LISTEN connections).

### 4. Load Fixtures

`scripts/perf-seed.ts` seeds the load fixtures (large streams, deep threads, missed sync-log entries, large drafts, wide boards) into a local stack. Profiles and the scenarios they serve: [`docs/perf/reproduction-matrix.md`](perf/reproduction-matrix.md).

## Pool Configuration

**Main pool:** 30 connections

- Used by: HTTP handlers, services, workers, queue system, Socket.io adapter
- Handles transactional work with fast connection turnover

**Listen pool:** 12 connections

- Used by: OutboxDispatcher LISTEN connections (9 handlers)
- Connections held indefinitely for database notifications
- Separated to prevent LISTEN connections from starving transactional work

## Warning Signs

### 🔴 Critical: Pool Exhaustion

```
Pool 'main' has 5 waiting client(s)
```

**Meaning:** More clients are trying to acquire connections than the pool has available.

**Impact:** Requests will timeout after 2 seconds (connectionTimeoutMillis), leading to 500 errors.

**Common causes:**

1. Connection leak (connections not released)
2. Sudden spike in concurrent requests
3. Slow queries holding connections too long

### 🟡 Warning: High Utilization

```
Pool 'main' utilization at 87%
```

**Meaning:** Most of the pool capacity is in use.

**Impact:** No immediate problem, but little headroom for spikes.

**Action:** Monitor for sustained high utilization.

### ✅ Healthy

```
Pool 'main': 23% utilized (7/30 active, 23 idle, 0 waiting)
```

## Debugging Connection Leaks

### Step 1: Identify the Leak Pattern

**Watch pool stats under load:**

```bash
tail -f apps/backend/logs/combined.log | grep "Pool stats"
```

Then drive load against the server while watching the stats.

**Look for:**

- Does `totalCount` keep increasing?
- Does `idleCount` decrease over time?
- Do `waitingCount` spikes appear?
- At what wave does failure start?

### Step 2: Check for Missing Releases

All connection acquisition should use helpers that guarantee release:

```typescript
// ✅ Good: withClient guarantees release
await withClient(pool, async (client) => {
  // work
})

// ✅ Good: withTransaction guarantees release + rollback
await withTransaction(pool, async (client) => {
  // work
})

// ❌ Bad: Manual acquire without guaranteed release
const client = await pool.connect()
await client.query("SELECT 1") // If this throws, release() won't run
client.release()
```

**Common leak patterns:**

1. **Missing finally block:**

   ```typescript
   const client = await pool.connect()
   try {
     await doWork(client)
     client.release() // ❌ Won't run on error
   } catch (err) {
     throw err
   }
   ```

2. **Early return without release:**

   ```typescript
   const client = await pool.connect()
   if (condition) return // ❌ Leak!
   client.release()
   ```

3. **Async work not awaited:**
   ```typescript
   const client = await pool.connect()
   try {
     doAsyncWork(client) // ❌ Missing await
   } finally {
     client.release() // Released before work completes!
   }
   ```

### Step 3: Identify High-Traffic Code Paths

**Check server logs for:**

- Which endpoints are being called most frequently?
- Which workers are processing the most jobs?
- Are there any error spikes?

**Places to investigate:**

1. **HTTP handlers** (`src/handlers/*`)
2. **Service methods** (`src/services/*`)
3. **Repository methods** (`src/repositories/*`)
4. **Worker handlers** (`src/workers/*`)
5. **Socket.io adapter** (uses main pool for pub/sub)

### Step 4: Monitor Socket.io Adapter

The `@socket.io/postgres-adapter` uses the main pool for pub/sub. Under high Socket.io traffic, this could contribute to pool pressure.

**Check:**

```bash
# Count socket connections
curl http://localhost:3001/readyz | jq '.pools[] | select(.poolName == "main")'

# Monitor Socket.io events (add logging if needed)
```

**Potential issue:** Many simultaneous Socket.io broadcasts could temporarily spike connection usage.

## Production Monitoring

### Metrics to Track

1. **Pool utilization over time**
   - Alert if sustained >80% for more than 5 minutes

2. **Waiting clients**
   - Alert immediately if waitingCount > 0

3. **Connection acquisition latency**
   - Track time between `pool.connect()` and connection acquired

4. **Connection hold time**
   - Track time between acquire and release
   - Identify slow queries or long-held connections

### Recommended Actions

1. **Increase pool size** if consistently at high utilization
2. **Investigate slow queries** if connections held for >1 second
3. **Add request queueing** if spikes are causing exhaustion
4. **Separate Socket.io adapter** to dedicated pool if high broadcast volume

## Temporary Workaround: Increase Pool Size

If you need immediate relief while investigating:

```typescript
// apps/backend/src/db/index.ts
const DEFAULT_POOL_CONFIG: Partial<PoolConfig> = {
  max: 50, // Increased from 30
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
}
```

**⚠️ This is a bandaid, not a fix.** Increasing the pool size will delay exhaustion but won't solve a connection leak.

## Next Steps

1. **Drive sustained load** to reproduce the leak
2. **Check server logs** during the test
3. **Identify the code path** where connections aren't released
4. **Add explicit logging** around suspected leak areas
5. **Fix the leak** by ensuring all acquisitions use `withClient` or `withTransaction`
