# Admin Serviceability & Location Management API Specification & Testing Guide

This document provides comprehensive API documentation for **Admin Serviceability & Location Hierarchy Management** (States, Cities, and Serviceable Areas/Pincodes) in the PuretyFarm backend.

---

## 1. Overview & Architecture

### Base URLs & Dual Routing
All admin location management routes support dual routing prefixes:
- **Base URL**: `https://api-puretyfarm.onrender.com`
- **Prefix A (Versioned)**: `https://api-puretyfarm.onrender.com/api/v1/admin/locations/...`
- **Prefix B (Direct)**: `https://api-puretyfarm.onrender.com/admin/locations/...`

### Hierarchy & Serviceability Model
Serviceability is structured as a strict 3-tier hierarchy:
```
State (e.g., Maharashtra)
 └── City (e.g., Pune)
      └── Area / Pincode (e.g., Kothrud - 411038)
```

- **Customer Matching**: Customer addresses and GPS location reverse-geocoding match against active **Area** records using Area name and Pincode.
- **Serviceability Activation**: 
  - An area is serviceable if and only if **Area `isActive: true`**, **City `isActive: true`**, AND **State `isActive: true`**.
  - Setting `isActive: false` on any tier instantly disables customer serviceability for that entire subtree without data loss.
- **Admin Visibility**: Unlike customer endpoints (which only return active records), admin endpoints return **both active and inactive** records for full operational management.
- **Integrity Protection**: Hard deletes are blocked with `409 Conflict` if dependent children or customer addresses exist. Administrators are prompted to set `isActive: false` instead.

### Security & Role Enforcement
- **Authentication**: `Authorization: Bearer <ADMIN_JWT_ACCESS_TOKEN>` header required on all endpoints.
- **Guard**: Protected by `JwtAuthGuard` and `@Roles('ADMIN')`. Non-admin tokens receive `403 Forbidden`.

---

## 2. States Management Endpoints

### 2.1 Create State
Creates a new state in the catalog (`isActive` defaults to `true`).

- **Method**: `POST`
- **Endpoint**: `/api/v1/admin/locations/states`
- **Request Body**:
  | Field | Type | Required | Description |
  | :--- | :--- | :--- | :--- |
  | `name` | String | Yes | Unique name of the state (max 100 chars) |

```json
{
  "name": "Maharashtra"
}
```

#### Response Example (`201 Created`):
```json
{
  "id": "e3a89110-53bc-418b-9e4a-1a8c9b20e001",
  "name": "Maharashtra",
  "isActive": true,
  "createdAt": "2026-10-05T10:00:00.000Z",
  "updatedAt": "2026-10-05T10:00:00.000Z"
}
```

---

### 2.2 List All States
Lists all states in alphabetical order (including inactive states).

- **Method**: `GET`
- **Endpoint**: `/api/v1/admin/locations/states`

#### Response Example (`200 OK`):
```json
[
  {
    "id": "e3a89110-53bc-418b-9e4a-1a8c9b20e001",
    "name": "Maharashtra",
    "isActive": true,
    "createdAt": "2026-10-05T10:00:00.000Z",
    "updatedAt": "2026-10-05T10:00:00.000Z"
  },
  {
    "id": "f4b90221-64cd-529c-0f5b-2b9d0c31f002",
    "name": "Karnataka",
    "isActive": false,
    "createdAt": "2026-10-05T10:05:00.000Z",
    "updatedAt": "2026-10-05T10:10:00.000Z"
  }
]
```

---

### 2.3 Update State
Renames a state and/or enables/disables it.

- **Method**: `PATCH`
- **Endpoint**: `/api/v1/admin/locations/states/:stateId`
- **Route Parameters**:
  - `stateId`: UUID of the state.
- **Request Body** (at least one field optional):
  ```json
  {
    "name": "Maharashtra State",
    "isActive": true
  }
  ```

#### Response Example (`200 OK`):
```json
{
  "id": "e3a89110-53bc-418b-9e4a-1a8c9b20e001",
  "name": "Maharashtra State",
  "isActive": true,
  "createdAt": "2026-10-05T10:00:00.000Z",
  "updatedAt": "2026-10-05T11:00:00.000Z"
}
```

---

### 2.4 Delete State
Hard-deletes a state if and only if no cities and no customer addresses reference it.

- **Method**: `DELETE`
- **Endpoint**: `/api/v1/admin/locations/states/:stateId`
- **Route Parameters**:
  - `stateId`: UUID of the state.

#### Response Example (`200 OK`):
```json
{
  "id": "e3a89110-53bc-418b-9e4a-1a8c9b20e001",
  "deleted": true
}
```

