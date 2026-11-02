# Shared Agent Kernel — Reference Implementation Review

> **Status: PROPOSED research report.** This review focuses on transferable execution-layer mechanisms for a multi-domain Agent Kernel. It is not a product ranking or a claim that any reference implementation satisfies this repository's authority, recovery, or completion contracts. Source snapshots and official documentation were inspected on 2026-11-02.

## 1. Research question and method

The question is which execution mechanisms should be shared by Coding and Video Editing, and which must remain domain-specific.

For each reference, distinguish:

- **FACT** — directly observed in source or official documentation;
- **INTERPRETATION** — the engineering problem the mechanism addresses;
- **LIMITATION** — what the source does not establish;
- **APPLICABILITY** — adopt, adapt, or reject for this Kernel.

The review prefers pinned source snapshots. Claude Code's native binary is not source-auditable; its official SDK documentation is used only for documented interfaces and behavior.

## 2. Snapshot register

| Reference | Snapshot | Primary anchors | Evidence |
| --- | --- | --- | --- |
| Pi Agent Core | earendil-works/pi, main at c9f4c7b9fcd0f3e6b5bbc35c7c9b6cda35580eb8 | packages/agent/src/agent-loop.ts; packages/agent/src/agent.ts; packages/coding-agent/src/core/agent-session.ts | Source |
| OpenAI Codex | openai/codex, main at a09812981de703f18f38015cd5d500ab373f616c | codex-rs/core/src/session/turn.rs; codex-rs/core/src/tools/router.rs; protocol sandbox policy; App Server protocol | Source + official engineering docs |
| DeepSeek Harness | deepseek-ai/deepseek-harness, master at ce7073d51254c26cd63b22a60835b8f948deb447 | docs/architecture.md; docs/agent-lifecycle.md; packages/core/tools/src/batch.ts; docs/tool-execution-pipeline.md | Source + project docs |
| Claude Agent SDK | Official docs accessed 2026-11-02 | Agent loop, permissions, hooks, sessions, checkpointing, budget and result messages | Official documentation; binary implementation not inspected |

## 3. Pi Agent Core

### Observed facts

- The generic loop works with AgentMessage and converts to provider-compatible messages at the LLM boundary.
- The loop has an inner cycle for tool calls and steering messages and an outer cycle for queued follow-up messages.
- A response stopped for output length does not execute possibly truncated tool-call arguments; it returns failure results for those calls.
- Tool calls may run sequentially or in parallel. Tool definitions can force sequential execution.
- The higher-level AgentSession is shared by interactive, print, and RPC run modes and owns event subscription/persistence, model state, compaction, bash execution, session switching, and branching.

### Interpretation

Pi shows that a provider-neutral tactical loop can be relatively small when separated from the higher-level session/product lifecycle. Steering and follow-up are distinct forms of user control. The complete-response guard is particularly relevant to any domain where a partial model output could create an invalid operation.

### Limitations

- The loop and session layer do not establish a Kernel-level hard admission ledger, separate Host Ledger, plan-switch barrier, long-running render process convergence, or criterion-level completion proof.
- Coding-agent session behavior is not a generic semantic model for media projects.
- Parallel tool calls alone do not prove safe concurrent writes or external effects.

### Applicability

**ADAPT:** provider-neutral model boundary, explicit lifecycle events, steering/follow-up semantics, safe handling of truncated tool calls, and deterministic result ordering.

**DO NOT COPY WHOLESALE:** do not treat a ReAct/tool loop or coding-agent session as the full autonomous platform.

## 4. OpenAI Codex

### Observed facts

- Codex uses a shared harness across CLI, IDE, desktop, and web surfaces. The App Server exposes it through a bidirectional JSON-RPC protocol.
- The public Thread/Turn/Item primitives provide durable session identity and explicit item started/delta/completed lifecycles.
- The App Server can initiate requests for approval or other input and pause a turn until the client responds.
- Codex core owns turn execution, tool routing, persistence, and context management. Tool routing is coupled to configured sandbox and approval policy.
- Official Codex safety guidance distinguishes the technical sandbox boundary from the approval policy that determines when the user must be asked.

