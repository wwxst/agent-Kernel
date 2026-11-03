# Context Engine

> **Status: ACCEPTED for construction (ARB-01, 2026-11-03); measurement design only; all targets are UNMEASURED and all runs NOT RUN.**
>
> Context infrastructure is shared; domain semantic projections remain independent. This document owns context assembly, the `ContextManifest` measurement fields and the context TARGET envelope. **Per-domain strategy values are owned by [Execution Strategy](../contracts/execution-strategy.md) (DES); record identity and digests by [Kernel data model](../contracts/kernel-data-model.md).** Where a value disagrees, DES wins for policy values and this document wins for manifest fields. Retrieval, indexing, evidence projection, compaction, checkpoint and memory *algorithms* remain OPEN; the ceilings in §11 are design targets to build against, not results.

## 1. Context is a projection, not authority

Context Engine builds the information Orchestration needs to make a decision. It must preserve provenance, trust, version, and freshness. It cannot authorize execution, mutate Kernel state, or rewrite execution facts.

Two primary contexts remain distinct:

- **Planning Context:** what is the goal, what is known about the task's domain (RepositoryModel or MediaProjectModel), and what should be done?
- **Execution Context:** what is the next authorized operation under the current accepted plan and authoritative state?

A third useful projection is the **Verification Context**, which assembles the accepted criteria, relevant changes, environment, and raw verification evidence for the assurance pass.

## 2. Domain models and EvidenceGraph

Context Engine hosts separate domain projections over common provenance and freshness infrastructure. RepositoryModel and MediaProjectModel are peers; neither is a universal semantic model.

### RepositoryModel

RepositoryModel may include:

- repository identity, base commit, branch, working-tree status, and workspace generation;
- directory/package structure, language, frameworks, entry points, and build system;
- manifests, lockfiles, dependency relationships, and runtime/compiler versions;
- symbols, imports, callers, public interfaces, configuration, migrations, and generated artifacts;
- test suites, fixtures, test commands, and affected test ownership;
- project conventions and architecture decisions;
- known constraints, compatibility boundaries, and risk areas.

Each claim retains source references, commit/file hashes, capture time, evidence status/source quality, and invalidation conditions. Do not treat model self-reported numeric confidence as evidence. Indexes and summaries are accelerators; source files and trusted observations remain the evidence.

### MediaProjectModel

MediaProjectModel is the Video Editing domain's sibling projection to RepositoryModel. It is not a universal replacement for RepositoryModel and is not an authority ledger.

It may include:

- immutable MediaAsset IDs, original source references, content digests, ingest status, and derived-proxy lineage;
- container and stream metadata, durations, stream IDs, rational time bases, frame-rate/VFR facts, dimensions, rotation, color metadata, audio sample rate, and channel layout;
- shot/scene boundaries, representative-frame references, transcript segments, audio events, and domain content observations;
- exact source asset/stream/time ranges, analysis tool/model version, capture time, evidence quality, and invalidation conditions for every derived claim;
- timeline and render artifact references, with explicit lineage to the source assets and analysis evidence.

MediaProjectModel is built and interpreted by Video Domain Intelligence. Context Engine supplies common retrieval, provenance, freshness, checkpoint, and compaction facilities. A shot detector output is evidence of a detector boundary, not proof of semantic scene meaning; a transcript is not proof of visual content. Unknown observations remain UNKNOWN.

A Task loads RepositoryModel or MediaProjectModel according to its immutable DomainBinding/Workflow Profile. The two models may share generic EvidenceGraph envelopes but do not share semantic schemas.

### Minimal evidence refs and optional EvidenceGraph index (PROPOSED subtraction)

The **authoritative evidence** is raw immutable source/ArtifactRef, trusted Host receipt, verifier or authorized human disposition. A graph database or a separate mutable `EvidenceGraph` aggregate is **not required** to support Coding/Video.

The minimum cross-domain envelope is:

| Record | Required fields | Status |
| --- | --- | --- |
| `EvidenceRef` | immutable ID, source kind/ref, content digest, domain/task scope, source/capture version, environment or project snapshot, trust/evidence class | **Required** for evidence that may satisfy a criterion |
| `CriterionEvidenceBinding` | Goal criterion ID/version, evidenceRefs, required independence class, verifier/human disposition and **freshness basis** (the exact versions/artifact digests it depends on) | **Required** for Completion Guard |
| `ClaimAnnotation` | optional domain proposition, kind (observed fact/hypothesis/assumption/decision/unknown/contradiction), source refs, confidence caveat | **Optional Domain projection** |
| `EvidenceLink` | optional supports/refutes/derived-from relation between claim or evidence refs | **Optional derived index** |

