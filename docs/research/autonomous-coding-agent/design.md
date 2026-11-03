# Autonomous Coding Agent — Intelligent Execution Architecture

> **Status: ACCEPTED for construction (ARB-01, 2026-11-03) as the Coding domain construction specification; implementation NOT started; runtime/quality claims UNVERIFIED.**

The design is expressed as cognitive responsibilities, state contracts, and execution invariants — not a module list to translate directly into code. Record shapes, identifiers, enums and events are fixed in the [Kernel data model](../../contracts/kernel-data-model.md); execution-policy bounds are fixed in the [Domain Execution Strategy](../../contracts/execution-strategy.md). No runtime, language, package topology, provider, database, or sandbox product is selected by this document.

Sections, clauses or values that earlier revisions labelled PROPOSED are construction requirements under the same decision; only the items listed in §13 remain OPEN, and policy values remain tunable solely within the bounds cited here.

## 1. Design thesis

This document specifies Coding Domain Intelligence only. The shared three-layer platform and Workflow Profile boundary are defined in [Unified domain architecture](../../architecture/domain-architecture.md); Video's separate cognition is defined in [Video Editing domain design](../multimedia-domain-architecture/design.md).

The central problem is not how quickly an agent calls tools or how many agents can be started. It is whether one autonomous system can reliably take responsibility for a non-trivial software outcome:

- understand what the user actually wants and what must remain unchanged;
- discover how the repository works before changing it;
- build and maintain a sufficiently accurate model of the problem and codebase;
- choose a coherent implementation strategy and revise it when evidence changes;
- make changes that fit the existing architecture and conventions;
- diagnose failures through experiments rather than repeated guesses;
- verify the result against explicit acceptance criteria;
- preserve enough state to continue after context compaction, process restart, or partial execution;
- stop, ask, or escalate when the task is ambiguous, unsafe, blocked, or no longer making progress;
- provide evidence that the requested outcome was achieved.

A tool-calling loop is necessary, but it is not the complete Coding Agent. The system needs a goal-level control process, a repository/problem model, an adaptive execution process, and an independent assurance process. The Kernel makes the resulting actions safe and auditable; it must not attempt to hard-code the reasoning policy.

**Proposed north star:** optimize for verified task completion under explicit scope, risk, and resource constraints—not for tool-call throughput, model-turn count, or apparent completion.

## 2. What independent completion means

A task is independently completed only when all of the following are true:

1. **Intent is understood.** The desired outcome, constraints, exclusions, and acceptance criteria are explicit or are based on disclosed, low-risk assumptions.
2. **The repository is understood enough to act.** The agent has inspected the relevant code paths, project conventions, dependencies, and verification commands. It has not mistaken a plausible guess for a repository fact.
3. **The plan is adequate and adaptive.** The accepted plan covers the acceptance criteria, dependencies, expected artifacts, risk boundaries, and verification obligations. It is revised when new evidence invalidates its assumptions.
4. **Changes are coherent.** The patch implements the intended behavior, respects repository conventions, avoids unrelated churn, and is attributable to the accepted plan and workspace generation.
5. **Failures are handled intelligently.** The agent distinguishes code defects from environment, dependency, permission, flaky-test, and infrastructure failures. It does not repeat an unchanged failed action without a reason.
6. **Verification is real.** Required checks actually ran in a declared environment, their results are bound to the current plan and workspace, and every acceptance criterion has sufficient evidence.
7. **The final state is safe and recoverable.** No required operation is unresolved, no UNKNOWN side effect is ignored, and the final workspace snapshot is frozen and authenticated.
8. **The completion claim is bounded.** The final response says what changed, what was verified, what was not verified, and what remains uncertain.

The agent may finish a turn without finishing a task. It may also finish a PlanStep while the overall Task remains incomplete. A model's final text, an empty tool-call list, a green command exit code, or the existence of a diff is not a completion proof.

## 3. Architectural principles

### 3.1 One primary autonomous controller

**Construction rule:** the default execution model is one primary Orchestration controller operating a task from intake through verification. Explorer, Planner, Implementer, Debugger, and Verifier are decision modes or model-step purposes—not a requirement to create separate agent processes.

This keeps task ownership, context, plan revision, and responsibility coherent. Specialized model calls may use different prompts, model capabilities, or effort settings, but every call remains a Kernel-managed ModelStep.

Multi-Agent / D9 remains deferred and unauthorized. The architecture must demonstrate strong single-agent completion before delegation is reconsidered.

### 3.2 Separate cognition from authority

Orchestration may inspect, reason, propose plans, select strategies, diagnose, and recommend the next action. It may not directly write authoritative Task state, spend hard budget, grant capabilities, approve a side effect, or dispatch a tool.

Kernel owns legal transitions, accepted plan versions, hard budgets, approvals, admission, durable intent, and completion gates. Trusted ToolHost owns physical execution evidence. These boundaries remain deterministic even when the reasoning policy is adaptive.

### 3.3 Evidence before confidence

Every important repository claim, diagnosis, plan assumption, verification result, and completion statement must be traceable to evidence or explicitly labeled as a hypothesis or assumption.

Model confidence is not evidence. A summary is not a source. A successful command is evidence only for the command, environment, workspace, and time actually recorded.

### 3.4 Plan at the level of outcomes, act at the level of operations

A plan is a dependency-aware graph of meaningful work outcomes. It is not a transcript of every shell command or a fixed list of model turns. The agent chooses the next concrete operation at runtime based on the current plan, evidence, and constraints.

### 3.5 Replan on information, not on impatience

A new plan revision is warranted when evidence changes the problem model, an assumption fails, a dependency changes, the workspace diverges, a criterion is uncovered, or the current approach is no longer viable. Replanning must preserve completed evidence and explain what is superseded.

### 3.6 Verification is a first-class objective

The system reserves enough budget and time to verify and repair. It does not spend the entire task budget on exploration or implementation and then declare success without running the required checks.

## 4. Cognitive state model

These are conceptual records and contracts. They do not prescribe storage tables or source-code types.

### 4.1 GoalContract

The GoalContract converts the user's request into an inspectable target without replacing the original intent.

**Source of intent and versioning**

- The original user request is retained as an immutable, provenance-bound UserIntent record.
- User clarifications and corrections are appended as new immutable references; they do not overwrite the original request.
- Orchestration proposes GoalContract candidates. Kernel records accepted versions and their version lineage.
- An accepted GoalContract is immutable. A changed target produces a new candidate and, if accepted, a new version.

Proposed lifecycle:

Candidate → NeedsClarification | ReadyForAcceptance → Accepted → Superseded

