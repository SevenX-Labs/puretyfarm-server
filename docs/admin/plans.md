# Admin Plans & Manage Delivery API Specification & Testing Guide

This document provides end-to-end API documentation for **Admin Plan Configuration** and **Admin Delivery Management (Change Requests)** in the PuretyFarm backend.

---

## 1. Overview & Architecture

### Base URLs & Dual Routing
All admin plan and delivery management routes support dual routing prefixes:
- **Base URL**: `https://api-puretyfarm.onrender.com`
- **Prefix A (Versioned)**: `https://api-puretyfarm.onrender.com/api/v1/admin/...`
- **Prefix B (Direct)**: `https://api-puretyfarm.onrender.com/admin/...`

### Security & Role Enforcement
- **Authentication**: Every request must provide a valid Admin JWT access token in the `Authorization` header: `Bearer <ADMIN_JWT_ACCESS_TOKEN>`.
- **Role Enforcement**: Protected by `JwtAuthGuard` and `@Roles('ADMIN')`. Customer tokens presenting `role: "CUSTOMER"` are strictly rejected with `403 Forbidden`.
- **Identity Derivation**: Admin identity for approvals/rejections is derived strictly from `JWT.sub`. Request bodies cannot override `adminId`.

---

## 2. Admin Plan Configuration API

### Core Business Rules
- **Fixed Plan Types**: Exactly three plan types exist: `BUY_ONCE`, `SEVEN_DAY_TRIAL`, and `MONTHLY`. Plans cannot be arbitrarily created or deleted.
- **Integer Paise Pricing**: All prices are stored and transmitted as **integer paise** (₹1 = 100 paise). Floating point currency or string numbers are rejected.
- **Cross-Field Validation**:
  - `sellingPricePerLitre` must never exceed `actualPricePerLitre`.
  - `quantityMin` must never exceed `quantityMax`.
  - For `MONTHLY` plans, at least one frequency (`dailyEnabled`, `alternateDaysEnabled`) and one quantity mode (`fixedQuantityEnabled`, `alternatingQuantityEnabled`) must remain enabled.
- **Advisory Locking**: Updates use PostgreSQL advisory transactions to serialize concurrent partial modifications safely.

---

### 2.1 Get All Plan Configurations
Retrieves the configuration status of all three system plans.

- **Method**: `GET`
- **Endpoint**: `/api/v1/admin/plans`
- **Headers**:
  ```http
  Authorization: Bearer <ADMIN_ACCESS_TOKEN>
  ```

#### Response Example (`200 OK`):
```json
{
  "plans": [
    {
      "type": "BUY_ONCE",
      "isActive": true,
      "actualPricePerLitre": 9500,
      "sellingPricePerLitre": 8500,
      "quantityMin": 1,
      "quantityMax": 5,
      "deliveryFeePaise": 0,
      "deliveryStartTime": "06:00",
      "deliveryEndTime": "08:00",
      "maxUsages": 3,
      "createdAt": "2026-10-04T12:00:00.000Z",
      "updatedAt": "2026-10-05T10:00:00.000Z"
    },
    {
      "type": "SEVEN_DAY_TRIAL",
      "isActive": true,
      "actualPricePerLitre": 9500,
      "sellingPricePerLitre": 7500,
      "quantityMin": 1,
      "quantityMax": 3,
      "deliveryFeePaise": 0,
      "deliveryStartTime": "06:00",
      "deliveryEndTime": "08:00",
      "trialDurationDays": 7,
      "maxUsages": 1,
      "createdAt": "2026-10-04T12:00:00.000Z",
      "updatedAt": "2026-10-05T10:00:00.000Z"
    },
    {
      "type": "MONTHLY",
      "isActive": true,
      "actualPricePerLitre": 9500,
      "sellingPricePerLitre": 8000,
      "quantityMin": 1,
      "quantityMax": 10,
      "deliveryFeePaise": 0,
      "deliveryStartTime": "06:00",
      "deliveryEndTime": "08:00",
      "dailyEnabled": true,
      "alternateDaysEnabled": true,
      "fixedQuantityEnabled": true,
      "alternatingQuantityEnabled": true,
      "frequencies": ["DAILY", "ALTERNATE_DAYS"],
      "quantityModes": ["FIXED", "ALTERNATING"],
      "createdAt": "2026-10-04T12:00:00.000Z",
      "updatedAt": "2026-10-05T10:00:00.000Z"
    }
  ],
  "unconfigured": []
}
```

---

### 2.2 Get Single Plan Configuration
Retrieves configuration for a specific plan.

- **Method**: `GET`
- **Endpoint**: `/api/v1/admin/plans/:planType`
- **Route Parameters**:
  - `planType`: `BUY_ONCE` | `SEVEN_DAY_TRIAL` | `MONTHLY`

