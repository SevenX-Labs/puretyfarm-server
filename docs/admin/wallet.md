# Admin Wallet API

Admin endpoints for reviewing and acting on customer wallet credit requests.
This document is the single source of truth for the frontend admin console.

> **Related docs:**
> - `docs/customer/wallet.md` — customer-facing wallet behaviour
> - `docs/admin/payments.md` — refund orchestration, cash collections, payment ledger

---

## 1. Overview

Admins act on `WalletCreditRequest` rows in one of two ways:

| Action | Result | Side effect |
|--------|--------|-------------|
| **Approve** | Credit the wallet via `WalletService` inside a single DB transaction | Also flips the customer's `autoCreditEnabled` to `true` if this is their first completed credit |
| **Reject** | Mark `REJECTED` + `refundStatus=REFUND_PENDING` and **automatically start the PayU refund** for online top-ups | Cash top-ups have no PayU payment, so the refund call is a no-op |

Admin identity for both actions comes from `JWT.sub`. The request body **never**
accepts an `adminId`.

### Authentication & authorization

```http
Authorization: Bearer <ADMIN_ACCESS_TOKEN>
```

All routes carry `@UseGuards(JwtAuthGuard)` and `@Roles('ADMIN')`.
- A customer token on any admin route → `403 Forbidden`.
- A missing or invalid token → `401 Unauthorized`.

### Money convention

Every monetary field is **integer paise** (₹1 = 100). No floating-point.

### Route prefixes

Each admin route is served both at `/api/v1/admin/wallet/...` and at
`/admin/wallet/...` for backwards compatibility.

---

## 2. Approval model (per-wallet, not global)

Each wallet has its own `autoCreditEnabled` boolean. There is **no**
`WALLET_AUTO_CREDIT_ENABLED` env flag any more — the previous global switch
has been removed from business logic.

```text
Credit request needs approval?
   ↓
Load wallet.autoCreditEnabled
   ↓
   ├── FALSE (default for every new customer) → ADMIN APPROVAL REQUIRED
   └── TRUE  (returning customer with at least one completed credit) → AUTO-CREDIT
```

**Invariants:**

1. **First credit always requires approval** regardless of anything else —
   because every new wallet starts at `autoCreditEnabled = false`.
2. **The flag flips to `true` atomically** inside the same transaction as the
   first `COMPLETED` credit — nowhere else.
3. **Cash top-ups never auto-credit.** Even if `autoCreditEnabled = true`, cash
   still waits for admin confirmation via `/admin/payments/cash-collections/:id/confirm`.
4. **The customer cannot set the flag.** No DTO accepts it.
5. **Zero balance does not reset the flag.**

See `docs/customer/wallet.md` §3 for the full behaviour.

---

## 3. State transitions

```text
WalletCreditRequest status machine

PENDING ─────── admin approve ──────▶ COMPLETED  (terminal; wallet credited)
   │
   ├────────── admin reject ───────▶ REJECTED   (terminal; refund flow starts for online)
   │
   └── funding never arrived ─────▶ CANCELLED  (terminal; no refund obligation)
                                          ▲
                 (set by Payment module when a PayU payment
                  fails/is cancelled/is expired, or by admin
                  cash cancellation)
```

Illegal transitions all return `409 CREDIT_REQUEST_ALREADY_PROCESSED`:
- `COMPLETED → REJECTED`
- `REJECTED → COMPLETED`
- `COMPLETED → COMPLETED` (double approve)
- `REJECTED → REJECTED` (double reject)
- `CANCELLED → anything`

Transitions are enforced by a conditional `updateMany WHERE status = PENDING`
guard, so two concurrent admins never both win.

---

## 4. Approve flow

```text
1. Admin calls POST /admin/wallet/credit-requests/:id/approve
   ↓
2. Atomic conditional update:
     UPDATE wallet_credit_requests
     SET status='COMPLETED', reviewedByAdminId=<admin.sub>, reviewedAt=NOW(), completedAt=NOW()
     WHERE id=:id AND status='PENDING'
   ↓
3. If 0 rows affected → 404 or 409
   ↓
4. WalletService.applyBalanceChange (same tx):
     - adds amountPaise to Wallet.balancePaise (CHECK >= 0 enforced)
     - writes immutable WalletTransaction (type=CREDIT, referenceType=CREDIT_REQUEST)
     - unique index on (type, referenceType, referenceId) prevents duplicate credit
   ↓
5. If wallet.autoCreditEnabled was false, conditional flip to true (same tx)
   ↓
6. 200 OK
```

