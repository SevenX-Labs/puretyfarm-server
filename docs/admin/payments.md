# Admin Payments & Cash Collection API

Admin reference for the payment ledger, cash-collection reconciliation and
manual gateway refund retry.

> **Related docs:**
> - `docs/admin/wallet.md` — admin approval/rejection; the rejection endpoint already auto-initiates the PhonePe refund
> - `docs/customer/payments.md` — top-up creation, verification, PhonePe webhook and browser return
> - `docs/customer/wallet.md` — wallet balance / ledger / credit-request lifecycle

---

## 1. Overview

Admins have three kinds of control over money:

| Area | Where | Behaviour |
|------|-------|-----------|
| **Online payments** | this document (read-only) + wallet reject | Admins can only read online payment state. The payment becomes `SUCCESS` strictly through a verified PhonePe Order Status API result — never through an admin action. |
| **Cash collections** | this document | Admins confirm or cancel physical cash. Cash collections serve two purposes: **wallet top-up** (credits the wallet on confirm) and **plan payment** (activates the plan and creates deliveries on confirm). |
| **Refunds** | wallet reject auto-initiates; this document exposes a manual retry | A rejected online credit request triggers a PhonePe refund automatically (see `docs/admin/wallet.md` §5). This document's refund endpoint exists for manual retry if the automatic call failed. |

### Architectural separation (non-negotiable)

- **Payment verification gate**: `Payment.status = SUCCESS` happens only via a
  PhonePe Order Status API check. No admin endpoint can set it.
- **Physical cash gate**: cash credits land only after an admin confirms the
  physical collection.
- **Wallet ledger ownership**: `WalletService` is the only writer of
  `Wallet.balancePaise` and `WalletTransaction`.

### Authentication & authorization

```http
Authorization: Bearer <ADMIN_ACCESS_TOKEN>
```

Protected with `@UseGuards(JwtAuthGuard)` and `@Roles('ADMIN')`.

- Admin identity for cash confirmation always comes from `JWT.sub` —
  `adminId` is never read from the body.
- Customer tokens → `403`. Missing/invalid tokens → `401`.

### Money & route conventions

- All amounts are **integer paise**.
- No response contains a gateway credential, raw card data, provider tokens or private
  keys. The stored `providerResponse` is sanitised before persistence.
- Every route is served at both `/api/v1/admin/payments/...` and
  `/admin/payments/...`.

---

## 2. Endpoints at a glance

| Method | Path | Purpose |
|--------|------|---------|
| `GET`  | `/api/v1/admin/payments` | List payments with filters |
| `GET`  | `/api/v1/admin/payments/:id` | Payment detail (sanitised provider payload) |
| `GET`  | `/api/v1/admin/payments/cash-collections` | List cash collections |
| `GET`  | `/api/v1/admin/payments/cash-collections/:id` | Cash collection detail |
| `POST` | `/api/v1/admin/payments/cash-collections/:id/confirm` | Confirm cash + credit wallet |
| `POST` | `/api/v1/admin/payments/cash-collections/:id/cancel` | Cancel cash (no wallet credit, no refund) |
| `POST` | `/api/v1/admin/payments/credit-requests/:creditRequestId/refund` | Manual refund retry |

> **Deliberately absent**: no endpoint lets an admin set a payment's status,
> approve a payment, mark one `SUCCESS`, or back-date a refund. These would
> break the verification gate.

---

## 3. `GET /api/v1/admin/payments` — list

**Query:**

| Param | Type | Notes |
|-------|------|-------|
| `status` | `PaymentTransactionStatus` | `PENDING` \| `PROCESSING` \| `SUCCESS` \| `FAILED` \| `CANCELLED` \| `EXPIRED` \| `REFUND_PENDING` \| `REFUNDED` |
| `purpose` | `ORDER` \| `WALLET_TOPUP` | |
| `paymentMethod` | `ONLINE` \| `CASH` | |
| `transactionId` | string ≤ 64 | Exact match on merchant txnid (e.g. `PFMH2K8A1B2C3D4E5F`) |
| `customerSearch` | string ≤ 100 | Case-insensitive partial match on mobile / email / firstName / lastName |
| `startDate` | `YYYY-MM-DD` | Inclusive on `createdAt` |
| `endDate` | `YYYY-MM-DD` | Inclusive end date |
| `page` | int ≥ 1 | default `1` |
| `limit` | int 1–100 | default `20` |

