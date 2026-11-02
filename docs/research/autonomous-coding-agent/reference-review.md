# Autonomous Coding Agent — Reference Implementation Review

> **Status: PROPOSED research report.** This is a source-grounded mechanism review, not a benchmark ranking. Source snapshots and official documentation were inspected on 2026-11-02. No runtime experiment was executed as part of this review.

## 1. Research method

The goal is to understand which mechanisms help an agent complete complex coding work, and which problems remain unsolved by a tool loop alone.

For each reference, distinguish:

- **FACT** — directly visible in the pinned source or official documentation;
- **INTERPRETATION** — what engineering problem the mechanism appears to solve;
- **LIMITATION** — what the inspected evidence does not establish;
- **APPLICABILITY** — whether the mechanism should be adopted, adapted, or rejected.

A source path and commit are included where source is available. Rolling documentation is dated rather than treated as a stable source snapshot.

## 2. Snapshot register

| Reference | Inspected snapshot | Primary anchors | Evidence type |
| --- | --- | --- | --- |
| Pi Agent Core / coding-agent | earendil-works/pi, tag v0.82.1, commit b4f293684bba718d59cc1157679bcf6157b3a7f5 | packages/agent/src/agent-loop.ts, agent.ts, types.ts; packages/coding-agent/src/core/agent-session.ts | Source |
| OpenAI Codex | openai/codex, main at commit a09812981de703f18f38015cd5d500ab373f616c | codex-rs/core/src/session/turn.rs, codex-rs/core/src/tools/router.rs, app-server protocol and thread store | Source + official engineering posts |
| DeepSeek Harness | deepseek-ai/deepseek-harness, master at commit ce7073d51254c26cd63b22a60835b8f948deb447 | docs/architecture.md, docs/agent-lifecycle.md, packages/core/agent-loop/src/agent.ts, packages/core/tools/src/batch.ts, packages/core/session/src/types.ts | Source + project documentation |
| Claude Code / Agent SDK | Official Agent SDK documentation as accessed 2026-11-02 | Agent loop, sessions, permissions, hooks, file checkpointing, tool execution | Official documentation only |

Pi's former repository location redirects to the earendil-works/pi repository. The pinned tag is used so line-level claims do not depend on a moving branch.

Claude Code's implementation is distributed as a native binary and is not available for a source-level audit. Its documentation describes supported behavior and SDK contracts; it does not authorize claims about undocumented internal algorithms.

## 3. Pi Agent Core

### Observed facts

- The low-level loop is provider-agnostic and works with AgentMessage until the model-call boundary, where context is transformed and converted to provider-compatible messages.
- runLoop() has an inner loop for tool calls and steering messages and an outer loop for follow-up messages. See agent-loop.ts around lines 155–275.
- Tool calls can execute sequentially or in parallel. The parallel path prepares calls before concurrent execution and projects results in assistant source order; see agent-loop.ts around lines 411–554.
- A response stopped for output length does not execute its possibly truncated tool-call arguments; it produces failure results instead. See agent-loop.ts around lines 210–214 and the truncated-call handling.
- The stateful Agent wrapper owns transcript state, subscriptions, abort behavior, steering and follow-up queues. The loop exposes explicit lifecycle events.
- The higher-level coding-agent session layer handles session persistence, branching, compaction, tool setup, extension integration, and session lifecycle. See packages/coding-agent/src/core/agent-session.ts.

### Interpretation

Pi demonstrates that a relatively small event-driven loop can support useful coding behavior when paired with a stateful session layer. Steering and follow-up are distinct control concepts: one redirects active work at a safe boundary; the other queues work after the current run would otherwise stop. The separation between generic Agent Core and coding-agent session responsibilities is useful.

### Limitations

- Agent Core by itself is not a complete autonomous software-engineering controller. It does not define the GoalContract, repository evidence model, dependency-aware plan, hypothesis-driven debugging policy, or an independent acceptance gate described in this proposal.
- The loop's tool concurrency modes do not by themselves establish a Kernel-level workspace conflict model, durable side-effect ledger, hard admission boundary, or completion proof.
- The presence of session persistence and compaction in the higher-level product does not prove that all task-critical facts survive every crash or context-compaction edge case.

### Applicability

**ADAPT:** retain explicit event semantics, stateful steering/follow-up, complete-response validation, safe handling of truncated tool calls, and deterministic model-visible result ordering.

**DO NOT COPY WHOLESALE:** do not treat the ReAct loop as the complete Coding Agent architecture or assume its execution policy supplies Kernel authority.

## 4. OpenAI Codex

### Observed facts

