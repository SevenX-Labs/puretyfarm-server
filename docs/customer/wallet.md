# Customer Wallet API

Complete customer-facing reference for the PuretyFarm Wallet module. The
frontend should implement wallet UI strictly from this document.

> **Related docs:**
> - `docs/customer/payments.md` — how money enters the wallet (PayU / Cash)
> - `docs/admin/wallet.md` — admin approval, rejection and auto-refund flow

---

## 1. Overview

Each customer has one `Wallet` holding a prepaid INR balance in **integer
paise** (₹1 = 100 paise). The wallet is credited through the Payment module
(PayU online or physical cash) and may be debited by future order payments.

### Key concepts

| Concept | Meaning |
|---------|---------|
| **Wallet** | One per customer, created lazily on first interaction |
| **WalletCreditRequest** | A pending or completed request to add money to the wallet |
| **WalletTransaction** | An immutable ledger row recording a balance change |
| **autoCreditEnabled** | A per-wallet boolean. Governs whether a verified ONLINE top-up auto-credits or waits for admin approval. Flipped `true` atomically on first completed credit. |
| **Idempotency-Key** | Required header on `POST /credit-request` to prevent duplicate submissions |

### Money convention

**All amounts in integer paise.** Never floats, never strings.

| Rupees | Paise |
|--------|-------|
| ₹1 | `100` |
| ₹500 | `50000` |
| ₹1,000 | `100000` |
| ₹10,000 | `1000000` |

The frontend formats paise → rupees only at display time. All API I/O is paise.

---

## 2. Authentication

All endpoints require a **Customer JWT**:

```http
Authorization: Bearer <ACCESS_TOKEN>
```

- Customer identity always comes from `JWT.sub`.
- The request body never accepts `userId`, `walletId`, `balancePaise`,
  `autoCreditEnabled`, `status`, `refundStatus` or `adminId`. These are
  stripped by the global `whitelist: true` validation pipe.
- A customer with no wallet row gets one created automatically on their first
  call to any wallet endpoint.

---

## 3. Customer-specific auto-credit (`autoCreditEnabled`)

Each wallet carries its own `autoCreditEnabled` flag. There is **no global
setting**; one customer's state never affects another.

```text
                 CUSTOMER
                    │
                    ↓
                 Wallet
                    │
             autoCreditEnabled
                    │
             ┌──────┴──────┐
             │             │
            TRUE          FALSE
             │             │
             ↓             ↓
        AUTO CREDIT    ADMIN APPROVAL
```

| State | Default | Set by |
|-------|---------|--------|
| `false` | Every new wallet | Schema default (`@default(false)`) |
| `true` | Returning customers who have completed at least one credit | Flipped atomically inside the DB transaction that completes the **first** wallet credit |

**Rules:**

1. **First credit always requires admin approval or cash confirmation**, even
   if the flag somehow became true some other way. The decision reads
   `autoCreditEnabled` fresh from the DB on every request.
2. **Subsequent VERIFIED ONLINE credits** auto-credit when `autoCreditEnabled = true`.
3. **Cash top-ups never auto-credit.** Even for an enabled wallet, cash still
   waits for the admin's physical confirmation.
4. **Zero balance does not reset the flag.** A customer who spent down to ₹0
   remains a returning customer.
5. **The customer cannot set this flag.** Submitting `{ "autoCreditEnabled": true }` is a no-op.

---

## 4. Credit flow summary

### First online credit (admin-approved)

```text
Customer → POST /customer/payments/create (ONLINE)
   ↓
PayU Hosted Checkout
   ↓
PayU SUCCESS
   ↓
Payment SUCCESS                        ← money collected
   ↓
WalletCreditRequest PENDING             ← wallet balance unchanged
   ↓
Admin reviews → POST /admin/wallet/credit-requests/:id/approve
   ↓
WalletCreditRequest COMPLETED           ← in the SAME DB transaction:
Wallet balance +amount                     - ledger row written
WalletTransaction CREDIT                  - balance updated
autoCreditEnabled → true                   - flag flipped
```

### Subsequent online credit (auto)

```text
Customer → POST /customer/payments/create (ONLINE)
   ↓
PayU SUCCESS
   ↓
Payment SUCCESS
   ↓
Load this wallet's autoCreditEnabled = true
   ↓
AUTO CREDIT                             ← no admin involved
Wallet balance +amount
WalletTransaction CREDIT
```

### Cash top-up (always admin-confirmed)

```text
Customer → POST /customer/payments/create (CASH)
   ↓
CashCollection PENDING                   ← no PayU, no Payment row
   ↓
Delivery partner collects physical cash
   ↓
Admin → POST /admin/payments/cash-collections/:id/confirm
   ↓
WalletCreditRequest COMPLETED
Wallet balance +amount
WalletTransaction CREDIT
autoCreditEnabled → true (if first)
```

### First online credit — rejected (auto-refund)

