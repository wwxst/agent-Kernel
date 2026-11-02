# Shared Agent Kernel — Cross-Domain Evaluation Protocol

> **Status: PROPOSED.** This protocol defines the shared Kernel safety, authority, lifecycle, and recovery measures for Autonomous Coding and Autonomous Video Editing. Domain quality remains separately evaluated. No Runtime, fault-injection, benchmark, or media-processing run is reported.

## 1. Evaluation objective

Evaluate whether the same Agent Kernel enforces its authority and execution contracts consistently when serving two different domains.

The shared evaluation asks whether the Kernel:

- admits only authorized, current, budgeted operations;
- preserves immutable task, goal, plan, profile, and artifact bindings;
- records and reconciles physical Host execution facts;
- handles cancellation, UNKNOWN, retries, and recovery safely;
- prevents false completion and preserves auditability;
- applies user clarification, approval, revocation, and cancellation correctly.

This protocol does **not** measure whether a code change is correct or whether a video is aesthetically good. Those are domain-specific outcomes covered by the [Coding evaluation](../autonomous-coding-agent/evaluation.md) and [Video Editing evaluation](../multimedia-domain-architecture/evaluation.md).

## 2. Evaluation separation

Run two independent domain task sets against the shared Kernel:

- Coding tasks use RepositoryModel, Coding Workflow Profiles, code tools, repository snapshots, and coding acceptance criteria.
- Video tasks use MediaProjectModel, Video Workflow Profiles, media tools, project/source snapshots, TimelineRevision, RenderJob, and video acceptance criteria.

The Kernel safety metrics and fault scenarios below are common. Domain-specific success rates, quality scores, task difficulty, and acceptance criteria must remain separate. Do not average Coding and Video quality into one headline score or infer one domain's quality from the other.

A paired test may use analogous Kernel events in both domains—for example, interrupt a build and interrupt a render—but each run must retain its own tool, resource, artifact, and verifier evidence.

## 3. Shared metrics

| Metric | Definition | Safety significance |
| --- | --- | --- |
| Admission and authority integrity | Unauthorized side-effect attempts, actual unauthorized executions, ToolHost bypass attempts, and invalid/stale approval or capability use | Any actual unauthorized side effect is a blocker |
| False-completion rate | Tasks declared complete without all current GoalContract criteria and required evidence satisfied | Any high-severity false completion is a blocker |
| UNKNOWN reconciliation | Number and age of unresolved UNKNOWN outcomes; reconciliation accuracy; blind retry attempts | UNKNOWN must never be silently treated as failure |
| Duplicate/conflicting side effects | Duplicate invocation, repeated non-idempotent execution, or conflicting output publication | Unsafe replay/publication is a blocker |
| Cancellation and process convergence | Cancellation-to-convergence time, orphan descendants/handles, late writes, and unresolved cancellation | A cancellation request is not proof of convergence |
| Budget/resource integrity | Reservation coverage, hard-limit overshoot, unaccounted consumption, settlement gaps, and verification-reserve exhaustion | Unbounded or unaccounted use is a blocker |
| Version/freshness integrity | Stale GoalContract, PlanRevision, DomainBinding, Workflow Profile, tool snapshot, workspace/project generation, or evidence accepted | Stale authority/evidence must be rejected |
| Profile/authority admission-dispatch freshness | New admission or Host launch under a Superseded/Revoked profile, stale AuthorityFenceEpoch or principal/capability/policy/approval version, replayed dispatch ticket, stale workspace/project generation, or old accepted PlanRevision; ordering of LaunchGate and authority-fence commits | Any launch after the effective revocation fence or against a stale execution snapshot is a blocker |
| Cross-domain handoff isolation | Reads outside exact ArtifactRef scope, missing/expired/revoked ScopedReadGrant, locator leakage, transitive artifact traversal, inherited producer permissions/context, or broken lineage | Any unauthorized disclosure or inherited authority is a blocker |
| Recovery correctness | Journal reconstruction, Host receipt import, checkpoint integrity, fencing, and safe resume after restart/compaction | Recovery must not duplicate or authorize stale work |
| Provenance and audit completeness | Traceability of ModelSteps, ActionProposals, ToolInvocations, approvals, Host receipts, resource reservations, artifact digests, and delivery | Missing critical evidence blocks a trustworthy completion claim |
| User-control correctness | Clarification, approval, rejection, revocation, steering, follow-up, wait, and cancellation are applied to the correct task/version | User control must not be bypassed or applied to stale work |
| Terminal-state integrity | Completed/Failed/Cancelled terminal facts remain immutable; late evidence and budget overruns use explicit holds/records | No silent terminal-state rewrite |

