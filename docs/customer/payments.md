# Customer Payments API

## Overview

The Payment module is how money enters PuretyFarm. It verifies and records
**money movement**; it never changes a wallet balance itself. The Wallet module
remains the single owner of the balance and the ledger.

Two ways to top up a wallet:

| Method | Gateway | What proves the money arrived |
|--------|---------|-------------------------------|
| `ONLINE` | PayU Hosted Checkout | A SHA-512 hash-verified PayU callback/webhook |
| `CASH` | None | An admin confirming the physical cash |

## Authentication

Every endpoint in this document requires a **Customer JWT**
(`Authorization: Bearer <access token>`). Customer identity always comes from
`JWT.sub`. No endpoint accepts a `userId` in the request body — the global
validation pipe runs with `whitelist: true`, so such a field is stripped before
it reaches any handler.

## Money convention

All amounts are **integer paise**. ₹1 = `100`, ₹500 = `50000`, ₹1000 = `100000`.
No floating-point currency value is accepted or returned. The rupee-decimal
string PayU requires (`"1000.00"`) is produced server-side by integer
arithmetic, never by dividing into a float.

---

## Payment architecture

```text
                    PAYMENT MODULE
                         │
              ┌──────────┴──────────┐
              │                     │
             PayU                 Cash
              │                     │
              ↓                     ↓
        Payment Record       CashCollection
              │                     │
              └──────────┬──────────┘
                         ↓
               WalletCreditRequest
                         │
               ┌─────────┴─────────┐
               │                   │
             FIRST              SUBSEQUENT
               │                   │
          Admin approval       Auto credit
               │                   │
               └─────────┬─────────┘
                         ↓
                       Wallet
                         ↓
                  WalletTransaction
```

## Customer flow

```text
                    ┌──────────────┐
                    │   Customer   │
                    └──────┬───────┘
                           │
                      Add ₹1000
                           │
              ┌────────────┴────────────┐
              │                         │
           ONLINE                     CASH
            PayU                 Cash Collection
              │                         │
              ↓                         ↓
        PayU Payment              Cash Request
              │                         │
              ↓                         ↓
       Payment SUCCESS          Partner collects cash
              │                         │
              ↓                         ↓
      Wallet Credit Request      Admin confirms cash
              │                         │
       ┌──────┴──────┐                  │
       │             │                  │
    FIRST         SECOND+               │
       │             │                  │
  Admin approve  Auto-credit       Credit wallet
       │             │                  │
       └─────────────┴──────────────────┘
                       ↓
                 WALLET +₹1000
```

## PayU flow

```text
Customer
   ↓
Create Payment              (POST /customer/payments/create)
   ↓
PayU Hosted Checkout        (browser form POST, server-signed)
   ↓
PayU
   ├── SUCCESS
   └── FAILED
   ↓
Webhook / Callback          (both land on the same state machine)
   ↓
Verify Hash                 ← reject here if it does not match
   ↓
Verify Transaction          ← unknown txnid is rejected
   ↓
Verify Amount               ← mismatch is rejected
   ↓
Update Payment              ← conditional, so duplicates are no-ops
   ↓
Wallet Logic
```

---

## Two events, not one

For a **first** wallet credit, "payment successful" and "wallet credited" are
different things and the app must show them differently.

```text
FIRST CREDIT

PayU SUCCESS
   ↓
Payment SUCCESS            ← money collected
   ↓
WalletCreditRequest PENDING ← balance unchanged
   ↓
Admin Approval
   ↓
WalletService
   ↓
WalletTransaction
   ↓
Wallet Balance             ← money usable
```

```text
SUBSEQUENT ONLINE CREDIT

PayU SUCCESS
   ↓
Payment SUCCESS
   ↓
Existing Wallet Logic
   ↓
Auto Credit                ← only if WALLET_AUTO_CREDIT_ENABLED=true
   ↓
WalletTransaction
   ↓
Wallet Balance
```

The first credit **always** requires admin approval, even when
`WALLET_AUTO_CREDIT_ENABLED=true`. When that flag is off (the default), every
credit requires approval.

Read this from the API as:

| Field | Meaning |
|-------|---------|
| `payment.status = "SUCCESS"` | The money was collected and verified |
| `walletCredit.status = "PENDING"` | Awaiting admin approval; balance unchanged |
| `walletCredit.status = "COMPLETED"` | Balance has increased |

---

## Cash flow

```text
Customer requests cash top-up
   ↓
CashCollection PENDING       ← nothing credited
   ↓
Partner collects cash
   ↓
CashCollection COLLECTED
   ↓
Admin confirms               ← the operational gate
   ↓
WalletService
   ↓
WalletTransaction
   ↓
Wallet Balance
```

A cash **request** does not mean cash was **received**. Nothing is credited
until an admin confirms. `WALLET_AUTO_CREDIT_ENABLED` does not apply to cash:
unverified physical money is never auto-credited, no matter how many successful
top-ups the customer has made before.

---

## Endpoints

All paths are also served without the `/api/v1` prefix, matching the rest of
the project (`/customer/payments/...`).

### POST `/api/v1/customer/payments/create`

Starts a top-up. **Requires an `Idempotency-Key` header.**

Request:

```json
{
  "amount": 100000,
  "paymentMethod": "ONLINE"
}
```

| Field | Type | Notes |
|-------|------|-------|
| `amount` | integer | Paise. Validated against the wallet's configured min/max. |
| `paymentMethod` | `"ONLINE"` \| `"CASH"` | |

`201` for `ONLINE`:

```json
{
  "payment": {
    "id": "...",
    "transactionId": "PFMH2K8A1B2C3D4E5F",
    "provider": "PAYU",
    "purpose": "WALLET_TOPUP",
    "paymentMethod": "ONLINE",
    "amountPaise": 100000,
    "currency": "INR",
    "status": "PENDING",
    "expiresAt": "2026-10-06T00:30:00.000Z"
  },
  "walletCreditRequestId": "...",
  "checkout": {
    "endpoint": "https://secure.payu.in/_payment",
    "method": "POST",
    "fields": {
      "key": "...",
      "txnid": "PFMH2K8A1B2C3D4E5F",
      "amount": "1000.00",
      "productinfo": "PuretyFarm Wallet Top-up",
      "firstname": "Asha",
      "email": "asha@example.com",
      "phone": "9876543210",
      "surl": "https://api-puretyfarm.onrender.com/api/v1/payments/payu/success",
      "furl": "https://api-puretyfarm.onrender.com/api/v1/payments/payu/failure",
      "udf1": "", "udf2": "", "udf3": "", "udf4": "", "udf5": "",
      "hash": "<128-char sha512>"
    }
  }
}
```

**Submit `checkout.fields` as a form POST to `checkout.endpoint`.** Do not
build a payment UI; PayU hosts it. Do not modify any field — every hashed field
is covered by the server-computed `hash`, so any change makes PayU reject it.

`201` for `CASH`:

```json
{
  "cashCollection": {
    "id": "...",
    "amountPaise": 100000,
    "status": "PENDING",
    "createdAt": "2026-10-06T00:00:00.000Z"
  },
  "walletCreditRequestId": "...",
  "message": "Cash collection requested. Your wallet is credited only after the cash is collected and confirmed by an admin."
}
```

Errors:

| Status | `error` | Cause |
|--------|---------|-------|
| 400 | — | Missing `Idempotency-Key` header |
| 400 | `INVALID_CREDIT_AMOUNT` | Amount outside the wallet's configured bounds |
| 400 | `CUSTOMER_EMAIL_REQUIRED` | Online payment with no email on the profile |
| 409 | `IDEMPOTENCY_KEY_REUSED` | Same key, different amount or payment method |
| 409 | `WALLET_PENDING_REQUEST_EXISTS` | A top-up is already pending for this wallet |

### POST `/api/v1/customer/payments/verify`

Re-checks a payment's real state **server-to-server with PayU**. Use it when
the browser callback was lost (app backgrounded, connection dropped).

```json
{ "transactionId": "PFMH2K8A1B2C3D4E5F" }
```

The request carries no status — the client cannot assert an outcome. PayU is
the source of truth.

```json
{
  "payment": { "status": "SUCCESS", "...": "..." },
  "walletCredited": false,
  "requiresAdminApproval": true
}
```

### POST `/api/v1/customer/payments/retry`