```text
PayU SUCCESS → Payment SUCCESS → WalletCreditRequest PENDING
   ↓
Admin → POST /admin/wallet/credit-requests/:id/reject (with note)
   ↓
WalletCreditRequest REJECTED, refundStatus=REFUND_PENDING
   ↓
(same request) PaymentsService.initiateRefundIfApplicable
   ↓
Payment SUCCESS → REFUND_PENDING, PayU refund API called
   ↓
PayU refund webhook arrives (verified)
   ↓
Payment REFUNDED, WalletCreditRequest refundStatus=REFUNDED
Wallet balance never changed; autoCreditEnabled stays false
```

---

## 5. Balance & lifecycle rules

- **Negative balance impossible** — enforced by a DB `CHECK (balancePaise >= 0)`.
- **One PENDING credit request per wallet** — enforced by a partial unique
  index. A second concurrent request returns `409 WALLET_PENDING_REQUEST_EXISTS`.
- **Immutable ledger** — `WalletTransaction` rows are read-only. Database
  triggers reject any UPDATE or DELETE.
- **Running balance snapshot** — every ledger row stores `balanceAfterPaise`
  computed inside the same atomic UPDATE as the balance change.

---

## 6. Credit-request status reference

| Status | Meaning | Terminal? |
|--------|---------|-----------|
| `PENDING` | Awaiting admin approval, cash confirmation, or verified ONLINE auto-credit | no |
| `COMPLETED` | Wallet was credited | yes |
| `REJECTED` | Admin rejected; refund workflow started for online top-ups | yes |
| `CANCELLED` | Funding never arrived (PayU payment failed/cancelled/expired, or cash collection cancelled). No refund. | yes |

Refund status (only relevant for `REJECTED`):

| `refundStatus` | Meaning |
|----------------|---------|
| `NOT_REQUIRED` | Default; no money was ever collected |
| `REFUND_PENDING` | PayU refund has been requested |
| `REFUNDED` | PayU refund webhook confirmed |
| `REFUND_FAILED` | Provider refused the refund request |

---

## 7. Endpoints

All routes are also served without the `/api/v1` prefix (`/customer/wallet/...`).

### 7.1 `GET /api/v1/customer/wallet`

Fetch the authenticated customer's wallet.

**Request:** no body, no query.

**Response `200`:**

```json
{
  "balancePaise": 150000,
  "currency": "INR",
  "autoCreditEnabled": true,
  "createdAt": "2026-10-01T08:00:00.000Z",
  "updatedAt": "2026-10-06T11:30:00.000Z"
}
```

Field notes:

| Field | Type | Notes |
|-------|------|-------|
| `balancePaise` | integer | Current spendable balance in paise |
| `currency` | string | Always `"INR"` today |
| `autoCreditEnabled` | boolean | Whether subsequent verified ONLINE credits auto-credit without admin approval |
| `createdAt` / `updatedAt` | ISO 8601 | Timestamps |

---

### 7.2 `POST /api/v1/customer/wallet/credit-request`

Direct wallet credit request. This is the **unverified** path — it exists for
legacy flows and is subject to the same first-credit rule as the Payment
module. For actual money collection via PayU or cash, use
`POST /customer/payments/create` instead.

**Headers:**

| Header | Required | Notes |
|--------|----------|-------|
| `Authorization: Bearer <token>` | yes | Customer JWT |
| `Idempotency-Key: <string>` | yes | Fresh UUID per user intent; reuse on retry |

**Request body:**

```json
{ "amount": 50000 }
```

| Field | Type | Rules |
|-------|------|-------|
| `amount` | integer (paise) | Must fall within wallet min/max (default 100 – 1,000,000) |

**Response `201` — queued for approval (first credit, or `autoCreditEnabled=false`):**

```json
{
  "id": "wcr-1092a3f0-4491",
  "amountPaise": 50000,
  "status": "PENDING",
  "autoApproved": false,
  "message": "Credit request submitted for admin approval.",
  "createdAt": "2026-10-06T11:00:00.000Z"
}
```

**Response `201` — auto-credited (`autoCreditEnabled=true`):**

```json
{
  "id": "wcr-1092a3f0-4491",
  "amountPaise": 50000,
  "status": "COMPLETED",
  "autoApproved": true,
  "message": "Wallet credited successfully.",
  "createdAt": "2026-10-06T11:00:00.000Z"
}
```

**Idempotent replay** (same key, same amount):

```json
{
  "id": "wcr-1092a3f0-4491",
  "replayed": true,
  "...": "..."
}
```

**Errors:**

| HTTP | `error` | Cause |
|------|---------|-------|
| 400 | — | Missing `Idempotency-Key` |
| 400 | `INVALID_CREDIT_AMOUNT` | Amount out of range or not an integer |
| 409 | `WALLET_PENDING_REQUEST_EXISTS` | A credit request is already pending |
| 409 | `IDEMPOTENCY_KEY_REUSED` | Same key reused with different amount |

