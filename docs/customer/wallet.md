# Customer Wallet API

## Overview

The Wallet module provides a prepaid wallet for customers. Customers can submit credit requests to add money to their wallet through online payment (PayU) or physical cash collection, or via direct wallet credit requests. The wallet balance can be used for order payments.

## Authentication

All endpoints require a valid **Customer JWT** (`Authorization: Bearer <token>`). Customer identity is always derived from `JWT.sub` — the request body never supplies a userId.

## Key Concepts

| Concept | Description |
|---------|-------------|
| **Wallet** | Prepaid balance per customer, created lazily on first interaction |
| **autoCreditEnabled** | Database boolean flag on each customer's wallet controlling auto-crediting |
| **Credit Request** | A request to add money to the wallet (backed by PayU, cash, or direct) |
| **Transaction** | An immutable ledger entry recording a balance change |
| **Idempotency Key** | Required header to prevent duplicate credit requests |

## Money Convention

All monetary values are **integer paise** (₹1 = 100 paise). No floating-point currency values are accepted or returned.

---

## Customer-Specific Wallet Auto-Credit (`autoCreditEnabled`)

Every customer's wallet carries its own `autoCreditEnabled` database flag. There is no global setting; Customer A's wallet state never affects Customer B's.

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
|---|---|---|
| `autoCreditEnabled = false` | New wallets | `Wallet.autoCreditEnabled @default(false)` |
| `autoCreditEnabled = true` | Returning customers who completed at least one credit | Set atomically inside the transaction that completes the first credit |

> **Security Guard**: The flag is **never** accepted from a request body. The customer cannot alter their own flag (e.g. `{ "autoCreditEnabled": true }` is stripped by global validation).

---

## Credit Approval & Auto-Credit Rules

### 1. First Credit — Always Admin-Approved

The first credit request for any customer **always requires admin approval**, regardless of configuration. This ensures every new customer is verified before money enters the system.

```text
Customer
   ↓
PayU SUCCESS (or Cash Request)
   ↓
Payment SUCCESS
   ↓
WalletCreditRequest PENDING          ← wallet balance unchanged
   ↓
Admin APPROVE
   ↓
Wallet CREDIT                        ← in the SAME DB transaction
   ↓
autoCreditEnabled → true             ← flipped here, exactly once
```

1. Customer submits first top-up → status: `PENDING`
2. Wallet balance remains unchanged (₹0)
3. Admin approves → wallet credited, status: `COMPLETED`
4. In the **same database transaction**: `autoCreditEnabled` flips to `true` on the customer's wallet

### 2. Subsequent Online Credits — Automatic Approval

Once `autoCreditEnabled = true` for that customer:

```text
Customer
   ↓
PayU SUCCESS
   ↓
Load that customer's Wallet (autoCreditEnabled = true)
   ↓
AUTO CREDIT                          ← no admin involved
   ↓
WalletTransaction CREDIT recorded
```

- Subsequent verified PayU payments credit the wallet immediately upon cryptographic success verification.
- **Zero Balance Spending**: Spending the entire balance down to zero (`balance = 0`) does **not** reset `autoCreditEnabled`. The customer remains recognized as a returning user.

### 3. Cash Top-ups — Never Auto-Credit

```text
Customer
   ↓
Cash Request                         ← no gateway involved
   ↓
CashCollection PENDING
   ↓
Partner collects
   ↓
Admin CONFIRM
   ↓
Wallet CREDIT                        ← physical confirmation gates this
   ↓
autoCreditEnabled → true (if first credit)
```

Even for a customer with `autoCreditEnabled = true`, a cash top-up **always** waits for the admin's physical cash confirmation. The `autoCreditEnabled` flag only governs verified online gateway payments.

### 4. Rejection of First Online Credit — Automatic PayU Refund

```text
Customer
   ↓
PayU SUCCESS
   ↓
Payment SUCCESS
   ↓
WalletCreditRequest PENDING
   ↓
Admin REJECT                         ← POST /admin/wallet/credit-requests/:id/reject
   ↓
NO wallet credit, NO ledger row
   ↓
PaymentsService initiates refund     ← atomic claim: status -> REFUND_PENDING
   ↓
PayuService calls PayU refund API
   ↓
PayU refund webhook arrives
   ↓
Payment: REFUNDED, refundStatus = REFUNDED
```

