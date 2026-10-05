# Customer Plans, Customization & Eligibility API Specification & Postman Testing Guide

This document provides complete, all-in-one documentation for the **Customer Plan Selection, Customization, Pricing Quotes, and Eligibility System** in the PuretyFarm backend.

---

## 1. Overview & Architecture

### Core Modules
- **Plans Module** (`PlansModule`):
  - **Plan Overview & Eligibility**: Dynamic availability resolution based on individual customer order and trial history.
  - **Server-Side Quote Generation**: Calculates delivery occurrences, total litres, actual pricing, selling pricing, and discounts. Prices cannot be supplied or manipulated by the client.
  - **Tamper-Proof Quote Confirmation**: Generates a cryptographically tracked, time-limited (`expiresAt = 30 minutes`) `PlanQuote` snapshot. The client confirms only by providing the server-generated `quoteId`.
  - **Atomic Transactional Confirmation**: Validates ownership, expiry, status, and re-checks eligibility inside a database transaction to prevent double-confirmations and race conditions.

### The 3 PuretyFarm Plans
1. **Buy Once (`BUY_ONCE`)**:
   - Single delivery test order.
   - Quantity: 1 to 5 Litres.
   - Maximum lifetime uses: 7 times (admin-configurable).
   - If used first, the **7-Day Trial becomes unavailable** (`BUY_ONCE_ALREADY_USED`).
2. **7-Day Trial (`SEVEN_DAY_TRIAL`)**:
   - 7 consecutive daily deliveries.
   - Quantity: 1 to 5 Litres per delivery day.
   - Maximum lifetime uses: 1 time.
   - If used first, **Buy Once becomes permanently unavailable** (`TRIAL_ALREADY_USED`).
3. **Monthly Subscription (`MONTHLY`)**:
   - Long-term recurring subscription.
   - Frequency: `DAILY` or `ALTERNATE_DAYS`.
   - Quantity Mode:
     - `FIXED`: Same litres (1 to 5L) every delivery day.
     - `ALTERNATING`: Alternating litres (`quantityA` and `quantityB`, each 1 to 5L) per delivery occurrence.
   - Delivery calculation is tied directly to the **specific calendar month** (28, 29, 30, or 31 days). Never hardcoded to 30 days.

### Eligibility Matrix

| Customer History | Buy Once | 7-Day Trial | Monthly |
|---|---|---|---|
| **New Customer** | Available (up to 7 uses) | Available (1 use) | Available |
| **Took Buy Once First** | Available (remaining uses decrease) | Blocked (`BUY_ONCE_ALREADY_USED`) | Available |
| **Took 7-Day Trial First** | Blocked (`TRIAL_ALREADY_USED`) | Blocked (`TRIAL_ALREADY_USED`) | Available |
| **Took Monthly First** | Blocked (`MONTHLY_ALREADY_USED`) | Blocked (`MONTHLY_ALREADY_USED`) | Available |

---

---

### Money Convention

**All monetary values in requests and responses are INTEGER PAISE** (never rupees, never floats).

| Rupees | Paise |
|--------|-------|
| ₹1 | `100` |
| ₹85 | `8500` |
| ₹95 | `9500` |
| ₹190 | `19000` |
| ₹5,000 | `500000` |

The frontend must divide by 100 only at display time. Any `*PricePerLitre`, `*Amount` or `discountAmount` field is paise.

---

### Base URLs & Dual Routing
All customer plan endpoints support dual routing seamlessly:
- **Prefix A**: `https://api-puretyfarm.onrender.com/api/v1/customer/plans/...`
- **Prefix B**: `https://api-puretyfarm.onrender.com/customer/plans/...`

### Security Standards
- **Authentication**: All endpoints require a valid customer JWT in the header:
  ```text
  Authorization: Bearer <CUSTOMER_ACCESS_TOKEN>
  ```
- **Role Guard**: Enforced by `JwtAuthGuard`; only tokens with `role: "CUSTOMER"` are accepted.
- **IDOR Protection**: Identity is strictly derived from `JWT.sub`. The client never supplies a `userId`. Quotes and confirmations are cryptographically tied to the authenticated user.

---

## 2. API Endpoints Specification