---

### 7.3 `GET /api/v1/customer/wallet/transactions`

The customer's immutable ledger, scoped to their own wallet.

**Query:**

| Param | Type | Default |
|-------|------|---------|
| `type` | `CREDIT` \| `DEBIT` | all |
| `startDate` | `YYYY-MM-DD` | — |
| `endDate` | `YYYY-MM-DD` (inclusive) | — |
| `page` | int ≥ 1 | 1 |
| `limit` | int 1–100 | 20 |

**Response `200`:**

```json
{
  "data": [
    {
      "id": "txn-5512b9a0",
      "type": "CREDIT",
      "amountPaise": 50000,
      "balanceAfterPaise": 150000,
      "referenceType": "CREDIT_REQUEST",
      "referenceId": "wcr-1092a3f0-4491",
      "description": "Wallet credit (auto-credited after verified payment)",
      "createdAt": "2026-10-06T11:05:00.000Z"
    }
  ],
  "pagination": { "page": 1, "limit": 20, "total": 1, "totalPages": 1 }
}
```

| `referenceType` | Meaning |
|-----------------|---------|
| `CREDIT_REQUEST` | A wallet top-up (ONLINE or CASH) |
| `ORDER` | An order payment debit |
| `PLAN_SELECTION` | A plan purchase debit (prepaid plan payment via wallet) |

---

### 7.4 `GET /api/v1/customer/wallet/credit-requests`

The customer's own credit requests.

**Query:**

| Param | Type | Default |
|-------|------|---------|
| `status` | `PENDING` \| `COMPLETED` \| `REJECTED` \| `CANCELLED` | all |
| `page` | int ≥ 1 | 1 |
| `limit` | int 1–100 | 20 |

**Response `200`:**

```json
{
  "data": [
    {
      "id": "wcr-aaaa",
      "amountPaise": 100000,
      "status": "COMPLETED",
      "autoApproved": false,
      "completedAt": "2026-10-05T18:35:00.000Z",
      "createdAt": "2026-10-05T18:30:00.000Z"
    },
    {
      "id": "wcr-bbbb",
      "amountPaise": 50000,
      "status": "REJECTED",
      "autoApproved": false,
      "adminNote": "Amount could not be reconciled",
      "refundStatus": "REFUND_PENDING",
      "reviewedAt": "2026-10-05T19:00:00.000Z",
      "createdAt": "2026-10-05T18:50:00.000Z"
    }
  ],
  "pagination": { "page": 1, "limit": 20, "total": 2, "totalPages": 1 }
}
```

Fields returned depend on status:
- `PENDING`: `id`, `amountPaise`, `status`, `autoApproved`, `createdAt`
- `COMPLETED`: adds `completedAt`
- `REJECTED`: adds `adminNote`, `refundStatus`, `reviewedAt`

---

## 8. Error code reference

| Code | HTTP | Scenario |
|------|------|----------|
| `INVALID_CREDIT_AMOUNT` | 400 | Amount outside wallet bounds or non-integer |
| `WALLET_PENDING_REQUEST_EXISTS` | 409 | One PENDING already exists for this wallet |
| `IDEMPOTENCY_KEY_REUSED` | 409 | Key reused with different parameters |
| `INSUFFICIENT_WALLET_BALANCE` | 400 | Debit would make balance negative |
| `CREDIT_REQUEST_NOT_FOUND` | 404 | Unknown credit request id |

Standard infrastructure errors:

| HTTP | Scenario |
|------|----------|
| 401 | Missing / expired / revoked token |
| 403 | Token has wrong role (admin on customer route, etc.) |

---

## 9. Security rules

- A customer can only read their own wallet, transactions, and credit requests.
- `userId`, `walletId`, `balancePaise`, `status`, `autoCreditEnabled`,
  `refundStatus`, `adminId` are never accepted from the request body.
- An admin token calling customer routes gets 403; a customer token on admin
  routes gets 403.
- A missing or invalid token returns 401 before any handler runs.

---

## 10. Frontend integration checklist

1. Always send `Idempotency-Key` on `POST /credit-request` and retry the same
   key on network errors — the server deduplicates.
2. Treat `autoCreditEnabled: false` as the default new-user state. Show
   "pending admin approval" messaging after any first credit request.
3. Treat `autoCreditEnabled: true` as a signal that a successful PayU payment
   will land in the wallet immediately, so the UI can show "Wallet credited"
   on the result page.
4. Never read `balancePaise` from your own cache after a payment attempt —
   always refetch `GET /customer/wallet` on return from PayU to see the real
   state.
5. For the "payment success + wallet pending" case (first credit), the UI must
   show two distinct messages: "Payment Successful" (the money reached PayU)
   and "Wallet Credit Awaiting Approval" (the admin has not approved yet).
