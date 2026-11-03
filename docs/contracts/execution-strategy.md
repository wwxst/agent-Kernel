# Domain Execution Strategy contract (DES v0.1)

> **Status: ACCEPTED for construction (ARB-01, 2026-11-03); implementation NOT started; no benchmark result exists.** This contract makes domain-specific execution policy **data**, so one Kernel loop can run Coding, Video, Office or Browser workflows without Kernel branches. It grants no authority, owns no assurance requirement (that belongs to `VerificationPolicy`), weakens no safety floor, and defines no domain semantics. Numbers in §7 are **provisional design hypotheses for tuning**, not measured results.

## 1. Problem and chosen trade-off

One shared Kernel, two initial domains, and future domains whose bottlenecks differ:

| Domain | Dominant cost driver | Strategy focus |
| --- | --- | --- |
| Coding | model round-trips, repository search, repeated test/build runs | incremental code context, fast locate, targeted/on-demand verification, serialized writes |
| Video | asset probing/analysis, preview generation, rendering | immutable metadata/proxy cache, bounded parallel analysis, asynchronous long jobs, media resource admission |
| Office | document parsing, external API latency/limits, batch edits | structured range operations, response caching, request batching, OAuth scope and rate-limit control |
| Browser | page load, interaction waits, DOM churn | incremental page-state projection, event-driven waits, timeout/retry budgets |

Three alternatives were considered:

1. **Kernel branches per domain.** Rejected: every new domain edits the Kernel loop/state machine, contradicting the approved extension invariant, and multiplying the regression surface of the authority core.
2. **One identical policy for all domains.** Rejected: forces Video into serialized model-bound steps (render/probe concurrency lost) and Coding into media-style parallel job admission (write conflict risk), so both run slower without being safer.
3. **Strategy as versioned data bound to the DomainBinding, with a Kernel floor.** Selected: Kernel enforces generic ceilings/floors deterministically; the adapter owns domain semantics and proposes strategy values; tuning is a data/profile change with L2 impact analysis, not a Kernel code change.

**Falsification:** if a domain's required behaviour cannot be expressed in the fields of §4 without exceeding the Kernel floor or changing a Kernel state transition, the strategy contract is insufficient and the extension boundary must be reopened — the correct response is *not* to add a domain branch to the loop.

## 2. What a strategy may and may not control

| May control (policy, bounded by floor) | May never control (authority) |
| --- | --- |
| Decision cadence, fast-path eligibility, number of model steps per step class | Whether a ToolInvocation is admitted, its effect class, or its budget reservation |
| Context selection size, cache policy, compaction triggers | Whether evidence is trusted, current, or sufficient for a criterion verdict |
| Per-effect-class concurrency and batching | Host launch rights, nonce/fence semantics, cancellation convergence |
| Wait/poll/backoff and external-job wake policy | Terminal state choice; Completion Guard remains deterministic |
| Verification triggers, shadow-audit sampling and extra checks above the policy floor | The required evidence class, independence floor or human gate — owned solely by `VerificationPolicy`; the floor itself; UNKNOWN handling |