Retries a `FAILED`, `CANCELLED` or `EXPIRED` online top-up. **Requires an
`Idempotency-Key` header.**

```json
{ "transactionId": "PFMH2K8A1B2C3D4E5F" }
```

No amount is accepted: it is re-read from the still-open credit request, so a
retry cannot change what is owed. A new `transactionId` and hash are generated.

| Status | `error` | Cause |
|--------|---------|-------|
| 409 | `PAYMENT_NOT_RETRYABLE` | The payment is PENDING, PROCESSING or SUCCESS |
| 409 | `CREDIT_REQUEST_NOT_PENDING` | The top-up was closed; start a new one |

### GET `/api/v1/customer/payments`

Your own payments only. Query: `status`, `purpose`, `paymentMethod`,
`startDate`, `endDate`, `page`, `limit` (max 100).

### GET `/api/v1/customer/payments/:id`

One payment, plus the wallet credit it funds:

```json
{
  "status": "SUCCESS",
  "amountPaise": 100000,
  "walletCredit": {
    "id": "...",
    "status": "PENDING",
    "amountPaise": 100000,
    "autoApproved": false,
    "completedAt": null,
    "refundStatus": "NOT_REQUIRED"
  }
}
```

`404` for another customer's payment — the same response as "does not exist",
so the endpoint cannot be used to probe for other customers' ids.

---

## PayU return URLs (not called by your app)

PayU redirects the customer's browser to these after checkout. They are public
(no JWT — a browser redirect has no Authorization header) and are verified by
hash alone.

```text
POST /api/v1/payments/payu/success
POST /api/v1/payments/payu/failure
POST /api/v1/payments/webhooks/payu    (server-to-server, all event types)
```

After verifying, the callback redirects the browser to
`PAYMENT_RESULT_REDIRECT_URL` with:

| Param | Values |
|-------|--------|
| `txnid` | The merchant transaction id |
| `result` | `wallet_credited` \| `awaiting_approval` \| `recorded` \| `error` |
| `status` | The payment status |

No amount, no hash and nothing secret appears in that URL, because URLs end up
in browser history, referrer headers and server logs.

**Treat the redirect as a hint, not as truth.** It tells your UI what to show
first; confirm with `GET /customer/payments/:id` or `POST
/customer/payments/verify`. The PayU webhook settles the payment independently
of whatever the browser does, so a customer who closes the tab still gets
credited.

> Reaching `/payu/success` does not make a payment successful. The route name
> carries no authority — only the verified `status` field does. A signed
> failure posted to the success URL is recorded as a failure.

---

## Payment statuses

| Status | Meaning |
|--------|---------|
| `PENDING` | Created; awaiting the customer at checkout |
| `PROCESSING` | PayU reports the payment in flight |
| `SUCCESS` | Verified as collected |
| `FAILED` | Verified as failed; the credit request is cancelled |
| `CANCELLED` | Abandoned |
| `EXPIRED` | Not completed before `expiresAt`; the credit request is released |
| `REFUND_PENDING` | A refund was requested from PayU |
| `REFUNDED` | PayU confirmed the refund |

An abandoned checkout expires automatically, which frees the one-pending-top-up
slot so you can start a new one.

## Refunds

If an admin **rejects** your wallet credit after the money was collected, the
Payment module requests a refund from PayU. It is marked `REFUNDED` only once
PayU confirms it — never when it is merely requested.

```text
Payment SUCCESS
   ↓
Wallet credit rejected
   ↓
REFUND_PENDING
   ↓
Payment module → PayU refund
   ↓
PayU confirmation (webhook)
   ↓
REFUNDED
```

## Idempotency

`POST /create` and `POST /retry` require an `Idempotency-Key` header. Generate
a fresh UUID per user intent and reuse it when retrying the same request after
a network error.

- Same key, same parameters → the original result, with `"replayed": true`
- Same key, different parameters → `409 IDEMPOTENCY_KEY_REUSED`

A key is bound to one payment method: reusing an online key for a cash top-up
is a conflict, not a replay.

## What the frontend never controls

- The payable amount sent to PayU
- The transaction id (server-generated, unpredictable)
- The payment status
- The wallet balance
- Whether a credit is approved
- The `surl` / `furl` callback URLs
- The result redirect target
