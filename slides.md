# Settl — Presentation Slides
# Nomba x DevCareer Hackathon 2026

---

## SLIDE 1 — Cover

**Settl**
Infrastructure for dedicated virtual account systems

Nomba x DevCareer Hackathon 2026
Team: [Your team name]

---

## SLIDE 2 — The Problem

**Every business collecting payments faces the same three problems:**

1. **Account chaos** — sharing one bank account across customers means you cannot tell who paid what
2. **Silent failures** — a payment leaves the sender but never arrives. Nobody knows. The customer is stuck.
3. **Manual reversals** — when a payment fails, someone has to manually initiate the refund. That person can make mistakes, double-reverse, or simply forget.

These problems get worse at scale. A marketplace with 10,000 customers cannot have a human reconciling payments.

---

## SLIDE 3 — What Settl Does

**One account per customer. Automatic everything else.**

- Provisions a **dedicated virtual bank account** per customer via Nomba
- Receives payment webhooks and writes them to an **internal ledger**
- Automatically **reconciles** stuck transactions by querying Nomba until they reach a final state
- Automatically **reverses** confirmed failed payments — no human needed
- Detects **over and underpayments** and records exactly what arrived vs what was expected
- Monitors **per-bank failure rates** in real time

The calling application never writes payment logic. It provisions an account and reads its balance.

---

## SLIDE 4 — Architecture

```
Nomba API
    │
    │  signed webhooks
    ▼
Express Handler          ← validate signature, check idempotency, enqueue
    │
    │  BullMQ job
    ▼
Webhook Worker           ← write ledger, update state, write audit log
    │
    │  every 60s
    ▼
Reconciliation Worker    ← requery Nomba → settle or reverse
    │
    │  reversal
    ▼
Nomba Transfers API
```

**The HTTP handler never touches the database.**
Nomba gets `200` in milliseconds. Processing happens in a worker.

---

## SLIDE 5 — The Webhook Pipeline

**What happens when Nomba fires a webhook:**

1. HMAC-SHA256 signature verified — timing-safe, replay window enforced
2. Redis idempotency check — duplicate webhooks silently discarded
3. Event type checked — `payment_failed` events routed directly to reversal
4. Job enqueued to BullMQ — `200` returned to Nomba immediately
5. Worker picks up the job — writes transaction, computes settlement match, updates state, appends audit log entry

**Result:** 500 simultaneous webhooks are all acknowledged in under 10ms each. Processing happens at the worker's pace with no data loss.

---

## SLIDE 6 — Reconciliation and Auto-Reversal

**The two-phase recovery system:**

**Phase 1 — Reconciliation**
Every 60 seconds, the worker queries Nomba's requery API for every pending transaction with exponential backoff. When Nomba confirms a terminal state, the transaction moves to `settled` or `failed`.

**Phase 2 — Auto-Reversal**
When a transaction is confirmed failed, Settl immediately initiates a reversal via Nomba's transfers API with:
```
X-Idempotency-Key: {merchantTxRef}:reversal
```
This key is deterministic. If the server crashes mid-reversal and retries, Nomba deduplicates the request. **The customer is never double-reversed.**

---

## SLIDE 7 — Security

**Four layers of protection on every inbound webhook:**

| Layer | What it does |
|---|---|
| HMAC-SHA256 | Verifies the payload came from Nomba, not an attacker |
| Timestamp check | Rejects replayed requests older than 10 min 30 sec |
| Redis idempotency | Blocks duplicate processing before touching the database |
| DB unique constraint | Second line of defence — database rejects duplicates even if application code has a bug |

**Tamper-evident audit log:**
Every state change is written to a SHA-256 hash chain. Editing any past entry breaks every hash after it. Chain integrity is verifiable via `GET /v1/audit-log/verify`.

---

## SLIDE 8 — Reliability

**What keeps Settl running when things go wrong:**

| Problem | Solution |
|---|---|
| Nomba is slow or down | Circuit breaker — callers get `503` immediately, not a timeout |
| Nomba rate limits us | Exponential backoff with jitter — no thundering herd |
| Token expires mid-flight | Promise-chain mutex — only one refresh, all others wait |
| Server crashes mid-write | Prisma `$transaction` — state change and audit log commit together or not at all |
| Two workers race on same transaction | Redis distributed lock — only one worker processes each reconciliation cycle |
| Server crashes mid-reversal | Outbound idempotency key — Nomba deduplicates the retry |