- When an admin rejects a `PENDING` credit request funded by an online payment, no wallet credit occurs.
- The linked payment moves to `REFUND_PENDING` and triggers an automated PayU refund request.
- The refund is marked `REFUNDED` only when PayU's signed refund webhook is received and verified.

---

## Balance & Lifecycle Rules

- **Negative Balance Protection**: Balance can never go negative (enforced by DB check constraint).
- **One Pending Limit**: Only **one PENDING** credit request per wallet is allowed at a time.
- **Ledger Invariant**: Every balance change produces exactly one immutable `WalletTransaction` row with `balanceAfterPaise`.

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
  "autoCreditEnabled": true,
  "createdAt": "2026-10-05T18:00:00.000Z",
  "updatedAt": "2026-10-05T18:30:00.000Z"
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

**Response — Pending (First Time or Manual Approval) (201):**

```json
{
  "id": "wcr-1092a3f0-4491",
  "amountPaise": 50000,
  "status": "PENDING",
  "autoApproved": false,
  "message": "Credit request submitted for admin approval.",
  "createdAt": "2026-10-05T18:00:00.000Z"
}
```

**Response — Auto-Approved (Subsequent Online) (201):**

```json
{
  "id": "wcr-1092a3f0-4491",
  "amountPaise": 50000,
  "status": "COMPLETED",
  "autoApproved": true,
  "message": "Wallet credited successfully.",
  "createdAt": "2026-10-05T18:00:00.000Z"
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
| `type` | `CREDIT` \| `DEBIT` | No | Filter by transaction type |
| `startDate` | `YYYY-MM-DD` | No | Transactions on or after date |
| `endDate` | `YYYY-MM-DD` | No | Transactions on or before date |
| `page` | integer | No | Page number (default 1) |
| `limit` | integer | No | Items per page (default 20, max 100) |

**Response (200):**

```json
{
  "data": [
    {
      "id": "txn-5512b9a0",
      "type": "CREDIT",
      "amountPaise": 50000,
      "balanceAfterPaise": 50000,
      "referenceType": "CREDIT_REQUEST",
      "referenceId": "wcr-1092a3f0-4491",
      "description": "Wallet credit (auto-approved)",
      "createdAt": "2026-10-05T18:30:00.000Z"
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
| `status` | `PENDING` \| `COMPLETED` \| `REJECTED` | No | Filter by status |
| `page` | integer | No | Page number (default 1) |
| `limit` | integer | No | Items per page (default 20, max 100) |

**Response (200):**

```json
{
  "data": [
    {
      "id": "wcr-1092a3f0-4491",
      "amountPaise": 50000,
      "status": "REJECTED",
      "autoApproved": false,
      "adminNote": "Online payment could not be reconciled",
      "refundStatus": "REFUNDED",
      "reviewedAt": "2026-10-05T18:35:00.000Z",
      "createdAt": "2026-10-05T18:00:00.000Z"
    }
  ],
  "pagination": { "page": 1, "limit": 20, "total": 1, "totalPages": 1 }
}
```

---

## Error Codes

| Code | HTTP Status | Description |
|---|---|---|
| `INVALID_CREDIT_AMOUNT` | 400 | Amount out of configured bounds or not an integer number of paise |
| `WALLET_PENDING_REQUEST_EXISTS` | 409 | A credit request is already pending for this wallet |
| `IDEMPOTENCY_KEY_REUSED` | 409 | Idempotency key reused with different parameters |
| `INSUFFICIENT_WALLET_BALANCE` | 400 | Not enough balance for debit |

## Security Rules

- Customer can only access their own wallet, transactions, and credit requests.
- `userId` is always derived from `JWT.sub` — never accepted from request body.
- Customer cannot manipulate balance, status, adminId, `autoCreditEnabled`, or `refundStatus`.
- Customer cannot access Admin endpoints (`403 Forbidden`).
- Missing or invalid token returns `401 Unauthorized`.
- Extra/forbidden fields in request body are silently stripped by whitelist validation.
