# Customer Profile API Specification & Complete Testing Plan

This document provides complete documentation and testing procedures for the Customer Profile and Avatar Management system in the PuretyFarm backend.

---

## 1. Overview & Architecture

- **Module**: Dedicated `ProfileModule` designed to support customer profile management today and extendable to future roles (admin, delivery partner) without duplicate modules.
- **Base Routes**:
  - `https://api-puretyfarm.onrender.com/api/v1/customer/profile`
  - `https://api-puretyfarm.onrender.com/customer/profile`
- **Database (PostgreSQL via Prisma)**:
  - 1-to-1 relation with the central `User` model.
  - Table: `customer_profiles`
  - Stored fields: `id`, `userId` (unique FK), `firstName`, `lastName`, `gender` (`MALE | FEMALE | OTHER`), `dateOfBirth` (`DateTime`), `profileImagePath` (`String?`), `createdAt`, `updatedAt`.
  - User identity fields (`mobile`, `email`, `emailVerified`, `role`) belong strictly to `User` and are combined in the API response.
- **Avatar Storage (Supabase Storage)**:
  - Bucket: `uploads` (Configured as **Private** for data privacy).
  - Storage path: `avatars/customers/{userId}-{timestamp}.{ext}`
  - The database stores **only** the permanent object path (`profileImagePath`), never a hardcoded URL.
  - The API dynamically generates a **1-hour signed URL** (`profileImageUrl`) on read requests (`GET /me`, `POST /update-avatar`) so frontend apps can directly render the private image.
- **Security & Authorization**:
  - All endpoints are protected by `JwtAuthGuard`.
  - Only the `CUSTOMER` role is authorized.
  - `userId` is strictly extracted from `req.user.sub` from the verified JWT.
  - Clients cannot pass or override `userId` via body, params, query, or file metadata (100% IDOR-safe).

---

## 2. Endpoint Specifications

### 2.1 Create Customer Profile
Creates the customer's initial profile.

- **Method**: `POST`
- **Path**: `/api/v1/customer/profile/create-profile`
- **Headers**:
  - `Authorization: Bearer <CUSTOMER_ACCESS_TOKEN>`
  - `Content-Type: application/json`
- **Request Body**:
  ```json
  {
    "firstName": "Sahil",
    "lastName": "Hode",
    "gender": "MALE",
    "dateOfBirth": "2000-01-15"
  }
  ```
- **Validation Rules**:
  - `firstName`: Non-empty string, max 50 chars, auto-trimmed.
  - `lastName`: Non-empty string, max 50 chars, auto-trimmed.
  - `gender`: Enum (`MALE`, `FEMALE`, `OTHER`).
  - `dateOfBirth`: Valid ISO 8601 date string (e.g. `YYYY-MM-DD`), must be in the past.
- **Success Response (201 Created)**:
  ```json
  {
    "id": "c1f7b049-55be-4416-9285-d6ca8e1dfc2e",
    "userId": "81fce727-4a0b-4171-be1e-d4c398335be9",
    "firstName": "Sahil",
    "lastName": "Hode",
    "gender": "MALE",
    "dateOfBirth": "2000-01-15",
    "profileImageUrl": null,
    "mobile": "+919876543210",
    "email": null,
    "emailVerified": false,
    "createdAt": "2026-10-03T14:15:00.000Z",
    "updatedAt": "2026-10-03T14:15:00.000Z"
  }
  ```
- **Error Responses**:
  - `409 Conflict`: Customer profile already exists.
  - `400 Bad Request`: Validation failed (invalid gender, future DOB, missing fields).
  - `401 Unauthorized`: Missing or invalid token.

---

### 2.2 Get Current Profile
Fetches the combined profile for the authenticated customer.

- **Method**: `GET`
- **Path**: `/api/v1/customer/profile/me`
- **Headers**:
  - `Authorization: Bearer <CUSTOMER_ACCESS_TOKEN>`
