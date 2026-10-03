# Customer Location & Address API Specification & Postman Testing Guide

This document provides complete, all-in-one documentation for both the **Location System** (GPS reverse-geocoding & active catalog hierarchy) and the **Customer Address Management System** in the PuretyFarm backend.

---

## 1. Overview & Architecture

### Core Modules
- **Location Module** (`LocationsModule`):
  - **Reverse Geocoding**: Converts device GPS coordinates (`latitude`, `longitude`) into human-readable locations via Geoapify without persisting anything to the database.
  - **Active Catalog**: Exposes read-only active `State -> City -> Area` hierarchies for manual location selection.
- **Address Module** (`AddressModule`):
  - **Saved Addresses**: Manages saved delivery addresses for authenticated customers.
  - **Authoritative Hierarchy Validation**: Validates that an area belongs to the specified city, the city belongs to the state, and all levels are active.
  - **Snapshot Preservation**: Denormalizes state, city, and area names at write time so future catalog renames do not corrupt historical customer addresses.

### Base URLs & Dual Routing
All endpoints support both versions seamlessly:
- Prefix A: `http://localhost:3000/api/v1/customer/...`
- Prefix B: `http://localhost:3000/customer/...`

### Security Standards
- **Authentication**: All endpoints require a valid customer JWT in the header:
  ```text
  Authorization: Bearer <CUSTOMER_ACCESS_TOKEN>
  ```
- **Role Guard**: Enforced by `JwtAuthGuard`; only `CUSTOMER` tokens are permitted.
- **IDOR Protection**: The customer's identity is derived strictly from `JWT.sub`. Clients can never supply a `userId` to read, update, or delete another user's address.

---

## 2. API Endpoints Specification

### ────────────────────────────────────────────────────────
### PART 1: LOCATION APIS
### ────────────────────────────────────────────────────────

### 2.1 Detect Location from GPS Coordinates
Reverse-geocodes device GPS coordinates using Geoapify. Does not persist to the database.

- **Method**: `POST`
- **Path**: `/api/v1/customer/locations/detect`
- **Headers**:
  - `Authorization: Bearer <ACCESS_TOKEN>`
  - `Content-Type: application/json`
- **Request Body**:
  ```json
  {
    "latitude": 19.0760,
    "longitude": 72.8777
  }
  ```
- **Body Attributes**:
  - `latitude` (Number, Required): Value between `-90` and `90`.
  - `longitude` (Number, Required): Value between `-180` and `180`.
- **Success Response (200 OK)**:
  ```json
  {
    "latitude": 19.0760,
    "longitude": 72.8777,
    "state": "Maharashtra",
    "city": "Mumbai",
    "area": "Bandra West",
    "pincode": "400050",
    "country": "India",
    "formattedAddress": "Bandra West, Mumbai, Maharashtra, 400050, India"
  }
  ```
- **Error Responses**:
  - `400 Bad Request`: Invalid coordinates (out of range or not numbers).
    ```json
    {
      "statusCode": 400,
      "message": ["latitude must be between -90 and 90"],
      "error": "Bad Request"
    }
    ```
  - `503 Service Unavailable`: Upstream Geoapify failure, timeout, or missing API key.
    ```json
    {
      "statusCode": 503,
      "message": "Location service is unavailable",
      "error": "Service Unavailable"
    }
    ```

---

### 2.2 Get Active States
Lists all active states alphabetically.

- **Method**: `GET`
- **Path**: `/api/v1/customer/locations/states`
- **Headers**:
  - `Authorization: Bearer <ACCESS_TOKEN>`
- **Success Response (200 OK)**:
  ```json
  [
    {
      "id": "a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d",
      "name": "Gujarat"
    },
    {
      "id": "e4f5a6b7-c8d9-0e1f-2a3b-4c5d6e7f8a9b",
      "name": "Maharashtra"
    }
  ]
  ```

---

### 2.3 Get Active Cities in a State
Lists all active cities belonging to a specified active state.

- **Method**: `GET`
- **Path**: `/api/v1/customer/locations/states/:stateId/cities`
- **Headers**:
  - `Authorization: Bearer <ACCESS_TOKEN>`
