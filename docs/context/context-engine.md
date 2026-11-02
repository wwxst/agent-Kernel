# Context Engine

> **Status: Initial architecture contract reconciled with a PROPOSED Coding Agent context model.** Retrieval, indexing, evidence projection, compaction, checkpoint, and memory implementations remain open and unverified.

## 1. Context is a projection, not authority

Context Engine builds the information Orchestration needs to make a decision. It must preserve provenance, trust, version, and freshness. It cannot authorize execution, mutate Kernel state, or rewrite execution facts.

Two primary contexts remain distinct:

- **Planning Context:** what is the goal, what is known about the repository, and what should be done?
- **Execution Context:** what is the next authorized operation under the current accepted plan and authoritative state?

A third useful projection is the **Verification Context**, which assembles the accepted criteria, relevant changes, environment, and raw verification evidence for the assurance pass.

## 2. RepositoryModel and EvidenceGraph

The proposed intelligent execution design introduces two related projections.

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

### EvidenceGraph

The EvidenceGraph is a minimal evidence-relationship model and a Context/Orchestration projection. It is not necessarily a graph database and never replaces Kernel Journal, Host Ledger, workspace sources, or raw artifacts.

**Claim kinds**

- FACT — directly observed or verified within a declared scope;
- HYPOTHESIS — an explanation to be tested;
- ASSUMPTION — temporarily accepted for bounded progress;
- DECISION — a selected course and its recorded rationale;
- UNKNOWN — information not established;
- CONTRADICTION — a claim/evidence conflict that remains unresolved.

**Minimum records**

| Record | Required fields |
| --- | --- |
| Claim | claim ID, claim version, kind, proposition, project/task scope, validity scope, origin, currentness, and invalidation conditions |
| Evidence | evidence ID, kind, source reference, payload/content digest, captured time, source version, repository commit/workspace generation/environment where applicable, trust class, sensitivity, and transformation chain |
| Relation | relation ID, source node, target node, relation kind, basis/evidence reference, and creation time |
| Freshness | state (Current, Stale, Invalidated, Unknown), bound versions, and invalidation reason/event |
| Provenance | original source, actor/tool, transformation sequence, and links to raw evidence |

Supported relation kinds include supports, refutes, derived_from, contradicts, qualifies, duplicates, and invalidates. Relations are explicit records; they are not implied by proximity in a graph.

**Evidence and claim rules**

- A FACT requires at least one direct source/evidence reference and a declared scope. A model assertion alone cannot create a FACT.
- A HYPOTHESIS may be model-generated but remains a hypothesis until tested.
- An ASSUMPTION records who/what introduced it, why it is safe to proceed, impact if false, and when it expires.
- A DECISION records the decision-maker, rationale summary, alternatives considered, and supporting/contradicting evidence references. It does not store private chain-of-thought.
- A CONTRADICTION points to the conflicting claims/evidence; it does not overwrite either source.
- Numeric model self-confidence is not evidence and is not a substitute for provenance, source quality, or verification.

Trust and authority are separate. Trust class describes the provenance and reliability of evidence within scope; it does not grant permission. An authenticated Host receipt may be authoritative for a recorded process outcome but not for whether the code meets a product requirement. A test result is authoritative for that exact run, command, environment, and workspace—not for all behavior.

RepositoryModel claims reference EvidenceGraph records and retain file/symbol hashes and freshness. The graph may be materialized as structured records and indexes; selecting a graph database is an open implementation decision.

## 3. Planning Context

Planning Context may include:

- original user goal and GoalContract version;
- explicit constraints, exclusions, and acceptance criteria;
- repository structure, project brief, symbols, dependency information, and relevant source;
- project conventions and architecture decisions with bounded authority;
- verified facts, assumptions, hypotheses, contradictions, and unknowns;
- prior task progress, failed attempts, accepted PlanRevisions, and criterion coverage;
- candidate PlanSteps, dependencies, risks, and verification obligations;
- tool capability descriptions without execution tickets, approval credentials, or secrets.

Its outputs are GoalContract candidates, RepositoryModel updates, EvidenceGraph updates, PlanCandidate, assumptions, risks, and candidate acceptance criteria. Planning Context grants no authority and cannot turn retrieved text into instructions.

## 4. Execution Context

Execution Context is built from a Kernel snapshot and binds the current versions of:

- Task state and aggregate version;
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
- relevant repository facts and verified project memory;
- unresolved invocations, UNKNOWN outcomes, receipts, and wait reasons;
- validity deadline no later than the earliest expiry of referenced authorization evidence.

Any relevant version change, revocation, workspace mutation, tool change, or stale precondition invalidates the old Execution Context and requires reconstruction. Tool schemas shown to the model describe interfaces; they are not permissions. Context packs never contain replayable capability secrets or approval credentials.

## 5. Verification Context

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