### Interpretation

Codex is useful evidence for a stable execution/session protocol independent of client surface, with explicit user input, progress, artifacts, and approval events. The separation between sandbox capability and user approval is important: permission prompts do not themselves create isolation, and isolation does not itself express user intent.

### Limitations

- A completed Turn or final assistant message is not proof that a Task's acceptance criteria passed.
- Product-specific sandboxing and approval mechanisms do not establish this Kernel's Host Ledger, durable-intent, UNKNOWN reconciliation, or cross-domain resource accounting.
- Codex is a coding agent; the source does not define a Video Editing domain model or perceptual media verifier.

### Applicability

**ADAPT:** stable client-facing lifecycle events, bidirectional approval/input, long-lived session identity, multi-surface protocol separation, and explicit sandbox/approval layers.

**EXTEND:** preserve the repository's existing Task/GoalContract/PlanRevision/Completion Guard contracts and add a typed long-running media execution record.

## 5. DeepSeek Harness

### Observed facts

- Cordis composes the product from replaceable service providers, typed events, and bundles/profiles. The model adapter, session log, tool registry, and agent loop are capability seams.
- The architecture distinguishes durable Session events from live Agent control/status events and capability events.
- The session log is append-only and model history is derived from committed events.
- The tool execution pipeline separates permission/hooks/guards from tool bodies and output normalization.
- The bounded batch scheduler supports exclusive barriers and a rolling parallel pool, reclassifies unstarted calls, drains started calls on abort/failure, and projects settled results in model order.
- The project explicitly describes itself as a developer preview with compatibility-breaking changes expected.

### Interpretation

DeepSeek Harness offers the clearest current examples of explicit capability seams, durable-versus-live event separation, scoped tool composition, and concurrency/cancellation semantics. Its profile/bundle composition is relevant to the idea of Workflow Profiles.

### Limitations

- Cordis and the current package topology are implementation choices, not requirements for this Kernel.
- An everything-is-a-plugin architecture can create unnecessary indirection if copied before the common contracts are stable.
- A durable session log is not automatically a complete task authority journal or a separate physical execution ledger.
- Developer-preview behavior must be rechecked before any implementation-level adoption.

### Applicability

**ADAPT:** explicit service-definition/provider/consumer seams, immutable tool sets per step, typed durable events, scoped capabilities, bounded effect-aware scheduling, and drain-before-settlement.

**DO NOT COPY WHOLESALE:** do not adopt Cordis or a plugin-per-everything package topology as an implicit architecture decision.

## 6. Claude Agent SDK

### Observed facts from official documentation

- The SDK embeds the Claude Code agent loop in a consumer-operated process and exposes built-in tools, permissions, sessions, hooks, and typed result messages.
- The documented loop repeats model evaluation and tool execution until a response has no further tool calls, then emits a result with status, usage, cost, and session ID.
- The SDK documents permission evaluation, pre-tool hooks, user input/approval, session resume/fork, and optional external session-store adapters.
- Read-only tools can run concurrently; state-changing tools run sequentially by default.
- The documentation describes automatic compaction and explicitly notes that early instructions may not survive summarization.
- Budget caps and turn caps produce typed result subtypes. The documentation notes that the response reaching a spend cap can still complete and push total spend beyond the cap by that response's cost.

### Interpretation

Claude's public SDK is a useful integrated reference for hooks, permissions, session continuity, user input, typed lifecycle messages, and tool scheduling. Its documented limits and compaction behavior illustrate why a shared Kernel needs explicit budgets and durable task invariants.

### Limitations

- The native binary is not source-auditable. No undocumented internal planner, scheduler, or recovery algorithm is inferred.
- The no-more-tool-calls loop stop is not a criterion-level task completion proof.
- A post-response spend cap is not equivalent to a pre-admission hard reservation ledger.
- Session persistence and file checkpointing do not prove external side effects are reversible or that long-running media renders are safely recoverable.

