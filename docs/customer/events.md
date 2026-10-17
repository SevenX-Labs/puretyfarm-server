# Customer Real-Time Events API Specification (SSE)

This document describes the **Customer Real-Time Events System** (`RealtimeModule`) in the PuretyFarm backend, allowing frontend mobile and web apps to receive instant updates via Server-Sent Events (SSE).

---

## 1. Overview & Architecture

- **Transport**: Standard HTTP/1.1 or HTTP/2 **Server-Sent Events (SSE)** (`text/event-stream`).
- **Endpoint**: `GET /api/v1/customer/events/stream` (also available via `/customer/events/stream`).
- **Authentication**: Requires a valid `Authorization: Bearer <CUSTOMER_ACCESS_TOKEN>` header.
- **Lightweight Signals**: The stream dispatches lightweight invalidated domain signals (`sync` events) rather than heavy database entities, prompting the client to re-fetch only the affected data.
- **Heartbeat & Liveness**: The backend sends a comment line ping (`: ping\n\n`) every 25 seconds to keep proxies and firewalls from dropping the connection.
- **Token Expiry Management**: The server automatically inspects the JWT `exp` claim and closes the connection cleanly upon token expiration, prompting the client to refresh its access token and reconnect.
- **Connection Limits**:
  - Maximum 5 concurrent connections per customer (`maxConnectionsPerUser = 5`). If a 6th connection is opened (e.g. multiple tabs or devices), the oldest connection is gracefully terminated.
  - Global server connection protection: Returns `503 Service Unavailable` if the global capacity is exhausted, allowing clients to gracefully fall back to polling.

---

## 2. Event Catalog

All domain notifications are delivered under the SSE event name `sync`:

```
event: sync
data: {"v":1,"types":["orders.updated"],"ts":1729150000000}
```

### Event Types

| Event Type | Trigger | Client Action |
|---|---|---|
| `wallet.updated` | A wallet credit request is approved/rejected, online/cash top-up settles, or manual admin credit/debit occurs. | Re-fetch `GET /api/v1/customer/wallet` and `GET /api/v1/customer/wallet/transactions`. |
| `orders.updated` | An order is created, status advances (`CONFIRMED`, `DELIVERED`, `COMPLETED`), delivery is settled, or an order is reordered. | Re-fetch `GET /api/v1/customer/orders`. |
| `plan.updated` | A plan is approved by admin, scheduled, deliveries are generated, paused, resumed, or delivery skipped. | Re-fetch `GET /api/v1/customer/plans` and `GET /api/v1/customer/manage-delivery`. |
| `plans.catalog.updated` | Admin updates global plan pricing, duration, or active status. | Re-fetch `GET /api/v1/customer/plans`. |

---

## 3. Connection Handshake & Lifecycle

### 3.1 Initial Handshake
Upon connecting, the server immediately emits a `ready` event:

```text
HTTP/1.1 200 OK
Content-Type: text/event-stream
Cache-Control: no-cache, no-transform
Connection: keep-alive
X-Accel-Buffering: no

event: ready
data: {"v":1,"types":[],"ts":1729150000000}
```

### 3.2 Periodic Ping
Every 25 seconds:
```text
: ping
```

### 3.3 Domain Update Signal
When an event occurs:
```text
id: 1
event: sync
data: {"v":1,"types":["wallet.updated"],"ts":1729150005000}
```

---

## 4. Frontend Client Implementation

### JavaScript / Browser Example

Using `fetch` with `ReadableStream` (supporting `Authorization` headers):

```javascript
async function connectCustomerSSE(accessToken) {
  const response = await fetch("https://api-puretyfarm.onrender.com/api/v1/customer/events/stream", {
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Accept": "text/event-stream"
    }
  });

  if (response.status === 401) {
    // Refresh token and retry
    const newToken = await refreshCustomerAccessToken();
    return connectCustomerSSE(newToken);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n\n");
    buffer = lines.pop(); // Keep unfinished chunk

    for (const chunk of lines) {
      if (chunk.startsWith(": ping")) continue;

      const eventMatch = chunk.match(/event: (\w+)/);
      const dataMatch = chunk.match(/data: (.+)/);

      if (eventMatch && dataMatch) {
        const eventName = eventMatch[1];
        const payload = JSON.parse(dataMatch[1]);

        if (eventName === "sync") {
          if (payload.types.includes("wallet.updated")) {
            refreshCustomerWallet();
          }
          if (payload.types.includes("orders.updated")) {
            refreshCustomerOrders();
          }
          if (payload.types.includes("plan.updated")) {
            refreshCustomerPlans();
          }
        }
      }
    }
  }

  // Auto-reconnect on disconnect
  setTimeout(() => connectCustomerSSE(accessToken), 3000);
}
```

---

## 5. cURL Testing

```bash
curl -N -H "Authorization: Bearer <CUSTOMER_ACCESS_TOKEN>" \
     -H "Accept: text/event-stream" \
     https://api-puretyfarm.onrender.com/api/v1/customer/events/stream
```
