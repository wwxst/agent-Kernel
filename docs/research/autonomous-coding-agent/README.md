# Autonomous Coding Agent intelligence — research charter

> **Status: OPEN / IN PROGRESS.** This is the highest-priority design gap. No final intelligent-execution architecture is frozen here.

## 1. Research objective

Design the intelligence and execution system that allows an Agent to complete real, multi-step software engineering tasks with bounded autonomy, reliable evidence and safe recovery.

The goal is not merely to build a tool-calling loop or a secure execution host. The system must understand a development goal, build an adequate model of the codebase, decide what to investigate, construct and revise a plan, make changes, run meaningful checks, diagnose failures, and determine whether the result actually satisfies the user's goal.

## 2. Capability areas to investigate

1. **Goal understanding** — extract desired outcome, explicit constraints, hidden dependencies, ambiguity and acceptance criteria; know when to ask the user.
2. **Repository exploration** — discover project structure, build/test commands, architecture, symbols, dependencies, ownership and relevant history; manage uncertainty and exploration cost.
3. **Task modeling and planning** — turn a goal into a dependency-aware plan with observable outcomes, risk, sequencing, estimates and reversible boundaries.
4. **Adaptive orchestration** — select the next action, choose model roles or strategies, revise plans when evidence changes, and distinguish retry, repair, replan, wait and stop.
5. **Code understanding and modification** — reason across files and abstractions, make coherent patches, preserve project conventions and avoid unrelated changes.
6. **Tool and execution strategy** — choose search, read, edit, shell, test, build, debugger and other tools; decide safe parallelism and exclusive operations.
7. **Feedback-driven debugging** — interpret compiler/test/runtime failures, form competing hypotheses, design discriminating experiments, and validate the fix rather than patching symptoms.
8. **Verification and completion** — map acceptance criteria to real commands and evidence; detect weak tests, stale reports, incomplete coverage and false success.
9. **Long-task continuity** — preserve intent, plan, evidence, failed attempts and unresolved operations across context compression, process restart and session recovery.
10. **Cost and time control** — allocate exploration, model, tool and verification budgets; know when more work has diminishing returns.
11. **Human collaboration** — ask precise questions, request approvals at meaningful risk boundaries, explain uncertainty and expose a useful control surface.
12. **Learning and reuse** — retain project knowledge and reusable discoveries with provenance, expiry and correction, without promoting model guesses into facts.

These are research dimensions, not a predetermined module decomposition.

## 3. Reference implementations

Study mechanisms from:

- **Pi Agent Core** — minimal agent loop, tool orchestration, streaming, steering/follow-up, model abstraction and extensibility.
- **OpenAI Codex** — thread/turn/step lifecycle, snapshots, tool routing, approval/sandbox separation, app-server and recovery semantics.
- **DeepSeek Harness** — execution scopes, lifecycle coordination, event projection, tool batch scheduling and concurrency control.
- **Claude Code / Claude Agent SDK / Desktop** — streaming tool scheduling, permissions, long-running shell, subagents, context compaction and bidirectional control.

For each mechanism, capture exact version/commit, source location, observed behavior, design interpretation, limits and applicability to this project. Do not combine mechanisms without analyzing their underlying assumptions.

## 4. Required research method

For each question:

1. State the engineering problem and why it matters to autonomous coding.
2. Inspect primary source code and official documentation where available.
3. Separate **FACT**, **INFERENCE**, **HYPOTHESIS** and **UNKNOWN**.
4. Build minimal reproductions or controlled comparisons where source reading is insufficient.
5. Evaluate success, failure, cancellation, concurrency, cost, latency, context use, observability and recovery.
6. Record alternative designs and the trade-offs of adopting, adapting or building.
7. Identify which decisions belong to Orchestration and which require Kernel-enforced contracts.
8. Propose acceptance tests and failure-injection cases.

## 5. Evaluation dimensions

The eventual design should be evaluated on real coding tasks, not only synthetic tool-call traces:

- task completion and acceptance-criteria satisfaction;
- patch correctness, scope control and maintainability;
- repository exploration efficiency;
- planning quality and adaptation after new evidence;
- debugging hypothesis quality and time to root cause;
- test selection, execution and interpretation;
- false-success and false-failure rates;
- tool-call efficiency, latency, token use and cost;
- context continuity over long tasks and restart;
- recovery from partial execution and UNKNOWN side effects;
- security boundary compliance and resistance to prompt injection;
- quality of human escalation and approval decisions.

Use fixed task definitions, base commits, environments, tool policies and budgets when comparing approaches. Report failures and limitations, not only successful runs.

## 6. Expected deliverables

- A capability model and end-to-end autonomous coding execution lifecycle.
- A source-grounded comparison of Pi, Codex, DeepSeek Harness and Claude.
- An explicit boundary design between adaptive Orchestration and deterministic Kernel.
- Candidate loop, planning, scheduling, debugging, verification and recovery designs.
- Context and memory strategy for long-running coding tasks.
- Threat model, failure taxonomy and human-control model.
- Evaluation benchmark, metrics, experiment protocol and reproducible results.
- Architecture changes and open decisions for owner review.

## 7. Current exclusions

- This document does not authorize runtime implementation.
- It does not select a loop, provider, language, persistence product or sandbox.
- It does not authorize Multi-Agent / D9.
- It does not declare that any reference implementation's design can be copied wholesale.