- The Codex harness is shared across multiple user surfaces. The App Server exposes it through a bidirectional JSON-RPC protocol; one client request may produce many progress events, and the server can request approval or other input while a turn is paused.
- The public conversation model distinguishes Thread, Turn, and Item. Items have explicit started/delta/completed lifecycles. See OpenAI's 2026-02-04 App Server engineering post.
- Codex core owns session/turn execution, tool routing, persistence, and context management. The current inspected turn.rs defines run_turn() near line 177 and uses an ordered in-flight tool future collection; the source imports and constructs ToolCallRuntime.
- The official loop explanation describes repeated model inference and tool execution, with context-window management as an agent responsibility. It also distinguishes the software changes in the workspace from the assistant message that ends a turn.
- Codex's execution path combines tool routing with sandbox and approval policy; its App Server makes lifecycle and approval events visible to clients.

### Interpretation

Codex demonstrates the value of a durable session spine and a stable event protocol when a coding agent is embedded in multiple clients. Thread/Turn/Item is a useful user-facing lifecycle model. The separation between core execution, protocol, tool routing, persistence, and client surfaces helps avoid reimplementing the agent loop for each UI.

### Limitations

- A turn ending with an assistant message is a harness lifecycle event, not proof that every user acceptance criterion passed.
- Codex's internal architecture and sandbox are product-specific. The existence of sandboxing and approvals does not establish the separate Kernel Journal / Host Ledger reconciliation contract required here.
- Public engineering posts explain selected mechanisms, not every correctness, crash-recovery, or security property. Source inspection is not a substitute for controlled fault-injection tests.

### Applicability

**ADAPT:** use explicit Thread/Turn/Step/Item semantics, durable event history, bidirectional approval/input handling, stable client events, and a clear boundary between UI protocol and core orchestration.

**EXTEND:** bind plans, criteria, workspace generations, test evidence, and final snapshots to Kernel state. Do not equate a terminal turn with a completed software task.

## 5. DeepSeek Harness

### Observed facts

- Its architecture is based on Cordis plugin composition. The model adapter, session log, tool registry, and agent loop are all replaceable plugins.
- The architecture documentation distinguishes durable Session events from live Agent events and capability events.
- The documented turn flow separates a model step from a turn and uses explicit pre-step, request preparation, streaming, tool execution, and step-end boundaries.
- The session package documents an append-only event log from which model history is derived. Persistence is layered through a persistence plugin.
- The tool package provides schema validation, guarded execution, per-agent restrictions, output normalization, and scoped executor selection.
- packages/core/tools/src/batch.ts implements bounded scheduling by execution mode, commits model-ordered outcomes, and drains already-started calls on abort or scheduler failure.
- The repository README explicitly describes the project as a developer preview and warns that compatibility-breaking changes will occur.

### Interpretation

DeepSeek Harness offers detailed examples of lifecycle ownership and event semantics. In particular, separating durable replay facts from transient control events is useful. Its scoped capability model, tool-batch scheduler, and explicit teardown behavior show that concurrency and cancellation need more than a global parallel flag.

### Limitations

- The plugin architecture is tightly coupled to Cordis and should not be mistaken for a requirement to use the same composition framework.
- The project is explicitly a rapidly changing developer preview. Its current design and tests are evidence about one evolving implementation, not a stable standard.
- Its rich package structure should not be translated into a package list before the Coding Agent's cognitive contracts are settled.
- The existence of a durable session log does not by itself prove Kernel-style authorization, separate Host evidence, or acceptance-gated task completion.

### Applicability

**ADAPT:** durable-versus-live event separation, explicit agent ownership and teardown, scoped capability resolution, step-level tool snapshots, bounded conflict-aware scheduling, and session-derived model history.

**DO NOT COPY WHOLESALE:** do not adopt Cordis or its package topology as an implicit technology decision.

## 6. Claude Code / Claude Agent SDK

### Observed facts from official documentation

- The Agent SDK provides the same tools, agent loop, and context management that power Claude Code, and runs the Claude Code binary in a process controlled by the SDK consumer.
- The documented loop repeats model evaluation and tool execution until the response contains no more tool calls. It emits typed lifecycle messages and a ResultMessage containing final result, usage, cost, and session ID.
- The SDK exposes built-in tools, hooks, permission modes, sessions, MCP, skills, plugins, subagents, file checkpointing, and observability.
- The documented scheduler permits read-only operations to run concurrently and runs state-changing operations sequentially by default.
- Context accumulates across turns. Automatic compaction summarizes older history, and the docs explicitly warn that specific early instructions may not survive. A PreCompact hook can archive context before compaction.
- Sessions can be resumed or forked; a session-store adapter can mirror transcripts for recovery across stateless hosts.
- The documented turn and budget caps stop a loop with explicit result subtypes. The docs note that the response that reaches a spend cap may still complete and push total spend above the cap by that response's cost.

### Interpretation

Claude Code's public interface is a useful integrated example of tools, permissions, hooks, sessions, context compaction, and user control. The documentation also makes a valuable distinction between the loop's final result and the wider session lifecycle.

### Limitations

- The native binary is not source-auditable. Internal planning, debugging, and verification algorithms must not be inferred beyond what the docs state.
- The documented loop's no-more-tool-calls condition is not equivalent to Kernel Completion Guard's acceptance-evidence condition.
- A post-response spend cap is not the same as a pre-admission hard reservation ledger.
- File checkpointing and transcript persistence do not prove that external side effects are reversible or that a workspace is safely frozen.

