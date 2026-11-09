# Requests from the MODELS group (round 4)

## To the integrator
- **No `modules.ts` change needed.** Everything lives inside the existing `ops` module (`server/src/ops/gateway.ts`, `models-*.ts`; migration `ops` v2 in `schema.ts`, tables `model_*`).
- `docs/ops.md` §2 (channels/routes) is superseded by `docs/models.md`; I added a one-line pointer there. `docs/architecture.md` §6 ("真实 provider … 管理员配置") is still accurate.
- Edits outside my owned paths, needed to keep the suite green (all minimal): `server/src/ops/module.ts` (init → `bootstrapModels` + `gateway.load`, model ACL resolver, `wr.ops` hook also records the acting user), `server/src/ops/routes.ts` (old model/channel/route routes replaced by `registerModelRoutes`), `server/src/ops/schema.ts` (+ migration v2), `server/src/ops/rotate-secrets.ts` (+ `model_providers.api_key_enc/headers_enc/env_enc`), `server/src/ops/testing.ts` (`fauxModel` now registers faux *providers*), tests: removed `ops-gateway.test.ts` (replaced by `models-*.test.ts`), adapted `ops-usage`, `ops-observability`, `ops-admin-contract`, `ops-secrets`, `identity-crosstenant`, `runtime-team` ("blocked" model now needs a provider without a key; the env-seeded Claude/GPT placeholders are gone).
- Permissions used (already in `shared/permissions.ts`): `model.use`, `model.manage`, `model.provider.manage`.

## To the chat-UI group (web/src/pages/SettingsPage.tsx)
- Mount the personal-key section: `import { PersonalProviders } from "@/features/admin/models/ModelsAdmin";` and render `<PersonalProviders />` (renders "管理员没有开放…" when the org policy is off). `GET /api/models` additionally returns `personalProviders: boolean`, and each model has `providerName`, `providerType`, `personal`, `input`, `reasoning`, `cost`, `thinkingLevels`. Legacy `workroom/<old id>` refs are hidden from `/api/models` (include with `?include=legacy`); the picker should show a raw ref label for old conversations if it cannot find them.
- Model picker: duplicate display names from different providers are already suffixed `· <provider name>`.

## To the stats group (server/src/ops/stats.ts:383)
- `SELECT id, label FROM ops_platform_models` is now an empty legacy table. Replace with `(ctx.services.get("models") as unknown as { modelLabels(): Map<string,string> }).modelLabels()` (platform id `<provider>/<modelId>` → display name; fixture and legacy aliases included).
- `usage_ledger.platform_model_id` for new data is `<providerId>/<modelId>` (fixture: `workroom-fixture`); `route` = `message.responseModel` (falls back to `<provider>/<model>`).

## To the runtime group (A)
- `rt.checkModel` is only consulted when a conversation / assistant is created; a *later* revocation (visibility change, personal-key policy off, a collaborator continuing someone's personal-key conversation) is enforced by the gateway at request time using the acting user captured by the `wr.ops` `beforeRequest` hook (`runtime.inputForTool(api, ctx)` is called with the hook api, duck-typed). Please keep `inputForTool` working with `{conversationId, snapshot}` only. A `model_not_allowed: …` assistant error is what the user sees.
