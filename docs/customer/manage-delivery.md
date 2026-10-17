# Customer Manage Delivery API Specification & Testing Guide

This document provides complete, production-grade documentation for the **Customer Delivery Management System** (`ManageDeliveryModule`) in the PuretyFarm backend. It covers calendar inspection, immediate skips, pause/resume vacation holds, single-delivery and plan-level quantity adjustments, frequency/plan modifications, and change request tracking.

---

## 1. Overview & Architecture

### Core Concepts
- **Active Plan Delivery Calendar**: Customers can inspect all materialised upcoming deliveries linked to their active or paused plan subscription (`selectionId`), including dates, quantities, delivery windows, dispatch orders, expected prices, and settlement statuses.
- **Immediate Skip**: Customers can directly skip any single future delivery (`SCHEDULED`). This cancels the delivery and stands down its dispatch order immediately without requiring admin intervention.
- **Approval-Gated Change Requests**: Structural adjustments that affect scheduling, production, or billing create a `ManageDeliveryChangeRequest` in `status: "PENDING"` awaiting admin review:
  - **Vacation Pause (`PAUSE`)**: Holds deliveries from a specified date until an optional `resumeDate`. Deliveries in the pause window are safely placed on hold upon admin approval.
  - **Plan Resume (`RESUME`)**: Reactivates a paused plan and restores upcoming delivery occurrences.
  - **Single Delivery Quantity Change (`CHANGE_QUANTITY`)**: Adjusts the milk quantity (e.g. from 2L to 3L) for ONE specific upcoming delivery date.
    - *Wallet Shortfall Pre-check*: If the requested quantity costs more than the current order total, the system verifies that the customer's wallet has sufficient funds. If insufficient, it immediately returns a structured `400 INSUFFICIENT_WALLET_BALANCE` error specifying the exact shortfall in paise/rupees so the customer can top up before requesting.
  - **Plan Quantity Change (`CHANGE_QUANTITY`)**: Adjusts the default daily/alternating quantity for all future deliveries.
  - **Frequency Change (`CHANGE_FREQUENCY`)**: Converts a monthly plan between `DAILY` and `ALTERNATE_DAYS`.
  - **Plan Type Change (`CHANGE_PLAN`)**: Requests switching between plan types (e.g., from `SEVEN_DAY_TRIAL` to `MONTHLY`).
  - **Schedule Reconfiguration (`CHANGE_SCHEDULE`)**: Full reconfiguration of delivery frequency, quantity mode (`FIXED` vs `ALTERNATING`), and quantities.

### Base URLs & Dual Routing
All customer delivery management endpoints support dual routing:
- **Prefix A**: `https://api-puretyfarm.onrender.com/api/v1/customer/manage-delivery/...`
- **Prefix B**: `https://api-puretyfarm.onrender.com/customer/manage-delivery/...`

### Security Standards
- **Authentication**: All endpoints require a valid customer JWT:
  ```http
  Authorization: Bearer <CUSTOMER_ACCESS_TOKEN>
  ```
- **Role Guard**: Enforced by `JwtAuthGuard`; only `CUSTOMER` tokens are permitted.
- **IDOR Protection**: The customer's identity is derived strictly from `JWT.sub`. A customer can never view or modify another customer's plan, delivery, or change request.

---

## 2. API Endpoints Specification

### 2.1 Get Active Plan Delivery Calendar
Retrieves the customer's active or paused plan configuration and chronological list of all deliveries.

- **Method**: `GET`
- **Path**: `/api/v1/customer/manage-delivery`
- **Headers**:
  - `Authorization: Bearer <ACCESS_TOKEN>`
- **Success Response (`200 OK`)**:
  ```json
  {
    "activePlan": {
      "selectionId": "sel-a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d",
      "planType": "MONTHLY",
      "status": "CONFIRMED",
      "billingModel": "PER_DELIVERY",
      "frequency": "DAILY",
      "quantityMode": "FIXED",
      "quantityLitres": 2,
      "quantityA": null,
      "quantityB": null,
      "startDate": "2026-10-18",
      "endDate": "2026-11-16",
      "deliveryStartTime": "06:00",
      "deliveryEndTime": "09:00"
    },
    "upcomingDeliveries": [
      {
        "date": "2026-10-18",
        "occurrence": 1,
        "quantityLitres": 2,
        "status": "SCHEDULED",
        "canSkip": true,
        "canModify": true,
        "orderId": "ord-b1c2d3e4-f5a6-7b8c-9d0e-1f2a3b4c5d6e",
        "orderNumber": "PF10001",
        "expectedAmountPaise": 16000,
        "settlementStatus": "PENDING"
      },
      {
        "date": "2026-10-19",
        "occurrence": 2,
        "quantityLitres": 2,
        "status": "SCHEDULED",
        "canSkip": true,
        "canModify": true,
        "orderId": "ord-c2d3e4f5-a6b7-8c9d-0e1f-2a3b4c5d6e7f",
        "orderNumber": "PF10002",
        "expectedAmountPaise": 16000,
        "settlementStatus": "PENDING"
      }
    ]
  }
  ```