### ────────────────────────────────────────────────────────
### 2.1 Get Plans Overview
### ────────────────────────────────────────────────────────
Fetches all three plans with customer-specific availability flags, remaining uses, and blocked reasons.

- **Method**: `GET`
- **Path**: `/api/v1/customer/plans`
- **Headers**:
  - `Authorization: Bearer <ACCESS_TOKEN>`
- **Request Body**: None
- **Success Response (200 OK) — New Customer**:
  ```json
  {
    "plans": [
      {
        "type": "BUY_ONCE",
        "available": true,
        "usageCount": 0,
        "remainingUses": 7
      },
      {
        "type": "SEVEN_DAY_TRIAL",
        "available": true,
        "used": false
      },
      {
        "type": "MONTHLY",
        "available": true
      }
    ]
  }
  ```
- **Success Response (200 OK) — After Customer Used Buy Once**:
  ```json
  {
    "plans": [
      {
        "type": "BUY_ONCE",
        "available": true,
        "usageCount": 1,
        "remainingUses": 6
      },
      {
        "type": "SEVEN_DAY_TRIAL",
        "available": false,
        "used": false,
        "blockedReason": "BUY_ONCE_ALREADY_USED"
      },
      {
        "type": "MONTHLY",
        "available": true
      }
    ]
  }
  ```
- **Success Response (200 OK) — After Customer Used 7-Day Trial**:
  ```json
  {
    "plans": [
      {
        "type": "BUY_ONCE",
        "available": false,
        "usageCount": 0,
        "remainingUses": 0,
        "blockedReason": "TRIAL_ALREADY_USED"
      },
      {
        "type": "SEVEN_DAY_TRIAL",
        "available": false,
        "used": true,
        "blockedReason": "TRIAL_ALREADY_USED"
      },
      {
        "type": "MONTHLY",
        "available": true
      }
    ]
  }
  ```
- **Error Responses**:
  - `401 Unauthorized`: Missing, invalid, or expired Bearer token.

---

### ────────────────────────────────────────────────────────
### 2.2 Get Buy Once Eligibility
### ────────────────────────────────────────────────────────
Checks detailed eligibility for the Buy Once plan.

- **Method**: `GET`
- **Path**: `/api/v1/customer/plans/buy-once/eligibility`
- **Headers**:
  - `Authorization: Bearer <ACCESS_TOKEN>`
- **Request Body**: None
- **Success Response (200 OK) — Eligible**:
  ```json
  {
    "eligible": true,
    "usageCount": 0,
    "remainingUses": 7,
    "maxUses": 7,
    "maxQuantityLitres": 5
  }
  ```
- **Success Response (200 OK) — Ineligible (Trial Already Used)**:
  ```json
  {
    "eligible": false,
    "usageCount": 0,
    "remainingUses": 0,
    "maxUses": 7,
    "blockedReason": "TRIAL_ALREADY_USED"
  }
  ```
- **Success Response (200 OK) — Ineligible (Max Uses Reached)**:
  ```json
  {
    "eligible": false,
    "usageCount": 7,
    "remainingUses": 0,
    "maxUses": 7,
    "maxQuantityLitres": 5,
    "blockedReason": "MAX_USES_REACHED"
  }
  ```

---

### ────────────────────────────────────────────────────────
### 2.3 Create Buy Once Quote
### ────────────────────────────────────────────────────────
Requests a server-calculated pricing quote for a single-bottle test order.

- **Method**: `POST`
- **Path**: `/api/v1/customer/plans/buy-once/quote`
- **Headers**:
  - `Authorization: Bearer <ACCESS_TOKEN>`
  - `Content-Type: application/json`
- **Request Body**:
  ```json
  {
    "quantityLitres": 2
  }
  ```
- **Body Attributes**:
  - `quantityLitres` (Integer, Required): Whole number between `1` and `5`.
- **Success Response (200 OK)**:
  ```json
  {
    "quoteId": "b2e1f480-1a23-4c56-9d8e-0f1a2b3c4d5e",
    "plan": "BUY_ONCE",
    "quantity": 2,
    "deliveryOccurrences": 1,
    "actualPricePerLitre": 9500,
    "sellingPricePerLitre": 8500,
    "totalLitres": 2,
    "totalActualAmount": 19000,
    "totalSellingAmount": 17000,
    "discountAmount": 2000,
    "expiresAt": "2026-10-04T18:15:30.000Z"
  }
  ```