Rejected candidates remain auditable as Rejected. A candidate is not task authority merely because a model generated it.

**Fields**

| Field | Meaning |
| --- | --- |
| Desired outcome | Observable behavior or deliverable the user expects |
| Scope and exclusions | In-scope repositories/packages/files/systems and what must not change |
| Acceptance criteria | Stable criterion IDs, observable outcomes, required evidence obligations, and required evidence-independence level |
| Constraints | Compatibility, performance, security, style, API, migration, and operational requirements |
| Assumptions | Reversible interpretations, source, impact if wrong, and disclosure status |
| Ambiguities | Questions that could materially change behavior, scope, or authorization |
| Risk profile | Data loss, external effects, irreversibility, and blast radius |
| Workspace binding | Repository identity, base commit, workspace ID, and initial generation |
| User-control policy | Decisions allowed autonomously and those requiring user input or approval |
| Provenance | Original request, clarification refs, candidate derivation, and field-level change set |

**Acceptance boundary**

Kernel performs deterministic checks: schema, stable IDs, provenance references, version lineage, field-level changes, and presence of required user-confirmation evidence. Kernel does not decide whether the interpretation is semantically faithful.

The following are protected fields: desired behavior, scope, exclusions, required acceptance criteria, constraints, public/compatibility commitments, risk boundary, and external/destructive side effects. A change to a protected field requires explicit user confirmation unless an immutable intake-time authorization record explicitly covers that exact change. Model-generated labels cannot downgrade a protected change to a harmless assumption.

Orchestration may proceed without asking only on a low-risk, reversible, disclosed operational assumption that remains within the accepted scope and constraints, does not alter required criteria, and is permitted by the user's control policy. If ambiguity materially changes behavior, scope, compatibility, or risk, ask the user.

A new accepted GoalContract version triggers plan impact analysis. If scope, criteria, or execution authority changes, use the PlanRevision switch protocol. Old work may be carried forward only under the lineage and evidence rules in [PlanRevision contract](../../contracts/plan-revision.md). A VerificationReport bound to an earlier GoalContract version cannot complete the new version; raw evidence may be reused only when its scope and freshness still match.

### 4.2 RepositoryModel

The RepositoryModel is a versioned, provenance-aware working model of the codebase and its execution environment. It may contain:

- repository identity, base commit, branch, working-tree status, and workspace generation;
- directory and package structure;
- language, framework, build system, package manager, runtime, and dependency graph;
- entry points, important symbols, call relationships, public APIs, and architectural boundaries;
- source files, configuration, migrations, generated code, and lockfiles relevant to the task;
- test suites, test ownership, fixtures, build and verification commands;
- project conventions, contribution instructions, and relevant architecture decisions;
- likely impact areas, compatibility boundaries, and known risks;
- evidence status, source quality, freshness, source references, and invalidation conditions for each projection. Numeric model self-confidence is not a repository fact or evidence.

The model is not assumed complete. It should answer: what has been inspected, what is inferred, what remains unknown, and which observations may be stale.

