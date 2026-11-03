# Kernel data model, event and error catalog

> **Status: ACCEPTED for construction (ARB-01, 2026-11-03); implementation NOT started; runtime claims UNVERIFIED.** This document fixes record shapes, identifiers, enums, canonicalization, events and error dispositions so that independent Kernel, Host and Domain implementations can interoperate. It adds **no authority** beyond [Core protocol](core-protocol.md). Where this document and an authority-owning contract disagree, that contract wins and this document must be amended in the same change. It is normative because it is listed in the [documentation index](../README.md) with this status and is registered in the [Decision Log](../decisions/decision-log.md).

## 1. Scope, precedence and non-claims

1. This document is the single place where **field-level shapes** of Kernel records are defined. Other documents keep the *meaning* of a record and link here instead of restating fields.
2. Normative here: required fields, types, enums, identifier/version semantics, canonical serialization, event names and required payload fields, error codes and their allowed dispositions, and the cross-record invariants in §8.
3. Informative here: suggested programming language types, storage layout, index design and wire encoding beyond canonical JSON.
4. Nothing here proves atomicity, durability, Host enforcement, provider billing behaviour or task quality. Those remain `UNVERIFIED` and are gated by the build/evidence gates in [Roadmap](../development/roadmap.md).
5. This document does not select a database, IPC mechanism, message broker, provider or OS sandbox.

## 2. Conventions

### 2.1 Identifiers

| Kind | Form | Rule |
| --- | --- | --- |
| `record_id` | opaque string, globally unique | Immutable. Never reused across restarts, retries, tasks or tenants. |
| `task_id` | opaque string | One Task = one accepted intent lineage, one active DomainBinding at a time. |
| `command_id` / `idempotency_key` | opaque string | Stable per logical command. Same ID + same canonical digest returns the original durable result; same ID + different digest is quarantined. |
| `journal_sequence` | `uint64`, strictly increasing | Audit total order. **Not** an optimistic-concurrency token. Gaps are permitted; reuse is forbidden. |
| `*_version` | `uint64`, starts at 1 | Per-aggregate CAS token: `task_control_version`, `model_step_version`, `invocation_version`, `budget_scope_version`, `checkpoint_version`, `profile_version` (immutable), `goal_version`, `plan_revision_number`. |
| Nonce / dispatch ticket | opaque ≤ 128 bytes, one-use | Consumed durably by the Host before physical spawn; never reconstructed by a consumer. |

Requirements: identifiers must not encode authority, permission or a filesystem path. A model, tool argument or retrieved document can never mint an identifier that Kernel treats as authoritative.

### 2.2 Digests and canonicalization