---

## 5. Reject flow (with automatic PayU refund)

**Breaking change from earlier versions:** the admin reject endpoint now
automatically starts the PayU refund for online top-ups. The frontend no
longer has to make a second call to `/admin/payments/credit-requests/:id/refund`
after a reject.

```text
1. Admin calls POST /admin/wallet/credit-requests/:id/reject (with mandatory note)
   ↓
2. Atomic conditional update (WalletService):
     UPDATE wallet_credit_requests
     SET status='REJECTED', refundStatus='REFUND_PENDING',
         reviewedByAdminId=<admin.sub>, adminNote=:note, reviewedAt=NOW()
     WHERE id=:id AND status='PENDING'
   ↓
3. Wallet balance is NOT changed. No WalletTransaction row is created.
   ↓
4. Same request: PaymentsService.initiateRefundIfApplicable(id)
   ├── Finds the settled ONLINE Payment (status=SUCCESS) linked to this request
   │     ├── Atomic claim: Payment.status SUCCESS → REFUND_PENDING
   │     ├── Calls PayuService.refundPayment() → PayU cancel_refund_transaction API
   │     └── Stores providerRefundId
   │
   ├── Cash top-up (no PayU Payment) → no-op, reason="NO_REFUNDABLE_PAYMENT"
   ├── Already in progress → no-op, reason="REFUND_ALREADY_IN_PROGRESS"
   └── Any genuine failure → bubbles up as a 5xx; wallet reject still holds
   ↓
5. Return 200 OK with { ...rejection, refund: { refundInitiated, reason? } }
   ↓
6. (Asynchronously) PayU sends a verified refund webhook
   ↓
7. Webhook handler: Payment REFUND_PENDING → REFUNDED,
                     WalletCreditRequest.refundStatus = REFUNDED
```

The wallet reject **always** holds, even if the PayU call fails. The admin can
then retry via the manual refund endpoint
`POST /admin/payments/credit-requests/:id/refund` (see `docs/admin/payments.md`).

---

## 6. Endpoints

### 6.1 `GET /api/v1/admin/wallet/credit-requests` — list

**Query:**

| Param | Type | Default | Notes |
|-------|------|---------|-------|
| `status` | `PENDING` \| `COMPLETED` \| `REJECTED` \| `CANCELLED` | all | |
| `customerSearch` | string ≤ 100 | — | Matches mobile, email, firstName, lastName (case-insensitive, partial) |
| `startDate` | `YYYY-MM-DD` | — | Inclusive on `createdAt` |
| `endDate` | `YYYY-MM-DD` | — | Inclusive end date |
| `page` | int ≥ 1 | `1` | |
| `limit` | int 1–100 | `20` | |

**Response `200`:**

```json
{
  "data": [
    {
      "id": "wcr-aaaa",
      "amountPaise": 100000,
      "status": "PENDING",
      "refundStatus": "NOT_REQUIRED",
      "autoApproved": false,
      "adminNote": null,
      "reviewedAt": null,
      "completedAt": null,
      "createdAt": "2026-10-06T11:00:00.000Z",
      "customer": {
        "id": "usr-...",
        "mobile": "+919876543210",
        "email": "customer@example.com",
        "name": "Rahul Sharma"
      },
      "transaction": null
    }
  ],
  "pagination": { "page": 1, "limit": 20, "total": 1, "totalPages": 1 }
}
```

`transaction` is `null` while `status != COMPLETED`; once completed it carries
`{ id, amountPaise, balanceAfterPaise, createdAt }`.

---

### 6.2 `GET /api/v1/admin/wallet/credit-requests/:id` — detail

**Response `200`:**

