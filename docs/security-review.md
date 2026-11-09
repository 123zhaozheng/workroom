# Workroom security review (independent)

Reviewer: independent security review. Scope: `server/src` (identity/runtime/files/knowledge/tools/ops) against the
attack surface in the brief. Repros live in `server/test/review/*.test.ts` and FAIL while the issue is present:

```
WORKROOM_DATA_DIR=/home/user/workroom/data/review \
  node --disable-warning=ExperimentalWarning --test server/test/review/<file>.test.ts
```

## Findings

| # | Severity | Affected | Repro test | Impact | Suggested fix |
|---|----------|----------|-----------|--------|---------------|
| 1 | **Critical** | `server/src/identity/oidc.ts:182-199` (`/api/auth/oidc/callback`), reachable via `/api/admin/oidc` which any org owner may call | `server/test/review/oidc-cross-org-linking.test.ts` → `review: an org-A OIDC provider cannot mint a session for a user who belongs to org B` | Full cross-tenant account takeover of any user by email. | Do not link a federated identity to a pre-existing account by email across orgs. Only auto-link/provision within the provider's own org, and require the email to belong to a member of `prov.org_id` (or an explicit, user-confirmed link). Never let one org's self-declared IdP assert identities for users of another org. |
| 2 | **High** | `server/src/tools/netpolicy.ts:35-45` (`isPrivateAddress`), used by the `browse` tool and personal HTTP MCP connectors (`server/src/tools/browser.ts`, `server/src/tools/mcp.ts:#connect`) | `server/test/review/ssrf-mapped-ipv6.test.ts` → `review: browse/MCP URL filter must block IPv4-mapped IPv6 literals for loopback and metadata` | SSRF to loopback and the cloud metadata endpoint (169.254.169.254) from a normal user, reaching host-local services and instance credentials. | Replace the hand-rolled `isPrivateAddress` with `node:net` `BlockList` (as `ops/egress.ts` already does), or normalise IPv4-mapped IPv6 in hex form (`::ffff:7f00:1`) to dotted form before the check and also match the mapped/metadata ranges. Reject all of `::ffff:0:0/96` and `64:ff9b::/96` unless the exact IP is allowlisted. |

### 1. OIDC callback links a federated identity to any existing account by email (cross-tenant takeover)

Any self-registered user is `owner` of their own org, so `requireOrgAdmin` passes and they may `POST /api/admin/oidc`
with an `issuer` they control and no client secret (public client — the attacker also runs the token endpoint). The
callback verifies the ID token **against that attacker-run issuer/JWKS**, so every claim (including `email`,
`email_verified`) is attacker-chosen. Then at `oidc.ts:187`:

```js
const existing = db.get("SELECT id FROM id_users WHERE email = ?", email); // GLOBAL, across every org
```

