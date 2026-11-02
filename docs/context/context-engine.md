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

Each claim retains source references, commit/file hashes, capture time, confidence, and invalidation conditions. Indexes and summaries are accelerators; source files and trusted observations remain the evidence.

### EvidenceGraph

EvidenceGraph connects claims to supporting, contradicting, and derived evidence. Claim kinds include FACT, HYPOTHESIS, ASSUMPTION, DECISION, UNKNOWN, and CONTRADICTION.

Evidence may include repository observations, source references, command output, test results, diffs, Host receipts, environment facts, external research, and user clarification.

The graph is a provenance-aware projection over Kernel Journal, Host Ledger, workspace snapshots, repository sources, and external evidence. It is not a second authoritative ledger.

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

## 9. Checkpoint and compaction

Context Engine produces a Checkpoint Candidate; it does not independently commit an authoritative checkpoint.

A task-progress checkpoint should bind a complete version tuple including Task/Journal sequence, GoalContract, PlanRevision, PlanStep progress, workspace, principal, capabilities, approvals, policy, budget, applicable lease/fencing, context schema, RepositoryModel/EvidenceGraph snapshot, tool snapshot, input context hash, and validity deadline.

Kernel Persistence commits, in one local transaction:

1. the Checkpoint Record and its payload/hash/source references;
2. the CheckpointCommitted Journal event;
3. the Task pointer to the checkpoint.

If any bound version changes, authorization is revoked, or the candidate expires, the transaction rolls back and the candidate is stale. A cache is reconstructable and never authoritative.

Compaction may alter context projection, not original Journal facts, Host receipts, source artifacts, or test outputs. Do not compact away unresolved tool calls, UNKNOWN outcomes, critical constraints, failed attempts, accepted plan versions, criterion evidence, approvals, or wait reasons.

Preserve the user's goal, current plan, completed/active/blocked steps, evidence references, failures, approvals/waits, remaining verification reserve, and next decision.

## 10. Memory lifecycle

Memory is separate from task-progress checkpoints. Candidate memory must have source references, project identity, purpose, freshness, and expiry; model output cannot directly promote itself to Active Memory.

Initial lifecycle: Candidate → Active / Rejected; Active may become Stale, Superseded, or Expired. Project Memory binds to project identity and source commit/file hashes. Source changes can make it stale. User and project memory have separate scope and authorization. Memory is never a substitute for TaskState, Approval, Tool Receipt, or VerificationReport.

Retrieval algorithms, symbol indexing, evidence-graph projection, token budgeting, compaction policy, memory extraction/retention, and long-context evaluation remain **OPEN / UNVERIFIED**.
