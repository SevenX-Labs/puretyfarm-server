# Admin Payments & Cash Collection API

## Overview

Admin APIs for managing the financial lifecycle of PuretyFarm: inspecting the unified payment ledger, reconciling offline physical cash collections, and triggering gateway refunds for rejected wallet top-ups.

### Architectural Separation
- **Payment Verification Gate**: Online payment records (`Payment`) transition to `SUCCESS` **only** via cryptographically verified PayU callbacks/webhooks. Admins cannot manually force an online payment status.
- **Physical Cash Gate**: Cash collections (`CashCollection`) do not interact with PayU. Admin confirmation is the operational trigger that authorizes [`WalletService`](file:///home/sahil-hode/Workspace/sevenx%20labs/purety%20farm/puretyfarm-server/src/modules/wallet/wallet.service.ts) to credit the wallet ledger.
- **Wallet Ledger Ownership**: All balance increments and transaction logs are owned exclusively by [`WalletService`](file:///home/sahil-hode/Workspace/sevenx%20labs/purety%20farm/puretyfarm-server/src/modules/wallet/wallet.service.ts).

---

## Authentication & Authorization

All endpoints in this document require an **Admin JWT**:
```http
Authorization: Bearer <ADMIN_ACCESS_TOKEN>
```
- Protected with `@UseGuards(JwtAuthGuard)` and `@Roles('ADMIN')`.
- Acting admin identity is always derived from `JWT.sub`. Request bodies never accept an `adminId`.
- Customer tokens receive `403 Forbidden`. Missing or invalid tokens receive `401 Unauthorized`.

---

## Money & Data Conventions

- **Amounts in Paise**: All amounts (`amountPaise`) are integer paise (₹1 = `100`, ₹1,000 = `100000`).
- **Security & Redaction**: Responses never contain `PAYU_SALT`, raw card data, tokens, or private gateway keys.
- **Route Prefixes**: All routes support both prefixed `/api/v1/admin/payments` and non-prefixed `/admin/payments`.

---

## Endpoints Summary

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/v1/admin/payments` | List and filter all online payments |
| `GET` | `/api/v1/admin/payments/:id` | Get details of a single payment by ID |
| `GET` | `/api/v1/admin/payments/cash-collections` | List and filter cash collection requests |
| `GET` | `/api/v1/admin/payments/cash-collections/:id` | Get single cash collection details |
| `POST` | `/api/v1/admin/payments/cash-collections/:id/confirm` | Confirm physical cash receipt & credit wallet |
| `POST` | `/api/v1/admin/payments/cash-collections/:id/cancel` | Cancel an uncollected cash top-up |
| `POST` | `/api/v1/admin/payments/credit-requests/:creditRequestId/refund` | Trigger PayU gateway refund for rejected credit request |

---

## 1. List Payments

`GET /api/v1/admin/payments`

Retrieves a paginated list of all payments across the system.

### Query Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `status` | string | No | Filter by `PaymentTransactionStatus`: `PENDING`, `PROCESSING`, `SUCCESS`, `FAILED`, `CANCELLED`, `EXPIRED`, `REFUND_PENDING`, `REFUNDED` |
| `purpose` | string | No | Filter by `PaymentPurpose`: `ORDER`, `WALLET_TOPUP` |
| `paymentMethod` | string | No | Filter by `PaymentMethod`: `ONLINE`, `CASH` |
| `transactionId` | string | No | Search by merchant transaction ID (e.g., `PF...`) |
| `customerSearch` | string | No | Search customer by mobile, email, or name |
| `startDate` | string | No | Filter created date from (`YYYY-MM-DD`) |
| `endDate` | string | No | Filter created date to (`YYYY-MM-DD`) |
| `page` | integer | No | Page number (default: `1`, min: `1`) |
| `limit` | integer | No | Items per page (default: `20`, min: `1`, max: `100`) |

### Example Request
```http
GET /api/v1/admin/payments?status=SUCCESS&purpose=WALLET_TOPUP&page=1&limit=20
Authorization: Bearer <ADMIN_JWT>
```

### Example Response (`200 OK`)
```json
{
  "data": [
    {
      "id": "a814c11b-756f-474c-a19c-112fb94ad076",
      "purpose": "WALLET_TOPUP",
      "paymentMethod": "ONLINE",
      "provider": "PAYU",
      "transactionId": "PFM8J1X091A2B3C4D5",
      "providerPaymentId": "403993715530182741",
      "amountPaise": 100000,
      "currency": "INR",
      "status": "SUCCESS",
      "createdAt": "2026-10-05T18:30:00.000Z",
      "completedAt": "2026-10-05T18:31:00.000Z",
      "refundedAt": null,
      "providerRefundId": null,
      "customer": {
        "id": "usr-8812c3f1-0a12",
        "mobile": "+919876543210",
        "email": "customer@example.com",
        "name": "Rahul Sharma"
      }
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 1,
    "totalPages": 1
  }
}
```

---

## 2. Get Single Payment

`GET /api/v1/admin/payments/:id`

Retrieves detailed information for a specific payment, including customer details, sanitized provider response payload, and linked wallet credit request.

### URL Parameters
- `id` (UUID, required): The internal payment ID.

### Example Request
```http
GET /api/v1/admin/payments/a814c11b-756f-474c-a19c-112fb94ad076
Authorization: Bearer <ADMIN_JWT>
```

### Example Response (`200 OK`)
```json
{
  "id": "a814c11b-756f-474c-a19c-112fb94ad076",
  "purpose": "WALLET_TOPUP",
  "paymentMethod": "ONLINE",
  "provider": "PAYU",
  "transactionId": "PFM8J1X091A2B3C4D5",
  "providerPaymentId": "403993715530182741",
  "amountPaise": 100000,
  "currency": "INR",
  "status": "SUCCESS",
  "createdAt": "2026-10-05T18:30:00.000Z",
  "completedAt": "2026-10-05T18:31:00.000Z",
  "refundedAt": null,
  "providerRefundId": null,
  "providerResponse": {
    "mode": "UPI",
    "bankcode": "UPI",
    "status": "success",
    "unmappedstatus": "captured"
  },
  "customer": {
    "id": "usr-8812c3f1-0a12",
    "mobile": "+919876543210",
    "email": "customer@example.com",
    "name": "Rahul Sharma"
  },
  "walletCredit": {
    "id": "wcr-1092a3f0-4491",
    "status": "PENDING",
    "amountPaise": 100000,
    "autoApproved": false,
    "refundStatus": null,
    "adminNote": null,
    "completedAt": null,
    "transactionId": null
  }
}
```

---

## 3. List Cash Collections

`GET /api/v1/admin/payments/cash-collections`

Retrieves a paginated list of offline physical cash collection requests submitted by customers.

### Query Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `status` | string | No | Filter by status: `PENDING`, `COLLECTED`, `CONFIRMED`, `CANCELLED` |
| `customerSearch` | string | No | Search customer by mobile, email, or name |
| `startDate` | string | No | Filter created date from (`YYYY-MM-DD`) |
| `endDate` | string | No | Filter created date to (`YYYY-MM-DD`) |
| `page` | integer | No | Page number (default: `1`, min: `1`) |
| `limit` | integer | No | Items per page (default: `20`, min: `1`, max: `100`) |

### Example Response (`200 OK`)
```json
{
  "data": [
    {
      "id": "csh-9901e12a-3341",
      "amountPaise": 50000,
      "status": "PENDING",
      "walletCreditRequestId": "wcr-5512b9a0-8811",
      "collectedAt": null,
      "confirmedAt": null,
      "createdAt": "2026-10-05T19:00:00.000Z",
      "customer": {
        "id": "usr-8812c3f1-0a12",
        "mobile": "+919876543210",
        "email": "customer@example.com",
        "name": "Rahul Sharma"
      }
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 1,
    "totalPages": 1
  }
}
```

---

## 4. Get Single Cash Collection

`GET /api/v1/admin/payments/cash-collections/:id`

Retrieves details for a specific cash collection request.

### Example Response (`200 OK`)
```json
{
  "id": "csh-9901e12a-3341",
  "amountPaise": 50000,
  "status": "CONFIRMED",
  "collectedAt": "2026-10-05T19:20:00.000Z",
  "confirmedAt": "2026-10-05T19:25:00.000Z",
  "confirmedByAdminId": "adm-0012a99c",
  "adminNote": "Cash handed over by delivery partner",
  "createdAt": "2026-10-05T19:00:00.000Z",
  "updatedAt": "2026-10-05T19:25:00.000Z",
  "customer": {
    "id": "usr-8812c3f1-0a12",
    "mobile": "+919876543210",
    "email": "customer@example.com",
    "name": "Rahul Sharma"
  },
  "walletCredit": {
    "id": "wcr-5512b9a0-8811",
    "status": "COMPLETED",
    "amountPaise": 50000,
    "completedAt": "2026-10-05T19:25:00.000Z",
    "transactionId": "txn-7712c00a"
  }
}
```

---

## 5. Confirm Cash Collection

`POST /api/v1/admin/payments/cash-collections/:id/confirm`

Confirms that physical cash was received. This is the **authoritative trigger** that credits the customer's wallet.

### Workflow & Invariants:
1. Validates that `CashCollection` is in `PENDING` or `COLLECTED` status.
2. Atomically updates status to `CONFIRMED`, setting `confirmedByAdminId = JWT.sub` and `confirmedAt = NOW()`.
3. Invokes [`WalletService.creditConfirmedCashRequest()`](file:///home/sahil-hode/Workspace/sevenx%20labs/purety%20farm/puretyfarm-server/src/modules/wallet/wallet.service.ts#L992) within the same database transaction:
   - Transitions `WalletCreditRequest` to `COMPLETED`.
   - Increments customer's `Wallet.balancePaise`.
   - Creates an immutable `WalletTransaction` with type `CREDIT` and referenceType `CREDIT_REQUEST`.
4. **Idempotency**: Repeated confirmation calls return `409 Conflict` (`CASH_COLLECTION_ALREADY_PROCESSED`) and never double-credit.

### Request Body
```json
{
  "note": "Cash received and reconciled from delivery partner"
}
```

| Field | Type | Required | Rules |
|---|---|---|---|
| `note` | string | No | Optional reconciliation note (max 1000 characters) |

### Example Response (`200 OK`)
```json
{
  "success": true,
  "message": "Cash confirmed and wallet credited.",
  "cashCollection": {
    "id": "csh-9901e12a-3341",
    "status": "CONFIRMED",
    "amountPaise": 50000,
    "confirmedAt": "2026-10-05T19:25:00.000Z"
  },
  "walletCredit": {
    "id": "wcr-5512b9a0-8811",
    "status": "COMPLETED",
    "amountPaise": 50000
  }
}
```

---

## 6. Cancel Cash Collection

`POST /api/v1/admin/payments/cash-collections/:id/cancel`

Cancels an offline cash top-up if the cash was never collected or could not be reconciled.

### Workflow & Invariants:
1. Validates that `CashCollection` is in `PENDING` or `COLLECTED` status.
2. Updates `CashCollection` status to `CANCELLED`.
3. Closes the linked `WalletCreditRequest` as `CANCELLED`, releasing the one-pending-per-wallet slot so the customer can start a new top-up.
4. No wallet credit is applied and no refund obligation is created.

### Request Body
```json
{
  "note": "Customer was unavailable at the address during collection"
}
```

| Field | Type | Required | Rules |
|---|---|---|---|
| `note` | string | **Yes** | Mandatory cancellation reason (3 to 1000 characters) |

### Example Response (`200 OK`)
```json
{
  "success": true,
  "message": "Cash collection cancelled.",
  "cashCollection": {
    "id": "csh-9901e12a-3341",
    "status": "CANCELLED",
    "adminNote": "Customer was unavailable at the address during collection"
  }
}
```

---

## 7. Initiate PayU Gateway Refund

`POST /api/v1/admin/payments/credit-requests/:creditRequestId/refund`

Initiates an automated PayU gateway refund for an online payment whose wallet credit request was **rejected** by an admin via `POST /api/v1/admin/wallet/credit-requests/:id/reject`.

### Flow:
```
1. Admin rejects wallet credit request
   POST /api/v1/admin/wallet/credit-requests/:id/reject
   => WalletCreditRequest: REJECTED | refundStatus: REFUND_PENDING
   ↓
2. Admin calls refund endpoint
   POST /api/v1/admin/payments/credit-requests/:creditRequestId/refund
   ├─ Finds settled online Payment (status: SUCCESS)
   ├─ Claims payment: status -> REFUND_PENDING
   ├─ Calls PayU cancel_refund_transaction API
   └─ Saves providerRefundId
   ↓
3. PayU sends refund webhook
   POST /api/v1/payments/webhooks/payu (status: 'refunded')
   => Payment: REFUNDED | WalletCreditRequest: refundStatus = REFUNDED
```

### URL Parameters
- `creditRequestId` (UUID, required): The ID of the rejected `WalletCreditRequest`.

### Request Body
*None (Amount is derived strictly from the stored `Payment` row).*

### Example Response (`200 OK`)
```json
{
  "success": true,
  "message": "Refund requested. It is marked REFUNDED only after the provider confirms it.",
  "payment": {
    "id": "a814c11b-756f-474c-a19c-112fb94ad076",
    "transactionId": "PFM8J1X091A2B3C4D5",
    "status": "REFUND_PENDING",
    "amountPaise": 100000,
    "providerRefundId": "918237461"
  }
}
```

---

## Error Handling Matrix

| HTTP Status | Error Code | Scenario |
|---|---|---|
| `400 Bad Request` | `VALIDATION_ERROR` | Malformed body, invalid date string, or missing mandatory note |
| `401 Unauthorized` | `UNAUTHORIZED` | Missing or invalid Bearer token |
| `403 Forbidden` | `FORBIDDEN` | Caller token does not have `ADMIN` role |
| `404 Not Found` | `PAYMENT_NOT_FOUND` | Payment ID does not exist |
| `404 Not Found` | `CASH_COLLECTION_NOT_FOUND` | Cash collection ID does not exist |
| `404 Not Found` | `CREDIT_REQUEST_NOT_FOUND` | Credit request ID does not exist |
| `409 Conflict` | `CASH_COLLECTION_ALREADY_PROCESSED` | Attempting to confirm or cancel an already processed cash collection |
| `409 Conflict` | `CREDIT_REQUEST_NOT_REJECTED` | Attempting to refund a credit request that is not in `REJECTED` status |
| `409 Conflict` | `NO_REFUNDABLE_PAYMENT` | No settled online payment exists for the given credit request |
| `409 Conflict` | `REFUND_ALREADY_IN_PROGRESS` | Concurrent refund request already claimed the payment |
| `409 Conflict` | `REFUND_REJECTED_BY_PROVIDER` | PayU gateway rejected the refund command |