Each record keeps a source reference, content digest, capture time and invalidation key; the record envelope, trust classes and freshness basis are fixed in the [Kernel data model](../../contracts/kernel-data-model.md#310-artifact-and-evidenceref) and [Context Engine §6](../../context/context-engine.md#6-provenance-and-trust) and are not restated here. The model is **versioned by source digest**: a rebuilt projection is a new projection, not a new version of the same fact, and a PlanRevision binds the workspace/source snapshot it was derived from rather than a projection digest ([PlanRevision §3](../../contracts/plan-revision.md)). A model-authored claim without a source reference is a hypothesis and cannot satisfy a criterion; a `StaleRead` or digest mismatch invalidates the affected records instead of silently refreshing them.

Repository instruction files such as AGENTS.md or CLAUDE.md may describe project conventions and workflow constraints. They are project data with bounded relevance, not Kernel policy or permission grants. They cannot override user intent, system policy, security rules, or Kernel admission.

**Convention precedence and limits.** Convention sources are read in this order: (1) `AGENTS.md`/`CLAUDE.md` from the repository root down to the edited file's directory — within its own subtree the nearest file wins and ancestors supply defaults; (2) a `CONTRIBUTING` contributor section and CI/lint/build configuration; (3) architecture decision records. Each source is recorded with path, digest and capture time, and a convention claim goes stale when its source digest changes. Conventions constrain style, structure, naming and workflow; they may **never** grant a permission or capability, add a mandatory acceptance check that the accepted GoalContract does not carry, authorize a command or network access, or be edited so that a check passes. A convention that appears to require a scope, criterion or verification change is a GoalContract/plan change, not a convention override.

### 4.3 Evidence and hypothesis indexing (optional EvidenceGraph)

Autonomous Coding still needs strong repository understanding, evidence-driven hypotheses, failed-experiment history and criterion coverage. **That does not require an authoritative graph database or a mandatory Claim/Relation/Freshness state machine.** The minimum durable/typed shared data are immutable `EvidenceRef` (source ref, digest, trust class, relevant snapshot/environment) and criterion-to-evidence bindings (criterion ID, verification obligation, provenance, freshness basis). Actual Host receipts, tests and source artifacts remain primary facts.

RepositoryModel may annotate observed facts, hypotheses, assumptions, contradictions, debug decisions and optional supports/refutes links to evidence. These records are Domain reasoning projections that can be rebuilt; only observations bound to verifiable source refs can satisfy completion. Freshness is derived from source/plan/criterion/version changes, not a separately authoritative freshness database. The richer EvidenceGraph is optional retrieval/index policy and can be introduced only if task-quality/latency evidence justifies its operational cost. This **does not relax** mandatory independent verification, provenance, or UNKNOWN handling.

### 4.4 PlanRevision and PlanStep

A PlanCandidate becomes authoritative only after Kernel's deterministic contract checks and safe activation. The full lifecycle, plan-switch barrier, status transitions, carry-forward rules, and UNKNOWN handling are specified in [PlanRevision and PlanStep lifecycle contract](../../contracts/plan-revision.md).

A PlanRevision binds the accepted GoalContract version, relevant RepositoryModel/evidence source snapshot, workspace generation, outcome-level PlanStep dependencies, acceptance-criterion mapping, assumptions, risks, expected artifacts, capability/approval boundaries, verification obligations, recovery strategy, resource estimate, and verification/repair reserve.

A PlanStep is a meaningful engineering outcome, not a model call or shell command. Its definition includes objective, dependencies, preconditions, expected artifacts, criterion links, effect/risk, capability needs, evidence obligations, verification, and recovery.

**PlanStep has two event-derived progress views, not two independently committed authority state machines:**

- WorkStatus: NotStarted, Ready, Running, Blocked, Completed, Superseded.
- VerificationStatus: NotRequired, Pending, Running, Passed, Failed, Stale, Inconclusive.

Thus WorkStatus=Completed with VerificationStatus=Failed is valid. A failed tool or model attempt is not a PlanStep failure. A PlanStep can be reworked only through an explicit event, preserving prior artifacts and verification history.

A new revision creates new PlanStep identities. It may explicitly carry forward old artifacts and evidence through lineage references, but it cannot reactivate or mutate a superseded step. Verification defaults to Pending in the new revision unless the evidence contract proves cross-revision reuse is valid.

### 4.5 Bounded action intent and ExecutionTrace — no duplicate lifecycle

A complete selected ModelStep response may contain one or more **bounded, immutable action-intent items** (Inspect, Experiment, Edit, Verify, Ask, RequestApproval, Wait, Replan or Stop). The `ActionProposal` name is retained as a compatibility **envelope/record**; it is neither authorization nor a separate execution state machine.

Minimum fields: stable `decisionId`, selected ModelStep/Attempt and response digest, Task/accepted GoalContract/PlanRevision, optional PlanStep, relevant authority/fence and workspace/project snapshot bindings, tool-definition digest, policy-limited item IDs, canonical argument digests, effect/conflict metadata, expected outputs, and declared dependencies. A **global Task aggregate version is not a required precondition** for ordinary action items; Kernel Admission verifies the relevant protected read-set and owning Invocation version. A durable tool-origin reference is recorded before or together with K-local child Invocation admission.

**No `Recorded → Selected → Executing → PartiallyExecuting → Settled` ActionProposal authority lifecycle.** Selected response identity is committed by Kernel ModelStep; individual ToolInvocations own their admission/dispatch/outcome/UNKNOWN state. Batch status such as partially executed or settled is derived from those children. Failed/denied dependent children do not authorize another item; a sibling proceeds only after its own Admission. No batch atomicity, no inherited grants, no automatic replay of UNKNOWN. A model-produced plan is not a tool token.

Non-tool Ask/Wait/Stop becomes a durable Orchestration/Kernel command only when it creates an external obligation or changes persisted TaskControl. Internal hypothesis notes need not become Kernel aggregate records. ExecutionTrace is a **queryable projection** joining decision ID, Invocation IDs, actual Host receipts, artifacts and evidence, not another authoritative ledger. Each tool remains bound to the actual current plan and exact grant at its Host launch boundary.

## 5. Control architecture

The system has **one primary autonomous Agent Loop**. Strategic, Tactical, and Assurance are three **decision purposes/modes** selected by that loop, not three cooperating independently scheduled loops, separate controller processes, or separate state machines. This preserves the full autonomous Coding skill set while removing arbitration overhead.

### 5.1 Strategic loop — goal and plan control

The strategic loop answers: **Are we still solving the right problem, and what outcome should happen next?**

1. Read the current GoalContract, accepted PlanRevision, PlanStep progress, and evidence projection.
2. Determine whether repository understanding is sufficient for the next decision.
3. Identify missing facts, failed assumptions, uncovered criteria, dependency changes, and risk changes.
4. Decide whether to continue the current plan, inspect further, replan, ask, wait, request approval, verify, or stop.
5. If a plan change is needed, produce a complete PlanCandidate with explicit revision rationale and criterion coverage.
6. Submit it to Kernel; continue only against the accepted revision.

The strategic loop is not invoked only at the beginning. It is revisited at milestones and whenever new evidence materially changes the task model.

### 5.2 Tactical loop — action and feedback

The tactical loop answers: **What is the safest useful operation to perform now?**

1. Build an Execution Context from the accepted PlanRevision, current PlanStep, relevant evidence, workspace generation, policy, budget, and tool snapshot.
2. Select a decision purpose: inspect, implement, debug, or verify.
3. Ask the model for a typed action proposal or a bounded batch of tool calls.
4. Validate response completeness, schema, tool identity, argument digest, plan binding, and preconditions.
5. Submit each side effect through Kernel admission.
6. Tool Runtime dispatches only admitted work to Trusted ToolHost.
7. Collect Host receipts, command outputs, diffs, and other evidence.
8. Update the RepositoryModel and EvidenceGraph projections; invalidate stale context.
9. Re-evaluate the PlanStep and strategic loop.

The model may propose multiple tool calls, but a tool batch is not an atomic transaction. Each invocation retains its own identity, admission, idempotency, and outcome. A denied or failed call does not grant permission to retry with altered arguments.

### 5.3 Assurance loop — correctness and completion

The assurance loop answers: **Does the current workspace actually satisfy the requested outcome?**

It uses three layers that must not be conflated:

1. **Machine-verifiable evidence.** Run the required tests, builds, type checks, static analysis, contract checks, hidden tests, or reproducible experiments through Trusted ToolHost. Record actual commands, environment, workspace, receipts, exit status, output digests, and artifacts. A test written by the Implementer can be useful regression evidence, but its authorship is recorded and it is not automatically an independent oracle.
2. **Conditional independent review.** A fresh Verifier ModelStep is invoked only when the accepted criterion/assurance policy or [Completion §3.2](../../contracts/completion.md) requires it (see §14.5 for the fast-path predicate); the always-on alternative is explicitly not a construction default. When invoked, its context is assembled from the original UserIntent, accepted GoalContract and PlanRevision, criterion definitions, current diff, and raw verification evidence. Do not provide the Implementer's summary, self-assessment, private reasoning, or prior verifier conclusion as evidence. The same model/provider may be used for ordinary-risk review if the context and decision are fresh. For higher-risk criteria, policy may require a different model/provider, an independently authored test suite, or an external reviewer. Diff text, code comments and test output are untrusted data: they are quoted with provenance and never treated as instructions to the verifier.
3. **External assurance.** Use human review, security audit, hidden/independently authored tests, staging or real-environment validation when the criterion's risk and nature require it. A model reviewer cannot substitute for a required human or external assurance step.

The Verifier produces review findings: NoBlockingFinding, BlockingFinding, InsufficientEvidence, or HumanReviewRequired. These are review outputs, not criterion proof. A Verifier model judgment never creates a trusted test result and cannot directly mark a criterion Passed.

The VerificationReport maps each required criterion to its required evidence class and actual evidence references. Completion Guard deterministically checks that the report is current, correctly bound, and contains the evidence classes required by the accepted GoalContract/policy. It checks evidence presence, provenance, freshness, and authorization—not whether a technical solution is semantically correct. Criteria requiring human judgment need an authenticated human disposition.

The assurance loop may send the task back to execution or planning. It cannot declare TaskCompleted itself.

### 5.4 One-controller decision priority and evidence feedback

The one Task Orchestrator reads current task/plan and the **small relevant context**, selects a decision purpose, records the selected ModelStep/decision intent where necessary, admits each tool independently, observes trusted outcomes, updates the RepositoryModel/evidence references, and loops. No separate `ControlProposal` record/lifecycle, three-loop arbitration queue or task-level mutex is required.

The next-decision priority is: (1) safety/cancellation/revocation; (2) conflicting UNKNOWN, started-operation reconciliation and Host process convergence; (3) new user intent, required approval or external wait; (4) failed/stale required assurance evidence and bounded repair; (5) material goal/plan invalidation requiring L2; (6) tactical next ready work or L0/L1 adjustment; (7) progress/delivery. A high-priority event stops **new** conflicting decisions and admissions, not already started physical effects. All such effects continue to drain/reconcile under the Host contract.

The controller may revisit strategic reasoning at milestones and plan-invalidating evidence, not after every tool call; it chooses assurance when evidence obligations are ready or missing, not as a separate agent. Decisions that change TaskControl/Plan/terminal state still use Kernel TaskControl CAS. Ordinary model, tool and evidence events use their respective owning-aggregate versions and selective read-set. The model cannot grant itself approval or bypass a current Host fence.

These three modes should be compared experimentally with a simpler baseline under equal permission, budget, test and recovery policy. Their internal cognitive richness is **Domain** policy, not an authorization/transaction protocol.

## 6. End-to-end execution lifecycle

### Phase A — Intake and goal formation

- Normalize the user request without losing its original wording.
- Identify the intended repository, branch/base commit, and workspace.
- Extract scope, exclusions, constraints, and candidate acceptance criteria.
- Separate known facts, assumptions, and ambiguities.
- Ask a focused question only when a missing answer changes the plan or authorization materially.
- Have Kernel admit the Task and establish hard budgets and initial capabilities.

### Phase B — Repository reconnaissance

Reconnaissance is a deliberate, bounded activity—not indiscriminate file reading.

1. Inspect repository status, top-level structure, project instructions, manifests, lockfiles, and build/test entry points.
2. Locate likely implementation paths using search, symbols, imports, references, and tests.
3. Read relevant source and architecture documents before proposing changes.
4. Trace the affected behavior across callers, implementations, interfaces, tests, and configuration.
5. Run read-only or low-risk diagnostic commands when needed to establish the baseline.
6. Record the facts, evidence quality/provenance, and unknowns in the RepositoryModel and EvidenceGraph; do not store model self-reported confidence as fact.

Before a plan is accepted, only the narrowly admitted reconnaissance capabilities may be used. Code writes and other side effects require an accepted plan and normal Kernel admission.

**Reconnaissance budget (profile-declared; initial ceilings are tuning hypotheses, not measurements).** `max_read_calls` (40), `max_read_bytes` (1 MiB), `max_commands` (12) and `max_concurrent` (the strategy's R0 value) bound the phase. Exceeding a bound is a typed `ReconGap` recorded with the missing fact — never a silent continuation, never a second unbounded sweep. Read-only parallel calls are admitted separately and must bind the same `tree_digest`.

**Required coverage checklist.** Reconnaissance records its coverage in the RepositoryModel: (1) workspace status, branch and base commit; (2) top-level structure and package/module layout; (3) build, test and lint entry points with their exact commands; (4) the owner and call sites of every file the planned change will touch; (5) applicable convention sources and their precedence (§4.2). The checklist is evidence, not prose.

**Stop predicate.** Stop when (a) the checklist is satisfied, (b) the next action's target file set is identified with source references, and (c) no remaining unknown could change that target set. Otherwise escalate with the typed gap (missing manifest, ambiguous package ownership, unresolved symbol, no trusted entry point) rather than reading broadly. More context is not automatically better.

**Baseline capture (mandatory before the first edit).** Run the affected build/test command set on the unmodified base snapshot and record the result set as baseline evidence bound to `source_snapshot_digest` (§14.3). Without a baseline record, a pre-existing failure cannot be distinguished from a regression and a bug-fix criterion cannot produce `EV-TEST-F2P`; the fix may not start until the record exists or the environment is declared `Unsupported`.

### Phase C — Problem formulation and plan acceptance

- Convert the goal into a problem statement and acceptance matrix.
- Identify affected components, invariants, compatibility boundaries, and likely regression surfaces.
- Build a dependency-aware PlanCandidate.
- Ensure every acceptance criterion is covered by a PlanStep or explicitly marked as requiring human judgment.
- Include test strategy, risks, assumptions, resource estimate, and recovery plan.
- Submit the candidate to Kernel for validation and acceptance.
- Do not perform source modifications against an unaccepted plan.

### Phase D — Implementation

For each ready PlanStep:

1. Refresh the Execution Context and check that its preconditions still hold.
2. Select the smallest coherent implementation action that advances the step.
3. Prefer targeted changes over broad rewrites unless evidence supports a broader change.
4. Keep each patch attributable to a PlanStep and workspace generation.
5. Inspect the diff after edits; detect unrelated changes and scope drift.
6. Run focused checks early enough to expose design errors before dependent work accumulates.
7. Update evidence and invalidate repository/context projections affected by the patch.

The agent should not edit generated artifacts, lockfiles, public interfaces, migrations, or security-sensitive code without understanding their ownership and consequences.

### Phase E — Debugging and repair

Debugging is a hypothesis-driven experiment loop, not an unbounded retry loop.

1. Classify the failure: syntax/type, build, assertion, regression, flaky test, environment, dependency, permission, network, timeout, resource exhaustion, or unknown execution outcome.
2. Preserve the exact failure evidence and environment binding.
3. Form a small set of competing hypotheses with predicted observations.
4. Choose the cheapest safe experiment that distinguishes the hypotheses.
5. Run it in a controlled workspace/environment and record the result.
6. Update the EvidenceGraph; reject or strengthen hypotheses based on evidence.
7. Repair the root cause, then run the narrow regression check and relevant broader checks.
8. If the same failure signature repeats without new evidence, stop the retry path and change strategy, replan, or escalate. Repair attempts are counted per **(PlanStep, failure signature)** — signature being the digest of failing command + test identity + normalized failure output: a new signature starts a new count, and repeating an identical action never resets it. The bound is `progress.max_same_step_repairs` from the bound strategy ([Execution Strategy §4.5](../../contracts/execution-strategy.md)), whose default is 2 and whose profile maximum cannot be exceeded locally. At the bound the loop must diagnose once from existing facts, then wait, replan (L2 only if a protected field changes), or fail with a typed reason; the count and signature digest are recorded on the PlanStep so recovery resumes the same count rather than restarting it. A repair that changes the failure signature is still a repair against the same PlanStep outcome.

A timeout, disconnected process, missing receipt, or interrupted command may be UNKNOWN. The agent cannot infer failure and blindly repeat a potentially non-idempotent side effect.

### Phase F — Verification

Verification proceeds at multiple levels:

- **Change verification:** inspect diff, formatting, static analysis, type checks, and focused tests.
- **Component verification:** run tests for the affected module or package.
- **Integration verification:** run relevant cross-package, contract, or integration tests.
- **System verification:** run the repository's required full suite, build, or end-to-end checks when required by the criteria and feasible within budget.
- **Acceptance verification:** evaluate every GoalContract criterion against its bound evidence.
- **Conditional independent review:** apply the accepted criterion-risk/assurance policy in [Completion](../../contracts/completion.md). Invoke a fresh Verifier ModelStep when semantic independence is required, the only oracle is implementation-authored, evidence is disputed or a higher-risk trigger applies; otherwise independent trusted deterministic tests and the non-skippable Completion Guard may suffice for low-risk tasks. If invoked, the Verifier receives original UserIntent, accepted Goal/Plan, diff and raw verification evidence, never Implementer self-assessment as proof. Its findings and evidence gaps are advisory, not criterion PASS.

The verification plan should identify required checks, optional risk-based checks, unavailable checks, and the consequences of each missing result. A skipped or unrun test is not a pass.

### Phase G — Freeze and completion

- Ensure no required operation, child process, or writable handle remains active.
- Kernel-issued freeze of a trusted, versioned ProtectedInputScope and immutable source snapshot before tests (§14.7); additionally require a Host-authenticated **ExecutionViewManifest** proving the test process actually resolved source/config/tests from that snapshot (cwd, mount/overlay/symlink resolution, writable roots and effective protected-path digests). Matching immutable snapshot hashes alone cannot prove a valid run. Writable overlay shadowing or unproven input-view changes invalidate verification even if underlying hashes match; isolated cache/coverage outputs remain separate evidence.
- If tests or final preparation changed in-scope files, the run is invalid rather than merely stale: under the sealed policy that is a Host-enforcement failure. Invalidate the evidence, take a **new** snapshot and re-run; re-hashing the same run is not a repair.
- Request the trusted immutable final snapshot and authenticated receipt.
- Submit the VerificationReport, criterion evidence, snapshot binding, and receipts to Kernel.
- Kernel Completion Guard performs the final state transition.
- Only after Kernel commits TaskCompleted may Orchestration deliver a completion response.

### Phase H — Delivery

The final user-facing report should contain:

- outcome and files/components changed;
- important design or implementation decisions;
- verification commands and actual results;
- acceptance criteria satisfied and any unmet criteria;
- tests not run and reasons;
- remaining risks, assumptions, or follow-up work;
- links or references to artifacts and the final workspace snapshot where supported.

A concise report is preferred, but it must not hide uncertainty or overstate verification.

## 7. Action selection and scheduling

### 7.1 Decision policy

The next action should be selected using:

- expected progress toward uncovered acceptance criteria;
- expected information gain and reduction in uncertainty;
- dependency readiness;
- risk, blast radius, and reversibility;
- current workspace and environment state;
- hard budget and remaining verification reserve;
- whether the action is safe to parallelize;
- whether human input or approval is required.

This is a decision policy, not a fixed numerical formula. The design must be evaluated empirically before thresholds are frozen.

### 7.2 Tool capability metadata

A tool definition should declare enough metadata for safe orchestration and Kernel admission:

- input and canonical output schema;
- read/write and external-side-effect classification;
- filesystem, process, network, and workspace scope;
- idempotency and replay classification;
- concurrency class and possible conflict keys;
- timeout, resource, and cancellation behavior;
- expected evidence and receipt requirements;
- approval and capability requirements;
- implementation identity and version.

Model-visible schemas describe interfaces. They do not grant permission. This list defines what the metadata *means*; the normative Coding registry, argument/result schemas and limits are §14.2, and the generic admission record is [Kernel data model §3.7](../../contracts/kernel-data-model.md#37-toolinvocation).

### 7.3 Minimal effect-aware scheduling

**Default to sequential execution in the first vertical slice.** Optional bounded concurrent read-only operations may proceed if they are independent, admitted separately, and bind an appropriate stable snapshot. Parallel writes require **proven enforced isolation/disjoint effect sets**; absent proof, serialize. Git index operations, package managers, workspace-wide builds, generated-code modifications, migration and common output publication serialize by default.

Do not implement a global DAG scheduler for every emitted model command. PlanStep dependencies describe engineering outcomes; the controller chooses the next ready operation. A bounded batch is just a set of individually admitted Invocations; the scheduler does not have its own authoritative lifecycle. Results are correlated by stable Invocation IDs and trusted Host receipts, and an UNKNOWN write blocks only demonstrably conflicting actions. Prove performance benefits and conflict soundness at PE before introducing speculative scheduling.

### 7.4 Retry policy

Retry is allowed only when the failure class and idempotency contract make it safe. A retry must preserve or explicitly replace invocation identity according to the Kernel contract, record why the prior attempt is retryable, and remain within budget. Unknown side effects are reconciled before any replay.

## 8. Long-task continuity and context management

Conversation history is not a sufficient long-task memory.

### 8.1 Task-progress checkpoint

A checkpoint candidate should preserve:

- original GoalContract and acceptance criteria;
- accepted PlanRevision and revision rationale;
- completed, active, blocked, and superseded PlanSteps;
- RepositoryModel snapshot and freshness/invalidation state;
- key evidence references and unresolved contradictions;
- failed attempts and tested/rejected debugging hypotheses;
- current workspace generation and snapshot references;
- active or UNKNOWN ModelSteps and ToolInvocations;
- approvals, wait reasons, budget reservations, and remaining verification reserve;
- next decision and the conditions that would change it.

A checkpoint is an **optional performance/recovery projection**, proposed at meaningful milestones, context-size pressure or an explicit recovery boundary—not after every tool/ModelStep. Kernel durably records its source Journal cursor and immutable digest; committing a checkpoint pointer must not advance TaskControlVersion or cause unrelated admissions to conflict. Replay from Kernel Journal and Host Ledger remains the authority; a checkpoint cannot restore stale grants.

### 8.2 Compaction

Compaction may summarize conversation content but must not discard:

- original user intent, scope, and exclusions;
- accepted plan and criterion coverage;
- evidence references and their source bindings;
- completed changes and workspace generations;
- failures, rejected hypotheses, and unresolved UNKNOWN outcomes;
- approvals, revocations, budget holds, and wait reasons;
- next action and stop conditions.

The full event history and source artifacts remain available for retrieval. Summaries are projections, not replacements for facts.

### 8.3 Project memory

Project memory is separate from task-progress checkpoints. It may retain reusable architecture facts, build commands, test locations, and conventions only with source provenance, project identity, commit/file hashes, freshness, and expiry. It cannot become Task state, approval, capability, or execution evidence.

## 9. Human control and escalation

Autonomy does not mean never asking the user. It means asking only at meaningful decision boundaries and providing enough evidence for a useful answer.

Ask or escalate when:

- ambiguity materially changes the intended behavior or public contract;
- two plausible designs have materially different compatibility or operational consequences;
- a destructive, external, irreversible, or high-blast-radius action is outside existing authorization;
- credentials, private data, or a network destination are required but not authorized;
- a required acceptance criterion needs human judgment;
- evidence is contradictory or an execution outcome remains UNKNOWN;
- the task cannot meet its goal within the remaining budget or permitted environment;
- repeated experiments fail to reduce uncertainty.

The approval request must bind the exact invocation, tool/version, arguments, target, workspace, capabilities, policy version, expiry, and risk. A general approval must not silently authorize later changed arguments.

Expose progress as durable milestones and evidence summaries, not as a flood of raw internal reasoning. The user needs to see what is known, what changed, what is blocked, and what decision is needed.

## 10. Security and trust boundary

The intelligent execution system inherits the existing Kernel and Trusted ToolHost security contracts:

- repository files, issue text, webpages, tool output, and external documents are untrusted data;
- retrieved instructions do not gain system or developer authority;
- project instructions may shape coding conventions only within the user's authorized scope;
- model output can propose an action but cannot issue an AdmissionTicket or approval;
- every side effect is admitted by Kernel and revalidated by Host;
- Kernel Journal and Host Ledger remain separate fact domains;
- UNKNOWN is a blocking reconciliation state, not a failure shortcut;
- context and memory projections never carry replayable capabilities or secrets;
- final completion requires authenticated Host evidence and a frozen workspace snapshot.

Prompt-injection resistance, sandbox isolation, and receipt authenticity remain requirements to prove, not properties implied by this design.

## 11. Kernel boundary required by this design

| Concern | Orchestration may propose or decide semantically | Kernel must own or enforce deterministically |
| --- | --- | --- |
| Goal | GoalContract interpretation, assumptions, ambiguity, and semantic fidelity | Immutable UserIntent refs, version identity, schema/provenance checks, protected-field confirmation evidence, accepted GoalContract pointer |
| Repository | RepositoryModel completeness and relevance; evidence interpretation | Workspace identity/generation and trusted snapshot references |
| Planning | PlanCandidate, technical route, step granularity, criterion adequacy, replan rationale | PlanRevision identity/version, schema, DAG, references, scope envelope, budget envelope, legal transition, cutover barrier, accepted pointer |
| Model reasoning | Purpose, model strategy, context needs | ModelStep/Attempt identity, admission, hard budgets, cancellation, and settlement |
| Action | ActionProposal semantics, ordering, and expected progress | Proposal recording/binding checks; ToolInvocation identity, schema/snapshot checks, policy, approval, budget, durable intent |
| Scheduling | Desired ordering and proposed safe concurrency | Admission, fencing, leases, execution constraints, state transitions |
| Debugging | Hypotheses, experiments, and root-cause interpretation | Invocation admission, evidence references, retry safety, UNKNOWN reconciliation |
| Verification | Check selection, evidence sufficiency assessment, review findings | Required evidence class/provenance/freshness checks, workspace freeze, Completion Guard |
| Continuity | Checkpoint Candidate and memory Candidate | Checkpoint integrity commit, authoritative Task state, recovery-time authorization revalidation |
| Delivery | User-facing summary | Selected response and durable delivery contract |

Kernel's plan acceptance is deterministic contract validation, not semantic approval. It must not call a model or inspect source code to decide whether a technical route is wise. Criterion coverage is checked structurally by stable IDs; semantic coverage remains Orchestration's responsibility.

All Planner, Explorer, Implementer, Debugger, and Verifier model calls pass through Model Gateway and Kernel-managed ModelSteps. No cognitive role bypasses Kernel to call a provider or execute a tool.

## 12. Definition of construction readiness

The specification is construction-ready because it has:

- coherent GoalContract, RepositoryModel, minimal EvidenceRefs/criterion links, structural PlanRevision/PlanStep, and bounded action-intent envelope; richer EvidenceGraph indexing remains optional;
- explicit strategic, tactical, debugging, assurance, arbitration, and stopping policies;
- precise Orchestration/Kernel/Context/Tool Runtime/Host boundaries;
- defined plan-switch, long-task checkpoint, and recovery semantics;
- a threat and failure model;
- reviewed metric definitions, task families, safety floors, and a staged reproducible evaluation method;
- explicit unresolved decisions retained as OPEN (§13) rather than silently resolved;

A frozen benchmark task set and measured baseline are later evaluation stages; neither is required to define the architecture-level evaluation method or begin implementation planning. Runtime execution and baseline measurement still require separate explicit authorization.

This specification is not empirically validated. The evaluation protocol is specified in [evaluation.md](evaluation.md); the current evidence and limitations are recorded in [reference-review.md](reference-review.md).

## 13. Open design questions

The second-round candidate now retains GoalContract versioning and safe L2 plan cutover, while simplifying PlanStep status to derived views, ActionProposal to bounded action intent, EvidenceGraph to optional evidence indexing, decision arbitration, verification independence levels, and checkpoint/authorization separation.

The following remain OPEN for owner review and empirical evaluation:

- What reconnaissance depth and PlanStep granularity work best across task families?
- What concrete field-level rules should define protected GoalContract changes for different product policies?
- Which plan-switch UNKNOWN cases can a future Host prove non-blocking?
- Which evidence kinds and independence levels are required for each risk class?
- How should the system measure whether a RepositoryModel or plan is semantically adequate without moving that judgment into Kernel?
- What benchmark tasks and hidden tests best expose false completion, plan churn, and weak debugging?
- What context retrieval, graph projection, and checkpoint formats are effective at realistic repository scale?
- Which task classes should be supported in the first controlled vertical slice?

These remain open; accepting the contract does not resolve them, and this design has not been empirically validated.

## 14. Coding construction contract (ARB-01 — normative)

This section fixes the Coding domain's constructible surfaces as a concrete `coding` adapter of the [Domain Extension Contract v0.2](../../contracts/domain-extension.md). It adds no Kernel behavior and does not restate record fields: shapes, identifiers, enums and events are the [Kernel data model](../../contracts/kernel-data-model.md), policy bounds are the Coding reference strategy in [Execution Strategy §7.1](../../contracts/execution-strategy.md#71-coding), and completion authority remains [Completion](../../contracts/completion.md).

### 14.1 Adapter capabilities and trace C-01 (localized bug)

**Adapter capabilities:** `coding.goal@0.1`, `coding.plan-step@0.1`, `coding.repository-snapshot@0.1`, `coding.patch@0.1`, `coding.verification-evidence@0.1` — schema IDs only; Kernel treats payloads as opaque. Shell commands, Git and network operations still require exact Host/tool capability admission; no unrestricted shell escape.

**Happy-path trace C-01 (localized bug):**

1. **Intake:** bind user intent, repo commit/tree digest, compatibility and allowed changes, pass/fail criterion, protected existing tests and tool Host policy. A simple one-step plan is sufficient if its declared outcome/criteria cover all requested work; avoid extra planner calls.
2. **Locate:** read repository manifest and target file metadata; perform indexed path/symbol/keyword lookup, then request only narrow source ranges with line/hash provenance. Escalate to dependency graph or wider search only when evidence indicates ambiguity. Cache read-only repository index under exact tree and parser/tool digest; never treat a guessed symbol as a trusted fact.
3. **Hypothesize and edit:** compare observed behavior with the criterion; propose a bounded patch with `base_tree_digest, affected_paths, patch_digest, expected_effect_scope`. Revalidate current workspace/read-set, then Kernel admits one write; Host stages the change in the authorized disposable workspace. A failed CAS/workspace conflict refreshes affected files and recomputes the patch; do not force overwrite unreviewed user changes.
4. **Verify:** select tests from accepted criteria, changed path dependency impact, existing baseline failure and compatibility obligations. Fast path means **run the minimum sufficient trusted checks**, not skip required checks. Freeze the final protected source snapshot and execute actual build/test commands against the sealed read-only input with **disjoint writable output/cache/temp paths** and attested `ExecutionViewManifest`. Include unchanged protected test/config/dependency inputs. A test that the agent wrote itself is not automatically an independent oracle.
5. **Repair:** classify failure as implementation defect, test/environment failure, stale view or missing coverage using authenticated evidence. L0 choose new read/tool, L1 repair the same outcome and invalidate affected verification, L2 only if protected plan/criterion/scope needs changing. The cap is `progress.max_same_step_repairs` (default 2), counted per (PlanStep, failure signature) as in §6 Phase E; at the bound, diagnose once then wait, replan or fail with a typed reason — the trace never assumes unlimited retries. A conflicting UNKNOWN write must reconcile before patch reapplication.
6. **Finish:** criterion-to-evidence report binds exact final snapshot, test command/view/exit/receipts, patch lineage, unresolved limitations and current plan. Policy-triggered fresh semantic review only when required. Kernel Guard commits Completed exactly once and delivers patch/diff plus checks; no mandatory extra model summary call if the delivery template is deterministic. Original user changes and provenance are preserved.

**C-02 read-only explanation** uses permitted scoped reads and deterministic citation completeness; no disposable edit/test needed unless the accepted criterion actually requires it. **C-03 cross-package change** must include dependent build/test contracts and may perform L2 structural decomposition; it must not be mislabeled as a cheap path. **C-04 long debugging** checkpoints at milestones, not every command, and resumes only after Journal/Host reconciliations/current authority and workspace read-set validation.

### 14.2 Tool registry (normative v1)

Six tools are required for construction. Every entry declares `implementation_digest` (absence blocks admission), `evidence_emitted[]`, the approval policy in the final column and `cancellation` semantics; generic admission fields are [Kernel data model §3.7](../../contracts/kernel-data-model.md#37-toolinvocation). `workspace.freeze_source` is **Kernel-issued** and is not a model-proposable adapter tool ([Workspace Freeze §2](../../contracts/workspace-freeze.md)).

| Tool | Input schema (required) | Result schema | Effect | `conflict_scope` | Idempotency | Limits | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `repository.discover@0.1` | `tree_digest, query_kind(path\|symbol\|text\|import), query, path_globs[], max_results, cursor` | `tree_digest, index_digest, hits[{path, span, symbol_kind, snippet_digest, rank}], truncated, next_cursor, scanned_files` | R0 | `repo:ro:<tree_digest>` | `pure` — replay returns the original result | ≤200 hits, snippet ≤512 B, ≤50k files, 20 s | `read_set` digest; approval: none |
| `repository.read_ranges@0.1` | `tree_digest, ranges[{path, start_line, end_line, expected_digest?}]` | `items[{path, range, content_digest, bytes, encoding}], missing[], truncated` | R0 | `repo:ro:<tree_digest>` | `pure`; `expected_digest` mismatch ⇒ typed `StaleRead` (no silent re-read) | ≤32 ranges, ≤256 KiB total, 20 s | `read_set` digest; approval: none |
| `workspace.apply_patch@0.1` | `base_tree_digest, edits[{path, op(create\|replace\|delete\|rename), base_digest, span, replacement}], patch_digest` | `new_tree_digest, applied[], conflicts[{path, reason}], atomic` | R1 | `ws:write:<workspace_id>` | keyed by `patch_digest` | ≤20 files, ≤1 MiB, 60 s | new tree digest; approval: per policy |
| `host.run_build_test@0.1` | `source_snapshot_id, command_argv[], cwd, env_digest, output_roots[], timeout_ms` | `run_id, exit\|signal, stdout_digest, stderr_digest, test_report_digest, execution_view_manifest_digest, receipt_id` | R1 | `host:exec:<host_id>` | `non-idempotent` — ambiguity ⇒ `OutcomeUnknown` | wall ≤ `terminate.task_deadline_ms`, resources per strategy | Host receipt + view manifest; approval: per policy |
| `workspace.freeze_source@0.1` (Kernel-issued) | `workspace_id, protected_input_scope_version` | `snapshot_id, source_digest, receipt_id` | trusted barrier | `ws:freeze:<workspace_id>` | by `requestId` + nonce | one freeze identity per request | freeze receipt + view-manifest basis; approval: Kernel service identity |
| `artifact.publish_patch@0.1` | `snapshot_id, patch_digest, target_ref` | `artifact_id, digest, receipt_id` | R1 (R2 if external) | `artifact:target:<ref>` | keyed by digest | one artifact per invocation | artifact digest; approval: required |

**Patch formalism.** Encoding is UTF-8 with a declared newline policy (`lf`, `crlf`, `preserve`) that is an input to `patch_digest`; **no lossy transcoding** is permitted, and a file whose encoding is ambiguous, undecodable or BOM-conflicting is a typed rejection rather than a rewrite. Every edit carries `base_digest`; a mismatch is `TargetConflict` and must not be applied by fuzzy or line-number-only matching. Multi-file apply is **all-or-nothing**: either `atomic=true` with the complete new tree, or typed `PartialApply` and Host quarantine of that workspace generation. `rename` is `create`+`delete` inside one atomic patch, and `delete` also requires `base_digest`. Symlinks, hardlinks, submodules, binary files and mode/ownership changes are **rejected in v1** as `Unsupported` rather than approximated. `patch_digest` is the canonical digest over `{base_tree_digest, ordered edits, newline_policy}`.

### 14.3 Test selection, baseline and repeat-test cache

Every verification run records a `TestSelection`: `{selection_id, source_snapshot_digest, changed_paths[], impacted_tests[], excluded_tests[], reason_per_exclusion, impact_map_digest, fallback_used, selected_command_argv[]}`. Every exclusion carries a reason (`unaffected`, `flaky_declared`, `out_of_scope`); an exclusion without one blocks the evidence. **Fallback:** when no trusted impact map exists, run the criterion-mandated check set in full — a silent subset is a protocol violation, not an optimization.

**Repeat-test cache key** is `(test_id, source_snapshot_digest, env_digest, argv_digest, flake_policy_version)`; a change to any bound input invalidates the entry, and a cached pass satisfies evidence only while the key still matches the final snapshot. A test declared flaky requires the policy repeat count; one green run is not a pass. The baseline record from §6 Phase B is the reference set against which new failures are classified.

### 14.4 Coding evidence catalog

Each evidence record carries `run_ids[], source_snapshot_id, execution_view_manifest_digest, env_digest, independence_class, freshness_keys[]` ([Data model §3.10](../../contracts/kernel-data-model.md#310-artifact-and-evidenceref)).

| Kind | Proof rule |
| --- | --- |
| `EV-BUILD`, `EV-TYPE`, `EV-LINT` | Trusted run, exit 0, matching toolchain/environment digest |
| `EV-TEST-F2P` | **Two** runs: fails on the base snapshot and passes on the final snapshot. Mandatory for every bug-fix criterion |
| `EV-TEST-P2P` | Unchanged protected tests pass before and after |
| `EV-TEST-HIDDEN` | Passes from a declared read-only `HiddenOracleInput` (independent oracle, separate digest) |
| `EV-DIFF-SCOPE` | Changed paths ⊆ declared write scope |
| `EV-CONVENTION` | Ratified convention rule id + source digest + compliance check |
| `EV-HUMAN` | Authenticated human disposition |

A green test that does not exercise the criterion is not evidence, and a passing unrelated test never substitutes for a fail-to-pass record. A hidden oracle is a **declared read-only input** bound by its own digest, not a file placed in the mutable workspace; its run must state both the oracle digest and the `SourceSnapshot` it ran against, or the criterion stays `Unverified`.

### 14.5 Fast path and conditional review

`fast_path_eligible(task) := criteria ⊆ {EV-BUILD, EV-TYPE, EV-TEST-P2P, EV-DIFF-SCOPE} AND no implementer-authored oracle for a protected criterion AND a trusted impact map exists AND ≤1 write step.`

Eligibility may skip a fresh Verifier ModelStep — never a mandatory check, the Completion Guard, or the fail-to-pass record. Otherwise the conditional-review triggers in [Completion §3.2](../../contracts/completion.md) and `verify.review_triggers[]` apply. Cost preferences cannot lower an accepted assurance obligation ([Execution Strategy §3](../../contracts/execution-strategy.md), floors F4/F5), and "minimum sufficient checks" means the selected set above, not an ad-hoc reduction.

### 14.6 `coding.plan-step@0.1` kinds

Kinds are `Inspect | Implement | Test | Migrate | Compatibility | Diagnose`. Every payload carries `{kind, objective, target_paths[], base_tree_digest, criterion_ids[], evidence_obligations[], expected_artifact_kind, recovery_disposition}`; the kind fixes the evidence and effect envelope, and Kernel validates presence and schema only.

| Kind | Additional obligation |
| --- | --- |
| `Inspect` | R0 only; produces cited observations, no write |
| `Implement` | Write scope + `EV-DIFF-SCOPE`; patch bound to `base_tree_digest` |
| `Test` | `EV-TEST-*` evidence; selection record required |
| `Migrate` | Rollback note + preserved-behavior evidence |
| `Compatibility` | Before/after contract evidence for the public surface |
| `Diagnose` | Hypothesis + discriminating experiment record; may not write |

### 14.7 Sealed verification, freeze and deliverable

Freeze is a Kernel-issued transition; a model-proposed freeze is not a freeze. Under the sealed policy the source tree is read-only for the run, so **any** in-scope change — including a test or fixture that writes into the source tree — invalidates the run and requires a new snapshot and a new run: there is no "invalidate and re-hash the same run" path (§6 Phase G). If the required toolchain cannot execute against sealed source with disjoint outputs, the criterion stays `Unverified`/`Unsupported`.

**Deliverable identity:** the deliverable is (a) the patch artifact from `artifact.publish_patch`, digest-bound with lineage to the accepted plan, **and** (b) the reference to the sealed final `SourceSnapshot` that verification executed against. The workspace itself is disposable; neither artifact may be reconstructed from the other after task end.

**Failure matrix:** repository branch changed → rebase/revalidate targeted read-set, never silently edit old state; test runner cannot use sealed source → Unsupported/Unverified and no success; command timeout → Host cancel/process convergence or OutcomeUnknown hold; dependency install/network request → distinct declared capability and approval; test failure after patch → evidence-bound L1 repair; high-risk secrets or external deploy → R2 fail closed unless explicitly approved; exhausted model/verification budget → ask or safe Failed, never claim verification from a model. A patch from an unconfirmed source or conflicting UNKNOWN cannot be published.

**Acceptance mapping:** Coding developers implement domain schemas, the tool registry (§14.2), fast locator, patch builder, test-selection/impact policy and evidence emitters (§14.3–§14.4); Kernel/Host developers implement *the same* invocation/budget/fence/receipt/Guard paths Video uses. Required conformance: C-01–C-15 ([Evaluation §11](evaluation.md)), each failure row, plus shared X1/X6/X7/X8. Measure task correctness, hidden tests, false completion, median/p95 duration, model attempts/tokens and duplicate search/tests; do not infer quality from the number of tool calls.
