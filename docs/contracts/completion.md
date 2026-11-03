# Verification and completion contract

> **Status: ACCEPTED for construction (ARB-01, 2026-11-03); implementation NOT started; runtime claims UNVERIFIED.** Completion Guard uses one common, domain-neutral evidence envelope; Coding and Video supply independent domain evidence and verifiers as **profile instances**, never as Kernel branches. Record shapes are owned by [Kernel data model](kernel-data-model.md); strategy knobs by [Execution Strategy](execution-strategy.md).

## 1. Completion is a guarded state transition

A Task is not complete because the model says it is complete, because a command returned exit code zero, because a PlanStep is verified, or because a diff exists.

TaskCompleted is a **TaskControl terminal CAS** with a K-local serializable check of the **relevant** Plan/Goal/Workspace/Host evidence and BudgetScope enforcement-hold read-set. A parallel unrelated receipt or accounting adjustment does not require a global Task version restart; an actual conflicting mutation/hold must invalidate completion.

Kernel may commit TaskCompleted only after a VerificationReport is validated against the current accepted GoalContract, PlanRevision, DomainBinding/Workflow Profile, acceptance criteria, final workspace/project snapshot, environment, delivered artifact digests, and trusted execution evidence.

The agent's final text is a delivery artifact. It is not completion evidence.

### 1.1 Kernel assurance floor (`KF-1`…`KF-8`)

The floor is what **every** Task must satisfy regardless of domain, Workflow Profile or Execution Strategy. A profile or strategy may add obligations; it may never omit, weaken or re-label a floor item ([Execution Strategy](execution-strategy.md) §3).

1. **KF-1 Current authority and bindings.** Accepted GoalContract, active PlanRevision, DomainBinding/Workflow Profile, strategy and criterion versions are current at Guard time; no protected-field change, revocation or `RevocationPending` invalidates the basis.
2. **KF-2 Mandatory checks actually ran.** Every check the accepted policy marks mandatory has a real trusted run bound to the sealed execution view — not a plan, not a summary, not a prior run under different inputs.
3. **KF-3 Output inspection.** Any criterion whose subject is a produced artifact requires inspection of the **actual artifact bytes** (or rendered output) produced by a trusted run. A description of the artifact is never inspection of it.
4. **KF-4 Provenance binding.** Every deliverable artifact is content-addressed with producer identity, source references and transformation lineage sufficient to re-derive what was delivered.
5. **KF-5 No conflicting effectful UNKNOWN.** No unresolved effect can still alter the accepted snapshot, deliverable or protected external target; provably isolated work may be excluded only by trusted policy with its responsibility retained.
6. **KF-6 Budget integrity.** Hard-budget exposure remains covered by credible reservations; no enforcement hold invalidates completion; missing usage is not zero and never releases a reservation.
7. **KF-7 Deterministic Guard.** The Completion Guard runs deterministically, in the fixed order of §6, with no model in the decision path, and records every check result.
8. **KF-8 Terminal immutability.** The terminal CAS happens once, binds immutable references, and is never rewritten; late facts create holds/remediation, never a reopened Task.

**Generic evidence classes** — the only vocabulary Kernel knows. Domain profiles map their concrete checks onto these classes; Kernel never inspects domain semantics:

| Class | Asserts | Profile instances (examples, not Kernel branches) |
| --- | --- | --- |
| `protected_input_view` | the effective inputs seen by the run equal the accepted immutable inputs, enforced and attested by the Host | Coding sealed SourceSnapshot + `ExecutionViewManifest`; Video immutable source/project snapshot |
| `output_inspection` | the actual produced artifact was opened/decoded/inspected by a trusted or independent party | Coding test/build output; Video probe/decode and rendered-output review |
| `external_target_identity` | the external target that was mutated or read is the exact authorized target, verified at access time | Office document revision/ETag; any remote publication target |
| `provenance_map` | delivered content traces to immutable sources and declared transformations, with unmapped regions explicit | Video source-to-output interval map; Coding artifact/diff lineage |
| `machine_check` | a deterministic check (build, type, lint, invariant, decode, probe, schema) ran and produced a bound result on the sealed execution view | Coding build/test/type results; Video decode/profile/timeline-invariant results |
| `human_disposition` | an authenticated, authorized human made the criterion judgment with declared independence | subjective Video editorial criteria; high-impact Office share/publish; security review |