#### Error Response (`409 Conflict` - if cities/addresses exist):
```json
{
  "statusCode": 409,
  "message": "State has dependent cities and cannot be deleted. Disable it instead.",
  "error": "Conflict"
}
```

---

## 3. Cities Management Endpoints

### 3.1 Create City
Creates a new city under an existing active parent state.

- **Method**: `POST`
- **Endpoint**: `/api/v1/admin/locations/cities`
- **Request Body**:
  | Field | Type | Required | Description |
  | :--- | :--- | :--- | :--- |
  | `stateId` | UUID | Yes | Parent State ID (must be an active state) |
  | `name` | String | Yes | Unique name within the state (max 100 chars) |

```json
{
  "stateId": "e3a89110-53bc-418b-9e4a-1a8c9b20e001",
  "name": "Pune"
}
```

#### Response Example (`201 Created`):
```json
{
  "id": "a1c78330-42ab-317a-8d39-0a7b8a10d001",
  "name": "Pune",
  "stateId": "e3a89110-53bc-418b-9e4a-1a8c9b20e001",
  "isActive": true,
  "createdAt": "2026-10-05T10:15:00.000Z",
  "updatedAt": "2026-10-05T10:15:00.000Z"
}
```

---

### 3.2 List Cities Under State
Lists all cities under a specified state in alphabetical order.

- **Method**: `GET`
- **Endpoint**: `/api/v1/admin/locations/states/:stateId/cities`
- **Route Parameters**:
  - `stateId`: UUID of the state.

#### Response Example (`200 OK`):
```json
[
  {
    "id": "a1c78330-42ab-317a-8d39-0a7b8a10d001",
    "name": "Pune",
    "stateId": "e3a89110-53bc-418b-9e4a-1a8c9b20e001",
    "isActive": true,
    "createdAt": "2026-10-05T10:15:00.000Z",
    "updatedAt": "2026-10-05T10:15:00.000Z"
  },
  {
    "id": "b2d89441-53bc-428b-9e4a-1b8c9b20e002",
    "name": "Mumbai",
    "stateId": "e3a89110-53bc-418b-9e4a-1a8c9b20e001",
    "isActive": true,
    "createdAt": "2026-10-05T10:20:00.000Z",
    "updatedAt": "2026-10-05T10:20:00.000Z"
  }
]
```

---

### 3.3 Update City
Renames a city and/or enables/disables it.

- **Method**: `PATCH`
- **Endpoint**: `/api/v1/admin/locations/cities/:cityId`
- **Route Parameters**:
  - `cityId`: UUID of the city.
- **Request Body**:
  ```json
  {
    "name": "Pune City",
    "isActive": true
  }
  ```

#### Response Example (`200 OK`):
```json
{
  "id": "a1c78330-42ab-317a-8d39-0a7b8a10d001",
  "name": "Pune City",
  "stateId": "e3a89110-53bc-418b-9e4a-1a8c9b20e001",
  "isActive": true,
  "createdAt": "2026-10-05T10:15:00.000Z",
  "updatedAt": "2026-10-05T11:05:00.000Z"
}
```

---

### 3.4 Delete City
Hard-deletes a city if and only if no areas and no customer addresses reference it.

- **Method**: `DELETE`
- **Endpoint**: `/api/v1/admin/locations/cities/:cityId`
- **Route Parameters**:
  - `cityId`: UUID of the city.

#### Response Example (`200 OK`):
```json
{
  "id": "a1c78330-42ab-317a-8d39-0a7b8a10d001",
  "deleted": true
}
```

---

## 4. Areas Management Endpoints (Serviceability Core)

### 4.1 Create Serviceable Area
Creates a new serviceable area under an active city with a mandatory pincode.

- **Method**: `POST`
- **Endpoint**: `/api/v1/admin/locations/areas`
- **Request Body**:
  | Field | Type | Required | Description |
  | :--- | :--- | :--- | :--- |
  | `cityId` | UUID | Yes | Parent City ID (must be active) |
  | `name` | String | Yes | Name of area/neighborhood (e.g. `Kothrud`) |
  | `pincode` | String | Yes | 4 to 10 digit postal code (e.g. `411038`) |

```json
{
  "cityId": "a1c78330-42ab-317a-8d39-0a7b8a10d001",
  "name": "Kothrud",
  "pincode": "411038"
}
```

#### Response Example (`201 Created`):
```json
{
  "id": "7b8c9d01-e2f3-4a5b-6c7d-8e9f0a1b2c3d",
  "name": "Kothrud",
  "cityId": "a1c78330-42ab-317a-8d39-0a7b8a10d001",
  "pincode": "411038",
  "isActive": true,
  "createdAt": "2026-10-05T10:30:00.000Z",
  "updatedAt": "2026-10-05T10:30:00.000Z"
}
```