**Response `200`:**

```json
{
  "data": [
    {
      "id": "pay-...",
      "transactionId": "PFMH2K8A1B2C3D4E5F",
      "providerPaymentId": "403993715530182741",
      "provider": "PHONEPE",
      "purpose": "WALLET_TOPUP",
      "paymentMethod": "ONLINE",
      "amountPaise": 100000,
      "currency": "INR",
      "status": "SUCCESS",
      "failureCode": null,
      "failureMessage": null,
      "walletCreditRequestId": "wcr-...",
      "orderId": null,
      "expiresAt": "2026-10-06T00:30:00.000Z",
      "completedAt": "2026-10-06T00:05:00.000Z",
      "refundedAt": null,
      "createdAt": "2026-10-06T00:00:00.000Z",
      "updatedAt": "2026-10-06T00:05:00.000Z",
      "customer": {
        "id": "usr-...",
        "mobile": "+919876543210",
        "email": "customer@example.com",
        "name": "Rahul Sharma"
      }
    }
  ],
  "pagination": { "page": 1, "limit": 20, "total": 1, "totalPages": 1 }
}
```

---

## 4. `GET /api/v1/admin/payments/:id` — detail

**Response `200`:** every field from the list form, plus:

```json
{
  "...": "every field as above",
  "providerResponse": {
    "mode": "UPI",
    "bankcode": "UPI",
    "status": "success",
    "unmappedstatus": "captured"
  },
  "walletCredit": {
    "id": "wcr-...",
    "status": "PENDING",
    "amountPaise": 100000,
    "autoApproved": false,
    "refundStatus": "NOT_REQUIRED",
    "adminNote": null,
    "completedAt": null,
    "transactionId": null
  }
}
```

Notes:
- `providerResponse` is **always** sanitised: `hash`, `salt`, `key`, card
  numbers, tokens are stripped before persistence; only primitive echo values
  survive. No gateway credential is ever written to the database.
- `walletCredit.transactionId` is the id of the matching `WalletTransaction`
  ledger row (not the gateway transaction id); null when the credit has not been applied.

**Errors:** `404 PAYMENT_NOT_FOUND`.

---

## 5. `GET /api/v1/admin/payments/cash-collections` — list

**Query:**

| Param | Type | Notes |
|-------|------|-------|
| `status` | `PENDING` \| `COLLECTED` \| `CONFIRMED` \| `CANCELLED` | |
| `customerSearch` | string ≤ 100 | Partial match on mobile / email / name |
| `startDate` / `endDate` | `YYYY-MM-DD` | Inclusive on `createdAt` |
| `page` | int ≥ 1 | default `1` |
| `limit` | int 1–100 | default `20` |

**Response `200`:**

```json
{
  "data": [
    {
      "id": "csh-...",
      "amountPaise": 50000,
      "status": "PENDING",
      "purpose": "WALLET_TOPUP",
      "walletCreditRequestId": "wcr-...",
      "planSelectionId": null,
      "collectedAt": null,
      "confirmedAt": null,
      "createdAt": "2026-10-06T19:00:00.000Z",
      "customer": {
        "id": "usr-...",
        "mobile": "+919876543210",
        "email": "customer@example.com",
        "name": "Rahul Sharma"
      }
    }
  ],
  "pagination": { "page": 1, "limit": 20, "total": 1, "totalPages": 1 }
}
```

---

## 6. `GET /api/v1/admin/payments/cash-collections/:id` — detail

**Response `200`:**

```json
{
  "id": "csh-...",
  "amountPaise": 50000,
  "status": "CONFIRMED",
  "collectedAt": "2026-10-06T19:20:00.000Z",
  "confirmedAt": "2026-10-06T19:25:00.000Z",
  "confirmedByAdminId": "adm-...",
  "adminNote": "Cash handed over by delivery partner",
  "createdAt": "2026-10-06T19:00:00.000Z",
  "updatedAt": "2026-10-06T19:25:00.000Z",
  "customer": {
    "id": "usr-...",
    "mobile": "+919876543210",
    "email": "customer@example.com",
    "name": "Rahul Sharma"
  },
  "walletCredit": {
    "id": "wcr-...",
    "status": "COMPLETED",
    "amountPaise": 50000,
    "completedAt": "2026-10-06T19:25:00.000Z",
    "transactionId": "txn-..."
  }
}
```

