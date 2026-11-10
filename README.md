# app-kit

The server guards my apps share, so every app fences cost and abuse the same way:

- **Rate limits** — fixed windows counted in Upstash Redis, where each policy states what happens
  when the store is down.
- **Daily budgets** — a per-subject and a global count per UTC day for paid work (a model call, a
  geocode, a mail), failing closed, with a `<FEATURE>_ENABLED=false` kill switch.
- **Security headers** — one set for `next.config`.
- **Redirect and secret checks** — `safeNextPath` for `?next=`, constant-time secret and cron
  bearer checks, and a token pre-check that refuses a malformed or forged token before the
  database is asked.

Each one is its own subpath with no framework dependency beyond the web `Request`, `Response` and
`Headers`. Nothing here imports an app's Redis client or `observability`: the counter store, the
logger and the ops alerter are passed in.

## Install

```bash
npm install github:yaniv120892/app-kit#v0.1.0
```

Then check that the lockfile's `resolved` names the tag's commit.

## Environment

The package reads only these; everything else is passed in.

| Variable            | Read by                                   | Effect                                                                           |
| ------------------- | ----------------------------------------- | -------------------------------------------------------------------------------- |
| `VERCEL_ENV`        | rate limits, daily budgets                | An unconfigured counter store is an outage only when this is `production`.       |
| `<FEATURE>_ENABLED` | `reserveDailyBudget`, `isFeatureDisabled` | `false` turns the feature off for everyone; unset or anything else leaves it on. |

The app passes `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` to the store, and its cron
secret and token-signing secret to the checks that need them.

## The counter store and reporting

Create these once, in `src/lib/guards.ts`:

```ts
import { createUpstashCounterStore } from '@yaniv120892/app-kit/counter-store';
import { createRateLimiter } from '@yaniv120892/app-kit/rate-limit';
import { logger, observability } from '@/lib/observability';

export const counterStore = createUpstashCounterStore({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

export const guardReporting = { logger, alerts: observability };

export const rateLimiter = createRateLimiter({ store: counterStore, ...guardReporting });
```

The store makes one `multi-exec` call per count with a 1 second timeout and no retry, and reports
an unset URL or token as `unconfigured` rather than throwing. `alerts` is anything with
`scheduleOpsAlert({ alertType, title })`, so the app's observability instance goes in as is.

## Rate limits

```ts
// src/app/api/auth/signup/route.ts
import { addressClient } from '@yaniv120892/app-kit/client-address';
import { refuseIfRateLimited, type RateLimitPolicy } from '@yaniv120892/app-kit/rate-limit';
import { rateLimiter } from '@/lib/guards';

const SIGNUP_RATE_LIMIT: RateLimitPolicy = {
  name: 'signup',
  limit: 5,
  windowSeconds: 60 * 60,
  whenStoreUnavailable: 'refuse',
};

export async function POST(request: Request): Promise<Response> {
  const refusal = await refuseIfRateLimited({
    rateLimiter,
    checks: [{ policy: SIGNUP_RATE_LIMIT, clientId: addressClient(request.headers) }],
    overLimitMessage: 'Too many sign-ups from this network. Try again in an hour.',
  });
  if (refusal) {
    return refusal;
  }
  // …
}
```

- `whenStoreUnavailable: 'allow'` lets requests through while the store is down and alerts at most
  once per 15 minutes per policy: use it where locking every member out is worse than a window
  with no limit (sign-in). `'refuse'` answers 503 and alerts: use it for anything that opens
  accounts, redeems invites, sends mail or costs money.
- An unconfigured store is allowed silently outside `VERCEL_ENV=production`, so a development
  server and a preview without Redis still work. On production it is an outage like any other.
- List several checks shortest window first. Counting stops at the first refusal, so a client
  retrying after a per-minute 429 does not burn its daily allowance.
- Refusals are 429 (over the limit) or 503 (store down), each with `Retry-After`. Use
  `rateLimiter.checkAll` and `rateLimitRefusalResponse` directly when the route answers in another
  shape.
- `addressClient` keys on the first `x-forwarded-for` entry, which is the client only because the
  edge proxy overwrites that header. For a signed-in user, key on `user:<id>`; for an email, key on
  a hash of it, never the address.

## Daily budgets

