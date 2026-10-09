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
| `ONLINE` | PayU Hosted Checkout | SHA-512 hash-verified PayU callback or webhook | Admin approval (first time) or automatic (per-wallet `autoCreditEnabled=true`) |
| `CASH` | None | Admin confirmation after physical cash reaches the depot | Admin confirmation only — never automatic |

**Plan payments and this module:** Plans are paid directly at plan confirmation
time via the Plans module (`POST /customer/plans/confirm` with `paymentMethod:
"WALLET"` or `"CASH"`). When a customer's wallet balance is insufficient, they
use this Payment module to top up their wallet (Add Money → ONLINE → PayU),
then return to the Plans module to complete the purchase with WALLET. There is
**no direct PayU checkout for plan purchases** — PayU is used only for wallet
top-ups.

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

**Integer paise everywhere in the API.** The server does the
paise → rupee-decimal conversion itself when calling PayU (`"1000.00"`), using
integer arithmetic — never floats.

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
            (PayU gateway)       (physical collection)
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

> **Scheduler**: a cron (every 10 minutes) expires PayU payments the customer
> never completed, so an abandoned checkout does not block future top-ups.
> See `docs/admin/scheduler.md`. The scheduler never credits a wallet.

---

## 3. The two-events rule (first credit)

For a customer's **first** wallet credit, "Payment Successful" and "Wallet
Credited" are **two different events**. The UI must show them differently:

```text
FIRST CREDIT

PayU SUCCESS
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
PayU SUCCESS
   ↓
Payment SUCCESS
   ↓
WalletCreditRequest COMPLETED, Wallet credited          ← one event
```

Read these fields from the API:

| Field | Meaning |
|-------|---------|
| `payment.status = "SUCCESS"` | Money reached PayU and we verified it |
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

Cash is also **never refunded through PayU**. Cash cancellation
(`/admin/payments/cash-collections/:id/cancel`) moves the credit request to
`CANCELLED` and the cash is reconciled offline.

---

## 5. Rejection → automatic PayU refund

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
Payment SUCCESS → REFUND_PENDING  (atomic claim; a second reject can't double-call PayU)
   ↓
PayU cancel_refund_transaction API called
   ↓
(wait for PayU verified refund webhook)
   ↓
Payment REFUNDED, WalletCreditRequest.refundStatus = REFUNDED
```

`REFUNDED` is only reached after a signed, hash-verified refund webhook from
PayU — never on the back of PayU merely accepting the request.

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
    "provider": "PAYU",
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
    "endpoint": "https://secure.payu.in/_payment",
    "method": "POST",
    "fields": {
      "key": "<merchant key>",
      "txnid": "PFMH2K8A1B2C3D4E5F",
      "amount": "1000.00",
      "productinfo": "PuretyFarm Wallet Top-up",
      "firstname": "Asha",
      "email": "asha@example.com",
      "phone": "9876543210",
      "surl": "https://api-puretyfarm.onrender.com/api/v1/payments/payu/success",
      "furl": "https://api-puretyfarm.onrender.com/api/v1/payments/payu/failure",
      "udf1": "",
      "udf2": "",
      "udf3": "",
      "udf4": "",
      "udf5": "",
      "hash": "<128-char SHA-512>"
    }
  },
  "message": "Payment created. Submit the checkout fields to the payment gateway to complete it."
}
```

**How the frontend uses `checkout`:**

1. Build an HTML form with `action = checkout.endpoint` and `method = "POST"`.
2. Add one hidden `<input name="...">` for every key in `checkout.fields` with
   its exact value.
3. Submit it (`form.submit()`). The browser lands on PayU Hosted Checkout.
4. Do **not** modify any field — every one is covered by `hash`.
5. PayU redirects the browser back to the configured
   `PAYMENT_RESULT_REDIRECT_URL` with query params `txnid`, `result`, `status`.

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

Server-to-server re-check of a payment's true state with PayU. Use when:
- The browser callback was lost (app closed, connection dropped).
- The user returned to the app and the UI needs the authoritative state.

**Request:**

```json
{ "transactionId": "PFMH2K8A1B2C3D4E5F" }
```

The request carries no status — the client cannot assert an outcome. PayU is
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
PayU page, hit back, etc.) and immediately releases the one-pending-per-wallet
slot so a new recharge can start without waiting for the 30-minute expiry sweep.

