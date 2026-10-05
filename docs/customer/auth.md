# Customer Authentication API Specification & Postman Testing Guide

This document provides complete documentation for the Customer Authentication system in the PuretyFarm backend, covering architecture, endpoint specifications, request/response payloads, distributed rate limiting, and a step-by-step Postman testing workflow.

---

## 1. Overview & Architecture

- **Auth Mode**: Passwordless Mobile + OTP authentication exclusively.
- **Shared Module Architecture**: Implemented via a unified `AuthModule`, `AuthController`, and `AuthService` with role-specific DTOs (`src/modules/auth/dto/customer/`).
- **Base URL**: `https://api-puretyfarm.onrender.com` (Routes are accessible via both `/api/v1/auth/customer/*` and `/auth/customer/*`).
- **Data Stores**:
  - **PostgreSQL (Supabase)**: Permanent user profiles (`User`) and authentication sessions (`Session`).
  - **Valkey (Layerbase)**: Ephemeral OTP hashes, cooldown locks, attempt counters, and distributed rate limiting counters.
- **Security Standards**:
  - **Argon2id**: All OTPs and refresh tokens are hashed using Argon2 before persistence. Plaintext credentials are never saved.
  - **Crypto-Secure OTP**: Generated using Node.js built-in `crypto.randomInt()`.
  - **Token Segregation**: Access and refresh tokens use distinct secrets (`JWT_ACCESS_SECRET` vs `JWT_REFRESH_SECRET`).
  - **Single-Use Enforced**: Used OTPs and rotated refresh tokens are immediately invalidated.

---

## 2. Phone Number Normalization & Rate Limiting

### Mobile Normalization Rules
Any of the following inputs automatically resolve to the canonical E.164 format `+91XXXXXXXXXX`:
- `9876543210` -> `+919876543210`
- `+919876543210` -> `+919876543210`
- `919876543210` -> `+919876543210`
- `09876543210` -> `+919876543210`
- `+91 98765-43210` -> `+919876543210`

### Valkey Rate Limiting Keys & Limits
| Key Pattern | TTL / Window | Limit / Action | HTTP Error |
|---|---|---|---|
| `auth:customer:otp:{mobile}` | 300s (5 min) | Stores Argon2 hash of active OTP | `400 Bad Request` (Expired/Invalid) |
| `auth:customer:otp:cooldown:{mobile}` | 60s | 1 request per 60 seconds resend cooldown | `429 Too Many Requests` |
| `auth:customer:otp:send:{mobile}:5m` | 300s | Max 5 OTP requests per 5-minute rolling window | `429 Too Many Requests` |
| `auth:customer:otp:send:{mobile}:daily` | 86400s (24h) | Max 15 OTP requests per mobile per day | `429 Too Many Requests` |
| `auth:customer:otp:attempts:{mobile}` | 300s | Max 5 failed OTP verification attempts | `400 Bad Request` (Invalidates OTP) |
| `auth:customer:email:{userId}` | 300s | Bound JSON `{ email, hash }` for email verification | `400 Bad Request` |
| `auth:customer:email:cooldown:{userId}` | 60s | 1 email OTP request per 60 seconds | `429 Too Many Requests` |
| `auth:customer:email:attempts:{userId}` | 300s | Max 5 failed email verification attempts | `400 Bad Request` |

> **Development Logging Note**: When running with `NODE_ENV !== 'production'`, OTPs are logged directly in the server console for easy testing:
> ```text
> [Nest] LOG [AuthService] [AUTH][DEV] Customer OTP Mobile: +919876543210 OTP: 744625 Expires: 5 minutes
> [Nest] LOG [AuthService] [AUTH][DEV] Customer Email OTP UserId: ... Email: customer@puretyfarm.com OTP: 313564 Expires: 5 minutes
> ```

---

## 3. Endpoint Specifications

### 3.1 Send Login OTP
Initiates customer login or registration by sending a 6-digit OTP to the provided mobile number.

- **Method**: `POST`
- **Path**: `/api/v1/auth/customer/login`
- **Headers**:
  ```http
  Content-Type: application/json
  ```
- **Request Body**:
  ```json
  {
    "mobile": "9876543210"
  }
  ```
- **Success Response (`200 OK`)**:
  ```json
  {
    "success": true,
    "message": "OTP sent successfully"
  }
  ```
- **Error Responses**:
  - `400 Bad Request`: Invalid mobile format (e.g. invalid length or non-numeric characters).
    ```json
    {
      "message": ["Please provide a valid 10-digit Indian mobile number"],
      "error": "Bad Request",
      "statusCode": 400
    }
    ```
  - `429 Too Many Requests`: Cooldown active or limit reached.
    ```json
    {
      "statusCode": 429,
      "message": "Please wait before requesting another OTP"
    }
    ```

---

### 3.2 Verify Login OTP
Validates the submitted OTP. If valid, provisions or retrieves the customer profile, registers an authentication session in PostgreSQL, and issues JWT access and refresh tokens.

