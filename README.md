# Settl

**Infrastructure layer for dedicated virtual account systems built on Nomba.**

Settl provisions a unique bank account number per customer, ingests payment webhooks into an internal ledger, automatically reconciles pending transactions against Nomba's requery API, and reverses confirmed failures, all without the calling application writing any payment logic.

Built for the Nomba x DevCareer Hackathon 2026.

**Live:** https://settl-878p.onrender.com  
**Dashboard:** https://settl-878p.onrender.com/  
**Repository:** https://github.com/temiscripts/settl

---

## Table of Contents

- [Architecture](#architecture)
- [API Reference](#api-reference)
- [Ops Dashboard](#ops-dashboard)
- [Transaction State Machine](#transaction-state-machine)
- [Production Engineering](#production-engineering)
- [Getting Started](#getting-started)
- [Environment Variables](#environment-variables)
- [Running Tests](#running-tests)
- [Deployment](#deployment)
- [Known Limitations](#known-limitations)
- [Project Structure](#project-structure)
- [Stack](#stack)

---

## Architecture

```
                        ┌─────────────┐
                        │  Nomba API  │
                        └──────┬──────┘
                               │ signed webhooks
                               ▼
┌──────────┐  POST /v1/  ┌────────────┐   enqueue   ┌───────────┐
│  Caller  │────────────▶│  Express   │────────────▶│  BullMQ   │
└──────────┘  webhooks   │  Handler   │             │  Queue    │
                         └────────────┘             └─────┬─────┘
                                                          │ dequeue
                                                          ▼
                         ┌────────────┐         ┌────────────────┐
                         │ Reconcilia-│◀────────│ Webhook Worker │
                         │ tion Worker│  requery │                │
                         └─────┬──────┘         └────────────────┘
                               │ reversal
                               ▼
                         ┌────────────┐
                         │  Nomba v2  │
                         │  Transfers │
                         └────────────┘
```

**Key design decisions:**

- The HTTP handler that receives Nomba webhooks does exactly three things: validate the HMAC signature, check idempotency, enqueue the job. It never touches the database directly. This decouples acknowledgement from processing — Nomba's delivery never times out regardless of downstream latency.
- Every Nomba API call is wrapped in a circuit breaker (opossum). If Nomba becomes degraded, the circuit opens and callers receive `503` immediately rather than waiting for timeouts that would exhaust the connection pool.
- All state transitions are validated at the application layer before any database write. An illegal transition throws before the query runs. The database enforces the same constraint independently.
- The reconciliation worker acquires a Redis distributed lock at the start of each cycle. Multiple instances never double-process the same pending transaction.

---

## API Reference

All routes are versioned under `/v1`.

### Accounts

#### `POST /v1/accounts`

Provisions a dedicated virtual bank account for a customer via Nomba.

**Request body**

| Field | Type | Required | Description |
|---|---|---|---|
| `customerName` | string | Yes | Name of the account holder (1–100 chars) |
| `accountRef` | string | Yes | Your internal unique reference (1–100 chars) |
| `expectedAmount` | integer | No | Expected payment in **kobo**. Enables over/underpayment detection. |
| `expiryDate` | ISO 8601 datetime | No | Account is automatically marked expired after this time. |

**Example request**
```bash
curl -X POST https://settl-878p.onrender.com/v1/accounts \
  -H "Content-Type: application/json" \
  -d '{
    "customerName": "Amara Okafor",
    "accountRef": "order-9182",
    "expectedAmount": 150000
  }'
```

**Example response** `201 Created`
```json
{
  "account": {
    "id": "4e0d8272-719a-4745-90b5-9c1d7b4b7661",
    "nombaVirtualAccountId": "3043911296",
    "bankAccountNumber": "3043911296",
    "bankName": "Nombank MFB",
    "bankAccountName": "Nomba/Amara Okafor",
    "customerName": "Amara Okafor",
    "accountRef": "order-9182",
    "expectedAmount": 150000,
    "expiryDate": null,
    "status": "active",
    "createdAt": "2026-07-03T19:27:51.412Z"
  }
}
```

---

#### `GET /v1/accounts/:id`

Returns account details by internal UUID.

**Example response** `200 OK`
```json
{
  "account": {
    "id": "4e0d8272-719a-4745-90b5-9c1d7b4b7661",
    "bankAccountNumber": "3043911296",
    "bankName": "Nombank MFB",
    "customerName": "Amara Okafor",
    "accountRef": "order-9182",
    "status": "active"
  }
}
```

---

#### `GET /v1/accounts/:id/balance`

Returns the computed balance derived from all settled transactions on the account.

**Example response** `200 OK`
```json
{
  "accountId": "4e0d8272-719a-4745-90b5-9c1d7b4b7661",
  "balanceKobo": 150000,
  "balanceNaira": 1500
}
```

---

#### `GET /v1/accounts/:id/transactions`

Returns paginated transaction history for a single account.

**Query parameters:** `page` (default: 1), `limit` (default: 20, max: 100)

---

### Webhooks

#### `POST /v1/webhooks/nomba`

Inbound webhook receiver for Nomba payment events. Nomba calls this endpoint — your application does not call it directly.

**What happens on each request:**

1. **HMAC-SHA256 signature verification** — timing-safe comparison against the `nomba-signature` header using the colon-joined scheme: `event_type:requestId:userId:walletId:transactionId:type:time:responseCode:timestamp`
2. **Replay-attack prevention** — rejects timestamps older than 10 minutes 30 seconds
3. **Idempotency check** — Redis `SET NX EX 36000` on `requestId` first; falls back to Postgres `UNIQUE` constraint on `merchantTxRef`
4. **Event type routing** — `payment_failed` and `payout_failed` events are never settled regardless of amount. They are routed directly to `failed` state and the auto-reversal engine, the same path as a failure discovered later by reconciliation
5. **Enqueue** — job added to BullMQ; `200` returned immediately. All database writes happen asynchronously in the worker

---

### Transactions

#### `GET /v1/transactions`

Global transaction feed across all accounts, plus a live summary for the ops dashboard.

**Query parameters:** `state`, `page`, `limit` (max: 100)

**Example response** `200 OK`
```json
{
  "transactions": [...],
  "total": 42,
  "page": 1,
  "limit": 20,
  "pages": 3,
  "summary": {
    "total": 42,
    "byState": { "pending": 3, "settled": 35, "failed": 2, "reversing": 1, "reversed": 1, "initiated": 0 },
    "byMatch": { "exact": 28, "overpaid": 5, "underpaid": 3, "none": 6 }
  }
}
```

---

### Bank Health

#### `GET /v1/bank-health`

Failure rate per `senderBankCode`, computed from transactions that carry sender bank details (captured when Nomba includes them on a webhook). Banks are classified by failure rate.

| Classification | Failure rate |
|---|---|
| `healthy` | < 10% |
| `degraded` | 10–30% |
| `critical` | ≥ 30% |

**Example response** `200 OK`
```json
{
  "generatedAt": "2026-07-07T21:00:00.000Z",
  "banks": [
    {
      "bankCode": "058",
      "totalTransactions": 20,
      "settled": 16,
      "pending": 2,
      "failed": 2,
      "failureRate": 0.1,
      "status": "degraded"
    }
  ]
}
```

#### `GET /v1/bank-health/:bankCode`

Health data for a single bank code. Returns `404` if no transactions have been seen from that bank.

---

### Audit Log

#### `GET /v1/audit-log?limit=`

Recent entries from the hash-chained audit log, most recent first. Default limit 50, max 500.

#### `GET /v1/audit-log/verify`

Walks the entire chain and reports integrity status.

**Example response** `200 OK`
```json
{ "valid": true, "checked": 148 }
```

If tampered:
```json
{
  "valid": false,
  "checked": 148,
  "reason": "Content alteration detected at sequence number 37"
}
```

---

### Health

#### `GET /v1/health`

Active health check that pings all dependencies. Does not return `200` based on a hardcoded value.

**Example response** `200 OK`
```json
{
  "status": "ok",
  "checks": {
    "database": { "status": "ok" },
    "redis":    { "status": "ok" },
    "queue": {
      "status": "ok",
      "waiting": 0,
      "active": 0,
      "dlqCount": 0
    },
    "nomba": {
      "circuitBreakers": {
        "createVirtualAccount": { "failures": 0, "fires": 0 },
        "requeryTransaction":   { "failures": 0, "fires": 0 },
        "initiateReversal":     { "failures": 0, "fires": 0 }
      }
    }
  }
}
```

---

### HTTP Status Codes

| Code | Meaning |
|---|---|
| `200` | Successful read or webhook acknowledged |
| `201` | Resource created |
| `400` | Validation failure or malformed request |
| `404` | Resource not found |
| `409` | Duplicate `accountRef` or idempotency conflict |
| `422` | Semantically invalid input (e.g. negative amount) |
| `503` | Circuit breaker open — Nomba API unavailable |
| `500` | Unhandled server error |

---

## Ops Dashboard

`GET /` serves a static ops dashboard (`src/public/index.html`) that polls the API every 5 seconds and renders:

- **Transaction summary** — counts by state (pending, settled, failed, reversing, reversed)
- **Settlement match breakdown** — segmented bar showing exact / overpaid / underpaid distribution
- **Bank health cards** — per-bank failure rate with healthy / degraded / critical classification
- **Recent transactions** — live table of the last 15 transactions
- **Audit trail** — last 15 audit entries with hash chain verification status

The dashboard is plain HTML and JavaScript — no build step, no framework, served directly by Express via `express.static`.

> **Note:** The dashboard has no authentication. Do not expose it publicly with real customer data without adding one.

---

## Transaction State Machine

```
initiated ──▶ pending ──▶ settled
                  │
                  └──▶ failed ──▶ reversing ──▶ reversed
```

`settled` and `reversed` are terminal states. No transition out of either is permitted anywhere in the codebase. The application layer validates every transition before writing; the database enforces the same constraint independently.

**Settlement match** is recorded on every transaction:

| Value | Meaning |
|---|---|
| `exact` | Received amount matches `expectedAmount` exactly |
| `overpaid` | Received amount exceeds `expectedAmount` |
| `underpaid` | Received amount is below `expectedAmount` — transaction stays pending |
| `null` | No `expectedAmount` was set on the account |

**Failure reason** is recorded when a transaction enters `failed` state:

| Value | Meaning |
|---|---|
| `partial` | Payment was underpaid |
| `rejected_by_bank` | Nomba returned `declined` on requery |
| `timeout` | Nomba returned `timeout_error` on requery |
| `silent_failure` | Terminal failure with no specific reason from Nomba |

---

## Production Engineering

### Async Webhook Processing (BullMQ)

The HTTP handler that receives webhooks returns `200` to Nomba in milliseconds. All database writes, state transitions, and audit log entries happen in a BullMQ worker running separately. This means:

- Nomba's webhook delivery never times out, even under heavy load
- 500 simultaneous webhooks are all acknowledged immediately and processed at the worker's pace
- Failed jobs retry automatically (up to 5 attempts, exponential backoff starting at 2 seconds)
- Jobs that exhaust all retries go to BullMQ's dead letter queue for manual inspection

### Circuit Breaker

All three Nomba call sites (virtual account creation, requery, reversal) are individually wrapped with [opossum](https://nodeshift.dev/opossum/) circuit breakers.

| Parameter | Value |
|---|---|
| Failure threshold | 50% of recent calls |
| Reset timeout | 30 seconds |
| Per-call timeout | 5 seconds |
| 4xx responses | Not counted as failures — they are caller errors, not Nomba outages |

When a circuit opens, callers receive `503` immediately. State changes (open, half-open, closed) are logged as structured events.

### Retry with Jitter

Every Nomba API call uses [async-retry](https://github.com/vercel/async-retry) with exponential backoff and random jitter:

```
delay = 2^(attempt - 1) × 1000ms + random(0, 1000ms)
```

Jitter prevents the thundering herd problem — all workers retrying simultaneously after an outage would recreate the original load spike. 4xx responses bail immediately without retrying.

### Distributed Reconciliation Lock

The reconciliation worker uses Redis `SET NX PX` to acquire an exclusive lock at the start of each cycle. The lock TTL is set slightly shorter than the cycle interval so it always expires before the next cycle, even if the holding instance crashes mid-cycle and never releases it.

Lock release uses a Lua script that atomically checks ownership before deleting:

```lua
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
```

This prevents an instance from releasing a lock it no longer owns after the TTL expired and another instance acquired it.

### Outbound Idempotency (Two-Generals Problem)

Every reversal call to Nomba includes:

```
X-Idempotency-Key: {merchantTxRef}:reversal
```

This key is deterministic and stable across retries. If the server crashes after sending the reversal but before receiving Nomba's response, and the worker retries, Nomba deduplicates on this key. The customer is reversed exactly once regardless of how many times the request is sent.

### Token Refresh Mutex

The Nomba access token has a finite lifetime. Under concurrent load, multiple requests can detect expiry simultaneously and all attempt a refresh — a race condition that produces redundant token requests. A Promise-chain mutex ensures only one refresh runs at a time. All other callers wait on the same Promise and receive the refreshed token when it resolves.

### Tamper-Evident Audit Log

Every state change writes an audit entry with:

```
hash = SHA-256(sequenceNumber + eventType + JSON.stringify(payload) + previousHash)
```

Editing any past entry breaks every hash after it. `GET /v1/audit-log/verify` walks the entire chain and reports the exact sequence number where a break occurs.

The audit log uses a PostgreSQL advisory transaction lock (`pg_advisory_xact_lock`) to serialize concurrent writes. This ensures sequence numbers are always strictly monotonic and the hash chain never has collisions, even with BullMQ running 5 concurrent webhook workers.

### Atomic Database Writes

Every operation that spans multiple tables uses `prisma.$transaction()`. A transaction state change and its audit log entry always commit together or not at all. A server crash between two writes cannot leave the database in a partially updated state.

### Graceful Shutdown

On `SIGTERM` (issued by Render during deploys and restarts):

1. HTTP server stops accepting new connections
2. Reconciliation interval is cleared
3. BullMQ worker drains in-flight jobs
4. Job queue closes
5. Database connection pool closes
6. Process exits `0`

A restart never interrupts a transaction mid-reconciliation.

### Structured Logging

All logs are JSON emitted by [pino](https://getpino.io). Every log line produced during a request lifecycle carries the correlation ID generated at request entry, making it possible to reconstruct the full journey of any webhook through the system from a single ID.

```json
{
  "level": 30,
  "time": 1783104797734,
  "requestId": "07f1473f-2f0a-4520-856a-7e3655f1640a",
  "merchantTxRef": "tx-00192",
  "accountId": "4e0d8272-719a-4745-90b5-9c1d7b4b7661",
  "msg": "webhook queued"
}
```

---

## Getting Started

### Prerequisites

- Node.js >= 18
- Docker and Docker Compose (for local development)
- A Nomba account with `clientId`, `clientSecret`, and a parent account ID

### Local setup with Docker Compose

```bash
git clone https://github.com/temiscripts/settl.git
cd settl

# Copy the environment template and fill in your Nomba credentials
cp .env.example .env

# Start all services (app + Postgres + Redis)
docker compose up --build
```

The API will be available at `http://localhost:3000` and the dashboard at `http://localhost:3000/`.

### Local setup without Docker

```bash
npm install
npx prisma migrate dev
npm run dev
```

Requires a running PostgreSQL instance and Redis. Update `DATABASE_URL` and `REDIS_URL` in `.env` accordingly.

---

## Environment Variables

Copy `.env.example` to `.env` and populate the values. Never commit `.env`.

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `REDIS_URL` | Redis connection string (supports `rediss://` for TLS) |
| `NOMBA_BASE_URL` | Nomba API base URL (`https://api.nomba.com/v1`) |
| `NOMBA_PARENT_ACCOUNT_ID` | Your Nomba parent account UUID |
| `NOMBA_SUB_ACCOUNT_ID` | Sub-account UUID for virtual account provisioning |
| `NOMBA_CLIENT_ID` | OAuth client ID |
| `NOMBA_CLIENT_SECRET` | OAuth client secret |
| `NOMBA_WEBHOOK_SECRET` | HMAC signing key for webhook verification |
| `PORT` | HTTP server port (default: `3000`) |
| `NODE_ENV` | Runtime environment |
| `LOG_LEVEL` | Pino log level (default: `info`) |
| `RECONCILIATION_BATCH_SIZE` | Max pending transactions per cycle (default: `50`) |
| `RECONCILIATION_INTERVAL_MS` | Cycle frequency in milliseconds (default: `60000`) |

> **All amounts are in kobo.** 1 naira = 100 kobo. The API never accepts or returns naira values.

---

## Running Tests

```bash
npm test
```

Tests use Node.js's built-in `node:test` runner — no additional test framework required. They run sequentially to preserve audit log hash chain integrity across test files. A live PostgreSQL connection is required (`DATABASE_URL`). Tests create and clean up their own data and do not touch production records.

**Test coverage**

| File | What is tested |
|---|---|
| `tests/stateTransitions.test.js` | All 5 valid transitions pass. Every illegal state-to-state pair throws. Terminal states have no outgoing transitions. |
| `tests/reconciliation.test.js` | Settlement match logic (exact, overpaid, underpaid, null). `payment_failed` events never settle regardless of amount. Failed events with sender details route toward reversal. Duplicate `merchantTxRef` rejected at DB constraint. Non-existent account throws before any write. |
| `tests/resolveTransaction.test.js` | Nomba status `settled` advances state. Status `pending` makes no change. Status `failed` triggers reversal and gracefully handles Nomba being unavailable in the test environment. |

CI runs the full suite on every push to `main` and `develop` via GitHub Actions against a real PostgreSQL service container.

---

## Deployment

Settl is deployed on [Render](https://render.com). The `main` branch is the production branch. Every merge to `main` triggers an automatic deploy.

On startup, Render runs:
```
npx prisma migrate deploy && node src/index.js
```

This applies any pending database migrations before the server accepts traffic.

**Infrastructure**

| Service | Provider |
|---|---|
| API server | Render (Web Service) |
| PostgreSQL | Render (Managed Postgres) |
| Redis | Render (Redis) |

---

## Known Limitations

Settl runs on Render's free tier for this hackathon. This has concrete implications worth being explicit about.

**Single instance.** The free tier runs one container. The architecture supports horizontal scaling — stateless HTTP layer, Redis-backed queue, Redis distributed lock on the reconciliation worker, database-level idempotency on every write. Scaling to multiple instances requires only changing the instance count; no code changes are needed.

**Dashboard has no authentication.** `GET /`, `/v1/transactions`, `/v1/bank-health`, and `/v1/audit-log*` have no auth — appropriate for a hackathon demo, not for a real deployment with customer data.

**Reversal requires sender bank details.** Auto-reversal only completes if Nomba includes sender bank details (`senderAccountName`, `senderAccountNumber`, `senderBankCode`) in the webhook payload. If these are absent, the transaction moves to `reversing` and stays there for manual review. In production, these fields are expected to be present on real payment webhooks.

---

## Project Structure

```
settl/
├── prisma/
│   ├── schema.prisma               # Account, Transaction, AuditLog models
│   └── migrations/                 # Applied migration history
├── src/
│   ├── index.js                    # Server entry point, graceful shutdown
│   ├── middleware/
│   │   ├── requestId.js            # Correlation ID on every request
│   │   ├── rateLimiter.js          # Rate limiting on webhook and provisioning routes
│   │   ├── nombaAuth.js            # HMAC-SHA256 webhook signature verification
│   │   └── errorHandler.js         # Global Express error handler
│   ├── routes/
│   │   ├── accounts.js             # Virtual account CRUD
│   │   ├── webhooks.js             # Inbound Nomba webhook receiver
│   │   ├── transactions.js         # Global transaction feed and live summary
│   │   ├── health.js               # Active dependency health check
│   │   ├── bankHealth.js           # Failure rate per bank code
│   │   └── auditLog.js             # Audit log read and chain verification
│   ├── services/
│   │   ├── nomba.js                # Nomba API client — auth, circuit breakers, retry
│   │   ├── provisioning.js         # Account creation, balance, transaction history
│   │   ├── reconciliation.js       # Ledger write, settlement match, auto-reversal
│   │   ├── bankHealth.js           # Bank failure rate aggregation and classification
│   │   └── auditLog.js             # Hash-chained audit log write and verify
│   ├── workers/
│   │   └── reconciliationWorker.js # BullMQ worker + periodic reconciliation cycle
│   ├── queues/
│   │   └── webhookQueue.js         # BullMQ queue definition
│   ├── public/
│   │   ├── index.html              # Ops dashboard
│   │   └── dashboard.js            # Dashboard polling and rendering logic
│   └── lib/
│       ├── stateTransitions.js     # State machine validator
│       ├── circuitBreaker.js       # opossum circuit breaker factory
│       ├── tokenMutex.js           # Token refresh mutex
│       └── logger.js               # pino structured logger
├── tests/
│   ├── stateTransitions.test.js
│   ├── reconciliation.test.js
│   └── resolveTransaction.test.js
├── scripts/
│   ├── fireTestWebhook.js          # Signed end-to-end webhook smoke test
│   ├── loadTest.js                 # Concurrent webhook load test
│   └── testReversal.js             # Live reversal integration test
├── .github/workflows/ci.yml        # GitHub Actions CI pipeline
├── Dockerfile
├── docker-compose.yml
└── .env.example
```

---

## Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 18 |
| Framework | Express 5 |
| ORM | Prisma 6 |
| Job queue | BullMQ 5 |
| Queue backend | Redis (Render) |
| Circuit breaker | opossum |
| Retries | async-retry |
| Validation | zod |
| Logging | pino |
| Database | PostgreSQL 15 (Render) |
| CI | GitHub Actions |
| Hosting | Render |