### Applicability

**ADAPT:** explicit hook points, layered permission rules, session resume/fork, typed result status, and observable compaction boundaries.

**DO NOT COPY:** do not replace Kernel admission with a model permission classifier or treat the SDK's loop result as universal completion proof.

## 7. Cross-reference synthesis

| Shared execution concern | Transferable evidence | Kernel direction |
| --- | --- | --- |
| Tactical agent loop | Pi, Codex, DeepSeek, Claude | Keep one domain-neutral model/tool loop with typed lifecycle and complete-response validation |
| Durable continuity | Pi AgentSession, Codex Thread, DeepSeek Session log, Claude sessions | Kernel Journal remains task authority; session/context projections are reconstructable views |
| User control | Pi steering/follow-up, Codex bidirectional approvals, Claude streaming input/hooks | Common ask/approve/steer/follow-up/cancel/wait protocol |
| Tool scheduling | Pi sequential/parallel modes, Codex in-flight tool routing, DSH bounded scheduler, Claude read-only/write policy | Effect/conflict-aware scheduling, bounded concurrency, explicit barriers and drain |
| Permission and isolation | Codex sandbox plus approval, DSH guards/approval/sandbox, Claude permission chain/hooks | Keep technical isolation and user authorization separate; Kernel remains final admission authority |
| Context and compaction | All four references | Preserve task invariants, accepted plans, domain model versions, evidence, UNKNOWN, and artifact lineage outside lossy prompt summaries |
| Long-running process control | General process/tool mechanisms in references | Promote long-running work to typed Host jobs with progress telemetry, resource reservations, cancellation, receipts, and UNKNOWN reconciliation |
| Artifact lifecycle | Codex diffs/items and tool results; session history in others | Generic immutable Artifact envelope and delivery binding; payload remains domain-specific |
| Domain cognition | Coding-oriented references, limited media-specific evidence | Do not reuse RepositoryModel for media or force one planner/verifier semantic model across domains |
| Completion quality | Most loop descriptions stop at final response/no more tool calls | Shared Completion Guard checks evidence envelope; each domain owns semantic verification |

## 8. Cross-domain conclusions

1. **Share execution mechanics, not domain cognition.** Task/Turn/Step, ModelStep/Attempt, ActionProposal, ToolInvocation, scheduling, authorization, budgets, Journal, Host receipts, cancellation, recovery, and delivery belong to the common Kernel.
2. **Use typed Workflow Profiles.** A Task binds one immutable domain/profile version, which selects schemas, tool snapshots, resource limits, and evidence obligations. A profile is not an Agent or permission grant.
3. **Keep GoalContract and PlanRevision as common envelopes.** Domain payloads and PlanStep semantics remain typed and separate. Kernel checks schema, lineage, graph, authority, and budget; Orchestration checks semantic adequacy.
4. **Context Engine is generic infrastructure with separate projections.** RepositoryModel and MediaProjectModel are peers, not one merged model.
5. **Domain tools share the same Host controls.** A shell command and an FFmpeg render differ in domain meaning and resource profile, but both require invocation identity, admission, durable intent, process control, receipt, cancellation, recovery, and output evidence.
6. **Long-running work needs a first-class lifecycle.** Progress is telemetry, cancellation requires process convergence, and lost receipts create UNKNOWN rather than a blind retry.
7. **Completion is not a loop stop.** Coding tests/diffs and Video probe/decode/perceptual evidence are domain-specific inputs to a common completion envelope.
8. **Do not over-abstract prematurely.** The common contract should be a small set of stable envelopes and authority boundaries, not a universal semantic ontology or plugin framework.
9. **One task remains one domain in the initial scope.** Linked cross-domain tasks may share artifact references; a composite cross-domain autonomous workflow is deferred.

