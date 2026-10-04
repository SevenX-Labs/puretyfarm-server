# Admin Customer Management API Specification & Testing Guide

This document provides comprehensive documentation for the **Admin Customer Management System** in the PuretyFarm backend (`src/modules/customers`), covering architecture, security enforcement, data sources, endpoint specifications, request/response payloads, and a step-by-step Postman/cURL testing guide.

---

## 1. Overview & Architecture

### Core Architecture
- **Unified Module Location**: Located at `src/modules/customers/` (`customers.module.ts`, `customers.controller.ts`, `customers.service.ts`, `dto/query-customers.dto.ts`).
- **Customer Source of Truth**: Customers are records in the central `User` model where `role = CUSTOMER`. There is no separate `Customer` or `AdminCustomer` database table.
- **Profile Optionality (Left-Join Semantics)**: A customer account exists as soon as authentication/registration occurs. A customer appears in Admin Customer Management even if they have not yet created a `CustomerProfile`.
  - Customers with a profile include formatted profile details and signed avatar URLs.
  - Customers without a profile return `"profile": null`.
- **Lightweight List Queries**:
  - The customer list uses Prisma `_count` aggregation for `addresses` and `planSelections`.
  - Heavy arrays (full address history, deliveries, quotes) are omitted from the list endpoint to ensure fast response times and low memory consumption.
- **Rich Detail Endpoint**:
  - The customer detail endpoint (`GET /admin/customers/:id`) returns the customer's full profile, saved addresses (`CustomerAddress[]`), and active/historical plan selections (`PlanSelection[]`).
- **Private Avatar Handling**:
  - Customer avatars are stored in private Supabase bucket storage.
  - Internal storage paths (`profileImagePath`) are strictly hidden.
  - Signed temporary URLs (`profileImageUrl`, 1-hour expiry) are dynamically generated via the reused `ProfileStorageService`.

### Base URLs & Dual Routing
All admin customer management endpoints support dual routing prefixes:
- **Prefix A (Versioned)**: `http://localhost:3000/api/v1/admin/customers`
- **Prefix B (Direct)**: `http://localhost:3000/admin/customers`

### Admin Authorization & RBAC
- **Strict Role Enforcement**: All endpoints require:
  - `@UseGuards(JwtAuthGuard)`
  - `@Roles('ADMIN')`
- **Identity from JWT**: Admin identity is derived exclusively from the verified JWT payload (`sub = admin.id`, `role = ADMIN`). Clients cannot supply or override an `adminId`.
- **403 Forbidden for Non-Admins**: Any token presenting `role: "CUSTOMER"` (or any non-admin role) is rejected immediately with `403 Forbidden`.
- **Zero Exposure of Sensitive Data**:
  - `passwordHash`, `refreshTokenHash`, internal sessions, OTPs, and private storage paths are completely omitted from API responses.

---

## 2. Database Models & Relations

Customer management leverages existing Prisma relations rooted at `User`:

```prisma
model User {
  id              String           @id @default(uuid())
  mobile          String           @unique
  email           String?          @unique
  emailVerified   Boolean          @default(false)
  role            Role             @default(CUSTOMER)
  createdAt       DateTime         @default(now())
  updatedAt       DateTime         @updatedAt
  sessions        Session[]
  customerProfile CustomerProfile?
  addresses       CustomerAddress[]
  planQuotes      PlanQuote[]
  planSelections  PlanSelection[]
  planDeliveries  PlanDelivery[]

  @@map("users")
}

model CustomerProfile {
  id               String   @id @default(uuid())
  userId           String   @unique
  firstName        String
  lastName         String
  gender           Gender
  dateOfBirth      DateTime
  profileImagePath String?
  createdAt        DateTime @default(now())
  updatedAt        DateTime @updatedAt
  user             User     @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@map("customer_profiles")
}
```

---

## 3. Endpoint Specifications

### 3.1 List Customers with Pagination & Search

Retrieves a paginated list of all customer accounts (`role = CUSTOMER`), with profile summary, address/plan counts, and multi-field search.

- **Method**: `GET`
- **Paths**:
  - `/api/v1/admin/customers`
  - `/admin/customers`
- **Headers**:
  - `Authorization: Bearer <ADMIN_ACCESS_TOKEN>`

#### Query Parameters

| Parameter | Type | Required | Default | Safe Limits | Description |
|---|---|---|---|---|---|
| `page` | Integer | No | `1` | Min: `1` | Page number to retrieve |
| `limit` | Integer | No | `20` | Min: `1`, Max: `100` | Number of customers per page |
| `search` | String | No | `undefined` | - | Case-insensitive search string |

