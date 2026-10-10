# Admin Orders API

## Overview

Admin order management endpoints for viewing orders, searching by customer/status/date, updating order status through valid lifecycle transitions, and closing out delivered orders as COMPLETED. All pricing, delivery fee, and delivery time configuration is controlled via PlanConfig.

## Authentication

All endpoints require a valid **Admin JWT** (`Authorization: Bearer <token>`) with `@Roles("ADMIN")`. Customer tokens receive 403. Missing tokens receive 401.

## Authorization

Admin identity is always derived from `JWT.sub`. The request body never supplies `adminId`.

## Order Architecture

```
Customer → PlanSelection → PlanDelivery → Order → OrderItems
                                             └──→ Invoice
                                             └──→ Payment (future)
```

## Customer/Order Relationships

Each Order belongs to one User. Admin can view all orders across all customers.

## Multi-Product Order Structure

Each Order contains one or more OrderItems. Each OrderItem stores immutable snapshots:
- `productNameSnapshot` — product name at order time
- `unitPricePaise` — unit price at order time
- `quantity`, `discountPaise`, `taxPaise`, `totalPaise`

## Admin-Controlled Pricing

Pricing is defined in PlanConfig (`actualPricePerLitre`, `sellingPricePerLitre`) in **integer paise**. Orders snapshot these values at creation time. Changing PlanConfig pricing does not affect existing orders.

## Admin-Controlled Delivery Fee

`deliveryFeePaise` on PlanConfig determines the delivery fee per order. Snapshotted at order creation. Customers cannot submit or override it.

## Admin-Controlled Delivery Time

`deliveryStartTime` and `deliveryEndTime` on PlanConfig (HH:MM, 24h format) define the delivery window per plan type, and are snapshotted onto the order at creation.

Both fields are **nullable and have no fallback**. An unconfigured plan snapshots `null`, the API returns `null`, and every client renders "window not set". Order snapshots are historical and are never rewritten to match today's PlanConfig.

The delivery window is **not** the order cut-off. The cut-off is a separate business-wide policy — 23:00 Asia/Kolkata — exposed as `orderCutoff` on the plans APIs. An order placed before 23:00 IST is scheduled for the next calendar day; at or after 23:00 IST, for the day after next. See `docs/admin/plans.md`.

## Order Snapshots

Each Order stores immutable snapshots of:
- Financial data (subtotal, discount, tax, delivery fee, total)
- Address (full address JSON)
- Price per litre (actual and selling)
- Delivery window (start/end time)
- Delivery date

## Order Status Lifecycle

```
PENDING → CONFIRMED → PROCESSING → OUT_FOR_DELIVERY → DELIVERED → COMPLETED
   ↓          ↓            ↓              ↓
CANCELLED  CANCELLED   CANCELLED      FAILED
                        FAILED
```

### Allowed Transitions

| From | To |
|------|----|
| PENDING | CONFIRMED, CANCELLED, FAILED |
| CONFIRMED | PROCESSING, CANCELLED |
| PROCESSING | OUT_FOR_DELIVERY, CANCELLED, FAILED |
| OUT_FOR_DELIVERY | DELIVERED, FAILED |
| DELIVERED | COMPLETED |
| COMPLETED | (terminal) |
| CANCELLED | (terminal) |
| FAILED | (terminal) |

### DELIVERED vs COMPLETED

`DELIVERED` is a statement about the goods: they reached the customer.
`COMPLETED` is an administrative close on an order that is already delivered.
It carries no financial or delivery side effects of its own, which is why it is
safe to expose as a one-click admin action.

Note that an **order status** and a **delivery status** are different things. A
plan order is linked 1:1 to a `PlanDelivery` row whose `DeliveryStatus`
(`SCHEDULED` / `SKIPPED` / `DELIVERED`) records what physically happened on that
one calendar day. Completing an order reads that row and never writes it, so the
other deliveries in a Trial or Monthly schedule — past or future — are untouched.

## Payment Status

Payment status is stored separately from order status: `PENDING`, `PAID`, `FAILED`, `REFUNDED`, `PARTIALLY_REFUNDED`.

**Prepaid plan orders:** Orders created from prepaid plan deliveries (BUY_ONCE, SEVEN_DAY_TRIAL, MONTHLY) are born with `paymentStatus: "PAID"`. The plan payment was collected at plan confirmation time (via wallet debit or cash collection). No second charge occurs for these orders.

---

## Admin Endpoints

### 1. List Orders

```
GET /api/v1/admin/orders
```

**Authentication:** Admin JWT required

**Query Parameters:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| status | OrderStatus enum | No | Filter by order status |
| paymentStatus | PaymentStatus enum | No | Filter by payment status |
| planType | PlanType enum | No | Filter by plan type |
| customerSearch | string | No | Search by customer name/mobile/email |
| orderNumber | string | No | Search by order number |
| startDate | YYYY-MM-DD | No | Orders created on or after |
| endDate | YYYY-MM-DD | No | Orders created on or before |
| page | integer | No | Page number (default 1) |
| limit | integer | No | Items per page (default 20, max 100) |