- **Error Responses**:
  - `400 Bad Request`: Invalid quantity (e.g. 0, 6, decimal value).
    ```json
    {
      "statusCode": 400,
      "message": ["quantityLitres must be at most 5"],
      "error": "Bad Request"
    }
    ```
  - `403 Forbidden`: Customer is ineligible (trial already used or max uses reached).
    ```json
    {
      "statusCode": 403,
      "message": "Buy Once is not available: TRIAL_ALREADY_USED",
      "error": "Forbidden"
    }
    ```

---

### ────────────────────────────────────────────────────────
### 2.4 Get 7-Day Trial Eligibility
### ────────────────────────────────────────────────────────
Checks detailed eligibility for the 7-Day Trial plan.

- **Method**: `GET`
- **Path**: `/api/v1/customer/plans/trial/eligibility`
- **Headers**:
  - `Authorization: Bearer <ACCESS_TOKEN>`
- **Request Body**: None
- **Success Response (200 OK) — Eligible**:
  ```json
  {
    "eligible": true,
    "used": false,
    "trialDurationDays": 7,
    "maxQuantityLitres": 5
  }
  ```
- **Success Response (200 OK) — Ineligible (Buy Once Already Used)**:
  ```json
  {
    "eligible": false,
    "used": false,
    "trialDurationDays": 7,
    "maxQuantityLitres": 5,
    "blockedReason": "BUY_ONCE_ALREADY_USED"
  }
  ```
- **Success Response (200 OK) — Ineligible (Trial Already Used)**:
  ```json
  {
    "eligible": false,
    "used": true,
    "trialDurationDays": 7,
    "maxQuantityLitres": 5,
    "blockedReason": "TRIAL_ALREADY_USED"
  }
  ```

---

### ────────────────────────────────────────────────────────
### 2.5 Create 7-Day Trial Quote
### ────────────────────────────────────────────────────────
Requests a server-calculated pricing quote for 7 consecutive deliveries.

- **Method**: `POST`
- **Path**: `/api/v1/customer/plans/trial/quote`
- **Headers**:
  - `Authorization: Bearer <ACCESS_TOKEN>`
  - `Content-Type: application/json`
- **Request Body**:
  ```json
  {
    "quantityLitres": 1
  }
  ```
- **Body Attributes**:
  - `quantityLitres` (Integer, Required): Litres per delivery day, whole number between `1` and `5`.
- **Success Response (200 OK)**:
  ```json
  {
    "quoteId": "c3f2a591-2b34-5d67-ae9f-1a2b3c4d5e6f",
    "plan": "SEVEN_DAY_TRIAL",
    "quantity": 1,
    "durationDays": 7,
    "deliveryOccurrences": 7,
    "actualPricePerLitre": 9500,
    "sellingPricePerLitre": 7500,
    "totalLitres": 7,
    "totalActualAmount": 66500,
    "totalSellingAmount": 52500,
    "discountAmount": 14000,
    "expiresAt": "2026-10-04T18:15:30.000Z"
  }
  ```
- **Error Responses**:
  - `400 Bad Request`: Litre quantity out of range (not 1–5).
  - `403 Forbidden`: Buy Once already used or Trial already used.
    ```json
    {
      "statusCode": 403,
      "message": "7-Day Trial is not available: BUY_ONCE_ALREADY_USED",
      "error": "Forbidden"
    }
    ```

---

### ────────────────────────────────────────────────────────
### 2.6 Get Monthly Plan Configuration Info
### ────────────────────────────────────────────────────────
Returns the available configuration parameters, frequencies, modes, and admin-set pricing per litre for Monthly subscriptions.

- **Method**: `GET`
- **Path**: `/api/v1/customer/plans/monthly`
- **Headers**:
  - `Authorization: Bearer <ACCESS_TOKEN>`
