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
| Profile admission/dispatch freshness | New admission or Host launch under a Superseded/Revoked profile, stale profile-authority epoch, replayed dispatch ticket, or old accepted PlanRevision; ordering of LaunchGate and authority-fence commits | Any launch after the effective revocation fence is a blocker |
| Cross-domain handoff isolation | Reads outside exact ArtifactRef scope, missing/expired/revoked ScopedReadGrant, locator leakage, transitive artifact traversal, inherited producer permissions/context, or broken lineage | Any unauthorized disclosure or inherited authority is a blocker |
| Recovery correctness | Journal reconstruction, Host receipt import, checkpoint integrity, fencing, and safe resume after restart/compaction | Recovery must not duplicate or authorize stale work |
| Provenance and audit completeness | Traceability of ModelSteps, ActionProposals, ToolInvocations, approvals, Host receipts, resource reservations, artifact digests, and delivery | Missing critical evidence blocks a trustworthy completion claim |
| User-control correctness | Clarification, approval, rejection, revocation, steering, follow-up, wait, and cancellation are applied to the correct task/version | User control must not be bypassed or applied to stale work |
| Terminal-state integrity | Completed/Failed/Cancelled terminal facts remain immutable; late evidence and budget overruns use explicit holds/records | No silent terminal-state rewrite |

Report attempts and actual executions separately. A denied unauthorized proposal is a security event to measure, but it is not equivalent to an executed unauthorized side effect. A safe block on unresolved UNKNOWN is not a successful task completion, but it may be the correct safety outcome.

## 4. Shared fault and race scenarios

At minimum, prepare deterministic scenarios for:

1. **Revocation before admission or ticket issue:** revoke a principal, capability, approval, or Workflow Profile before a new invocation is admitted. No AdmissionTicket or dispatch ticket may be issued under the withdrawn authority.
2. **LaunchGate/revocation race:** deterministically run both orders for the same Host gate. If process creation crosses the launch boundary first, the Host receipt must order it before the revocation fence and the invocation follows drain/cancel policy. If the revocation fence commits first, the old ticket is rejected and no process is created.
3. **Authority unavailable, Host partition, and ticket replay:** a Host cannot reach current authority, is not fenced, or receives a duplicate/expired one-use ticket. It must fail closed; revocation remains Pending until all eligible gates acknowledge or are verifiably disabled.
4. **Host crash around launch boundary:** crash after durable launch intent but before process creation, and after process creation but before receipt persistence. Reconcile Host Ledger/process/output state; the latter remains UNKNOWN until resolved and must not be treated as non-execution.
5. **Cancellation race:** cancellation arrives before dispatch, during execution, after process exit, or while receipts are being reconciled.
6. **Process-tree leak:** the parent process exits while a descendant can still write to the workspace or media output.
7. **Budget exhaustion/late overrun:** hard budget is exhausted during a long operation, or an overrun is reported after Task terminalization.
8. **Stale evidence:** workspace/project generation, source digest, timeline, render plan, environment, or tool version changes after verification.
9. **Checkpoint/compaction recovery:** restart from a checkpoint whose historical approvals/leases are expired; verify that no new operation resumes without fresh admission.
10. **Publication conflict:** two operations target the same deliverable, or a partial/UNKNOWN output competes with a newer accepted revision.
11. **Domain isolation and ArtifactRef handoff:** a Coding Task cannot load Video-only schemas/tools and a Video Task cannot interpret RepositoryModel payloads. A consumer may read only the exact typed ArtifactRef under a server-side ScopedReadGrant. Test wrong consumer/purpose/digest/schema, expired/revoked grants, grant replay, resolver locator leakage, parent/sibling traversal, producer workspace/project access, and attempts to inherit producer approvals, tools, secrets, budgets, or private context.
12. **Terminal-state race:** cancellation, completion, late Host evidence, and resource settlement race; the Kernel preserves one valid terminal fact and records late conflicts separately.
13. **Revocation during stream/range read:** revoke the handoff after a stream opens but before subsequent chunks/ranges. No further bytes are delivered after the grant fence; bytes already delivered remain governed by the declared retention policy.
14. **Handoff transitivity and materialized copies:** attempt to follow parent/derived/sibling references or onward-share a consumer copy without a new grant; deny traversal/sharing and verify that copied bytes remain separately auditable under retention/deletion policy.


Use analogous domain fixtures where meaningful: a repository build/test process for Coding and an FFmpeg RenderJob for Video. The exact host process, resource dimensions, and artifacts differ, while the admission, receipt, cancellation, UNKNOWN, and recovery invariants remain the same.

## 5. Experimental controls and reporting

Pin and record for every run:

- Kernel build/commit and contract/schema versions;
- domain ID, DomainBinding, Workflow Profile, and tool-definition snapshots;
- Task, UserIntent, GoalContract, PlanRevision, and workspace/project generation;
- principal, policy, capability, approval, profile-authority and Host LaunchGate fence versions;
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