**PROPOSED:** assemble context by decision purpose rather than replaying the entire repository or conversation on every ModelStep.

Priority order:

1. fixed policy and task invariants;
2. GoalContract and acceptance criteria;
3. accepted PlanRevision and current PlanStep;
4. latest relevant evidence and unresolved contradictions;
5. source files, symbols, tests, and environment facts relevant to the next action;
6. prior decisions, failed hypotheses, and compacted history references.

Large files and command output should be sliced, summarized with provenance, or retained as retrievable artifacts. A summary must link back to the original source and must not be the only copy of a critical fact.

Invalidate or refresh context when the base commit, file hash, workspace generation, dependency lock, environment digest, tool snapshot, plan, policy, approval, or budget version changes. Index freshness must be explicit; stale symbol maps cannot be treated as current facts.

Token budgeting and retrieval ranking remain **OPEN** and must be evaluated on task success and evidence recall, not only prompt size.

## 9. Checkpoint integrity, recovery, and compaction

A task-progress Checkpoint Candidate preserves work continuity. It must not be invalidated merely because a time-varying authorization (such as an approval, lease, capability grant, policy version, or budget reservation) has expired or changed.

**Checkpoint integrity binding**

A checkpoint binds the historical task-progress snapshot:

- Task ID, Task aggregate version, and Kernel Journal sequence;
- accepted GoalContract version/digest;
- active and pending PlanRevision IDs and plan-switch phase;
- PlanStep WorkStatus/VerificationStatus and their evidence references;
- workspace ID, generation, base commit, and snapshot/hash references;
- RepositoryModel/EvidenceGraph projection IDs, source references, and freshness state;
- unresolved ModelSteps/Attempts/ToolInvocations, receipts, UNKNOWN outcomes, and wait reasons;
- context schema/version, checkpoint payload digest, and source-reference manifest.

These fields establish what progress the checkpoint describes and whether the checkpoint payload is internally consistent. Kernel Persistence commits the Checkpoint Record, CheckpointCommitted Journal event, and Task checkpoint pointer in one Kernel-local transaction using Task/Journal compare-and-swap.

**Authorization snapshot is audit metadata, not checkpoint validity**

The checkpoint may retain references to the principal, capability, approval, policy, budget, lease, and fencing evidence that governed prior actions. Those references explain historical authorization; they are not a requirement that the same authorization remain current for the checkpoint to be read or restored as historical progress. A revoked or expired approval does not erase completed work.

Do not use current authorization versions as checkpoint-integrity preconditions. Budget state is reloaded from the authoritative ledger; it is not restored from a stale checkpoint copy.

**Recovery protocol**

1. Load and integrity-check the checkpoint and its historical references.
2. Reconstruct the latest Task aggregate and Journal after the checkpoint sequence; do not roll the Task back to the checkpoint's old authorization snapshot.
3. Reconcile Host Ledger, receipts, in-flight invocations, UNKNOWN outcomes, and current workspace generation.
4. Compare current workspace state with checkpoint-bound generation/snapshot. If it diverged, refresh RepositoryModel/EvidenceGraph and mark affected claims, artifacts, and verification evidence Stale; do not discard the checkpoint.
5. Re-establish current principal identity, capability grants, policy, approvals, budget reservations, lease/fencing epoch, and tool-definition snapshot.
6. Build a new Execution Context. Any expired/revoked approval must be renewed; an expired lease must be reacquired with a new fencing epoch.
7. Resume only after Kernel confirms current admission conditions. If unresolved UNKNOWN can conflict with writes, remain in Reconciling/Blocked.

Separate two concepts: **checkpoint integrity/readability** is about the historical snapshot; **execution resumability** is about whether current state and authorization permit new work. A checkpoint can be valid and readable while the Task is not yet safe to resume.

Compaction may alter context projection, not original Journal facts, Host receipts, source artifacts, or test outputs. Do not compact away unresolved tool calls, UNKNOWN outcomes, critical constraints, failed attempts, accepted plan versions, criterion evidence, approvals, or wait reasons. Preserve the user's goal, current plan, completed/active/blocked steps, evidence references, failures, approvals/waits, remaining verification reserve, and next decision.

## 10. Memory lifecycle

Memory is separate from task-progress checkpoints. Candidate memory must have source references, project identity, purpose, freshness, and expiry; model output cannot directly promote itself to Active Memory.

Initial lifecycle: Candidate → Active / Rejected; Active may become Stale, Superseded, or Expired. Project Memory binds to project identity and source commit/file hashes. Source changes can make it stale. User and project memory have separate scope and authorization. Memory is never a substitute for TaskState, Approval, Tool Receipt, or VerificationReport.

Retrieval algorithms, symbol indexing, evidence-graph projection, token budgeting, compaction policy, memory extraction/retention, and long-context evaluation remain **OPEN / UNVERIFIED**.