- **Error Responses**:
  - `404 Not Found`: No active or paused plan subscription exists for the customer.
  - `401 Unauthorized`: Token missing or invalid.

---

### 2.2 Skip a Delivery (Immediate)
Skips a specific future delivery date. Moves the delivery status to `SKIPPED` and safely cancels its dispatch order. No admin approval required.

- **Method**: `POST`
- **Path**: `/api/v1/customer/manage-delivery/skip`
- **Headers**:
  - `Authorization: Bearer <ACCESS_TOKEN>`
  - `Content-Type: application/json`
- **Request Body**:
  ```json
  {
    "deliveryDate": "2026-10-20"
  }
  ```
- **Validation Rules**:
  - `deliveryDate`: Required valid ISO date (`YYYY-MM-DD`). Must be strictly in the future (today and past dates cannot be skipped).
- **Success Response (`200 OK`)**:
  ```json
  {
    "success": true,
    "message": "Delivery skipped successfully.",
    "delivery": {
      "activePlan": { ... },
      "upcomingDeliveries": [ ... ]
    }
  }
  ```
- **Error Responses**:
  - `400 Bad Request`: `Only future deliveries can be skipped` or `${date} is not a scheduled delivery date`.
  - `400 Bad Request`: `This delivery is already skipped` or `A completed delivery cannot be skipped`.

---

### 2.3 Request Vacation Pause
Submits a request to pause deliveries. Deliveries remain active until an admin approves the request.

- **Method**: `POST`
- **Path**: `/api/v1/customer/manage-delivery/pause`
- **Headers**:
  - `Authorization: Bearer <ACCESS_TOKEN>`
  - `Content-Type: application/json`
- **Request Body (all fields optional)**:
  ```json
  {
    "resumeDate": "2026-10-28"
  }
  ```
- **Validation Rules**:
  - `resumeDate`: Optional ISO date (`YYYY-MM-DD`). If provided, must be in the future and cannot exceed the plan's `endDate`.
- **Success Response (`200 OK`)**:
  ```json
  {
    "success": true,
    "message": "Your pause request has been submitted. Deliveries continue as normal until an admin approves it.",
    "request": {
      "id": "req-uuid",
      "type": "PAUSE",
      "status": "PENDING",
      "currentConfiguration": {
        "status": "CONFIRMED",
        "frequency": "DAILY",
        "quantityMode": "FIXED",
        "quantity": 2,
        "startDate": "2026-10-18",
        "endDate": "2026-11-16"
      },
      "requestedConfiguration": {
        "status": "PAUSED",
        "resumeDate": "2026-10-28"
      },
      "createdAt": "2026-10-17T14:00:00.000Z",
      "message": "Your change request is pending admin approval."
    }
  }
  ```
- **Error Responses**:
  - `409 Conflict`: A pending `PAUSE` or `RESUME` request is already awaiting admin review.
  - `400 Bad Request`: `resumeDate must be in the future` or exceeds plan end date.

---

### 2.4 Request Plan Resume
Requests resuming deliveries for a previously `PAUSED` plan.

- **Method**: `POST`
- **Path**: `/api/v1/customer/manage-delivery/resume`
- **Headers**:
  - `Authorization: Bearer <ACCESS_TOKEN>`
- **Request Body**: None (empty body)
- **Success Response (`200 OK`)**:
  ```json
  {
    "success": true,
    "message": "Your resume request has been submitted. Your plan stays paused until an admin approves it.",
    "request": {
      "id": "req-uuid",
      "type": "RESUME",
      "status": "PENDING",
      "currentConfiguration": {
        "status": "PAUSED",
        "startDate": "2026-10-18",
        "endDate": "2026-11-16"
      },
      "requestedConfiguration": {
        "status": "CONFIRMED"
      },
      "createdAt": "2026-10-17T14:05:00.000Z",
      "message": "Your change request is pending admin approval."
    }
  }
  ```
- **Error Responses**:
  - `404 Not Found`: Customer has no paused plan to resume.
  - `409 Conflict`: A pending resume request already exists.