A criterion cannot be `Pass` unless its required evidence classes are present as records. No class may be satisfied by a model statement, a filename, a summary or an unverified hash.

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

**Who may write a `Pass` (normative).** A criterion verdict is written by exactly two parties: the **domain verifier** proposes a verdict backed by evidence records, and the **Completion Guard** accepts it in the §6 order. An adapter, tool, model or producer may emit `candidate_verdict` evidence but cannot self-certify: a `Pass` originating from the implementation path, the artifact producer, the plan author or the model that produced the work is not a verdict. A human disposition is a distinct review record bound to criterion ID, artifact digest and reviewer independence ([Permissions](../security/permissions.md) §4.7). Guard may only **accept** or **block**; it never upgrades an absent, `NotRun`, `Skip`, `Partial` or `Unverified` verdict to `Pass`. A Guard acceptance with no verifier record is valid only where the accepted policy declares the criterion fully machine-decidable and the mandatory checks ran on the sealed view.

## 3. Verification strategy and independence

Verification is a layered evidence process. Process independence, judgment independence, and evidence independence are different properties and must be recorded separately.

### 3.1 Machine-verifiable evidence

Run the checks required by the accepted GoalContract and plan, expressed as concrete per-profile instances of the §1.1 evidence classes. Coding-profile examples: tests, builds, type checks, static analysis, API/contract checks, and hidden tests. Video-profile examples: ffprobe metadata checks, frame/packet decode checks, timeline/source-range invariants, audio/video synchronization, and media-profile checks. The domain Workflow Profile declares which concrete checks satisfy which class; Kernel never inspects the check list itself. Each run must use the trusted execution path and record actual command, environment, workspace, Host run ID, receipt, exit/signal, output digest, and artifacts.

A test authored or modified by the Implementer is useful evidence that the test ran and that the implementation satisfies that particular test. It is not automatically an independent oracle. The evidence record must retain test provenance and whether its oracle was authored/modified by the implementation path, independently authored, hidden, or externally supplied.

### 3.2 Conditional fresh independent review (ACCEPTED for construction v0)

**No unconditional Verifier ModelStep is required for every task.** The accepted GoalContract's criterion-risk and Workflow Profile's immutable `verification_policy` declare whether fresh independent semantic review is required. Technical/machine evidence and Completion Guard are **always** required as specified; skipping a model review never skips an accepted test, source/execution-view attestation, media output inspection, authorization check, or human gate.

A fresh Verifier ModelStep is required when the accepted assurance policy demands it, semantic instruction fulfillment is not fully decidable by trusted deterministic evidence, criterion evidence is disputed, implementation-authored tests are the only oracle for a protected criterion, risk or uncertainty crosses the profile trigger, or the accepted artifact/evidence bindings become stale. For a low-risk task with independent deterministic tests and complete criterion coverage, Completion Guard may commit directly without an additional model call. Where a criterion's subject is a produced artifact, inspection of the **actual artifact output** (technical and, where the criterion requires it, content) remains mandatory; whether content assurance uses an independent model, an independently annotated comparison, or human judgment is bound by that criterion's policy, not by cost. Cost-saving preferences cannot lower a previously accepted assurance obligation.