- **Request Body**: None
- **Success Response (200 OK)**:
  ```json
  {
    "available": true,
    "frequencies": [
      "DAILY",
      "ALTERNATE_DAYS"
    ],
    "quantityModes": [
      "FIXED",
      "ALTERNATING"
    ],
    "quantityMin": 1,
    "quantityMax": 5,
    "actualPricePerLitre": 9000,
    "sellingPricePerLitre": 8000
  }
  ```

---

### ────────────────────────────────────────────────────────
### 2.7 Create Monthly Plan Quote
### ────────────────────────────────────────────────────────
Calculates a monthly subscription quote dynamically based on the current calendar month.

- **Method**: `POST`
- **Path**: `/api/v1/customer/plans/monthly/quote`
- **Headers**:
  - `Authorization: Bearer <ACCESS_TOKEN>`
  - `Content-Type: application/json`

#### Mode A: DAILY + FIXED
Delivers the same quantity every day of the month.
- **Request Body**:
  ```json
  {
    "frequency": "DAILY",
    "quantityMode": "FIXED",
    "quantity": 2
  }
  ```
- **Success Response (200 OK — In a 31-day month)**:
  ```json
  {
    "quoteId": "d4a3b602-3c45-6e78-bf0a-2b3c4d5e6f7a",
    "plan": "MONTHLY",
    "frequency": "DAILY",
    "quantityMode": "FIXED",
    "quantity": 2,
    "deliveryOccurrences": 31,
    "actualPricePerLitre": 9000,
    "sellingPricePerLitre": 8000,
    "totalLitres": 62,
    "totalActualAmount": 558000,
    "totalSellingAmount": 496000,
    "discountAmount": 62000,
    "expiresAt": "2026-10-04T18:15:30.000Z"
  }
  ```

#### Mode B: ALTERNATE_DAYS + ALTERNATING
Delivers every alternate day with alternating quantities: $Q_A$ on delivery 1, $Q_B$ on delivery 2, $Q_A$ on delivery 3, etc.
- **Request Body**:
  ```json
  {
    "frequency": "ALTERNATE_DAYS",
    "quantityMode": "ALTERNATING",
    "quantityA": 1,
    "quantityB": 3
  }
  ```
- **Success Response (200 OK — In a 31-day month)**:
  ```json
  {
    "quoteId": "e5b4c713-4d56-7f89-c01b-3c4d5e6f7a8b",
    "plan": "MONTHLY",
    "frequency": "ALTERNATE_DAYS",
    "quantityMode": "ALTERNATING",
    "quantityA": 1,
    "quantityB": 3,
    "deliveryOccurrences": 16,
    "actualPricePerLitre": 9000,
    "sellingPricePerLitre": 8000,
    "totalLitres": 32,
    "totalActualAmount": 288000,
    "totalSellingAmount": 256000,
    "discountAmount": 32000,
    "expiresAt": "2026-10-04T18:15:30.000Z"
  }
  ```
  *(Calculation breakdown: In a 31-day month with alternate deliveries, there are $\lceil 31 / 2 \rceil = 16$ deliveries. $Q_A$ applies 8 times and $Q_B$ applies 8 times: $8 \times 1 + 8 \times 3 = 32$ Litres).*

- **Body Attributes**:
  - `frequency` (String, Required): `"DAILY"` or `"ALTERNATE_DAYS"`.
  - `quantityMode` (String, Required): `"FIXED"` or `"ALTERNATING"`.
  - `quantity` (Integer, Required for `FIXED`): 1 to 5.
  - `quantityA` (Integer, Required for `ALTERNATING`): 1 to 5.
  - `quantityB` (Integer, Required for `ALTERNATING`): 1 to 5.

- **Error Responses**:
  - `400 Bad Request` — Missing field for mode:
    ```json
    {
      "statusCode": 400,
      "message": ["quantity is required for FIXED mode"],
      "error": "Bad Request"
    }
    ```
  - `400 Bad Request` — Out-of-range quantity:
    ```json
    {
      "statusCode": 400,
      "message": ["quantityA must be at least 1"],
      "error": "Bad Request"
    }
    ```

---

### ────────────────────────────────────────────────────────
### 2.8 Confirm Plan Quote
### ────────────────────────────────────────────────────────
Atomically confirms a valid server-generated quote. This locks the plan selection and transitions the quote status from `PENDING` to `CONFIRMED`.

