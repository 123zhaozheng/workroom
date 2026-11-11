# Credentials (round 7b, C)

Lets the agent use a secret (API key, token) **without ever seeing it**. The model asks; the user types the value into a form; the server seals it and,
when the agent calls `credential_http`, performs the request itself and injects the secret into one header.

Code: `server/src/tools/credentials/` (`secret-store.ts`, `store.ts`, `requests.ts`, `proxy.ts`, `extension.ts`, `routes.ts`). Tests: `server/test/credentials.test.ts`.
Wiring: `docs/requests/round7b-c.md`.

## Flow

1. `credential_request {service, purpose, targetHosts[], methods?, inject?, usage?, envName?, ttlSec?}` (replay `safe`). Arguments are validated strictly
   (hosts: exact FQDN or one leading `*.`, no IPs unless the instance allowlist names them; methods subset of GET/POST/PUT/PATCH/DELETE; header charset; template
   has `{secret}` exactly once; ttl 60 s to 30 d; env name rules). The actor (user, space, conversation) is resolved server side. A row in `credential_requests`
   is created, keyed `(space, conversation, callId)` (idempotent on replay), with a fresh nonce (only its SHA-256 is stored). The tool then waits.
2. The browser lists pending requests (`GET /api/credential-requests?status=pending`), opens one (`GET /api/credential-requests/:id`, requester only) and receives
   the form data plus a **single-use nonce**. The nonce never goes through the model.
3. `POST /api/credential-requests/:id/fulfill` `{secret, persist: "once"|"save", scope?, envConsent?, nonce}` (contract: `shared/workspace-safety.ts` section 3).
   Session auth, same-origin check, body hard-capped at 16 KB and never logged or echoed. The nonce is consumed atomically with the credential insert; a
   repeat of the same submit returns the first result (`idempotent: true`). `decline` / `cancel` are separate POSTs (requester only).
4. The tool returns `CredentialStatusForModel` only (`fulfilled` + `credentialId`, `declined`, `cancelled`, `expired`, `revoked`).
5. `credential_http {credentialId | requestId, method, url, headers?, body?}` (replay `unsafe`): the server validates, resolves DNS once, pins the socket, injects the
   secret, scrubs the response. `credential_list` returns metadata of credentials the actor may use.

### Request status: own doc, not the approvals doc
Status is mirrored into a dedicated `wr.credential-requests` doc (conversation scope, `fork: "initial"`, status only: no secret, no nonce). We did **not** reuse
`wr.approvals`: an approval means "the agent may do this dangerous thing" and a decline refuses the action; a credential request means "please type a secret
here" and a decline means "I will not give it". One UI path must never be able to approve or dismiss the other. The authoritative state is the DB row; the tool
waits by polling it (`WORKROOM_CREDENTIAL_POLL_MS`, default 500 ms), so a restart cannot lose a request: the replayed tool re-attaches by callId.

### Lifetimes
- Request wait window = `min(ttlSec, WORKROOM_CREDENTIAL_MAX_WAIT_SEC (default 3600))`; afterwards `expired` (audited `credential.expire`).
- `persist: "once"`: sealed, **not listed**, bound to the requesting conversation, `expires_at = fulfil time + ttlSec`. After expiry the ciphertext is wiped.
- `persist: "save"`: sealed in `user` scope (default) or `project` / `org` (needs `credential.manage.project` / `credential.manage.org`). No automatic expiry: revoke, rotate
  and delete are the controls.
- A run that is aborted (user stop **or** server shutdown; indistinguishable) does not cancel its request: it stays pending and answerable, which is what makes restart safe.
  It expires or can be dismissed (`decline` / `cancel`).

## Access rules
| Scope | May use (proxy) | May revoke | May rotate / delete |
|---|---|---|---|
| user | the owner | owner; org admin with `credential.manage.org` | owner |
| project | members with write access to that project's space | owner, `credential.manage.project` holders, org admins | owner, `credential.manage.project` holders |
| org | holders of `credential.use.org` (owner/admin by default) | owner, `credential.manage.org` holders | owner, `credential.manage.org` holders |

- Every use re-checks: same org, not revoked, not expired, ACL as above, principal is **not an automation** (`principal.via` is refused: nobody consented to unattended use).
- Other users / orgs get `404` for every id (existence is not confirmed). **No API returns plaintext, to anyone, including admins.** An admin can revoke; an admin cannot rotate (that would let them choose the value).
- New permissions (additive, `shared/permissions.ts`, group `credential`): `credential.manage.project`, `credential.manage.org` (critical), `credential.use.org`. Built-in roles: only owner/admin hold them (they derive from "all"); grant to others through custom roles.
- Audit actions (`id_audit`; ids, hosts, methods, status codes, never values, never URL paths or bodies): `credential.request`, `credential.fulfill`, `credential.decline`, `credential.cancel`, `credential.use`, `credential.use_denied`, `credential.revoke`, `credential.rotate`, `credential.expire`.