If invoked, the Verifier receives original UserIntent, current accepted Goal/Plan, exact artifact/diff, raw trusted receipts and criterion evidence, but not the Implementer's private reasoning or unsupported self-conclusion. Same-model fresh-context review may be used only when policy permits; riskier criteria may require a different reviewer or human. The Verifier outputs `NoBlockingFinding`, `BlockingFinding`, `InsufficientEvidence`, or `HumanReviewRequired`; these are advisory review dispositions, **not** execution proof or a criterion PASS. Review-trigger reason, independence class, call/Token cost, and skipped-review policy reference are auditable so the PE domain slices can test false-completion regressions against a fixed-verifier control.

**Verifier sensitivity and shadow-audit record (design only; NOT RUN).** Each acceptance records enough to measure whether the *decision to skip or require* review is itself sound: `trigger_class` (which rule fired: policy-required, implementer-authored oracle, disputed evidence, stale binding, high-impact claim, low confidence, manual), `review_required` (bool) and `skipped_review_policy_ref`; `shadow_audit_sample_ref` and `shadow_audit_result` for tasks where the policy permitted skipping review but the sample was independently re-reviewed; `false_block_count` and `false_allow_count` attributed to the reviewing party; and `guard_rejection_reason` where Guard blocked a verifier proposal. These are audit fields, not a guarantee: a low false-block rate never justifies removing a mandatory check, and a shadow audit is a control on the policy, not proof that an individual verdict is correct.

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
- `domain_evidence_refs[]`: typed `{schema_id, schema_version, digest}` for every domain evidence artifact the report relies on (for example a sealed execution-view manifest, a source/project snapshot, a render plan, a provenance map), plus the Kernel-level bindings those artifacts are checked against (workspace/project generation, hash-scope version, effective protected-input identity). Kernel binds identity and digest; the domain verifier interprets the payload;
- environment digest, runtime/compiler/toolchain/renderer versions, FFmpeg build identity where applicable, and dependency-lock hash;
- each required command or render invocation's actual argv/argument digest, filtergraph digest where applicable, working directory, Host run ID, start/finish times, exit code or signal;
- stdout/stderr digests and controlled log references;
- opaque artifact IDs/locators and controlled retrieval references (not bearer access tokens), content hashes, domain artifact schema/version, and source execution IDs;
- for cross-domain consumption, exact handoff ID, producer Task/domain/DomainBinding, ArtifactRef ID/kind/schema/digest, consumer Task/domain/DomainBinding, scoped authorization reference and its validity at each access event, permitted access mode, and derived-output lineage;
- for cross-domain consumption, the ScopedReadGrant ID/version, consumer audience, authorizing principal/policy version, authority/revocation epoch, issue/expiry and revocation facts, and trusted resolver access-event/receipt references; each payload read must be shown as authorized at the time of access;
- the delivered output artifact digest and any required inspection/provenance artifact digest, carried as `domain_evidence_refs[]` entries;
- per-criterion verdicts and evidence references;
- skipped/unavailable checks and reasons;
- verifier identity/version/policy, fresh-context digest, input-source manifest, and review disposition;
- per-criterion evidence-independence class (implementation-authored, independently authored/hidden, external, or human) and the policy-required class;
- human/external review identity, authorization, decision reference, and timestamp where required.

A model-generated hash or test summary is not trusted evidence.

## 5. Workspace and domain artifact snapshot

### 5.1 Sealed SourceSnapshot, effective verification view and `protected_input_view` (ACCEPTED for construction v0)

The first viable Host architecture **enforces one read-only sealed SourceSnapshot** containing all acceptance-relevant source, tests, dependency/config files and declared necessary untracked inputs. Verification executes in an isolated Host namespace/container/workspace with **writable scratch/output/cache roots disjoint from protected input paths**. Host-enforced filesystem permissions/mount restrictions, not model assertions, prove that test commands cannot modify, replace, overlay, mount-shadow or redirect a protected input. If a build/test tool expects to write into source paths, the profile must redirect its output to a declared separate root or mark that verification setup **Unsupported/Unverified**; a writable source overlay is not a fallback for the first implementation.