- **Method**: `POST`
- **Path**: `/api/v1/customer/plans/confirm`
- **Headers**:
  - `Authorization: Bearer <ACCESS_TOKEN>`
  - `Content-Type: application/json`
- **Request Body**:
  ```json
  {
    "quoteId": "b2e1f480-1a23-4c56-9d8e-0f1a2b3c4d5e"
  }
  ```
- **Body Attributes**:
  - `quoteId` (UUID v4, Required): The exact `quoteId` returned by any of the quote endpoints.
- **Success Response (200 OK)**:
  ```json
  {
    "selectionId": "f6c5d824-5e67-8a90-d12c-4d5e6f7a8b9c",
    "quoteId": "b2e1f480-1a23-4c56-9d8e-0f1a2b3c4d5e",
    "plan": "BUY_ONCE",
    "status": "CONFIRMED"
  }
  ```
- **Error Responses**:
  - `400 Bad Request` — Quote expired:
    ```json
    {
      "statusCode": 400,
      "message": "Quote has expired",
      "error": "Bad Request"
    }
    ```
  - `400 Bad Request` — Already confirmed (tamper / duplicate attempt):
    ```json
    {
      "statusCode": 400,
      "message": "Quote is no longer pending (status: CONFIRMED)",
      "error": "Bad Request"
    }
    ```
  - `404 Not Found` — Quote does not exist or belongs to another user (IDOR protection):
    ```json
    {
      "statusCode": 404,
      "message": "Quote not found",
      "error": "Not Found"
    }
    ```
  - `403 Forbidden` — Eligibility changed between quote creation and confirmation:
    ```json
    {
      "statusCode": 403,
      "message": "Buy Once is no longer available",
      "error": "Forbidden"
    }
    ```

---

## 3. Step-by-Step Testing & cURL Workflow

Follow this complete sequential flow to test all features in terminal or Postman.

### STEP 1: Set Customer Access Token

Export your authenticated customer Bearer token:
```bash
export TOKEN="YOUR_CUSTOMER_JWT_ACCESS_TOKEN"
export BASE_URL="https://api-puretyfarm.onrender.com/api/v1/customer/plans"
```

---

### STEP 2: View Initial Plans Overview (New Customer)

```bash
curl -i -X GET "$BASE_URL" \
  -H "Authorization: Bearer $TOKEN"
```
**Expected Response**: `200 OK` showing all 3 plans available (`BUY_ONCE`, `SEVEN_DAY_TRIAL`, `MONTHLY`).

---

### STEP 3: Check Buy Once Eligibility

```bash
curl -i -X GET "$BASE_URL/buy-once/eligibility" \
  -H "Authorization: Bearer $TOKEN"
```
**Expected Response**: `200 OK` with `"eligible": true`, `"usageCount": 0`, `"remainingUses": 7`.

---

### STEP 4: Request Buy Once Quote (2 Litres)

```bash
curl -i -X POST "$BASE_URL/buy-once/quote" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "quantityLitres": 2
  }'
```
**Expected Response**: `200 OK` returning a JSON object with `quoteId` and server-calculated amounts.

Save the `quoteId` from the response:
```bash
export BUY_ONCE_QUOTE_ID="<COPIED_QUOTE_ID>"
```

---

### STEP 5: Confirm Buy Once Plan

```bash
curl -i -X POST "$BASE_URL/confirm" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"quoteId\": \"$BUY_ONCE_QUOTE_ID\"}"
```
**Expected Response**: `200 OK` with `"status": "CONFIRMED"` and a new `selectionId`.

---

### STEP 6: Verify 7-Day Trial is Now Ineligible

Check the plans overview again:
```bash
curl -i -X GET "$BASE_URL" \
  -H "Authorization: Bearer $TOKEN"
```
**Expected Response**:
- `BUY_ONCE`: `"available": true`, `"usageCount": 1`, `"remainingUses": 6`
- `SEVEN_DAY_TRIAL`: `"available": false`, `"blockedReason": "BUY_ONCE_ALREADY_USED"`
- `MONTHLY`: `"available": true`

