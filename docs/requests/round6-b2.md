# Round 6 B2: skills created in conversation (`skill_manage`) - wiring request for the integrator

Everything lives in `server/src/tools/skill-drafts.ts`. It only uses public APIs (Sandbox.workdir, Market.upload/policy/can/audit,
effects.requestApproval, skills-package.ts, the runtime actor resolver). It needs NO edits in B1 files except the three lines below in
`server/src/tools/module.ts`. The service (`skillDraftsFor(ctx)`) is created lazily per AppContext, so no `services.provide` is needed.

## 1. server/src/tools/module.ts

Import:
```ts
import { createSkillManageExtension, registerSkillDraftRoutes, SKILL_DRAFT_MIGRATIONS } from "./skill-drafts.ts";
```
Migrations (new unused offset **800**; table `skill_ws_drafts`, additive):
```ts
		...SKILL_DRAFT_MIGRATIONS.map((m) => ({ ...m, version: m.version + 800 })), // skill drafts (round 6, B2)
```
Extension: append `createSkillManageExtension(ctx)` to the array returned by `extensions(ctx)`
(e.g. after `createSkillsExtension(ctx)` / its round-6 replacement).

Routes: inside `routes(api, ctx)`, next to `registerMarketRoutes(api, ctx)`:
```ts
		registerSkillDraftRoutes(api, ctx); // GET /api/skill-drafts/:id  (owner only) -> { draft: SkillDraftDTO }
```

If `skill_manage` must be offered under a tool group / policy (server/src/tools/policy.ts TOOL_GROUPS) or listed in `D_TOOLS`
(knownToolNames in module.ts), add `"skill_manage"` there. It is not a sandbox tool: it requires write access to the conversation's space
and the same personal-skill permission as Market.upload (`skill.upload`, or `skill.publish` when org policy is `disabled`).

## 2. Behaviour the UI can rely on
- Approval: `ApprovalDTO.toolName === "skill_manage"`, `detail.kind === "skill_draft"` (SkillDraftApprovalDetail), `risk` low (prompt-only) /
  medium (scripts, permissions, exec/prompt-injection warnings) / high (network, sensitive paths, obfuscation, hidden characters).
  `title` = `保存为个人技能：<title>`, `summary` = `保存为仅你可用的个人技能 v<ver>；不会自动执行，也不会发布到商城` (update: `在你已有的个人技能「x」上新增版本 v<ver>（仅你可用）；...`; policy review adds `组织策略要求审核：保存后需通过审核才能使用`).
- Draft states: pending -> saved | rejected | failed. Error findings never open an approval (state `failed`, tool result `isError`).
- Tool result `details`: `{ draftId, state, skillId?, versionNo? }`.
- Audit actions (id_audit): `skill.draft.submit`, `skill.draft.saved`, `skill.draft.rejected`, `skill.draft.failed`.

## 3. Tests
`server/test/skills-drafts.test.ts` installs the extension into the running runtime itself (`runtime.reinstallExtension`) and applies the
migration with `db.migrate("tools", ... version + 800)`, exactly as module.ts will; after wiring both are no-ops (same extension name
`wr.skill-manage`, same migration key). It drives the real agent loop (fixture model), real approvals and a real restart.
After wiring, the end-to-end check is simply the same file (optionally delete the `wire()` helper body).

## 4. Dependencies on B1 / other files
None beyond public methods: `Market.upload/policy/can/audit`, `Skills.skill/version/active/resolveForUse` (tests only),
`Sandbox.workdir`. If B1 renames `Market.upload` or changes its `files` input shape, `SkillDrafts.save` is the single call site.