A factual claim still needs source evidence and scope; model confidence is never proof. Domain hypotheses/decisions can remain in RepositoryModel or MediaProjectModel without an independently committed Claim/Relation/Freshness/Provenance lifecycle. **Freshness is computed** from exact source/criterion/plan/workspace/project/version bindings and authoritative invalidation events; it is not a separately written global freshness ledger. An EvidenceGraph may be materialized for retrieval/reasoning, but it is disposable and rebuildable, never a second completion authority.

Coding may keep file/symbol/commit evidence and test logs; Video may keep sampled-frame intervals, source timebase, transcript, Timeline and render lineage. These domain details stay typed and distinct. In both domains, Completion Guard checks the criterion's required evidence class, provenance and current bindings rather than arbitrary graph connectivity. See [Architecture subtraction review](../decisions/architecture-subtraction-review.md).

## 3. Planning Context — lazy purpose view

Planning Context may include:

- original user goal and GoalContract version;
- explicit constraints, exclusions, and acceptance criteria;
- domain structure and evidence: repository/project structure and source for Coding, or media assets, streams, shot/scene/audio/transcript observations and source timestamps for Video;
- project conventions and architecture decisions with bounded authority;
- verified facts, assumptions, hypotheses, contradictions, and unknowns;
- prior task progress, failed attempts, accepted PlanRevisions, and criterion coverage;
- candidate PlanSteps, dependencies, risks, and verification obligations;
- tool capability descriptions without execution tickets, approval credentials, or secrets.

Its outputs may be GoalContract candidates, RepositoryModel updates, optional evidence-index projections (mandatory EvidenceRefs/criterion links are source-bound), PlanCandidates, assumptions, risks and acceptance-criterion candidates. Planning Context grants no authority and cannot turn retrieved text into instructions.

## 4. Execution Context — lazy purpose view

Execution Context is built from a Kernel snapshot and binds the current versions of:

- TaskControl state/version **only if relevant**, plus selected ModelStep/Invocation and the protected read-set versions required for the decision;
- accepted GoalContract and PlanRevision;
- current PlanStep and its dependencies, preconditions, and expected artifacts;
- acceptance-criteria version and evidence obligations;
- workspace ID, generation, hash, and base commit;
- principal identity/version and revocation epoch;
- capability set/version and revocation epoch;
- approvals, decision versions, revocation versions, and expiry;
- policy version and budget ledger version;
- applicable lease/fencing epoch;
- immutable tool-definition snapshot and effect/conflict metadata;
- relevant domain facts and verified project memory;
- unresolved invocations, UNKNOWN outcomes, receipts, and wait reasons;
- validity deadline no later than the earliest expiry of referenced authorization evidence.

Only changes to **relevant protected bindings and preconditions** invalidate the affected context fragment/action. A non-conflicting Host receipt, unrelated Journal append or another step's budget settlement does **not** invalidate all task context. Context may be lazily refreshed by purpose; Kernel independently rechecks live admission/Host authority. Tool schemas shown to the model describe interfaces; they are not permissions. Context packs never contain replayable capability secrets or approval credentials.

## 5. Verification Context — lazy purpose view

Verification Context is narrower and more evidence-focused than implementation context. It should include:

- accepted GoalContract and PlanRevision;
- acceptance criteria and required evidence for each criterion;
- changed-file list and diff digest;
- pre-test workspace and environment identity;
- exact commands and toolchain versions required by the verification plan;
- raw Host run IDs, receipts, exit status, output digests, and test reports;
- known test gaps, skips, flakes, and unresolved contradictions;
- final snapshot and hash-scope references when available.

The verifier should not rely solely on the implementer's narrative. It should inspect the criterion-to-evidence mapping and the actual verification records.

## 6. Provenance and trust

Every context segment should retain source type, URI/reference, version, content hash, trust class, retrieval time, validity, sensitivity, instruction status, and transformation chain.

Initial trust classes:

| Class | Source | Use |
| --- | --- | --- |
| T0 | Fixed Kernel policy and trusted configuration | Defines execution boundaries |
| T1 | Original user goal, explicit constraints, and approvals | Defines intent and authorized scope |
| T2 | Kernel Journal, authenticated Host receipt, and verifiable test evidence | Execution facts within their bound scope |
| T3 | Repository source, project docs, AGENTS.md/CLAUDE.md, ADRs, and lockfiles | Project facts and bounded project conventions |
| T4 | Web, MCP, third-party tool output, and external attachments | Untrusted research input |
| T5 | Model-generated summaries, plans, and hypotheses | Candidate reasoning, never independent fact |