- JSON records are canonicalized with RFC 8785 JCS over UTF-8, strings NFC-normalized, no duplicate keys, no `NaN`/`Infinity`, and integers only for money and counts.
- Digest form: `<alg>:<lowercase hex>`, starting with `sha256:`. Algorithm agility is required in the schema (`digest_alg`), but exactly one algorithm is accepted per contract version.
- Money is `{amount_minor: int64, currency: ISO-4217}` and never floating point. Durations are integer nanoseconds or exact rationals `{num, den}`; media time follows [Media Timeline](media-timeline.md).
- Timestamps are RFC 3339 UTC with millisecond precision plus an explicit `clock_source` when they can influence authority (`host_monotonic`, `k_db`, `provider_signed`). Wall-clock timestamps never order two competing commands.
- Canonical payloads exclude their own digest/authenticator fields to avoid circular construction.
- Inline payload cap: **256 KiB** per record field. Larger content is an [Artifact](#310-artifact-and-evidenceref) reference. Silently truncating an authority-relevant payload is a protocol violation.

### 2.3 Unknown fields and enum evolution

- Unknown **required** fields, unknown safety/effect/resource/assurance declarations, or unknown `contract_version` majors are rejected before admission (fail closed).
- Unknown **optional** fields under `ext.<namespace>.*` are preserved and digest-bound but ignored by Kernel semantics.
- Enum values are closed per schema version. Adding a state requires a new contract version and migration review; adding a *reason code*, *evidence kind* or *tool* does not.
- Absent and `null` are distinct. `null` means "explicitly not applicable"; absent means "not supplied".
- Every durable record carries `tenant_id`; it is immutable and is part of every admission read-set and every query predicate ([Permissions](../security/permissions.md)).

### 2.4 Epoch, generation and ticket terminology

Exactly three monotonic counters exist. New text must use these names; older documents that say `AuthorityFenceEpoch`, "fencing epoch" or `fencingEpoch` are aliases and must be amended when touched. A bare "fencing epoch" in older text denotes the pair (`ticket_epoch`, Host gate sequence), not a fourth counter; an implementation must never introduce another counter.

| Counter | Scope | Incremented by | Used by |
| --- | --- | --- | --- |
| `authority_epoch` | One authority scope: principal, capability, policy, approval, profile | Any revocation, supersession, grant change, approval decision | Kernel admission; domain-binding validity; Host grant issuance |
| `workspace_generation` | One workspace or media project | Any accepted write/freeze/snapshot that changes the input set | Context freshness, completion binding, patch CAS |
| `ticket_epoch` | One dispatch ticket | Issued as the bound pair `(authority_epoch, workspace_generation)` plus host incarnation and gate sequence | Host launch gate; one-use nonce |

Gate rule: a ticket is launchable only if **both** components equal the Host-installed values, the ticket is unexpired and unconsumed, and the Host has no newer local fence. Kernel-side admission compares current versions separately; the two checks are not one atomic snapshot ([Trusted Host](../security/trusted-host.md)).

## 3. Record catalog

Every record carries `schema_version`. Task-scoped records carry `task_id`; records that can outlive a Task carry the immutable bindings they were created under.

### 3.1 UserIntent

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `intent_id` | id | yes | Immutable root of intent. |
| `session_id` | id | yes | Conversation boundary. |
| `raw_text` / `raw_artifact_ref` | string / artifact ref | one of | Original user request. Never replaced by a GoalContract. |
| `raw_digest` | digest | yes | Binds the exact original bytes. |
| `clarifications[]` | `{intent_id, text_digest, received_at, auth_ref}` | no | Append-only. Never mutates prior entries. |
| `principal_id` | id | yes | Authenticated requesting principal. |

Invariant: `GoalContract.derived_from` must reference the exact `intent_id` + clarification digests used.

### 3.2 TaskControl

The **only** Task-level transition authority. Terminal facts are immutable.

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `task_id` | id | yes | — |
| `task_control_version` | version | yes | CAS token for goal/structural-plan/cancel/terminal only. |
| `session_id` | id | yes | — |
| `state` | enum `Open \| Completed \| Failed \| Cancelled` | yes | Only the four authoritative states. |
| `accepted_goal_contract` | `{goal_id, version, digest}` | conditional | Required once a goal is accepted. |
| `active_plan_revision_id` | id | conditional | Exactly one when state is `Open` and a plan is active. |
| `plan_switch` | `{switch_id, phase, old_revision_id, candidate_id, barrier_seq}` \| null | no | Structural cutover only; phases in [PlanRevision](plan-revision.md). |
| `cancel` | `{requested_at, requested_by, reason_code, disposition, cancel_accepted_journal_sequence}` \| null | no | Request is not convergence. `cancel_accepted_journal_sequence` is the ordering fact used for "effective cancellation" comparisons. |
| `terminal` | `{status, reason_code, completion_id?, decided_at, journal_sequence}` | conditional | Exactly one, immutable. |
| `display_hint` | string \| null | no | Derived view only; never an authority. |

`reason_code` for `Failed`: `DeadlineExceeded \| NoProgress \| BudgetExhausted \| UnsafeEnvironment \| RepairExhausted \| UnresolvedEffect \| DependencyFailed \| PolicyDenied`. `Cancelled` uses `UserRequested \| Superseded \| AuthorityRevoked \| DependencyCancelled`. This is a **reason taxonomy, not new states**.

Invariant: `task_control_version` increments exactly once per accepted command that changes a field above. A receipt, evidence append, budget settlement, checkpoint or approval **never** increments it.

### 3.3 GoalContract

Immutable accepted version. Kernel validates the envelope and bindings; Domain decides semantic fidelity.

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `goal_id`, `version` | id, version | yes | Monotonic per Task. |
| `derived_from` | `{intent_id, clarification_digests[]}` | yes | Provenance to the original request. |
| `domain_binding_digest` | digest | yes | Bound profile/binding. |
| `payload_schema`, `payload_digest` | `{id, version}`, digest | yes | Typed domain payload; body is opaque to Kernel. |
| `outcome` | string | yes | Desired observable result (human-readable). |
| `scope[]`, `exclusions[]` | strings | yes (may be empty) | Hard bounds for plan containment checks. |
| `constraints[]` | strings | no | Compatibility/safety constraints. |
| `criteria[]` | criterion records | yes | See below; at least one. |
| `assumptions[]`, `ambiguities[]` | records | no | Disclosed assumptions; ambiguity blocks autonomy. |
| `risk` | `{class: R0\|R1\|R2, rationale}` | yes | Risk ceiling for the Task. |
| `user_control` | `{approval_mode, protected_field_policy}` | yes | Confirmation policy reference. |
| `confirmations[]` | `{field_path, auth_ref, digest, at}` | conditional | Required for protected changes. |
| `status` | `Candidate \| NeedsClarification \| ReadyForAcceptance \| Accepted \| Superseded \| Rejected` | yes | — |

`criterion`: `{criterion_id, version, statement, observable, method, required_evidence_class[], independence_required, human_disposition_required, validity_scope}`.

Rules: `criterion_id` is stable across versions; changing the *meaning* of a criterion requires a new version and a protected-field confirmation. A criterion with `method=human` can only pass with an authenticated human disposition.

### 3.4 DomainBinding and Workflow Profile

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `binding_id`, `binding_digest` | id, digest | yes | Immutable snapshot bound to a Task. |
| `domain_id` | string | yes | `coding`, `video_editing`, future `office`, … Namespaced, not branched in Kernel. |
| `tenant_id` | id | yes | Owning tenant; immutable. |
| `profile_id`, `profile_version`, `profile_digest` | ids/version/digest | yes | Immutable. |
| `contract_versions` | map | yes | goal/plan/evidence/artifact schema versions. |
| `tool_snapshot_set_digest` | digest | yes | Exact admitted tool definitions. |
| `strategy_ref` | `{strategy_id, version, digest}` | yes | See [Execution Strategy](execution-strategy.md). |
| `resource_policy_ref`, `verification_policy_ref` | refs | yes | — |
| `authority_epoch` | uint64 | yes | Epoch at creation; current authority lives in `AuthorityState` (§3.21). |

Invariant: binding fields are immutable; a change creates a new binding candidate and, if protected, a structural L2 cutover. `strategy_ref` may only be replaced by the same L2 protocol. A binding has **no mutable lifecycle status**; `Draft/Active/Superseded/Revoked` belong to the `AuthorityState` record so the historical pin never changes.

### 3.5 PlanRevision and PlanStep

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `revision_id`, `revision_number`, `parent_revision_id` | ids | yes | Monotonic; `parent` null for the first. |
| `goal_id`, `goal_version`, `binding_digest` | refs | yes | — |
| `state` | `Proposed \| AcceptedPendingCutover \| Active \| Superseding \| Superseded \| Rejected` | yes | — |
| `steps[]` | PlanStep records | yes | DAG. |
| `criterion_map` | `criterion_id -> step_ids[]` | yes | Every required criterion mapped, or explicit `human_review` obligation. |
| `effect_envelope` | `{classes[], targets[], capability_set[]}` | yes | Kernel containment check. |
| `resource_estimate`, `verification_reserve` | resource records | yes | Must fit remaining hard budget. |
| `snapshot_refs` | `{workspace_generation?, project_snapshot?, domain_model?}` | yes | Freshness basis. |
| `rationale` | string | yes | Human-auditable plan intent. |

`PlanStep`: `{step_id, plan_step_version, kind, objective, depends_on[], payload_schema, payload_digest, effect_class_envelope, expected_artifacts[], evidence_obligations[], preconditions[], recovery_disposition, work_status, verification_status}`.
`work_status`: `NotStarted \| Ready \| Running \| Blocked \| Completed \| Superseded`; `verification_status`: `NotRequired \| Pending \| Running \| Passed \| Failed \| Stale \| Inconclusive`. Statuses are **event-derived projections**, persisted for reconstruction, not separate CAS authorities.

### 3.6 ModelStep, ModelAttempt, Candidate

| Record | Required fields |
| --- | --- |
| `ModelStep` | `model_step_id`, `task_id`, `purpose` (`strategic\|tactical\|assurance\|planning\|verification\|summary`), `version`, `state` (`Open \| CandidateRecorded \| Selected \| Completed \| Abandoned`), `attempt_ids[]`, `selected_attempt_id`, `binding` (`goal_version`, `plan_revision_id`, `profile_digest`, `context_manifest_digest`), `deadline`, `strategy_ref` |
| `ModelAttempt` | `attempt_id`, `model_step_id`, `provider`, `model`, `pricing_version`, `request_digest`, `max_charge` (certificate ref + minor amount + currency), `reservation_id`, `budget_scope_id`, `provider_request_key?`, `state` (`AdmittedUnsentKnown \| SendMayHaveOccurred \| Complete \| FailedKnownNotAccepted \| ProviderOutcomeUnknown`), `send_marker_ref?`, `usage_ref?` |
| `Candidate` | `candidate_id`, `attempt_id`, `response_digest`, `journal_sequence`, `schema_valid`, `selection_eligible`, `ineligibility_reason?` |

Invariants: exactly one `selected_attempt_id` ever; selection is irreversible; an incomplete/UNKNOWN attempt has no candidate; the Gateway, not Kernel, records provider send facts.

### 3.7 ToolInvocation

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `invocation_id`, `version` | id, version | yes | Identity and CAS token. |
| `task_id`, `plan_revision_id`, `step_id` | ids | yes | Work binding. |
| `decision_id` | id \| null | yes for R1/R2 | Originating bounded decision envelope. May be null only for a system-generated R0 maintenance read with no model proposal; a null on an effectful invocation is a protocol violation. |
| `tool` | `{definition_id, version, digest}` | yes | Immutable snapshot. |
| `args_digest`, `args_ref` | digest, ref | yes | Canonical arguments; body not in Journal. |
| `effect_class` | `R0 \| R1 \| R2` | yes | Effective class from tool + arguments + target, never the model label. |
| `conflict_scope` | string | yes | Serialization domain (e.g. workspace path set, project, output target). |
| `target` | `{kind, ref, digest?}` | yes | Exact target identity, not a bare path. |
| `read_set` | binding vector | yes | `tenant_id`, `principal_id`, `goal_version`, `plan_revision_id`, `authority_epoch`, `profile_digest`, `workspace_generation` or `project_snapshot`, `budget_scope_version`, `tool_digest`, `step_precondition_digest`. |
| `reservation_id` | id | yes | Budget hold covering the operation. |
| `approval_ref` | id \| null | conditional | Required when policy demands per-invocation approval. |
| `state` | `Proposed \| Admitted \| DispatchPending \| Running \| Rejected \| OutcomeUnknown \| Succeeded \| FailedKnown \| Cancelled` | yes | Logical lifecycle. `Succeeded/FailedKnown` require Host evidence, never a model claim. |
| `dispatch` | `{ticket_id, nonce, host_id, host_incarnation, issued_at, deadline}` | after admission | One-use. |
| `receipt_ref`, `outcome_evidence[]` | refs | conditional | Authenticated Host facts. |
| `reconciliation` | `{reason, scope, resolved_by, resolved_at}` | conditional | Required to leave `OutcomeUnknown`. |

Rules: `Admitted` means the durable intent + reservation + outbox committed **before** dispatch. Missing Host facts after a possible spawn is `OutcomeUnknown`, never `FailedKnown`. A nonce is never reconstructed.

### 3.8 Approval and ScopedReadGrant

Approval is two records owned by [Permissions](../security/permissions.md) §4; their field shapes and lifecycle are canonical there and are **not** restated here. Kernel adds one field only: `ApprovalDecision.approval_version` (CAS token) plus `consumed_by_invocation_id`/`consumed_at`, and consumption is committed in the same K transaction as `InvocationAdmitted`. Approval is a permission fact, not an Invocation state; a stale, expired, revoked or consumed approval never authorizes launch.

`ScopedReadGrant`: `{grant_id, version, handoff_id, artifact_id, artifact_digest, consumer_task_id, consumer_binding_digest, purpose, access_mode, authorizing_principal, policy_version, issue_at, expiry, revocation_epoch, resolver_receipts[]}`. Grants are server-side and never appear in model context.

### 3.9 BudgetScope, Reservation, CostRecord

- `BudgetScope`: `{budget_scope_id, version, tenant_id, owner_kind, owner_id, limit {amount,currency} or resource vector, hard_mode, protected_verification_repair_reserve, enforcement_hold?, overrun_records[]}`.
- `Reservation`: `{reservation_id, budget_scope_id, owner_kind: model|host|resource, owner_id, maximum, state: Reserved|ProvisionallyAccounted|Settled|Adjusted|HeldUnknown, created_at, settled_at?}`.
- `CostRecord`: `{cost_record_id, reservation_id, provider_usage_ref?, host_usage_ref?, settled_amount, basis, late: bool}`. Append-only; late costs never rewrite a selection or a terminal fact.

Resource vector dimensions (only those the profile declares enforceable): `wall_ms, cpu_ms, peak_mem_bytes, gpu_ms, gpu_mem_bytes, disk_bytes, output_bytes, network_bytes, media_input_seconds, media_output_seconds`.

### 3.10 Artifact and EvidenceRef

`Artifact`: `{artifact_id, task_id, kind, schema_id/version, digest, size, media_type, storage_ref (opaque), provenance {producer_kind, producer_id, invocation_id?, source_refs[]}, lineage {parent_artifacts[], handoff_id?}, classification, retention, state: Staging|Published|Quarantined|Missing|DigestMismatch|Unverified}`.
Kernel treats `kind`, `schema` and payload as opaque; it validates identity, digest, binding and state. The six states above are the **minimum construction projection**; ADP-04 may add storage lifecycle states, but may not remove these or weaken the rule that only `Published` bytes are deliverable or handoff-eligible.

`EvidenceRef`: `{evidence_id, task_id, source_kind, source_ref, digest, scope, capture_version, environment_digest?, trust_class, captured_at, freshness_basis {goal_version, plan_revision_id, workspace_generation|project_snapshot, tool_digest, artifact_digests[]}}`.
`CriterionEvidenceBinding`: `{criterion_id, goal_version, evidence_refs[], required_class, observed_class, independence, verdict, verifier_ref, disposition_at, freshness_basis_digest}`.
Trust classes are `T0..T5` as in [Context Engine](../context/context-engine.md#6-provenance-and-trust). No record may store a numeric model self-confidence as evidence.

### 3.11 VerificationReport and CompletionRecord

`VerificationReport`: `{report_id, report_version, task_id, goal_version, plan_revision_id, binding_digest, strategy_ref, verification_policy_ref, criterion_results[], environment, toolchain, domain_evidence_refs[] {schema_id, schema_version, digest}, artifact_digests[], skipped_checks[], verifier_run {model_or_human, independence, input_manifest_digest, disposition}?, guard_inputs_digest, created_at}`.

`domain_evidence_refs[]` is the only domain-specific part of the shared report: it carries typed schema ids and digests, never Coding/Video field names. Coding's sealed-view manifest, Video's project/render references and any future domain's evidence live inside their own typed artifacts, resolved by the domain verifier; the Kernel binds identity and digest only.
`criterion_results[]`: `{criterion_id, verdict, evidence_refs[], independence, notes_ref?}` where `verdict` uses the enum owned by [Completion](completion.md) §2 (`Pass | Fail | NotRun | Skip | Partial | Unverified`).

`CompletionRecord`: `{completion_id, task_id, task_control_version, report_id, report_digest, guard_policy_version, checks[] {check_id, ok, detail_ref}, outstanding_holds[], decided_at, journal_sequence}`. Committed atomically with the terminal fact.

### 3.12 WaitRecord

`{wait_id, task_id, reason_code, blocking_scope, owner, created_at, next_wake_at, max_wait_until, recovery_strategy, condition_ref, evidence_ref?}`.
Every non-terminal wait that persists across a loop wake **must** have a WaitRecord; a wait without a wake source or max deadline is a defect. `reason_code`: `UserInput \| Approval \| ExternalJob \| ProviderReconciliation \| HostReconciliation \| BudgetAction \| Dependency \| RateLimit`.

### 3.13 ExecutionStrategy reference

`{strategy_id, version, digest, domain_id}`. Body is defined in [Execution Strategy](execution-strategy.md); it is a **policy object**, not a record family, and cannot grant authority.

### 3.14 Checkpoint (optional)

`{checkpoint_id, checkpoint_version, task_id, journal_high_water, task_control_version, goal_version, active_revision_id, step_states[], workspace_generation, projection_digests[], unresolved_refs[], payload_digest}`.
Checkpoint integrity is historical; current authorizations are **not** part of its validity (§[Context Engine](../context/context-engine.md#9-checkpoint-integrity-recovery-and-compaction)).

### 3.15 WakeEvent

`{wake_id, task_id, cause, dedupe_key, source_ref, occurred_at, sequence}`. `cause` is closed: `TaskAdmitted \| UserInput \| ApprovalResolved \| CancelAccepted \| DeadlineDue \| HostReceipt \| ProviderResult \| CutoverReady \| RecoveryTimer \| InternalContinue`. The Orchestrator consumes wakes through a durable cursor, coalesces duplicate `dedupe_key` values, and never derives a new cause from model text. `InternalContinue` is persisted by the scheduler only with `source_ref` pointing to a typed previous disposition and an enforced per-Task continuation allowance; it never bypasses model/no-progress/deadline limits. A wake is a scheduling hint, not authority: every wake handler re-reads current state and admission conditions.

### 3.16 VerificationPolicy

The **sole owner** of assurance requirements. An Execution Strategy may add triggers and tighten, never restate or lower these values.

`{policy_id, version, digest, criterion_class_map[], verification_reserve_derivation, shadow_audit_rate}` where each criterion class maps to `{required_evidence_class[], independence_floor: self|fresh_context|different_reviewer|human, human_gate: bool, tolerance_profile_ref?, decode_scan_policy_ref?}`.

Kernel validates that every accepted criterion maps to exactly one class, that the policy digest is bound in the DomainBinding and VerificationReport, and that the Kernel assurance floor in [Completion](completion.md) is satisfied. It does not interpret domain-specific tolerance or scan semantics.

### 3.17 Holds

Two durable safety barriers exist. Neither is a Task state; neither rewrites a terminal fact, and neither clears itself on a timer.

`CompletionHold`: `{hold_id, version, task_id, hold_kind: PreTerminal|PostTerminalEvidenceHold|UnresolvedEffect, opened_by_event_id, conflicting_fact_ref, blocked_scope, review_state: Open|EvidenceValidated|DefectConfirmed|Inconclusive, owner, resolution_deadline, resolved_at?}`.

`UnresolvedEffectHold`: `{hold_id, version, task_id, terminal_fact_ref, invocation_ids[], conflict_scope, reconciliation_owner, next_wake_at, max_reconcile_until, disposition: Pending|Reconciled|Escalated}`. It exists **after** a Task terminalizes with `reason=UnresolvedEffect`; it keeps conflicting targets fenced and records that physical convergence is not claimed.

An event `CompletionHoldOpened/Resolved` covers both record kinds via `hold_kind`; a hold timeout escalates, never auto-clears.

### 3.18 EffectPolicy

`{effect_policy_id, version, tenant_id, risk_class: R0|R1, tool_digests[] | tool_class, target_scope, grant_ttl_ms, clock_uncertainty_ms, fence_ack_target_ms, fail_closed: true, approval_required, allowed_effect_classes[], status: Draft|Active|Revoked, activated_by, activated_at}`.

An effectful R1 launch is admitted only when an `Active` policy **matches** the invocation on tenant, tool digest (or declared tool class), target scope and risk class, and the Host can enforce its TTL/clock/fence values. `tool_class` is a manifest-declared class id; `target_scope` is a namespaced target pattern (for example `workspace:<id>`, `staging:<task>`); an implementation must not invent an alternative taxonomy. No match is `PolicyDenied`, never a silent default. Only an `operator` principal with `profile.activate` may activate or revoke a policy ([Permissions](../security/permissions.md)).

### 3.19 Freeze records and workspace generation

`FreezeRequest`: `{freeze_id, request_id, tenant_id, task_id, workspace_id, workspace_generation, authority_epoch, kernel_challenge, nonce, request_payload_digest, expires_at, state: Requested|InProgress|Completed|Expired|Aborted, created_at}`.
`FreezeReceipt`: `{receipt_id, freeze_id, tenant_id, workspace_id, workspace_generation, authority_epoch, kernel_challenge, snapshot_id, source_digest, protected_input_scope_version, hash_alg, hash_scope_version, hash_scope_descriptor_digest, convergence {processes, writable_handles, evidence_digests[]}, execution_view_manifest_digest?, host_id, key_id, ledger_sequence, ledger_chain_digest, captured_at}`.
`FreezeDecisionIntent`: `{decision_id, tenant_id, freeze_id, decision: Commit|Abort, receipt_digest, persisted_at}` persisted **before** sending to the Host; the Host rejects the opposite decision and returns the recorded one.

`AdvanceWorkspaceGeneration` is the only command that increments `workspace_generation`; it requires a committed freeze decision (or a proven non-freezing write path declared by policy) and records the resulting generation. Protocol semantics and recovery are owned by [Workspace Freeze](workspace-freeze.md).

### 3.20 TaskDelivery

`{delivery_id, tenant_id, task_id, terminal_fact_ref, artifact_refs[] {artifact_id, digest, schema}, report_digest, status: Pending|Delivered|Acknowledged|Failed, attempt_count, next_attempt_at, ack_ref?, created_at}`.

Delivery is at-least-once with a stable `delivery_id`; an ACK binds the delivery id, artifact digests and report digest. A missing ACK is retried with bounded backoff and dead-lettered, never used to reopen a terminal Task.

### 3.21 AuthorityState

`{scope_kind: principal|capability|policy|approval|profile, scope_id, tenant_id, authority_epoch, effective_binding_digest, effect_policy_id, status: Active|RevocationPending|Revoked, updated_at}`.

One record per authority scope. `DomainBinding` is the immutable historical pin; `AuthorityState` is the only mutable "current authority" record and is what admission and the Host grant reference. `EffectPolicyId` in [Trusted Host](../security/trusted-host.md) denotes the `effect_policy_id` field of the §3.18 record.

## 4. Kernel event catalog

Events are append-only Journal records: `{event_id, event_type, aggregate_kind, aggregate_id, aggregate_version, journal_sequence, task_id, occurred_at, correlation_id, causation_id, payload_schema, payload_digest, payload}`. Delivery to adapters is at-least-once and idempotent by `event_id`.

| Event | Aggregate | Emitted when | Minimum payload |
| --- | --- | --- | --- |
| `TaskAdmitted` | TaskControl | Task created with binding | `binding_digest`, `intent_id` |
| `GoalContractAccepted` | TaskControl | goal accepted | `goal_id`, `version`, `digest`, `confirmations[]` |
| `PlanRevisionProposed` | PlanRevision | candidate recorded | `revision_id`, `digest` |
| `PlanRevisionAccepted` | PlanRevision | deterministic checks pass | `revision_id`, `state=AcceptedPendingCutover` |
| `PlanSwitchBarrierInstalled` | TaskControl | structural cutover begins | `switch_id`, `old_revision_id` |
| `PlanRevisionActivated` | TaskControl | atomic activation | `old_revision_id`, `new_revision_id` |
| `CancelAccepted` | TaskControl | cancellation accepted (not convergence) | `cancel_accepted_journal_sequence`, `reason_code`, `requested_by` |
| `PlanSwitchRequested` | TaskControl | structural cutover requested | `switch_id`, `old_revision_id`, `reason` |
| `PlanStepReworkStarted` | PlanRevision | authorized rework of the same objective | `step_id`, `plan_step_version`, `prior_attempt_ref` |
| `PlanStepStatusChanged` | PlanRevision | derived work/verification change | `step_id`, `work_status?`, `verification_status?`, `cause_event_id` |
| `ModelStepOpened` | ModelStep | decision starts | `model_step_id`, `purpose`, `binding` |
| `ModelAttemptAdmitted` | ModelAttempt | K-local admission + reservation | `attempt_id`, `reservation_id`, `request_digest` |
| `ModelSendMayHaveOccurred` | ModelAttempt | Gateway durable marker (imported fact) | `attempt_id`, `marker_ref` |
| `AttemptCancelRequested` | ModelAttempt | attempt cancellation requested | `attempt_id`, `command_id` |
| `ModelCandidateRecorded` | ModelStep | complete valid response | `candidate_id`, `attempt_id`, `response_digest` |
| `ModelStepSelected` | ModelStep | final selection | `selected_attempt_id`, `delivery_id` |
| `ModelStepAbandoned` | ModelStep | no candidate can ever be selected | `model_step_id`, `reason` |
| `ModelAttemptOutcomeUnknown` | ModelAttempt | ambiguity recorded | `attempt_id`, `reason` |
| `InvocationAdmitted` | ToolInvocation | K-local admission | `invocation_id`, `effect_class`, `read_set_digest`, `reservation_id` |
| `InvocationDispatched` | ToolInvocation | outbox send | `invocation_id`, `ticket_id` |
| `HostLaunchBoundaryRecorded` | ToolInvocation | Host imported fact | `invocation_id`, `host_run_id`, `gate_sequence` |
| `HostReceiptImported` | ToolInvocation | authenticated receipt | `invocation_id`, `receipt_digest`, `outcome` |
| `InvocationOutcomeUnknown` | ToolInvocation | unresolved | `invocation_id`, `scope`, `reconciliation_id` |
| `InvocationReconciled` | ToolInvocation | authoritative resolution | `invocation_id`, `final_state`, `evidence[]` |
| `ApprovalRequested` | Approval | approval requested for an exact scope | `approval_request_id`, `tool_digest`, `args_digest`, `approver_class` |
| `ApprovalDecided` | Approval | granted/denied/expired/revoked | `approval_id`, `decision`, `approver_principal_id`, `expires_at` |
| `ApprovalConsumed` | Approval | consumed by an admitted invocation | `approval_id`, `invocation_id`, `approval_version` |
| `AuthorityFenceChanged` | DomainBinding/authority | local/observed fence change | `epoch`, `scope`, `state` |
| `RevocationRequested` | Authority | Kernel records desired revocation epoch | `scope`, `requested_epoch`, `reason` |
| `HostFenceInstalled` | Authority | imported Host gate fact | `host_id`, `host_incarnation`, `installed_epoch`, `gate_sequence` |
| `Revoked` | Authority | all eligible Host gates acknowledged/disabled | `scope`, `epoch`, `host_acks[]` |
| `DomainBindingValidated` | DomainBinding | strategy/profile/effect policy validation passed | `binding_digest`, `strategy_digest`, `effect_policy_id` |
| `EffectPolicyActivated` | EffectPolicy | operator activates an effect policy | `effect_policy_id`, `risk_class`, `activated_by` |
| `ArtifactRecorded` | Artifact | immutable artifact identity recorded | `artifact_id`, `digest`, `state` |
| `ArtifactPublished` | Artifact | final publication | `artifact_id`, `digest`, `state` |
| `FreezeRequested` | Workspace | PrepareFreeze dispatched | `freeze_id`, `request_id`, `workspace_generation` |
| `FreezeReceiptImported` | Workspace | authenticated freeze receipt | `freeze_id`, `receipt_id`, `snapshot_id`, `source_digest` |
| `FreezeDecisionCommitted` | Workspace | Commit/Abort decided | `freeze_id`, `decision`, `receipt_digest` |
| `TaskDeliveryPrepared` | TaskDelivery | terminal delivery prepared | `delivery_id`, `terminal_fact_ref`, `artifact_digests[]` |
| `TaskDeliveryAcknowledged` | TaskDelivery | consumer acknowledged | `delivery_id`, `ack_ref`, `digest` |
| `EvidenceRecorded` | Evidence | evidence ref/binding recorded | `evidence_id`, `kind`, `digest`, `freshness_basis_digest` |
| `VerificationReportSubmitted` | VerificationReport | verifier report bound to current plan | `report_id`, `report_version`, `report_digest`, `criterion_results_digest` |
| `EvidenceInvalidated` | Evidence | freshness broken | `evidence_ids[]`, `cause_digest` |
| `WaitPersisted` / `WaitResolved` | WaitRecord | parking/resume | `wait_id`, `reason_code`, `max_wait_until` |
| `CompletionHoldOpened` / `CompletionHoldResolved` | TaskControl | safety hold (either kind) | `hold_id`, `hold_kind`, `reason`, `scope` |
| `CompletionCommitted` | TaskControl | Guard passes | `completion_id`, `report_digest` |
| `TaskTerminal` | TaskControl | terminal CAS | `status`, `reason_code`, `completion_id?` |

Event rules: an event never substitutes for a Host fact; `HostLaunchBoundaryRecorded` and `HostReceiptImported` are imports and carry the Host receipt digest. Adapters rebuild projections after a gap from a Kernel snapshot plus the Journal cursor.

## 5. Command catalog and idempotency

| Command | Owning version | Effect |
| --- | --- | --- |
| `AdmitTask` | new | create TaskControl + binding; no side effect |
| `AcceptGoalContract` | `task_control_version` | accept immutable goal |
| `RequestPlanSwitch` | `task_control_version` | install barrier |
| `ActivatePlanRevision` | `task_control_version` | atomic cutover |
| `RequestCancel` | `task_control_version` | stop new admissions; start convergence |
| `CommitTerminal` | `task_control_version` | one terminal fact |
| `OpenModelStep` / `RecordCandidate` / `SelectCandidate` | `model_step_version` | model decision |
| `AdmitInvocation` | `invocation_version` (new) | validate read-set, reserve, intent, outbox |
| `ImportHostOutcome` | `invocation_version` | dedup receipt, project outcome |
| `ReconcileUnknown` | `invocation_version` | typed resolution |
| `AppendBudgetEvent` | `budget_scope_version` | reserve / settle / hold |
| `ActivateEffectPolicy` | new + `authority_epoch` | operator activates an effect policy |
| `PrepareFreeze` / `CommitFreeze` / `AbortFreeze` | `freeze_id` + `workspace_generation` | freeze protocol |
| `AdvanceWorkspaceGeneration` | `workspace_generation` | only command that increments the generation |
| `RecordArtifact` / `RecordEvidence` / `SubmitVerificationReport` | `task_id` + artifact/evidence version; `report_version` for reports | immutable evidence ingestion |
| `PrepareDelivery` / `AcknowledgeDelivery` | `delivery_id` | terminal delivery |
| `OpenHold` / `ResolveHold` | `hold_id` + `task_control_version` | safety barriers |
| `PersistWait` / `ResolveWait` | `task_id` + wait id | parking |
| `BindStrategy` | `task_control_version` | L2 only; new binding candidate |

Command result: `{command_id, payload_digest, disposition: Applied|Rejected|NoOp|Conflict, aggregate_version, event_ids[], error_code?}`. A business rejection is durable. A transport retry of the same command returns the original result.

## 6. Error and disposition catalog

| Code | Class | Allowed Kernel response |
| --- | --- | --- |
| `SchemaInvalid` | request | reject before admission; no reservation |
| `UnknownRequiredField` | request | reject closed |
| `StaleBinding` | concurrency | reject; refresh context; never retry blindly |
| `VersionConflict` | concurrency | reject with current version; caller re-reads |
| `AuthorityDenied` | policy | reject; audit security event |
| `ApprovalMissing` / `ApprovalExpired` | policy | park as `Approval` wait or reject per policy |
| `ApprovalConsumed` / `ApprovalScopeMismatch` / `SelfApprovalForbidden` / `ApproverClassMismatch` | policy | reject; security event ([Permissions](../security/permissions.md)) |
| `EffectClassMismatch` | policy | reject; security event; no relabel |
| `EffectClassDisabled` | policy | reject (R2 default-disabled) |
| `PreconditionFailed` | state | reject; re-read and re-decide; never blind replay |
| `EffectNotApplied` | state | record negative result; retry only per policy |
| `HostCapabilityMissing` | capability | reject admission; mark profile unsupported |
| `StorageUnavailable` | infrastructure | fail closed; no admission until storage is healthy |
| `DeliveryStalled` | infrastructure | dead-letter + escalate; never reopen a terminal Task |
| `IntegrityConflict` | integrity | quarantine; operator escalation |
| `ExecutionBindingMismatch` | integrity | quarantine; no publication |
| `BudgetExhausted` | resource | park `BudgetAction` or fail typed; never silently downgrade hard→soft |
| `ResourceUnavailable` | resource | queue per strategy or reject |
| `TargetConflict` | conflict | serialize or reject; never overlap writes |
| `OutcomeUnknown` | fact | retain hold; reconcile; no replay |
| `RetryableNoEffect` | fact | retry only with proof no physical/provider effect was possible |
| `DependencyBlocked` / `DependencyFailed` | composition | park or terminal `DependencyFailed` |
| `UnsupportedEnvironment` | capability | mark `Unverified`/`Unsupported`; block completion |
| `NoProgress` | control | diagnose once, then wait or terminal `NoProgress` |
| `DeadlineExceeded` | control | safe-stop protocol, then terminal `DeadlineExceeded` |

Error codes are data. An adapter error never licenses Kernel to reinterpret domain semantics.

## 7. Canonical enum ownership

State enums are owned as follows and must not be duplicated or renamed elsewhere:

| Enum | Owning document (enum values) | Transition/semantic owner |
| --- | --- | --- |
| Task authority states, terminal reason codes | this document | [Lifecycle](../architecture/lifecycle.md) |
| GoalContract states | this document | [PlanRevision](plan-revision.md) |
| PlanRevision / PlanStep states | this document | [PlanRevision](plan-revision.md) |
| EffectPolicy / AuthorityState / TaskDelivery / FreezeRequest states | this document | this document |
| ModelStep / ModelAttempt states | this document | [Model and Budget](model-and-budget.md) |
| ToolInvocation states | this document | [Core protocol](core-protocol.md) |
| Verification verdicts and evidence classes | [Completion](completion.md) | [Completion](completion.md) |
| Artifact states | this document | this document (+ ADP-04 scope) |
| Evidence trust classes | [Context Engine](../context/context-engine.md) | [Context Engine](../context/context-engine.md) |
| Domain effect/risk classes R0/R1/R2 | [Trusted Host](../security/trusted-host.md) | [Trusted Host](../security/trusted-host.md) |

## 8. Cross-record invariants (DM)

1. Exactly one `TaskControl` per Task; exactly one terminal record per Task; terminal fields never change.
2. No `InvocationAdmitted` without a durable `Intent` + reservation + outbox in the same K transaction.
3. No `DispatchPending` without a committed `InvocationAdmitted`.
4. No `Succeeded`/`FailedKnown` Invocation without an authenticated Host receipt bound to the same invocation, nonce and host incarnation.
5. A consumed nonce never appears in a second `dispatch`.
6. `OutcomeUnknown` never transitions directly to `Succeeded`/`FailedKnown` without a `Reconciliation` record referencing trusted evidence.
7. At most one `selected_attempt_id` per ModelStep; it never changes.
8. Every `Candidate` references a `Complete` Attempt; no candidate from a partial or UNKNOWN response.
9. `confirmed_spend + outstanding_reserved_max + proposed_max + protected_verification_repair_reserve <= hard_limit` at every funding-scope admission.
10. A late cost, receipt or evidence record may append but never rewrite a selection, accepted plan, artifact digest or terminal fact.
11. Every passing criterion has at least one `CriterionEvidenceBinding` whose `freshness_basis` matches the current goal/plan/workspace-or-project/tool versions at Guard time.
12. At most one `Active` PlanRevision; no admission binds a `Superseded` revision.
13. Every `Artifact` in `Published` has a digest and provenance; `Staging`/`Quarantined`/`DigestMismatch` artifacts are never deliverable or handoff-eligible.
14. A `ScopedReadGrant` is required for every cross-domain artifact byte access; grant fields match consumer task, binding, purpose, digest and access time.
15. Domain payloads are opaque: no Kernel field may contain a domain semantic verdict.
16. An ExecutionStrategy binding cannot exceed the profile's effect/resource/assurance envelope and cannot lower a Kernel safety floor.
17. Any persisted wait has `owner`, `max_wait_until` and `recovery_strategy`.
18. Event payload digests are canonical; re-emitting the same `event_id` with different bytes is an integrity conflict.
19. A `CompletionRecord` exists if and only if the Task is `Completed`.
20. No record may store a secret, bearer token, approval credential or filesystem locator that grants access.

## 9. Versioning and migration

- `contract_version` uses `MAJOR.MINOR`. A MINOR addition may add optional fields/events/error codes; a MAJOR change requires a new document version, a migration note and a Decision Log entry.
- Kernel must reject a record with an unsupported MAJOR. It must preserve and ignore unknown MINOR optional fields under namespaced extensions.
- Existing historical records are never rewritten to a new schema. Projections may add derived fields; the original digest stays authoritative.
- A schema change that alters authority semantics (e.g. new terminal state, new effect class) is **not** a data-model migration; it requires a new architecture decision.

## 10. Explicitly deferred

- Storage engine, serialization wire format, RPC/queue technology and index design.
- Concrete ID generator and key-management/HSM choice.
- Artifact blob storage, encryption-at-rest and retention implementation.
- Multi-tenant identity federation and authorization policy language.
- Any numeric token/latency/resource target (see [Shared evaluation](../research/shared-kernel/evaluation.md); targets are design hypotheses, not results).

These are build-time choices constrained by this model, not open architecture questions.
