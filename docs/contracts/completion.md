# Verification and completion contract

> **Status: Approved completion principles re-authored as an initial contract and extended by a PROPOSED intelligent-execution model.** Completion Guard implementation, verifier quality, and evidence interoperability remain unverified.

## 1. Completion is a guarded state transition

A Task is not complete because the model says it is complete, because a command returned exit code zero, because a PlanStep is verified, or because a diff exists.

Kernel may commit TaskCompleted only after a VerificationReport is validated against the current accepted GoalContract, PlanRevision, acceptance criteria, workspace snapshot, environment, and trusted execution evidence.

The agent's final text is a delivery artifact. It is not completion evidence.

## 2. Acceptance criteria and evidence obligations

Each GoalContract acceptance criterion must have:

- a stable criterion ID and version;
- an observable expected outcome;
- a declared verification method or an explicit human-review requirement;
- links to the PlanSteps that implement or verify it;
- required evidence kinds and acceptable environment/workspace bindings;
- a verdict of Pass, Fail, NotRun, Skip, Partial, or Unverified.

Every required criterion must have sufficient current evidence. A criterion cannot be marked Pass solely because the implementer or model claims it is satisfied.

A PlanStep may be verified independently, but TaskCompleted requires all required Task-level criteria to pass.

## 3. Verification strategy

The proposed assurance process uses multiple levels:

1. **Change verification:** inspect the diff and run focused formatting, static analysis, type, or unit checks as relevant.
2. **Component verification:** run the affected package/module tests.
3. **Integration verification:** run cross-package, contract, or integration checks required by the acceptance criteria.
4. **System verification:** run required full build, end-to-end, or system checks when specified by the task contract.
5. **Acceptance verification:** evaluate every criterion against its evidence obligations.
6. **Independent review:** run a fresh verifier decision step against the accepted plan, criteria, diff, and raw verification evidence. The verifier may use the same model/provider, but must not accept the implementer's completion claim as evidence.

The verification plan must distinguish required checks from optional risk-based checks. A skipped, unavailable, or unrun test is not a pass. If a criterion requires human judgment, the system must request that review rather than synthesize a model verdict as if it were objective evidence.

## 4. VerificationReport binding

A report should bind at least:

- task ID and aggregate version;
- accepted GoalContract version and digest;
- accepted PlanRevision and acceptance-criteria version;
- criterion-to-PlanStep and criterion-to-evidence mapping;
- workspace ID, base commit, workspace generation, and hash-scope version;
- pre-test, post-test, and final-acceptance workspace hashes;
- environment digest, runtime/compiler/toolchain versions, and dependency-lock hash;
- each required command's actual argv/command digest, working directory, Host run ID, start/finish times, exit code or signal;
- stdout/stderr digests and controlled log references;
- artifact paths, content hashes, and source execution IDs;
- per-criterion verdicts and evidence references;
- skipped/unavailable checks and reasons;
- verifier identity/version/policy and report digest.

A model-generated hash or test summary is not trusted evidence.

## 5. Workspace hash sequence

The initial contract distinguishes three hashes:

1. **Pre-test hash** — captured by the trusted Workspace Host before the first verification command.
2. **Post-test hash** — captured after all verification processes and descendants have stopped.
3. **Final acceptance hash** — captured from an immutable snapshot after all verification and permitted final preparation are complete.

Completion Guard independently checks the same immutable snapshot and requires its hash to equal the report's final acceptance hash. The hashes must use the same workspace ID, hash algorithm, and hash-scope version.

By default:

    preTestWorkspaceHash == postTestWorkspaceHash == finalAcceptanceWorkspaceHash == workspaceHashAtCompletionGuard

If a test changes any in-scope source, configuration, dependency, or untracked input, the old report is stale and the relevant verification must be rerun. Exclusions must be declared in a versioned hash scope; an agent cannot add exclusions after the fact to preserve a passing report.

## 6. Completion Guard invariants

Before TaskCompleted, Kernel verifies:

- Task is in an allowed state and no model step remains active.
- GoalContract, PlanRevision, and acceptance-criteria versions match the current accepted versions.
- Every required PlanStep is verified or otherwise accounted for by the accepted plan.
- All required acceptance criteria passed; no required criterion is NotRun, Skip, Partial, or Unverified.
- Criterion evidence is attributable to actual trusted runs, source observations, or authorized human review.
- Verifier report is current and does not rely solely on implementer self-report.
- Workspace ID, generation, snapshot, hash algorithm, and hash-scope version match.
- Final acceptance hash equals the trusted hash of the same immutable snapshot.
- Test environment and dependency/toolchain digests match the task contract.
- Every required test has a real Host Run, trusted receipt, exit code, and output digest.
- Artifacts are attributable and content-addressed.
- No required approval, dependency, or external condition is pending.
- No unresolved UNKNOWN invocation or cancellation remains.
- Budget and usage settlement conditions are satisfied.
- Report is current, not revoked or superseded.
- Verification did not exceed the task's authorization.
- Host has proven the workspace is frozen, write processes/handles are quiescent, and the final snapshot is sealed.
- CompletionCommitted and TaskCompleted are committed atomically in Kernel Persistence and bind the receipt digest, snapshot, final hash, and fencing epoch.

Any failed or missing condition blocks completion with an explicit reason.

## 7. CompletionHold and remediation

CompletionHold is a safety barrier, not a way to rewrite history.

For a non-terminal Task, a conflicting authoritative late fact may open CompletionHold and block TaskCompleted and new side effects. Evidence review has three outcomes:

- **EvidenceValidated** — resolve the hold, return a non-terminal task to Verifying, and rerun the necessary Completion Guard checks.
- **DefectConfirmed** — preserve the original evidence and create a separately authorized RemediationTask with a new task ID, workspace ID/generation, plan revision, budget, principal/capabilities/approvals, attempts, receipts, and verification report.
- **EvidenceInconclusive** — keep the hold active; allow read-only evidence collection and human review only.

For a Task already Completed / Failed / Cancelled, the terminal status is immutable. A late conflict creates an independent post-terminal evidence hold; it does not reopen the Task. Remediation, if authorized, is a separate Task and never overwrites the original receipt, snapshot, attempt, or report.

Hold ownership, review deadline, escalation, and resolution authority must be explicit. A timeout must not silently clear a safety hold.

## 8. Non-claims

A report does not prove correctness outside its bound workspace, plan, environment, test set, and time. The presence of a test file does not prove it passed. A green test suite does not prove sandbox isolation, receipt authenticity, or absence of untested defects. A fresh verifier pass reduces self-report dependence but does not guarantee correctness beyond its evidence.

Completion Guard, verifier quality, hash-scope interoperability, process convergence, and remediation lifecycle are **UNVERIFIED** until tested.
