# Requests / notes from group A (runtime)

## To integrator (shared files A may not edit)

1. `server/src/core/contracts.ts` — make the runtime extras official so C/D/E stop duck-typing (all implemented in
   `server/src/runtime/service.ts` and covered by tests):
   ```ts
   interface RuntimeService {
     // existing ...
     createConversation(principal, spaceId, options: { title?; projectId?; kind?: "chat" | "automation"; model?: ModelRef; assistantId?: string }, context): Promise<{ conversationId: number }>;
     actorForToolCall(api: ToolApiLike, context): Promise<ToolActor & { input?: InputEntryData }>; // space from the storage's wr.space doc
     inputForTool(api: ToolApiLike, context): Promise<InputEntryData | undefined>;
     spaceIdForTool(api: ToolApiLike, context): Promise<string>;
     promptScope(input: PromptInput, context): Promise<{ space: Space; principal: Principal | null } | null>; // null principal = revoked
     reinstallExtension(ext: Extension): void;
   }
   ```
   `actorForTool(api, "", ctx)` keeps working (space resolved from `wr.space`).
2. `InputEntryData.via` — widen to `{ kind: "automation"; automationId; runId } | { kind: "delegate" | "subagent_report"; id: string }`
   (runtime already writes the latter for subagent inputs/reports; typed with a cast today).
3. Optional: `docs/api.md` "会话与运行" could link to `docs/runtime.md §4`, which lists the added routes
   (`GET …/state`, `POST …/submissions/:id/withdraw`, `POST …/effects/:effectId/reconcile`, `/assistants*`, `GET /runtime/status`).

## To E (ops)

- Fixture model: keep registering `createFixtureModel().provider` in the gateway; ref `{ provider: "fixture", modelId: "workroom-fixture" }`.
  Runtime falls back to its own Models (fixture only) when no `models` service exists, and asks `models.defaultModel()` for new conversations.
- Usage projection: subagent child conversations are task-owned and are **not** in `rt_conversations`; their spend lives in
  their own `pi.usage`. Import them via the parent's `wr.team` doc (`delegations[*].childConversationId`) or by scanning
  `harness.usage()` per space, otherwise subagent cost is missed (M03-B shows it per delegation already).
- Assistants live in `rt_assistants` (runtime) because the binding and member snapshot are runtime facts (`wr.assistant` doc).
  Automations may pass `assistantId` to `createConversation` (supported).
- Budget gate: runtime calls `budget.checkSubmit` before admitting user input (HTTP 402 `budget_exceeded`) and before starting a subagent.

## To C (knowledge)

- `actorForToolCall`, `inputForTool` and `promptScope` are now real methods (see above); `input` is the **first placed input of
  the current run** (not the newest `wr.input`), so a mid-run steer does not change the run's knowledgeRefs.
- A subagent's member declaration is in its child conversation's `wr.assistant` doc as `member` (`member.knowledgeScope.kbIds`);
  please narrow `kb_search` to it when present.

## To D (files / tools)

- `actorForToolCall` and `reinstallExtension` exist now. `effects.externalEffect`: throw `EffectRejected` (exported from
  `server/src/runtime/effects.ts`) from `perform` when the target definitively refused → recorded `failed` (not reconciliation).
- Runtime does not install pi's generic `tool_search` and does not provide `HarnessOptions.env` (tools see `api.env === undefined`).
  If the sandbox needs a per-conversation `ExecutionEnv`, tell A and we will add an env factory hook.

## To B (web)

- Contract: `shared/chat.ts` + `docs/runtime.md §4`. SSE `snapshot`/`state` carry a full `ConversationState`; render
  `live.partial` while streaming, `approvals` (pending → card with approve/reject), `effects` (`needs_reconciliation` → 待核对 card
  with reconcile action), `subagents` (child transcript at `GET /conversations/:spaceId/:childConversationId/entries`),
  `queue` (queued steers / follow-ups with withdraw). Label fixture answers (`fixture: true`) as “测试模型，非真实 AI”.