### Applicability

**ADAPT:** explicit permissions, lifecycle hooks, session resume/fork, compaction boundary events, checkpoint awareness, and typed result status.

**DO NOT COPY:** do not treat a product's internal binary as a transparent reference implementation, and do not assume model-classified permission is a replacement for deterministic Kernel admission.

## 7. Cross-reference synthesis

| Design problem | Useful evidence | Kernel proposal |
| --- | --- | --- |
| Agent loop and event semantics | Pi, Codex, DeepSeek, Claude SDK | Keep a clear tactical loop with typed lifecycle events; separate loop exit from Task completion |
| Long-running state | Codex thread history, DeepSeek Session log, Pi session manager, Claude sessions | Kernel Journal is authoritative; context and transcript are projections with explicit recovery contracts |
| Steering and user control | Pi queues, Codex bidirectional App Server, Claude streaming input/hooks | Support explicit steer, follow-up, ask, approval, cancel, and wait boundaries |
| Tool concurrency | Pi execution modes, Codex in-flight scheduling, DeepSeek bounded batch, Claude read-only/write policy | Classify by effects and conflicts; serialize unknown conflicts; use Host evidence |
| Context compaction | Pi coding-agent compaction, Codex context management, DeepSeek compaction, Claude automatic compaction | Preserve task intent, accepted plan, criterion coverage, evidence, failed hypotheses, and UNKNOWN state |
| Permission and side effects | Codex sandbox/approval, DeepSeek tool guards, Claude permission modes | Kernel remains final admission authority; Host revalidates at execution |
| Goal-level planning | Partial support across products; no single source establishes the complete contract proposed here | Add GoalContract, RepositoryModel, EvidenceGraph, PlanRevision, and PlanStep |
| Debugging quality | Tool feedback loops in all references; limited public proof of hypothesis quality | Add a hypothesis-driven experiment protocol and no-progress guard |
| Completion quality | Most public loop descriptions use final model response or no more tool calls | Require criterion-linked test evidence and trusted workspace freeze |

## 8. Design conclusions

1. A good agent loop is a necessary execution primitive, not the architecture of an autonomous Coding Agent.
2. A durable task model must preserve intent, accepted plans, evidence, tool outcomes, and recovery state—not only a conversation transcript.
3. Tool scheduling must be based on side effects and conflict scope. Parallelism is an execution policy, not an autonomy strategy.
4. Context compaction must preserve evidence and task invariants, not merely produce a plausible summary.
5. Permissions must be enforced outside model reasoning and rechecked at the side-effect boundary.
6. A task is complete only when its acceptance criteria are proven against the current workspace and environment.
7. The strongest transferable patterns should be adapted to the existing Kernel authority boundaries rather than copied as a product framework.

## 9. Sources

### Pinned source repositories

- Pi tag: https://github.com/earendil-works/pi/tree/v0.82.1
- Pi Agent loop: https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/agent/src/agent-loop.ts
- Pi Agent types: https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/agent/src/types.ts
- Pi coding-agent session: https://github.com/earendil-works/pi/blob/b4f293684bba718d59cc1157679bcf6157b3a7f5/packages/coding-agent/src/core/agent-session.ts
- Codex source snapshot: https://github.com/openai/codex/tree/a09812981de703f18f38015cd5d500ab373f616c
- Codex turn execution: https://github.com/openai/codex/blob/a09812981de703f18f38015cd5d500ab373f616c/codex-rs/core/src/session/turn.rs
- DeepSeek Harness source snapshot: https://github.com/deepseek-ai/deepseek-harness/tree/ce7073d51254c26cd63b22a60835b8f948deb447
- DeepSeek architecture: https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/docs/architecture.md
- DeepSeek agent lifecycle: https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/docs/agent-lifecycle.md
- DeepSeek tool batch scheduler: https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/core/tools/src/batch.ts

### Official engineering and product documentation

- OpenAI, Unrolling the Codex agent loop (2026-01-23): https://openai.com/index/unrolling-the-codex-agent-loop/
- OpenAI, Unlocking the Codex harness: how we built the App Server (2026-02-04): https://openai.com/index/unlocking-the-codex-harness/
- Claude Agent SDK overview: https://code.claude.com/docs/en/agent-sdk/overview
- Claude Agent SDK loop: https://code.claude.com/docs/en/agent-sdk/agent-loop
- Claude Agent SDK sessions: https://code.claude.com/docs/en/agent-sdk/sessions
- Claude Agent SDK permissions: https://code.claude.com/docs/en/agent-sdk/permissions
- Claude Agent SDK hooks: https://code.claude.com/docs/en/agent-sdk/hooks
- Claude Agent SDK file checkpointing: https://code.claude.com/docs/en/agent-sdk/file-checkpointing

Official Claude documentation is rolling and was accessed 2026-11-02. Recheck it before making a version-specific implementation decision.
