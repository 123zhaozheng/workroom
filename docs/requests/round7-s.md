# Round 7 S: wiring for the integrator

## server/src/tools/module.ts
```ts
import { PROVIDER_CONFIG_MIGRATIONS } from "./sandbox/provider-config.ts";
import { registerSandboxProviderRoutes } from "./sandbox/provider-routes.ts";
// migrations:
...PROVIDER_CONFIG_MIGRATIONS.map((m) => ({ ...m, version: m.version + 900 })),
// routes: MUST be registered BEFORE registerSandboxRoutes(api, ctx), otherwise `GET /sandbox/:spaceId` swallows
// /sandbox/providers, /sandbox/provider-policy and /sandbox/instances.
registerSandboxProviderRoutes(api, ctx);
registerSandboxRoutes(api, ctx);
```
Service: `providerConfigsFor(ctx)` (lazy, per AppContext) from `provider-config.ts`; no `services.provide` needed (optional: `ctx.services.provide("sandboxProviders", providerConfigsFor(ctx))`).

## API used by A1 (driver selection / construction)
- `svc.effectiveFor(space)` -> `{kind:"local"} | {kind:"provider", provider, orgId}`; `svc.explain(space)` -> error text ("" when usable).
- `await svc.connection(orgId, provider)` -> decrypted `ProviderConnection | null` (ASYNC: re-validates the endpoint every time; throws 400 blocked_address / 409 needs_reconnect). Never log it.
- `svc.lifecycle(orgId, provider)` -> `LifecyclePolicy`.
- Tests: `svc.resolver` and `svc.factory` are replaceable test doubles.

## Routes (all /api)
GET/PUT `/sandbox/providers[/:provider]`, POST `/sandbox/providers/:provider/test {kind}`, GET/PUT `/sandbox/provider-policy` (admin only), GET/PUT `/projects/:projectId/sandbox-provider` (GET: project members; PUT `{provider: id|"local"|null}`: project.manage), GET `/sandbox/instances`.
Response shapes: PUT provider -> `{provider}`, test -> `{test}`, policy -> `{policy}`, instances -> `{instances}`, project GET -> `{provider, allowed, options[{id,label,enabled}]}`.

## Operator allowlist for private/loopback endpoints (e2e)
Reuses `WORKROOM_WEBHOOK_ALLOWLIST` (ops/egress.ts instanceAllowlist): comma-separated IPs, CIDRs or hostnames, e.g. `WORKROOM_WEBHOOK_ALLOWLIST=127.0.0.1`. The org admin must ALSO tick `allowPrivateNetwork` on the provider. No new env var. Disallowed endpoints are refused at save (400) and again at test/use.