**Headers:**
- `Authorization: Bearer <token>`
- `Content-Type: application/json`

**Request body:**

```json
{ "transactionId": "PFMH2K8A1B2C3D4E5F" }
```

**Safety:** the live payment is never cancelled on the client's word. The server
first re-checks the authoritative status with PayU:

- **success** → the payment is settled (wallet credited) and the cancel is
  refused (`PAYMENT_ALREADY_SUCCESSFUL`).
- **in progress** → refused (`PAYMENT_IN_PROGRESS`); let the callback/verify path
  resolve it.
- **failure** → the slot is released; `cancelled: true`.
- **no record at PayU** → the customer never paid; cancelled locally and the slot
  is released.

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
| 409 | `PAYMENT_ALREADY_SUCCESSFUL` | PayU reports the payment succeeded; it was credited, not cancelled |
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

## 7. Public PayU routes (not called by your app)

These are called by PayU directly — the frontend must not call them.

```
POST /api/v1/payments/payu/success    — browser callback (public, hash-verified)
POST /api/v1/payments/payu/failure    — browser callback (public, hash-verified)
POST /api/v1/payments/webhooks/payu   — server-to-server webhook (public, hash-verified)
                                        handles successful, failed, and refund events
```

After verifying, the browser callback issues a `302` to
`PAYMENT_RESULT_REDIRECT_URL` with:

| Query param | Values |
|-------------|--------|
| `txnid` | The merchant transaction id |
| `result` | `wallet_credited` \| `awaiting_approval` \| `recorded` \| `error` |
| `status` | The resulting payment status |

The redirect carries **no** `amount`, `hash`, or anything derived from
`PAYU_SALT`. URLs end up in browser history and referrers; secrets never do.

**The route name carries no authority.** Hitting `/payu/success` with an
unsigned payload does nothing. A signed FAILURE payload posted to the success
URL is recorded as a failure.

**Treat the redirect as a hint, not as truth.** The webhook settles the
payment independently of what the browser does. Even if the user closes the
tab after paying, the webhook will complete the flow. The authoritative state
is always `GET /customer/payments/:id` or `POST /customer/payments/verify`.

---

## 8. Payment status reference

| Status | Meaning | Can retry? |
|--------|---------|------------|
| `PENDING` | Created, awaiting the customer at checkout | no (still live) |
| `PROCESSING` | PayU reports the payment in flight | no |
| `SUCCESS` | Verified; wallet credit flow has run | no |
| `FAILED` | Verified as failed; credit request moved to CANCELLED | yes |
| `CANCELLED` | Abandoned | yes |
| `EXPIRED` | `expiresAt` passed without completion; credit request CANCELLED | yes |
| `REFUND_PENDING` | PayU refund has been requested | no |
| `REFUNDED` | PayU refund confirmed via webhook | no |

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

- The payable amount sent to PayU (only `/create` accepts an amount, and it is
  validated against the wallet's configured bounds).
- The transaction id (`txnid`) — server-generated, unpredictable.
- The payment status.
- The wallet balance.
- `autoCreditEnabled`.
- `walletCreditRequestId` on a payment.
- Whether a credit is approved.
- The `surl` / `furl` callback URLs.
- The result redirect target.
- The hash on an incoming callback (the server recomputes it).

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
2. On an ONLINE create response, build a hidden form from `checkout.fields`
   and submit it to `checkout.endpoint`. Do not alter any field.
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
