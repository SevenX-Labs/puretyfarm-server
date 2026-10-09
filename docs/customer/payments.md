# Customer Payments API

Complete customer-facing reference for the PuretyFarm Payment module. The
frontend must implement the top-up and payment-result UX strictly from this
document.

> **Related docs:**
> - `docs/customer/wallet.md` — wallet balance, ledger, credit-request lifecycle
> - `docs/admin/payments.md` — admin cash-collection and refund controls
> - `docs/admin/wallet.md` — approval / rejection / auto-refund orchestration

---

## 1. Overview

The Payment module verifies and records **money movement**. It never mutates a
wallet balance itself — that is the Wallet module's single responsibility.

Two ways to top up a wallet:

| Method | Gateway | What proves the money arrived | Wallet is credited by |
|--------|---------|-------------------------------|-----------------------|
| `ONLINE` | PhonePe Standard Checkout (v2) | PhonePe's **Order Status API**, queried server-to-server after an authenticated webhook or the browser return | Admin approval (first time) or automatic (per-wallet `autoCreditEnabled=true`) |
| `CASH` | None | Admin confirmation after physical cash reaches the depot | Admin confirmation only — never automatic |

**Plan payments and this module:** Plans are paid directly at plan confirmation
time via the Plans module (`POST /customer/plans/confirm` with `paymentMethod:
"WALLET"` or `"CASH"`). When a customer's wallet balance is insufficient, they
use this Payment module to top up their wallet (Add Money → ONLINE → PhonePe),
then return to the Plans module to complete the purchase with WALLET. There is
**no direct gateway checkout for plan purchases** — PhonePe is used only for
wallet top-ups and online order payments.

### Authentication

```http
Authorization: Bearer <CUSTOMER_ACCESS_TOKEN>
```

- Customer identity always comes from `JWT.sub`.
- No field in any request body is trusted for `userId`, `walletId`,
  `transactionId` (output only), `status`, `amount` (except on `/create`),
  `autoCreditEnabled`, or `adminId`. Unknown fields are stripped by
  `whitelist: true`.

### Money convention

**Integer paise everywhere in the API.** PhonePe also speaks integer paise, so
no rupee-decimal conversion happens anywhere in the online payment path. (PayU
required one; it is gone.)

### Route prefixes

Each route is served at both `/api/v1/customer/payments/...` and
`/customer/payments/...` for backwards compatibility.

---

## 2. Architecture overview

```text
                        PAYMENT MODULE
                              │
                 ┌────────────┴────────────┐
                 │                         │
               ONLINE                    CASH
          (PhonePe gateway)      (physical collection)
                 │                         │
                 ↓                         ↓
          Payment record            CashCollection
                 │                         │
                 └────────────┬────────────┘
                              ↓
                   WalletCreditRequest
                              │
                  ┌───────────┴───────────┐
                  │                       │
               FIRST                  SUBSEQUENT
          (autoCredit=false)      (autoCredit=true, online only)
                  │                       │
                  ↓                       ↓
            Admin approve /          Auto credit
          cash confirmation
                  │                       │
                  └───────────┬───────────┘
                              ↓
                     WalletService ledger
                              ↓
                    Wallet balance change
```

> **Scheduler**: a cron (every 10 minutes) expires online payments the customer
> never completed, so an abandoned checkout does not block future top-ups.
> See `docs/admin/scheduler.md`. The scheduler never credits a wallet.

---

## 3. The two-events rule (first credit)

For a customer's **first** wallet credit, "Payment Successful" and "Wallet
Credited" are **two different events**. The UI must show them differently:

```text
FIRST CREDIT

PhonePe order COMPLETED (confirmed via the Order Status API)
   ↓
Payment SUCCESS                       ← money collected, show "Payment Successful"
   ↓
WalletCreditRequest PENDING            ← balance unchanged
   ↓
(wait for admin approval)
   ↓
Admin APPROVE
   ↓
WalletCreditRequest COMPLETED           ← now show "Wallet Credited"
Wallet balance increases
Wallet.autoCreditEnabled → true
```

For every **subsequent** online credit (per-wallet `autoCreditEnabled = true`):

```text
PhonePe order COMPLETED
   ↓
Payment SUCCESS
   ↓
WalletCreditRequest COMPLETED, Wallet credited          ← one event
```