**`ProtectedInputScope` content rule (normative).** The scope is a versioned, predeclared list, not an on-the-fly selection:

- **Included:** source files, test files (implementation- or independently authored), build/config manifests, dependency lockfiles, declared generated inputs needed to reproduce the build, and declared oracle inputs.
- **Excluded:** build outputs, dependency caches, coverage output, temporary files, VCS internals (index/refs/objects) and any path outside the declared roots — unless a profile explicitly declares a path as protected input.
- **Versioning and approval.** A scope change is a protected-field change: new scope version, new snapshot binding, explicit approval recorded before the run, and a report bound to that version. Evidence produced under an earlier scope is stale for a later one.
- **Two special declared inputs, both digest-bound and read-only:** `DependencyRoot` (the resolved dependency tree/materialized lockfile state actually used) and `HiddenOracleInput` (independently supplied tests/oracles that the implementer path did not author). Both are declared in the scope, mounted read-only and digested; neither may be supplied by the implementer at run time, and a hidden oracle's content digest is visible to Guard even when its content is not shown to the implementation path.
- **Equality rule.** Passed evidence requires `effective_protected_inputs == sealed_source_snapshot ∪ declared_DependencyRoot ∪ declared_HiddenOracleInput` with every element digest-matching. A subset, superset, substitute or hash-only match is not equality.

**Minimal trusted ExecutionViewManifest** binds: SourceSnapshot ID/digest and ProtectedInputScope version; exact Host run/process identity; command/cwd; sealed read-only mount/root identity; protected path resolution policy (including symlink and bind-mount handling); opened, per-path-symlink-or-remount denials where recorded; list/identity of distinct writable output roots; pinned toolchain/environment/dependency inputs; and authenticated evidence that the sealed view and no-shadow/no-remount policy remained enforced throughout the run. The Host verifies effective protected-path identities/digests correspond to the accepted SourceSnapshot and declared special inputs. The manifest also binds the output artifact manifest and independently obtained final workspace/acceptance snapshot.

**Default enforceable sandbox policy:**

1. Materialize or mount an immutable source tree as the **only executable read source for protected files**. Deny writes, writable overlays/upper layers over any protected path, remounts, unapproved bind mounts, symlinks resolving into different/unpinned roots, replacement via cwd/PATH/test discovery, and changes to process mount namespace that could shadow those paths.
2. Permit only predeclared disjoint output/cache/temp roots. The verifier can write there and generate ordinary coverage/build results **without** making the source Stale. Output files are separate provenance-bound artifacts and cannot become trusted source/config/test input by unapproved path redirection.
3. Bind the exact executed command, tool/environment and Host-proven execution view; verify the sealed view was enforced before process start, during execution and through process/descendant convergence, then re-read the immutable input identity at Completion Guard. The Host receipt is independent evidence; a matching lower-layer hash alone is insufficient.
4. Validate `sourceDigestBefore == sourceDigestAfter == sourceDigestAtGuard` **and** exact effective protected source identity/digest in the sealed execution view. A mismatch or unverifiable enforcement invalidates the report, including when lower-layer hashes appear unchanged.
5. If a supported platform cannot enforce the sealed-view/no-shadow guarantee, the criterion stays **Unverified/Unsupported**, not Passed. A full file-open/mutation tracer or another equivalent proof system is **optional future experiment**, requiring separate complexity/security review and G2 evidence; it is **not** implicitly required or authorized by this contract.

This intentionally rejects a broad writable overlay with post-run hashing as the first-slice design. Completion Guard consumes the authenticated ExecutionViewManifest, scope/source/effective-view bindings, process/handle convergence, required criterion evidence and final artifact digest. Video retains immutable source/project/timeline/render/output provenance and output inspection, without forcing a Coding filesystem tracer onto media workflows.

See [Core protocol](core-protocol.md), [Workspace Freeze](workspace-freeze.md), and [Architecture subtraction](../decisions/architecture-subtraction-review.md).

