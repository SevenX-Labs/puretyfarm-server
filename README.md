# PuretyFarm Server Backend

Backend API server for PuretyFarm built with [NestJS](https://nestjs.com/), TypeScript, Prisma ORM, and PostgreSQL.

## 🌐 Base URL
All API requests must be sent to the base URL:
```
https://api-puretyfarm.onrender.com
```

Both versioned (`/api/v1/...`) and direct routes are supported across modules.

---

## 📚 API Documentation

Detailed endpoint specifications, DTOs, response schemas, and cURL examples are available in the [docs](./docs) directory:

### 👤 Customer APIs
- **[Customer Authentication](./docs/customer/auth.md)** (`https://api-puretyfarm.onrender.com/api/v1/auth/customer`)
  - Phone OTP Login & Verification (`/login`, `/verify-otp`)
  - Email OTP Send & Verification (`/send-email-otp`, `/verify-email-otp`)
  - Token Refresh (`/refresh-token`) & Logout (`/logout`)
- **[Customer Profile](./docs/customer/profile.md)** (`https://api-puretyfarm.onrender.com/api/v1/customer/profile`)
  - Profile Retrieval (`/me`), Creation (`/create-profile`), Updates (`/update-profile`)
  - Avatar Upload & Deletion (`/update-avatar`, `/remove-avatar`)
- **[Location & Serviceability](./docs/customer/location.md)** (`https://api-puretyfarm.onrender.com/api/v1/customer/locations`)
  - Location Detection & Reverse Geocoding (`/locations/detect`)
  - Hierarchical Serviceability Discovery (`/states`, `/states/:id/cities`, `/cities/:id/areas`)
  - Address Book CRUD (`/addresses`)
- **[Subscription Plans & Quotes](./docs/customer/plans.md)** (`https://api-puretyfarm.onrender.com/api/v1/customer/plans`)
  - Active Plans Discovery (`/`)
  - Real-time Price Quotation for Buy Once, Trial, and Monthly Plans (`/buy-once/quote`, `/trial/quote`, `/monthly/quote`)
  - Plan Confirmation & Subscription Creation (`/confirm`)

### 🛡️ Admin APIs
- **[Admin Authentication](./docs/admin/auth.md)** (`https://api-puretyfarm.onrender.com/api/v1/auth/admin`)
  - Admin Login (`/login`)
  - Current Admin Info (`/get-me`)
  - Admin Password Change (`/change-password`)
- **[Customer Management](./docs/admin/customers.md)** (`https://api-puretyfarm.onrender.com/api/v1/admin/customers`)
  - Paginated Customer Listing with Search & Filters (`/`)
  - Single Customer Detail View with Profiles, Subscriptions & Addresses (`/:id`)
- **[Admin Plans & Manage Delivery](./docs/admin/plans.md)** (`https://api-puretyfarm.onrender.com/api/v1/admin/plans` & `.../manage-delivery`)
  - Plan Pricing, Limits, Frequency & Quantity Mode Config (`/plans`)
  - Customer Delivery Change Requests (Pause, Resume, Skip, Change Qty) Review & Approvals (`/manage-delivery/requests`)

---

## 🚀 Getting Started

### Prerequisites
- Node.js (v18+)
- PostgreSQL Database
- Valkey / Redis Server

### Installation
```bash
npm install
```

### Environment Variables
Configure your `.env` file:
```env
PORT=3000
DATABASE_URL="postgresql://..."
VALKEY_URL="rediss://..."
JWT_ACCESS_SECRET="..."
JWT_REFRESH_SECRET="..."
JWT_ADMIN_ACCESS_SECRET="..."
JWT_ADMIN_REFRESH_SECRET="..."
GEOAPIFY_API_KEY="..."
CORS_ORIGIN="https://puretyfarm.in,http://localhost:3000"
```

### Database Setup & Migrations
```bash
npx prisma migrate dev
npm run seed
```

### Compile & Run
```bash
# Development mode
npm run start

# Watch mode
npm run start:dev

# Production build & run
npm run build
npm run start:prod
```

### Run Tests
```bash
# Unit tests
npm run test

# End-to-end tests
npm run test:e2e

# Test coverage
npm run test:cov
```