- **Success Response (200 OK)**:
  ```json
  {
    "id": "c1f7b049-55be-4416-9285-d6ca8e1dfc2e",
    "userId": "81fce727-4a0b-4171-be1e-d4c398335be9",
    "firstName": "Sahil",
    "lastName": "Hode",
    "gender": "MALE",
    "dateOfBirth": "2000-01-15",
    "profileImageUrl": "https://<project-id>.supabase.co/storage/v1/object/sign/uploads/avatars/customers/...jpg?token=...",
    "mobile": "+919876543210",
    "email": "customer@example.com",
    "emailVerified": true,
    "createdAt": "2026-10-03T14:15:00.000Z",
    "updatedAt": "2026-10-03T14:15:00.000Z"
  }
  ```
- **Error Responses**:
  - `404 Not Found`: Customer profile not found. Please create a profile first.
  - `401 Unauthorized`: Missing or invalid token.

---

### 2.3 Update Profile Details
Performs partial updates on allowed customer profile fields.

- **Method**: `PATCH`
- **Path**: `/api/v1/customer/profile/update-profile`
- **Headers**:
  - `Authorization: Bearer <CUSTOMER_ACCESS_TOKEN>`
  - `Content-Type: application/json`
- **Request Body (all fields optional)**:
  ```json
  {
    "firstName": "Sahil",
    "lastName": "Patil",
    "gender": "MALE",
    "dateOfBirth": "1999-05-20"
  }
  ```
- **Protected Fields**:
  - `id`, `userId`, `mobile`, `email`, `emailVerified`, `role` are ignored/stripped by NestJS ValidationPipe and cannot be modified here.
- **Success Response (200 OK)**: Returns updated combined profile object.

---

### 2.4 Upload / Replace Avatar
Uploads or updates the customer's profile avatar image.

- **Method**: `POST`
- **Path**: `/api/v1/customer/profile/update-avatar`
- **Headers**:
  - `Authorization: Bearer <CUSTOMER_ACCESS_TOKEN>`
  - `Content-Type: multipart/form-data`
- **Form Data Field**:
  - Key: `avatar` (File)
- **File Validation Rules**:
  - **Size Cap**: Maximum 3 MB (`3,145,728 bytes`). Enforced at both Multer stream limit and service layer.
  - **MIME Types**: `image/jpeg`, `image/png`, `image/webp`.
  - **Magic-Byte Signature Verification**: Raw bytes must match JPEG (`FF D8 FF`), PNG (`89 50 4E 47...`), or WEBP (`RIFF...WEBP`).
  - **MIME Cross-Check**: Declared MIME type must match the detected binary format.
- **Replacement Order (Safe 2-Phase Commit)**:
  1. Validate incoming file.
  2. Upload new image to Supabase Storage -> obtain storage path.
  3. Update PostgreSQL `profileImagePath` with new path.
  4. Only after DB succeeds, delete the old image from Supabase.
  5. If DB fails, automatically clean up the newly uploaded image.
- **Success Response (200 OK)**:
  ```json
  {
    "id": "c1f7b049-55be-4416-9285-d6ca8e1dfc2e",
    "userId": "81fce727-4a0b-4171-be1e-d4c398335be9",
    "firstName": "Sahil",
    "lastName": "Patil",
    "gender": "MALE",
    "dateOfBirth": "1999-05-20",
    "profileImageUrl": "https://<project-id>.supabase.co/storage/v1/object/sign/uploads/avatars/customers/81fce727-4a0b-4171-be1e-d4c398335be9-1727961200000.jpg?token=...",
    "mobile": "+919876543210",
    "email": "customer@example.com",
    "emailVerified": true,
    "createdAt": "2026-10-03T14:15:00.000Z",
    "updatedAt": "2026-10-03T14:20:00.000Z"
  }
  ```

---

### 2.5 Remove Avatar
Removes the customer's avatar and deletes the stored object.