**Errors:** `404 CASH_COLLECTION_NOT_FOUND`.

---

## 7. `POST /api/v1/admin/payments/cash-collections/:id/confirm`

Confirms physical cash was received. Behaviour depends on the cash collection's purpose:

| Purpose | Trigger | Side effects on confirm |
|---------|---------|------------------------|
| **Wallet top-up** | `POST /customer/payments/create` with `paymentMethod: "CASH"` | Wallet credited, `WalletTransaction` written, `autoCreditEnabled` flipped if first credit |
| **Plan payment** | `POST /customer/plans/confirm` with `paymentMethod: "CASH"` | Wallet credited (`CASH_COLLECTION`), wallet debited (`PLAN_SELECTION`), `autoCreditEnabled` flipped if first credit, plan activated (`CONFIRMED`), quote confirmed, deliveries materialised |

The admin does not need to distinguish — the system routes automatically based on which FK is set (`walletCreditRequestId` or `planSelectionId`).

**Request body (all optional):**

```json
{ "note": "Cash received and reconciled from delivery partner" }
```

| Field | Type | Rules |
|-------|------|-------|
| `note` | string | Optional; trimmed; max 1000 chars |

**Response `200` (wallet top-up):**

```json
{
  "success": true,
  "message": "Cash confirmed and wallet credited.",
  "cashCollection": {
    "id": "csh-...",
    "status": "CONFIRMED",
    "amountPaise": 50000,
    "confirmedAt": "2026-10-06T19:25:00.000Z"
  },
  "walletCredit": {
    "id": "wcr-...",
    "status": "COMPLETED",
    "amountPaise": 50000
  }
}
```

**Response `200` (plan payment):**

```json
{
  "success": true,
  "message": "Cash confirmed and plan activated.",
  "cashCollection": {
    "id": "csh-...",
    "status": "CONFIRMED",
    "amountPaise": 17000,
    "confirmedAt": "2026-10-06T19:25:00.000Z"
  }
}
```

**Side effects for wallet top-up (atomic, single DB transaction):**

1. `CashCollection.status`: `PENDING | COLLECTED → CONFIRMED` with
   `confirmedByAdminId = JWT.sub`, `confirmedAt = NOW()`, `collectedAt = NOW()`.
2. `WalletCreditRequest.status`: `PENDING → COMPLETED`.
3. `Wallet.balancePaise` incremented by `amountPaise`.
4. Immutable `WalletTransaction` written (`type=CREDIT`, `referenceType=CREDIT_REQUEST`).
5. If this is the customer's first completed credit,
   `Wallet.autoCreditEnabled` flips to `true`.

**Side effects for plan payment (atomic, single DB transaction):**

1. `CashCollection.status`: `PENDING | COLLECTED → CONFIRMED`.
2. `PlanSelection.status`: `PENDING_PAYMENT → CONFIRMED`, with `paidAt` and `paidAmountPaise` set.
3. `PlanQuote.status`: `PENDING → CONFIRMED`.
4. Delivery rows (`PlanDelivery`) materialised for the plan schedule.

**Errors:**

| HTTP | Code | Scenario |
|------|------|----------|
| 404 | `CASH_COLLECTION_NOT_FOUND` | Unknown id |
| 409 | `CASH_COLLECTION_ALREADY_PROCESSED` | Status is not `PENDING` or `COLLECTED` |

**Idempotency:** a second confirmation hits the conditional guard and returns
`409`; wallet is credited exactly once.

---

## 8. `POST /api/v1/admin/payments/cash-collections/:id/cancel`

Cancels a cash collection — cash was never received.

**Request body:**

```json
{ "note": "Customer unavailable at the collection address." }
```

| Field | Type | Rules |
|-------|------|-------|
| `note` | string | **Required**; trimmed; 3–1000 chars |

**Response `200`:**

```json
{
  "success": true,
  "message": "Cash collection cancelled. No wallet credit was made.",
  "cashCollection": {
    "id": "csh-...",
    "status": "CANCELLED",
    "amountPaise": 50000,
    "adminNote": "Customer unavailable at the collection address."
  }
}
```

**Side effects:**

