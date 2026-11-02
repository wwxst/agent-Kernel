# Verification and completion contract

> **Status: Approved completion principles re-authored as a cross-domain proposal.** Completion Guard uses one common evidence envelope; Coding and Video supply independent domain-specific evidence and verifiers. Implementation, verifier quality, and evidence interoperability remain unverified.

## 1. Completion is a guarded state transition

A Task is not complete because the model says it is complete, because a command returned exit code zero, because a PlanStep is verified, or because a diff exists.

Kernel may commit TaskCompleted only after a VerificationReport is validated against the current accepted GoalContract, PlanRevision, DomainBinding/Workflow Profile, acceptance criteria, final workspace/project snapshot, environment, delivered artifact digests, and trusted execution evidence.

The agent's final text is a delivery artifact. It is not completion evidence.

## 2. Acceptance criteria and evidence obligations

Each GoalContract acceptance criterion must have:

- a stable criterion ID and version;
- an observable expected outcome;
- a declared verification method or an explicit human-review requirement;
- links to the PlanSteps that implement or verify it;
- required evidence kinds, evidence-independence class, and acceptable environment/workspace bindings;
- a verdict of Pass, Fail, NotRun, Skip, Partial, or Unverified.

Every required criterion must have sufficient current evidence. A criterion cannot be marked Pass solely because the implementer or model claims it is satisfied.

A PlanStep may be verified independently, but TaskCompleted requires all required Task-level criteria to pass.

## 3. Verification strategy and independence

Verification is a layered evidence process. Process independence, judgment independence, and evidence independence are different properties and must be recorded separately.

### 3.1 Machine-verifiable evidence

Run the checks required by the accepted GoalContract and plan. Coding examples include tests, builds, type checks, static analysis, API/contract checks, and hidden tests. Video examples include ffprobe metadata checks, frame/packet decode checks, timeline/source-range invariants, audio/video synchronization, and media-profile checks. The domain Workflow Profile defines the required evidence classes. Each run must use the trusted execution path and record actual command, environment, workspace, Host run ID, receipt, exit/signal, output digest, and artifacts.

A test authored or modified by the Implementer is useful evidence that the test ran and that the implementation satisfies that particular test. It is not automatically an independent oracle. The evidence record must retain test provenance and whether its oracle was authored/modified by the implementation path, independently authored, hidden, or externally supplied.

### 3.2 Fresh independent review

After implementation and machine checks, create a fresh Verifier ModelStep. It must receive the original UserIntent, accepted GoalContract and PlanRevision, acceptance criteria, current diff, and raw verification evidence. It must not rely on the Implementer's summary, self-assessment, private reasoning, or prior conclusion as evidence.

The same model/provider may be used for ordinary-risk tasks if the Verifier receives a fresh context and makes a separate decision. For higher-risk criteria, policy may require a different model/provider, an independent test author, or external review. A different model alone does not make evidence independent.

The Verifier emits only review dispositions:

- NoBlockingFinding — no blocking issue found in the inspected evidence;
- BlockingFinding — a potential defect or criterion mismatch needs resolution;
- InsufficientEvidence — evidence obligations are not met;
- HumanReviewRequired — the criterion requires an authorized human decision.

A Verifier disposition is a review artifact, not a trusted test result and not a criterion Pass. It may identify missing tests or request further verification; it cannot manufacture execution evidence.

### 3.3 External assurance

For criteria whose risk or nature requires it, use human review, security audit, hidden or independently authored tests, staging/real-environment validation, or an external evaluator. If the GoalContract requires a human judgment, only an authenticated, authorized human disposition can satisfy that obligation. Model agreement cannot substitute for it.

### 3.4 Completion Guard's role

The VerificationReport maps every required criterion to its required evidence class, evidence-independence level, provenance, freshness, and actual evidence references. Completion Guard deterministically checks the report's binding, required evidence presence, provenance, freshness, policy-required assurance level, and human dispositions.

Completion Guard does not decide whether a technical approach is semantically correct, whether a test suite is intellectually sufficient beyond the declared evidence contract, or whether a Verifier's reasoning is correct. Those judgments belong to Orchestration, independent review, external assurance, or the user as required. The Guard must not accept a Verifier's NoBlockingFinding as a substitute for required evidence.

## 4. VerificationReport binding

A report should bind at least:

- task ID and aggregate version;
- accepted GoalContract version and digest;
- accepted PlanRevision and acceptance-criteria version;
- DomainBinding ID/digest and Workflow Profile version;
- criterion-to-PlanStep and criterion-to-evidence mapping;
- workspace/project ID, base commit or source-asset digest set, workspace/project generation, and hash-scope version;
- pre-execution, post-execution, and final-acceptance workspace/project snapshot digests;
- environment digest, runtime/compiler/toolchain/renderer versions, FFmpeg build identity where applicable, and dependency-lock hash;
- each required command or render invocation's actual argv/argument digest, filtergraph digest where applicable, working directory, Host run ID, start/finish times, exit code or signal;
- stdout/stderr digests and controlled log references;
- artifact paths/URIs, content hashes, domain artifact schema/version, and source execution IDs;
- for Video, TimelineRevision, RenderPlan, RenderJob, Host receipt, and final rendered-output digest references;
- per-criterion verdicts and evidence references;
- skipped/unavailable checks and reasons;
- verifier identity/version/policy, fresh-context digest, input-source manifest, and review disposition;
- per-criterion evidence-independence class (implementation-authored, independently authored/hidden, external, or human) and the policy-required class;
- human/external review identity, authorization, decision reference, and timestamp where required.

A model-generated hash or test summary is not trusted evidence.

## 5. Workspace and domain artifact snapshot