- **Path Parameters**:
  - `stateId` (UUID, Required): ID of the state.
- **Success Response (200 OK)**:
  ```json
  [
    {
      "id": "f1e2d3c4-b5a6-7890-1234-56789abcdef0",
      "name": "Mumbai",
      "stateId": "e4f5a6b7-c8d9-0e1f-2a3b-4c5d6e7f8a9b"
    },
    {
      "id": "b1a2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6e",
      "name": "Pune",
      "stateId": "e4f5a6b7-c8d9-0e1f-2a3b-4c5d6e7f8a9b"
    }
  ]
  ```
- **Error Responses**:
  - `400 Bad Request`: `stateId` is not a valid UUID.
  - `404 Not Found`: State does not exist or is inactive (`{"statusCode": 404, "message": "State not found"}`).

---

### 2.4 Get Active Areas in a City
Lists all active areas and delivery zones belonging to a specified active city.

- **Method**: `GET`
- **Path**: `/api/v1/customer/locations/cities/:cityId/areas`
- **Headers**:
  - `Authorization: Bearer <ACCESS_TOKEN>`
- **Path Parameters**:
  - `cityId` (UUID, Required): ID of the city.
- **Success Response (200 OK)**:
  ```json
  [
    {
      "id": "c1d2e3f4-a5b6-7c8d-9e0f-1a2b3c4d5e6f",
      "name": "Andheri East",
      "cityId": "f1e2d3c4-b5a6-7890-1234-56789abcdef0",
      "pincode": "400069"
    },
    {
      "id": "9a8b7c6d-5e4f-3a2b-1c0d-e1f2a3b4c5d6",
      "name": "Bandra West",
      "cityId": "f1e2d3c4-b5a6-7890-1234-56789abcdef0",
      "pincode": "400050"
    }
  ]
  ```
- **Error Responses**:
  - `400 Bad Request`: `cityId` is not a valid UUID.
  - `404 Not Found`: City does not exist or is inactive (`{"statusCode": 404, "message": "City not found"}`).

---

### ────────────────────────────────────────────────────────
### PART 2: SAVED ADDRESS APIS
### ────────────────────────────────────────────────────────

### 2.5 Create Customer Address
Creates and saves a new delivery address for the authenticated customer.

- **Method**: `POST`
- **Path**: `/api/v1/customer/addresses`
- **Headers**:
  - `Authorization: Bearer <ACCESS_TOKEN>`
  - `Content-Type: application/json`
- **Request Body**:
  ```json
  {
    "fullName": "Sahil Hode",
    "mobile": "+919876543210",
    "houseNumber": "Flat 402, Building A",
    "buildingName": "Green Acres Residency",
    "streetName": "Hill Road",
    "landmark": "Near Mehboob Studio",
    "stateId": "e4f5a6b7-c8d9-0e1f-2a3b-4c5d6e7f8a9b",
    "cityId": "f1e2d3c4-b5a6-7890-1234-56789abcdef0",
    "areaId": "9a8b7c6d-5e4f-3a2b-1c0d-e1f2a3b4c5d6",
    "pincode": "400050",
    "latitude": 19.0544,
    "longitude": 72.8277
  }
  ```
- **Body Attributes**:
  - `fullName` (String, Required): Max 100 characters.
  - `mobile` (String, Required): E.164 phone number format.
  - `houseNumber` (String, Required): Room, flat, house or unit number.
  - `buildingName` (String, Optional): Apartment/society name.
  - `streetName` (String, Optional): Street or road name.
  - `landmark` (String, Optional): Notable physical landmark.
  - `stateId` (UUID, Required): ID of the state.
  - `cityId` (UUID, Required): ID of the city.
  - `areaId` (UUID, Required): ID of the area.
  - `pincode` (String, Optional): 4 to 10 digit postal code. If omitted, automatically defaults to the selected area's catalog pincode.
  - `latitude` (Number, Optional): Float between `-90` and `90` (present when GPS detected).
  - `longitude` (Number, Optional): Float between `-180` and `180` (present when GPS detected).