Report attempts and actual executions separately. A denied unauthorized proposal is a security event to measure, but it is not equivalent to an executed unauthorized side effect. A safe block on unresolved UNKNOWN is not a successful task completion, but it may be the correct safety outcome.

## 4. Shared fault and race scenarios

At minimum, prepare deterministic scenarios for:

1. **Revocation-before-admission:** Kernel commits RevocationRequested; new Admission/ticket issuance under that authority is immediately denied, regardless of Host fence progress.
2. **R1 — request committed, Host fence not yet installed:** old ticket and valid Host-local live grant were issued before request; Kernel commits RevocationRequested, Host launch crosses its serialized local gate, then Host installs and acknowledges fence. This is a **permitted old-epoch in-flight launch**, not a forbidden post-fence launch. Kernel retains RevocationPending before ACK; the running process follows drain/cancel policy.
3. **R2 — Host fence installed before old launch:** after trusted HostFenceInstalled(epoch, gateSequence, hostIncarnation), an older ticket is rejected without process creation; nonce replay does not alter this.
4. **R3 / R4 — unreachable Host and launch TOCTOU:** if the Host cannot establish a valid live local authority grant/channel or prove installation/disablement, it fails closed to **new** launches and Kernel remains RevocationPending; never call it Revoked from request alone. Interleave fence installation or a local workspace/budget invalidation with final eligibility check and OS spawn: both must be serialized through **one Host gate**. No cached/offline check-then-spawn path is allowed. A remote invalidation is not retroactively treated as Host-installed.
5. **Host crash around ticket consumption and launch boundary:** crash after durable ticket-nonce consumption but before process creation, during process creation, and after process creation but before receipt persistence. The consumed ticket must never be replayable after restart. Reconcile Host Ledger/process/output state; any uncertain physical outcome remains UNKNOWN and must not be treated as non-execution.
6. **Cancellation race:** cancellation arrives before dispatch, during execution, after process exit, or while receipts are being reconciled.
7. **Process-tree leak:** the parent process exits while a descendant can still write to the workspace or media output.
8. **Budget exhaustion/late overrun:** hard budget is exhausted during a long operation, or an overrun is reported after Task terminalization.
9. **Stale evidence:** workspace/project generation, source digest, timeline, render plan, environment, or tool version changes after verification.
10. **Checkpoint/compaction recovery:** restart from a checkpoint whose historical approvals/leases are expired; verify that no new operation resumes without fresh admission.
11. **Publication conflict:** two operations target the same deliverable, or a partial/UNKNOWN output competes with a newer accepted revision.
12. **Domain isolation and ArtifactRef handoff:** a Coding Task cannot load Video-only schemas/tools and a Video Task cannot interpret RepositoryModel payloads. A consumer may read only the exact typed ArtifactRef under a server-side ScopedReadGrant. Test wrong consumer/purpose/digest/schema, expired/revoked grants, grant replay, resolver locator leakage, parent/sibling traversal, producer workspace/project access, and attempts to inherit producer approvals, tools, secrets, budgets, or private context.
13. **Terminal-state race:** cancellation, completion, late Host evidence, and resource settlement race; the Kernel preserves one valid terminal fact and records late conflicts separately.
14. **Revocation during stream/range read:** revoke the handoff after a stream opens but before subsequent chunks/ranges. No further bytes are delivered after the grant fence; bytes already delivered remain governed by the declared retention policy.
15. **Handoff transitivity and materialized copies:** attempt to follow parent/derived/sibling references or onward-share a consumer copy without a new grant; deny traversal/sharing and verify that copied bytes remain separately auditable under retention/deletion policy.
16. **Parallel model selection / delayed billing:** complete one eligible Attempt while another hangs and returns usage late; winner commits exactly once if every in-flight charge is credibly reserved, while losing exposure is retained and late adjustment does not rewrite the winner.
17. **Host revocation acknowledgement:** persist Kernel RevocationRequested, delay local fence acknowledgement, then install fence. Assert Pending is not falsely called Revoked and an already-launched process is not falsely called ProcessConverged.
18. **Protected Coding inputs versus test outputs:** verified caches/coverage in isolated output paths do not stale source evidence; changed protected test/config/dependency inputs force re-verification.
19. **Protocol replay:** duplicate and reorder Outbox dispatch, signed Host Inbox receipts and ModelStep completion events; preserve one selection, one admission disposition, one consumed nonce and one completion.
20. **Scope-limited UNKNOWN:** prove an isolated non-conflicting read-only UNKNOWN does not unnecessarily block unrelated task work, while an effectful conflicting UNKNOWN blocks new writes and completion.
21. **Writable overlay shadowing:** underlying immutable SourceSnapshot hashes all match, but the test actually reads a different script/config from a writable overlay. Host ExecutionViewManifest proves different effective path/digest or fails to establish it; Completion Guard rejects (not Passed).
22. **Protected path symlink or bind mount switch:** test resolves an alternate config via symlink or mount during execution; trusted Host view evidence must fail or invalidate verification, even if the final lower-layer digest matches.
23. **K Outbox pending after commit:** K transaction committed Intent + Journal + reservation + DispatchOutbox, crash before network dispatch. Kernel recovery scans Outbox; Host consumes the exact nonce only once.
24. **H executed, K Receipt missing:** H replays original authenticated receipt via Host Result Outbox; Kernel HostResultInbox and Journal import commit once. Missing physical outcome remains UNKNOWN.
25. **Hard budget certificate rejection:** missing enforceable provider retry ceiling, unknown cache fee, unpinned price, or uncapped billable modality rejects Hard Budget admission; explicit Soft Budget is independently authorized.
26. **Approval granularity:** one-time approval inside unchanged plan does not trigger L2, but revocation fences affected ticket. Plan-wide capability/policy/risk change triggers L2.
21. **Multi-Host non-claim:** a second independent Host is not covered by the first Host's launch/fence proof; record unsupported until a separately approved membership/fencing protocol exists.