## 9. Required adjustments to the current Kernel proposal

- Reframe the repository objective and Architecture overview from Coding-only to one shared Kernel with Coding and Video Editing domains.
- Retain the existing Autonomous Coding Agent design as the Coding Domain Intelligence proposal.
- Add MediaProjectModel as a sibling Context Engine projection; do not rename or generalize RepositoryModel into a vague universal model.
- Add immutable DomainBinding and Workflow Profile references to Task/GoalContract/PlanRevision/ToolInvocation/Artifact/VerificationReport envelopes.
- Extend resource accounting to non-token host resources and long-running jobs without selecting a runtime or storage technology.
- Add canonical TimelineRevision and RenderJob contracts for Video Editing.
- Keep Completion Guard generic while making each domain supply its own criterion/evidence matrix.
- Preserve no-runtime, no-production-dependency, no-legacy-migration, and no-Multi-Agent gates.

## 10. Sources

### Pinned source repositories

- Pi repository at inspected commit: https://github.com/earendil-works/pi/tree/c9f4c7b9fcd0f3e6b5bbc35c7c9b6cda35580eb8
- Pi agent loop: https://github.com/earendil-works/pi/blob/c9f4c7b9fcd0f3e6b5bbc35c7c9b6cda35580eb8/packages/agent/src/agent-loop.ts
- Pi coding session: https://github.com/earendil-works/pi/blob/c9f4c7b9fcd0f3e6b5bbc35c7c9b6cda35580eb8/packages/coding-agent/src/core/agent-session.ts
- Codex source: https://github.com/openai/codex/tree/a09812981de703f18f38015cd5d500ab373f616c
- Codex turn execution: https://github.com/openai/codex/blob/a09812981de703f18f38015cd5d500ab373f616c/codex-rs/core/src/session/turn.rs
- Codex tool router: https://github.com/openai/codex/blob/a09812981de703f18f38015cd5d500ab373f616c/codex-rs/core/src/tools/router.rs
- DeepSeek Harness source: https://github.com/deepseek-ai/deepseek-harness/tree/ce7073d51254c26cd63b22a60835b8f948deb447
- DeepSeek architecture: https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/docs/architecture.md
- DeepSeek tool batch scheduler: https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/core/tools/src/batch.ts
- DeepSeek tool execution pipeline: https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/docs/tool-execution-pipeline.md

### Official engineering and product documentation

- OpenAI, Unrolling the Codex agent loop: https://openai.com/index/unrolling-the-codex-agent-loop/
- OpenAI, Unlocking the Codex harness / App Server: https://openai.com/index/unlocking-the-codex-harness/
- OpenAI, Running Codex safely: https://openai.com/index/running-codex-safely/
- Claude Agent SDK overview: https://code.claude.com/docs/en/agent-sdk/overview
- Claude Agent SDK loop: https://code.claude.com/docs/en/agent-sdk/agent-loop
- Claude Agent SDK permissions: https://code.claude.com/docs/en/agent-sdk/permissions
- Claude Agent SDK hooks: https://code.claude.com/docs/en/agent-sdk/hooks
- Claude Agent SDK sessions: https://code.claude.com/docs/en/agent-sdk/sessions
- Claude Agent SDK file checkpointing: https://code.claude.com/docs/en/agent-sdk/file-checkpointing

### Media execution and analysis documentation

- FFmpeg documentation: https://ffmpeg.org/ffmpeg.html
- ffprobe documentation: https://ffmpeg.org/ffprobe.html
- PySceneDetect documentation: https://www.scenedetect.com/docs/latest/

FFmpeg documents filtergraphs and machine-readable progress reporting. ffprobe documents machine-readable container/stream/frame inspection. PySceneDetect documents shot-boundary detection and splitting. These sources support media execution/probing primitives; they do not establish semantic editing quality or a complete video-editing workflow.

Official product documentation is rolling and was accessed 2026-11-02. Recheck it before making version-specific implementation decisions.
