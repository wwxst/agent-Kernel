# Domain Extension Contract v0.2 — construction baseline

> **Status: ACCEPTED for construction (ARB-01, 2026-11-03); design-only for Office; implementation NOT started; runtime claims UNVERIFIED.**
>
> This is a minimal adapter ABI candidate, not a deployed plugin system, external authority grant, or D9/Multi-Agent enablement. Field shapes are owned by [Kernel data model](kernel-data-model.md); per-domain execution policy is owned by [Execution Strategy](execution-strategy.md) (DES); permission facts are owned by [Permissions](../security/permissions.md). Kernel authority, Host fence, UNKNOWN, billing and completion obligations remain those of [Core Protocol](core-protocol.md), [Domain Workflow](domain-workflow.md) and [Completion](completion.md).

## 1. Boundary and neutrality requirement

**Design choice:** one authoritative Kernel + one Task Orchestrator loop per Task + a version-pinned domain adapter. Every domain difference enters the Kernel as **data**: the DomainBinding, the bound ExecutionStrategy, the digested ToolDefinition, and typed adapter payloads.

An adapter may propose intents, schemas and evidence obligations. It **cannot** commit TaskControl, bypass Model Gateway, admit an Invocation, mint a capability, settle a bill, mark a Host process converged, or finish a Task.