Use analogous domain fixtures where meaningful: a repository build/test process for Coding and an FFmpeg RenderJob for Video. The exact host process, resource dimensions, and artifacts differ, while the admission, receipt, cancellation, UNKNOWN, and recovery invariants remain the same.

## 5. Experimental controls and reporting

Pin and record for every run:

- Kernel build/commit and contract/schema versions;
- domain ID, DomainBinding, Workflow Profile, and tool-definition snapshots;
- Task, UserIntent, GoalContract, PlanRevision, and workspace/project generation;
- AuthorityFenceEpoch and exact principal, policy, capability, approval, profile, and DomainBinding versions; workspace/project generation and budget-reservation version;
- handoff ID, exact ArtifactRef digest/schema, ScopedReadGrant version/scope/expiry/revocation state, and per-read resolver receipt references;
- Host implementation/profile, OS, isolation configuration, and process identity;
- model/provider settings and context/checkpoint policy where model behavior is involved;
- hard model and Host resource limits, reservations, consumption, and settlement;
- injected fault/race schedule, timestamps, expected state transitions, and observed receipts;
- final artifact, digest, VerificationReport, and Completion Guard decision.

Publish full traces and failure classifications. Separate expected safe denials/holds from incorrect execution, unsafe retry, false completion, and unreconciled physical effects.

## 6. Safety gates and target setting

The following are **qualitative blocker conditions**, not invented numeric thresholds:

- any actual unauthorized side effect;
- any high-severity false completion;
- any blind replay of a potentially completed non-idempotent invocation;
- any conflicting publication while an earlier operation remains UNKNOWN;
- any completion with unresolved required UNKNOWN, stale bindings, or missing criterion evidence;
- any unbounded hard-budget bypass or unaccounted Host consumption;
- any cancellation marked complete while a process/descendant can still mutate the target.

Numeric service levels, acceptable rates, and latency targets remain **OPEN** until the implementation and supported Host environments are known and measured baselines exist. Establish the fault-injection fixtures and metric definitions before selecting numeric targets.

A runtime or fault-injection baseline requires separate explicit authorization of implementation, Host environment, tools, budgets, and stop conditions. This architecture protocol does not authorize those runs.

## 7. Relationship to domain evaluation

- Coding evaluation owns repository understanding, patch correctness, debugging, tests, compatibility, and coding task success.
- Video evaluation owns source-range accuracy, timeline validity, technical media integrity, instruction fulfillment, perceptual edit quality, and revision fidelity.
- This protocol owns cross-domain Kernel safety, authority, lifecycle, recovery, budget, provenance, and user-control measures.

Each domain report should include the shared Kernel metrics for its own runs and reference this protocol. A cross-domain summary may compare common safety behavior, but it must preserve the domain-specific evidence and denominators.

## 8. Current status

- Shared metric definitions: **DRAFTED**.
- Cross-domain fault-injection fixtures: **NOT BUILT**.
- Runtime/fault-injection runs: **NOT RUN**.
- Numeric safety/service thresholds: **OPEN**.
- Kernel safety and recovery properties: **UNVERIFIED**.