- **Success Response (201 Created)**:
  ```json
  {
    "id": "7b8c9d0e-1f2a-3b4c-5d6e-7f8a9b0c1d2e",
    "userId": "81fce727-4a0b-4171-be1e-d4c398335be9",
    "fullName": "Sahil Hode",
    "mobile": "+919876543210",
    "houseNumber": "Flat 402, Building A",
    "buildingName": "Green Acres Residency",
    "streetName": "Hill Road",
    "landmark": "Near Mehboob Studio",
    "stateId": "e4f5a6b7-c8d9-0e1f-2a3b-4c5d6e7f8a9b",
    "cityId": "f1e2d3c4-b5a6-7890-1234-56789abcdef0",
    "areaId": "9a8b7c6d-5e4f-3a2b-1c0d-e1f2a3b4c5d6",
    "state": "Maharashtra",
    "city": "Mumbai",
    "area": "Bandra West",
    "pincode": "400050",
    "latitude": 19.0544,
    "longitude": 72.8277,
    "createdAt": "2026-10-03T18:00:00.000Z",
    "updatedAt": "2026-10-03T18:00:00.000Z"
  }
  ```
- **Error Responses**:
  - `400 Bad Request`: Invalid hierarchy selection.
    ```json
    {
      "statusCode": 400,
      "message": "Invalid or inactive State -> City -> Area selection",
      "error": "Bad Request"
    }
    ```

---

### 2.6 Get All Customer Addresses
Retrieves all delivery addresses saved by the authenticated customer, sorted by newest first (`createdAt desc`).

- **Method**: `GET`
- **Path**: `/api/v1/customer/addresses`
- **Headers**:
  - `Authorization: Bearer <ACCESS_TOKEN>`
- **Success Response (200 OK)**:
  ```json
  [
    {
      "id": "7b8c9d0e-1f2a-3b4c-5d6e-7f8a9b0c1d2e",
      "userId": "81fce727-4a0b-4171-be1e-d4c398335be9",
      "fullName": "Sahil Hode",
      "mobile": "+919876543210",
      "houseNumber": "Flat 402, Building A",
      "buildingName": "Green Acres Residency",
      "streetName": "Hill Road",
      "landmark": "Near Mehboob Studio",
      "stateId": "e4f5a6b7-c8d9-0e1f-2a3b-4c5d6e7f8a9b",
      "cityId": "f1e2d3c4-b5a6-7890-1234-56789abcdef0",
      "areaId": "9a8b7c6d-5e4f-3a2b-1c0d-e1f2a3b4c5d6",
      "state": "Maharashtra",
      "city": "Mumbai",
      "area": "Bandra West",
      "pincode": "400050",
      "latitude": 19.0544,
      "longitude": 72.8277,
      "createdAt": "2026-10-03T18:00:00.000Z",
      "updatedAt": "2026-10-03T18:00:00.000Z"
    }
  ]
  ```

---

### 2.7 Get Address by ID
Retrieves a single address. Only the owner can access it.

- **Method**: `GET`
- **Path**: `/api/v1/customer/addresses/:id`
- **Headers**:
  - `Authorization: Bearer <ACCESS_TOKEN>`
- **Path Parameters**:
  - `id` (UUID, Required): Address ID.
- **Success Response (200 OK)**: Returns the single address object.
- **Error Responses**:
  - `400 Bad Request`: `id` is not a valid UUID.
  - `404 Not Found`: Address does not exist or belongs to another user (IDOR prevention).
    ```json
    {
      "statusCode": 404,
      "message": "Address not found",
      "error": "Not Found"
    }
    ```

---

### 2.8 Update Address (Partial Update)
Updates one or more fields on an owned address. If any location foreign key (`stateId`, `cityId`, `areaId`) is passed, the complete merged triple is re-validated against the catalog and name snapshots are updated.

- **Method**: `PATCH`
- **Path**: `/api/v1/customer/addresses/:id`
- **Headers**:
  - `Authorization: Bearer <ACCESS_TOKEN>`
  - `Content-Type: application/json`
