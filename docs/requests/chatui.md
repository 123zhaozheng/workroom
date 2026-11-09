# Requests from the chat UI group (round 4)

## To runtime (group A) — switching the model of an existing conversation
The composer's model switcher calls `PATCH /conversations/:spaceId/:id` with `{ modelId, thinkingLevel? }` (platform model id, same
resolution as `POST /conversations`) and then re-reads `GET /conversations/:spaceId/:id`. Today the route only handles
`title` / `archived`, so the UI shows the real model and a note ("服务端目前只在创建对话时确定模型"). Once the route applies the change
(and `agent.model` / `agent.thinkingLevel` reflect it) the note disappears by itself; no UI change needed.

`POST /conversations` is already sent `thinkingLevel` next to `modelId`; the runtime currently ignores it (only the model's default level applies).

## To models (group E)
- The switcher reads `GET /models` tolerantly: `provider` as string or `{id,name}`, `providerName`, `capabilities` as array or object,
  `thinkingLevels`, `defaultThinking`, `contextWindow`, `description`, `isDefault`, `status`/`statusDetail`, `fixture`. Please add a human
  provider name (group header) — today real models carry the internal routing id `workroom`, shown as "平台模型".
- The server default (`defaultModelId`) is a ready real model as soon as one exists; the fixture model then only appears when picked.

## To integrator
- A user-level default model is kept in the browser (localStorage `wr.model.default.v1`). If a server-side user preference store is added
  (`GET/PUT /me/preferences`), the composer can switch to it without UI changes beyond `readDefaultChoice/writeDefaultChoice` in `features/composer/models.ts`.
- `web/src/lib/prefs.tsx` gained `dotMatrix` and `SettingsPage.tsx` a toggle row (both outside the chat paths; additive).
