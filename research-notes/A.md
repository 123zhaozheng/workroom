# Group A research notes (runtime core)

- pi-durable 1.5.0 README + dist/harness/types.d.ts read fully; examples 12/19/20/21/22/23/31/34 read from v1.5.0 source.
- Key facts used:
  - `onWake` disables pi's own sleep timers -> host must arm timers and call `resume()`; `wake().active` while work can run.
  - Conversation view watch `docs` holds only built-in pi.* docs -> own docs (`wr.approvals`, `wr.effects`, `wr.team`) are watched with `watchDoc`, so they are created in `conversationCreated` for every conversation.
  - `fork(at)` needs a concrete visible entry -> every chat gets a display-only `wr.start` entry at creation so "edit the first message" can fork before it (parent stays in pi's ConversationRecord.parent).
  - `submit(entry: {kind:"wr.input", data})` keeps the user message for the model while the transcript shows our data (principal for ToolActor).
  - Tool replay: only `replay:"safe"` tools rerun after a crash; a close is not a crash (tools see abort). External effects need their own doc (`wr.effects`) for intent/dispatching/receipt.
  - Background subagents: anchor task `{background:true}` owns the child conversation; reporter task (background) delivers the message and posts the answer back as follow-up with requestId (example 22).
  - Storage is wrapped (public `Storage` interface, Proxy) so every `commit`/`mintId` first checks the in-memory lease expiry -> a process that lost its lease fails its Harness instead of writing.
  - Default retry policy = 3 retries, base 2000 ms; overridable via WORKROOM_RT_RETRY_BASE_MS / WORKROOM_RT_RETRY_MAX (tests use small values).
- Reference behaviour (not code):
  - LambChat chat_steer.py: steer outcome `accepted/delivered/cancelled`, steer while waiting for a human is treated specially. We map to SubmissionStatus received/queued/applied/done/unanswered/withdrawn from pi SubmissionRecord + inbox mode.
  - LambChat recovery.py: recovery lock + retry ceiling -> pi gives restartLimit + lease gives the lock.