### 5.1 Coding workspace hash sequence

The Coding domain distinguishes three hashes:

1. **Pre-test hash** — captured by the trusted Workspace Host before the first verification command.
2. **Post-test hash** — captured after all verification processes and descendants have stopped.
3. **Final acceptance hash** — captured from an immutable snapshot after all verification and permitted final preparation are complete.

Completion Guard independently checks the same immutable snapshot and requires its hash to equal the report's final acceptance hash. The hashes must use the same workspace ID, hash algorithm, and hash-scope version.

By default:

    preTestWorkspaceHash == postTestWorkspaceHash == finalAcceptanceWorkspaceHash == workspaceHashAtCompletionGuard

If a test changes any in-scope source, configuration, dependency, or untracked input, the old report is stale and the relevant verification must be rerun. Exclusions must be declared in a versioned hash scope; an agent cannot add exclusions after the fact to preserve a passing report.

### 5.2 Video media artifact snapshot

The Video domain does not use a Git workspace hash as a substitute for media provenance. Its final report binds:

- immutable source MediaAsset IDs and content digests, declared source/usage metadata, and exact ProjectSnapshot ID/generation/manifest digest;
- selected stream identities, source PTS/timebase/sample positions, proxy digests, and verified source-to-proxy mappings;
- MediaAnalysis IDs/configuration/coverage and MediaProjectModel projection version/digest used for planning;
- NarrativePlan ID/version/digest, accepted TimelineRevision ID/digest, parent/EditIntent lineage, and EvidenceCarryForward records;
- per-output-interval source-to-output mapping: source asset/stream digest, source PTS/sample range, timeline clip/transition, and applied transformation nodes; transitions may map one output interval to multiple source intervals;
- RenderPlan ID/digest, compiler and FFmpeg build/environment identity, canonical argv/filtergraph digest, and Output Profile version;
- RenderJob/ToolInvocation IDs, Host run ID, receipt, exit/signal, resource settlement, staging identity, process/handle convergence, and publication fencing;
- final rendered artifact digest, independently obtained probe/decode report, technical checks, content/perceptual evidence, required human disposition, and final publication state.

The source assets remain unchanged. A new edit instruction creates a new TimelineRevision and output artifact. If any bound source, stream mapping, analysis claim used by a criterion, timeline, render plan, profile, renderer, or output digest changes, the affected report/evidence becomes stale and checks must be repeated.

The exact project snapshot, source/output digests, and final artifact identity must be independently re-read from the trusted storage/Host boundary; a model-generated filename, source attribution, or hash is not evidence.

### 5.3 Video source-to-output provenance and acceptance

For each final output interval, the report must make it possible to trace back to one or more exact source intervals or to an explicitly declared generated/externally supplied ingredient. It records source digest, stream, PTS/sample interval, timeline clip/transition, render operation, output interval, and any audio/visual transformation. Unmapped output intervals are not silently accepted as source-derived content.

Technical validity, editorial fulfillment, provenance completeness, and human acceptance are separate result dimensions:

- **Technical validity:** container/stream/profile checks, complete decode under the declared scan policy, timing/synchronization, audio integrity, output digest, and trusted Host receipt.
- **Editorial/content fulfillment:** required and excluded content, message/beat coverage, order/context, factual/causal consistency, and actual rendered output match.
- **Perceptual quality:** continuity, pacing, audiovisual coherence, readability, and artifacts, using declared independent review evidence.
- **Source provenance:** all source/derived ingredients and output intervals are traceable to immutable digests and transformation lineage.
- **Rights/authenticity context:** declared licenses/permissions and any optional provenance credential are recorded separately. A content-provenance manifest can attest to a chain of edits/ingredients; it does not prove that depicted content is true, that a source is authentic in the real world, or that its use is legally licensed.

A model verifier's opinion is a review finding, not proof. Subjective narrative/style or high-impact factual criteria require the human/external disposition declared by GoalContract and policy. The independent verifier must inspect the actual rendered output, not only the TimelineRevision, RenderPlan, editor rationale, or source summaries.

## 6. Completion Guard invariants

Before TaskCompleted, Kernel verifies:

- Task is in an allowed state and no ModelStep, ToolInvocation, or Host job remains active.
- GoalContract, PlanRevision, and acceptance-criteria versions match the current accepted versions.
- Every required PlanStep is verified or otherwise accounted for by the accepted plan.
- All required acceptance criteria passed; no required criterion is NotRun, Skip, Partial, or Unverified.
- Criterion evidence is attributable to actual trusted runs, source observations, or authorized human review.
- A fresh Verifier review record is present when required, and its input manifest excludes the Implementer's summary/self-assessment as evidence.
- Verifier disposition is not treated as criterion proof; the required machine/external/human evidence classes are independently present.
- Per-criterion evidence-independence class meets the risk-based requirement in the accepted GoalContract/policy.
- Workspace or media-project identity, DomainBinding, generation, and final artifact snapshot match the report.
- Coding final acceptance hash or Video source/timeline/render/output digests equal the trusted digests of the same immutable artifacts.
- Execution environment, dependency/toolchain, renderer, and FFmpeg build digests match the task contract where applicable.
- Every required test, probe, decode check, or render invocation has a real Host Run, trusted receipt, terminal outcome, and output digest.
- Artifacts are attributable and content-addressed.
- No required approval, dependency, or external condition is pending.
- No unresolved UNKNOWN invocation or cancellation remains.
- Budget and usage settlement conditions are satisfied.
- Report is current, not revoked or superseded.
- Verification did not exceed the task's authorization.
- Host has proven the relevant workspace/project write or render processes/handles are quiescent and the final workspace snapshot or domain artifact is sealed.
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
