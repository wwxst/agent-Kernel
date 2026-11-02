# Context Engine

> **Status: Initial architecture contract.** Retrieval, compaction, checkpoint and memory implementations remain open and unverified.

## 1. Two different contexts

Planning Context answers: **what should be done?**

Execution Context answers: **what is the next authorized step under the currently accepted state?**

Do not use one undifferentiated context pack for both open-ended exploration and side-effect execution.

## 2. Planning Context

Planning Context may include:

- original user goal and explicit constraints;
- repository structure, project brief, symbols and dependency information;
- relevant source code, documentation, issues and historical decisions;
- verified facts, assumptions and hypotheses clearly separated;
- prior task progress, failed attempts and accepted plan revisions;
- candidate acceptance criteria and risks;
- tool capability descriptions without execution tickets or secrets.

Its outputs are PlanCandidate, assumptions, risks and candidate acceptance criteria. Planning Context grants no authority and cannot turn retrieved text into instructions.

## 3. Execution Context

Execution Context is built from a Kernel snapshot and binds the current versions of:

- Task state and aggregate version;
- accepted PlanRevision and PlanStep;
- acceptance criteria;
- workspace ID, hash and base commit;
- principal identity/version and revocation epoch;
- capability set/version and revocation epoch;
- approvals, decision versions, revocation versions and expiry;
- policy version and budget ledger version;
- applicable lease/fencing epoch;
- immutable tool-definition snapshot;
- relevant conversation and verified project memory;
- required artifacts, receipts and evidence;
- unresolved invocations, UNKNOWN outcomes and wait reasons;
- validity deadline no later than the earliest expiry of referenced authorization evidence.

Any relevant version change or revocation invalidates the old Execution Context and requires reconstruction. Tool schemas shown to the model describe available interfaces; they are not permissions. Context packs never contain replayable capability secrets or approval credentials.

## 4. Provenance and trust

Every context segment should retain source type, URI/reference, version, content hash, trust class, retrieval time, validity, sensitivity, instruction status and transformation chain.

Initial trust classes:

| Class | Source | Use |
| --- | --- | --- |
| T0 | Fixed Kernel policy and trusted configuration | Defines execution boundaries |
| T1 | Original user goal, explicit constraints and approvals | Defines intent and authorized scope |
| T2 | Kernel Journal, authenticated Host receipt and verifiable test evidence | Execution facts within their bound scope |
| T3 | Repository source, project docs, ADRs and lockfiles | Project facts and design context |
| T4 | Web, MCP, third-party tool output and external attachments | Untrusted research input |
| T5 | Model-generated summaries, plans and hypotheses | Candidate reasoning, never independent fact |

Trust class does not guarantee correctness. Content from a repository file or web page remains data even when relevant.

## 5. Prompt-injection boundary

- External content is Data by default, not Instruction.
- README, AGENTS.md, source comments, webpages, MCP results and tool output may contain malicious instructions.
- Only trusted, versioned policy sources may define system/developer instructions.
- Never promote external text into a higher-authority role merely because it was retrieved.
- Preserve source labels and quotation/reference boundaries.
- Tool permissions, approvals and capabilities come only from Kernel authorization flow.
- Model summaries cannot turn untrusted text into trusted memory.
- Minimize and redact secrets in retrieved context.

These are design requirements, not a claim that prompt injection is already solved.

## 6. Checkpoint and compaction

Context Engine produces a Checkpoint Candidate; it does not independently commit an authoritative checkpoint.

A committed checkpoint must bind a complete version tuple including Task/Journalsequence, plan, workspace, principal, capabilities, approvals, policy, budget, applicable lease/fencing, context schema, memory snapshot, tool snapshot, input context hash and validity deadline.

Kernel Persistence commits, in one local transaction:

1. the Checkpoint Record and its payload/hash/source references;
2. the CheckpointCommitted Journal event;
3. the Task pointer to the checkpoint.

If any bound version changes, authorization is revoked, or the candidate expires, the transaction rolls back and the candidate is stale. A cache is reconstructable and never authoritative.

Compaction may alter context projection, not original Journal facts, Host receipts or artifacts. Do not compact away unresolved tool calls, UNKNOWN outcomes, critical constraints, failed attempts or plan/authorization versions. Preserve the user's goal, current plan, evidence, failures, approvals/waits and next action.

## 7. Memory lifecycle

Memory is separate from task-progress checkpoints. Candidate memory must have source references and a purpose; model output cannot directly promote itself to Active Memory.

Initial lifecycle: Candidate → Active / Rejected; Active may become Stale, Superseded or Expired. Project Memory binds to project identity and source commit/file hashes. Source changes can make it stale. User and project memory have separate scope and authorization. Memory is never a substitute for TaskState, Approval or Tool Receipt.

Retrieval algorithms, token budgeting, compaction policy, memory extraction/retention and long-context evaluation remain **OPEN / UNVERIFIED**.