the flow resolves the email to a user in **any** org, links the attacker's `(provider, sub)` to that account, adds it
to the attacker's org, and `id.createSession(victimUserId, attackerOrg)` issues a session acting as the victim. From
there `/api/me/orgs` enumerates the victim's real orgs and `/api/auth/switch-org` returns a principal inside the
victim's own org (`principalFor` only checks the victim's membership, which is genuine) — full takeover, no password or
TOTP. The repro asserts the secure property (an org‑A provider must not mint a session for org‑B's user) and currently
fails because the minted session's `userId` equals the victim's.

### 2. SSRF filter misses IPv4-mapped IPv6 literals

`WHATWG URL` normalises an IPv6 host literal to compressed hex (`new URL("http://[::ffff:127.0.0.1]/").hostname` →
`[::ffff:7f00:1]`). `netpolicy.isPrivateAddress` only recognises the *dotted* mapped form
(`/^::ffff:(\d+\.\d+\.\d+\.\d+)$/`) and its generic IPv6 prefix test (`^(fc|fd|fe8|...|ff)`) does not match
`::ffff:...`, so `::ffff:7f00:1` (127.0.0.1) and `::ffff:a9fe:a9fe` (169.254.169.254) pass. `pinnedRequest` then
connects the socket straight to that address. Reachable two ways that need no Playwright for the connector path:
`browse({url:"http://[::ffff:a9fe:a9fe]/latest/meta-data/..."})` and a **personal** HTTP MCP connector whose URL is the
mapped metadata address (`mcp.ts:#connect` calls `checkUrl(url,{allowPrivate:false})` for personal scope). Note
`ops/egress.ts` (notification webhooks) uses `BlockList` and correctly blocks these, so the webhook path is not affected
— the two filters disagree.

## Checked and found OK (no issue reproduced)

- **Conversation IDOR via spaceId/conversationId mismatch** — each space has its own `durable.sqlite`; `rt.access` checks
  ACL on the passed `spaceId` then opens that space's harness, so a conversation id from another space resolves to 404.
  No project/space confusion found (SSE `/events`, `/state`, `/entries`, `/fork`, `/edit`, `/regenerate`, `/messages`,
  `/approvals`, `/tasks`, `/routes`, kb citation-status all route through the same check).
- **Tool actor re-auth / revocation / branches** — `runtime.actorForTool` re-resolves the principal and re-checks
  current ACL (`write` on the conversation) on every call; removed/disabled members and forks cannot act. Viewers cannot
  submit (write denied), so they never reach tools.
- **Agent tools with foreign ids** — `file_read`/`file_revise`/`sandbox_publish` go through `FileService.getVersion`/
  `requireFile`, which re-check the file's space ACL for the acting principal; `kb_search` filters requested `kbIds`
  against the caller's accessible set (`knowledge/service.ts` `search`, `knowledge/acl.ts`); subagent member scope
  further narrows kb access.
- **Cross-tenant admin/ops routes** — models/channels/routes/budgets/usage/trace/audit all scope by `p.orgId`; builtin
  (org_id NULL) rows are read-only; `checkEnvName` restricts channel `apiKeyEnv` to `WORKROOM_*`.
- **Automation as an owner who lost access** — `#execute` re-resolves the owner at fire time and re-checks space ACL
  (`refused` with `owner_inactive`/`no_access`); webhook triggers go through the same path.
- **Webhook egress SSRF (notifications)** — `ops/egress.ts` resolves once, pins the socket, and uses `BlockList` for
  private/metadata ranges including mapped IPv6; no redirects; per-org allowlist cannot unlock metadata.
- **Secret handling** — model/connector/OIDC/webhook secrets are AES-GCM sealed (`identity/secrets.ts`), redacted from
  MCP tool output/logs (`expandSecrets`/`redactText`), and omitted from DTOs (`channelDto`, connector dto hides command
  for non-managers, share renderers return names only). TOTP seeds sealed; `totp_last_step` gives replay protection.
- **Uploaded HTML/SVG preview** — served under a `sandbox` CSP (opaque origin, no `allow-scripts`); downloads use
  `attachment` + `nosniff` + `content-security-policy: sandbox`. No app-origin script execution reproduced.
- **Disabled/removed user tokens & 2FA** — `livePrincipal`/`resolveSessionToken` re-validate membership and session
  revocation on every request; disabling/removing a member revokes sessions; `/api/auth/login` enforces TOTP when
  enabled.
- **Sandbox isolation** — Linux user/mount/pid/net/ipc/uts namespaces, pivot_root to a read-only image, caps dropped,
  no network; `resolveIn` blocks path/symlink escape; per-space workdir. (Not exhaustively fuzzed; kernel-level escape
  out of scope.)

## Suspected, not confirmed

- **Share links for `conversation`/`file`/`kb` are inert, not leaky.** `Identity.shareGrant` is defined but no public
  endpoint consumes it, and `/api/shared/:token` only returns registered renderer content (project, automation). So a
  share token for a conversation/file/kb yields no content — a functional gap rather than a disclosure. Worth confirming
  the web client does not have another unauthenticated read path that trusts the token.

## Resolution (integrator, 2026-11-09)

| Finding | Status | Fix | Evidence |
|---|---|---|---|
| Critical — OIDC links external identity to any existing account by email | fixed | `server/src/identity/oidc.ts` callback: an existing account is linked only when the browser completing the callback is already signed in as that same account; otherwise 409 `oidc_link_required` (audited `auth.oidc_link_required`). Auto-provisioning of new accounts only for providers with a non-empty `allowed_domains`. | `server/test/review/oidc-cross-org-linking.test.ts` passes; `server/test/identity-oidc.test.ts` still passes |
| High — SSRF filter misses hex-form IPv4-mapped IPv6 | fixed | `server/src/tools/netpolicy.ts`: real IPv6 parser; embedded IPv4 extracted from mapped (any notation), IPv4-compatible, 6to4; NAT64/Teredo/ULA/link-local/site-local/multicast/documentation blocked; unparseable literals refused. | `server/test/review/ssrf-mapped-ipv6.test.ts` passes; 17-case classifier check (docs/progress.md); `tools-netpolicy.test.ts` passes |

Residual risks (documented, not fixed): email-domain ownership for OIDC auto-provisioning is declared by the org admin, not verified (no DNS TXT verification); the notification-webhook egress filter (E, `BlockList`) and the tools filter (D) are two implementations that should be unified.
Suspected-only item (share tokens for conversation/file/kb inert) is a functional gap, tracked under M09-C.