- `CashCollection.status`: `PENDING | COLLECTED → CANCELLED`.
- **Wallet top-up purpose:** Linked `WalletCreditRequest.status`: `PENDING → CANCELLED` (frees the one-pending-per-wallet slot).
- **Plan payment purpose:** Linked `PlanSelection.status`: `PENDING_PAYMENT → CANCELLED` and `PlanQuote.status`: `PENDING → CANCELLED`.
- **No wallet credit, no gateway refund call** — cash was never collected and
  there is no online payment to reverse. Any physical cash that did arrive is
  reconciled offline.

**Errors:**

| HTTP | Code | Scenario |
|------|------|----------|
| 400 | — | Missing or too-short `note` |
| 404 | `CASH_COLLECTION_NOT_FOUND` | Unknown id |
| 409 | `CASH_COLLECTION_ALREADY_PROCESSED` | Status is not `PENDING` or `COLLECTED` |

---

## 9. `POST /api/v1/admin/payments/credit-requests/:creditRequestId/refund`

**Manual refund retry.** The wallet reject endpoint
(`POST /admin/wallet/credit-requests/:id/reject`) already triggers this
orchestration automatically. Use this endpoint only when the automatic call
failed (provider timeout, upstream 5xx) and you need to retry.

**Request body:** none. The amount is read from the stored `Payment` row — the
admin cannot change it.

**Response `200`:**

```json
{
  "success": true,
  "message": "Refund requested. It is marked REFUNDED only after the provider confirms it.",
  "payment": {
    "id": "pay-...",
    "transactionId": "PFMH2K8A1B2C3D4E5F",
    "status": "REFUND_PENDING",
    "amountPaise": 100000,
    "providerRefundId": "918237461"
  }
}
```

**Full refund flow (same for the automatic path):**

```text
1. WalletCreditRequest is in REJECTED status
   ↓
2. Find the matching ONLINE Payment with status=SUCCESS
   ↓
3. Atomic claim:
      UPDATE payments SET status='REFUND_PENDING'
      WHERE id=:id AND status='SUCCESS'
   (second caller matches 0 rows → 409)
   ↓
4. PhonePeService.refundPayment(transactionId, amountPaise)
      → POST /apis/pg/payments/v2/refund
      - merchantRefundId = `RFND-<transactionId>` (deterministic; PhonePe
        dedupes retries)
      - originalMerchantOrderId = `<transactionId>`
   ↓
5. PhonePe accepts (state=PENDING) → store providerRefundId (PhonePe refundId)
   PhonePe refuses → release claim: REFUND_PENDING → SUCCESS,
                     refundStatus → REFUND_FAILED, return 409
   Network error  → release claim, bubble up as 5xx
   ↓
6. (Asynchronously) PhonePe sends pg.refund.completed to
      POST /api/v1/payments/webhooks/phonepe
   The handler re-checks GET /payments/v2/refund/RFND-<txnid>/status and
   acts only on state=COMPLETED.
   ↓
7. Payment REFUND_PENDING → REFUNDED, refundedAt=NOW
   WalletCreditRequest.refundStatus → REFUNDED
```

**Errors:**

| HTTP | Code | Scenario |
|------|------|----------|
| 404 | `CREDIT_REQUEST_NOT_FOUND` | Unknown id |
| 409 | `CREDIT_REQUEST_NOT_REJECTED` | The credit request is not in `REJECTED` |
| 409 | `NO_REFUNDABLE_PAYMENT` | No settled ONLINE payment exists (cash top-up) |
| 409 | `PROVIDER_PAYMENT_ID_MISSING` | Online payment has no PhonePe order reference |
| 409 | `REFUND_ALREADY_IN_PROGRESS` | Another request already claimed the refund |
| 409 | `REFUND_REJECTED_BY_PROVIDER` | PhonePe refused the refund |

**Idempotency:**
- The `SUCCESS → REFUND_PENDING` conditional update means a second concurrent
  caller fails with `409 REFUND_ALREADY_IN_PROGRESS`.
- The `merchantRefundId` sent to PhonePe is `RFND-<transactionId>`,
  deterministic per payment, so repeated attempts at the provider for the same
  payment are the same request to PhonePe rather than two separate refunds.

---

## 10. The PhonePe webhook (public)

PhonePe calls `POST /api/v1/payments/webhooks/phonepe` for the
`checkout.order.completed` and `checkout.order.failed` events selected in the
dashboard. The admin app does not call this. For completeness:

- **Public endpoint**, no JWT.
- Authentication is the `Authorization` header only: PhonePe sets it to
  `SHA256(PHONEPE_WEBHOOK_USERNAME:PHONEPE_WEBHOOK_PASSWORD)`, hex-encoded,
  and the server compares it in constant time. A mismatch returns
  `403 PAYMENT_SIGNATURE_INVALID`.
- **The event body is never proof of payment.** After the header check passes,
  the handler re-reads the outcome from PhonePe's Order Status API over a
  server-to-server call, and applies only that. An authentic-looking event
  claiming a success PhonePe does not hold changes nothing.
- A PhonePe outage during that re-check returns `503`, so PhonePe retries the
  event rather than treating it as delivered.
- Idempotent: a replayed webhook matches no row via conditional updates and
  returns `{ outcome: "DUPLICATE" }`.
- Settles the payment through the exact same state machine as the browser
  return, so even if the user closed the tab the webhook still credits the
  wallet (for subsequent auto-credit) or holds the credit request pending (for
  first credit).

> The old `POST /api/v1/payments/webhooks/payu` route no longer exists.

---

## 11. Error code reference

| HTTP | Code | Scenario |
|------|------|----------|
| 400 | — | DTO validation (missing note, invalid date, etc.) |
| 401 | — | Missing / expired token |
| 403 | — | Non-admin token |
| 404 | `PAYMENT_NOT_FOUND` | Unknown payment id |
| 404 | `CASH_COLLECTION_NOT_FOUND` | Unknown cash-collection id |
| 404 | `CREDIT_REQUEST_NOT_FOUND` | Unknown credit-request id |
| 409 | `CASH_COLLECTION_ALREADY_PROCESSED` | Confirmed/cancelled already |
| 409 | `CREDIT_REQUEST_NOT_REJECTED` | Refund attempted on a non-rejected request |
| 409 | `NO_REFUNDABLE_PAYMENT` | Cash top-up or no settled payment |
| 409 | `PROVIDER_PAYMENT_ID_MISSING` | Online payment missing providerPaymentId |
| 409 | `REFUND_ALREADY_IN_PROGRESS` | A refund is in flight |
| 409 | `REFUND_REJECTED_BY_PROVIDER` | PhonePe refused the refund |

---

## 12. Step-by-step cURL

```bash
export BASE_URL="https://api-puretyfarm.onrender.com"
export ADMIN_TOKEN="<admin access token>"
```

### List pending cash collections
```bash
curl -i -X GET \
  "$BASE_URL/api/v1/admin/payments/cash-collections?status=PENDING&page=1&limit=20" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

### Confirm a cash collection (credits the wallet)
```bash
curl -i -X POST \
  "$BASE_URL/api/v1/admin/payments/cash-collections/<CSH_ID>/confirm" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "note": "Cash received at depot" }'
```

### Cancel a cash collection
```bash
curl -i -X POST \
  "$BASE_URL/api/v1/admin/payments/cash-collections/<CSH_ID>/cancel" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "note": "Customer unavailable" }'
```

### List online payments in REFUND_PENDING
```bash
curl -i -X GET \
  "$BASE_URL/api/v1/admin/payments?status=REFUND_PENDING&paymentMethod=ONLINE" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

### Manually retry a refund (only after an auto-refund failure)
```bash
curl -i -X POST \
  "$BASE_URL/api/v1/admin/payments/credit-requests/<WCR_ID>/refund" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

---

## 13. Frontend integration checklist

1. **Do not call the refund endpoint after a reject under normal circumstances**
   — the wallet reject already does this. Only use it as a retry button when
   `response.refund.refundInitiated === false` and the reason indicates a
   genuine failure (not `NO_REFUNDABLE_PAYMENT`).
2. After cash confirmation, refetch both the cash-collection detail and the
   customer's wallet view — the wallet now shows the new balance.
3. For a cash top-up, the refund button must be hidden in the UI. Cash
   refunds happen offline.
4. Treat `REFUND_PENDING` as "awaiting PhonePe confirmation". Only when the
   payment lands in `REFUNDED` should the UI show "Refund complete".
5. The admin **cannot** change a refund amount — it always matches the stored
   `Payment.amountPaise`. If the UI shows an input for refund amount, remove
   it.
6. Payment status changes landing without an admin action (e.g. a payment
   flipping from `PENDING` to `SUCCESS` or `EXPIRED` while the admin was
   viewing it) are the webhook / scheduler at work; just refetch.
