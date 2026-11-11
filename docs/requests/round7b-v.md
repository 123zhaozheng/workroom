# Round 7b V: sandbox environment variables - wiring for the integrator

Files: `server/src/tools/sandbox/env-vars.ts` (service, rules, `ENV_MIGRATIONS`), `env-routes.ts`, test `server/test/sandbox-env-vars.test.ts`.

## server/src/tools/module.ts
```ts
import { ENV_MIGRATIONS } from "./sandbox/env-vars.ts";
import { registerSandboxEnvRoutes } from "./sandbox/env-routes.ts";
// migrations (offset 1100):
...ENV_MIGRATIONS.map((m) => ({ ...m, version: m.version + 1100 })),
// routes (paths are /sandbox-env/..., no clash with /sandbox/:spaceId):
registerSandboxEnvRoutes(api, ctx);
```
Service: `sandboxEnvFor(ctx)` (lazy per AppContext).

## Credentials hook (group C / integrator)
`sandboxEnvFor(ctx).isCredentialEnvName = (orgId, name) => creds.hasEnvName(orgId, name);` (default: always false.) Such names are refused at write
and dropped (reported in `denied`) at resolve time.

## Sandbox.run / startService (A1 owns sandbox.ts; add these lines)
```ts
import { sandboxEnvFor, mergeSandboxEnv } from "./sandbox/env-vars.ts";
// once per command / service start (NOT cached), where the process env is assembled:
const { env: userEnv } = sandboxEnvFor(ctx).resolve(principal, space, conversationId);   // conversationId: number | undefined
const finalEnv = mergeSandboxEnv(userEnv, platformEnv);   // platformEnv last: PATH/HOME/proxy/WORKROOM_*/credential env always win
```
`principal` = the user running the conversation (their user-scope variables apply). `resolve` throws 404 if space and principal orgs differ.
Remote drivers pass `finalEnv` as the per-command env. Merge order: ordinary vars first, platform-owned and credential-injected env last.

## Rules
- Name `^[A-Za-z_][A-Za-z0-9_]{0,63}$`; value <= 4096 chars, no NUL; max 100 variables per (scope, scopeRef). `locked` only on org scope.
- Deny (case-insensitive): LD_*/DYLD_*/MALLOC_*/BASH_FUNC_*, PYTHON{PATH,STARTUP,HOME,INSPECT,USERBASE,BREAKPOINT,HTTPSVERIFY}, NODE_{OPTIONS,PATH,
  EXTRA_CA_CERTS,TLS_REJECT_UNAUTHORIZED}, PERL5OPT/LIB, RUBYOPT/LIB, JAVA_TOOL_OPTIONS/_JAVA_OPTIONS/JDK_JAVA_OPTIONS/CLASSPATH, BASH_ENV, ENV,
  PROMPT_COMMAND, SHELLOPTS, BASHOPTS, IFS, GCONV_PATH, GLIBC_TUNABLES, PATH, HOME, SHELL, USER, LOGNAME, TMPDIR/TMP/TEMP, PWD/OLDPWD, XDG_*DIR/HOME,
  PROXY and *_PROXY, SSL_*, REQUESTS_CA_BUNDLE, CURL_CA_BUNDLE, GIT_SSH*, GIT_ASKPASS, SSH_ASKPASS, GIT_CONFIG*, NPM_CONFIG_*, WORKROOM_*, SKILL_*,
  OPENSANDBOX_*, E2B_*, DAYTONA_*, plus credential env names (hook). Allowed: LANG, LC_*, TZ (TMPDIR is denied: path redirection).
- Secret-looking values are refused with "请使用凭据功能保存密钥": PEM blocks, sk-/ghp_/gho_/ghu_/ghs_/github_pat_/glpat-/xox*-/AIza prefixes, AKIA/ASIA
  keys, JWTs, `scheme://user:pass@host`, and 32+ char tokens that are hex or mixed upper/lower/digit with entropy >= 3.5.
- **This is a guardrail, not a guarantee**: heuristics miss secrets and may refuse harmless values; the deny list protects what the platform injects, not
  what code does inside its own process. Real secrets belong to the credential feature.
- Permissions: org = `sandbox.policy.manage` (read and write); project = write `project.manage`, read project members; user = the user only (other
  same-org user 403); conversation = ACL write on the space (read for GET) and the conversation must exist in it (404 otherwise). Cross-org = 404.
- Precedence conversation > user > project > org; org `locked=true` cannot be overridden (lower values ignored, reported in `denied`); personal spaces
  have no project level. Rows that violate current rules at resolve time are dropped and reported in `denied`.
- Timing: changes apply to NEW commands only (resolved at each run / service start); running processes and running services keep their env.
  Every API response carries `appliesToNewCommandsOnly: true`.
- Audit (`id_audit`, category admin): `sandbox.env.create|update|delete`, target `scope:scopeRef:name`, detail {scope, scopeRef, name, valueSha256 (12 hex),
  previousSha256, locked}. Never the value.

## API (all /api)
- `GET /sandbox-env/effective?spaceId=&conversationId=` -> `{effective: EffectiveEnvDTO}` (space read access)
- `GET /sandbox-env/:scope/:scopeRef` -> `{vars: EnvVarDTO[], appliesToNewCommandsOnly}`; scopeRef = org id / project id / user id / `<spaceId>:<conversationId>` (URL-encode)
- `PUT /sandbox-env/:scope/:scopeRef/:name` `{value, locked?}` -> `{var, appliesToNewCommandsOnly}` (400 invalid_env_var / looks_like_secret, 409 too_many)
- `DELETE /sandbox-env/:scope/:scopeRef/:name` -> `{ok, appliesToNewCommandsOnly}`