- **Method**: `POST`
- **Path**: `/api/v1/auth/customer/verify-otp`
- **Headers**:
  ```http
  Content-Type: application/json
  ```
- **Request Body**:
  ```json
  {
    "mobile": "9876543210",
    "otp": "744625"
  }
  ```
- **Success Response (`200 OK`)**:
  ```json
  {
    "success": true,
    "message": "Authentication successful",
    "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "user": {
      "id": "62ed549b-0b21-4020-8d57-6e4966edaa43",
      "mobile": "+919876543210",
      "email": null,
      "emailVerified": false,
      "role": "CUSTOMER"
    }
  }
  ```
- **Error Responses**:
  - `400 Bad Request` (Invalid OTP):
    ```json
    {
      "message": "Invalid OTP. Attempts remaining: 4",
      "error": "Bad Request",
      "statusCode": 400
    }
    ```
  - `400 Bad Request` (Max Attempts Reached):
    ```json
    {
      "message": "Maximum verification attempts exceeded. Please request a new OTP.",
      "error": "Bad Request",
      "statusCode": 400
    }
    ```
  - `400 Bad Request` (Expired or Already Used OTP):
    ```json
    {
      "message": "Invalid or expired OTP",
      "error": "Bad Request",
      "statusCode": 400
    }
    ```

---

### 3.3 Refresh Access Token
Rotates the refresh token and issues a new access token. Old refresh tokens are permanently invalidated.

- **Method**: `POST`
- **Path**: `/api/v1/auth/customer/refresh`
- **Headers**:
  ```http
  Content-Type: application/json
  ```
- **Request Body**:
  ```json
  {
    "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
  }
  ```
- **Success Response (`200 OK`)**:
  ```json
  {
    "success": true,
    "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
  }
  ```
- **Error Responses**:
  - `401 Unauthorized`:
    ```json
    {
      "message": "Invalid or expired refresh token",
      "error": "Unauthorized",
      "statusCode": 401
    }
    ```

---

### 3.4 Get Authenticated Customer Profile (`get-me`)
Returns the currently authenticated customer's profile. User ID is extracted strictly from the JWT `sub` claim.

- **Method**: `GET`
- **Path**: `/api/v1/auth/customer/get-me`
- **Headers**:
  ```http
  Authorization: Bearer <accessToken>
  ```
- **Success Response (`200 OK`)**:
  ```json
  {
    "id": "62ed549b-0b21-4020-8d57-6e4966edaa43",
    "mobile": "+919876543210",
    "email": "customer@puretyfarm.com",
    "emailVerified": true,
    "role": "CUSTOMER",
    "createdAt": "2026-10-03T08:35:39.250Z",
    "updatedAt": "2026-10-03T08:36:23.437Z"
  }
  ```
- **Error Responses**:
  - `401 Unauthorized`: Token missing, expired, or session revoked.
    ```json
    {
      "message": "Session has been revoked or expired",
      "error": "Unauthorized",
      "statusCode": 401
    }
    ```

---

### 3.5 Customer Logout
Revokes the current session in PostgreSQL, invalidating the session and any associated refresh token.

- **Method**: `POST`
- **Path**: `/api/v1/auth/customer/logout`
- **Headers**:
  ```http
  Authorization: Bearer <accessToken>
  ```
- **Success Response (`200 OK`)**:
  ```json
  {
    "success": true,
    "message": "Logged out successfully"
  }
  ```
- **Error Responses**:
  - `401 Unauthorized`: Token missing or invalid.

---

### 3.6 Send Email Verification OTP
Initiates email verification for the authenticated customer. Checks if email is already taken and generates a 6-digit OTP bound specifically to the user and email.

- **Method**: `POST`
- **Path**: `/api/v1/auth/customer/email-verification/send-otp`
- **Headers**:
  ```http
  Authorization: Bearer <accessToken>
  Content-Type: application/json
  ```
- **Request Body**:
  ```json
  {
    "email": "customer@puretyfarm.com"
  }
  ```
- **Success Response (`200 OK`)**:
  ```json
  {
    "success": true,
    "message": "Email verification OTP sent successfully"
  }
  ```
- **Error Responses**:
  - `409 Conflict`: Email is already used by another account.
    ```json
    {
      "message": "Email is already associated with another account",
      "error": "Conflict",
      "statusCode": 409
    }
    ```
  - `429 Too Many Requests`: 60-second resend cooldown active.
    ```json
    {
      "statusCode": 429,
      "message": "Please wait before requesting another email verification OTP"
    }
    ```

---

### 3.7 Verify Email Verification OTP
Verifies the submitted email OTP against the bound user and email address. Updates `email` and sets `emailVerified = true` in the database.

- **Method**: `POST`
- **Path**: `/api/v1/auth/customer/email-verification/verify-otp`
- **Headers**:
  ```http
  Authorization: Bearer <accessToken>
  Content-Type: application/json
  ```
- **Request Body**:
  ```json
  {
    "email": "customer@puretyfarm.com",
    "otp": "313564"
  }
  ```