---

### 2.5 Request Quantity Change
Modifies either a single upcoming delivery's quantity or the entire plan's default quantity.

- **Method**: `POST`
- **Path**: `/api/v1/customer/manage-delivery/change-quantity`
- **Headers**:
  - `Authorization: Bearer <ACCESS_TOKEN>`
  - `Content-Type: application/json`
- **Request Body — Single Delivery Quantity Change**:
  ```json
  {
    "quantityLitres": 3,
    "deliveryDate": "2026-10-22"
  }
  ```
- **Request Body — Plan-Wide Quantity Change**:
  ```json
  {
    "quantityLitres": 3
  }
  ```
- **Body Attributes**:
  - `quantityLitres` (Integer, Required): New quantity in litres (between `1` and `10`).
  - `deliveryDate` (String YYYY-MM-DD, Optional): Scheduled date of the single delivery to change. If omitted, applies to all future deliveries.
- **Success Response (`200 OK`) — Single Delivery**:
  ```json
  {
    "success": true,
    "message": "Your quantity change request has been submitted for admin approval.",
    "request": {
      "id": "req-uuid",
      "type": "CHANGE_QUANTITY",
      "status": "PENDING",
      "orderId": "ord-uuid",
      "orderNumber": "PF10005",
      "deliveryDate": "2026-10-22",
      "currentQuantity": 2,
      "requestedQuantity": 3,
      "currentAmountPaise": 16000,
      "requestedAmountPaise": 24000
    }
  }
  ```
- **Error Responses**:
  - `400 Bad Request` (Insufficient Wallet Balance for increased quantity):
    ```json
    {
      "error": "INSUFFICIENT_WALLET_BALANCE",
      "message": "Your wallet balance is too low for this change. Add at least ₹80 to your wallet first, then request the change again.",
      "orderNumber": "PF10005",
      "deliveryDate": "2026-10-22",
      "currentQuantity": 2,
      "requestedQuantity": 3,
      "currentBalancePaise": 16000,
      "currentAmountPaise": 16000,
      "requiredPaise": 24000,
      "shortfallPaise": 8000
    }
    ```
  - `400 Bad Request`: `The order cut-off for the {date} delivery has passed` (cannot change after 23:00 IST preceding delivery).
  - `409 Conflict`: `You already have a pending quantity request for this delivery.`

---

### 2.6 Request Delivery Frequency Change
Requests changing the delivery frequency of an active monthly plan between `DAILY` and `ALTERNATE_DAYS`.

- **Method**: `POST`
- **Path**: `/api/v1/customer/manage-delivery/change-frequency`
- **Headers**:
  - `Authorization: Bearer <ACCESS_TOKEN>`
  - `Content-Type: application/json`
- **Request Body**:
  ```json
  {
    "frequency": "ALTERNATE_DAYS"
  }
  ```
- **Success Response (`200 OK`)**:
  ```json
  {
    "success": true,
    "message": "Your delivery frequency change request has been submitted for admin approval.",
    "request": {
      "id": "req-uuid",
      "type": "CHANGE_FREQUENCY",
      "status": "PENDING",
      "currentFrequency": "DAILY",
      "requestedFrequency": "ALTERNATE_DAYS"
    }
  }
  ```
- **Error Responses**:
  - `400 Bad Request`: `Frequency changes apply to monthly plans only` or `Requested frequency is the same as current`.

---

### 2.7 Request Plan Type Change
Requests migrating the active subscription to another plan type.

- **Method**: `POST`
- **Path**: `/api/v1/customer/manage-delivery/change-plan`
- **Headers**:
  - `Authorization: Bearer <ACCESS_TOKEN>`
  - `Content-Type: application/json`
- **Request Body**:
  ```json
  {
    "planType": "MONTHLY"
  }
  ```
- **Success Response (`200 OK`)**:
  ```json
  {
    "success": true,
    "message": "Your plan change request has been submitted for admin approval.",
    "request": {
      "id": "req-uuid",
      "type": "CHANGE_PLAN",
      "status": "PENDING",
      "currentPlanType": "SEVEN_DAY_TRIAL",
      "requestedPlanType": "MONTHLY"
    }
  }
  ```

---

### 2.8 Request Schedule Reconfiguration
Reconfigures frequency and quantity mode (`FIXED` vs `ALTERNATING`) for an active monthly plan.

- **Method**: `POST`
- **Path**: `/api/v1/customer/manage-delivery/change-schedule`
- **Headers**:
  - `Authorization: Bearer <ACCESS_TOKEN>`
  - `Content-Type: application/json`
