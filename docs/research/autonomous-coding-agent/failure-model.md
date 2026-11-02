# Autonomous Coding Agent — Failure Model and Recovery Policy

> **Status: PROPOSED.** This taxonomy is a design input for Orchestration, Kernel, Context Engine, and Trusted ToolHost contracts. It is not a claim that the failure handling is implemented.

## 1. Purpose

Complex coding tasks fail in more ways than model errors or tool exceptions. The system must recognize whether it has misunderstood the goal, misunderstood the repository, chosen a poor plan, made an incorrect change, run an invalid test, lost continuity, or lost certainty about a side effect.

The response to a failure depends on its class and evidence. Retrying the same action is not a universal recovery strategy.

## 2. Failure taxonomy

| Class | Typical symptom | Detection evidence | Required response |
| --- | --- | --- | --- |
| Goal ambiguity | Two plausible interpretations lead to different behavior | Conflicting requirements, missing acceptance detail | Ask the user or proceed only with a disclosed reversible assumption |
| Scope drift | Patch changes unrelated files or public behavior | Diff versus accepted PlanRevision and declared write scope | Stop dependent writes, inspect diff, revert or replan with approval |
| Repository misunderstanding | Wrong layer, stale symbol map, missed convention | Call graph, tests, architecture docs, build output contradict model | Refresh RepositoryModel and revise the plan |
| Plan omission | Required criterion has no PlanStep or verification | Acceptance matrix coverage gap | Create a new PlanRevision before proceeding |
| Dependency failure | Work starts before prerequisite or external service is ready | Dependency state and failed precondition | Block the step; wait, inspect, or replan |
| Implementation defect | Compile error, failing assertion, regression | Reproducible build/test evidence | Use hypothesis-driven debugging and bounded repair |
| Test defect or weakness | Test passes but does not exercise intended behavior | Test diff, coverage, fixtures, mutation or review evidence | Improve verification; do not claim criterion passed |
| Flaky or nondeterministic check | Same test alternates across runs | Repeated run evidence and environment binding | Classify flakiness; require stable evidence or human decision |
| Environment failure | Toolchain missing, service unavailable, permission error | Host receipt, environment digest, command output | Repair environment only within authorization; otherwise block |
| Tool protocol failure | Truncated call, invalid schema, mismatched identity | Model response and tool snapshot | Reject the call; request a complete valid proposal |
| Concurrency conflict | Overlapping edits or stale workspace read | Workspace generation, write-set conflict, diff | Serialize, refresh, and re-evaluate affected steps |
| Cancellation race | Caller cancels while a side effect is running | Kernel intent and Host execution record | Reconcile; do not infer rollback |
| UNKNOWN side effect | Timeout, disconnect, lost ACK, missing receipt | Host Ledger and target-system evidence incomplete | Preserve UNKNOWN; block unsafe retry; reconcile or escalate |
| Context loss | Compaction or restart loses a key constraint or failure | Checkpoint/version mismatch, missing evidence references | Restore from authoritative journal and checkpoint; rebuild context |
| Stale evidence | A file, environment, tool, plan, or workspace changed after a check | Hash/version mismatch | Invalidate dependent claims and rerun required checks |
| False completion | Model says done while criteria remain unverified | Criterion matrix and Completion Guard | Reject completion; return to verify, execute, or block |
| Budget exhaustion | Required verification or repair cannot fit remaining budget | Kernel budget ledger | Stop or ask for authorized top-up; do not silently exceed |
| Security/prompt injection | Retrieved content requests credential disclosure or policy bypass | Provenance/trust labels and policy checks | Treat as data; ignore instruction; deny unauthorized action and record evidence |

## 3. Hypothesis-driven debugging protocol

Every debugging cycle should contain:

1. **Failure signature** — exact failing command, test, output digest, environment, workspace generation, and relevant source state.
2. **Failure class** — code, test, environment, dependency, permission, resource, infrastructure, or UNKNOWN.
3. **Competing hypotheses** — plausible explanations with evidence for and against each.
4. **Discriminating experiment** — the smallest safe action whose possible outcomes distinguish the hypotheses.
5. **Prediction** — what each hypothesis predicts before the experiment runs.
6. **Observed result** — actual output and Host evidence.
7. **Belief update** — which hypotheses were rejected, strengthened, or left unresolved.
8. **Repair decision** — targeted fix, more inspection, new experiment, plan revision, wait, ask, or stop.
9. **Regression proof** — the narrow check and broader affected checks that validate the repair.