- **Method**: `DELETE`
- **Path**: `/api/v1/customer/profile/remove-avatar`
- **Headers**:
  - `Authorization: Bearer <CUSTOMER_ACCESS_TOKEN>`
- **Success Response (200 OK)**:
  ```json
  {
    "id": "c1f7b049-55be-4416-9285-d6ca8e1dfc2e",
    "userId": "81fce727-4a0b-4171-be1e-d4c398335be9",
    "firstName": "Sahil",
    "lastName": "Patil",
    "gender": "MALE",
    "dateOfBirth": "1999-05-20",
    "profileImageUrl": null,
    "mobile": "+919876543210",
    "email": "customer@example.com",
    "emailVerified": true,
    "createdAt": "2026-10-03T14:15:00.000Z",
    "updatedAt": "2026-10-03T14:25:00.000Z"
  }
  ```

---

## 3. Complete Step-by-Step Testing Plan

### Test Matrix

| Test ID | Scenario | Request | Expected Status | Verification Check |
|---|---|---|---|---|
| **TC-01** | Obtain Auth Token | `POST /api/v1/auth/customer/verify-otp` | `200 OK` | Copy `accessToken` |
| **TC-02** | Get Profile Before Creation | `GET /api/v1/customer/profile/me` | `404 Not Found` | Message indicates profile not created |
| **TC-03** | Create Profile (Valid) | `POST /api/v1/customer/profile/create-profile` | `201 Created` | Combined profile with `profileImageUrl: null` |
| **TC-04** | Prevent Duplicate Profile | `POST /api/v1/customer/profile/create-profile` | `409 Conflict` | Conflict error message |
| **TC-05** | Validation: Invalid Gender | `POST /api/v1/customer/profile/create-profile` | `400 Bad Request` | Rejects non-enum gender value |
| **TC-06** | Validation: Future DOB | `POST /api/v1/customer/profile/create-profile` | `400 Bad Request` | `dateOfBirth must be in the past` |
| **TC-07** | Validation: Invalid Date Format | `POST /api/v1/customer/profile/create-profile` | `400 Bad Request` | `dateOfBirth must be a valid date string` |
| **TC-08** | Get Profile After Creation | `GET /api/v1/customer/profile/me` | `200 OK` | Profile details match |
| **TC-09** | Update Profile Details | `PATCH /api/v1/customer/profile/update-profile` | `200 OK` | First/last name updated |
| **TC-10** | Protected Fields Immutable | `PATCH /api/v1/customer/profile/update-profile` with `email`, `mobile`, `role` | `200 OK` | Protected fields unchanged in DB response |
| **TC-11** | Upload Avatar (Valid JPEG) | `POST /api/v1/customer/profile/update-avatar` (`avatar: photo.jpg`) | `200 OK` | Returns signed URL; object uploaded to Supabase |
| **TC-12** | Verify Avatar Display | HTTP GET to the returned `profileImageUrl` | `200 OK` | Returns `image/jpeg` binary with 200 OK |
| **TC-13** | Replace Avatar (Valid PNG) | `POST /api/v1/customer/profile/update-avatar` (`avatar: new-photo.png`) | `200 OK` | Returns new signed URL; old JPEG deleted from storage |
| **TC-14** | Avatar Rejection: > 3 MB | `POST /api/v1/customer/profile/update-avatar` with 3.5 MB file | `400 Bad Request` | File size limit exceeded |
| **TC-15** | Avatar Rejection: Unsupported MIME | `POST /api/v1/customer/profile/update-avatar` with `document.pdf` | `400 Bad Request` | Unsupported file type |
| **TC-16** | Avatar Rejection: Spoofed File | `POST /api/v1/customer/profile/update-avatar` with text file named `.jpg` | `400 Bad Request` | Magic-byte signature rejected |
| **TC-17** | Avatar Rejection: MIME Mismatch | `POST /api/v1/customer/profile/update-avatar` with PNG sent as `image/jpeg` | `400 Bad Request` | Declared type does not match bytes |
| **TC-18** | Avatar Rejection: Missing File | `POST /api/v1/customer/profile/update-avatar` with empty body | `400 Bad Request` | `Avatar file is required` |
| **TC-19** | Remove Avatar | `DELETE /api/v1/customer/profile/remove-avatar` | `200 OK` | `profileImageUrl: null`; file deleted from storage |
| **TC-20** | Remove Avatar (Already Null) | `DELETE /api/v1/customer/profile/remove-avatar` (repeated) | `200 OK` | Safe idempotent operation |
| **TC-21** | Security: Missing Token | `GET /api/v1/customer/profile/me` (No header) | `401 Unauthorized` | Access denied |
| **TC-22** | Security: IDOR Defense | Pass `{ "userId": "attacker-id" }` in body or params | Ignored | Strictly operates on token `sub` |