#### Response Example (`200 OK` - Monthly Plan):
```json
{
  "type": "MONTHLY",
  "isActive": true,
  "actualPricePerLitre": 9500,
  "sellingPricePerLitre": 8000,
  "quantityMin": 1,
  "quantityMax": 10,
  "deliveryFeePaise": 0,
  "deliveryStartTime": "06:00",
  "deliveryEndTime": "08:00",
  "dailyEnabled": true,
  "alternateDaysEnabled": true,
  "fixedQuantityEnabled": true,
  "alternatingQuantityEnabled": true,
  "frequencies": ["DAILY", "ALTERNATE_DAYS"],
  "quantityModes": ["FIXED", "ALTERNATING"],
  "createdAt": "2026-10-04T12:00:00.000Z",
  "updatedAt": "2026-10-05T10:00:00.000Z"
}
```

---

### 2.3 Update Plan Configuration
Partially updates configuration fields for a specific plan type.

- **Method**: `PATCH`
- **Endpoint**: `/api/v1/admin/plans/:planType`
- **Route Parameters**:
  - `planType`: `BUY_ONCE` | `SEVEN_DAY_TRIAL` | `MONTHLY`

#### Common Request Body Fields (Optional):
| Field | Type | Description |
| :--- | :--- | :--- |
| `actualPricePerLitre` | Integer (paise) | Base price per litre (e.g. `9500` = ₹95.00) |
| `sellingPricePerLitre` | Integer (paise) | Discounted selling price per litre (e.g. `8000` = ₹80.00) |
| `quantityMin` | Integer | Minimum allowed quantity in litres (>= 1) |
| `quantityMax` | Integer | Maximum allowed quantity in litres (<= 50) |
| `isActive` | Boolean | Whether the plan is currently visible to customers |

#### Plan-Specific Request Body Fields:
- **`BUY_ONCE`**:
  - `maxUsages` (Integer, 1-100): Lifetime uses permitted per customer.
- **`SEVEN_DAY_TRIAL`**:
  - *(Duration is fixed at 7 days and usage limit is fixed at 1; only common fields can be updated).*
- **`MONTHLY`**:
  - `dailyEnabled` (Boolean): Allow Daily delivery schedule.
  - `alternateDaysEnabled` (Boolean): Allow Alternate Days delivery schedule.
  - `fixedQuantityEnabled` (Boolean): Allow Fixed daily quantity.
  - `alternatingQuantityEnabled` (Boolean): Allow Alternating (Qty A / Qty B) daily quantity.

#### Request Example (Update Monthly Plan Options):
```json
{
  "sellingPricePerLitre": 7900,
  "quantityMax": 12,
  "dailyEnabled": true,
  "alternateDaysEnabled": true,
  "fixedQuantityEnabled": true,
  "alternatingQuantityEnabled": false
}
```

#### Request Example (Update Buy Once Usages & Pricing):
```json
{
  "actualPricePerLitre": 9500,
  "sellingPricePerLitre": 8500,
  "maxUsages": 5
}
```

---

## 3. Admin Manage Delivery API (Change Requests)

### Core Workflow
Customers can submit change requests (`PAUSE`, `RESUME`, `SKIP`, `CHANGE_QUANTITY`, `CHANGE_SCHEDULE`) for their active subscriptions. Administrators review and approve/reject these requests.

- **Status Lifecycle**: `PENDING` ➡️ `APPROVED` or `REJECTED` (or `CANCELLED` by customer before review).
- **Atomic Concurrency**: Only one admin can review a pending request; double-reviews return `409 Conflict`.
- **Automatic Execution**: When approved, the system immediately applies schedule and quantity modifications to customer active plan deliveries.

---

### 3.1 List Change Requests
Retrieves a paginated list of customer change requests with optional filters.

- **Method**: `GET`
- **Endpoint**: `/api/v1/admin/manage-delivery/requests`
- **Query Parameters**:
  | Parameter | Type | Required | Description |
  | :--- | :--- | :--- | :--- |
  | `status` | String | No | Filter by `PENDING`, `APPROVED`, `REJECTED`, `CANCELLED` |
  | `requestType` | String | No | Filter by `PAUSE`, `RESUME`, `SKIP`, `CHANGE_QUANTITY`, `CHANGE_SCHEDULE` |
  | `page` | Integer | No | Page number (default: `1`) |
  | `limit` | Integer | No | Page size (default: `20`, max: `100`) |