#### Search Capabilities
The `search` query parameter dynamically searches across:
- `mobile` (exact or partial match)
- `email` (case-insensitive partial match)
- `customerProfile.firstName` (case-insensitive partial match)
- `customerProfile.lastName` (case-insensitive partial match)
- Multi-word strings (e.g. `"Sahil Hode"` matches combined `firstName` and `lastName`)

#### Success Response (`200 OK`)
```json
{
  "data": [
    {
      "id": "c7a8b412-2f3b-4ce4-8cb8-ef71bc9d4001",
      "mobile": "+919876543210",
      "email": "customer@example.com",
      "emailVerified": true,
      "createdAt": "2026-03-01T10:00:00.000Z",
      "updatedAt": "2026-03-02T12:00:00.000Z",
      "profile": {
        "id": "p8b7c612-4f3b-4ce4-8cb8-ef71bc9d4002",
        "firstName": "Sahil",
        "lastName": "Hode",
        "gender": "MALE",
        "dateOfBirth": "1995-05-15",
        "profileImageUrl": "https://<supabase-url>/storage/v1/object/sign/uploads/avatars/customers/user-1.jpg?token=..."
      },
      "counts": {
        "addresses": 2,
        "planSelections": 1
      }
    },
    {
      "id": "d1a2b3c4-5e6f-7a8b-9c0d-1e2f3a4b5c6d",
      "mobile": "+919812345678",
      "email": null,
      "emailVerified": false,
      "createdAt": "2026-03-03T15:30:00.000Z",
      "updatedAt": "2026-03-03T15:30:00.000Z",
      "profile": null,
      "counts": {
        "addresses": 0,
        "planSelections": 0
      }
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 2,
    "totalPages": 1
  }
}
```

---

### 3.2 Get Customer Details by ID

Retrieves complete information for a specific customer by their `User` ID, including profile data, saved addresses, and all plan selections.

- **Method**: `GET`
- **Paths**:
  - `/api/v1/admin/customers/:id`
  - `/admin/customers/:id`
- **Headers**:
  - `Authorization: Bearer <ADMIN_ACCESS_TOKEN>`
- **Path Parameter**:
  - `id`: UUID of the customer user.

#### Access Control & Verification
- Verifies `User.id == :id` AND `User.role == CUSTOMER`.
- If the ID does not exist OR belongs to an Admin / non-customer user, returns `404 Not Found`.

#### Success Response (`200 OK`)
```json
{
  "id": "c7a8b412-2f3b-4ce4-8cb8-ef71bc9d4001",
  "mobile": "+919876543210",
  "email": "customer@example.com",
  "emailVerified": true,
  "createdAt": "2026-03-01T10:00:00.000Z",
  "updatedAt": "2026-03-02T12:00:00.000Z",
  "profile": {
    "id": "p8b7c612-4f3b-4ce4-8cb8-ef71bc9d4002",
    "firstName": "Sahil",
    "lastName": "Hode",
    "gender": "MALE",
    "dateOfBirth": "1995-05-15",
    "profileImageUrl": "https://<supabase-url>/storage/v1/object/sign/uploads/avatars/customers/user-1.jpg?token=...",
    "createdAt": "2026-03-01T10:05:00.000Z",
    "updatedAt": "2026-03-01T10:05:00.000Z"
  },
  "addresses": [
    {
      "id": "a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d",
      "userId": "c7a8b412-2f3b-4ce4-8cb8-ef71bc9d4001",
      "fullName": "Sahil Hode",
      "mobile": "+919876543210",
      "houseNumber": "Flat 402",
      "buildingName": "Green Valley Towers",
      "streetName": "Baner Road",
      "landmark": "Near Westend Mall",
      "stateId": "s1a2b3c4-e5f6-7a8b-9c0d-1e2f3a4b5c6d",
      "cityId": "c1a2b3c4-e5f6-7a8b-9c0d-1e2f3a4b5c6d",
      "areaId": "r1a2b3c4-e5f6-7a8b-9c0d-1e2f3a4b5c6d",
      "state": "Maharashtra",
      "city": "Pune",
      "area": "Baner",
      "pincode": "411045",
      "latitude": 18.5597,
      "longitude": 73.7799,
      "createdAt": "2026-03-01T10:10:00.000Z",
      "updatedAt": "2026-03-01T10:10:00.000Z"
    }
  ],
  "plans": [
    {
      "id": "pl1a2b3c-4d5e-6f7a-8b9c-0d1e2f3a4b5c",
      "planType": "MONTHLY",
      "status": "CONFIRMED",
      "frequency": "DAILY",
      "quantity": 2,
      "quantityMode": "FIXED",
      "quantityA": null,
      "quantityB": null,
      "startDate": "2026-03-05T00:00:00.000Z",
      "endDate": "2026-04-04T00:00:00.000Z",
      "createdAt": "2026-03-01T11:00:00.000Z",
      "updatedAt": "2026-03-01T11:00:00.000Z"
    }
  ]
}
```

