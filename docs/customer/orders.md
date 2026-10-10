# Customer Orders API

## Overview

The Orders module handles order creation from plan deliveries, order listing, reordering, and invoice access. Each scheduled PlanDelivery can generate one Order containing one or more OrderItems with immutable price/address/delivery-time snapshots.

## Authentication

All endpoints require a valid **Customer JWT** (`Authorization: Bearer <token>`). Customer identity is always derived from `JWT.sub` — the request body never supplies a userId.

## Order Concepts

| Concept | Description |
|---------|-------------|
| **Order** | A single customer order/transaction linked to a PlanDelivery |
| **OrderItem** | One product line within an Order (supports multiple products) |
| **Invoice** | Immutable financial document generated alongside each Order |
| **PlanDelivery** | A scheduled delivery from the customer's active plan |

## Order Lifecycle

```
PENDING → CONFIRMED → PROCESSING → OUT_FOR_DELIVERY → DELIVERED → COMPLETED
   ↓          ↓            ↓
CANCELLED  CANCELLED   CANCELLED / FAILED
```

`COMPLETED` is the terminal status an admin sets once a delivered order is
closed out. Completed orders expose a `completedAt` timestamp; every other
status returns `completedAt: null`.

Customers cannot change order status — including completion. Status is managed
by Admin and the server's persisted value is the only source of truth.

## Supported Plan Types

- **BUY_ONCE** — Single purchase order
- **SEVEN_DAY_TRIAL** — Each of 7 delivery days generates an individual order
- **MONTHLY** — Each scheduled delivery generates an individual order

## Multi-Product Order Structure

```
Order
  ├── OrderItem → Product A (quantity, unit price, discount, tax, total)
  ├── OrderItem → Product B
  └── ...
```

Each OrderItem stores an immutable `productNameSnapshot` and `unitPricePaise` at creation time.

## Price Snapshot Rules

All monetary values are stored as **integer paise** (₹1 = 100 paise). When an order is created:

- `actualPricePerLitrePaise` and `sellingPricePerLitrePaise` are snapshotted from the current PlanConfig
- Each OrderItem stores `unitPricePaise`, `discountPaise`, `taxPaise`, `totalPaise`
- The Order stores `subtotalPaise`, `discountPaise`, `taxPaise`, `deliveryFeePaise`, `totalPaise`

Old orders **never** change when Admin updates pricing.

## Delivery Fee Rules

Delivery fee is **Admin-controlled** via PlanConfig (`deliveryFeePaise`). The customer cannot submit or override it. The backend reads the current fee at order creation and snapshots it.

## Delivery Time Rules

Delivery window (`deliveryStartTime`, `deliveryEndTime`) is **Admin-controlled** via PlanConfig. Snapshotted onto the Order at creation time. Format: `HH:MM` (24h); clients render it as 12h AM/PM.

`deliveryEndTime` doubles as the daily cut-off. A plan confirmed — or an order
reordered — after today's window has closed is scheduled for the next day, so a
customer ordering at 12:00 against an `06:00`–`11:00` window gets tomorrow's
delivery, not a slot that has already passed.

## Address Snapshot Rules

The customer's delivery address is snapshotted as JSON at order creation. If the customer later changes their address, existing orders retain the original address.

## Reorder Rules

- Only **DELIVERED** and **COMPLETED** orders are eligible for reorder
- Uses **current** Admin pricing, delivery fee, and delivery time (not historical)
- Creates a completely new Order; the original remains unchanged
- Stores `reorderedFromOrderId` referencing the original

## Invoice Rules

- Each Order has one Invoice created at the same time
- Invoice stores an immutable `financialSnapshot` and `addressSnapshot`
- Invoice numbers are unique (format: `INV-10001`)

---

## Customer Endpoints

### 1. List Orders

```
GET /api/v1/customer/orders
```

**Authentication:** Customer JWT required

