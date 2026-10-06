# Admin Dashboard API

> **Related docs:**
> - `docs/admin/plans.md` — plan lifecycle
> - `docs/admin/wallet.md` — wallet operations
> - `docs/admin/payments.md` — payment & cash collection

## Endpoint

```
GET /api/v1/admin/dashboard/overview
GET /admin/dashboard/overview
```

**Authentication:** Admin JWT required (`JwtAuthGuard` + `@Roles('ADMIN')`).

## Query Parameters

| Param | Type       | Required | Description                          |
|-------|------------|----------|--------------------------------------|
| from  | ISO date   | No       | Start date (defaults to today)       |
| to    | ISO date   | No       | End date (defaults to today)         |

- `from` must not be greater than `to`.
- Both are inclusive (full day boundaries: 00:00:00.000Z to 23:59:59.999Z).

## Response Structure

```json
{
  "period": { "from": "2026-10-01", "to": "2026-10-06" },
  "customers": { "total", "new", "active", "withActivePlan" },
  "orders": { "total", "pending", "confirmed", "processing", "outForDelivery", "delivered", "cancelled", "failed" },
  "sales": { "totalPaise", "buyOncePaise", "trialPaise", "monthlyPaise" },
  "revenue": { "collectedPaise", "walletPaise", "cashPaise", "buyOncePaise", "trialPaise", "monthlyPaise", "walletTopUpsPaise", "pendingCashPaise", "refundsPaise" },
  "plans": { "activeMonthly", "activeTrial", "buyOnceCustomers", "newSelections" },
  "deliveries": { "scheduled", "delivered", "skipped", "cancelled", "failed", "completionPercent" },
  "wallet": { "totalCustomerBalancePaise", "walletTopUpsPaise" },
  "profit": { "salesPaise", "productCostPaise", "deliveryCostPaise", "grossProfitPaise", "grossMarginPercent", "costDataAvailable" },
  "alerts": { "pendingCashCollections", "pendingWalletApprovals", "pendingDeliveryChangeRequests", "failedOrders" },
  "comparison": { "previousPeriod", "customersNewChangePercent", "ordersChangePercent", "salesChangePercent", "revenueChangePercent", "grossProfitChangePercent" },
  "trend": { "daily": [{ "date", "salesPaise", "revenueCollectedPaise", "grossProfitPaise", "orders", "deliveries" }] }
}
```

## Metric Definitions

### Customers
- **total**: All users with `role = CUSTOMER`.
- **new**: Customers created within the selected period.
- **active**: Customers with an ACTIVE plan selection OR a qualifying (non-cancelled, non-failed) order in the period.
- **withActivePlan**: Distinct customers with `PlanSelection.status = ACTIVE`.

### Orders
All counts filtered by `Order.createdAt` within the period, grouped by `OrderStatus` enum values.

### Sales vs Revenue

**Sales** = the value of customer purchases. Source of truth: `PlanSelection.paidAmountPaise` for paid plan selections. This avoids double-counting with prepaid orders (which are created as PAID from already-paid plan selections).

**Revenue** = actual money collected for purchases:
- **walletPaise**: Wallet debits (`WalletTransaction` type=DEBIT) for PLAN_SELECTION + ORDER reference types.
- **cashPaise**: Confirmed `CashCollection` records with a `planSelectionId`.
- **collectedPaise**: walletPaise + cashPaise.

**Wallet top-ups are NOT revenue.** A wallet top-up is customer funding; it becomes revenue only when spent on a purchase.

### Profit
This is a **contribution margin** metric, NOT true Gross Profit or Net Profit.

```
grossProfitPaise = salesPaise - productCostPaise - deliveryCostPaise
grossMarginPercent = salesPaise > 0 ? (grossProfitPaise / salesPaise) * 100 : 0
```

- **productCostPaise**: Always 0. The system stores `actualPricePerLitre` (MRP, not procurement cost). **No actual procurement cost is tracked.** Do not fabricate this value.
- **deliveryCostPaise**: Sum of `Order.deliveryFeePaise` (immutable historical snapshot) for non-cancelled/failed orders in the period.
- **costDataAvailable**: Always `false`. Indicates that `productCostPaise` is unavailable — the `grossProfitPaise` value represents `salesPaise - deliveryCostPaise` only. Frontend should communicate this limitation to the admin.

No operating expenses (salaries, rent, marketing, etc.) are tracked.

### Wallet
- **totalCustomerBalancePaise**: Sum of `Wallet.balancePaise` for users with `role = CUSTOMER` only. This represents customer wallet liability.
- **walletTopUpsPaise**: Wallet CREDIT transactions with `referenceType = CREDIT_REQUEST` in the period. Does not include plan payment debits, order debits, or refund credits.

### Deliveries
Sourced from `PlanDelivery`. The current schema has three statuses: SCHEDULED, DELIVERED, SKIPPED.
`cancelled` and `failed` return 0 (not present in schema).

```
completionPercent = eligible > 0 ? (delivered / eligible) * 100 : 0
```

Where eligible = scheduled + delivered + skipped.

### Alerts
Counts of records requiring admin attention (no date filter — all pending items):
- `pendingCashCollections`: CashCollection status IN (PENDING, COLLECTED)
- `pendingWalletApprovals`: WalletCreditRequest status = PENDING
- `pendingDeliveryChangeRequests`: ManageDeliveryChangeRequest status = PENDING
- `failedOrders`: Order status = FAILED

### Comparison
Previous period has the same duration as the selected period, ending the day before `from`.

Percentage change: `((current - previous) / previous) * 100`, rounded to 2 decimal places.
- If previous = 0 and current = 0: 0%.
- If previous = 0 and current > 0: 100%.

### Trend
One entry per calendar day from `from` to `to`. Missing dates filled with zeros.

## Example Request

```
GET /api/v1/admin/dashboard/overview?from=2026-10-01&to=2026-10-06
Authorization: Bearer <admin-jwt>
```
