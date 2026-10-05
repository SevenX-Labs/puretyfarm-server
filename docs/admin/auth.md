# Admin Authentication API Specification & Postman Testing Guide

This document provides complete, all-in-one documentation for the **Admin Authentication System** in the PuretyFarm backend (Phase 1), covering architecture, database models, initial seeding, endpoint specifications, request/response payloads, and a step-by-step Postman/cURL testing guide.

---

## 1. Overview & Architecture

### Core Architecture
- **Unified Module Architecture**: Implemented within the existing `AuthModule` (`src/modules/auth/auth.controller.ts`, `src/modules/auth/auth.service.ts`), extending authentication to administrators without creating duplicate modules.
- **Dedicated Admin Database Model**: Admins are stored in a dedicated `admins` table, strictly separate from the customer `users` table.
- **Single Source of Truth**: The database-generated UUID (`Admin.id`) is the sole authoritative identity. No environment variable is used or required for Admin ID.
- **Phase 1 Boundary**: Exactly one Administrator is seeded for Phase 1. No multi-admin, roles management, or public registration is permitted.

### Base URLs & Dual Routing
All admin authentication routes support dual routing prefixes:
- **Prefix A**: `https://api-puretyfarm.onrender.com/api/v1/auth/admin/...`
- **Prefix B**: `https://api-puretyfarm.onrender.com/auth/admin/...`

### Security Standards
- **Password Hashing**: Uses Argon2id via `argon2` for all password hashing and verification. Plaintext passwords are never stored in the database.
- **Zero Logging Policy**: Passwords and password hashes are never logged, printed, or exposed in API responses.
- **Session Architecture**: Reuses the core `sessions` table. An admin session records `adminId: admin.id`, `refreshTokenHash` (Argon2), and session expiration (`90 days`).
- **Token Segregation**: Signs separate Access (`30m` TTL) and Refresh (`90d` TTL) JWTs using distinct secrets (`JWT_ACCESS_SECRET` vs `JWT_REFRESH_SECRET`).
- **Role Enforcement & Guarding**:
  - Protected endpoints utilize `JwtAuthGuard` and `@Roles('ADMIN')`.
  - Customer tokens presenting `role: "CUSTOMER"` are strictly rejected with `403 Forbidden`.
  - Admin identity is derived strictly from `JWT.sub`. Request bodies cannot provide an `adminId`.

---

## 2. Database Model & Initial Seeding

### 2.1 Prisma Admin Model
Located in `prisma/schema.prisma`:
```prisma
model Admin {
  id           String    @id @default(uuid())
  email        String    @unique
  passwordHash String
  isActive     Boolean   @default(true)
  createdAt    DateTime  @default(now())
  updatedAt    DateTime  @updatedAt
  sessions     Session[]

  @@index([email])
  @@index([isActive])
  @@map("admins")
}
```

### 2.2 Initial Seed (`prisma/seed.ts`)
Run the seed via Prisma CLI:
```bash
npx prisma db seed
```

**Seeded Credentials**:
- **Email**: `admin@puretyfarm.com`
- **Initial Password**: `puretyfarm@2026`

**Idempotency & Safety Rules**:
1. The seed checks if an Admin with `email: "admin@puretyfarm.com"` already exists.
2. If **not found**, it hashes `puretyfarm@2026` with Argon2 and creates the record.
3. If **already exists**, it skips creation and **never overwrites** the existing password hash, ensuring updated passwords are not reset on subsequent seed executions.

---

## 3. JWT Token Structure

Admin JWT tokens are signed with the following claims:

```json
{
  "sub": "7cf7afdf-6d89-4fbf-a9f2-11089335e980",
  "role": "ADMIN",
  "sessionId": "4a713915-1823-455a-bd5b-7b0036ca6d50",
  "type": "access",
  "iat": 1728086400,
  "exp": 1728088200
}
```

- `sub`: The UUID of the `Admin` record from the database.
- `role`: Strictly `"ADMIN"`.
- `sessionId`: ID of the corresponding record in `sessions`.
- `type`: `"access"` for authorization headers, `"refresh"` for token rotation.