---

## 4. Postman & cURL Testing Guide

### Prerequisites
1. Server running locally:
   ```bash
   npm run start:dev
   ```
2. Set Postman Environment variables:
   - `baseUrl`: `https://api-puretyfarm.onrender.com`
   - `accessToken`: *(Obtained from step 1)*

---

### Step 1: Login & Obtain Access Token

**cURL**:
```bash
# 1. Send OTP
curl -X POST https://api-puretyfarm.onrender.com/api/v1/auth/customer/login \
  -H "Content-Type: application/json" \
  -d '{"mobile": "+919876543210"}'

# Check terminal console for the printed dev OTP (e.g. 123456)

# 2. Verify OTP and get accessToken
curl -X POST https://api-puretyfarm.onrender.com/api/v1/auth/customer/verify-otp \
  -H "Content-Type: application/json" \
  -d '{"mobile": "+919876543210", "otp": "123456"}'
```

Save the returned `accessToken` for subsequent requests.

---

### Step 2: Verify Profile Pre-Condition (404 Check)

**cURL**:
```bash
curl -i -X GET https://api-puretyfarm.onrender.com/api/v1/customer/profile/me \
  -H "Authorization: Bearer $ACCESS_TOKEN"
```
**Expected Response**: `HTTP 404 Not Found`

---

### Step 3: Create Customer Profile

**cURL**:
```bash
curl -i -X POST https://api-puretyfarm.onrender.com/api/v1/customer/profile/create-profile \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "firstName": "Sahil",
    "lastName": "Hode",
    "gender": "MALE",
    "dateOfBirth": "2000-01-15"
  }'
```
**Expected Response**: `HTTP 201 Created`

---

### Step 4: Verify Conflict on Duplicate Creation

**cURL**: Re-run Step 3.
**Expected Response**: `HTTP 409 Conflict` (`Customer profile already exists`).

---

### Step 5: Test Field Validations

**cURL (Invalid Gender)**:
```bash
curl -i -X POST https://api-puretyfarm.onrender.com/api/v1/customer/profile/create-profile \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"firstName": "A", "lastName": "B", "gender": "ALIEN", "dateOfBirth": "2000-01-01"}'
```
**Expected Response**: `HTTP 400 Bad Request`

**cURL (Future Date of Birth)**:
```bash
curl -i -X POST https://api-puretyfarm.onrender.com/api/v1/customer/profile/create-profile \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"firstName": "A", "lastName": "B", "gender": "MALE", "dateOfBirth": "2099-01-01"}'
```
**Expected Response**: `HTTP 400 Bad Request` (`dateOfBirth must be in the past`).

---

### Step 6: Update Profile Details

**cURL**:
```bash
curl -i -X PATCH https://api-puretyfarm.onrender.com/api/v1/customer/profile/update-profile \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "firstName": "Sahil",
    "lastName": "Patil",
    "email": "hacker@evil.com",
    "role": "ADMIN"
  }'
```
**Verification**: Name is updated to `Sahil Patil`. `email` and `role` are ignored/stripped.

