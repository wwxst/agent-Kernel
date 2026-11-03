# Autonomous Coding Agent — Failure Model and Recovery Policy

> **Status: ACCEPTED for construction (ARB-01, 2026-11-03) as part of the Coding domain construction specification; implementation NOT started.** This taxonomy is a design input for Orchestration, Kernel, Context Engine, and Trusted ToolHost contracts. It is not a claim that the failure handling is implemented.

## 1. Purpose

Complex coding tasks fail in more ways than model errors or tool exceptions. The system must recognize whether it has misunderstood the goal, misunderstood the repository, chosen a poor plan, made an incorrect change, run an invalid test, lost continuity, or lost certainty about a side effect.

The response to a failure depends on its class and evidence. Retrying the same action is not a universal recovery strategy.

## 2. Failure taxonomy

Codes are normative: evidence records, evaluation metrics and terminal dispositions reference `CF-nn`, never free text. This table adds **no terminal state**; the `reason_code` enum it maps into is owned by [Kernel data model §3.2](../../contracts/kernel-data-model.md#32-taskcontrol) (`DeadlineExceeded | NoProgress | BudgetExhausted | UnsafeEnvironment | RepairExhausted | UnresolvedEffect | DependencyFailed | PolicyDenied`).

| ID | Class | Symptom / detection evidence | Allowed recovery | Terminal `reason_code` | Required evidence |
| --- | --- | --- | --- | --- | --- |
| CF-01 | Goal ambiguity | Two plausible interpretations change behavior; conflicting requirements, missing acceptance detail | Ask, or proceed on a disclosed reversible assumption | — | Conflicting-requirement record + clarification or assumption digest |
| CF-02 | Scope drift | Patch touches unrelated files or public behavior; diff vs accepted plan/write scope | Stop dependent writes, inspect diff, revert or L2 | PolicyDenied (only if unauthorized write was attempted) | Diff-vs-plan comparison bound to `base_tree_digest` |
| CF-03 | Repository misunderstanding | Wrong layer, stale symbol map, missed convention; call graph/tests/build contradict the model | Refresh RepositoryModel, revise plan | — | Contradicting source reference at digest |
| CF-04 | Plan omission | Required criterion has no PlanStep or verification | New PlanRevision before proceeding | — | Criterion-coverage gap record |
| CF-05 | Dependency failure | Work starts before a prerequisite or external service is ready | Block, wait, inspect, replan | DependencyFailed | Dependency state + failed precondition |
| CF-06 | Implementation defect | Compile error, failing assertion, regression | Hypothesis-driven debugging + bounded repair | RepairExhausted | Reproducible build/test evidence |
| CF-07 | Test defect or weakness | Test passes but does not exercise the criterion | Improve verification; do not claim Pass | — | Test diff, coverage, fixture/mutation evidence |
| CF-08 | Flaky or nondeterministic check | Same test, same binding, different outcomes across runs | Classify; require stable evidence or human decision | — | ≥2 run records with equal `env_digest` and `argv_digest` |
| CF-09 | Environment failure | Toolchain missing or unsupported, service unavailable, permission error | Repair only within authorization; else block/mark Unsupported | UnsafeEnvironment | Host receipt, environment digest, command output |
| CF-10 | Tool protocol failure | Truncated call, invalid schema, mismatched tool/argument identity | Reject the call; request a complete valid proposal | — | Model response + tool snapshot digest |
| CF-11 | Concurrency conflict | Overlapping edits or stale workspace read-set | Serialize, refresh, re-evaluate affected steps | — | Workspace generation + write-set conflict record |
| CF-12 | Cancellation race | Cancel while a side effect is running | Reconcile; never infer rollback | — (terminal only after convergence) | Kernel cancel intent + Host execution record |
| CF-13 | UNKNOWN side effect | Timeout, disconnect, lost ACK, missing receipt | Preserve UNKNOWN; block unsafe retry; reconcile | UnresolvedEffect | Host Ledger + target evidence incomplete |
| CF-14 | Context loss | Compaction/restart loses a constraint, failure or UNKNOWN | Restore from Journal/checkpoint; rebuild context | — | Checkpoint/version mismatch + missing evidence refs |
| CF-15 | Stale evidence | File, environment, tool, plan or workspace changed after a check | Invalidate dependent claims; re-run required checks | — | Hash/version mismatch record |
| CF-16 | False completion | Model claims done while criteria remain unverified | Reject completion; return to verify/execute | NoProgress (only after bounded repeat) | Criterion matrix + Guard rejection record |
| CF-17 | Budget exhaustion | Required verification or repair cannot fit remaining budget | Stop or ask for authorized top-up; never silently exceed | BudgetExhausted | Kernel budget ledger + reservation state |
| CF-18 | Security / prompt injection | Retrieved content requests credential disclosure, policy bypass, or a destructive edit | Treat as data; ignore instruction; deny and record | PolicyDenied | Provenance/trust label + denied-invocation record |

**Classification and overlap rules.** Classify by the *first blocking cause with direct evidence*, in this order: `CF-13` → `CF-12` → `CF-18`/`CF-02` → `CF-09` → `CF-10` → `CF-11` → `CF-07`/`CF-08` → `CF-06` → `CF-03`/`CF-04`/`CF-01`. A single failure is never `CF-08` without two bound runs; without that, it is `CF-06` (defect) or `CF-07` (weak test). "The test looks wrong" alone is `CF-07`, not evidence for `CF-06`. `CF-13` may not be reclassified to `CF-06`/`CF-09` without reconciliation evidence. Reclassification is itself an event citing the new evidence, and an unchanged retry after reclassification is `CF-16` no-progress regardless of the earlier label. A class with no terminal code can still end the Task through `CF-16`/`CF-17` when the bound is reached.

## 3. Hypothesis-driven debugging protocol

Every debugging cycle should contain:

1. **Failure signature** — exact failing command, test, output digest, environment, workspace generation, and relevant source state.
2. **Failure class** — exactly one `CF-nn` code from §2, with the evidence its row requires.
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

The bounds are not free parameters. `progress.max_same_step_repairs` (default 2) and `progress.max_consecutive_no_progress` (default 3) come from the bound strategy ([Execution Strategy §4.5](../../contracts/execution-strategy.md)); local policy may lower them but may not exceed the profile maximum. Repairs are counted per **(PlanStep, failure signature)** as specified in [Design §6 Phase E](design.md) — a repeated identical action never resets the count, and recovery resumes the persisted count instead of restarting it. Kernel enforces hard attempt and resource limits; Orchestration decides whether a new attempt has a meaningful reason. Tuning is an evaluated strategy change, never an in-run adjustment.

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
- **`Failed(reason_code)`** — the overall goal cannot be completed under its contract; codes are those of §2, not a new enum ([Data model §3.2](../../contracts/kernel-data-model.md#32-taskcontrol));
- **TaskCompleted** — the acceptance contract has been proven within its declared scope.