Trust class does not guarantee correctness. Repository instruction files may define project workflow conventions when the user has authorized work in that repository, but they cannot grant Kernel permissions or override user/system/security policy. Content from a repository file or webpage remains data even when relevant.

## 7. Prompt-injection boundary

- External content is Data by default, not Instruction.
- README, AGENTS.md, CLAUDE.md, source comments, webpages, MCP results, and tool output may contain malicious instructions.
- Only trusted, versioned policy sources define system/developer instructions.
- Project conventions may constrain implementation within the authorized task but may not expand scope or grant permissions.
- Never promote external text into a higher-authority role merely because it was retrieved.
- Preserve source labels and quotation/reference boundaries.
- Tool permissions, approvals, and capabilities come only from Kernel authorization flow.
- Model summaries cannot turn untrusted text into trusted memory.
- Minimize and redact secrets in retrieved context.

These are design requirements, not a claim that prompt injection is already solved.

## 8. Context assembly and freshness

**REQUIRED (normative; §11 defines the envelope and instrumentation):** assemble context by decision purpose rather than replaying the entire repository or conversation on every ModelStep.

Priority order:

1. fixed policy and task invariants;
2. GoalContract and acceptance criteria;
3. accepted PlanRevision and current PlanStep;
4. latest relevant evidence and unresolved contradictions;
5. source files, symbols, tests, and environment facts relevant to the next action;
6. prior decisions, failed hypotheses, and compacted history references.

Large files and command output should be sliced, summarized with provenance, or retained as retrievable artifacts. A summary must link back to the original source and must not be the only copy of a critical fact.

Invalidate or refresh context when the base commit, file hash, workspace generation, dependency lock, environment digest, tool snapshot, plan, policy, approval, or budget version changes. Index freshness must be explicit; stale symbol maps cannot be treated as current facts.

Token budgeting *values* are now fixed as **TARGET ceilings** in §11 — design targets, UNMEASURED. Retrieval *ranking* algorithms remain **OPEN** and must be evaluated on task success and evidence recall, not only prompt size. A ceiling is an upper bound to design against; it is never evidence that the budget was met or that context was sufficient.

## 9. Checkpoint integrity, recovery, and compaction

Context Engine is **one on-demand assembler** that builds Planning, Execution and Verification *views*, not three independent stores/services or lifecycle authorities. Build only the relevant subset at each model decision, preserve source references and freshness, and discard/rebuild caches safely. Project Memory is optional in the initial vertical slice and may not determine admission or completion.

A checkpoint is a milestone/compaction/recovery **optimization**, not an event created after every ActionProposal or ToolInvocation. A task-progress Checkpoint Candidate preserves work continuity. It must not be invalidated merely because a time-varying authorization (such as an approval, lease, capability grant, policy version, or budget reservation) has expired or changed.

**Checkpoint integrity binding**

A checkpoint binds the historical task-progress snapshot:

- Task ID, the last known **taskControlVersion** and Kernel Journal high-water sequence (historical cursor, not a new global CAS prerequisite);
- accepted GoalContract version/digest;
- active and pending PlanRevision IDs and plan-switch phase;
- PlanStep WorkStatus/VerificationStatus and their evidence references;
- workspace ID, generation, base commit, and snapshot/hash references;
- domain-model/EvidenceGraph projection IDs, source references, and freshness state;
- unresolved ModelSteps/Attempts/ToolInvocations, receipts, UNKNOWN outcomes, and wait reasons;
- context schema/version, checkpoint payload digest, and source-reference manifest.

These fields establish historical progress and checkpoint integrity. Kernel Persistence commits the immutable Checkpoint Record/Journal cursor and optional pointer in one K-local transaction using a **checkpoint pointer-specific** version; it does not CAS or increment TaskControlVersion merely for a checkpoint. Source Journal/Host receipts still prevail on recovery.

**Authorization snapshot is audit metadata, not checkpoint validity**

The checkpoint may retain references to the principal, capability, approval, policy, budget, lease, and fencing evidence that governed prior actions. Those references explain historical authorization; they are not a requirement that the same authorization remain current for the checkpoint to be read or restored as historical progress. A revoked or expired approval does not erase completed work.

Do not use current authorization versions as checkpoint-integrity preconditions. Budget state is reloaded from the authoritative ledger; it is not restored from a stale checkpoint copy.