#### Response Example (`200 OK`):
```json
{
  "data": [
    {
      "id": "c7a83d42-5f6e-41d9-83bc-91823abce123",
      "requestType": "SKIP",
      "status": "PENDING",
      "currentConfiguration": {
        "status": "ACTIVE",
        "frequency": "DAILY",
        "quantity": 2
      },
      "requestedConfiguration": {
        "skipDate": "2026-10-10"
      },
      "adminNote": null,
      "reviewedAt": null,
      "createdAt": "2026-10-05T08:30:00.000Z",
      "customer": {
        "id": "d1e2f3a4-b5c6-7d8e-9f0a-1b2c3d4e5f6a",
        "mobile": "+919876543210",
        "email": "customer@example.com",
        "name": "Sahil Hode"
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

### 3.2 Get Single Change Request Detail
Retrieves comprehensive details of a single change request.

- **Method**: `GET`
- **Endpoint**: `/api/v1/admin/manage-delivery/requests/:requestId`
- **Route Parameters**:
  - `requestId`: UUID of the change request.

#### Response Example (`200 OK`):
```json
{
  "id": "c7a83d42-5f6e-41d9-83bc-91823abce123",
  "requestType": "CHANGE_QUANTITY",
  "status": "PENDING",
  "currentConfiguration": {
    "quantityMode": "FIXED",
    "quantity": 2
  },
  "requestedConfiguration": {
    "effectiveDate": "2026-10-08",
    "quantityMode": "FIXED",
    "quantity": 3
  },
  "adminId": null,
  "adminNote": null,
  "reviewedAt": null,
  "createdAt": "2026-10-05T09:00:00.000Z",
  "updatedAt": "2026-10-05T09:00:00.000Z",
  "customer": {
    "id": "d1e2f3a4-b5c6-7d8e-9f0a-1b2c3d4e5f6a",
    "mobile": "+919876543210",
    "email": "customer@example.com",
    "name": "Sahil Hode"
  }
}
```

---

### 3.3 Approve Change Request
Approves a pending request and applies the change to deliveries immediately.

- **Method**: `POST`
- **Endpoint**: `/api/v1/admin/manage-delivery/requests/:requestId/approve`
- **Route Parameters**:
  - `requestId`: UUID of the change request.
- **Request Body**: `{}` *(empty JSON object)*

#### Response Example (`200 OK`):
```json
{
  "success": true,
  "message": "The change request has been approved and applied.",
  "request": {
    "id": "c7a83d42-5f6e-41d9-83bc-91823abce123",
    "status": "APPROVED",
    "requestType": "CHANGE_QUANTITY"
  }
}
```

---

### 3.4 Reject Change Request
Rejects a pending change request with a mandatory reason note.

- **Method**: `POST`
- **Endpoint**: `/api/v1/admin/manage-delivery/requests/:requestId/reject`
- **Route Parameters**:
  - `requestId`: UUID of the change request.
- **Request Body**:
  ```json
  {
    "note": "Route schedule cannot support the requested modification for tomorrow morning."
  }
  ```

#### Response Example (`200 OK`):
```json
{
  "success": true,
  "message": "The change request has been rejected.",
  "request": {
    "id": "c7a83d42-5f6e-41d9-83bc-91823abce123",
    "status": "REJECTED",
    "adminNote": "Route schedule cannot support the requested modification for tomorrow morning."
  }
}
```

---

## 4. Step-by-Step Testing Guide (cURL)

Set your access token environment variable before testing:
```bash
export BASE_URL="https://api-puretyfarm.onrender.com"
export ADMIN_TOKEN="<YOUR_ADMIN_ACCESS_TOKEN>"
```

### 1. Admin Login (Get Token)
```bash
curl -i -X POST "$BASE_URL/api/v1/auth/admin/login" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "admin@puretyfarm.in",
    "password": "puretyfarm@2026"
  }'
```

### 2. View All Plan Configurations
```bash
curl -i -X GET "$BASE_URL/api/v1/admin/plans" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

### 3. Update Monthly Plan Pricing & Options
```bash
curl -i -X PATCH "$BASE_URL/api/v1/admin/plans/MONTHLY" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "sellingPricePerLitre": 8000,
    "actualPricePerLitre": 9500,
    "quantityMin": 1,
    "quantityMax": 10,
    "dailyEnabled": true,
    "alternateDaysEnabled": true,
    "fixedQuantityEnabled": true,
    "alternatingQuantityEnabled": true
  }'
```

### 4. Update Buy Once Plan Limits
```bash
curl -i -X PATCH "$BASE_URL/api/v1/admin/plans/BUY_ONCE" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "sellingPricePerLitre": 8500,
    "actualPricePerLitre": 9500,
    "maxUsages": 5
  }'
```

### 5. List Pending Delivery Change Requests
```bash
curl -i -X GET "$BASE_URL/api/v1/admin/manage-delivery/requests?status=PENDING&page=1&limit=20" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

### 6. Get Specific Request Details
```bash
curl -i -X GET "$BASE_URL/api/v1/admin/manage-delivery/requests/<REQUEST_ID>" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

### 7. Approve Change Request
```bash
curl -i -X POST "$BASE_URL/api/v1/admin/manage-delivery/requests/<REQUEST_ID>/approve" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}'
```

### 8. Reject Change Request
```bash
curl -i -X POST "$BASE_URL/api/v1/admin/manage-delivery/requests/<REQUEST_ID>/reject" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "note": "Cut-off time for tomorrow has already passed."
  }'
```