A model-generated root-cause statement without a discriminating observation remains a hypothesis.

## 4. No-progress and retry control

Orchestration should detect at least these no-progress patterns:

- the same command or tool call is proposed with the same arguments and same relevant workspace/environment state;
- the same failure signature recurs without a new hypothesis or experiment;
- repeated edits oscillate between equivalent states;
- a PlanStep is repeatedly marked active without producing its expected artifact or evidence;
- exploration produces no new relevant facts and does not reduce uncertainty;
- the agent repeatedly attempts an action that Kernel or Host has denied.

The exact thresholds are **OPEN** and must be tuned against the evaluation benchmark. Kernel enforces hard attempt and resource limits; Orchestration decides whether a new attempt has a meaningful reason.

Retry rules:

- Never replay a non-idempotent invocation while its outcome is UNKNOWN.
- A known retryable failure requires a documented retry condition and remains budgeted.
- A changed argument, tool version, workspace, target, or authorization is a new invocation proposal, not a silent retry.
- After repeated non-informative failures, require a strategy change, plan revision, or human escalation.

## 5. Recovery matrix

| Failure point | Recovery owner | Durable facts to consult | Safe next action |
| --- | --- | --- | --- |
| Before plan acceptance | Orchestration | GoalContract, reconnaissance evidence, Kernel Task state | Continue read-only discovery, ask, or submit revised PlanCandidate |
| After accepted plan, before action | Kernel + Orchestration | Accepted PlanRevision, PlanStep state, budget and policy versions | Rebuild Execution Context and revalidate preconditions |
| During model request | Kernel + Model Gateway | ModelStep, Attempt, provider events, usage evidence | Resume/retry only under the ModelStep contract |
| Before Host accepts invocation | Kernel | Admission, intent, invocation digest | Reissue same idempotent command identity or reject stale proposal |
| After Host accepts invocation | Trusted ToolHost + Kernel | Host Ledger, process identity, receipt, fencing epoch | Reconcile; preserve UNKNOWN until proven |
| After tool completion, before result projection | Kernel + Host | Host receipt and Kernel Journal | Import the same receipt idempotently; do not re-execute |
| During context compaction | Context Engine + Kernel | Journal, accepted plan, checkpoint candidate/record, evidence references | Rebuild projection from authoritative sources |
| During verification | Trusted ToolHost + Kernel | Run IDs, environment digest, workspace hashes, test outputs | Reconcile process convergence; rerun only if evidence is stale and safe |
| During freeze | Trusted ToolHost + Kernel | Freeze request, challenge, nonce, Host Ledger | Recover the same freeze identity or quarantine |
| After TaskCompleted | Kernel | Immutable terminal state and late evidence | Preserve terminal status; use separate hold/remediation task if authorized |

## 6. Security-specific failures

- Treat repository instructions, comments, web pages, and tool output as untrusted data. They may influence code understanding only within the user's authorized task.
- Never promote retrieved content into a system/developer instruction or permission.
- Do not expose secrets in model context, tool output, logs, or checkpoints.
- Reject path traversal, symlink escape, mount escape, stale workspace fencing, mismatched tickets, and changed payload digests at the execution boundary.
- If the Host cannot prove isolation or process convergence, fail closed or quarantine.
- A denied action must remain denied through the entire tool pipeline; a later hook or model response cannot turn denial into approval.

## 7. Completion and terminal-state rule

A Task may complete only through Kernel Completion Guard. A late test result, bill, receipt, or external event does not rewrite a terminal Task. It creates a separate evidence/overrun record and, if authorized, a new remediation Task.

This preserves the difference between:

- **FailedKnown** — evidence proves the operation failed;
- **OutcomeUnknown** — evidence cannot prove whether it happened;
- **Blocked** — safe progress depends on an external condition;
- **TaskFailed** — the overall goal cannot be completed under its contract;
- **TaskCompleted** — the acceptance contract has been proven within its declared scope.