**Recovery protocol**

1. Load and integrity-check the checkpoint and its historical references.
2. Reconstruct the latest Task aggregate and Journal after the checkpoint sequence; do not roll the Task back to the checkpoint's old authorization snapshot.
3. Reconcile Host Ledger, receipts, in-flight invocations, UNKNOWN outcomes, and current workspace generation.
4. Compare current workspace state with checkpoint-bound generation/snapshot. If it diverged, refresh affected domain projections/evidence indexes and derive Stale for the **relevant** criterion/evidence bindings; do not globally stale unrelated facts or discard the checkpoint.
5. Re-establish current principal identity, capability grants, policy, approvals, budget reservations, lease/fencing epoch, and tool-definition snapshot.
6. Build a new Execution Context. Any expired/revoked approval must be renewed; an expired lease must be reacquired with a new fencing epoch.
7. Resume only after Kernel confirms current admission conditions. If unresolved UNKNOWN can conflict with writes, remain in Reconciling/Blocked.

Separate two concepts: **checkpoint integrity/readability** is about the historical snapshot; **execution resumability** is about whether current state and authorization permit new work. A checkpoint can be valid and readable while the Task is not yet safe to resume.

Compaction may alter context projection, not original Journal facts, Host receipts, source artifacts, or test outputs. Do not compact away unresolved tool calls, UNKNOWN outcomes, critical constraints, failed attempts, accepted plan versions, criterion evidence, approvals, or wait reasons. Preserve the user's goal, current plan, completed/active/blocked steps, evidence references, failures, approvals/waits, remaining verification reserve, and next decision.

## 10. Memory lifecycle

Memory is separate from task-progress checkpoints. Candidate memory must have source references, project identity, purpose, freshness, and expiry; model output cannot directly promote itself to Active Memory.

Initial lifecycle: Candidate → Active / Rejected; Active may become Stale, Superseded, or Expired. Project Memory binds to project identity and source commit/file hashes. Source changes can make it stale. User and project memory have separate scope and authorization. Memory is never a substitute for TaskState, Approval, Tool Receipt, or VerificationReport.

Retrieval algorithms, symbol indexing, evidence-graph projection, compaction policy, memory extraction/retention, and long-context evaluation remain **OPEN / UNVERIFIED**. Token budget values are fixed as TARGET ceilings in §11; whether those ceilings are achievable without evidence loss is **UNMEASURED**.

## 11. Context TARGET envelope and `ContextManifest` instrumentation

One **lazy** context assembler builds purpose-scoped views for Strategic/Tactical/Assurance; do not create three resident context stores or re-summarize the full history on every command. Untrusted repository/media/Office content is quoted as data with explicit provenance, not inserted as system instructions.

### 11.1 TARGET ceilings — design values, never results

Ceilings are supplied per Task by the bound strategy ([DES](../contracts/execution-strategy.md) `context.input_token_ceiling`, `context.retrieved_item_cap`) and enforced here **before** a model call. The values below are the reference values DES §7 cites; status is **TARGET / UNMEASURED / ratifiable only at PE**. They are upper bounds to design against: exceeding one produces a recorded truncation, never a silent overrun, and no value here is a measurement.

| Domain (DES reference strategy) | `planning` | `tactical` | `assurance` |
| --- | --- | --- | --- |
| Coding | 24k | 16k | 20k |
| Video | 20k | 12k | 16k |
| Default (any other domain) | 16k | 8k | 12k |

The Coding and Video rows are the values DES §7 cites. The default row is this document's starting point for any domain DES does not tabulate (Office, Browser, future); the owning strategy must still declare its own values and pass DES validation.

| Cap | Value (TARGET / UNMEASURED) | Enforcement |
| --- | --- | --- |
| `retrieved_item_cap` | planning 40 / tactical 20 / assurance 24 distinct sources | over-cap source is listed in `omitted_reasons[]`, never silently dropped |
| `assemblies_per_step_max` | 2 (initial + one refresh after a protected read-set invalidation) | a third assembly requires a new ModelStep |
| `assembly_deadline_ms` | 3000 / 1500 / 3000 (throwaway defaults) | expiry yields a partial manifest with `was_truncated=true`, never a blocking wait |

**Rules.** A strategy may lower any ceiling, never raise it above the profile envelope. A ceiling governs *retrieval*, never an evidence obligation: a criterion-critical source that does not fit is listed in `omitted_reasons[]` and the affected criterion is `Unverified`, never `Pass`. Ceilings are tokenizer-specific; the tokenizer identity is part of the manifest.