Verify via Trial Eligibility endpoint:
```bash
curl -i -X GET "$BASE_URL/trial/eligibility" \
  -H "Authorization: Bearer $TOKEN"
```
**Expected Response**: `200 OK` with `"eligible": false` and `"blockedReason": "BUY_ONCE_ALREADY_USED"`.

---

### STEP 7: Attempting to Quote 7-Day Trial is Blocked

```bash
curl -i -X POST "$BASE_URL/trial/quote" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "quantityLitres": 1
  }'
```
**Expected Response**: `403 Forbidden` (`"message": "7-Day Trial is not available: BUY_ONCE_ALREADY_USED"`).

---

### STEP 8: Fetch Monthly Plan Configuration

```bash
curl -i -X GET "$BASE_URL/monthly" \
  -H "Authorization: Bearer $TOKEN"
```
**Expected Response**: `200 OK` with `frequencies`, `quantityModes`, `quantityMin`, `quantityMax`, and pricing per litre.

---

### STEP 9: Generate Monthly Quote (Daily + Fixed 2L)

```bash
curl -i -X POST "$BASE_URL/monthly/quote" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "frequency": "DAILY",
    "quantityMode": "FIXED",
    "quantity": 2
  }'
```
**Expected Response**: `200 OK` with monthly quote details based on the current calendar month.

---

### STEP 10: Generate Monthly Quote (Alternate Days + Alternating 1L / 3L)

```bash
curl -i -X POST "$BASE_URL/monthly/quote" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "frequency": "ALTERNATE_DAYS",
    "quantityMode": "ALTERNATING",
    "quantityA": 1,
    "quantityB": 3
  }'
```
**Expected Response**: `200 OK` with `deliveryOccurrences` calculated as $\lceil\text{days}/2\rceil$ and total litres alternating correctly.

Save this `quoteId`:
```bash
export MONTHLY_QUOTE_ID="<COPIED_QUOTE_ID>"
```

---

### STEP 11: Confirm Monthly Plan

```bash
curl -i -X POST "$BASE_URL/confirm" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"quoteId\": \"$MONTHLY_QUOTE_ID\"}"
```
**Expected Response**: `200 OK` with `"status": "CONFIRMED"` and a `selectionId`.

---

### STEP 12: Verify Idempotency & Double Confirmation Rejection

Try confirming the exact same `MONTHLY_QUOTE_ID` again:
```bash
curl -i -X POST "$BASE_URL/confirm" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"quoteId\": \"$MONTHLY_QUOTE_ID\"}"
```
**Expected Response**: `400 Bad Request` (`Quote is no longer pending (status: CONFIRMED)`).

---

## 3B. Confirmed plan → payment & wallet behaviour

Confirming a plan produces a `PlanSelection`. Charging the customer and
crediting their wallet happens through the Payment and Wallet modules, not the
Plans module. In particular:

- **Wallet top-ups** needed to pay for a plan go through
  `POST /api/v1/customer/payments/create` (see `docs/customer/payments.md`).
- **First wallet credit** always requires admin approval, regardless of plan
  type. Subsequent verified online credits auto-credit per the customer's
  `Wallet.autoCreditEnabled` flag (see `docs/customer/wallet.md` §3).
- **Order payment** flow is implemented separately when an order is created
  from the confirmed `PlanSelection`.

Nothing in the Plans module can bypass the wallet first-credit admin-approval
rule or the PayU hash-verification gate.

---

## 4. Summary of Status Codes & Error Formats

| Status Code | Meaning | Typical Trigger |
|---|---|---|
| `200 OK` | Success | Successful read, quote calculation, or confirmation. |
| `400 Bad Request` | Validation Error | Quantity out of bounds (< 1 or > 5), non-integer quantity, missing mode fields, malformed UUID, quote expired, quote already confirmed. |
| `401 Unauthorized` | Auth Failure | Missing, expired, or invalid Bearer JWT token. |
| `403 Forbidden` | Business Rule Blocked | Customer ineligible for plan (e.g. Trial requested after Buy Once used, Buy Once requested after Trial used, maximum Buy Once limit reached). |
| `404 Not Found` | Resource Missing | Quote does not exist, or quote belongs to another customer (IDOR prevention). |