### 5.2 Media artifact snapshot (Video profile instance)

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

### 5.3 Source-to-output provenance and acceptance (Video profile instance)

For each final output interval, the report must make it possible to trace back to one or more exact source intervals or to an explicitly declared generated/externally supplied ingredient. It records source digest, stream, PTS/sample interval, timeline clip/transition, render operation, output interval, and any audio/visual transformation. Unmapped output intervals are not silently accepted as source-derived content.

Technical validity, editorial fulfillment, provenance completeness, and human acceptance are separate result dimensions:

- **Technical validity:** container/stream/profile checks, complete decode under the declared scan policy, timing/synchronization, audio integrity, output digest, and trusted Host receipt.
- **Editorial/content fulfillment:** required and excluded content, message/beat coverage, order/context, factual/causal consistency, and actual rendered output match.
- **Perceptual quality:** continuity, pacing, audiovisual coherence, readability, and artifacts, using declared independent review evidence.
- **Source provenance:** all source/derived ingredients and output intervals are traceable to immutable digests and transformation lineage.
- **Rights/authenticity context:** declared licenses/permissions and any optional provenance credential are recorded separately. A content-provenance manifest can attest to a chain of edits/ingredients; it does not prove that depicted content is true, that a source is authentic in the real world, or that its use is legally licensed.

A model verifier's opinion is a review finding, not proof. Subjective narrative/style or high-impact factual criteria require the human/external disposition declared by GoalContract and policy. The independent verifier must inspect the actual rendered output, not only the TimelineRevision, RenderPlan, editor rationale, or source summaries.

## 6. Completion Guard invariants and fixed check order

The Guard evaluates in the order below, **stopping at the first failure**, and records every result as a `checks[]` entry `{check_id, ok, detail_ref}` in the `CompletionRecord` ([Data model](kernel-data-model.md) §3.11). The order is normative because it determines the blocking reason and whether a hold opens. A check that cannot be evaluated — missing record, unresolvable digest, unreadable ledger — is a **failure**, never a skip. No model participates in this decision.

1. **`G01 task_state`** — the Task is in an allowed non-terminal state; no ModelStep, ToolInvocation or Host job remains active; the report is the current one, not revoked, superseded or stale.
2. **`G02 bindings_current`** — accepted GoalContract, active PlanRevision, DomainBinding/Workflow Profile, strategy and acceptance-criteria versions are current; verification stayed inside the Task's authorization; no protected-field change, revocation or `RevocationPending` invalidates the basis (`KF-1`).
3. **`G03 plan_coverage`** — every required PlanStep is verified or otherwise accounted for by the accepted plan; no required approval, dependency or external condition is pending.
4. **`G04 criteria_pass`** — every required criterion is `Pass`; none is `NotRun`, `Skip`, `Partial` or `Unverified`; the Pass was written by a permitted party (§2), not by the implementation path.
5. **`G05 evidence_attribution`** — each criterion's evidence is attributable to an actual trusted run, a trusted source observation or an authorized human review; the independence class meets the accepted policy; a fresh verifier record exists when required and its input manifest excludes the implementer's summary; a verifier disposition is never treated as criterion proof.
6. **`G06 protected_input_view`** — the sealed execution view and Guard re-read show `effective_protected_inputs` equal to the accepted snapshot plus declared `DependencyRoot`/`HiddenOracleInput` (§5.1 equality rule), with no-shadow/no-remount enforcement proven through process convergence. A lower-layer hash match without view proof is not sufficient.
7. **`G07 output_inspection`** — every artifact-bearing criterion has an inspection of the **actual produced bytes** by a trusted or independent party, bound to Host run, receipt, terminal outcome and output digest.
8. **`G08 external_target_identity`** — where an external system was read or mutated, the exact target identity was verified at access time (revision/ETag/status), not inferred from a name or URL.
9. **`G09 provenance_map`** — artifacts are attributable and content-addressed; every delivered region maps to immutable sources and declared transformations, or is explicitly declared generated/external. Unmapped regions are not silently accepted.
10. **`G10 environment`** — environment, toolchain, dependency-lock, renderer and codec/FFmpeg build digests match the task contract where applicable.
11. **`G11 grants`** — every cross-domain ArtifactRef read is backed by a `ScopedReadGrant` bound to the exact consumer Task/DomainBinding, artifact digest, purpose and access mode; every read was authorized at its access time; none occurred after expiry/revocation fencing; copied bytes follow the declared retention/deletion policy; no producer authority or private context is inherited.
12. **`G12 unknown_closure`** — no unresolved UNKNOWN invocation, cancellation or writable process can affect the accepted final snapshot, deliverable, acceptance evidence or protected external target (`KF-5`). Proven isolated non-conflicting work may be excluded only by trusted policy, with its unresolved responsibility retained.
13. **`G13 budget_integrity`** — all hard-budget exposure remains covered by credible reservations and no active enforcement hold invalidates completion (`KF-6`). Final invoices for fully bounded exposure may settle later; missing usage is not zero and never releases a reservation.
14. **`G14 quiescence`** — the Host has proven, with its own evidence, that the relevant workspace/project write or render processes and writable handles are quiescent and that the final snapshot or domain artifact is sealed.
15. **`G15 terminal_commit`** — `CompletionCommitted` and the terminal CAS commit in **one Kernel transaction** and bind **immutable references**: receipt digest, snapshot ID, expected final digest, `workspace_generation` and `authority_epoch`. The transaction does not make snapshot creation, Host evidence or any external effect atomic with it. Guard re-verifies each referenced digest at read time; a reference that no longer verifies invalidates the completion basis and opens a post-terminal evidence hold, and never rewrites the terminal record (`KF-8`).

