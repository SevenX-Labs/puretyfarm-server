# Scheduler

## Why this exists

A customer who starts a PhonePe Standard Checkout and then closes the tab leaves a
`Payment` row stuck in `PENDING` and the matching `WalletCreditRequest` stuck
in `PENDING`. The one-pending-per-wallet database index then blocks every
future top-up for that customer. The PhonePe browser return and the PhonePe
webhook never fire for an abandoned checkout, so without a timer nothing ever
closes the row.

The scheduler is that timer.

## What it does

```text
                    SCHEDULER
                        │
                  Every 10 min
                        │
                        ↓
          expireStalePayments()
                        │
              ┌─────────┴─────────┐
              │                   │
           Expired              Active
              │                   │
              ↓                   ↓
          CANCEL/RELEASE        Nothing
              │
              ↓
        Customer can retry
```

| Cron | Method called | Owned by |
|------|---------------|----------|
| `*/10 * * * *` | `PaymentsService.expireStalePayments()` | `src/modules/payments/payments.service.ts` |

That method is the only expiry logic. It:

1. Finds every `Payment` whose `status ∈ (PENDING, PROCESSING)` and whose
   `expiresAt < now`.
2. In a transaction, flips each one `PENDING|PROCESSING → EXPIRED` with a
   conditional `updateMany` guarded on the current status.
3. If the payment is tied to a `WalletCreditRequest`, calls
   `WalletService.cancelCreditRequest(..., "Online payment expired before completion")`,
   which releases the one-pending-per-wallet slot.

The conditional updates make the method **idempotent**: a second pass (or
overlap with a late webhook) matches zero rows and credits nothing.

## What it does NOT do

The scheduler is only an automatic timer. It does not own, change, or bypass
any business rule.

- It does **not** approve payments.
- It does **not** credit wallets.
- It does **not** mark a payment successful.
- It does **not** change the first-credit admin-approval rule.
- It does **not** change the subsequent auto-credit rule.
- It does **not** touch cash collections or bypass cash confirmation.
- It does **not** call PhonePe for anything (no verify, no refund).

Those responsibilities stay in the modules that already own them.

## Interaction with wallet credit rules

```text
FIRST ONLINE CREDIT:

Customer
   ↓
PhonePe order COMPLETED
   ↓
Payment SUCCESS
   ↓
WalletCreditRequest PENDING
   ↓
Admin Approve                    ← scheduler is not involved
   ↓
Wallet CREDIT
```

```text
SECOND+ ONLINE CREDIT:

Customer
   ↓
PhonePe order COMPLETED
   ↓
Payment SUCCESS
   ↓
Existing WalletService logic     ← scheduler is not involved
   ↓
Wallet.autoCreditEnabled = true  ← per-wallet flag, not a global env variable
   ↓
Auto Credit
   ↓
Wallet CREDIT
```

```text
ABANDONED PAYMENT (the only case the scheduler acts on):

Customer
   ↓
PhonePe checkout started
   ↓
PENDING
   ↓
Customer leaves
   ↓
No callback / No webhook
   ↓
Scheduler every 10 min
   ↓
expireStalePayments()
   ↓
Expired? → CANCEL/RELEASE
   ↓
Customer can retry
```

```text
CASH (unchanged):

Customer
   ↓
Cash Request
   ↓
Partner collects
   ↓
Admin confirms                   ← scheduler is not involved
   ↓
Wallet CREDIT
```

## Code locations

```text
src/modules/scheduler/
├── jobs/
│   ├── payment-expiry.job.ts         ← the @Cron handler
│   └── payment-expiry.job.spec.ts    ← contract + negative-space tests
└── scheduler.module.ts               ← ScheduleModule.forRoot() + job
```

Registered once in `src/app.module.ts` as `SchedulerModule`.

## Failure handling

The handler wraps `expireStalePayments()` in `try/catch`. Any failure is
logged (class name only, no payload) and swallowed, so a transient database
error does not take down the Nest process. The next scheduled tick picks up
whatever is still stale.

The log never includes any gateway credential, access token, or any
payment payload.

## Future jobs

Belong in the same module as additional `@Injectable()` providers listed in
`SchedulerModule.providers`. Not implemented today:

```text
src/modules/scheduler/jobs/
├── payment-expiry.job.ts         (this task)
├── quote-expiry.job.ts           (future)
├── delivery-processing.job.ts    (future)
└── consistency-check.job.ts      (future)
```
