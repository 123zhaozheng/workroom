# Research notes: models (round 4)

Sources: `node_modules/@earendil-works/pi-ai` 1.5.0 README ("Custom Providers", auth/credentials, dynamic models), `dist/models.js` (`createProvider`, `refresh`), `dist/models.d.ts`, `providers/compat-schema.d.ts`, `providers/all`.

Facts that shaped the design (verified in code, not assumed):
- `createProvider`: static `models` baseline; `fetchModels` result REPLACES same-id baseline models; `Models.refresh()` skips providers with no resolvable credential and persists through `ModelsStore`.
- `Provider.headers` is metadata only — `Models.applyAuth` merges `auth.headers` + `model.headers` + request headers. Custom headers therefore travel through `auth.resolve`.
- `ApiKeyAuth.resolve` receives the stored credential from our `CredentialStore`; the refresh credential is derived from its result (`auth.apiKey`), so bearer-style auth (no apiKey) loses the key for `fetchModels` → we read the key from the store.
- The Anthropic API implementation posts to `{baseURL}/v1/messages?beta=true`; the OpenAI SDK appends `/chat/completions` or `/responses`.
- Provider-specific behaviour keys on `model.provider` only for a handful of built-in ids (`openai`, `xai`, `openrouter`, `github-copilot`, …) and otherwise on `baseUrl`, so generic custom providers with their own ids lose almost nothing; built-ins that need native ids are registered under their native id (one instance per deployment).
- `fauxProvider` reports zero cost; test-only faux rows are priced with `calculateCost`.
- All built-in provider catalogs load in ~80 ms / 10 MB, so they are used to enrich fetched ids (same host, or Claude/GPT ids behind a relay).
- Compat schemas are exported (`CompatSchemasByApi`) and accept unknown keys; Workroom rejects unknown keys itself.

Honest gaps: no real third-party provider was exercised; Azure/Bedrock/Google built-ins are wired but untested; `?beta=true` support of arbitrary Claude relays is assumed; no circuit breaker / RPM limit any more.