Any failed or missing check blocks completion with an explicit reason code. A Guard that cannot evaluate a check must block; it must never pass by default, and it must never be reordered to hide an earlier failure.

## 7. CompletionHold and remediation

CompletionHold is a safety barrier, not a way to rewrite history.

For a non-terminal Task, a conflicting authoritative late fact may open a durable `CompletionHold` record ([Lifecycle §4](../architecture/lifecycle.md)) and block TaskCompleted and new side effects. Evidence review has three outcomes:

- **EvidenceValidated** — resolve the hold, return a non-terminal task to Verifying, and rerun the necessary Completion Guard checks.
- **DefectConfirmed** — preserve the original evidence and create a separately authorized RemediationTask with a new task ID, workspace ID/generation, plan revision, budget, principal/capabilities/approvals, attempts, receipts, and verification report.
- **EvidenceInconclusive** — keep the hold active; allow read-only evidence collection and human review only.

For a Task already Completed / Failed / Cancelled, the terminal status is immutable. A late conflict creates an independent `CompletionHold` with `hold_kind=PostTerminalEvidenceHold` ([Data model §3.17](kernel-data-model.md)); it does not reopen the Task. Remediation, if authorized, is a separate Task and never overwrites the original receipt, snapshot, attempt, or report.

Hold ownership, review deadline, escalation, and resolution authority must be explicit. A timeout must not silently clear a safety hold.

## 8. Non-claims

A report does not prove correctness outside its bound workspace, plan, environment, test set, and time. The presence of a test file does not prove it passed. A green test suite does not prove sandbox isolation, receipt authenticity, or absence of untested defects. A fresh verifier pass reduces self-report dependence but does not guarantee correctness beyond its evidence. The `KF` floor and evidence classes are **obligations and vocabulary**, not a claim that any listed class is currently enforceable, tamper-evident or independently witnessed; each becomes a claim only through its own recorded evidence.

Completion Guard, verifier quality, hash-scope interoperability, process convergence, evidence-class enforceability, shadow-audit sensitivity measurement and remediation lifecycle are **UNVERIFIED / NOT RUN** until tested.
