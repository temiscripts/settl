# Settl

**Infrastructure layer for dedicated virtual account systems built on Nomba.**

Settl provisions a unique bank account number per customer, ingests payment webhooks into an internal ledger, automatically reconciles pending transactions against Nomba's requery API, and reverses confirmed failures — all without the calling application writing any payment logic.

Built for the Nomba × DevCareer Hackathon 2026.

---

## Table of Contents

- [Architecture](#architecture)
- [API Reference](#api-reference)
- [Getting Started](#getting-started)
- [Environment Variables](#environment-variables)
- [Running Tests](#running-tests)
- [Deployment](#deployment)
- [Production Engineering](#production-engineering)
- [Transaction State Machine](#transaction-state-machine)
- [Project Structure](#project-structure)

---

## Architecture

```
                        ┌─────────────┐
                        │   Nomba API  │
                        └──────┬──────┘
                               │ webhooks
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

- The HTTP handler that receives Nomba webhooks does exactly three things: validate the request, check idempotency, enqueue the job. It never touches the database directly. This decouples acknowledgement from processing — Nomba's delivery never times out regardless of downstream latency.
- Every Nomba API call is wrapped in a circuit breaker. If Nomba becomes degraded, the circuit opens and callers receive a `503` immediately rather than waiting for timeouts that would exhaust the database connection pool.
- All state transitions are validated at the application layer before any database write. An illegal transition throws before the query runs.

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
| `expectedAmount` | integer | No | Expected payment amount in **kobo**. Enables over/underpayment detection. |
| `expiryDate` | ISO 8601 datetime | No | If set, the account is automatically marked expired after this time. |

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

Returns paginated transaction history for an account.

**Query parameters:** `page` (default: 1), `limit` (default: 20, max: 100)

---

### Webhooks

#### `POST /v1/webhooks/nomba`

Inbound webhook receiver for Nomba payment events. Nomba calls this endpoint; your application does not.

The handler performs replay-attack prevention (rejects timestamps older than 10 minutes 30 seconds), idempotency checking on `transactionId`, and enqueues the job to BullMQ before returning `200`. Processing is entirely asynchronous.

> **Note:** Full HMAC signature verification is implemented as a stub pending integration with the cybersecurity module.

---

### Health

#### `GET /v1/health`

Active health check that pings all dependencies. Does not return `200` based on a hardcoded value — each check runs a real probe.

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
| `409` | Duplicate `accountRef` (idempotency conflict) |
| `422` | Semantically invalid input (e.g. negative amount) |
| `503` | Circuit breaker open — Nomba API unavailable |
| `500` | Unhandled server error |

---

## Getting Started

### Prerequisites

- Node.js >= 18
- Docker and Docker Compose (for local development)
- A Nomba account with `clientId`, `clientSecret`, and a parent account ID

### Local setup with Docker Compose

```bash
# Clone the repository
git clone https://github.com/temiscripts/settl.git
cd settl

# Copy the environment template and fill in your Nomba credentials
cp .env.example .env

# Start all services (app + Postgres + Redis)
docker compose up --build
```

The API will be available at `http://localhost:3000`.

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

| Variable | Description | Example |
|---|---|---|
| `DATABASE_URL` | PostgreSQL connection string | `postgresql://user:pass@host:5432/settl` |
| `REDIS_URL` | Redis connection string (supports `rediss://` for TLS) | `redis://localhost:6379` |
| `NOMBA_BASE_URL` | Nomba API base URL | `https://api.nomba.com/v1` |
| `NOMBA_PARENT_ACCOUNT_ID` | Your Nomba parent account UUID | `f666ef9b-...` |
| `NOMBA_SUB_ACCOUNT_ID` | Sub-account UUID used for virtual account provisioning | `1dde5fef-...` |
| `NOMBA_CLIENT_ID` | OAuth client ID | `e5e85b13-...` |
| `NOMBA_CLIENT_SECRET` | OAuth client secret | `8/doS7Q3w77...` |
| `NOMBA_WEBHOOK_SECRET` | HMAC signing key for webhook verification | `NombaHackathon2026` |
| `PORT` | HTTP server port | `3000` |
| `NODE_ENV` | Runtime environment | `production` |
| `LOG_LEVEL` | Pino log level | `info` |

> **All amounts are stored and transmitted in kobo.** 1 naira = 100 kobo. The API never accepts or returns naira values.

---

## Running Tests

Tests use Node.js's built-in `node:test` runner — no additional test framework is required.

```bash
npm test
```

The test suite requires a live PostgreSQL connection. Set `DATABASE_URL` in your environment or `.env` file before running. Tests create and clean up their own data; they do not touch production records.

**Test coverage**

| File | What is tested |
|---|---|
| `tests/stateTransitions.test.js` | All 5 valid transitions pass. Every illegal state-to-state pair throws with a descriptive message. Terminal states have no outgoing transitions. |
| `tests/reconciliation.test.js` | Settlement match logic for exact, overpaid, underpaid, and null-expected-amount cases. Duplicate `merchantTxRef` rejected at the database constraint level. Non-existent account throws before any write. |
| `tests/resolveTransaction.test.js` | Nomba status `settled` advances state. Status `pending` makes no change. Status `failed` triggers reversal and gracefully handles Nomba API being unavailable in the test environment. |

CI runs the full suite on every push to `main` and `develop` via GitHub Actions, with a real PostgreSQL service container.

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
| Redis | Upstash (serverless Redis) |

**Live endpoint:** https://settl-878p.onrender.com

---

## Production Engineering

### Circuit Breaker

All three Nomba API call sites — virtual account creation, transaction requery, and reversal — are individually wrapped with [opossum](https://nodeshift.dev/opossum/) circuit breakers.

| Parameter | Value |
|---|---|
| Failure threshold | 50% |
| Reset timeout | 30 seconds |
| Per-call timeout | 5 seconds |

When a circuit opens, callers receive a `503` immediately. Circuit state changes (open, half-open, closed) are logged as structured events.

### Retry with Jitter

Every Nomba API call uses [async-retry](https://github.com/vercel/async-retry) with exponential backoff and random jitter. Jitter prevents all workers from retrying simultaneously after an outage, which would recreate the original spike.

```
delay = 2^(attempt - 1) × 1000ms + random(0, 1000ms)
```

4xx responses from Nomba bail immediately — they represent caller errors that retrying will not fix.

### Token Refresh Mutex

The Nomba access token has a finite lifetime. Under concurrent load, multiple requests can detect expiry simultaneously. Without coordination, each would attempt a refresh — racing to write the same cached token.

A Promise-chain mutex ensures only one refresh runs at a time. All other callers wait on the same Promise and receive the token once it resolves. No request ever sees an expired token or triggers a redundant refresh call.

### Outbound Idempotency (Two-Generals Problem)

Every reversal call to Nomba includes:

```
X-Idempotency-Key: {merchantTxRef}:reversal
```

This key is deterministic and stable across retries. If the server crashes after sending the reversal request but before receiving Nomba's confirmation, and the reconciliation worker retries, Nomba deduplicates on this key. The customer is reversed exactly once regardless of how many times the request is sent.

### Atomic Database Writes

Every operation that spans multiple tables is wrapped in `prisma.$transaction()`. Specifically: a transaction state change and its corresponding audit log entry always commit together or not at all. A server crash between two writes cannot leave the database in a partially updated state.

### Graceful Shutdown

On `SIGTERM` (issued by Render during deploys and restarts):

1. The HTTP server stops accepting new connections
2. The reconciliation interval is cleared
3. The BullMQ worker drains in-flight jobs
4. The job queue closes
5. The database connection pool closes
6. The process exits with code `0`

A restart never interrupts a transaction mid-reconciliation.

### Structured Logging

All logs are JSON emitted by [pino](https://getpino.io). Every log line produced during a request lifecycle carries the correlation ID generated at request entry, making it possible to reconstruct the full journey of any webhook through the system from a single search.

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

## Transaction State Machine

```
initiated ──▶ pending ──▶ settled
                    │
                    └──▶ failed ──▶ reversing ──▶ reversed
```

`settled` and `reversed` are terminal. No transition out of either state is permitted. Any attempt to write an illegal transition throws at the application layer before the query is issued.

The `settlementMatch` field is recorded on every transaction:

| Value | Meaning |
|---|---|
| `exact` | Received amount matches `expectedAmount` |
| `overpaid` | Received amount exceeds `expectedAmount` |
| `underpaid` | Received amount is below `expectedAmount` — transaction stays pending |
| `null` | No `expectedAmount` was set on the account |

---

## Project Structure

```
settl/
├── prisma/
│   └── schema.prisma               # Single schema — Account, Transaction, AuditLog
├── src/
│   ├── index.js                    # Server entry point, graceful shutdown
│   ├── middleware/
│   │   ├── requestId.js            # Correlation ID on every request
│   │   ├── rateLimiter.js          # Rate limiting on the webhook endpoint
│   │   └── errorHandler.js         # Global Express error handler
│   ├── routes/
│   │   ├── accounts.js             # Virtual account CRUD endpoints
│   │   ├── webhooks.js             # Inbound Nomba webhook receiver
│   │   └── health.js               # Active health check
│   ├── services/
│   │   ├── nomba.js                # Nomba API client — auth, circuit breakers, retry
│   │   ├── provisioning.js         # Account creation, balance, transaction history
│   │   ├── reconciliation.js       # Ledger write, settlement match, auto-reversal
│   │   └── auditLog.js             # Audit log write (stub — in progress)
│   ├── workers/
│   │   └── reconciliationWorker.js # BullMQ worker + 60s reconciliation cycle
│   ├── queues/
│   │   └── webhookQueue.js         # BullMQ queue definition and DLQ config
│   └── lib/
│       ├── stateTransitions.js     # State machine validator
│       ├── circuitBreaker.js       # opossum circuit breaker factory
│       ├── tokenMutex.js           # Token refresh mutex
│       └── logger.js               # pino structured logger
├── tests/
│   ├── stateTransitions.test.js
│   ├── reconciliation.test.js
│   └── resolveTransaction.test.js
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
| Queue backend | Redis (Upstash) |
| Circuit breaker | opossum |
| Retries | async-retry |
| Validation | zod |
| Logging | pino |
| Database | PostgreSQL 15 |
| CI | GitHub Actions |
| Hosting | Render |