Read these fields from the API:

| Field | Meaning |
|-------|---------|
| `payment.status = "SUCCESS"` | Money reached PhonePe and we verified it server-to-server |
| `walletCredit.status = "PENDING"` | Awaiting admin approval — balance unchanged |
| `walletCredit.status = "COMPLETED"` | Balance has already increased |

---

## 4. Cash flow

```text
POST /customer/payments/create { amount, paymentMethod: "CASH" }
   ↓
CashCollection PENDING, WalletCreditRequest PENDING, NO Payment row
   ↓
Delivery partner collects physical cash
   ↓
Admin → POST /admin/payments/cash-collections/:id/confirm
   ↓
Wallet credited, autoCreditEnabled → true (if first credit)
```

Cash **never** auto-credits, even if `autoCreditEnabled = true`. The admin
confirmation is the only trigger.

Cash is also **never refunded through the gateway**. Cash cancellation
(`/admin/payments/cash-collections/:id/cancel`) moves the credit request to
`CANCELLED` and the cash is reconciled offline.

---

## 5. Rejection → automatic gateway refund

When an admin rejects a credit request that had a settled ONLINE payment, the
Payment module **automatically** starts the refund during that same admin
request. The customer does not need to do anything.

```text
Payment SUCCESS → WalletCreditRequest PENDING
   ↓
Admin REJECT  (POST /admin/wallet/credit-requests/:id/reject)
   ↓
Wallet NEVER credited, no ledger row
   ↓
Payment SUCCESS → REFUND_PENDING  (atomic claim; a second reject can't double-call PhonePe)
   ↓
PhonePe POST /payments/v2/refund called with merchantRefundId = RFND-<txnid>
   ↓
(wait for a PhonePe refund confirmation)
   ↓
Payment REFUNDED, WalletCreditRequest.refundStatus = REFUNDED
```

`merchantRefundId` is derived from the transaction id, so a retried rejection
is the **same** refund request to PhonePe rather than a second refund.

`REFUNDED` is only reached after PhonePe's Refund Status API reports
`COMPLETED` — never on the back of PhonePe merely accepting the request.

> ⚠️ **Configuration gap:** reaching `REFUNDED` automatically requires the
> `pg.refund.completed` and `pg.refund.failed` events to be enabled for the
> webhook in the PhonePe dashboard. They are **not** currently selected (only
> `checkout.order.completed` and `checkout.order.failed` are). Until they are,
> a refund stays in `REFUND_PENDING` after PhonePe accepts it; the handler for
> those events is already implemented and needs no code change.

The customer can read the current state at any time:
- `GET /customer/payments/:id` — includes `walletCredit.refundStatus`
- `GET /customer/wallet/credit-requests` — filter by `status=REJECTED`

---

## 6. Endpoints

### 6.1 `POST /api/v1/customer/payments/create`

Starts a wallet top-up.

**Headers:**

| Header | Required | Notes |
|--------|----------|-------|
| `Authorization: Bearer <token>` | yes | Customer JWT |
| `Idempotency-Key: <string>` | yes | Fresh UUID per user intent; reuse on retry |
| `Content-Type: application/json` | yes | |

**Request body:**

```json
{
  "amount": 100000,
  "paymentMethod": "ONLINE"
}
```

| Field | Type | Rules |
|-------|------|-------|
| `amount` | integer (paise) | Must fall within wallet min/max (default 100 – 1,000,000) |
| `paymentMethod` | `"ONLINE"` \| `"CASH"` | required |

**Response `201` — ONLINE:**

```json
{
  "payment": {
    "id": "pay-...",
    "transactionId": "PFMH2K8A1B2C3D4E5F",
    "providerPaymentId": null,
    "provider": "PHONEPE",
    "purpose": "WALLET_TOPUP",
    "paymentMethod": "ONLINE",
    "amountPaise": 100000,
    "currency": "INR",
    "status": "PENDING",
    "failureCode": null,
    "failureMessage": null,
    "walletCreditRequestId": "wcr-...",
    "orderId": null,
    "expiresAt": "2026-10-06T00:30:00.000Z",
    "completedAt": null,
    "refundedAt": null,
    "createdAt": "2026-10-06T00:00:00.000Z",
    "updatedAt": "2026-10-06T00:00:00.000Z"
  },
  "walletCreditRequestId": "wcr-...",
  "checkout": {
    "endpoint": "https://mercury.phonepe.com/transact/pg?token=...",
    "method": "REDIRECT",
    "fields": {},
    "redirectUrl": "https://mercury.phonepe.com/transact/pg?token=...",
    "providerOrderId": "OMO2501011234567890",
    "expiresAt": 1767000000000
  },
  "message": "Payment created. Submit the checkout fields to the payment gateway to complete it."
}
```

