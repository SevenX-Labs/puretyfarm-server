# OTP and onboarding response times

Baseline, root cause and the first round of optimizations for the two POST
requests the customer web app waits on during sign-up:

- `POST /api/v1/auth/customer/verify-otp`
- `POST /api/v1/customer/profile/create-profile` (the onboarding "Continue")

`POST /api/v1/auth/customer/login` (send OTP) is included because it shares the
same root cause.

## How these numbers were produced

Everything below was measured on 2026-10-11 on the dev machine, never against
production. The rig:

- Throwaway `postgres:16-alpine` and `redis:7-alpine` containers, with the
  server pointed at them through a scratch env file. Postgres ran with
  `fsync=off synchronous_commit=off full_page_writes=off` so that container
  disk jitter (which produced 13 ms–658 ms swings on the same INSERT) did not
  drown out the application cost being measured.
- Durations come from the server's own `PERF_TIMING=true` request-timing
  middleware, so client and curl process overhead are excluded. 2xx only.
- "Baseline" is the code at commit `8a404e5`, built into a separate directory
  from `git archive HEAD` and run side by side with the optimized build against
  the same database and cache.

Because production talks to Supabase (ap-south-1 pooler) and a hosted Valkey
over the network while the rig is local, each flow was measured twice: once
with local services, and once with every Postgres and Valkey connection routed
through a TCP proxy that adds 10 ms in each direction (≈20 ms round-trip). The
20 ms figure is a stand-in for production network latency, not a measurement of
it — but it is what makes the round-trip count visible.

## Baseline and result

Server-side duration, median of 20–25 sequential requests:

| Endpoint | Local services | | +20 ms RTT to DB and cache | |
|---|---|---|---|---|
| | before | after | before | after |
| `auth/customer/login` | 135.4 ms | **3.2 ms** | 204.4 ms | **85.0 ms** |
| `auth/customer/verify-otp` | 286.9 ms | **11.1 ms** | 456.6 ms | **158.6 ms** |
| `customer/profile/create-profile` | 9.9 ms | **7.6 ms** | 74.5 ms | **50.2 ms** |

p95 over the same runs, with 20 ms RTT: verify-otp 528.0 ms → 230.6 ms,
create-profile 120.5 ms → 99.3 ms, login 222.6 ms → 88.7 ms.

## Root cause: Argon2 on machine-generated secrets

`verify-otp` spent most of its time in two Argon2 calls: verifying the stored
OTP hash, and hashing the newly issued refresh token. Measured on this machine
at the library's default parameters (64 MiB, t=3, p=4):

```
otp (6 chars):     hash 148.5 ms   verify 150.4 ms
jwt (300 chars):   hash 156.7 ms   verify 164.8 ms
hmac-sha256:       0.0262 ms per op
10 parallel argon2 hashes: 1212.6 ms total   (8 cores, libuv threadpool 4)
```

That is ~300 ms of CPU on the critical path of a single `verify-otp`, and
~150 ms on every `login`. The cost is not only direct: each call holds a libuv
thread and 64 MiB for its duration, and in the baseline logs the two INSERTs
that surround it reported 208–443 ms against a *local* Postgres that otherwise
answers in 0–5 ms. Under concurrency it degrades sharply — ten parallel hashes
take 1.2 s because only four can run at a time.

Argon2 is the right tool for a password: low entropy, long-lived, attackable
offline at the attacker's own pace. Neither value here has that shape. An OTP
is 6 random digits that live in Valkey for 5 minutes behind a 5-attempt counter
and per-mobile send limits — its guessing resistance comes from those limits,
not from hash cost. A refresh token is a signed JWT carrying >=256 bits of
entropy, with no dictionary to run against it.

### What replaced it

`src/common/utils/secret-hash.util.ts`: HMAC-SHA256 under a server-side pepper,
bound to a caller-supplied context.

- The pepper keeps a cache or database dump from yielding usable credentials.
  An unkeyed digest would not: 10^6 OTP candidates is a one-second rainbow
  table.
- The key is derived with HKDF from `OTP_HASH_SECRET` when set, otherwise from
  `JWT_ACCESS_SECRET` under a fixed purpose-specific `info` string. HKDF's
  domain separation makes that reuse safe, so no deployment has to add a new
  secret before this ships. Setting `OTP_HASH_SECRET` is still preferable.
- The context (`customer-otp:<mobile>`, `customer-email-otp:<userId>`,
  `refresh-token:<sessionId>`) stops a hash lifted from one subject from being
  replayed against another.
- Comparison is constant-time, and hashes carry an `h1:` prefix so the scheme
  is self-describing and can be rotated later.

**Argon2 hashes are still accepted on verify.** Refresh tokens live for 90 days
and an OTP can outlive a rolling deploy, so existing credentials keep working;
a session's stored hash is upgraded to the new format the first time it is
rotated. **Admin passwords keep using Argon2** (`crypto.util.ts`) — they are
exactly the case it is built for.

## Round-trip reductions

With remote services, each avoided round-trip is worth roughly one RTT:

- `verify-otp`: the OTP hash and the attempt counter are now read together, and
  the compare-and-delete and the attempt-counter delete are issued together —
  4 sequential Valkey round-trips down to 2. The Glide client multiplexes
  concurrent commands over its single connection.
- `login` and email-OTP send: storing the OTP and clearing the previous attempt
  counter now happen together (2 round-trips → 1).
- `create-profile`: the insert is issued together with the user read instead of
  after a pre-flight existence check, so the endpoint is one database
  round-trip instead of two. Nothing is lost — the unique index on
  `customer_profiles.userId` (P2002) and the foreign key (P2003) enforce what
  the pre-read checked, and they were already the authoritative answer under
  concurrency.
- Email verification: the pre-read of `users.email` before the update is gone;
  the unique index reports the same conflict via P2002.
- Token pairs are signed concurrently rather than one before and one after the
  session write.

## Verified

- Full suite: 1263 tests across 51 suites pass, including the existing auth
  tests that build Argon2 hashes — which is what exercises the compatibility
  path. New: `src/common/utils/secret-hash.util.spec.ts` (11 tests).
- Live against the local rig: login → verify-otp → create-profile →
  refresh → refresh, plus consumed-OTP replay, consumed-refresh-token replay
  (rejected 401), wrong-OTP, and `get-me` with a rotated access token.
- No new lint errors (the files touched report the same counts as at HEAD).

## Not done yet — ranked by expected effect

1. **`login` awaits the Fast2SMS HTTP call** (`auth.service.ts`, 5 s timeout).
   In production this is almost certainly the largest remaining component of
   send-OTP latency, and the result is already discarded — the endpoint returns
   `success: true` whether or not delivery worked. Dispatching it without
   blocking the response would cost nothing in behaviour and remove an external
   HTTP call from the critical path. Needs a decision on error semantics first.
2. **Measure production.** Everything above is dev-machine work. Enabling
   `PERF_TIMING=true` on Render gives real per-request numbers and the real
   DB/cache RTT, which is the one input simulated here.
3. **`verify-otp` still makes 2 database round-trips** (user lookup, session
   insert). A single `INSERT ... RETURNING` against an upserted user could make
   it one, at some cost in clarity.
4. **Refresh tokens issued within the same second for one session are
   byte-identical** — same payload, same `iat`. Pre-existing, not a regression:
   it gives reuse-detection a one-second blind spot, during which the
   "superseded" token is literally the same string. Adding a `jti` to the
   refresh payload would close it.