---

## 4. Step-by-Step Postman / cURL Testing Guide

### STEP 1: Admin Login (Obtain Admin JWT)

Login with admin credentials to receive an access token:

```bash
curl -i -X POST http://localhost:3000/api/v1/auth/admin/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "admin@puretyfarm.com",
    "password": "puretyfarm@2026"
  }'
```

**Response (`200 OK`)**:
```json
{
  "accessToken": "eyJhbGciOi...",
  "refreshToken": "eyJhbGciOi...",
  "admin": {
    "id": "a9f8b7c6-...",
    "email": "admin@puretyfarm.com",
    "role": "ADMIN"
  }
}
```

Export the token in your terminal:
```bash
export ADMIN_TOKEN="<COPIED_ACCESS_TOKEN>"
```

---

### STEP 2: List Customers (Default Pagination)

Fetch customers using default parameters (`page=1`, `limit=20`):

```bash
curl -i -X GET "http://localhost:3000/api/v1/admin/customers" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

**Expected Response**: `200 OK` returning `{ "data": [...], "pagination": { "page": 1, "limit": 20, ... } }`.

---

### STEP 3: Search Customers by Name / Mobile / Email

#### By Mobile:
```bash
curl -i -X GET "http://localhost:3000/api/v1/admin/customers?search=9876543210" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

#### By Email:
```bash
curl -i -X GET "http://localhost:3000/api/v1/admin/customers?search=example.com" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

#### By First Name or Last Name:
```bash
curl -i -X GET "http://localhost:3000/api/v1/admin/customers?search=Sahil" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

#### By Full Name:
```bash
curl -i -X GET "http://localhost:3000/api/v1/admin/customers?search=Sahil%20Hode" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

---

### STEP 4: Test Pagination Controls

Request page 2 with 10 records per page:

```bash
curl -i -X GET "http://localhost:3000/api/v1/admin/customers?page=2&limit=10" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

**Validation Limits**:
- Minimum `page` is `1`.
- Minimum `limit` is `1`, Maximum `limit` is `100`.
- Limits exceeding `100` are rejected by validation pipe or safely clamped.

---

### STEP 5: Get Customer Details by ID

Using a customer `User.id` from the list response:

```bash
curl -i -X GET "http://localhost:3000/api/v1/admin/customers/<CUSTOMER_USER_ID>" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

**Expected Response**: `200 OK` returning complete customer profile, saved addresses array, and plan selections array.

---

### STEP 6: Verify RBAC Protection with Customer Token

Attempting to access the admin endpoint with a customer access token:

```bash
curl -i -X GET "http://localhost:3000/api/v1/admin/customers" \
  -H "Authorization: Bearer <CUSTOMER_ACCESS_TOKEN>"
```

**Expected Response (`403 Forbidden`)**:
```json
{
  "statusCode": 403,
  "message": "Access denied for this role",
  "error": "Forbidden"
}
```

---

### STEP 7: Verify Admin ID / Non-Existent ID Returns 404

Attempting to fetch details for an Admin user ID or non-existent ID:

```bash
curl -i -X GET "http://localhost:3000/api/v1/admin/customers/00000000-0000-0000-0000-000000000000" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

**Expected Response (`404 Not Found`)**:
```json
{
  "statusCode": 404,
  "message": "Customer with ID 00000000-0000-0000-0000-000000000000 not found",
  "error": "Not Found"
}
```

---

### STEP 8: Verify Dual Route Prefix

Test the direct `/admin/customers` path without `/api/v1`:

```bash
curl -i -X GET "http://localhost:3000/admin/customers" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

**Expected Response**: `200 OK` matching `/api/v1/admin/customers`.

---

## 5. Status Codes & Error Reference

| Status Code | Meaning | Cause / Scenario |
|---|---|---|
| `200 OK` | Success | Customers listed or customer detail retrieved successfully. |
| `400 Bad Request` | Validation Error | Query parameters fail validation (e.g. `page < 1`, `limit < 1`, `limit > 100`). |
| `401 Unauthorized` | Authentication Missing | Missing, malformed, or expired Bearer token. |
| `403 Forbidden` | Insufficient Permissions | Token role is not `ADMIN` (e.g. `CUSTOMER` JWT). |
| `404 Not Found` | Customer Not Found | Customer ID does not exist or record has a non-customer role (e.g. Admin record). |