---

### 4.2 List Areas Under City
Lists all areas under a city in alphabetical order.

- **Method**: `GET`
- **Endpoint**: `/api/v1/admin/locations/cities/:cityId/areas`
- **Route Parameters**:
  - `cityId`: UUID of the city.

#### Response Example (`200 OK`):
```json
[
  {
    "id": "7b8c9d01-e2f3-4a5b-6c7d-8e9f0a1b2c3d",
    "name": "Kothrud",
    "cityId": "a1c78330-42ab-317a-8d39-0a7b8a10d001",
    "pincode": "411038",
    "isActive": true,
    "createdAt": "2026-10-05T10:30:00.000Z",
    "updatedAt": "2026-10-05T10:30:00.000Z"
  },
  {
    "id": "8c9d0e12-f3a4-5b6c-7d8e-9f0a1b2c3d4e",
    "name": "Baner",
    "cityId": "a1c78330-42ab-317a-8d39-0a7b8a10d001",
    "pincode": "411045",
    "isActive": true,
    "createdAt": "2026-10-05T10:35:00.000Z",
    "updatedAt": "2026-10-05T10:35:00.000Z"
  }
]
```

---

### 4.3 Update Area (Toggle Serviceability / Edit Pincode)
Renames, changes pincode, or enables/disables an area. Setting `isActive: false` directly marks the area unserviceable for customers.

- **Method**: `PATCH`
- **Endpoint**: `/api/v1/admin/locations/areas/:areaId`
- **Route Parameters**:
  - `areaId`: UUID of the area.
- **Request Body**:
  ```json
  {
    "name": "Kothrud West",
    "pincode": "411038",
    "isActive": true
  }
  ```

#### Response Example (`200 OK`):
```json
{
  "id": "7b8c9d01-e2f3-4a5b-6c7d-8e9f0a1b2c3d",
  "name": "Kothrud West",
  "cityId": "a1c78330-42ab-317a-8d39-0a7b8a10d001",
  "pincode": "411038",
  "isActive": true,
  "createdAt": "2026-10-05T10:30:00.000Z",
  "updatedAt": "2026-10-05T11:15:00.000Z"
}
```

---

### 4.4 Delete Area
Hard-deletes an area if no customer address is registered to it.

- **Method**: `DELETE`
- **Endpoint**: `/api/v1/admin/locations/areas/:areaId`
- **Route Parameters**:
  - `areaId`: UUID of the area.

#### Response Example (`200 OK`):
```json
{
  "id": "7b8c9d01-e2f3-4a5b-6c7d-8e9f0a1b2c3d",
  "deleted": true
}
```

---

## 5. Step-by-Step Testing Guide (cURL)

Set environment variables:
```bash
export BASE_URL="https://api-puretyfarm.onrender.com"
export ADMIN_TOKEN="<YOUR_ADMIN_ACCESS_TOKEN>"
```

### 1. Authenticate as Admin
```bash
curl -i -X POST "$BASE_URL/api/v1/auth/admin/login" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "admin@puretyfarm.in",
    "password": "puretyfarm@2026"
  }'
```

### 2. Create State
```bash
curl -i -X POST "$BASE_URL/api/v1/admin/locations/states" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Maharashtra"
  }'
```

### 3. List All States
```bash
curl -i -X GET "$BASE_URL/api/v1/admin/locations/states" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

### 4. Create City Under State
```bash
curl -i -X POST "$BASE_URL/api/v1/admin/locations/cities" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "stateId": "<STATE_ID>",
    "name": "Pune"
  }'
```

### 5. List Cities Under State
```bash
curl -i -X GET "$BASE_URL/api/v1/admin/locations/states/<STATE_ID>/cities" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

### 6. Create Serviceable Area Under City
```bash
curl -i -X POST "$BASE_URL/api/v1/admin/locations/areas" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "cityId": "<CITY_ID>",
    "name": "Kothrud",
    "pincode": "411038"
  }'
```

### 7. List Areas Under City
```bash
curl -i -X GET "$BASE_URL/api/v1/admin/locations/cities/<CITY_ID>/areas" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

### 8. Toggle Area Serviceability (Disable Service)
```bash
curl -i -X PATCH "$BASE_URL/api/v1/admin/locations/areas/<AREA_ID>" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "isActive": false
  }'
```

### 9. Delete Unused Area
```bash
curl -i -X DELETE "$BASE_URL/api/v1/admin/locations/areas/<AREA_ID>" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```