- **Success Response (`200 OK`)**:
  ```json
  {
    "success": true,
    "message": "Email verified successfully"
  }
  ```
- **Error Responses**:
  - `400 Bad Request`: OTP mismatch, invalid email binding, or expired.
    ```json
    {
      "message": "OTP was not requested for this email address",
      "error": "Bad Request",
      "statusCode": 400
    }
    ```

---

## 4. Step-by-Step Postman Testing Guide

Follow this sequence to test the entire lifecycle in Postman:

### Environment Setup in Postman
Set the following environment variables:
- `baseUrl`: `https://api-puretyfarm.onrender.com`
- `accessToken`: *(Leave blank initially, populated by verify-otp)*
- `refreshToken`: *(Leave blank initially, populated by verify-otp)*

---

### Step 1: Send Login OTP
1. Set request to **`POST {{baseUrl}}/api/v1/auth/customer/login`**.
2. Under **Body** (`raw` > `JSON`):
   ```json
   {
     "mobile": "9876543210"
   }
   ```
3. Click **Send**.
4. Status: `200 OK`.
5. Check your backend terminal log for the OTP:
   ```text
   [Nest] LOG [AuthService] [AUTH][DEV] Customer OTP Mobile: +919876543210 OTP: <6-DIGIT-OTP> Expires: 5 minutes
   ```
   *(Optional edge test: Send again immediately to verify `429 Too Many Requests` cooldown response).*

---

### Step 2: Verify Login OTP
1. Set request to **`POST {{baseUrl}}/api/v1/auth/customer/verify-otp`**.
2. Under **Body** (`raw` > `JSON`):
   ```json
   {
     "mobile": "+919876543210",
     "otp": "<PASTE-OTP-FROM-LOG>"
   }
   ```
3. Under the **Tests** tab, add this script to automatically store the tokens:
   ```javascript
   if (pm.response.code === 200) {
       var data = pm.response.json();
       pm.environment.set("accessToken", data.accessToken);
       pm.environment.set("refreshToken", data.refreshToken);
   }
   ```
4. Click **Send**.
5. Status: `200 OK`. Tokens are now stored in `{{accessToken}}` and `{{refreshToken}}`.

---

### Step 3: Get Customer Profile
1. Set request to **`GET {{baseUrl}}/api/v1/auth/customer/get-me`**.
2. Under **Authorization** tab:
   - Type: **Bearer Token**
   - Token: `{{accessToken}}`
3. Click **Send**.
4. Status: `200 OK`. Returns customer details.

---

### Step 4: Refresh Access Token (Token Rotation)
1. Set request to **`POST {{baseUrl}}/api/v1/auth/customer/refresh`**.
2. Under **Body** (`raw` > `JSON`):
   ```json
   {
     "refreshToken": "{{refreshToken}}"
   }
   ```
3. Under the **Tests** tab, update the stored tokens:
   ```javascript
   if (pm.response.code === 200) {
       var data = pm.response.json();
       pm.environment.set("accessToken", data.accessToken);
       pm.environment.set("refreshToken", data.refreshToken);
   }
   ```
4. Click **Send**.
5. Status: `200 OK`. New access and rotated refresh tokens are issued.
6. *(Optional edge test: Click Send again immediately with the previous refresh token to confirm `401 Unauthorized` rotation enforcement).*

---

### Step 5: Send Email Verification OTP
1. Set request to **`POST {{baseUrl}}/api/v1/auth/customer/email-verification/send-otp`**.
2. Under **Authorization** tab: Bearer Token `{{accessToken}}`.
3. Under **Body** (`raw` > `JSON`):
   ```json
   {
     "email": "customer@puretyfarm.com"
   }
   ```
4. Click **Send**.
5. Status: `200 OK`.
6. Retrieve the generated email OTP from your backend terminal console.

---

### Step 6: Verify Email OTP
1. Set request to **`POST {{baseUrl}}/api/v1/auth/customer/email-verification/verify-otp`**.
2. Under **Authorization** tab: Bearer Token `{{accessToken}}`.
3. Under **Body** (`raw` > `JSON`):
   ```json
   {
     "email": "customer@puretyfarm.com",
     "otp": "<PASTE-EMAIL-OTP>"
   }
   ```
4. Click **Send**.
5. Status: `200 OK`. Response: `{"success": true, "message": "Email verified successfully"}`.
6. Run `GET /api/v1/auth/customer/get-me` again to verify `emailVerified: true`.

---

### Step 7: Logout & Session Revocation
1. Set request to **`POST {{baseUrl}}/api/v1/auth/customer/logout`**.
2. Under **Authorization** tab: Bearer Token `{{accessToken}}`.
3. Click **Send**.
4. Status: `200 OK`. Response: `{"success": true, "message": "Logged out successfully"}`.
5. Re-run `GET /api/v1/auth/customer/get-me` with the same token to confirm immediate revocation:
   ```json
   {
     "message": "Session has been revoked or expired",
     "error": "Unauthorized",
     "statusCode": 401
   }
   ```
