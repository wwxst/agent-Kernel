# Autonomous Coding Agent — Intelligent Execution Architecture

> **Status: PROPOSED.** This is the first complete design proposal for the intelligent execution system. It is not an approved implementation specification. No runtime, language, package topology, provider, database, sandbox product, or multi-agent design is selected by this document.
>
> The proposal is deliberately expressed as cognitive responsibilities, state contracts, and execution invariants. It is not a module list to translate directly into code.

## 1. Design thesis

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

**PROPOSED:** the default execution model is one primary Orchestration controller operating a task from intake through verification. Explorer, Planner, Implementer, Debugger, and Verifier are decision modes or model-step purposes—not a requirement to create separate agent processes.

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

The GoalContract converts the user's request into an inspectable target.

| Field | Meaning |
| --- | --- |
| Desired outcome | Observable behavior or deliverable the user expects |
| Scope | In-scope repositories, packages, files, systems, and permitted change classes |
| Exclusions | Behavior, files, interfaces, or operations that must not change |
| Acceptance criteria | Individually identifiable conditions with a proposed verification method |
| Constraints | Compatibility, performance, security, style, API, migration, and operational requirements |
| Assumptions | Facts not yet established, with confidence and impact if wrong |
| Ambiguities | Questions that could materially change the plan or authorization |
| Risk profile | Data loss, external side effects, security impact, irreversibility, and blast radius |
| Workspace binding | Repository identity, base commit, workspace ID, and initial generation |
| User-control policy | Which decisions can proceed autonomously and which require input or approval |

Acceptance criteria should be observable. If a criterion is subjective or cannot be verified automatically, the contract must say whether human review is required. The agent may proceed on a low-risk assumption when the choice is reversible and the assumption is disclosed. It should ask the user when an ambiguity materially changes scope, design, compatibility, or risk.

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
- confidence, freshness, source references, and invalidation conditions for each projection.

The model is not assumed complete. It should answer: what has been inspected, what is inferred, what remains unknown, and which observations may be stale.

Repository instruction files such as AGENTS.md or CLAUDE.md may describe project conventions and workflow constraints. They are project data with bounded relevance, not Kernel policy or permission grants. They cannot override user intent, system policy, security rules, or Kernel admission.

### 4.3 EvidenceGraph

The EvidenceGraph links claims to their supporting or contradicting evidence.

Claim kinds:

- **FACT** — directly observed or verified within a stated scope;
- **HYPOTHESIS** — an explanation to be tested;
- **ASSUMPTION** — temporarily accepted to make progress;
- **DECISION** — a selected course of action and its rationale;
- **UNKNOWN** — information not established;
- **CONTRADICTION** — evidence that conflicts with an existing claim.

Evidence kinds include repository observations, source references, command outputs, test results, diffs, environment facts, Host receipts, external research, and user clarification.

Each evidence item should retain its source, content or payload digest, repository commit or workspace generation, environment, capture time, trust class, and transformation history. The graph is a Context/Orchestration projection; it does not replace Kernel Journal, Host Ledger, or source files.

A claim is invalidated when its bound file, commit, environment, dependency, tool version, or authorization changes. A new source observation must not silently rewrite historical evidence.

### 4.4 PlanRevision and PlanStep

A PlanCandidate becomes authoritative only after Kernel accepts it as a versioned PlanRevision.

A PlanRevision binds:

- GoalContract version and digest;
- RepositoryModel snapshot and workspace generation;
- a dependency-aware PlanStep graph;
- acceptance-criterion coverage;
- assumptions, risks, unresolved questions, and external dependencies;
- expected artifacts and observable outcomes;
- required capabilities and approval boundaries;
- verification obligations and evidence expected from each step;
- rollback or containment strategy for risky changes;
- resource estimate and a verification/repair reserve.

A PlanStep is a meaningful unit of outcome, such as understanding an API boundary, implementing a migration, updating a compatibility layer, or proving a regression is fixed. It is not a single model call or shell command.

A PlanStep should define:

| Field | Meaning |
| --- | --- |
| Objective | Outcome this step must produce |
| Dependencies | PlanSteps that must be complete first |
| Preconditions | Repository, environment, and state assumptions |
| Expected artifacts | Files, interfaces, reports, or evidence to produce |
| Criteria links | Acceptance criteria advanced by this step |
| Risk and effect | Expected workspace and external effects |
| Capability needs | Read, edit, execute, network, or approval requirements |
| Verification | Checks that establish this step's outcome |
| Recovery | Safe retry, rollback, replan, or escalation path |

PlanStep progress is a Kernel-owned fact once the plan is accepted. Orchestration proposes transitions and evidence; Kernel validates and records them. A new PlanRevision supersedes or amends prior work explicitly. It must not erase completed evidence or silently reopen a terminal Task.

### 4.5 ActionProposal and ExecutionTrace

An ActionProposal is a typed suggestion from Orchestration. Typical action kinds are:

- Inspect — read or search repository/environment state;
- Experiment — run a bounded diagnostic experiment;
- Edit — propose a code or configuration change;
- Verify — run a required check or inspect verification evidence;
- Ask — request missing user information;
- RequestApproval — request authorization for a specific risk boundary;
- Wait — wait for a dependency, lease, or external condition;
- Replan — propose a new PlanRevision;
- Stop — stop because the goal is met, blocked, unsafe, or infeasible.

An ActionProposal binds the current PlanRevision, PlanStep, workspace generation, expected preconditions, effect class, proposed tool calls, expected outputs, and a verification method. It is not an execution ticket.

The ExecutionTrace links the ModelStep and Attempt, accepted action proposal, ToolInvocations, Kernel admission decisions, Host run IDs, receipts, artifacts, and resulting evidence. It is the explanation chain for what the agent did and why.

## 5. Control architecture

The system uses three cooperating control loops. They are logical responsibilities of Orchestration, not necessarily separate processes or agents.

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

- Map each acceptance criterion to one or more required evidence obligations.
- Select checks based on the affected code, risk, and criterion coverage.
- Run checks through the trusted execution path.
- Interpret failures as evidence, not merely as a red/green signal.
- Re-run stale or invalidated checks after relevant changes.
- Perform a fresh verification pass that does not rely on the implementer's self-reported success.
- Request the trusted workspace freeze and final snapshot.
- Submit the bound VerificationReport to Kernel Completion Guard.

The assurance loop may send the task back to execution or planning. It cannot declare TaskCompleted itself.

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
6. Record the facts, confidence, and unknowns in the RepositoryModel and EvidenceGraph.

Before a plan is accepted, only the narrowly admitted reconnaissance capabilities may be used. Code writes and other side effects require an accepted plan and normal Kernel admission.

The agent should stop exploring when it has enough evidence to choose a bounded next action. More context is not automatically better.

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
8. If the same failure signature repeats without new evidence, stop the retry path and change strategy, replan, or escalate.

A timeout, disconnected process, missing receipt, or interrupted command may be UNKNOWN. The agent cannot infer failure and blindly repeat a potentially non-idempotent side effect.

### Phase F — Verification

Verification proceeds at multiple levels:

- **Change verification:** inspect diff, formatting, static analysis, type checks, and focused tests.
- **Component verification:** run tests for the affected module or package.
- **Integration verification:** run relevant cross-package, contract, or integration tests.
- **System verification:** run the repository's required full suite, build, or end-to-end checks when required by the criteria and feasible within budget.
- **Acceptance verification:** evaluate every GoalContract criterion against its bound evidence.
- **Independent review:** use a fresh verifier decision step over the accepted plan, criteria, diff, and raw verification evidence. It may use the same model/provider, but it must not treat the implementer's completion claim as evidence.

The verification plan should identify required checks, optional risk-based checks, unavailable checks, and the consequences of each missing result. A skipped or unrun test is not a pass.

### Phase G — Freeze and completion

