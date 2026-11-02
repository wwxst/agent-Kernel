# Autonomous Coding Agent — Coding Domain Evaluation and Experiment Protocol

> **Status: PROPOSED Coding-domain evaluation.** Video evaluation is separate; shared Kernel safety metrics are defined in the [Video evaluation protocol](../multimedia-domain-architecture/evaluation.md) and cross-domain architecture. This document defines how the intelligent execution architecture should be evaluated. No benchmark run, runtime result, or performance claim is reported here.

## 1. Evaluation objective

Evaluate whether the agent can independently complete real software-engineering tasks with correct, maintainable changes and trustworthy verification.

The primary question is not whether the agent makes fewer tool calls. It is whether it achieves the intended outcome, handles uncertainty and failure intelligently, and avoids false success or unauthorized side effects.

## 2. Benchmark task families

Build a curated suite from reproducible repositories and task definitions. The initial candidate suite should cover:

1. **Repository understanding:** locate behavior, trace dependencies, explain a subsystem, and identify the right change boundary without modifying files.
2. **Localized bug fix:** reproduce a failing test, identify root cause, implement a minimal fix, and add or improve regression coverage.
3. **Cross-file feature:** implement behavior spanning interfaces, implementation, configuration, and tests.
4. **Compatibility change:** modify an API or behavior while preserving documented backward compatibility.
5. **Refactor:** change internal structure without changing observable behavior.
6. **Build/test repair:** diagnose broken CI, type checks, fixtures, or test setup without masking the underlying defect.
7. **Dependency or migration task:** update a dependency or data/API migration with explicit compatibility and rollback requirements.
8. **Performance or resource task:** establish a baseline, identify a bottleneck, change behavior, and measure the result.
9. **Security-sensitive change:** fix a vulnerability or harden a boundary while respecting least privilege and avoiding unrelated exposure.
10. **Long-running composite task:** combine discovery, plan revision, implementation, debugging, verification, and restart/compaction recovery.

Each task should include a fixed repository commit, task prompt, scope and exclusions, environment definition, acceptance criteria, required checks, allowed network/tool policy, resource budget, expected artifacts, and hidden tests or reviewer rubric where appropriate.

Avoid evaluating only small benchmark puzzles. Include realistic repositories, imperfect documentation, cross-package dependencies, and tasks that require the agent to discover the correct tests.

## 3. Experimental controls

For each run, pin and record:

- repository URL and base commit;
- task definition and acceptance-criteria version;
- model/provider identifier and relevant model settings;
- system/developer/project instruction versions;
- tool definitions and implementation versions;
- sandbox/Host profile and policy;
- environment/container image digest, runtime, compiler, package manager, and lockfile;
- network availability and allowlist;
- workspace initialization and initial hash;
- hard model, tool, wall-clock, and host-resource budgets;
- context/checkpoint policy;
- random seed or repeatability controls where available.

A comparison is not valid if one configuration receives different hidden tests, a different base commit, a more permissive tool policy, or a larger budget without being labeled as a separate condition.

Run tasks repeatedly where model nondeterminism matters. Report distributions and failure cases, not only the best run.

## 4. Primary metrics

| Metric | Definition | Why it matters |
| --- | --- | --- |
| Verified task success rate | Fraction of tasks whose required acceptance criteria pass Completion Guard | Primary outcome |
| Criterion coverage | Fraction of criteria with valid, current evidence | Detects partial completion |
| False-completion rate | Fraction of runs that claim completion without sufficient evidence | Critical trust metric |
| Patch correctness | Hidden-test, regression, and reviewer assessment of behavior | Measures actual code quality |
| Scope discipline | Unrelated changes, unauthorized writes, or unapproved scope expansion | Measures change quality and safety |
| Repository understanding | Correctness of discovered entry points, dependencies, tests, and constraints | Measures problem-model quality |
| Plan quality | Criterion coverage, dependency correctness, risk handling, and adaptation quality | Measures strategic control |
| Debugging efficiency | Time and experiments to reach a supported root cause | Measures feedback reasoning |
| Verification quality | Required tests run, evidence freshness, environment fidelity, and interpretation accuracy | Measures assurance |
| Recovery correctness | Correct behavior after cancellation, restart, compaction, and UNKNOWN outcomes | Measures long-task reliability |
| Human escalation quality | Whether questions/approvals are necessary, timely, and sufficiently specific | Measures usable autonomy |
| Resource efficiency | Cost and time per verified successful task | Measures efficiency without replacing quality |

Tool calls, tokens, and latency are diagnostic metrics. They are not primary success metrics.

## 5. Failure and safety metrics

Report at least:

- unauthorized side-effect attempts and actual unauthorized executions;
- prompt-injection compliance rate for adversarial repository/web/tool content;
- false failure and false success rates;
- unresolved UNKNOWN count and age;
- unsafe retry attempts;
- stale verification evidence accepted or rejected;
- workspace hash mismatches;
- process/handle convergence failures;
- scope drift and unintended file changes;
- context-critical facts lost after compaction or restart;
- budget overshoot and incomplete settlement;
- test modifications that weaken acceptance coverage;
- repeated no-progress cycles and successful strategy changes.

A single high-severity unauthorized execution or false completion should block a safety gate even if aggregate task success is high.

## 6. Evaluation protocol

For every task run:

1. Admit a fresh Task and workspace from the pinned base commit.
2. Capture initial workspace and environment evidence.
3. Let the agent create its GoalContract and reconnaissance model.
4. Record PlanCandidate and every accepted PlanRevision.
5. Capture every ModelStep, Attempt, ActionProposal, ToolInvocation, admission result, Host receipt, diff, and verification run.
6. Preserve all user questions, approval requests, waits, cancellations, and budget decisions.
7. Run hidden tests and reviewer assessment against the final frozen snapshot.
8. Compare the agent's completion claim with actual criterion results.
9. Classify every failure using the failure model.
10. Publish the full run trace, not just the final answer.

A task that stops because of budget, approval, missing input, or UNKNOWN outcome is not a successful completion. It may still be a correct safety outcome and should be scored separately.

## 7. Ablation plan

After a stable baseline exists, remove or vary one capability at a time:

- no explicit GoalContract / acceptance matrix;
- shallow versus structured repository reconnaissance;
- no dependency-aware plan versus PlanRevision/PlanStep graph;
- no evidence graph versus provenance-aware facts and hypotheses;
- generic retry versus hypothesis-driven debugging;
- no independent verification pass versus fresh verifier context;
- no checkpoint versus milestone checkpoint and compaction;
- naive parallel tool calls versus effect/conflict-aware scheduling;
- no no-progress guard versus bounded retry/replan policy.

Do not introduce Multi-Agent / D9 as a baseline dependency. The first question is whether one primary agent can complete the task reliably.

## 8. Staged evaluation gates

Evaluation readiness is staged. A measured baseline cannot be a prerequisite for agreeing on the evaluation method, and a target threshold must not be invented before a baseline exists.

| Stage | Required output | Gate |
| --- | --- | --- |
| Architecture design | Metric definitions, task families, safety floors, evidence rules, and experiment method | Owner review of the evaluation protocol; no runtime result is implied |
| Task-set preparation | Reproducible task schema, pinned repositories/commits, difficulty strata, acceptance criteria, hidden tests/reviewer rubric, and scoring rules | Task set and scoring rubric reviewed before comparison runs |
| Baseline | Run a declared reference system or the first controlled implementation on the frozen task set with pinned environment, policy, tools, and budgets | Publish baseline distributions, failure taxonomy, and confounders; if no comparable reference is available, label the first controlled implementation as the baseline |
| Target confirmation | Set quality and safety thresholds using baseline distributions, task difficulty, confidence intervals, and the intended risk profile | Owner approves target thresholds and safety gates; do not backfill thresholds to fit results |
| Formal evaluation | Repeated controlled comparisons, ablations, and regression runs against the approved baseline and thresholds | Report all outcomes, including failed, blocked, incomplete, and unsafe runs |

**Implementation-planning gate:** architecture and implementation planning may proceed after the design-level metrics, task families, safety floors, and experimental method are reviewed. They do not need measured baseline thresholds that cannot exist before a runnable system or reference baseline is available.

**Runtime / controlled-execution gate:** a real-model baseline requires separate explicit authorization of provider, disposable workspace, tools, network policy, hard budget, task set, and stop conditions. Architecture approval or implementation planning does not grant that authorization.

A single high-severity unauthorized execution or false completion remains a safety blocker regardless of aggregate task success. Target thresholds remain OPEN until the baseline stage is complete.

## 9. Reporting template

Every experiment report should include:

- question and hypothesis;
- task set, pinned commits, and environment;
- agent configuration and hard budgets;
- baseline and candidate conditions;
- verified success, criterion coverage, false completion, safety, and resource metrics;
- failure taxonomy with representative traces;
- ablation results;
- confidence limits and known confounders;
- recommendation: adopt, adapt, reject, or run another experiment.

## 10. Current status

- Benchmark task suite: **NOT RUN / NOT BUILT**.
- Runtime experiments: **NOT RUN**.
- Comparative benchmark claims: **UNVERIFIED**.
- Proposed evaluation protocol: **DRAFTED**.
