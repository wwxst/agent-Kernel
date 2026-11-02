# Verification and completion contract

> **Status: Approved completion principles re-authored as an initial contract.** Completion Guard implementation and evidence quality remain unverified.

## 1. Completion is a guarded state transition

A Task is not complete because the model says it is complete, because a command returned exit code zero, or because a diff exists.

Kernel may commit TaskCompleted only after a VerificationReport is validated against the current accepted PlanRevision, acceptance criteria, workspace snapshot, environment and trusted execution evidence.

## 2. VerificationReport binding

A report should bind at least:

- task ID and aggregate version;
- accepted PlanRevision and acceptance-criteria version;
- workspace ID, base commit and hash-scope version;
- pre-test, post-test and final-acceptance workspace hashes;
- environment digest, runtime/compiler/toolchain versions and dependency-lock hash;
- each required command's actual argv/command digest, working directory, host run ID, start/finish times, exit code or signal;
- stdout/stderr digests and controlled log references;
- artifact paths, content hashes and source execution IDs;
- per-criterion verdicts and evidence references;
- verifier identity/version/policy and report digest.

A model-generated hash or test summary is not trusted evidence.

## 3. Workspace hash sequence

The initial contract distinguishes three hashes:

1. **Pre-test hash** — captured by the trusted Workspace Host before the first verification command.
2. **Post-test hash** — captured after all verification processes and descendants have stopped.
3. **Final acceptance hash** — captured from an immutable snapshot after all verification and permitted final preparation are complete.

Completion Guard independently checks the same immutable snapshot and requires its hash to equal the report's final acceptance hash. The hashes must use the same workspace ID, hash algorithm and hash-scope version.

By default:

`preTestWorkspaceHash == postTestWorkspaceHash == finalAcceptanceWorkspaceHash == workspaceHashAtCompletionGuard`

If a test changes any in-scope source, configuration, dependency or untracked input, the old report is stale and the relevant verification must be rerun. Exclusions must be declared in a versioned hash scope; an agent cannot add exclusions after the fact to preserve a passing report.

## 4. Completion Guard invariants

Before TaskCompleted, Kernel verifies:

- Task is in an allowed state and no model step remains active.
- Report PlanRevision and acceptance criteria match the current accepted versions.
- All required criteria passed.
- Workspace ID, snapshot, hash algorithm and hash-scope version match.
- Final acceptance hash equals the trusted hash of the same immutable snapshot.
- Test environment and dependency/toolchain digests match the task contract.
- Every required test has a real Host Run, trusted receipt, exit code and output digest.
- Artifacts are attributable and content-addressed.
- No required approval, dependency or child task is pending.
- No unresolved UNKNOWN invocation or cancellation remains.
- Budget and usage settlement conditions are satisfied.
- Report is current, not revoked or superseded.
- Verification did not exceed the task's authorization.
- Host has proven the workspace is frozen, write processes/handles are quiescent and the final snapshot is sealed.
- CompletionCommitted and TaskCompleted are committed atomically in Kernel Persistence and bind the receipt digest, snapshot, final hash and fencing epoch.

Any failed or missing condition blocks completion with an explicit reason.

## 5. CompletionHold and remediation

CompletionHold is a safety barrier, not a way to rewrite history.

For a non-terminal Task, a conflicting authoritative late fact may open CompletionHold and block TaskCompleted and new side effects. Evidence review has three outcomes:

- **EvidenceValidated** — resolve the hold, return a non-terminal task to Verifying, and rerun the necessary Completion Guard checks.
- **DefectConfirmed** — preserve the original evidence and create a separately authorized RemediationTask with a new task ID, workspace ID/generation, plan revision, budget, principal/capabilities/approvals, attempts, receipts and verification report.
- **EvidenceInconclusive** — keep the hold active; allow read-only evidence collection and human review only.

For a Task already Completed / Failed / Cancelled, the terminal status is immutable. A late conflict creates an independent post-terminal evidence hold; it does not reopen the Task. Remediation, if authorized, is a separate Task and never overwrites the original receipt, snapshot, attempt or report.

Hold ownership, review deadline, escalation and resolution authority must be explicit. A timeout must not silently clear a safety hold.

## 6. Non-claims

A report does not prove correctness outside its bound workspace, plan, environment, test set and time. The presence of a test file does not prove it passed. A green test suite does not prove sandbox isolation, receipt authenticity or absence of untested defects.

Completion Guard, hash-scope interoperability, process convergence and remediation lifecycle are **UNVERIFIED** until tested.