```json
{
  "id": "wcr-aaaa",
  "amountPaise": 100000,
  "status": "COMPLETED",
  "refundStatus": "NOT_REQUIRED",
  "autoApproved": false,
  "adminNote": null,
  "reviewedByAdminId": "adm-...",
  "reviewedAt": "2026-10-06T11:35:00.000Z",
  "completedAt": "2026-10-06T11:35:00.000Z",
  "createdAt": "2026-10-06T11:00:00.000Z",
  "updatedAt": "2026-10-06T11:35:00.000Z",
  "customer": {
    "id": "usr-...",
    "mobile": "+919876543210",
    "email": "customer@example.com",
    "name": "Rahul Sharma"
  },
  "walletBalancePaise": 100000,
  "transaction": {
    "id": "txn-...",
    "type": "CREDIT",
    "amountPaise": 100000,
    "balanceAfterPaise": 100000,
    "createdAt": "2026-10-06T11:35:00.000Z"
  }
}
```

**Errors:**
- `404 CREDIT_REQUEST_NOT_FOUND`

---

### 6.3 `POST /api/v1/admin/wallet/credit-requests/:id/approve`

**Request body:** `{}` (empty).

**Response `200`:**

```json
{
  "success": true,
  "message": "Credit request approved and wallet credited.",
  "request": {
    "id": "wcr-aaaa",
    "status": "COMPLETED",
    "amountPaise": 100000
  }
}
```

**Side effects:**
- `Wallet.balancePaise` incremented by `amountPaise`.
- Immutable `WalletTransaction` row written.
- If this was the customer's first completed credit,
  `Wallet.autoCreditEnabled` flips to `true` **atomically** in the same tx.

**Errors:**

| HTTP | Code | Scenario |
|------|------|----------|
| 404 | `CREDIT_REQUEST_NOT_FOUND` | Unknown id |
| 409 | `CREDIT_REQUEST_ALREADY_PROCESSED` | Status is not `PENDING` |

Concurrent approves: exactly one wins (DB-enforced), the other gets 409.

---

### 6.4 `POST /api/v1/admin/wallet/credit-requests/:id/reject`

**Request body:**

```json
{
  "note": "Payment could not be reconciled against the bank statement."
}
```

| Field | Type | Rules |
|-------|------|-------|
| `note` | string | Trimmed; required; 3–1000 chars |

**Response `200`:**

```json
{
  "success": true,
  "message": "Credit request rejected.",
  "request": {
    "id": "wcr-aaaa",
    "status": "REJECTED",
    "refundStatus": "REFUND_PENDING",
    "adminNote": "Payment could not be reconciled against the bank statement."
  },
  "refund": {
    "refundInitiated": true
  }
}
```

**`refund` field reference:**