```ts
// src/app/api/advisor/route.ts
import { reserveDailyBudget, type DailyBudget } from '@yaniv120892/app-kit/daily-budget';
import { counterStore, guardReporting } from '@/lib/guards';

const ADVISOR_BUDGET: DailyBudget = {
  feature: 'advisor',
  subjectLimit: 20,
  globalLimit: Number(process.env.ADVISOR_GLOBAL_DAILY_LIMIT || 200),
};

export async function POST(request: Request): Promise<Response> {
  const { userId } = await requireSession(request);
  const decision = await reserveDailyBudget({
    budget: ADVISOR_BUDGET,
    subjectId: userId,
    store: counterStore,
    ...guardReporting,
  });
  if (!decision.isAllowed) {
    return advisorRefusal(decision);
  }
  // …call the model
}
```

- Reserve before the paid call. The subject's count is spent first, so a subject refused for its
  own limit never spends the global budget.
- The decision's `reason` is `disabled` (kill switch), `subjectDailyLimit`, `globalDailyLimit` or
  `storeUnavailable`; all but `disabled` carry `retryAfterSeconds`. Map them to the answer the
  feature gives.
- It fails closed: with the store down, or unconfigured on production, the feature refuses
  everyone. The first global refusal of the day raises an ops alert.
- `ADVISOR_ENABLED=false` turns the feature off without a code change; call
  `isFeatureDisabled('advisor')` to hide its UI as well.

## Security headers

```ts
// next.config.ts
import { securityHeaders } from '@yaniv120892/app-kit/security-headers';

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [
      { source: '/:path*', headers: securityHeaders({ allowedFeatures: ['geolocation'] }) },
      { source: '/agent/:path*', headers: [{ key: 'Referrer-Policy', value: 'same-origin' }] },
    ];
  },
};
```

The set is `X-Frame-Options: DENY`, `Content-Security-Policy: frame-ancestors 'none'`,
`X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`,
`Strict-Transport-Security: max-age=63072000` and a `Permissions-Policy` that turns camera,
microphone and geolocation off unless `allowedFeatures` names one. The script and style parts of a
CSP stay with the app: pass them as `contentSecurityPolicy` and `frame-ancestors 'none'` is added
unless the policy sets its own. List this entry first: when two entries set the same header for a
path, Next keeps the later one, so a path-specific header after it wins.

## Redirect after sign-in

```ts
import { safeNextPath } from '@yaniv120892/app-kit/safe-next-path';

const nextPath = safeNextPath(searchParams.get('next')) ?? '/';
```

Only a path on the same origin comes back, unchanged. Absolute URLs, `//host`, `/\host`, control
characters (browsers drop tabs and newlines, so `/\t/host` arrives as `//host`) and percent-encoded
forms of any of them give null.

## Cron and shared secrets

```ts
// src/app/api/cron/snapshot/route.ts
import { requireCronSecret } from '@yaniv120892/app-kit/secrets';

export async function GET(request: Request): Promise<Response> {
  const refusal = requireCronSecret({ request, secret: process.env.CRON_SECRET });
  if (refusal) {
    return refusal;
  }
  // …
}
```

It answers 401 to a missing or wrong `Authorization: Bearer` header and 503 to every request while
the secret is unset, so a deployment missing it shows as a failing job. `secretsEqual` compares two
secrets in constant time and never matches an empty side; `isBearerAuthorized` is the boolean form
of the cron check for other shared-secret callers.

## Token pre-check

For tokens the app signs (`<prefix><32 random bytes, base64url><16-char HMAC>`):

```ts
import { createSignedTokenFormat } from '@yaniv120892/app-kit/token-format';

export const agentTokenFormat = createSignedTokenFormat({
  prefix: 'mia_',
  purpose: 'agent-token',
  readSecret: () => process.env.JWT_SECRET,
});

// minting: agentTokenFormat.mint()
// before the lookup: if (!agentTokenFormat.isAuthentic(token)) { return unauthorized(); }
```

The layout and HMAC input match what my-investments (`mia_`, `agent-token`) and
my-expenses-website (`mxk_`, `api-token`) mint today, so adopting it keeps issued tokens valid.
With the secret unset, nothing is authentic and `mint` throws.

For unsigned tokens (`<prefix><32 random bytes, base64url>`), check the shape before the lookup:

```ts
import { hasTokenShape } from '@yaniv120892/app-kit/token-format';

if (!hasTokenShape({ token, prefix: 'msk_mcp_' })) {
  return unauthorized();
}
```

## Release

Bump `version` in the same PR as the change — Vercel caches a git dependency by version, so a
same-version change never reaches a deployed app. After the squash-merge, tag the merge commit:
`gh release create v<version> --generate-notes`.