- **Request Body (Mode A: FIXED)**:
  ```json
  {
    "frequency": "DAILY",
    "quantityMode": "FIXED",
    "quantity": 3
  }
  ```
- **Request Body (Mode B: ALTERNATING)**:
  ```json
  {
    "frequency": "ALTERNATE_DAYS",
    "quantityMode": "ALTERNATING",
    "quantityA": 1,
    "quantityB": 3
  }
  ```
- **Success Response (`200 OK`)**:
  ```json
  {
    "success": true,
    "message": "Your schedule change request has been submitted for admin approval.",
    "request": {
      "id": "req-uuid",
      "type": "CHANGE_FREQUENCY",
      "status": "PENDING"
    }
  }
  ```

---

### 2.9 List Own Change Requests
Lists all delivery change requests submitted by the authenticated customer in reverse chronological order.

- **Method**: `GET`
- **Path**: `/api/v1/customer/manage-delivery/requests`
- **Headers**:
  - `Authorization: Bearer <ACCESS_TOKEN>`
- **Success Response (`200 OK`)**:
  ```json
  [
    {
      "id": "req-uuid-1",
      "type": "CHANGE_QUANTITY",
      "status": "PENDING",
      "currentConfiguration": { "quantity": 2, "deliveryDate": "2026-10-22", "orderNumber": "PF10005" },
      "requestedConfiguration": { "quantity": 3, "deliveryDate": "2026-10-22", "orderNumber": "PF10005", "requestedBy": "CUSTOMER" },
      "orderId": "ord-uuid",
      "currentAmountPaise": 16000,
      "requestedAmountPaise": 24000,
      "createdAt": "2026-10-17T14:10:00.000Z",
      "reviewedAt": null,
      "message": "Your change request is pending admin approval."
    },
    {
      "id": "req-uuid-2",
      "type": "PAUSE",
      "status": "APPROVED",
      "currentConfiguration": { ... },
      "requestedConfiguration": { ... },
      "createdAt": "2026-10-15T09:00:00.000Z",
      "reviewedAt": "2026-10-15T10:30:00.000Z",
      "message": "Your change request has been approved and your delivery schedule has been updated."
    }
  ]
  ```

---

### 2.10 Get Change Request by ID
Fetches details of a specific change request.

- **Method**: `GET`
- **Path**: `/api/v1/customer/manage-delivery/requests/:requestId`
- **Headers**:
  - `Authorization: Bearer <ACCESS_TOKEN>`
- **Success Response (`200 OK`)**: Single change request object (same shape as array item above).
- **Error Responses**:
  - `404 Not Found`: Request not found or belongs to another user (IDOR protection).

---

## 3. Step-by-Step cURL Guide

```bash
export TOKEN="YOUR_CUSTOMER_JWT_ACCESS_TOKEN"
export BASE="https://api-puretyfarm.onrender.com/api/v1/customer/manage-delivery"

# 1. View delivery schedule
curl -i -X GET "$BASE" \
  -H "Authorization: Bearer $TOKEN"

# 2. Skip a future delivery (e.g. 2026-10-20)
curl -i -X POST "$BASE/skip" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"deliveryDate": "2026-10-20"}'

# 3. Request a quantity change for a specific upcoming delivery
curl -i -X POST "$BASE/change-quantity" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "quantityLitres": 3,
    "deliveryDate": "2026-10-22"
  }'

# 4. Request a vacation pause
curl -i -X POST "$BASE/pause" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"resumeDate": "2026-10-28"}'

# 5. List all submitted change requests
curl -i -X GET "$BASE/requests" \
  -H "Authorization: Bearer $TOKEN"
```

---

## 4. Status Codes & Error Reference

| Code | HTTP | Scenario |
|---|---|---|
| `200 OK` | 200 | Successful query or update. |
| `400 Bad Request` | 400 | Past date submitted, order cut-off passed, invalid quantity. |
| `INSUFFICIENT_WALLET_BALANCE` | 400 | Customer wallet lacks funds for an increased delivery quantity. |
| `QUANTITY_CHANGE_NOT_SUPPORTED_FOR_PREPAID_PLAN` | 409 | Single-delivery quantity edits are not allowed on legacy prepaid plans. |
| `401 Unauthorized` | 401 | Missing or expired customer token. |
| `403 Forbidden` | 403 | Non-customer token used. |
| `404 Not Found` | 404 | No active plan, or request ID does not belong to customer. |
| `409 Conflict` | 409 | Duplicate pending request already awaiting review. |
