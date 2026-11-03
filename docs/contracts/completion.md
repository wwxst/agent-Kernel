# Verification and completion contract

> **Status: Approved completion principles re-authored as a cross-domain proposal.** Completion Guard uses one common evidence envelope; Coding and Video supply independent domain-specific evidence and verifiers. Implementation, verifier quality, and evidence interoperability remain unverified.

## 1. Completion is a guarded state transition

A Task is not complete because the model says it is complete, because a command returned exit code zero, because a PlanStep is verified, or because a diff exists.

TaskCompleted is a **TaskControl terminal CAS** with a K-local serializable check of the **relevant** Plan/Goal/Workspace/Host evidence and BudgetScope enforcement-hold read-set. A parallel unrelated receipt or accounting adjustment does not require a global Task version restart; an actual conflicting mutation/hold must invalidate completion.

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

### 3.2 Conditional fresh independent review (G0 optimization proposal)

**No unconditional Verifier ModelStep is required for every task.** The accepted GoalContract's criterion-risk and Workflow Profile's immutable `verification_policy` declare whether fresh independent semantic review is required. Technical/machine evidence and Completion Guard are **always** required as specified; skipping a model review never skips an accepted test, source/execution-view attestation, media output inspection, authorization check, or human gate.

A fresh Verifier ModelStep is required when the accepted assurance policy demands it, semantic instruction fulfillment is not fully decidable by trusted deterministic evidence, criterion evidence is disputed, implementation-authored tests are the only oracle for a protected criterion, risk or uncertainty crosses the profile trigger, or the accepted artifact/evidence bindings become stale. For a low-risk Coding task with independent deterministic tests and complete criterion coverage, Completion Guard may commit directly without an additional model call. For Video, actual rendered-output technical **and content** inspection remain mandatory; whether content assurance uses an independent model, independently annotated comparison, or human judgment is bound by the Video criterion policy. Cost-saving preferences cannot lower a previously accepted assurance obligation.

If invoked, the Verifier receives original UserIntent, current accepted Goal/Plan, exact artifact/diff, raw trusted receipts and criterion evidence, but not the Implementer's private reasoning or unsupported self-conclusion. Same-model fresh-context review may be used only when policy permits; riskier criteria may require a different reviewer or human. The Verifier outputs `NoBlockingFinding`, `BlockingFinding`, `InsufficientEvidence`, or `HumanReviewRequired`; these are advisory review dispositions, **not** execution proof or a criterion PASS. Review-trigger reason, independence class, call/Token cost, and skipped-review policy reference are auditable so G3/G4 can test false-completion regressions against a fixed-verifier control.

### 3.3 External assurance

For criteria whose risk or nature requires it, use human review, security audit, hidden or independently authored tests, staging/real-environment validation, or an external evaluator. If the GoalContract requires a human judgment, only an authenticated, authorized human disposition can satisfy that obligation. Model agreement cannot substitute for it.

### 3.4 Completion Guard's role

The VerificationReport maps every required criterion to its required evidence class, evidence-independence level, provenance, freshness, and actual evidence references. Completion Guard deterministically checks the report's binding, required evidence presence, provenance, freshness, policy-required assurance level, and human dispositions.

Completion Guard does not decide whether a technical approach is semantically correct, whether a test suite is intellectually sufficient beyond the declared evidence contract, or whether a Verifier's reasoning is correct. Those judgments belong to Orchestration, independent review, external assurance, or the user as required. The Guard must not accept a Verifier's NoBlockingFinding as a substitute for required evidence.

## 4. VerificationReport binding

A report should bind at least:

- task ID, accepted **TaskControlVersion**, current GoalContract/PlanRevision epoch and **only the relevant evidence/Host/Workspace/BudgetScope version read-set**; an unrelated Attempt, receipt or Journal append must not stale the report solely by incrementing a global Task sequence;
- accepted GoalContract version and digest;
- accepted PlanRevision and acceptance-criteria version;
- DomainBinding ID/digest and Workflow Profile version;
- criterion-to-PlanStep and criterion-to-evidence mapping;
- workspace/project ID, base commit or source-asset digest set, workspace/project generation, and hash-scope version;
- for Coding, the approved ProtectedInputScope version, immutable SourceSnapshot ID, sourceDigestBefore/sourceDigestAfter/sourceDigestAtGuard, **ExecutionViewManifest digest and Host receipt, effective protected input digests, namespace/mount/overlay/path-resolution identity, enforced in-run no-shadow/no-mutation proof**, and isolated verification-output manifest; for Video, the applicable source/project/timeline/render/output digests;
- environment digest, runtime/compiler/toolchain/renderer versions, FFmpeg build identity where applicable, and dependency-lock hash;
- each required command or render invocation's actual argv/argument digest, filtergraph digest where applicable, working directory, Host run ID, start/finish times, exit code or signal;
- stdout/stderr digests and controlled log references;
- opaque artifact IDs/locators and controlled retrieval references (not bearer access tokens), content hashes, domain artifact schema/version, and source execution IDs;
- for cross-domain consumption, exact handoff ID, producer Task/domain/DomainBinding, ArtifactRef ID/kind/schema/digest, consumer Task/domain/DomainBinding, scoped authorization reference and its validity at each access event, permitted access mode, and derived-output lineage;
- for cross-domain consumption, the ScopedReadGrant ID/version, consumer audience, authorizing principal/policy version, authority/revocation epoch, issue/expiry and revocation facts, and trusted resolver access-event/receipt references; each payload read must be shown as authorized at the time of access;
- for Video, TimelineRevision, RenderPlan, RenderJob, Host receipt, and final rendered-output digest references;
- per-criterion verdicts and evidence references;
- skipped/unavailable checks and reasons;
- verifier identity/version/policy, fresh-context digest, input-source manifest, and review disposition;
- per-criterion evidence-independence class (implementation-authored, independently authored/hidden, external, or human) and the policy-required class;
- human/external review identity, authorization, decision reference, and timestamp where required.