| `refundInitiated` | `reason` | Meaning |
|-------------------|----------|---------|
| `true` | — | PayU refund request was accepted; wait for the refund webhook |
| `false` | `"NO_REFUNDABLE_PAYMENT"` | Cash top-up (no PayU payment exists) |
| `false` | `"REFUND_ALREADY_IN_PROGRESS"` | A previous attempt already claimed the refund |
| `false` | `"CREDIT_REQUEST_NOT_REJECTED"` | Guard tripped (shouldn't occur on this path) |

**Side effects:**
- `WalletCreditRequest` → `REJECTED` with `refundStatus = REFUND_PENDING`.
- Wallet balance is NOT touched. No `WalletTransaction` is created.
- For an online top-up: linked `Payment` moves `SUCCESS → REFUND_PENDING`; the
  PayU refund API is called with `providerPaymentId` and the stored
  `amountPaise`. The admin cannot change the refund amount.
- For a cash top-up: nothing is sent to PayU.

**Errors:**

| HTTP | Code | Scenario |
|------|------|----------|
| 400 | — | `note` missing or outside length bounds |
| 404 | `CREDIT_REQUEST_NOT_FOUND` | Unknown id |
| 409 | `CREDIT_REQUEST_ALREADY_PROCESSED` | Status is not `PENDING` |

> If the PayU provider call itself fails (network error, upstream 5xx), the
> wallet rejection is still durable. The response surfaces the HTTP error, and
> the admin can retry the refund via the manual endpoint
> `POST /admin/payments/credit-requests/:id/refund` later.

---

### 6.5 `GET /api/v1/admin/wallet/customers/:userId` — customer wallet view

Read-only view: current balance, summary stats, and the 10 most recent ledger
rows. No endpoint anywhere can mutate a balance directly — all changes flow
through the ledger path.

**Response `200`:**

```json
{
  "customer": {
    "id": "usr-...",
    "mobile": "+919876543210",
    "email": "customer@example.com",
    "name": "Rahul Sharma"
  },
  "balancePaise": 100000,
  "summary": {
    "totalCreditsPaise": 200000,
    "totalCreditsCount": 2,
    "totalDebitsPaise": 100000,
    "totalDebitsCount": 1
  },
  "recentTransactions": [
    {
      "id": "txn-...",
      "type": "DEBIT",
      "amountPaise": 100000,
      "balanceAfterPaise": 100000,
      "referenceType": "ORDER",
      "referenceId": "ord-...",
      "description": "Order payment",
      "createdAt": "2026-10-06T12:00:00.000Z"
    }
  ],
  "createdAt": "2026-10-01T08:00:00.000Z",
  "updatedAt": "2026-10-06T12:00:00.000Z"
}
```

**Errors:**
- `404` — Customer wallet not found

---

## 7. Error code reference

| Code | HTTP | Scenario |
|------|------|----------|
| `CREDIT_REQUEST_NOT_FOUND` | 404 | Credit request id does not exist |
| `CREDIT_REQUEST_ALREADY_PROCESSED` | 409 | Not in `PENDING` status |
| — | 400 | Validation (missing note, out-of-range length, etc.) |
| — | 401 | Missing / expired / revoked token |
| — | 403 | Non-admin token |

Infrastructure-level `500` means the wallet rejection may or may not have
landed; retry with the same ids — the conditional-update guard makes it safe.

---

## 8. Concurrency & integrity guarantees

- **Approve / reject races**: conditional `WHERE status = PENDING` guard means
  exactly one request wins. The loser gets 409.
- **Double credit prevention**: unique index on `wallet_transactions
  (type, referenceType, referenceId)` guarantees at most one `CREDIT` ledger
  row per credit request.
- **Immutable ledger**: PostgreSQL triggers reject UPDATE and DELETE on
  `wallet_transactions`.
- **Balance floor**: `CHECK (balancePaise >= 0)` enforced at DB level.
- **Atomic flag flip**: `autoCreditEnabled` write happens inside the same
  transaction as the ledger write, so a transaction rollback leaves nothing
  inconsistent.

---

## 9. Step-by-step cURL

```bash
export BASE_URL="https://api-puretyfarm.onrender.com"
export ADMIN_TOKEN="<admin access token>"
```

### List pending requests
```bash
curl -i -X GET \
  "$BASE_URL/api/v1/admin/wallet/credit-requests?status=PENDING&page=1&limit=20" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

### Approve a credit request
```bash
curl -i -X POST \
  "$BASE_URL/api/v1/admin/wallet/credit-requests/<ID>/approve" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}'
```

### Reject a credit request (auto-initiates PayU refund for online)
```bash
curl -i -X POST \
  "$BASE_URL/api/v1/admin/wallet/credit-requests/<ID>/reject" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "note": "Payment could not be reconciled against the bank statement."
  }'
```

### View a customer's wallet
```bash
curl -i -X GET \
  "$BASE_URL/api/v1/admin/wallet/customers/<USER_ID>" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

---

## 10. Frontend integration checklist

1. **Rejecting a credit request is enough** — do not make a second call to the
   payments refund endpoint. Read `response.refund.refundInitiated` to show
   the correct status.
2. For `refund.reason === "NO_REFUNDABLE_PAYMENT"` show "Cash top-up — no
   refund needed." Reconcile physical cash offline.
3. The refund is **not** complete after this call — it only moves to
   `REFUND_PENDING`. Final `REFUNDED` state comes from a verified PayU
   webhook. Poll `GET /admin/payments/:id` or `GET /admin/wallet/credit-requests/:id`
   to see the final state.
4. On a race / 409 response, refetch the request detail: another admin likely
   already acted.
5. The `autoCreditEnabled` field is informational on the customer-wallet view
   — treat it as read-only. There is no API to toggle it today.
