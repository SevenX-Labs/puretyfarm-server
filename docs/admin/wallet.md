# Admin Wallet API

## Overview

Admin endpoints for managing customer wallet credit requests. Admins can list, view, approve, and reject credit requests, and view customer wallet details.

**External payment/refund integration is not implemented in the Wallet module.**

## Authentication

All endpoints require a valid **Admin JWT** (`Authorization: Bearer <token>`) with `@Roles("ADMIN")`. Customer tokens receive 403. Missing tokens receive 401.

## Authorization

Admin identity is always derived from `JWT.sub`. The request body never supplies `adminId`.

## Approval Workflow

### When does a credit request need admin approval?

1. **First credit request** for any customer — always requires approval
2. **Subsequent requests** when `WALLET_AUTO_CREDIT_ENABLED` is `false` (default) — requires approval
3. **Subsequent requests** when `WALLET_AUTO_CREDIT_ENABLED` is `true` — auto-approved

> **WALLET_AUTO_CREDIT_ENABLED** defaults to `false`. Without payment verification, automatic crediting would let a customer create free money. This flag should only be set to `true` after the Payment module verifies incoming payments.

### State Transitions

```
PENDING → COMPLETED  (via admin approve, or auto-approve)
PENDING → REJECTED   (via admin reject)
```

No other transitions are allowed:
- COMPLETED → REJECTED: Rejected (409)
- REJECTED → COMPLETED: Rejected (409)
- COMPLETED → COMPLETED: Rejected (409)

### Approve Flow

1. Admin calls approve endpoint
2. Atomic conditional update: `status = COMPLETED WHERE status = PENDING`
3. Wallet balance is credited through the ledger path
4. `reviewedByAdminId`, `reviewedAt`, `completedAt` are set
5. Two concurrent approvals: exactly one succeeds (race-safe)

### Reject Flow

1. Admin calls reject endpoint with a required `note`
2. Atomic conditional update: `status = REJECTED WHERE status = PENDING`
3. `refundStatus` is set to `REFUND_PENDING`
4. Balance is **NOT** changed — no ledger row is created
5. No external refund call is made — the Payment module handles refunds
6. Two concurrent rejections: exactly one succeeds

### Refund-Pending Behavior

