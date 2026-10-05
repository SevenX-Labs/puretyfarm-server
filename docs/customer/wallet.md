# Customer Wallet API

## Overview

The Wallet module provides a prepaid wallet for customers. Customers can submit credit requests to add money to their wallet. The wallet balance can be used for order payments (future integration).

**External payment/refund integration is not implemented in the Wallet module.**

## Authentication

All endpoints require a valid **Customer JWT** (`Authorization: Bearer <token>`). Customer identity is always derived from `JWT.sub` — the request body never supplies a userId.

## Key Concepts

| Concept | Description |
|---------|-------------|
| **Wallet** | Prepaid balance per customer, created lazily on first interaction |
| **Credit Request** | A request to add money to the wallet |
| **Transaction** | An immutable ledger entry recording a balance change |
| **Idempotency Key** | Required header to prevent duplicate credit requests |

## Money Convention

All monetary values are **integer paise** (₹1 = 100 paise). No floating-point currency values are accepted or returned.

## First-Credit Approval Flow

The first credit request for any customer **always requires admin approval**, regardless of configuration. This ensures every new customer is verified before money enters the system.

1. Customer submits a credit request → status: `PENDING`
2. Admin reviews the request
3. Admin approves → wallet credited, status: `COMPLETED`
4. Admin rejects → status: `REJECTED`, refundStatus: `REFUND_PENDING`

## Automatic Credits (WALLET_AUTO_CREDIT_ENABLED)

When `WALLET_AUTO_CREDIT_ENABLED` is set to `true` in the backend configuration:

- **First credit request**: Still requires admin approval (always)
- **Subsequent requests**: Auto-approved and credited immediately

When `WALLET_AUTO_CREDIT_ENABLED` is `false` (default):

- **All credit requests** require admin approval

> **Note**: Auto-credit is disabled by default because there is no payment verification in the Wallet module. It should only be enabled after the Payment module verifies incoming payments.

## Balance Rules

- Balance can never go negative
- Balance is checked at the database level (CHECK constraint)
- Wallet is created lazily — you don't need to create one explicitly
- Even if a customer has spent their entire balance (balance = 0), subsequent credits may still auto-approve (they are not treated as first-time)

## Pending Request Limit

Only **one PENDING** credit request per wallet is allowed at a time. Submit a new request only after the existing one is approved or rejected.

## Rejection & Refund Status

When a credit request is rejected:
- `adminNote` explains the reason
- `refundStatus` is set to `REFUND_PENDING` (the actual refund is handled by the future Payment module)

---

## Customer Endpoints

### 1. Get Wallet

```
GET /api/v1/customer/wallet
```

**Authentication:** Customer JWT required

**Response (200):**

```json
{
  "balancePaise": 50000,
  "currency": "INR",
  "createdAt": "2026-10-05T...",
  "updatedAt": "2026-10-05T..."
}
```

---

### 2. Create Credit Request

```
POST /api/v1/customer/wallet/credit-request
```

**Authentication:** Customer JWT required

**Required Header:**
```
Idempotency-Key: <unique-string>
```

**Request Body:**

```json
{
  "amount": 50000
}
```

`amount` is in integer paise (50000 = ₹500.00). Must be within the configured min/max range.

**Response — Pending (201):**

```json
{
  "id": "uuid",
  "amountPaise": 50000,
  "status": "PENDING",
  "autoApproved": false,
  "message": "Credit request submitted for admin approval.",
  "createdAt": "2026-10-05T..."
}
```

**Response — Auto-Approved (201):**

```json
{
  "id": "uuid",
  "amountPaise": 50000,
  "status": "COMPLETED",
  "autoApproved": true,
  "message": "Wallet credited successfully.",
  "createdAt": "2026-10-05T..."
}
```

**Idempotency:**
- Same `Idempotency-Key` with the same amount → returns the original result with `replayed: true`
- Same `Idempotency-Key` with a different amount → `409 IDEMPOTENCY_KEY_REUSED`

**Errors:**
- `400 INVALID_CREDIT_AMOUNT` — Amount out of range or non-integer
- `409 WALLET_PENDING_REQUEST_EXISTS` — A request is already pending
- `409 IDEMPOTENCY_KEY_REUSED` — Key reused with different parameters

---

### 3. List Transactions

```
GET /api/v1/customer/wallet/transactions
```

**Authentication:** Customer JWT required

**Query Parameters:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| type | CREDIT \| DEBIT | No | Filter by transaction type |
| startDate | YYYY-MM-DD | No | Transactions on or after |
| endDate | YYYY-MM-DD | No | Transactions on or before |
| page | integer | No | Page number (default 1) |
| limit | integer | No | Items per page (default 20, max 100) |

**Response (200):**

```json
{
  "data": [
    {
      "id": "uuid",
      "type": "CREDIT",
      "amountPaise": 50000,
      "balanceAfterPaise": 50000,
      "referenceType": "CREDIT_REQUEST",
      "referenceId": "uuid",
      "description": "Wallet credit (auto-approved)",
      "createdAt": "2026-10-05T..."
    }
  ],
  "pagination": { "page": 1, "limit": 20, "total": 1, "totalPages": 1 }
}
```

---

### 4. List Credit Requests

```
GET /api/v1/customer/wallet/credit-requests
```

**Authentication:** Customer JWT required

**Query Parameters:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| status | PENDING \| COMPLETED \| REJECTED | No | Filter by status |
| page | integer | No | Page number (default 1) |
| limit | integer | No | Items per page (default 20, max 100) |

**Response (200):**

```json
{
  "data": [
    {
      "id": "uuid",
      "amountPaise": 50000,
      "status": "REJECTED",
      "autoApproved": false,
      "adminNote": "Payment not verified",
      "refundStatus": "REFUND_PENDING",
      "reviewedAt": "2026-10-05T...",
      "createdAt": "2026-10-05T..."
    }
  ],
  "pagination": { "page": 1, "limit": 20, "total": 1, "totalPages": 1 }
}
```

> `adminNote` and `refundStatus` are only included for `REJECTED` requests. `completedAt` is only included for `COMPLETED` requests.

---

## Error Codes

| Code | HTTP Status | Description |
|------|-------------|-------------|
| INVALID_CREDIT_AMOUNT | 400 | Amount out of configured range or non-integer |
| WALLET_PENDING_REQUEST_EXISTS | 409 | A credit request is already pending |
| IDEMPOTENCY_KEY_REUSED | 409 | Idempotency key reused with different parameters |
| INSUFFICIENT_WALLET_BALANCE | 400 | Not enough balance for debit |

## Security Rules

- Customer can only access their own wallet, transactions, and credit requests
- `userId` is always derived from JWT.sub — never accepted from request body
- Customer cannot manipulate balance, status, adminId, or refundStatus
- Customer cannot access Admin endpoints (403)
- No token = 401
- Extra/forbidden fields in request body are silently stripped (whitelist validation)