---

## 4. API Endpoints Specification

### ────────────────────────────────────────────────────────
### 4.1 Admin Login
### ────────────────────────────────────────────────────────
Authenticates an Administrator using email and password, creates an active session, and returns access and refresh JWT tokens.

- **Method**: `POST`
- **Path**: `/api/v1/auth/admin/login` (also `/auth/admin/login`)
- **Headers**:
  - `Content-Type: application/json`
- **Request Body**:
  ```json
  {
    "email": "admin@puretyfarm.com",
    "password": "puretyfarm@2026"
  }
  ```
- **Body Attributes**:
  - `email` (String, Required): Valid email format. Case-insensitive and trimmed by the server.
  - `password` (String, Required): Non-empty password string.
- **Success Response (200 OK)**:
  ```json
  {
    "success": true,
    "message": "Authentication successful",
    "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "admin": {
      "id": "7cf7afdf-6d89-4fbf-a9f2-11089335e980",
      "email": "admin@puretyfarm.com",
      "role": "ADMIN"
    }
  }
  ```
- **Error Responses**:
  - `400 Bad Request` — Validation failure (invalid email format or missing fields):
    ```json
    {
      "statusCode": 400,
      "message": ["email must be a valid email address"],
      "error": "Bad Request"
    }
    ```
  - `401 Unauthorized` — Invalid email or incorrect password:
    ```json
    {
      "statusCode": 401,
      "message": "Invalid email or password",
      "error": "Unauthorized"
    }
    ```
  - `401 Unauthorized` — Admin account is inactive (`isActive: false`):
    ```json
    {
      "statusCode": 401,
      "message": "Admin account is inactive",
      "error": "Unauthorized"
    }
    ```

---

### ────────────────────────────────────────────────────────
### 4.2 Admin Change Password
### ────────────────────────────────────────────────────────
Allows an authenticated Administrator to update their password. Requires verification of the current password before applying the new Argon2 hash.

- **Method**: `POST`
- **Path**: `/api/v1/auth/admin/change-password` (also `/auth/admin/change-password`)
- **Headers**:
  - `Authorization: Bearer <ADMIN_ACCESS_TOKEN>`
  - `Content-Type: application/json`
- **Request Body**:
  ```json
  {
    "currentPassword": "puretyfarm@2026",
    "newPassword": "newSecurePassword2026!"
  }
  ```
- **Body Attributes**:
  - `currentPassword` (String, Required): Existing password for verification.
  - `newPassword` (String, Required): New password, minimum 8 characters long.
- **Success Response (200 OK)**:
  ```json
  {
    "success": true,
    "message": "Password changed successfully"
  }
  ```
- **Error Responses**:
  - `400 Bad Request` — Incorrect current password:
    ```json
    {
      "statusCode": 400,
      "message": "Incorrect current password",
      "error": "Bad Request"
    }
    ```
  - `400 Bad Request` — New password too short (< 8 chars):
    ```json
    {
      "statusCode": 400,
      "message": ["newPassword must be at least 8 characters long"],
      "error": "Bad Request"
    }
    ```
  - `401 Unauthorized` — Missing or expired token:
    ```json
    {
      "statusCode": 401,
      "message": "Invalid or expired authentication token",
      "error": "Unauthorized"
    }
    ```
  - `403 Forbidden` — Customer token presented instead of Admin token:
    ```json
    {
      "statusCode": 403,
      "message": "Access denied for this role",
      "error": "Forbidden"
    }
    ```
  - `404 Not Found` — Admin record does not exist:
    ```json
    {
      "statusCode": 404,
      "message": "Admin not found",
      "error": "Not Found"
    }
    ```

---

### ────────────────────────────────────────────────────────
### 4.3 Admin Get Me
### ────────────────────────────────────────────────────────
Returns safe profile metadata for the authenticated Administrator.

- **Method**: `GET`
- **Path**: `/api/v1/auth/admin/get-me` (also `/auth/admin/get-me`)
- **Headers**:
  - `Authorization: Bearer <ADMIN_ACCESS_TOKEN>`