When a credit request is rejected:
- `refundStatus` = `REFUND_PENDING` (the customer's payment needs to be refunded)
- The Wallet module **never** sets `REFUNDED` or `REFUND_FAILED` — those statuses exist for the future Payment module
- No external refund API call is made from this module

---

## Admin Endpoints

### 1. List Credit Requests

```
GET /api/v1/admin/wallet/credit-requests
```

**Authentication:** Admin JWT required

**Query Parameters:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| status | PENDING \| COMPLETED \| REJECTED | No | Filter by status |
| customerSearch | string | No | Search by customer name/mobile/email |
| startDate | YYYY-MM-DD | No | Requests created on or after |
| endDate | YYYY-MM-DD | No | Requests created on or before |
| page | integer | No | Page number (default 1) |
| limit | integer | No | Items per page (default 20, max 100) |

**Response (200):**

```json
{
  "data": [
    {
      "id": "uuid",
      "amountPaise": 50000,
      "status": "PENDING",
      "refundStatus": "NOT_REQUIRED",
      "autoApproved": false,
      "adminNote": null,
      "reviewedAt": null,
      "completedAt": null,
      "createdAt": "2026-10-05T...",
      "customer": {
        "id": "uuid",
        "mobile": "9999999999",
        "email": "test@example.com",
        "name": "Test User"
      },
      "transaction": null
    }
  ],
  "pagination": { "page": 1, "limit": 20, "total": 1, "totalPages": 1 }
}
```

---

### 2. Get Credit Request Detail

```
GET /api/v1/admin/wallet/credit-requests/:id
```

**Authentication:** Admin JWT required

**Response (200):**

```json
{
  "id": "uuid",
  "amountPaise": 50000,
  "status": "COMPLETED",
  "refundStatus": "NOT_REQUIRED",
  "autoApproved": false,
  "adminNote": null,
  "reviewedByAdminId": "admin-uuid",
  "reviewedAt": "2026-10-05T...",
  "completedAt": "2026-10-05T...",
  "createdAt": "2026-10-05T...",
  "updatedAt": "2026-10-05T...",
  "customer": {
    "id": "uuid",
    "mobile": "9999999999",
    "email": "test@example.com",
    "name": "Test User"
  },
  "walletBalancePaise": 50000,
  "transaction": {
    "id": "txn-uuid",
    "type": "CREDIT",
    "amountPaise": 50000,
    "balanceAfterPaise": 50000,
    "createdAt": "2026-10-05T..."
  }
}
```

**Errors:**
- `404 CREDIT_REQUEST_NOT_FOUND` — Request does not exist

---

### 3. Approve Credit Request

```
POST /api/v1/admin/wallet/credit-requests/:id/approve
```

**Authentication:** Admin JWT required

**Request Body:** `{}` (empty JSON object)

**Response (200):**

```json
{
  "success": true,
  "message": "Credit request approved and wallet credited.",
  "request": {
    "id": "uuid",
    "status": "COMPLETED",
    "amountPaise": 50000
  }
}
```

**Errors:**
- `404 CREDIT_REQUEST_NOT_FOUND` — Request does not exist
- `409 CREDIT_REQUEST_ALREADY_PROCESSED` — Request is not in PENDING status

---

### 4. Reject Credit Request

```
POST /api/v1/admin/wallet/credit-requests/:id/reject
```

**Authentication:** Admin JWT required

**Request Body:**

```json
{
  "note": "Payment not verified. Customer needs to resubmit proof."
}
```

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| note | string | Yes | Trimmed, 3-1000 characters |

**Response (200):**

```json
{
  "success": true,
  "message": "Credit request rejected.",
  "request": {
    "id": "uuid",
    "status": "REJECTED",
    "refundStatus": "REFUND_PENDING",
    "adminNote": "Payment not verified. Customer needs to resubmit proof."
  }
}
```

**Errors:**
- `404 CREDIT_REQUEST_NOT_FOUND` — Request does not exist
- `409 CREDIT_REQUEST_ALREADY_PROCESSED` — Request is not in PENDING status

---

### 5. Get Customer Wallet

```
GET /api/v1/admin/wallet/customers/:userId
```

**Authentication:** Admin JWT required

Read-only view of a customer's wallet: balance, summary stats, and recent transactions. No endpoint may edit a balance directly.

**Response (200):**

```json
{
  "customer": {
    "id": "uuid",
    "mobile": "9999999999",
    "email": "test@example.com",
    "name": "Test User"
  },
  "balancePaise": 50000,
  "summary": {
    "totalCreditsPaise": 100000,
    "totalCreditsCount": 2,
    "totalDebitsPaise": 50000,
    "totalDebitsCount": 1
  },
  "recentTransactions": [
    {
      "id": "txn-uuid",
      "type": "DEBIT",
      "amountPaise": 50000,
      "balanceAfterPaise": 50000,
      "referenceType": "ORDER",
      "referenceId": "order-uuid",
      "description": "Order payment",
      "createdAt": "2026-10-05T..."
    }
  ],
  "createdAt": "2026-10-05T...",
  "updatedAt": "2026-10-05T..."
}
```

**Errors:**
- `404` — Customer wallet not found

---

## Error Cases

| Code | HTTP | Description |
|------|------|-------------|
| CREDIT_REQUEST_NOT_FOUND | 404 | Credit request does not exist |
| CREDIT_REQUEST_ALREADY_PROCESSED | 409 | Request is not in PENDING status |

## Security Rules

- Admin identity always from JWT.sub
- Admin cannot impersonate customers via request body
- No endpoint directly modifies wallet balance — all changes go through the ledger
- Customer tokens receive 403 on all admin endpoints
- The immutable ledger (wallet_transactions) cannot be updated or deleted (DB trigger enforced)

## Concurrency Protections

- Approve/reject use conditional `WHERE status = PENDING` — only one admin can process a request
- The ledger path uses atomic `UPDATE ... RETURNING` — no read-then-write race conditions
- Partial unique index enforces at most one PENDING request per wallet at the DB level

## Step-by-Step Testing (cURL)

```bash
export BASE_URL="https://api-puretyfarm.onrender.com"
export ADMIN_TOKEN="<YOUR_ADMIN_ACCESS_TOKEN>"
```

### List pending credit requests
```bash
curl -i -X GET "$BASE_URL/api/v1/admin/wallet/credit-requests?status=PENDING&page=1&limit=20" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

### Get credit request detail
```bash
curl -i -X GET "$BASE_URL/api/v1/admin/wallet/credit-requests/<REQUEST_ID>" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

### Approve credit request
```bash
curl -i -X POST "$BASE_URL/api/v1/admin/wallet/credit-requests/<REQUEST_ID>/approve" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}'
```

### Reject credit request
```bash
curl -i -X POST "$BASE_URL/api/v1/admin/wallet/credit-requests/<REQUEST_ID>/reject" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "note": "Payment not verified. Please resubmit with proof."
  }'
```

### View customer wallet
```bash
curl -i -X GET "$BASE_URL/api/v1/admin/wallet/customers/<USER_ID>" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```