A model-generated hash or test summary is not trusted evidence.

## 5. Workspace and domain artifact snapshot

### 5.1 Coding sealed SourceSnapshot and effective verification view (G0 PROPOSED)

The first viable Host architecture **enforces one read-only sealed SourceSnapshot** containing all acceptance-relevant source, tests, dependency/config files and declared necessary untracked inputs. Verification executes in an isolated Host namespace/container/workspace with **writable scratch/output/cache roots disjoint from protected input paths**. Host-enforced filesystem permissions/mount restrictions, not model assertions, prove that test commands cannot modify, replace, overlay, mount-shadow or redirect a protected input. If a build/test tool expects to write into source paths, the profile must redirect its output to a declared separate root or mark that verification setup **Unsupported/Unverified**; a writable source overlay is not a fallback for the first implementation.

**Minimal trusted ExecutionViewManifest** binds: SourceSnapshot ID/digest and ProtectedInputScope version; exact Host run/process identity; command/cwd; sealed read-only mount/root identity; protected path resolution policy (including symlink and bind-mount handling); list/identity of distinct writable output roots; pinned toolchain/environment/dependency inputs; and authenticated evidence that the sealed view and no-shadow/no-remount policy remained enforced throughout the run. The Host verifies effective protected-path identities/digests correspond to the accepted SourceSnapshot. The manifest also binds the output artifact manifest and independently obtained final workspace/acceptance snapshot.

**Default enforceable sandbox policy:**

1. Materialize or mount an immutable source tree as the **only executable read source for protected files**. Deny writes, writable overlays/upper layers over any protected path, remounts, unapproved bind mounts, symlinks resolving into different/unpinned roots, replacement via cwd/PATH/test discovery, and changes to process mount namespace that could shadow those paths.
2. Permit only predeclared disjoint output/cache/temp roots. The verifier can write there and generate ordinary coverage/build results **without** making the source Stale. Output files are separate provenance-bound artifacts and cannot become trusted source/config/test input by unapproved path redirection.
3. Bind the exact executed command, tool/environment and Host-proven execution view; verify the sealed view was enforced before process start, during execution and through process/descendant convergence, then re-read the immutable input identity at Completion Guard. The Host receipt is independent evidence; a matching lower-layer hash alone is insufficient.
4. Validate `sourceDigestBefore == sourceDigestAfter == sourceDigestAtGuard` **and** exact effective protected source identity/digest in the sealed execution view. A mismatch or unverifiable enforcement invalidates the report, including when lower-layer hashes appear unchanged.
5. If a supported platform cannot enforce the sealed-view/no-shadow guarantee, the criterion stays **Unverified/Unsupported**, not Passed. A full file-open/mutation tracer or another equivalent proof system is **optional future experiment**, requiring separate complexity/security review and G2 evidence; it is **not** implicitly required or authorized by this contract.

This intentionally rejects a broad writable overlay with post-run hashing as the first-slice design. Completion Guard consumes the authenticated ExecutionViewManifest, scope/source/effective-view bindings, process/handle convergence, required criterion evidence and final artifact digest. Video retains immutable source/project/timeline/render/output provenance and output inspection, without forcing a Coding filesystem tracer onto media workflows.

See [Core protocol](core-protocol.md), [Workspace Freeze](workspace-freeze.md), and [Architecture subtraction](../decisions/architecture-subtraction-review.md).

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
- Coding protected-input digest **and trusted effective execution view (including process-view protected-path digests, no-shadow enforcement and Guard reread)**, or Video source/timeline/render/output digests, match the accepted immutable inputs. Generated Coding test outputs remain separately bound as evidence.
- Execution environment, dependency/toolchain, renderer, and FFmpeg build digests match the task contract where applicable.
- Every required test, probe, decode check, or render invocation has a real Host Run, trusted receipt, terminal outcome, and output digest.
- Artifacts are attributable and content-addressed.
- Every cross-domain ArtifactRef read is backed by a ScopedReadGrant bound to the exact consumer Task/DomainBinding, artifact digest, purpose, and access mode; each read was authorized at its access time, no read occurred after expiry/revocation fencing, and any copied bytes follow the declared retention/deletion policy. The report contains no inherited producer authority or private context.
- No required approval, dependency, or external condition is pending.
- No unresolved UNKNOWN invocation, cancellation or writable process remains **if it can affect the accepted final snapshot, deliverable, acceptance evidence or protected external target**. Proven isolated non-conflicting work may be explicitly excluded under trusted policy with its separate unresolved responsibility retained.
- All hard-budget exposure remains covered by credible reservations and no active enforcement hold invalidates completion. Final provider invoices for fully bounded exposure may settle later; missing usage is not zero and does not release its reservation.
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
