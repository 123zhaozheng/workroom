# Round 7b C: credentials - wiring for the integrator

Everything is in `server/src/tools/credentials/` plus an additive block in `shared/permissions.ts` (group `credential`, 3 permissions). Design/threat model: `docs/credentials.md`.

## server/src/tools/module.ts
```ts
import { CREDENTIAL_MIGRATIONS } from "./credentials/store.ts";
import { createCredentialExtension, CREDENTIAL_TOOL_NAMES } from "./credentials/extension.ts";
import { registerCredentialRoutes } from "./credentials/routes.ts";
// migrations (tables credentials, credential_requests):
...CREDENTIAL_MIGRATIONS.map((m) => ({ ...m, version: m.version + 1200 })), // credentials (round 7b)
// extensions(ctx): append
createCredentialExtension(ctx),
// routes(api, ctx): anywhere (no path overlaps; /credentials/status is registered before /credentials/:id)
registerCredentialRoutes(api, ctx);
```
The service `credentialsFor(ctx)` is lazy per AppContext (no `services.provide` needed).
Add `...CREDENTIAL_TOOL_NAMES` to `D_TOOLS` (knownToolNames) and to the tool policy groups in `policy.ts` if tools must be grouped there
(`credential_request`, `credential_http`, `credential_list`; they are not sandbox tools and need only write access to the space).

## V's env-name rule (optional)
Local rules already refuse reserved/dangerous names. To add V's stricter rule: `credentialsFor(ctx).envNameValidator = (name) => isCredentialEnvName(name);` (true / undefined = accepted, false or a string = refused; it can only add restrictions).

## Env injection hook for Sandbox.run (A1 / integrator)
Inside the single sandbox run path, after the actor and space are known and ACL passed, before the process is spawned:
```ts
import { credentialsFor } from "./credentials/store.ts";
const cred = await credentialsFor(this.ctx).envFor(input.principal, input.space, input.conversationId); // all env credentials consented in THIS conversation; or pass explicit ids
try {
	// merge cred.env into the child process environment for THIS run only (after V's non-secret env vars; credentials win only for their own names).
	// NEVER write cred.env to: the workspace, the image, snapshots, run records/DB rows, logs, the tool result, docker inspect labels or remote-provider metadata.
	// Record only cred.names (variable names) in the run record if you want to show "credentials injected: GH_TOKEN".
	...run...
} finally {
	cred.cleanup();
}
```
`envFor` throws (never skips silently) when an id is ineligible; with no ids it returns `{ env: {}, names: [] }` when nothing is consented. For remote drivers pass the env through
the provider's per-exec environment parameter only if the provider documents that it is not persisted; otherwise refuse (`credentials are not supported by this driver`). Network policy still applies
(the process can send the value anywhere it can reach).

## Routes (all /api, session auth)
GET `/credentials/status`, GET `/credential-requests[?status=pending]`, GET `/credential-requests/:id` (-> `{request, nonce?, store}`), POST `/credential-requests/:id/fulfill|decline|cancel`,
GET `/credentials`, GET `/credentials/:id`, POST `/credentials/:id/revoke`, POST `/credentials/:id/rotate {secret}`, DELETE `/credentials/:id`. No route returns a plaintext secret.
The HTTP layer in `core/app.ts` logs only `HttpError` codes and unexpected errors' objects (never request bodies); keep it that way and do not add body-logging middleware for `/api/credential*` or `/api/credentials*`.

## UI contract (for the web owner)
- Pending request: `ApprovalDTO`-like card from `GET /api/credential-requests?status=pending` (`CredentialRequestDTO`). Show service, purpose, **target hosts and methods prominently**, `envConsentText` + a separate consent checkbox for `usage: env`.
- Form: GET the request (gets a fresh nonce), POST fulfill; keep nothing in browser storage; clear the input after submit. A 403 `invalid_nonce` means "reload the form".
- Status doc `wr.credential-requests` (conversation doc, status only) is available for live updates; the DB row is authoritative.

## Config
`WORKROOM_SECRET_KEY` / `WORKROOM_SECRET_KEY_FILE` / `WORKROOM_SECRET_STORE` / `WORKROOM_VAULT_*` (see docs/credentials.md), `WORKROOM_CREDENTIAL_MAX_WAIT_SEC`, `WORKROOM_CREDENTIAL_EXTRA_PORTS`, `WORKROOM_CREDENTIAL_POLL_MS`. Private destinations only via the instance allowlist `WORKROOM_WEBHOOK_ALLOWLIST`.

## Tests
`server/test/credentials.test.ts` applies the migration (+1200), mounts the routes on the app's Hono before the first request and reinstalls the extension, exactly as module.ts will; after wiring those are no-ops.
