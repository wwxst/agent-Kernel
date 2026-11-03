# Domain Extension Contract v0.1 — implementation candidate

> **Status: PROPOSED / G0 OWNER REVIEW OPEN.** This is a new minimal adapter contract, not an approved implementation ABI, deployed plugin system, external authority grant, or D9/Multi-Agent enablement. Its first conformance consumers are Coding and Video; Office is a design-only third consumer. Kernel authority, Host fence, UNKNOWN, billing, and completion obligations remain those of [Core Protocol](core-protocol.md), [Domain Workflow](domain-workflow.md), and [Completion](completion.md).

## 1. Boundary and excluded abstractions

**Design choice:** one authoritative Kernel + one Task Orchestrator loop per Task + a version-pinned domain adapter. The Kernel never branches on `domain_id` to choose a tool, domain cognitive mode, editorial operation, coding test or Office API. Domain semantics stay in the adapter. A domain adapter can suggest intents, schemas and evidence obligations but **cannot** commit TaskControl, bypass Model Gateway, admit an Invocation, mint a capability, settle a bill, mark a Host process converged, or finish a Task.

This contract deliberately omits a plugin marketplace, dynamically executed third-party code inside the Kernel authority process, a general distributed workflow engine, a universal semantic model, a domain-specific Kernel state machine, and automatic agent-to-agent delegation. Domain code executes in the Orchestration/adapter boundary under its own approved deployment policy; all effects go through Kernel Admission and Trusted ToolHost.

## 2. Versioned manifest and activation

`DomainManifest` (canonical content digest, immutable after activation):

| Required field | Contract |
| --- | --- |
| `domain_id`, `adapter_api_version`, `manifest_version`, `digest`, `publisher_attestation` | Unique namespace, API compatibility, integrity and provenance; unknown publisher is not trusted |
| `workflow_profiles[]` | Pinned profile ID/version/digest, goal/step schemas, supported task families and context policy; follows existing DomainBinding rules |
| `tools[]` | Canonical ToolDefinition ID/version/digest, argument/result schemas, effect class R0/R1/R2, conflict scope, idempotency class, resource dimensions, deadline/cancellation semantics and approval policy |
| `artifact_types[]`, `evidence_types[]` | Namespaced schema ID/version, digest/lineage and criterion binding policies; payload opaque to Kernel |
| `verification_policies[]` | Criterion-class evidence requirements, minimum independence/assurance, explicit human gate, permitted evidence carry-forward conditions |
| `execution_requirements` | Host capabilities, supported enforcement profiles, resource limits, projection freshness rules, privacy/retention declarations |
| `compatibility` | Supported Kernel contract range, required event schema, migration rule and explicit unsupported capabilities |

**Registry flow:** Register (untrusted/inactive) → schema+digest+namespace+signature policy validation → capability/effect-risk review → host/profile compatibility proof → explicitly authorized Activate → bind a new Task to exact manifest/profile digest. Activation provides availability **not authority**: at every admission Kernel intersects profile restrictions with current principal/policy/approval/budget and Host capability. Superseded/revoked manifests remain readable historically but cannot authorize new execution. Changing manifests on a live Task requires the existing freeze/reconcile/confirmation PlanRevision cutover, never an in-place binding rewrite.

**Compatibility:** `adapter_api_version=0.1` is the proposed first-slice target, not a finalized release. Unknown required/safety fields or unsupported major versions fail registration/admission closed. Optional non-authoritative metadata may be ignored; an unknown effect/resource/assurance declaration may not. New domains add new manifest/profile/tool/artifact namespaces without changing the Kernel core state machine. A breaking authority-envelope change requires a new Kernel contract version and separate migration review.

## 3. Port interfaces and envelopes

These are **logical ports and data shapes**, not runtime-language signatures or endorsement of a framework.

| Domain-facing port | Inputs | Output | Authority |
| --- | --- | --- | --- |
| `interpretGoal` | UserIntent, current Goal candidate, allowed domain profile | `GoalCandidate{schema_ref, payload_digest, criteria[], ambiguity[], risk}` | Advisory: Kernel validates binding/confirmation and accepts |
| `projectContext` | `ContextRequest{task, purpose, snapshot_refs, evidence_cursor, token_cap}` | `ContextManifest{sources[], digests[], freshness, redactions, token_estimate}` | Read-only projection; no authority |
| `decideNext` | Bound Goal/Plan, relevant context, current evidence gaps, remaining budgets | `DecisionIntent{decision_id, mode, read_set, items[], need_user?, no_progress_reason?}` | Proposal only; selected ModelStep/Attempt and each Invocation are Kernel-owned |
| `interpretOutcome` | Authenticated receipts, artifact refs, evidence cursor | `DomainObservation{typed_refs[], affected_criteria[], invalidations[]}` | No Host/process truth rewrite |
| `verifyCriteria` | `VerificationRequest{criterion_ids, required_evidence, artifact_snapshot, environment}` | `VerificationProposal{criterion_verdicts[], evidence_refs[], assurance_gaps[]}` | Cannot promote missing/untrusted evidence to PASS or commit Completed |
| `describeRecovery` | Reconciled K/H facts, known/unknown effect scope | `RecoverySuggestion{safe_next?, blocking_scope?, next_probe?}` | Kernel determines legal retry/admission |