A strategy is an immutable, content-digested object referenced by `DomainBinding.strategy_ref` ([Data model](kernel-data-model.md#34-domainbinding-and-workflow-profile)). Activations and changes follow the profile rules: new version → impact analysis → L2 cutover when protected effects, resources or assurance obligations change.

## 3. Kernel safety floor (non-overridable)

The Kernel rejects any strategy that would authorize, weaken or omit the following. These are checked once at binding validation and re-checked cheaply at admission for fields that can drift.

| # | Floor |
| --- | --- |
| F1 | Every effect still requires its own ToolInvocation admission, budget reservation, durable intent and Host gate. |
| F2 | `R2` effects remain disabled unless a separate owner decision enables the exact class; no strategy field can raise an effect class. |
| F3 | UNKNOWN is never retried, downgraded or reclassified by strategy; only reconciliation evidence resolves it. |
| F4 | Every accepted acceptance criterion retains its required evidence class and independence; no strategy may reduce a profile's verification obligation. |
| F5 | A deterministic Completion Guard always executes; a fast path may skip *model review*, never the Guard or a mandatory check. |
| F6 | Cancellation, deadline and no-progress dispositions remain typed and bounded; strategy may set bounds within stated maxima, not remove them. |
| F7 | Per-Task write serialization holds unless a proven disjoint conflict scope exists; strategy cannot declare an unproven scope disjoint. |
| F8 | Resource limits are ceilings; strategy may lower them, never raise them above the profile/Host capability. |
| F9 | Cache entries are keyed by source digest + tool/parser version + scope + privacy policy; a strategy cannot key caches by path, summary text or time alone. |
| F10 | External/user waits must persist an owner and `max_wait_until`; no strategy may create an unbounded poll loop. |
| F11 | Cross-domain bytes require a `ScopedReadGrant`; caching never crosses an authorization boundary or outlives revocation. |
| F12 | The strategy cannot introduce Kernel-visible domain semantics (no `if domain_id`, no domain-specific terminal state, no domain-specific evidence trust rule). |

## 4. Strategy schema

All fields are required unless marked optional. Numeric values are **policy ceilings** interpreted as "at most"; a value of `0` means "not permitted". `null` means "not applicable". Durations are integer milliseconds.

### 4.1 Identity and binding

| Field | Type | Meaning | Kernel check |
| --- | --- | --- | --- |
| `strategy_id`, `version`, `digest` | id/version/digest | Immutable identity | digest matches binding |
| `domain_id` | string | Namespace only | must equal binding's domain; **never inspected for behaviour** |
| `contract_version` | `"0.1"` | DES version | supported major |
| `owner`, `rationale_ref` | string, ref | Who tuned it and why | present |
| `tuning_evidence_ref` | ref \| null | Benchmark/ablation reference once available | must be `null` before B-gates; never fabricated |
| `created_at`, `supersedes` | timestamp, id \| null | Lineage | immutable |

### 4.2 Decision and fast-path policy

| Field | Type | Meaning |
| --- | --- | --- |
| `planning_mode` | `full_plan \| incremental_plan \| deterministic_only` | When a PlanRevision is needed. `deterministic_only` is valid only for a single fixed pipeline with no adaptive decisions. |
| `max_model_steps_per_task_class` | map `task_class -> int` | Hard ceiling. Exceeding it parks `BudgetAction`/`NoProgress`, never silently continues. |
| `fast_path.eligible_task_classes[]` | strings | Task classes allowed to skip a dedicated planning model call. |
| `fast_path.require_independent_oracle` | bool | Must be `true` when the fast path skips semantic review for a protected criterion. |
| `fast_path.max_repair_rounds` | int (0..profile max) | Per-PlanStep repair bound before L2/diagnose/stop. |
| `decision_batching` | `single \| plan_then_act \| act_per_item` | Whether one decision may carry several bounded items. Batching reduces round-trips; Kernel still admits each item. |
| `preferred_purpose_sequence[]` | enum[] | Advisory ordering (`tactical`, `assurance`, …); not a mandatory multi-call chain. |

### 4.3 Context policy

| Field | Type | Meaning |
| --- | --- | --- |
| `context.input_token_ceiling` | map `purpose -> int` | Per-purpose assembly ceiling, enforced by Context Engine before a model call. |
| `context.retrieved_item_cap` | map `purpose -> int` | Max distinct sources per assembly (files, symbols, ranges, sections). |
| `context.mandatory_sections[]` | enum[] | Sources that must be present when relevant (goal, criteria, current step, unresolved UNKNOWN). |
| `context.compaction_trigger` | `{token_pct, turn_count, milestone}` | When to compact; never drops unresolved effects/approvals. |
| `context.summary_policy` | `none \| referenced \| hierarchical` | Summaries must always link to raw sources. |
| `context.cache` | `{enabled, ttl_class_map, max_entries, invalidation: digest_deps}` | See F9. |
| `context.truncation_record` | bool (must be `true`) | Record `was_truncated` + cursor on every truncation. |

### 4.4 Scheduling, batching and resource policy

| Field | Type | Meaning |
| --- | --- | --- |
| `schedule.max_concurrent[effect_class]` | map | `R0` may exceed 1; `R1` defaults to 1; `R2` must be 0 unless enabled. |
| `schedule.disjoint_scopes[]` | scope descriptors | Only proven disjoint scopes may run concurrently. |
| `schedule.batch_tool` | bool | Whether independent R0 reads may be dispatched as one admitted batch (each still an Invocation). |
| `schedule.fairness` | `{per_task, per_principal, per_class}` | Queueing policy; prevents one long render monopolizing a Host. |
| `resource.requested[]` | resource vector | Dimensions the strategy expects; must be ⊆ profile-supported. |
| `resource.per_task_cap`, `resource.per_host_cap` | resource vector | Cannot exceed profile/Host limits. |
| `resource.admission_timeout_ms` | int | Queue wait bound before a typed `ResourceUnavailable` disposition. |

### 4.5 Wait, async and progress policy

| Field | Type | Meaning |
| --- | --- | --- |
| `wait.external_job_wake` | `event \| bounded_poll` | Default `event` (Host outbox/status), not LLM polling. |
| `wait.poll_interval_ms`, `wait.max_poll_attempts` | int | Only for `bounded_poll`; both bounded. |
| `wait.max_wait_ms` | map `reason_code -> int` | Hard bound per reason; expiry triggers one deterministic decision. |
| `progress.evidence_required` | bool (must be `true`) | Only new accepted evidence/artifact/version/blocked-resolution counts as progress. |
| `progress.max_consecutive_no_progress` | int (1..10, default 3) | Then diagnose once; then wait or terminal. |
| `progress.max_same_step_repairs` | int (0..5, default 2) | Then require new evidence, user action or L2. |

### 4.6 Verification and termination policy

| Field | Type | Meaning |
| --- | --- | --- |
| `verify.policy_ref` | `{policy_id, version, digest}` | **Required.** The sole source of required evidence class, independence floor and human gates ([Data model §3.16](kernel-data-model.md)). Kernel checks that the digest matches the binding. |
| `verify.check_catalog_ref` | `{catalog_id, version}` | Domain check catalog; Kernel validates that referenced check ids are declared in the manifest. |
| `verify.additional_triggers[]` | enum[] (`implementer_authored_oracle`, `low_confidence_evidence`, `protected_input_changed`, `high_impact_claim`, `disputed_evidence`, `manual_request`) | **Tightening only.** Adds review when the policy minimum is already satisfied; cannot remove a policy trigger. |
| `verify.additional_human_gates[]` | criterion ids / classes | **Tightening only**; cannot remove a policy human gate. |
| `verify.shadow_audit_rate` | `0..1` | Fraction of skipped semantic reviews sampled for audit. Must be `> 0` whenever the policy permits a skip. |
| `verify.review_deadline_ms` | int | Bound on the review wait; expiry parks the Task with a typed wait. |
| `terminate.task_deadline_ms` | int \| null | Wall-clock bound; expiry → safe-stop protocol then typed terminal. |
| `terminate.step_deadline_ms` | int | Per-Step bound. |
| `terminate.retry_classes` | map error-code -> max attempts | Bounded; `OutcomeUnknown` must map to 0 automatic retries. |
| `terminate.degraded_delivery` | `forbidden \| explicit_criteria` | A partial result may be delivered only under explicit accepted criteria, never silently. |

## 5. Validation algorithm (deterministic)

`ValidateStrategy(strategy, profile, binding)`:

1. Schema/version/canonical digest check; reject unknown required fields.
2. `domain_id` equals binding domain (namespace consistency only).
3. Every referenced enum, tool class, resource dimension and error code is known to this Kernel version.
4. Floor check F1–F12; any violation is `StrategyRejected` with the failing floor id.
5. Envelope check: every value ≤ profile limit (concurrency, resource, token ceilings, deadlines) and every assurance value ≥ profile minimum.
6. Deadline/consistency check: `step_deadline ≤ task_deadline`; `admission_timeout ≤ task_deadline`; `max_wait` values positive; no `0`-timeout loops.
7. Internal consistency: `semantic_review=never` requires no criterion with semantic independence; `deterministic_only` requires no adaptive step; `max_concurrent[R1] > 1` requires non-empty `disjoint_scopes`.
8. Record `strategy_digest` in the binding and emit `DomainBindingValidated`.

Admission-time recheck (cheap, no domain interpretation): current `strategy_ref` digest equals the binding's; effective concurrency/resource ceilings still within Host capability; no floor drift.

## 6. Why the Kernel needs no domain branch

The loop reads only generic strategy fields:

```text
wake(task):
  if terminal: reconcile outboxes; return
  if cancel/deadline/authority-changed: safe_stop()
  if conflicting UNKNOWN: reconcile_or_park()
  if wait_active and not due: return
  if completion_possible(): if CompletionGuard(): commit_terminal(); return
  if missing_mandatory_evidence(): next = adapter.verifyCriteria(...)      // domain decides *what*
  else if strategy.decision.fast_path.eligible(state): next = adapter.decideNext(...)
  else: next = adapter.decideNext(...)                                    // same call, different context budget
  candidates = bound_items(next)                                          // generic envelope
  for item in candidates:
      if invocation(item) conflicts with running/UNKNOWN: park_or_serialize()
      admit(item)  // read_set, effect class, budget, approval, Host ticket
  schedule per strategy.schedule and proven conflict scopes
  wait per strategy.wait; wake on Host events, not model spins
```

`decideNext`, `verifyCriteria`, `interpretOutcome`, `projectContext`, `describeRecovery` come from the domain adapter ([Domain Extension](domain-extension.md)). The loop branches on **state and policy values**, not on `domain_id`. A grep-level conformance check (S-1) forbids `domain_id` string comparisons in the Kernel source tree.

## 7. Reference strategies (hypotheses, not results)

Each domain starts from a minimal strategy; numbers are starting points to be calibrated by the E-gates. They are **ceilings**, so the system stays correct if the model needs fewer.

### 7.1 Coding

| Field | Value | Rationale |
| --- | --- | --- |
| `planning_mode` | `incremental_plan` | A full plan for a small fix wastes a round-trip; the plan is revised on information. |
| `decision_batching` | `plan_then_act` | One decision may propose a locate+read batch; edits are admitted individually. |
| `max_model_steps_per_task_class` | `simple: 6, complex: 20` | Bound runaway loops; calibrated by C-evaluation. |
| `context.input_token_ceiling` | `planning: 24k, tactical: 16k, assurance: 20k` | Prefer structural locate (symbols/diffs) over repository dumps. |
| `context.cache.ttl_class` | `source: until digest change, test_output: 1 run, parse_index: until tool version change` | Repeated test design must not re-read the whole repo. |
| `schedule.max_concurrent` | `R0: 4, R1: 1, R2: 0` | Parallel reads; serialized writes/tests that share a worktree. |
| `wait.external_job_wake` | `event` | Build/test completion wakes the loop; no polling model calls. |
| `verify.policy_ref` | policy version whose floor applies | Never overridable by strategy |
| `verify.additional_triggers` | `risk_triggered` extras | Independent tests plus Guard remain mandatory; trigger a fresh review for implementer-authored oracles |
| `verify.shadow_audit_rate` | `0.1` for Coding | Sampled audit of skipped reviews; enables false-completion measurement |
| `verify.review_deadline_ms` | `600000` | Bounds human/reviewer wait |
| `terminate.max_consecutive_no_progress` | `3` | Diagnose once, then replan or stop. |
| `repeat_test_policy` | `rerun only when bound inputs changed or a repair occurred` | Avoid the "same red test three times" loop; freshness is bound by digest. |

### 7.2 Video

| Field | Value | Rationale |
| --- | --- | --- |
| `planning_mode` | `full_plan` for multi-beat edits, `deterministic_only` for a single fixed pipeline task | Narrative structure needs a plan; a pure transcode task does not. |
| `decision_batching` | `plan_then_act` | Several analysis jobs per decision, each separately admitted. |
| `context.input_token_ceiling` | `planning: 20k, tactical: 12k, assurance: 16k` | Media evidence is referenced by time ranges, not raw frames. |
| `schedule.max_concurrent` | `R0 probe/analyze: 4, R1 render: 1 per Host, R2: 0` | Parallel analysis, serialized publication; GPU/disk bounded. |
| `resource.per_task_cap` | `{gpu_ms, disk_bytes, output_bytes, media_input_seconds}` declared by profile | Render must be admission-controlled, not best-effort. |
| `wait.external_job_wake` | `event` with bounded status polling ≤ 1/min | Long renders must not burn model turns. |
| `verify.policy_ref` | Video verification policy version | Owns required evidence class, independence and human gates |
| `verify.check_catalog_ref` | `video.checks.v1` | `decode/probe/stream/timeline-invariant/audio-integrity` are mandatory checks, never delegated to a model |
| `verify.additional_triggers` | `high_impact_claim`, `disputed_evidence` | Tightens review; cannot skip rendered-output inspection |
| `verify.shadow_audit_rate` | `0` when every content criterion is always reviewed | No skipped review to audit |
| `cache` | `probe: immutable per source digest; proxy: per proxy spec; shot/transcript: per analyzer version` | Asset processing dominates cost; cache must be provenance-keyed. |

### 7.3 Office (illustrative, non-normative)

The Office block is an **example** of expressing a different bottleneck, not a registered domain:

| Field | Value |
| --- | --- |
| `planning_mode` | `incremental_plan` |
| `schedule.max_concurrent` | `R0 read: 2, R1 edit: 1 per document/range, R2: 0` |
| `resource` | `external_api_calls_per_minute`, `document_bytes` as declared dimensions |
| `wait.external_job_wake` | `event`; OAuth/rate-limit waits are `RateLimit` WaitRecords |
| `verify.policy_ref` | Office verification policy (evidence class + human gate for share/publish/delete) |

### 7.4 Browser (future example, illustrative only)

`wait` is event-driven on navigation/DOM-quiescence with hard timeouts; `context` prefers incremental page-state diffs; `schedule.R0` may run parallel tab reads only with proven isolation; `verify` uses deterministic DOM/assertion checks plus risk-triggered visual review.

## 8. Change control

- A strategy change that alters effect classes, resource ceilings, assurance floors or human gates is **L2**: new binding candidate, impact analysis, freeze/drain/reconcile/cutover.
- A tuning change within the same envelope (e.g. token ceiling 16k→12k, concurrency 4→2) is a new strategy version bound by a profile patch; it still requires a digest change, audit event and re-validation, but not a plan cutover.
- Strategy versions used by completed tasks remain readable for provenance; they never retroactively change historical evidence.

## 9. Conformance fixtures (design; NOT RUN)

| Fixture | Setup | Expected |
| --- | --- | --- |
| S-1 no domain branch | Static scan of the Kernel module for `domain_id` comparisons and domain-name literals; scan the shared record schemas for Coding/Video field names | No behavioural branch and no domain-shaped shared field; only namespace validation and `domain_evidence_refs[]` |
| S-2 floor violation | Strategy sets `semantic_review=never` while a criterion requires semantic independence | `StrategyRejected(F4)`, no binding |
| S-3 ceiling escalation | Strategy requests concurrency 8 when profile permits 2 | reject; profile wins |
| S-4 deadline consistency | `step_deadline > task_deadline` | reject |
| S-5 Coding fast path | Simple inspect+fix task, independent tests present | ≤ 2 model steps if evidence suffices; Guard runs; no fresh reviewer; no skipped test |
| S-6 Coding no-progress | Same failing test three times with no new evidence | one diagnosis, then L2/wait/`NoProgress`; zero further identical reruns |
| S-7 Video async render | Render runs 20 min; no progress events for 5 min | loop parked on event; zero model spins; cancellation still converges |
| S-8 Video assurance | Fast path proposes to skip rendered-output inspection | rejected by floor F4/F5; inspection mandatory |
| S-9 Cache invalidation | Source digest changes while a cached analysis exists | cache miss; stale evidence marked and re-requested |
| S-10 Revocation during cached read | Grant revoked mid-stream | resolver stops further bytes; no cache hit after revocation |
| S-11 Office rate-limit | API returns 429 with retry-after | `RateLimit` WaitRecord with bounded wake; no tight loop, no duplicate edit |

These fixtures prove the **strategy boundary**, not performance. Performance claims require the paired ablation in [Shared Kernel evaluation](../research/shared-kernel/evaluation.md).

## 10. Deliberately deferred

- Any measured optimal value for the fields in §4; current values are hypotheses.
- A policy DSL, hot-reload of strategies, per-tenant tuning UI.
- Automatic strategy learning/self-tuning (would need its own authority and evaluation design).
- Domain-specific scheduler implementations; the Kernel scheduler stays generic.