- **Request Body (all fields optional)**:
  ```json
  {
    "houseNumber": "Flat 501, 5th Floor",
    "landmark": "Opposite Lilavati Hospital",
    "areaId": "c1d2e3f4-a5b6-7c8d-9e0f-1a2b3c4d5e6f"
  }
  ```
- **Success Response (200 OK)**: Returns the updated address object.
- **Error Responses**:
  - `400 Bad Request`: Invalid partial hierarchy combination or invalid data format.
  - `404 Not Found`: Address not found or not owned by caller.

---

### 2.9 Delete Address
Permanently removes a saved address owned by the authenticated customer.

- **Method**: `DELETE`
- **Path**: `/api/v1/customer/addresses/:id`
- **Headers**:
  - `Authorization: Bearer <ACCESS_TOKEN>`
- **Path Parameters**:
  - `id` (UUID, Required): Address ID to delete.
- **Success Response (204 No Content)**: Empty body.
- **Error Responses**:
  - `404 Not Found`: Address does not exist or not owned by caller.

---

## 3. Step-by-Step Postman & cURL Testing Guide

### Prerequisites
1. **Server Running**: `npm run start:dev`
2. **Postman Environment Setup**:
   - `baseUrl`: `http://localhost:3000`
   - `accessToken`: *(Populated after OTP login)*
   - `stateId`: *(Captured from Step 3)*
   - `cityId`: *(Captured from Step 4)*
   - `areaId`: *(Captured from Step 5)*
   - `addressId`: *(Captured from Step 6)*

---

### STEP 1: Quick Database Seeding (If Location Catalog is Empty)
If your `states`, `cities`, and `areas` tables are currently empty, run this one-line Node script in your terminal to insert sample active locations:

```bash
node -e '
const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();
async function seed() {
  const state = await p.state.upsert({
    where: { name: "Maharashtra" },
    update: {},
    create: { name: "Maharashtra", isActive: true }
  });
  const city = await p.city.upsert({
    where: { stateId_name: { stateId: state.id, name: "Mumbai" } },
    update: {},
    create: { stateId: state.id, name: "Mumbai", isActive: true }
  });
  const area = await p.area.upsert({
    where: { cityId_name: { cityId: city.id, name: "Bandra West" } },
    update: {},
    create: { cityId: city.id, name: "Bandra West", pincode: "400050", isActive: true }
  });
  console.log("Seeded successfully:", { stateId: state.id, cityId: city.id, areaId: area.id });
}
seed().finally(() => p.$disconnect());
'
```

---

### STEP 2: Authenticate Customer & Obtain Access Token

```bash
# 1. Send Login OTP
curl -X POST http://localhost:3000/api/v1/auth/customer/login \
  -H "Content-Type: application/json" \
  -d '{"mobile": "+919876543210"}'

# (Inspect server logs to read the 6-digit dev OTP, e.g. 123456)

# 2. Verify OTP
curl -X POST http://localhost:3000/api/v1/auth/customer/verify-otp \
  -H "Content-Type: application/json" \
  -d '{"mobile": "+919876543210", "otp": "123456"}'
```
Save the returned `accessToken`:
```bash
export TOKEN="<YOUR_ACCESS_TOKEN>"
```

---

### STEP 3: Test GPS Location Detection

```bash
curl -i -X POST http://localhost:3000/api/v1/customer/locations/detect \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "latitude": 19.0760,
    "longitude": 72.8777
  }'
```
**Expected Response**: `200 OK` with normalized city (`Mumbai`), state (`Maharashtra`), country, and formatted address.

---

### STEP 4: Browse Location Hierarchy (State -> City -> Area)