### 11.2 `ContextManifest` — required measurement fields

Every assembly is exactly one `kind=context` span in the run trace. `ContextManifest` is a Context Engine projection record, not a Kernel authority record: Kernel binds only its digest (`ModelStep.binding.context_manifest_digest`, [Kernel data model](../contracts/kernel-data-model.md#36-modelstep-modelattempt-candidate)). The field names below are normative for that projection; if the data model later registers `ContextManifest` as a Kernel record, the data model wins for shape and this list becomes the measurement requirement that shape must satisfy.

| Field | Definition |
| --- | --- |
| `assembly_id`, `span_id`, `model_step_id` | Join keys; `span_id` joins the assembly to the run's span records |
| `purpose`, digests | purpose plus goal/plan/profile/strategy/redaction-policy/tokenizer/assembly-policy digests |
| `input_tokens_by_source_class` | Measured tokens per class: policy, goal/criteria, plan/step, source-file/symbol, diff, tool-output, summary, conversation-history, `domain_evidence_refs`, media-reference. Their sum is `input_tokens`; a class without tokenizer attribution is reported separately, **never as zero** |
| `output_budget`, `output_tokens` | Reserved versus used output capacity |
| `assembly_ms` | Request-to-manifest latency, attributed to the context span, never to a model call |
| `cache` | `{lookup, hit, miss_by_class[], hit_by_class[], stale_cache_errors}` |
| `items[]` | `{source_kind, source_ref, digest, token_estimate, was_truncated, cursor, cache_state}` |
| `omitted_reasons[]` | `{source_ref, reason: ceiling\|item_cap\|deadline\|access_denied\|not_found\|stale, criterion_ids[]}` |
| `evidence_omission_rate` | See below |

`evidence_omission_rate = |criterion-critical sources absent from this manifest| / |criterion-critical sources required by the accepted criteria|`, computed against the authoritative index and the harness oracle — never against the model's own summary and never self-reported. The assembler records the numerator it can observe; the **gate value** is recomputed post hoc ([Shared evaluation §9](../research/shared-kernel/evaluation.md)).

`stale_cache_errors` counts cache hits whose entry would fail the invalidation predicate when re-checked against the authoritative source at hit time. A hit is valid only after that re-check; a mismatch is a forced miss plus one recorded error.

### 11.3 Cache key and invalidation predicate

`cache_key = digest(canonical_source_bytes) ⊕ tool_or_parser_id+version ⊕ scope_id ⊕ privacy_or_access_class+revocation_epoch ⊕ transform_parameters_digest`. A path, filename, summary text, capture time or model-chosen label is **never** part of the key (DES floor F9). Invalidate a dependent entry iff any key component changed, its `ttl_class` expired, or a `ScopedReadGrant` was revoked; unrelated entries stay reusable. A source change invalidates dependents through declared read-sets — never a global flush, and never a rebuild of unrelated projections. Cross-domain bytes require a new scoped grant before a key can even be constructed; a cache never serves bytes that were accessible only under a now-revoked grant.

**Incremental selection:** begin with accepted goal/constraints, current PlanStep, unresolved UNKNOWN/approvals, latest relevant receipts and evidence gaps; then retrieve the smallest authorized file ranges/symbols, changed diffs, shot ranges/transcript spans or Office sections. Prefer structural discovery (`rg`/symbol index, ffprobe/shot manifest, range index) to dumping entire repositories or all source frames.

**Budget pressure:** reserve output plus required verification/repair Tokens before admitting exploratory model work ([Model and Budget](../contracts/model-and-budget.md)). Apply the §11.1 ceilings and output trimming with `was_truncated` and source cursor; an observation that could be incomplete must not become positive verification evidence. Deduplicate exact repeated tool outputs by digest+cursor and expand only on semantic uncertainty or failed acceptance. Keep a small stable prefix only when provider caching semantics/fees have been checked. Cache accounting includes writes/reads, transformed input and extra modalities.

**Ablations:** compare eager full-history and staged fixed-mode baselines against this approach with matched accepted criteria, budgets, tools, model and Host. Record context Tokens by source class, retrieval precision/coverage, stale-cache errors, cache hit/miss, summarization calls, omitted evidence defects, task success/false completion and P50/P95; reductions in Tokens alone cannot pass if quality or safety degrades. Metric definitions, the percentile method, the cost gate and the shadow audit are owned by [Shared evaluation §9](../research/shared-kernel/evaluation.md). No Token or latency saving is claimed before **PE** evidence.