**Neutrality rule.** No Kernel, Host or Completion-Guard rule names a domain, and none reads `domain_id` for behaviour. Shared obligations are expressed only as generic **evidence classes**, matched by id rather than by domain: `protected_input_view` (the enforced effective input view of a run), `machine_check` (a deterministic check bound to an execution receipt), `output_inspection` (examination of the actual deliverable), `provenance_map` (input→output lineage for the delivered artifact), `external_target_identity` (the external target's own revision/state at the effect boundary) and `human_disposition` (authenticated human judgement). These six identifiers are defined by [Completion §1.1](completion.md), which owns the evidence-class enum; this contract only references them and may not restate or extend the list. A rule that **decides behaviour by domain name** in Kernel, Host or Guard is a defect, not an extension. Labelled profile-instance examples (for documentation clarity) are not branches and may name a domain. A new domain must land with **zero Kernel file, enum, event, error-code or state-machine changes**; only manifest, profile, strategy, tool, artifact and verification-policy additions.

Excluded by design: plugin marketplace, untrusted in-process plugins inside the Kernel authority process, a general distributed workflow engine, a universal semantic model, a per-domain Kernel state machine, and automatic agent-to-agent delegation. Domain code runs in the adapter boundary; all effects pass Kernel Admission and Trusted ToolHost.

## 2. Manifest, profile and activation

`DomainManifest` is canonical (RFC 8785 JCS), content-digested and immutable after activation. It must declare every field the Kernel validates for a DomainBinding ([Data model §3.4](kernel-data-model.md#34-domainbinding-and-workflow-profile)); a manifest that omits or merely implies one is rejected at registration.

| Required manifest field | Contract |
| --- | --- |
| `domain_id`, `adapter_api_version`, `manifest_version`, `digest`, `publisher`, `adapter_artifact_digest` | Unique namespace, API compatibility, integrity, publisher identity and the digest of the **deployed adapter artifact**. Optional `signature_ref` only; this version imposes no PKI/attestation requirement. |
| `contract_versions` | Goal/plan/evidence/artifact/tool schema id+version map, copied into the binding verbatim |
| `workflow_profiles[]` | `profile_id/version/digest`, goal and PlanStep payload schemas, supported task families, context-policy ref, `strategy_refs[]` (exactly one default), `resource_policy_id/version`, `verification_policy_id/version`, `required_host_profiles[]` |
| `tools[]` | ToolDefinition id/version/digest, argument/result schema ids, `effect_class`, `conflict_scope_rule`, `idempotency_class`, resource dimensions, deadline/cancellation semantics, approval-policy ref |
| `artifact_types[]`, `evidence_types[]` | Namespaced schema id/version; payload opaque to Kernel |
| `verification_policies[]` | The **only** owner of required evidence class, independence floor, human gates and evidence carry-forward, keyed by criterion class (§3.1) |
| `delivery` | Deliverable artifact kinds, publication gate, retention and deletion rules |
| `cancellation_recovery` | Per-effect-class cancellation disposition, required convergence evidence, reconciliation probe definitions |
| `compatibility` | Supported Kernel contract range, required event-schema version, minimum API, explicitly unsupported capabilities |

**Effect-class authority.** The manifest's `effect_class` is a classification proposal bound into the ToolDefinition digest. At admission the Kernel **re-derives** the effective class from the digest-covered ToolDefinition, the canonical arguments and the resolved target, exactly as for any tool ([Data model §3.7](kernel-data-model.md#37-toolinvocation)). A `DecisionIntent` declaration is a proposal; if it differs from the derived value the admission is rejected with `EffectClassMismatch`, a security event is emitted, and no retry-by-relabelling is possible. R2 can never be introduced by an adapter, and R2 enablement is an operator/owner risk-policy decision — it is **not** a manifest field ([Trusted Host](../security/trusted-host.md)).

**Activation.** There is one registry lifecycle, recorded in `AuthorityState` (not on the immutable binding): `Draft → Validated → Active → Superseded`, with `RevocationPending`/`Revoked` ([Data model §3.21](kernel-data-model.md), [Domain Workflow §3.1](domain-workflow.md)). Registering a manifest creates candidates only. Activation is performed by an `operator` principal holding `profile.activate`; revocation requires `profile.revoke` ([Permissions §3](../security/permissions.md)). Activation advances the monotonic `authority_epoch` for the affected scope and is **availability, not authority**: at every admission the Kernel intersects profile restrictions with current principal, capability, policy, approval, budget and Host capability.

Changing any manifest, profile, strategy or adapter-artifact digest on a live Task is a **structural L2 change** — freeze/drain/reconcile/confirmation/atomic activation, never an in-place binding rewrite. Superseded or revoked digests remain readable for provenance and can never authorize new execution. Unknown required/safety/effect/resource/assurance declarations fail registration and admission closed; unknown optional `ext.*` metadata is digest-bound and ignored.

## 3. Ports, envelopes and errors

Ports are logical, not language signatures. Every call carries the shared envelope; domain payloads are versioned, bounded (≤256 KiB inline) and content-digested.

**Envelope (all ports):** `contract_version, task_id, binding_digest, goal_version, plan_revision_id, strategy_ref, correlation_id, idempotency_id, input_digest, deadline, trace_id`. A proposed mutation additionally carries the exact `read_set`: goal/plan revision, `authority_epoch`, profile digest, workspace generation or project snapshot, budget-scope version, tool digest, step precondition digest.

**Canonical digest.** All payloads, arguments and results are canonicalized per [Data model §2.2](kernel-data-model.md#22-digests-and-canonicalization) (RFC 8785 JCS over UTF-8, NFC, no duplicate keys; digest fields excluded from their own input). `canonical_args_digest` is computed over the JCS form of the argument object validated against the declared argument schema; two encodings of the same arguments must produce one digest.

### 3.1 Port contracts

| Port | Required input | Required output | Idempotency |
| --- | --- | --- | --- |
| `interpretGoal` | `user_intent_ref+digest`, `allowed_profile_ref`, `clarification_digests[]` | `GoalCandidate{schema_id/version, payload_digest, criteria[], ambiguity[], risk{class, rationale}}` | Pure. Same `idempotency_id`+`input_digest` returns the identical candidate; never creates a goal version |
| `projectContext` | `purpose`, `snapshot_refs[]`, `evidence_cursor`, `token_cap` | `ContextManifest{sources[]{source_id, digest, kind, scope}, omissions[], freshness_basis, redactions[], token_estimate, truncated}` | Pure and cacheable; key per DES F9 (source digest + tool/parser version + scope + privacy policy) |
| `decideNext` | `goal_version`, `plan_revision_id`, `read_set`, `evidence_gaps[]`, `remaining_budget`, `strategy_ref` | `DecisionIntent{decision_id, purpose, items[], need_user?, no_progress_reason?, read_set}` | Pure. A duplicate `idempotency_id` returns the same intent and item digests; it must not mint new invocation identities |
| `interpretOutcome` | `receipt_refs[]`, `artifact_refs[]`, `evidence_cursor` | `DomainObservation{typed_refs[], affected_criteria[], invalidations[]}` | Idempotent per `event_id`/receipt-digest set; re-delivery yields the same observation |
| `verifyCriteria` | `criterion_ids[]`, `required_evidence` per criterion class, `artifact_snapshot`, `environment` | `VerificationProposal{criterion_verdicts[]{criterion_id, verdict, evidence_refs[], independence, assurance_gaps[]}, human_disposition_required[]}` | Re-runnable read-only; never mutates artifacts or evidence; a verdict derived under changed digests is invalid, not reused |
| `describeRecovery` | reconciled K facts, reconciled H facts, `unknown_scope` | `RecoverySuggestion{safe_next?, blocking_scope?, next_probe?}` | Advisory and pure; Kernel alone decides retry/admission |

**`DecisionIntent.items[]` (each item):** `item_id`, `kind` (`tool_invocation | ask | wait | stop`), `tool_definition_digest`, `canonical_args_digest`, `target_identity`, `declared_effect_class`, `declared_conflict_scope`, `dependency_refs[]`, `requested_resource_reservation`, `result_expectations[]`, `criterion_refs[]`. Items are finite and ordered. No item carries a bearer permission, path locator or credential.

**Criterion-class binding.** Every `criteria[].required_evidence_class[]` entry must resolve, through the bound profile, to exactly one `verification_policies[]` entry carrying the policy `id/version`. A criterion class with no policy, or with two, fails binding validation. There is no policy-free "class".

### 3.2 Adapter error codes and Kernel disposition

Adapter errors are data; they never license Kernel to reinterpret domain semantics. Each maps to exactly one Kernel disposition from [Data model §6](kernel-data-model.md#6-error-and-disposition-catalog).

| Adapter code | Meaning | Kernel disposition |
| --- | --- | --- |
| `UnsupportedProfile` | Manifest/API/profile unsupported by this Kernel | Reject binding (`SchemaInvalid`) |
| `InvalidDomainPayload` | Payload fails its declared schema/digest | Reject (`SchemaInvalid`) |
| `ContextStale` | Projection older than the bound read-set | Reject, refresh (`StaleBinding`) |
| `EvidenceInsufficient` | Required criterion evidence missing or untrusted | Block completion; request evidence |
| `NeedsAuthorization` | Missing/expired capability, approval or OAuth scope | Park as `Approval` WaitRecord or deny (`AuthorityDenied`) |
| `ResourceUnavailable` | Declared resource/quota unavailable | Queue per strategy or reject |
| `RetryableNoEffect` | Proven that no physical/provider effect was possible (pre-effect) | Retry permitted with proof |
| `EffectNotApplied` | Target affirmatively rejected, or Host proves no effect occurred | Admit a **new** Invocation with new arguments; never an automatic replay of the old one |
| `PreconditionFailed` | Declared revision/etag/hash precondition did not match; no effect applied | `FailedKnown`; require a fresh read/decision, then a new Invocation |
| `EffectClassMismatch` | Declared class/scope differs from the Kernel-derived value | Reject before admission; security event; no downgrade |
| `HostCapabilityMissing` | No Host profile can enforce the required isolation/resource dimension | Reject or mark `Unverified` (`UnsupportedEnvironment`) |
| `OutcomeUnknown` | Effect may have occurred and the outcome is not authoritative | Retain conflict and budget holds; reconcile; no blind retry |

`PreconditionFailed` and `EffectNotApplied` are **not** `OutcomeUnknown`: they assert a known no-effect outcome. `RetryableNoEffect` asserts no effect was *possible*. Deadlines and cancellation never recast UNKNOWN as failure.

### 3.3 Event exchange

Kernel publishes the append-only catalog in [Data model §4](kernel-data-model.md#4-kernel-event-catalog); adapters consume it idempotently by `event_id`, rebuild projections after a gap from a Kernel snapshot plus the Journal cursor, and never write the Journal. A Kernel event is not assurance that an external side effect occurred unless authenticated Host/provider facts support it.

## 4. Loop, assurance ownership and waits

One orchestrator runs the single priority-ordered loop defined in [Core §12](core-protocol.md). That algorithm is the only normative priority order; this contract adds no second ordering. The loop branches on state and policy values only; a Strategy decision is requested on ambiguity or L2 cutover, not before each tool.

**Single assurance owner.** `verification_policies[]` is the only owner of required evidence class, independence floor and human gates. The bound `ExecutionStrategy` may add **additional** review triggers and tighten thresholds; it may never restate, weaken or lower a policy obligation ([DES §2–§3](execution-strategy.md)). A fresh independent Verifier runs when the policy demands it, evidence is disputed or stale, a protected input changed, or a risk trigger is met; the deterministic Completion Guard always runs and cannot be optimized out.

**Waits and termination.** Every persisted non-terminal wait is a Kernel `WaitRecord` with `reason_code, blocking_scope, owner, next_wake_at, max_wait_until, recovery_strategy` ([Data model §3.12](kernel-data-model.md#312-waitrecord)); reason codes include `Approval`, `ExternalJob`, `RateLimit`, `Dependency`, `ProviderReconciliation`, `HostReconciliation`. No adapter-visible intermediate state exists: a task is `Open` with a persisted wait, or terminal.

Terminal disposition uses the existing taxonomy: `Completed` only via Completion Guard; `Cancelled` only with cancellation disposition and proven effect state; `Failed(reason)` with `DeadlineExceeded | NoProgress | BudgetExhausted | UnsafeEnvironment | RepairExhausted | UnresolvedEffect | DependencyFailed | PolicyDenied`. Repair, no-progress and deadline bounds are declared by the strategy within the DES maxima ([DES §4.5](execution-strategy.md)); this contract fixes no numeric value, and every terminal fact is immutable.

## 5. Multi-domain composition

A multi-domain task is an ordered set of **independently authorized Tasks** plus a derived record. It is not a composite Task and creates no new authority.

`CompositePlan` (**derived, read-only projection**; not a Kernel aggregate, no CAS, no terminal state, no event of its own):

```
{composite_id, principal, intent_ref,
 steps[]{step_id, task_id, domain, binding_digest,
         inputs[]{from_step, artifact_ref, schema, purpose, access_mode, grant_ref},
         failure_policy, deadline, budget_ref},
 delivery{final_artifact_refs[], report_digests[], composite_criteria[]}}
```

Rules:

1. **Executor.** The Application layer creates and starts each step under existing task-creation authorization (`task.create`) and records the `CompositePlan` as a projection; it has no capability to admit, approve, spend or terminate.
2. **Per-step authority.** Each step Task carries its own principal, DomainBinding, profile, approvals, budget, tools and verifier; nothing is inherited — not grants, approvals, context, budget, Host privilege or OAuth scope ([Permissions §3](../security/permissions.md)).
3. **Inputs.** Every edge requires its own handoff and `ScopedReadGrant` for the exact artifact digest, consumer Task, purpose and access mode ([Domain Workflow §11](domain-workflow.md)). ArtifactRef is an identifier, never a capability.
4. **Failure policies.** `require_success` — the consumer Task is not created until the producer reaches `Completed` and a current grant exists. `skip_on_failed_dependency` — the consumer is created with the dependent criterion `Fail`/`Unverified`, never `Pass`. `allow_partial_with_explicit_criteria` is **removed**: partial, staging, quarantined, missing or digest-mismatched artifacts are not consumable ([Domain Workflow §11](domain-workflow.md)).
5. **UNKNOWN.** A producer `OutcomeUnknown` creates no consumer and no fabricated success; the composite stays undelivered for that branch.
6. **Late failure.** A producer failing after a consumer already completed does not reopen a terminal Task (terminal facts are immutable); the composite delivery reports the failed step and is not "accepted". Remediation, if any, is a separately authorized Task.
7. **Delivery.** Composite delivery is published by the existing Delivery path only when every contributing step is `Completed` and each report is current; otherwise an explicitly partial record lists which criteria are unmet.
8. **Deferred.** Fan-out and parallel branches, agent-driven graph expansion, cross-task budget pooling, shared context, inherited approvals, composite re-planning, a durable coordinator service and D9/Multi-Agent remain deferred.

## 6. Office third-domain validation sample (design only)

Scope is deliberately **R0 read + R1 local export**. External in-place document edit is an R2 external effect and stays disabled, so it is neither implemented nor mocked; the sample proves the adapter boundary, not external-service safety.

- **Manifest** `office.basic@0.1`, profile `office.basic`, strategy `office.local_export@0.1` (DES §7.3), one verification policy, artifact types `office.document.v1` and `office.table.v1`.
- **Tools.** `office.document.read` — R0, `conflict_scope_rule = document:{id}`, `idempotency_class = effect_free`, arguments `{document_ref, ranges[], schema_version}`, result `{sections[], table_facts[], provider_revision, source_digest}`. `office.document.export` — R1, new content-addressed artifact in a Host-isolated output root, `conflict_scope_rule = export:{task}/{target_id}`, `idempotency_class = content_addressed`, arguments `{source_digest, editset_digest, format}`, result `{artifact_ref, bytes_digest, format_report}`; publication of the final artifact remains guarded.
- **Criteria.** C1 required sections present (deterministic, from the read manifest); C2 exported values equal `table_facts` by digest (independent oracle, not the adapter's self-report); C3 declared-style formatting preserved → `human_disposition_required`; C4 source document unmutated (`provider_revision` unchanged, `external_target_identity` evidence).
- **UNKNOWN and waits.** Host crash after output write and before publish → Invocation `OutcomeUnknown`, reconciled from the output-root manifest digest plus the publication fence; safe retry only with the same target id. OAuth scope revoked → `NeedsAuthorization`, persisted re-authorization `Approval` WaitRecord. Rate limit → `RateLimit` WaitRecord with bounded wake. Revision/etag conflict → `PreconditionFailed`, then a fresh read.
- **No new Kernel state.** The task uses existing Goal/Plan/Invocation/budget/UNKNOWN/WaitRecord/Completion machinery; additions are namespaced schemas, two tool definitions, one strategy, one verification policy and one artifact type.

**Falsification gate.** If Office — or any added domain — requires a domain-specific branch in the Kernel loop, terminal enum, permission state machine, provider-ambiguity rule or Host side-effect semantic, the adapter boundary is rejected and the extension decision is reopened. A new typed tool, resource dimension or external account principal is a normal extension **only if** the existing admission/Host contracts can enforce it.

## 7. Conformance fixtures (design; PE NOT RUN)

X1–X8 are **extension-conformance** fixtures, not an Office test suite; Office-specific cases are X1, X3 and X9–X12.

| Fixture | Scope | Initial facts | Expected |
| --- | --- | --- | --- |
| X1 register Office | manifest/profile | valid manifest, no Kernel special case | binds a new Task; identical event/authority machinery |
| X2 unknown effect or changed digest | manifest/tool | version, schema or digest mismatch | reject before model/tool admission; audit preserved |
| X3 ambiguous external write (design-only simulation; R2 not enabled) | effect semantics | simulated provider accepts a mutation, response lost | UNKNOWN retained, no blind retry, reconcile by exact revision; proves the protocol, enables no real external effect |
| X4 cross-domain Coding→Video | handoff | exact ArtifactRef + grant | consumer reads exact digest only; no producer grant/context inheritance |
| X5 delayed Video render | long job | cancel before Host convergence, partial staging | task stays `Open` with an UNKNOWN reconciliation wait; no publication, no false Completed |
| X6 cheap Coding path | fast path | deterministic evidence suffices | no verifier ModelStep; all mandatory checks and Guard still run |
| X7 high-risk/ambiguous | assurance | semantic concern or human gate | fresh independent review/human approval; no cheap-path bypass |
| X8 timeout/no progress | control | deadline or bounded stall | safe stop, typed outcome/WaitRecord, zero unbounded requeue |
| X9 OAuth scope revoked mid-batch | Office R0/R1 | read succeeds, scope revoked before export | `NeedsAuthorization` WaitRecord; no partial artifact published; no retry loop |
| X10 revision/etag conflict | Office | edit set built on a stale `provider_revision` | `PreconditionFailed`; re-read and re-decide; never a blind replay |
| X11 rate limit with batch partial | Office | provider 429 mid-batch over an ordered item list | `RateLimit` WaitRecord with bounded wake; completed items retained as evidence; no duplicate effect |
| X12 approval expired before dispatch | permission | approval valid at admission, expired at the Host gate | launch denied; no side effect; typed disposition |
| X13 fourth domain, zero Kernel diff | neutrality | an **independent** author (not the adapter author) adds a domain using only manifest/profile/strategy/tool/policy files | no Kernel file, enum, event or error-code change; `domain_id`-branch static scan clean; existing fixtures unchanged |

A contract-level static pass additionally requires an owner-reviewed schema inventory, an input/output example per port, stable authorization/error mapping and cross-document consistency. PE and VI remain **NOT RUN** unless evidence is attached to named implementations and environments.

## 8. Stable, extensible, deferred

**Stable for v0.2:** Task/Goal/Plan/ModelStep/Invocation identity and transition ownership, K-local reservations/intent/journal/outbox, separate K/G/H facts, Host-local launch/fence/receipt, cancellation/UNKNOWN, terminal CAS, ArtifactRef digest/handoff, criterion/evidence binding, Completion Guard and WaitRecord.

**Extension surface:** profile schemas, criterion classes and verification policies, context projection, tool catalog, strategy values within the DES floor, artifact kinds, resource dimensions and Host-supported execution profiles.

**Deferred:** multi-Host linearizability, arbitrary autonomous cross-domain DAG orchestration, untrusted in-process plugins, agent swarms, Office implementation, external R2 effects, and any performance target without a measured baseline. Multi-Agent/D9 remains deferred and unauthorized.