All ports use a request/response envelope: `contract_version, task_id, domain_binding_digest, goal_version, plan_revision_id, correlation_id, idempotency_id, input_digest, deadline, trace_id`. A proposed mutation additionally includes the *specific* `read_set` of plan/authority/workspace/artifact/budget versions it depends on. Domain-specific payloads are versioned, bounded and content-digested. `DecisionIntent.items` is finite and ordered; each requested ToolInvocation has `tool_definition_digest, canonical_args_digest, effect_class, conflict_scope, dependency_refs, requested_resource_reservation, result_expectations`. None carries a bearer permission. Kernel rejects unknown required fields, mismatched digests, stale bindings and unsupported effect kinds.

**Errors:** `UnsupportedProfile`, `InvalidDomainPayload`, `ContextStale`, `EvidenceInsufficient`, `NeedsAuthorization`, `ResourceUnavailable`, `RetryableNoEffect`, `OutcomeUnknown`. An adapter error is data, not a license for Kernel to reinterpret domain semantics. `RetryableNoEffect` requires independent proof that no physical/provider effect was possible. `OutcomeUnknown` retains conflict and budget holds until authoritative reconciliation; deadlines and cancellation never recast UNKNOWN as failure.

**Event exchange:** Kernel publishes append-only `TaskControlChanged, ModelStepSelected, InvocationAdmitted/Denied, HostReceiptImported, AuthorityFenceChanged, ArtifactPublished, EvidenceInvalidated, CompletionCommitted, TaskTerminal` with `event_id, aggregate_id, aggregate_version, journal_sequence, correlation_id, payload_schema, digest`. Adapters consume idempotently by `event_id`, rebuild projections after gaps from Kernel snapshots plus the Journal cursor, and never write the Journal directly. A Kernel event is not an assurance that an external side effect occurred unless authenticated Host/provider facts support it.

## 4. Runtime scheduling and assurance policy

One orchestrator runs a priority-ordered loop, irrespective of domain: **cancel/authority/deadline → conflicting UNKNOWN/reconcile → user/approval wait → missing mandatory evidence → pending planned work/repair → guarded terminal**. Simple safe tasks may use a single tactical model decision and deterministic checks. A Strategy decision is requested on initial ambiguity or L2 cutover, not mechanically before each tool. A fresh model Verifier is **conditionally invoked** if the accepted criterion's `verification_policy` requires semantic independence, the evidence is disputed/low confidence, a protected input changed, or a risk trigger is met; there is no always-on model Verifier for every tool batch. A deterministic Completion Guard always executes and cannot be optimized out. See [Completion](completion.md).

**Termination:** Completed iff current criteria/evidence/authority/bindings satisfy Completion Guard and no conflicting UNKNOWN or safety hold remains. Failed iff recovery is exhausted or impossible with explicit typed reason; Cancelled iff requested cancellation has reached safe convergence/recorded disposition; deadline expiry yields a **terminal Failed with `reason=DeadlineExceeded`** after the required reconciliation/safe-stop protocol, not a new unapproved Task enum. Inability to prove convergence transitions to bounded `Blocked/Reconciling` with a durable wait reason and next escalation deadline; **never** falsely marks terminal or retries indefinitely. All terminal facts are immutable.

**No-progress bound (proposed operational default):** after 3 consecutive decision cycles with no new authoritative evidence, changed plan/evidence obligations, completed work, or user input, the loop must stop model/tool churn, diagnose once from existing facts and either wait for a named external dependency, request clarification, or commit Failed(`NoProgress`) if safe to do so. Each PlanStep gets at most 2 autonomous repair attempts before an explicitly budgeted L2 decision or Failed(`RepairExhausted`). These are tuning hypotheses requiring G3/G4 evaluation, not measured optimums; local policy may lower them but cannot bypass safety holds.

## 5. Cross-domain composition without authority sharing

A future *thin coordinator* may store a **dependency graph of Task IDs and exact ArtifactRefs**, not combined private memory or shared mutable DomainBinding. The first slice supports explicit sequential handoff as in [Domain Workflow](domain-workflow.md); automatic autonomous fan-out and D9 remain deferred. Proposed dependency record: `handoff_id, producer_task, producer_artifact_id/digest/schema, consumer_task/domain/profile, authorized_purpose, required_schema, scoped_read_grant_ref, dependency_policy`. Allowed `dependency_policy`: `require_success` (otherwise consumer remains Blocked), `allow_partial_with_explicit_criteria`, or `skip_on_failed_dependency`. Failures never propagate as fabricated success. Fan-out requires separate producer/user authorization for every consumer; neither budgets, approvals, OAuth tokens, context nor Host privileges are inherited. A coordinator may only request Task creation/activation through existing Kernel authorization; it cannot commit task status. Revoked/expired ScopedReadGrant prevents new reads; previously delivered bytes are not retroactively erased.