## Proxy guarantees (`proxy.ts`)
https only; host must match the credential's `targetHosts` (exact, or `*.` = exactly one label); port 443 unless `WORKROOM_CREDENTIAL_EXTRA_PORTS`; method must be in the
credential's methods; DNS resolved once, all addresses public (reuses `ops/egress.ts` `resolveTarget`; **only the instance allowlist** `WORKROOM_WEBHOOK_ALLOWLIST` can unlock
private ranges, org allowlists are not consulted; cloud metadata is refused unless the instance allowlist names it exactly), socket pinned to the validated address, TLS verified
for the original hostname; no redirects followed (3xx returned with its Location host); `HTTP(S)_PROXY` ignored (own `Agent`); user headers may not collide with the injected
header or be hop-by-hop; request body <= 1 MB, response <= 2 MB (truncated beyond), 30 s; response status line, shown headers and body are scrubbed of the secret and of the injected header value in
raw, base64 (all three alignments, standard and URL-safe), percent-encoded, JSON-escaped and hex forms. `Set-Cookie` is never shown. Secrets must be 8 to 8192 characters (shorter values cannot be scrubbed reliably) and, for proxy use, contain no line breaks.

`credential_http` is **replay `unsafe`**: if the run is interrupted mid-call the request is not re-sent automatically; the model gets an `interrupted` result and must check the remote
state first. Callers can pass an `Idempotency-Key` header, which is forwarded unchanged.

## Env usage (`usage: "env"`)
Only for the sandbox, only with `envConsent: true` at fulfil, bound to the conversation where consent was given (even when saved), valid, ACL ok.
`credentialsFor(ctx).envFor(principal, space, conversationId, ids?)` returns `{ env, names, cleanup }` for **one** run; the integrator must pass `env` to that process only, call `cleanup()` in `finally`, and record only `names`
(never `env`) in run records. **Honest limits:** the command and every child process can read the variable; it can be printed, written to files in `/work`, or sent over the network (network policy still applies, it is
not a barrier against the code that receives the secret). It is never written to the image or snapshot by us, but anything the process writes is the process's doing. Prefer `proxy`.

## Secret stores (`secret-store.ts`)
`WORKROOM_SECRET_STORE=local|vault-transit` (default `local`). No default or fixed key anywhere; if the selected store is not configured it is **unavailable and refuses everything** (`未配置`),
it never falls back to another store and nothing is stored unsealed. `GET /api/credentials/status` reports availability.

- **local**: AES-256-GCM (`SecretBox`, HKDF from the master key; ciphertext bound to `org|credential id|version` via AAD). Master key from `WORKROOM_SECRET_KEY_FILE` (preferred: regular file, not a symlink, mode 600/400 on POSIX; read once at start) or `WORKROOM_SECRET_KEY`; at least 16 characters (use 32 random bytes). A bad key file does not fall back to the inline key.
- **vault-transit** (HashiCorp Vault / OpenBao): `WORKROOM_VAULT_ADDR` (https; plain http only for loopback with `WORKROOM_VAULT_DEV_HTTP=1`), `WORKROOM_VAULT_TOKEN` or `_TOKEN_FILE`, `WORKROOM_VAULT_TRANSIT_KEY`, optional `WORKROOM_VAULT_TRANSIT_MOUNT` / `WORKROOM_VAULT_NAMESPACE`.
  **UNVERIFIED against a real Vault/OpenBao**: implemented against the public Transit HTTP API (`POST /v1/<mount>/encrypt|decrypt/<key>`) and tested only against a mock of it. Verify with a dev server before relying on it.
- Each credential records `store_id`; a value sealed by one store is not opened by another (`secret_storage_mismatch`).

### Ops: master key handling and rotation
- Keep the key in a secret manager / mounted file (`chmod 600`, owned by the service user). Never in the database, repo, image, environment dumps or **backups** (back up `app.sqlite` and the key separately; a backup of the DB without the key cannot be decrypted, which is the point). Losing the key makes every stored credential unrecoverable: users must re-enter them (`needs_reenter`).
- Key rotation (local): there is no online re-wrap yet. Procedure: announce, stop the service, set the new key, start, and ask owners to re-enter/rotate credentials (old rows fail with `needs_reenter`; revoke them). A re-wrap tool would need both keys at once; not implemented.
- Credential rotation (value): `POST /api/credentials/:id/rotate {secret}` by the owner: version + 1, the old ciphertext is overwritten.

## Threat model and honest limits
Protected against: the model or a prompt injection reading a secret (it never enters model input/output, chat messages, pi-durable docs/events/checkpoints, tool-call records, audit, logs; asserted in tests by scanning the whole data directory, the app DB dump, the console and audit); another user/org using or listing a credential; SSRF and DNS rebinding through the proxy; redirect-based exfiltration to another host; the upstream reflecting the secret back; replay/double-submit of the form; CSRF on the form (same-origin check; no cookie-only trust for cross-site posts); a stolen DB file without the key.

NOT protected against (be honest in UI/ops):
- A server operator or anyone with the master key plus the DB (or with code execution in the server process) can decrypt everything. Vault Transit narrows this to "needs a live Vault token".
- The target service itself: whatever host the user approved receives the secret (it is the point). Wildcards widen that; the form must show the hosts, methods and purpose to the user (UI task).
- A malicious allowed host that returns a transformed secret (e.g. encrypted) cannot be scrubbed. The scrubber handles common encodings only.
- `usage: env`: see above. A compromised sandbox command holds the plaintext for its lifetime.
- The user can be tricked into pasting a secret for an unintended purpose: the request text is model-written. The UI must make that explicit and display target hosts prominently.
- Short-lived memory: the plaintext exists in server memory (JS strings, not zeroed) during seal / use.
- No per-credential rate limiting or spend limits on the target service.
- Aborted runs leave requests pending (see Lifetimes).
