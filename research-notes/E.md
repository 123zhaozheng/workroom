# Research notes — group E (behaviour only; no code copied)

Sources read: DEEIX-Chat `backend/internal/{application,domain}/{channel,billing,auth,audit,user}`, `shared/channelconfig`;
LambChat `src/api/routes/scheduled_task.py`, `src/infra/scheduler/{service,runtime,conversation,locks}.py`, `src/infra/assistant/*`.

## Model routing (DEEIX `application/channel/service_routing.go`, `shared/channelconfig/breaker_defaults.go`)
- Platform model name → active routes; routes filtered by task type / protocol, then grouped by **priority**; inside a
  group **weighted random** selection; a two-level circuit breaker (upstream + model binding) with half-open probes;
  per-route rate-limit backoff; API keys chosen per upstream from an encrypted key list; unsafe base URLs skipped.
- Adopted: priority + weight, skip reasons, breaker (simplified: consecutive failures → open 30 s, in-process), local rpm
  and concurrency limits, encrypted keys, capability filtering per route. Different: routing runs *inside* pi-ai as a
  provider, so pi-durable's retries/compaction/usage keep working; failover only before any output is streamed.
- DEEIX records usage/billing per request with route info; we keep pi-durable `pi.usage` authoritative and project it.

## Billing (DEEIX `application/billing/*`, `domain/billing/epay.go`)
- Official price snapshots + per-schedule pricing; payment checkout with an external gateway (epay) and callbacks.
- Not adopted: no payment credentials → payment is **blocked**; we only compute cost = reported tokens × catalog/channel
  price, flag provider-reported totals, cost fixture usage at 0.

## Identity (DEEIX `application/auth/provider.go`)
- Multiple identity sources (password + OAuth/OIDC providers) bound to local users; admin-managed providers.
- Adopted: per-org OIDC providers, (provider, sub) binding, email-domain allow list, auto-join role; PKCE + nonce.

## Scheduling (LambChat `infra/scheduler/runtime.py`, `service.py`, `conversation.py`, `locks.py`)
- APScheduler jobs with `max_instances=1`, `coalesce=True`; timezone coercion per task; cron/interval/date triggers;
  "durable, coalesced wakeups through the authorized conversation submission path"; distributed locks for single fire;
  owner check on every API call; run history; manual trigger.
- Adopted: coalescing of missed runs (explicit policy skip|run_once, recorded), max-concurrency skip, owner-scoped access,
  submission through the normal authorized path (RuntimeService.submitInput with the re-resolved owner principal).
- Different: anti-reentrancy is a DB uniqueness claim (automation_id, scheduled_for) + pi requestId dedupe instead of
  a lock; webhook trigger with Idempotency-Key; notifications/deliveries recorded separately from run outcome.

## Assistants (LambChat `infra/assistant/*`, `api/routes/assistants.py`)
- Assistant identity separate from sessions, with tasks/acceptance state. In Workroom group A owns `rt_assistants`;
  E only exposes models/ACL and `assistantId` on automations.