- **Request Body**: None
- **Success Response (200 OK)**:
  ```json
  {
    "id": "7cf7afdf-6d89-4fbf-a9f2-11089335e980",
    "email": "admin@puretyfarm.com",
    "role": "ADMIN"
  }
  ```
- **Error Responses**:
  - `401 Unauthorized` — Missing or invalid token:
    ```json
    {
      "statusCode": 401,
      "message": "Authentication token is missing",
      "error": "Unauthorized"
    }
    ```
  - `403 Forbidden` — Token role is not `ADMIN`:
    ```json
    {
      "statusCode": 403,
      "message": "Access denied for this role",
      "error": "Forbidden"
    }
    ```
  - `404 Not Found` — Admin does not exist:
    ```json
    {
      "statusCode": 404,
      "message": "Admin not found",
      "error": "Not Found"
    }
    ```

---

## 5. Step-by-Step Testing & cURL Workflow

Follow this sequential workflow to test Admin Authentication from terminal or Postman.

### STEP 1: Seed Initial Admin (If Not Already Done)

Run the database seed:
```bash
npx prisma db seed
```
**Expected Output**: Confirms creation or shows admin already exists.

---

### STEP 2: Login as Admin

```bash
curl -i -X POST https://api-puretyfarm.onrender.com/api/v1/auth/admin/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "admin@puretyfarm.com",
    "password": "puretyfarm@2026"
  }'
```
**Expected Response**: `200 OK` containing `accessToken`, `refreshToken`, and the `admin` profile.

Save the access token from the response:
```bash
export ADMIN_TOKEN="<COPIED_ACCESS_TOKEN>"
```

---

### STEP 3: Verify Profile with Get Me

```bash
curl -i -X GET https://api-puretyfarm.onrender.com/api/v1/auth/admin/get-me \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```
**Expected Response**: `200 OK` returning `{ "id": "...", "email": "admin@puretyfarm.com", "role": "ADMIN" }`.

---

### STEP 4: Verify RBAC Protection with Customer Token

Attempting to access `/api/v1/auth/admin/get-me` with a customer token:
```bash
curl -i -X GET https://api-puretyfarm.onrender.com/api/v1/auth/admin/get-me \
  -H "Authorization: Bearer <CUSTOMER_TOKEN>"
```
**Expected Response**: `403 Forbidden` (`Access denied for this role`).

---

### STEP 5: Change Password

```bash
curl -i -X POST https://api-puretyfarm.onrender.com/api/v1/auth/admin/change-password \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "currentPassword": "puretyfarm@2026",
    "newPassword": "newSecurePassword2026!"
  }'
```
**Expected Response**: `200 OK` (`"message": "Password changed successfully"`).

---

### STEP 6: Verify Old Password Stops Working

Try logging in with the old initial password:
```bash
curl -i -X POST https://api-puretyfarm.onrender.com/api/v1/auth/admin/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "admin@puretyfarm.com",
    "password": "puretyfarm@2026"
  }'
```
**Expected Response**: `401 Unauthorized` (`"message": "Invalid email or password"`).

---

### STEP 7: Login with New Password

```bash
curl -i -X POST https://api-puretyfarm.onrender.com/api/v1/auth/admin/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "admin@puretyfarm.com",
    "password": "newSecurePassword2026!"
  }'
```
**Expected Response**: `200 OK` with fresh `accessToken` and `refreshToken`.

---

## 6. Summary of Status Codes & Error Formats

| Status Code | Meaning | Typical Trigger |
|---|---|---|
| `200 OK` | Success | Successful login, password update, or profile retrieval. |
| `400 Bad Request` | Validation Error | Malformed email, empty password, new password < 8 characters, or incorrect current password. |
| `401 Unauthorized` | Auth Failure | Incorrect login credentials, inactive account, missing token, or expired token. |
| `403 Forbidden` | Access Denied | Token presented does not possess the `ADMIN` role (e.g. customer access token). |
| `404 Not Found` | Resource Missing | Admin ID does not exist in the database. |