**Query Parameters:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| status | OrderStatus enum | No | Filter by order status |
| planType | PlanType enum | No | Filter by plan type |
| startDate | YYYY-MM-DD | No | Orders created on or after |
| endDate | YYYY-MM-DD | No | Orders created on or before |
| orderNumber | string | No | Search by order number (partial match) |
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
      "status": "DELIVERED",
      "paymentStatus": "PAID",
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
      "invoice": { "invoiceNumber": "INV-10001", "issuedAt": "..." },
      "createdAt": "...",
      "updatedAt": "..."
    }
  ],
  "pagination": { "page": 1, "limit": 20, "total": 1, "totalPages": 1 }
}
```

**Errors:**
- `401` — Missing or invalid token
- `403` — Non-customer role

---

### 2. Get Order

```
GET /api/v1/customer/orders/:id
```

**Authentication:** Customer JWT required

**Response (200):** Single order object (same shape as list item).

**Errors:**
- `401` — Missing or invalid token
- `404` — Order not found or belongs to another customer

---

### 3. Create Order

```
POST /api/v1/customer/orders
```

**Authentication:** Customer JWT required

**Request Body:**

```json
{
  "planDeliveryId": "uuid",
  "addressId": "uuid"
}
```

**Business Logic:**
1. Verifies the PlanDelivery belongs to the customer and is SCHEDULED
2. Verifies no order already exists for this delivery (duplicate prevention)
3. Reads current PlanConfig for pricing, delivery fee, delivery time
4. Snapshots address, prices, delivery configuration
5. Creates Order + OrderItem + Invoice in a transaction

**Response (201):**

```json
{
  "success": true,
  "message": "Order created successfully.",
  "order": { ... }
}
```

**Errors:**
- `400` — Delivery not found, not scheduled, address not found, plan inactive
- `409` — Order already exists for this delivery

---

### 4. Reorder

```
POST /api/v1/customer/orders/:id/reorder
```

**Authentication:** Customer JWT required

**Request Body:**

```json
{
  "addressId": "uuid"
}
```

**Business Logic:**
1. Verifies original order belongs to customer and is DELIVERED
2. Uses **current** PlanConfig pricing and delivery configuration
3. Creates a new Order with `reorderedFromOrderId` reference
4. Original order remains unchanged

**Response (201):**

```json
{
  "success": true,
  "message": "Reorder created successfully.",
  "order": { ... }
}
```

**Errors:**
- `400` — Order not eligible for reorder, plan no longer active
- `404` — Order not found

---

### 5. Get Invoice

```
GET /api/v1/customer/orders/:id/invoice
```

**Authentication:** Customer JWT required

**Response (200):**

```json
{
  "invoiceNumber": "INV-10001",
  "orderNumber": "PF10001",
  "issuedAt": "2026-10-06T...",
  "financialSnapshot": {
    "subtotalPaise": 16000,
    "deliveryFeePaise": 2000,
    "totalPaise": 18000,
    "items": [...]
  },
  "addressSnapshot": { ... }
}
```

**Errors:**
- `404` — Order or invoice not found

---


---

### 6. Pay for Order

```
POST /api/v1/customer/orders/:orderId/pay
```

**Authentication:** Customer JWT required

**Request Body:**

```json
{
  "paymentMethod": "WALLET"
}
```

**Important: Prepaid plan orders**

Orders generated from prepaid plan deliveries are created with `paymentStatus: "PAID"`. They **cannot** be paid again — attempting to do so returns `409 ORDER_ALREADY_PROCESSED`. This is the expected behaviour for all plan-based deliveries (BUY_ONCE, SEVEN_DAY_TRIAL, MONTHLY).

**Payment Methods:**

| Method | Supported | Behaviour |
|--------|-----------|-----------|
| `WALLET` | Yes | Debits wallet, marks order PAID |
| `CASH` | No | Returns `400 DIRECT_CASH_ORDER_PAYMENT_NOT_SUPPORTED` |

CASH is **not supported** as a direct payment method for orders through this endpoint. Plan deliveries are prepaid at plan confirmation time.

**`WALLET` payment:**
- Synchronously debits the customer's wallet balance by `Order.totalPaise`.
- Atomically updates `Order.paymentStatus = PAID` within the same transaction.
- Creates an immutable `WalletTransaction` ledger row (`type: DEBIT`, `referenceType: ORDER`).

**Response — Wallet (`200 OK`):**
```json
{
  "success": true,
  "orderId": "uuid",
  "paymentMethod": "WALLET",
  "paymentStatus": "PAID",
  "orderStatus": "CONFIRMED"
}
```

**Errors:**
- `400 DIRECT_CASH_ORDER_PAYMENT_NOT_SUPPORTED` — CASH is not a supported order payment method
- `400 INSUFFICIENT_WALLET_BALANCE` — Customer wallet does not have enough balance for order total
- `404 ORDER_NOT_FOUND` — Order does not exist or belongs to another customer
- `409 ORDER_ALREADY_PROCESSED` — Order is already `PAID` (including all prepaid plan orders)

## Security / IDOR Rules

- Customer can only access their own orders, invoices, and reorders
- `userId` is always derived from JWT.sub
- Customer cannot manipulate price, delivery fee, delivery time, or total
- Customer cannot change order status
- Customer cannot access Admin endpoints (403)