Resource arbitration remains Kernel/Host admission over declared per-Task/per-Host limits; one task's long render must not monopolize unrelated authorized work without a configured fairness/quota policy. Initial scheduler is sequential within one Task, optional bounded independent reads with proven non-conflict, and bounded Host media workers; no speculative distributed scheduler.

## 6. Office third-domain falsification example (design only)

An `office` domain registers `office.basic@0.1`: Goal payload `{document_refs, operation, output_format, criteria}`; typed `office.document.edit` and `office.sheet.batch_update` tools; context projection for document sections/sheet ranges; `office.document.v1` and `office.table.v1` artifact schemas; independent checks for content/format/range and immutable exported bytes.

**Hypothetical / mock-only until owner-approved external-effect profile:** Task O binds Office profile → user authorizes exact external app/account, document ID and edit scope → adapter suggests batched structured edits → Kernel reserves rate quota and checks current OAuth scope/approval → a *mock* Trusted Host/remote API executes an exact request with a simulated credential boundary → immutable simulated revision/etag + authenticated test receipt and exported artifact digest enter evidence → deterministic checks plus any policy-required human review → Completion Guard → delivered ArtifactRef. A simulated timeout after possible mutation yields `OutcomeUnknown`; only authoritative revision/status reconciliation could permit a safe retry. **For a real external provider, an Office edit/write is R2 unless the owner formally approves a narrower risk classification backed by enforceable Host/provider controls; an individual user approval does not override the global R2-disabled default.** Real network egress, OAuth secrets, external edits, delete/send/share/publish and irreversible operations stay **disabled** until the Host risk/TTL/fence policy and provider idempotency/status semantics are explicitly approved and verified. The G5 mock proves interface shape, not real-world external service safety. Concurrent editors cause etag/read-set conflict and refresh; the Kernel loop, TaskControl, Invocation, terminal and ArtifactRef protocols are **unchanged**.

**Falsification gate:** if Office requires an Office-specific branch in Kernel Loop, Task terminal enum, permission state machine, provider-ambiguity rules, or Host side-effect semantics, reject the proposed adapter boundary and reopen G0. A new typed tool/resource dimension and external account principal are normal extensions **only if** the existing admission/Host contracts can enforce them.

## 7. Portability and acceptance fixtures

| Fixture | Initial facts | Expected result |
| --- | --- | --- |
| X1 register Office | Valid manifest/profile but no Kernel domain-id special case | Profile can bind a new Task; same core event/authority machinery |
| X2 unknown effect or changed digest | Version/manifest/tool schema mismatch | Reject before model/tool admission, preserve audit |
| X3 Office ambiguous external edit | Provider accepted mutation, response lost | UNKNOWN retained, no blind retry; reconcile by exact revision |
| X4 cross-domain Coding→Video | Exact ArtifactRef with scoped read grant | Consumer may read exact digest only; no producer grant/context inheritance |
| X5 delayed Video render | Cancel before Host convergence, partial staging output | Stay Reconciling/UNKNOWN; no output publication or false Completed |
| X6 cheap Coding path | Evidence suffices deterministically and independent model review not required | No verifier ModelStep; still run all mandatory tests and Completion Guard |
| X7 high-risk/ambiguous path | Semantic concern or human gate required | Fresh independent review/human approval; no cheap-path bypass |
| X8 timeout/no progress | Deadline or bounded stall reached | Safe stop, durable typed outcome/wait; zero unbounded requeue |

A **contract-level static pass** requires an owner-reviewed schema inventory, every named port's input/output example, stable authorization state/error mapping, cross-document consistency and Office X1–X8 walk-through. **G1/G2/G3/G4/G5 remain NOT RUN** unless evidence is attached to named implementations/environments. Do not infer provider billing, Host enforcement, runtime speed or editing quality from this document.

## 8. Stable / extensible / deliberately deferred

**Stable for v0.1 proposal:** Task/Goal/Plan/ModelStep/Invocation IDs and legal transition ownership, K-local reservations/intent/journal/outbox, separate K/G/H facts, Host-local launch/fence/receipt, cancellation/UNKNOWN, terminal CAS, ArtifactRef digest/handoff, criterion/evidence binding and Completion Guard.

**Extension surface:** profile schemas, domain cognitive policy, context projection, capability/tool catalog, verifier rubric/assurance obligations (never below Kernel minimum), artifact kinds, provider adapter traits with proven limits, resource dimension adapters and Host-supported execution profiles.

**Deferred:** multi-Host linearizability, arbitrary cross-domain autonomous DAG orchestration, untrusted in-process plugins, agent swarms, Office implementation, external R2 effects, and any performance target without a measured baseline.