**Response (200):**

```json
{
  "data": [
    {
      "id": "uuid",
      "orderNumber": "PF10001",
      "planType": "MONTHLY",
      "status": "CONFIRMED",
      "paymentStatus": "PENDING",
      "items": [...],
      "subtotalPaise": 16000,
      "discountPaise": 2000,
      "taxPaise": 0,
      "deliveryFeePaise": 2000,
      "totalPaise": 18000,
      "deliveryDate": "2026-10-06",
      "deliveryStartTime": "08:00",
      "deliveryEndTime": "10:00",
      "addressSnapshot": {...},
      "actualPricePerLitrePaise": 9000,
      "sellingPricePerLitrePaise": 8000,
      "invoice": { "invoiceNumber": "INV-10001", "issuedAt": "..." },
      "completedAt": null,
      "customer": {
        "id": "uuid",
        "mobile": "9999999999",
        "email": "test@example.com",
        "name": "Test User"
      },
      "createdAt": "...",
      "updatedAt": "..."
    }
  ],
  "pagination": { "page": 1, "limit": 20, "total": 1, "totalPages": 1 }
}
```

---

### 2. Get Order Detail

```
GET /api/v1/admin/orders/:id
```

**Authentication:** Admin JWT required

**Response (200):** Full order object with customer info, items, snapshots, invoice, and timestamps.

**Errors:**
- `404` — Order not found

---

### 3. Update Order Status

```
PATCH /api/v1/admin/orders/:id/status
```

**Authentication:** Admin JWT required

**Request Body:**

```json
{
  "status": "CONFIRMED"
}
```

**Validation:**
- `status` must be a valid `OrderStatus` enum value
- The transition must be allowed (see Allowed Transitions table above)
- Invalid transitions receive 400

**Business Rules:**
- Status update does NOT modify pricing, snapshots, or customer identity
- Only operational status changes — no financial modifications

**Response (200):**

```json
{
  "success": true,
  "message": "Order status updated to CONFIRMED.",
  "order": { ... }
}
```

**Errors:**
- `400` — Invalid status transition
- `404` — Order not found

**Note:** `{"status": "COMPLETED"}` on this endpoint is routed internally to the
dedicated completion path below, so its eligibility rules cannot be bypassed.

---

### 4. Complete Order

```
PATCH /api/v1/admin/orders/:orderId/complete
```

**Authentication:** Admin JWT required

**Request Body:** none. `orderId` must be a UUID (400 otherwise).

**Eligibility:**
- The order must exist
- Its current status must be `DELIVERED`
- If the order is linked to a `PlanDelivery`, that delivery must not be
  `SKIPPED` and its `deliveryDate` must not be in the future

**Business Rules:**
- Writes exactly two columns on one `orders` row: `status` and `completedAt`
- Never writes `PlanDelivery`, `PlanSelection`, `Wallet`, `WalletTransaction`,
  `Payment`, `CashCollection` or `Invoice` records
- Never marks an undelivered order delivered to make completion succeed
- Never creates a replacement order
- Idempotent: completing an already-`COMPLETED` order returns 200 with
  `alreadyCompleted: true` and the original `completedAt`, repeating no side
  effects

**Response (200):**

```json
{
  "success": true,
  "message": "Order marked as completed.",
  "alreadyCompleted": false,
  "order": {
    "id": "uuid",
    "orderNumber": "PF10001",
    "status": "COMPLETED",
    "completedAt": "2026-10-10T07:15:00.000Z",
    "...": "full order object"
  }
}
```

**Errors:**
- `400` — Not a UUID; order not `DELIVERED`; delivery skipped; delivery still in the future
- `401` — Missing or invalid authentication token
- `403` — Customer token on admin endpoint
- `404` — Order not found
- `409` — Order changed concurrently, or a plan order's delivery record is missing

---

## Error Cases

| Code | Meaning |
|------|---------|
| 400 | Invalid request, invalid transition, validation failure |
| 401 | Missing or invalid authentication token |
| 403 | Customer token on admin endpoint |
| 404 | Order not found |
| 409 | Duplicate order for same delivery; concurrent completion conflict |

## Security Rules

- Admin identity always from JWT.sub
- Admin cannot impersonate customers via request body
- Status updates do not alter financial data
- Customer tokens receive 403 on all admin endpoints

## Future Compatibility

- **Product module**: OrderItem.productId is nullable, ready for FK when Product model exists
- **Payment module**: PaymentStatus field on Order is ready; payment logic will not be in Orders
- **Delivery Operations**: Status transitions are compatible with future delivery tracking