- Ensure no required operation, child process, or writable handle remains active.
- Capture pre-test, post-test, and final acceptance workspace hashes under the same hash scope.
- If tests or final preparation changed in-scope files, invalidate affected evidence and re-run verification.
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

Model-visible schemas describe interfaces. They do not grant permission.

### 7.3 Concurrency policy

Concurrency follows effect and conflict semantics, not the number of calls emitted by the model.

- Independent read-only inspections may run concurrently.
- Writes may run concurrently only when their write scopes are known to be disjoint and the Host can enforce the boundary.
- Same-file edits, overlapping directories, package-manager operations, generated-code updates, Git index operations, migrations, and workspace-wide commands are serialized unless a stronger isolation contract proves otherwise.
- Unknown conflict scope defaults to serialization.
- A build or test that reads a changing workspace must bind to a stable generation or be rerun after relevant writes.
- Results may arrive in completion order, but their durable association and model-visible projection must be deterministic.
- Cancellation drains or reconciles already-started work; it does not pretend to roll back external effects.

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

Context Engine proposes the checkpoint. Kernel commits the checkpoint record, journal event, and Task pointer in one Kernel-local transaction. It is not authoritative merely because it was generated.

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

| Concern | Orchestration may propose | Kernel must own or enforce |
| --- | --- | --- |
| Goal | GoalContract and criteria candidate | Task identity, accepted scope version, immutable user intent references |
| Repository | RepositoryModel and evidence projections | Workspace identity/generation and trusted snapshot references |
| Planning | PlanCandidate and PlanRevision rationale | Accepted PlanRevision, legal revision transitions, PlanStep progress facts |
| Model reasoning | Purpose, model strategy, context needs | ModelStep/Attempt identity, admission, hard budgets, cancellation and settlement |
| Action | ActionProposal and tool-call batch | ToolInvocation identity, schema/snapshot checks, policy, approval, budget, durable intent |
| Scheduling | Desired ordering and safe concurrency proposal | Admission, fencing, leases, execution constraints, state transitions |
| Debugging | Hypotheses and experiments | Invocation admission, evidence references, retry safety, UNKNOWN reconciliation |
| Verification | Check selection and criterion verdict proposal | Required evidence validation, workspace freeze, Completion Guard |
| Continuity | Checkpoint Candidate and memory Candidate | Checkpoint commit, authoritative Task state, durable recovery |
| Delivery | User-facing summary | Selected response and durable delivery contract |

All Planner, Explorer, Implementer, Debugger, and Verifier model calls pass through Model Gateway and Kernel-managed ModelSteps. No cognitive role bypasses Kernel to call a provider or execute a tool.

## 12. Definition of design success

The proposal is ready for implementation planning only when it has:

- a coherent GoalContract, RepositoryModel, EvidenceGraph, PlanRevision, and PlanStep model;
- explicit strategic, tactical, debugging, assurance, and stopping policies;
- precise Orchestration/Kernel/Context/Tool Runtime/Host boundaries;
- defined long-task checkpoint and recovery semantics;
- a threat and failure model;
- an evaluation benchmark and reproducible experiment protocol;
- explicit unresolved decisions and owner review.

The proposal is not empirically validated. The evaluation protocol is specified in [evaluation.md](evaluation.md); the current evidence and limitations are recorded in [reference-review.md](reference-review.md).

## 13. Open design questions

- How much reconnaissance is sufficient for different task classes, and how should the system detect that it is exploring without learning?
- What is the smallest useful PlanStep granularity for cross-package changes?
- Which evidence types and freshness rules should be mandatory for RepositoryModel claims?
- How should plan revisions preserve stable step identity while representing superseded work?
- How should a verifier's independence be measured without requiring another agent?
- How should flaky tests and nondeterministic environments affect acceptance evidence?
- Which action classes can be safely parallelized under a real workspace conflict model?
- What no-progress thresholds are robust across different task types and model capabilities?
- How should project-specific instruction files be discovered and bounded by user authority?
- Which task classes should be supported in the first controlled vertical slice?

These remain **OPEN** until supported by experiments and owner decisions.