---

## SLIDE 9 — Bank Health Monitor

**Real-time visibility into which banks are causing failures**

Settl captures the sender's bank code from every inbound webhook and tracks the outcome. The bank health API computes failure rates across the last N transactions per bank:

| Status | Failure rate |
|---|---|
| Healthy | < 10% |
| Degraded | 10–30% |
| Critical | ≥ 30% |

Merchants can query `GET /v1/bank-health/:bankCode` before routing a transfer to warn customers proactively: *"Payments to this bank are experiencing delays."*

---

## SLIDE 10 — Ops Dashboard

**Live visibility without a separate frontend deployment**

The dashboard is served at `/` by the same Express server — plain HTML and JavaScript, no framework, no build step.

It polls the API every 5 seconds and shows:
- Transaction counts by state (pending / settled / failed / reversing / reversed)
- Settlement match breakdown (exact / overpaid / underpaid)
- Per-bank health cards with failure rates
- Recent transactions table
- Audit trail with live hash chain verification status

When Nomba fires a real payment webhook, the transaction appears on the dashboard within 5 seconds.

---

## SLIDE 11 — Live Demo

**End-to-end with real Nomba infrastructure:**

1. Provision a virtual account → `POST /v1/accounts`
2. Direct a payment to the account number Nomba returns
3. Nomba fires a signed webhook to `https://settl-878p.onrender.com/v1/webhooks/nomba`
4. Dashboard updates within 5 seconds — transaction visible, audit log growing
5. Reconciliation worker picks up any pending transactions and resolves them
6. Failed transactions auto-reverse — state moves to `reversing` → `reversed`

**Dashboard:** https://settl-878p.onrender.com  
**Health:** https://settl-878p.onrender.com/v1/health

---

## SLIDE 12 — Technical Decisions Worth Noting

**Why BullMQ instead of processing webhooks synchronously?**
Nomba has a delivery timeout. Processing synchronously means a slow database write can cause Nomba to retry, creating duplicates. The queue decouples the two — Nomba always gets `200` in milliseconds.

**Why a hash chain audit log instead of a regular log table?**
A regular log can be edited without detection. The hash chain means any modification to any past entry is mathematically detectable. This matters for financial dispute resolution.

**Why Redis for idempotency and not just the database?**
The database unique constraint is the source of truth, but Redis is faster. The Redis check happens before any database round-trip, keeping the common path (non-duplicate webhook) cheap.

---

## SLIDE 13 — What We Built in 7 Days

| Component | Status |
|---|---|
| Virtual account provisioning | Done |
| Webhook ingestion with HMAC verification | Done |
| BullMQ async processing pipeline | Done |
| Settlement match detection | Done |
| Reconciliation worker with exponential backoff | Done |
| Auto-reversal with outbound idempotency | Done |
| Tamper-evident hash-chain audit log | Done |
| Bank health monitor and failure classifier | Done |
| Ops dashboard with 5-second live polling | Done |
| Circuit breaker on all Nomba API calls | Done |
| Distributed lock for multi-instance safety | Done |
| CI/CD with GitHub Actions + Render | Done |

---

## SLIDE 14 — What's Next

- **User-facing bank health warnings** — merchants query `/v1/bank-health/:bankCode` before routing a payment to warn customers before the transfer fails
- **Dashboard authentication** — API key or session-based auth before exposing to non-internal users
- **Webhook DLQ inspector** — UI panel to view and reprocess jobs that exhausted all retries
- **Account provisioning UI** — form on the dashboard to provision accounts without using curl

The foundation is production-ready. Everything above is feature addition, not architectural change.

---

## SLIDE 15 — Team

**Track:** Infrastructure — Dedicated Virtual Account System

| Role | Responsibility |
|---|---|
| Backend #1 | Account provisioning, state machine, balance computation |
| Backend #2 | Reconciliation engine, reversal, webhook pipeline |
| Cybersecurity | HMAC verification, audit log, idempotency |
| Data Science | Bank health monitor, failure classifier |

**Repository:** https://github.com/temiscripts/settl