---

### Step 7: Upload Customer Avatar

In Postman:
- Method: `POST`
- URL: `{{baseUrl}}/api/v1/customer/profile/update-avatar`
- Headers: `Authorization: Bearer {{accessToken}}`
- Body $ightarrow$ `form-data`
  - Key: `avatar` (Change dropdown from Text to **File**)
  - Value: Select a valid image file (`sample.jpg` $le$ 3 MB)

**cURL**:
```bash
curl -i -X POST https://api-puretyfarm.onrender.com/api/v1/customer/profile/update-avatar \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -F "avatar=@/path/to/valid-avatar.jpg"
```
**Expected Response**:
`HTTP 200 OK` with a valid signed `profileImageUrl`.

---

### Step 8: Verify Avatar Image Display

Copy the `profileImageUrl` from Step 7 and open it directly in a web browser or run:
```bash
curl -i "<SIGNED_PROFILE_IMAGE_URL>"
```
**Expected Response**:
`HTTP 200 OK`
`Content-Type: image/jpeg`
The browser displays the image correctly.

---

### Step 9: Replace Avatar (Safe Replacement Test)

Upload a different image (e.g. `avatar2.png`):
```bash
curl -i -X POST https://api-puretyfarm.onrender.com/api/v1/customer/profile/update-avatar \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -F "avatar=@/path/to/avatar2.png"
```
**Verification**:
1. Returns a new signed URL ending in `.png`.
2. Old image is cleanly deleted from Supabase Storage.
3. No orphaned files remain.

---

### Step 10: Test Avatar Security Controls

**Test 10A: Oversized File (> 3 MB)**:
```bash
# Create a 4 MB dummy file
dd if=/dev/urandom of=/tmp/large.jpg bs=1M count=4

curl -i -X POST https://api-puretyfarm.onrender.com/api/v1/customer/profile/update-avatar \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -F "avatar=@/tmp/large.jpg"
```
**Expected Response**: `HTTP 400 Bad Request` (`Avatar file size must not exceed 3 MB`).

**Test 10B: Fake Extension (Text file renamed to .jpg)**:
```bash
echo "malicious text file" > /tmp/fake.jpg

curl -i -X POST https://api-puretyfarm.onrender.com/api/v1/customer/profile/update-avatar \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -F "avatar=@/tmp/fake.jpg"
```
**Expected Response**: `HTTP 400 Bad Request` (`File signature does not match a valid JPEG, PNG, or WEBP image`).

**Test 10C: Unsupported File Type (PDF)**:
```bash
curl -i -X POST https://api-puretyfarm.onrender.com/api/v1/customer/profile/update-avatar \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -F "avatar=@/path/to/document.pdf"
```
**Expected Response**: `HTTP 400 Bad Request` (`Unsupported file type`).

---

### Step 11: Remove Avatar

**cURL**:
```bash
curl -i -X DELETE https://api-puretyfarm.onrender.com/api/v1/customer/profile/remove-avatar \
  -H "Authorization: Bearer $ACCESS_TOKEN"
```
**Expected Response**:
`HTTP 200 OK`
`profileImageUrl` is `null`. The physical file is removed from Supabase Storage.

---

### Step 12: Verify Final State via GET /me

**cURL**:
```bash
curl -i -X GET https://api-puretyfarm.onrender.com/api/v1/customer/profile/me \
  -H "Authorization: Bearer $ACCESS_TOKEN"
```
**Expected Response**:
```json
{
  "id": "...",
  "userId": "...",
  "firstName": "Sahil",
  "lastName": "Patil",
  "gender": "MALE",
  "dateOfBirth": "1999-05-20",
  "profileImageUrl": null,
  "mobile": "+919876543210",
  "email": "customer@example.com",
  "emailVerified": true,
  "createdAt": "...",
  "updatedAt": "..."
}
```
