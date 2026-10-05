# PuretyFarm API Documentation Index

Base URL for all API requests:
```
https://api-puretyfarm.onrender.com
```

## Customer Modules
1. **[Customer Auth Documentation](./customer/auth.md)**: Phone OTP login, email OTP verification, token refresh, and logout endpoints.
2. **[Customer Profile Documentation](./customer/profile.md)**: Profile setup, update, and avatar management.
3. **[Location & Address Documentation](./customer/location.md)**: Geoapify reverse geocoding, serviceability check, state/city/area hierarchy, and customer addresses.
4. **[Subscription Plans Documentation](./customer/plans.md)**: Plan catalogue, dynamic pricing calculations, and subscription creation.
5. **[Orders Documentation](./customer/orders.md)**: Order creation, tracking, and delivery history.
6. **[Customer Wallet Documentation](./customer/wallet.md)**: Balance query, transaction ledger history, and direct credit requests.
7. **[Customer Payments Documentation](./customer/payments.md)**: PayU Hosted Checkout integration, online/cash wallet top-ups, transaction verification, and retry.

## Admin Modules
1. **[Admin Auth Documentation](./admin/auth.md)**: Dedicated admin login, session management, and password change.
2. **[Admin Customer Management Documentation](./admin/customers.md)**: Admin customer queries, filtering, search, and detailed profile inspection.
3. **[Admin Plans & Manage Delivery Documentation](./admin/plans.md)**: Plan pricing/configuration management, and customer delivery change request approval/rejection workflows.
4. **[Admin Serviceability & Locations Documentation](./admin/serviceability.md)**: State, city, and serviceable area / pincode CRUD with active/inactive availability toggling.
5. **[Admin Orders Documentation](./admin/orders.md)**: Order management and fulfillment workflows.
6. **[Admin Wallet Documentation](./admin/wallet.md)**: Wallet credit request queue, first-credit approval/rejection, and customer wallet summaries.
7. **[Admin Payments & Cash Collection Documentation](./admin/payments.md)**: Payment ledger queries, physical cash collection confirmation/cancellation, and automated PayU gateway refunds.