```bash
# A. Get States
curl -i -X GET http://localhost:3000/api/v1/customer/locations/states \
  -H "Authorization: Bearer $TOKEN"

# (Copy a stateId from response, e.g. export STATE_ID="...")

# B. Get Cities for State
curl -i -X GET http://localhost:3000/api/v1/customer/locations/states/$STATE_ID/cities \
  -H "Authorization: Bearer $TOKEN"

# (Copy a cityId from response, e.g. export CITY_ID="...")

# C. Get Areas for City
curl -i -X GET http://localhost:3000/api/v1/customer/locations/cities/$CITY_ID/areas \
  -H "Authorization: Bearer $TOKEN"

# (Copy an areaId from response, e.g. export AREA_ID="...")
```

---

### STEP 5: Create Saved Address

```bash
curl -i -X POST http://localhost:3000/api/v1/customer/addresses \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "fullName": "Sahil Hode",
    "mobile": "+919876543210",
    "houseNumber": "Flat 301",
    "buildingName": "Sunrise Heights",
    "streetName": "Linking Road",
    "landmark": "Near KFC",
    "stateId": "'"$STATE_ID"'",
    "cityId": "'"$CITY_ID"'",
    "areaId": "'"$AREA_ID"'",
    "latitude": 19.0600,
    "longitude": 72.8300
  }'
```
**Expected Response**: `201 Created` with full address object and server-resolved `state`, `city`, `area` strings. Copy the returned `id` as `ADDRESS_ID`.

---

### STEP 6: Hierarchy Validation Rejection Test

Try creating an address with an invalid/mismatched State and City:
```bash
curl -i -X POST http://localhost:3000/api/v1/customer/addresses \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "fullName": "Test User",
    "mobile": "+919876543210",
    "houseNumber": "12",
    "stateId": "00000000-0000-0000-0000-000000000000",
    "cityId": "'"$CITY_ID"'",
    "areaId": "'"$AREA_ID"'"
  }'
```
**Expected Response**: `400 Bad Request` (`Invalid or inactive State -> City -> Area selection`).

---

### STEP 7: List Customer Saved Addresses

```bash
curl -i -X GET http://localhost:3000/api/v1/customer/addresses \
  -H "Authorization: Bearer $TOKEN"
```
**Expected Response**: `200 OK` array containing your created address.

---

### STEP 8: Fetch Single Address by ID

```bash
curl -i -X GET http://localhost:3000/api/v1/customer/addresses/$ADDRESS_ID \
  -H "Authorization: Bearer $TOKEN"
```
**Expected Response**: `200 OK` with the address entity.

---

### STEP 9: Update Address (PATCH)

```bash
curl -i -X PATCH http://localhost:3000/api/v1/customer/addresses/$ADDRESS_ID \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "houseNumber": "Penthouse 901",
    "landmark": "Near Starbucks"
  }'
```
**Expected Response**: `200 OK` showing updated `houseNumber` and `landmark` with location hierarchy remaining intact.

---

### STEP 10: Delete Address

```bash
curl -i -X DELETE http://localhost:3000/api/v1/customer/addresses/$ADDRESS_ID \
  -H "Authorization: Bearer $TOKEN"
```
**Expected Response**: `204 No Content` (Empty body).

---

### STEP 11: Verify Deletion & IDOR Protection

Try fetching the deleted address:
```bash
curl -i -X GET http://localhost:3000/api/v1/customer/addresses/$ADDRESS_ID \
  -H "Authorization: Bearer $TOKEN"
```
**Expected Response**: `404 Not Found` (`Address not found`).

---

## 4. Summary of Status Codes & Error Formats

| Status Code | Meaning | Typical Trigger |
|---|---|---|
| `200 OK` | Success | Successful read or update. |
| `201 Created` | Created | Successful address creation. |
| `204 No Content` | Deleted | Successful address deletion. |
| `400 Bad Request` | Validation Error | Broken State/City/Area hierarchy, out-of-range coordinates, invalid UUID syntax, missing required fields. |
| `401 Unauthorized` | Auth Failure | Missing, expired, or malformed Bearer JWT token. |
| `403 Forbidden` | RBAC Denied | Token role is not `CUSTOMER`. |
| `404 Not Found` | Resource Missing | Non-existent address ID, address owned by another user (IDOR protection), inactive State/City. |
| `503 Service Unavailable` | Upstream Down | Geoapify timeout, network failure, or missing API key. |