> 🔴 **FRONTEND CHANGE REQUIRED — this is the only breaking change in the
> PayU → PhonePe migration.** Every other request and response field, error
> code and status value is unchanged.

**How the frontend uses `checkout` (new):**

1. Read `checkout.method`. For PhonePe it is always `"REDIRECT"`.
2. Navigate the browser to `checkout.redirectUrl` (identical to
   `checkout.endpoint`): `window.location.assign(checkout.redirectUrl)`, or
   open it in a WebView / Custom Tab on mobile.
3. There is **no form to build and no field to submit** — `checkout.fields` is
   always `{}`. Delete the form-POST code path.
4. Do **not** cache, rewrite or append anything to `redirectUrl`. It is a
   one-time, order-scoped PhonePe token URL.
5. PhonePe returns the browser to the server, which verifies the payment and
   then redirects to the configured `PAYMENT_RESULT_REDIRECT_URL` with the
   **same** `txnid`, `result` and `status` query params as before — so the
   existing payment-result page needs **no change**.

Two optional fields are new and may be ignored:
`checkout.providerOrderId` (PhonePe's own order id) and `checkout.expiresAt`
(epoch **milliseconds** after which the checkout URL stops working).

**Response `201` — CASH:**

```json
{
  "cashCollection": {
    "id": "csh-...",
    "amountPaise": 100000,
    "status": "PENDING",
    "createdAt": "2026-10-06T00:00:00.000Z"
  },
  "walletCreditRequestId": "wcr-...",
  "message": "Cash collection requested. Your wallet is credited only after the cash is collected and confirmed by an admin."
}
```

Both responses may include `"replayed": true` when the same idempotency key
was already used with the same parameters.

**Errors:**

| HTTP | `error` | Cause |
|------|---------|-------|
| 400 | — | Missing `Idempotency-Key` header |
| 400 | `INVALID_CREDIT_AMOUNT` | Amount out of wallet bounds or not an integer |
| 400 | `CUSTOMER_EMAIL_REQUIRED` | ONLINE top-up without a verified email on the profile |
| 404 | `CUSTOMER_NOT_FOUND` | Unknown customer (should not occur with a valid JWT) |
| 409 | `IDEMPOTENCY_KEY_REUSED` | Same key with a different amount or payment method |
| 409 | `WALLET_PENDING_REQUEST_EXISTS` | Another top-up is already pending |

---

### 6.2 `POST /api/v1/customer/payments/verify`

Server-to-server re-check of a payment's true state with PhonePe. Use when:
- The browser callback was lost (app closed, connection dropped).
- The user returned to the app and the UI needs the authoritative state.

**Request:**

```json
{ "transactionId": "PFMH2K8A1B2C3D4E5F" }
```

The request carries no status — the client cannot assert an outcome. PhonePe is
the source of truth.

**Response `200`:**

```json
{
  "payment": {
    "id": "pay-...",
    "transactionId": "PFMH2K8A1B2C3D4E5F",
    "status": "SUCCESS",
    "amountPaise": 100000,
    "...": "..."
  },
  "walletCredited": false,
  "requiresAdminApproval": true
}
```

| Field | Meaning |
|-------|---------|
| `payment.status` | Current status after verification |
| `walletCredited` | `true` if the wallet balance was changed as part of this call |
| `requiresAdminApproval` | `true` for a first credit awaiting admin review |

**Errors:**
- `404 PAYMENT_NOT_FOUND` — unknown or belongs to another customer (same code for both to prevent probing).

---

### 6.3 `POST /api/v1/customer/payments/retry`

Retries a `FAILED`, `CANCELLED`, or `EXPIRED` online top-up.

**Headers:**
- `Authorization: Bearer <token>`
- `Idempotency-Key: <fresh UUID per retry intent>`
- `Content-Type: application/json`

**Request body:**

```json
{ "transactionId": "PFMH2K8A1B2C3D4E5F" }
```

The amount is **not** accepted — the server reads it from the still-open
`WalletCreditRequest`, so a retry can never change what the customer owes. A
fresh `transactionId` and hash are generated.

**Response `201`:** same shape as `/create` for ONLINE.

**Errors:**

| HTTP | `error` | Cause |
|------|---------|-------|
| 400 | — | Missing `Idempotency-Key` |
| 404 | `PAYMENT_NOT_FOUND` | Unknown or not yours |
| 409 | `PAYMENT_NOT_RETRYABLE` | Payment is `PENDING`, `PROCESSING`, `SUCCESS`, `REFUND_PENDING`, or `REFUNDED` |
| 409 | `CREDIT_REQUEST_NOT_PENDING` | The underlying credit request was closed; create a brand new top-up |

---

### 6.4 `POST /api/v1/customer/payments/cancel`

Cancels an online top-up the customer **abandoned before paying** (closed the
PhonePe page, hit back, etc.) and immediately releases the one-pending-per-wallet
slot so a new recharge can start without waiting for the 30-minute expiry sweep.

**Headers:**
- `Authorization: Bearer <token>`
- `Content-Type: application/json`

**Request body:**

```json
{ "transactionId": "PFMH2K8A1B2C3D4E5F" }
```

**Safety:** the live payment is never cancelled on the client's word. The server
first re-checks the authoritative status with PhonePe's Order Status API:

- **`COMPLETED`** → the payment is settled (wallet credited) and the cancel is
  refused (`PAYMENT_ALREADY_SUCCESSFUL`).
- **`PENDING` with a payment attempt on it** → refused
  (`PAYMENT_IN_PROGRESS`); let the webhook/verify path resolve it.
- **`FAILED`** → the slot is released; `cancelled: true`.
- **no record at PhonePe, or `PENDING` with no attempt yet** → the customer
  never started paying; cancelled locally and the slot is released.

The last case is why a freshly created PhonePe order is not treated as
in-flight: PhonePe reports a created-but-untouched order as `PENDING`, and
reading that as `PROCESSING` would make an abandoned top-up impossible to
cancel.

**Response `200`:**

```json
{
  "payment": { "...": "the payment in its new status" },
  "cancelled": true,
  "alreadyFinal": false
}
```

- `cancelled` — whether this call moved the payment to a closed state.
- `alreadyFinal` — `true` when the payment was already terminal (idempotent no-op).

**Errors:**

| HTTP | `error` | Cause |
|------|---------|-------|
| 404 | `PAYMENT_NOT_FOUND` | Unknown or not yours |
| 409 | `PAYMENT_NOT_CANCELLABLE` | Not a wallet top-up payment |
| 409 | `PAYMENT_ALREADY_SUCCESSFUL` | PhonePe reports the order `COMPLETED`; it was credited, not cancelled |
| 409 | `PAYMENT_IN_PROGRESS` | A capture is in flight; try again shortly |
| 409 | `PAYMENT_CANNOT_BE_VERIFIED` | Provider status could not be checked; it will auto-expire if left |

---

### 6.5 `GET /api/v1/customer/payments`

The customer's own payment history.

**Query:**

| Param | Type | Default |
|-------|------|---------|
| `status` | one of the `PaymentStatus` values below | all |
| `purpose` | `ORDER` \| `WALLET_TOPUP` | all |
| `paymentMethod` | `ONLINE` \| `CASH` | all |
| `startDate` | `YYYY-MM-DD` | — |
| `endDate` | `YYYY-MM-DD` inclusive | — |
| `page` | int ≥ 1 | 1 |
| `limit` | int 1–100 | 20 |

**Response `200`:** paginated list of payments in the shape above (without the
`providerResponse` field).

---

### 6.6 `GET /api/v1/customer/payments/:id`

One payment, enriched with its wallet-credit state.

**Response `200`:**

```json
{
  "id": "pay-...",
  "transactionId": "PFMH2K8A1B2C3D4E5F",
  "status": "SUCCESS",
  "amountPaise": 100000,
  "...": "...",
  "walletCredit": {
    "id": "wcr-...",
    "status": "PENDING",
    "amountPaise": 100000,
    "autoApproved": false,
    "completedAt": null,
    "refundStatus": "NOT_REQUIRED"
  }
}
```

**Errors:**
- `404 PAYMENT_NOT_FOUND` — unknown id or another customer's payment (same code).

---

## 7. Public PhonePe routes (not called by your app)

These are called by PhonePe directly — the frontend must not call them.

```
GET  /api/v1/payments/phonepe/return?txnid=…  — browser return (public, carries no authority)
POST /api/v1/payments/phonepe/return?txnid=…  — same handler, for providers that post
POST /api/v1/payments/webhooks/phonepe        — server-to-server webhook (public, header-authenticated)
                                                handles checkout.order.completed / .failed
```

The PayU routes (`/payments/payu/success`, `/payments/payu/failure`,
`/payments/webhooks/payu`) **no longer exist**. The PayU provider classes are
still on disk for rollback but are not registered, so those paths return 404.

### 7.1 Browser return

PhonePe uses **one** return URL for both outcomes rather than PayU's
`surl`/`furl` pair, so there is no `/success` and `/failure` split any more.

The handler ignores everything in the request except the `txnid` the server
itself put in the URL, asks PhonePe's Order Status API what actually happened,
applies the outcome, and then issues a `302` to `PAYMENT_RESULT_REDIRECT_URL`
with the **unchanged** parameter set:

| Query param | Values |
|-------------|--------|
| `txnid` | The merchant transaction id |
| `result` | `wallet_credited` \| `awaiting_approval` \| `recorded` \| `pending` \| `error` |
| `status` | The resulting payment status |

`result=pending` is new: it means PhonePe had no actionable state for the order
at the moment the browser came back. Treat it exactly like `recorded` — poll
`POST /customer/payments/verify` or `GET /customer/payments/:id` for the real
answer.

The redirect carries **no** `amount` and nothing derived from a PhonePe
credential. URLs end up in browser history and referrers; secrets never do.

**The return route carries no authority at all.** PhonePe sends no trustworthy
payload with the browser return, so hitting this URL by hand achieves nothing
beyond one extra server-to-server status check against an unguessable
transaction id. Only PhonePe's own API can make a payment successful.

### 7.2 Webhook authentication

PhonePe does **not** sign its webhook payloads the way PayU hashed them. Two
independent gates protect this endpoint:

1. **Authenticity** — PhonePe sets the `Authorization` header to
   `SHA256(PHONEPE_WEBHOOK_USERNAME:PHONEPE_WEBHOOK_PASSWORD)`, hex-encoded,
   using the credentials configured against the webhook in the PhonePe
   dashboard. The server recomputes the digest and compares it in constant
   time. A mismatch, a missing header or missing configuration is a `403` with
   no state change.
2. **Truth** — even an authentic event is never accepted as proof of payment.
   The event only names *which* order to re-check; the outcome is then read
   from PhonePe's Order Status API over a server-to-server call. A replayed or
   tampered body therefore cannot assert a payment PhonePe does not hold.

If PhonePe cannot be reached for that second check, the endpoint answers `503`
so PhonePe **retries** the event rather than considering it delivered.

**Treat the redirect as a hint, not as truth.** The webhook settles the
payment independently of what the browser does. Even if the user closes the
tab after paying, the webhook will complete the flow. The authoritative state
is always `GET /customer/payments/:id` or `POST /customer/payments/verify`.

---

## 8. Payment status reference

| Status | Meaning | Can retry? |
|--------|---------|------------|
| `PENDING` | Created, awaiting the customer at checkout | no (still live) |
| `PROCESSING` | PhonePe reports an attempt in flight (`PENDING` with a payment attempt) | no |
| `SUCCESS` | Verified; wallet credit flow has run | no |
| `FAILED` | Verified as failed; credit request moved to CANCELLED | yes |
| `CANCELLED` | Abandoned | yes |
| `EXPIRED` | `expiresAt` passed without completion; credit request CANCELLED | yes |
| `REFUND_PENDING` | A PhonePe refund has been requested and accepted | no |
| `REFUNDED` | PhonePe's Refund Status API reports the refund `COMPLETED` | no |

An abandoned payment expires automatically within one scheduler tick (10
minutes after `expiresAt`) so the one-pending-per-wallet slot is freed and the
customer can start a new top-up.

---

## 9. Idempotency

- `POST /create` and `POST /retry` require an `Idempotency-Key` header.
- Reuse the same key when retrying the same user intent after a network error.
- Same key + same parameters → the original result, with `"replayed": true`.
- Same key + different parameters → `409 IDEMPOTENCY_KEY_REUSED`.
- A key is bound to one payment method — reusing an ONLINE key for a CASH
  top-up is a conflict, not a replay.

---

## 10. What the frontend never controls

The server rejects or ignores any attempt to supply these from the client:

- The payable amount sent to PhonePe (only `/create` accepts an amount, and it
  is validated against the wallet's configured bounds).
- The transaction id (`txnid` / PhonePe `merchantOrderId`) — server-generated,
  unpredictable.
- The payment status.
- The wallet balance.
- `autoCreditEnabled`.
- `walletCreditRequestId` on a payment.
- Whether a credit is approved.
- The PhonePe `redirectUrl` (browser return URL), which is built from
  `PUBLIC_API_BASE_URL` server-side.
- The result redirect target.
- The outcome of a payment: it is read only from PhonePe's Order Status API,
  never from a webhook body or a browser return.

---

## 11. Step-by-step cURL

```bash
export BASE_URL="https://api-puretyfarm.onrender.com"
export TOKEN="<customer access token>"
export IDEM="$(uuidgen)"
```

### Create an ONLINE top-up
```bash
curl -i -X POST "$BASE_URL/api/v1/customer/payments/create" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Idempotency-Key: $IDEM" \
  -H "Content-Type: application/json" \
  -d '{ "amount": 100000, "paymentMethod": "ONLINE" }'
```

### Create a CASH top-up
```bash
curl -i -X POST "$BASE_URL/api/v1/customer/payments/create" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{ "amount": 100000, "paymentMethod": "CASH" }'
```

### Re-verify a payment server-to-server
```bash
curl -i -X POST "$BASE_URL/api/v1/customer/payments/verify" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "transactionId": "PFMH2K8A1B2C3D4E5F" }'
```

### Retry a failed/cancelled/expired online payment
```bash
curl -i -X POST "$BASE_URL/api/v1/customer/payments/retry" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{ "transactionId": "PFMH2K8A1B2C3D4E5F" }'
```

### Cancel an abandoned online top-up
```bash
curl -i -X POST "$BASE_URL/api/v1/customer/payments/cancel" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "transactionId": "PFMH2K8A1B2C3D4E5F" }'
```

### List payments
```bash
curl -i -X GET "$BASE_URL/api/v1/customer/payments?status=SUCCESS" \
  -H "Authorization: Bearer $TOKEN"
```

### Get one payment
```bash
curl -i -X GET "$BASE_URL/api/v1/customer/payments/<PAYMENT_ID>" \
  -H "Authorization: Bearer $TOKEN"
```

---

## 12. Frontend integration checklist

1. Generate a fresh `Idempotency-Key` per user intent and reuse it on retry.
2. On an ONLINE create response, navigate the browser to
   `checkout.redirectUrl` (`checkout.method === "REDIRECT"`). Do not build a
   form — `checkout.fields` is always `{}` under PhonePe.
3. On return to the result page, treat the URL params as a hint, then confirm
   with `POST /payments/verify` for an authoritative state.
4. Show two distinct messages on first credit: "Payment Successful" (status
   SUCCESS, walletCredit PENDING) and "Wallet Credited" (walletCredit
   COMPLETED).
5. If a payment is `FAILED`/`CANCELLED`/`EXPIRED`, offer "Try again" which
   calls `POST /retry` with a new `Idempotency-Key`. If it is still
   `PENDING`/`PROCESSING` (an abandoned checkout), offer "Cancel" which calls
   `POST /cancel` to release the pending slot. On `WALLET_PENDING_REQUEST_EXISTS`
   from `POST /create`, surface the same retry/cancel actions on the blocking
   top-up rather than a dead-end error.
6. For `CASH`, show "Awaiting pickup" / "Collected" / "Confirmed" according to
   the cash-collection status (visible through `GET /customer/wallet/credit-requests`).
7. On a refund, poll `GET /customer/payments/:id` and show `REFUND_PENDING` →
   `REFUNDED` based on the authoritative payment status.

---

## 13. PayU → PhonePe migration notes

### What changed for the frontend

Exactly one thing: **the shape of `checkout` on an ONLINE `/create` and
`/retry` response.** See §6.1.

| Before (PayU) | After (PhonePe) |
|---------------|-----------------|
| `checkout.method = "POST"` | `checkout.method = "REDIRECT"` |
| `checkout.fields` = 15 form fields incl. `hash` | `checkout.fields = {}` |
| Build a hidden form, `form.submit()` | `window.location.assign(checkout.redirectUrl)` |
| `payment.provider = "PAYU"` | `payment.provider = "PHONEPE"` |

Everything else is byte-for-byte identical: all endpoints, request bodies,
`Idempotency-Key` semantics, every `error` code, every payment status, the
`PAYMENT_RESULT_REDIRECT_URL` query parameters (`txnid` / `result` / `status`,
with one added `result=pending` value), the two-events first-credit rule, and
the cash flow.

If the frontend branches on `checkout.method` it will keep working against both
gateways during the rollback window.

### What did NOT change

- Cash plan payments, cash collection confirmation and cash float reconciliation.
- Plan purchase workflows (wallet-funded and online).
- Pricing, inventory, order management and delivery fulfilment.
- Platform fees, revenue calculation, cancellations.
- Wallet funding rules, including first-top-up admin approval and the
  subsequent per-wallet auto-credit behaviour.
- Idempotency keys, the one-live-payment-per-credit-request index, the
  one-live-payment-per-order index, the expiry sweep, and every conditional
  state transition in `applyVerifiedOutcome`.
- Authentication, authorisation, rate limiting, logging and API conventions.
- The `CUSTOMER_EMAIL_REQUIRED` gate on ONLINE top-ups. PhonePe does not need
  an email address, but relaxing the gate would change who can start an online
  top-up, so it is deliberately left in place. Removing it is a separate,
  product-level decision.

### Required configuration

```env
PHONEPE_ENV=PRODUCTION
PHONEPE_CLIENT_ID=<from the PhonePe dashboard>
PHONEPE_CLIENT_SECRET=<from the PhonePe dashboard>
PHONEPE_CLIENT_VERSION=<from the PhonePe dashboard>
PHONEPE_WEBHOOK_USERNAME=<as configured against the webhook>
PHONEPE_WEBHOOK_PASSWORD=<as configured against the webhook>
```

All six are asserted at boot: a deployment missing any of them fails to start
rather than failing at a customer's first payment. `PHONEPE_ENV` is optional
and defaults to `PRODUCTION`; an unrecognised value is rejected at boot so a
typo can never silently route live traffic to the sandbox.

`PAYU_KEY` and `PAYU_SALT` are **still required** at boot. PayU is off the
active payment path, but the credentials are retained so the cutover can be
rolled back without a credential hunt. Remove them, and the
`src/modules/payments/providers/payu/` and `webhook/payu-webhook.*` files,
once PhonePe is validated in production.

The webhook registered in the PhonePe dashboard must be exactly:

```
https://api-puretyfarm.onrender.com/api/v1/payments/webhooks/phonepe
```

with **Authentication Type: SHA**, and the username/password matching
`PHONEPE_WEBHOOK_USERNAME` / `PHONEPE_WEBHOOK_PASSWORD`.

### Rolling back

1. In `src/modules/payments/payments.module.ts`, swap the PhonePe controllers
   and providers back to `PayuCallbackController`, `PayuWebhookController`,
   `PayuWebhookService`, `PayuHashService`, `PayuClient`, `PayuService`, and
   rebind `PAYMENT_PROVIDER` to `PayuService`.
2. Set `ACTIVE_PAYMENT_PROVIDER` in `payments.constants.ts` back to
   `PaymentProviderType.PAYU`.

No migration, no data change and no frontend rollback beyond restoring the
form-POST branch. Payments already created against PhonePe keep
`provider = "PHONEPE"` and remain readable.
