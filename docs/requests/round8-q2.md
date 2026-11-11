# Round 8 Q2: execution environment (cloud button + "正在准备工作环境" status)

## Wiring for the integrator

`server/src/tools/module.ts` (routes, anywhere in `routes(api, ctx)`; the order does not matter, the path is unique):

```ts
import { registerEnvironmentRoutes } from "./sandbox/environment-routes.ts";
registerEnvironmentRoutes(api, ctx);
```

No migration, no new service registration. (Already added in the working tree for testing; keep or re-apply.)

## API

| Route | Access | Result |
|---|---|---|
| `GET /api/conversations/:spaceId/:conversationId/environment` | space read | `ConversationEnvironmentDTO` (shared/sandbox.ts). Never creates or connects a sandbox. `:conversationId` may be `new` (home composer, no conversation yet: same environment, state `none`). |
| `POST /api/conversations/:spaceId/:conversationId/environment/prepare` | space write + `sandbox.use` | Same DTO. Remote only, idempotent, explicit retry. Failures do not throw: they come back as `state: "failed"` + `error`. Local environments: returns the DTO unchanged. |

Another org's space: 404. A space the caller cannot access: 403. `canPrepare` is false for viewers and for a misconfigured environment (POST then answers 403).

### How `state` is decided (no probing)

- `preparing`: an in-process marker set by `RemoteDriver` while a run or a prepare creates / reconnects / syncs `/work` + mounts for this exact org/space/workspace (`remoteActivity` in `remote-driver.ts`; ends when the program starts), or a `creating` row younger than create-timeout + 30 s.
- `failed`: a failure marker (create/connect/sync/network refusal/workspace restore failed; cleared by the next successful phase), a newest row in state `error`, or a misconfiguration (provider disabled / no key / no driver → `执行环境未配置：请联系管理员…`; network "不联网" with a provider that cannot guarantee it → says runs are refused).
- `lost`: newest row `lost` / `destroyed` / `stopping`, or `ready` past its `expires_at`.
- `ready`: newest row `ready` (verified on last use, NOT re-verified by GET).
- `none`: no row for this conversation's workspace.

Hooks added to existing files (backwards compatible): `remote-driver.ts` exports `remoteActivity` / `activityKey` and `RemoteDriver.prepare()` (the same `#run` path as a run, stopping before the program starts); `sandbox.ts` gets `Sandbox.prepare()` (same provider / network-policy / workspace-restore / mounts steps as `run()`, no run record).

## UI for Q1 (`web/src/features/environment/`)

```tsx
import { EnvironmentButton } from "@/features/environment/EnvironmentButton";
import { EnvironmentStatus } from "@/features/environment/EnvironmentStatus";
```

**`<EnvironmentButton />`** props: `spaceId: string | undefined` (renders nothing until known), `conversationId?: number` (omit on home), `active?: boolean`, `side?: "top" | "bottom"` (default `"top"`), `disabled?`, `className?`.
It is a 36px (40px on phones) round icon button, same classes as the "+" button, so put it in the Composer's `tools` slot right after the "+" (the slot renders after the "+"):

- ChatPage: `tools={<EnvironmentButton spaceId={spaceId} conversationId={id} active={busy} />}`
- HomePage: `tools={<><EnvironmentButton spaceId={personalSpaceId} /><AssistantPicker ... /></>}` (for a project home pass the project's `spaceId`).

It renders nothing when the route is absent (older server) or the first GET fails. `active` only turns on light polling (every second) while the state is `none`/`lost` on a remote environment; it also polls while `preparing`, and stops by itself on `ready` / `failed` / local. Pass `busy` (turn running); if you can tell that a sandbox tool call is running, pass only that.

**`<EnvironmentStatus />`** props: `spaceId`, `conversationId: number | undefined` (nothing without it), `active?`, `className?`. Renders `null` unless the environment is remote and `preparing` (spinner line "正在准备工作环境…", hides by itself when ready) or `failed` (danger line, message, `重试` = POST prepare, `详情` for long errors, "请联系管理员" when not retryable). It is a plain block in the flow, never an overlay: put it in the message flow directly above the composer / queue (not absolutely positioned), so a pending approval card is never covered. It never blocks sending.

Both components share data through an in-memory bus (a retry in the popover updates the inline line, and the reverse). `ENV-SLOT` in `ChatPage.tsx` is the place; when using the `readOnly ? … : <Composer/>` ternary, put `<EnvironmentStatus/>` before the ternary.

Test ids: `env-button` (`data-env-kind`, `data-env-state`), `env-dot`, `env-popover`, `env-label`, `env-location`, `env-network`, `env-isolation`, `env-state` (`data-state`), `env-prepare`, `env-options`, `env-option-<id>`, `env-switch-<id>`, `env-choose-hint`, `env-admin-link`, `env-status` (`data-state`), `env-retry`, `env-detail`.

## Limits (honest)

- `ready` is the state at last use; an out-of-band delete or expiry-by-provider is only noticed on the next use (GET never probes, by design). Lifetime expiry, idle reaping and failed destroys do show `lost` without a probe.
- `preparing` markers are in the server process; a second server process serving the same DB only sees the `creating` row (create phase), not reconnect/sync.
- Switching uses the existing project override API; an existing remote sandbox is not migrated. Personal spaces cannot switch (policy: org default).
- Provider capabilities (network-off, location) come from the live driver when one is cached, else from the last connection test / placeholder.
