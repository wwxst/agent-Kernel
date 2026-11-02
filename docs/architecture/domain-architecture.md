# Unified domain architecture

> **Status: APPROVED PRODUCT DIRECTION; PROPOSED ARCHITECTURE.** The owner has confirmed one shared Agent Kernel for Autonomous Coding and Autonomous Video Editing, with independent domain intelligence and execution capabilities. This document is the cross-domain architecture proposal, not an implementation specification or runtime authorization.

## 1. Product objective

Build one autonomous Agent platform that can understand different kinds of engineering tasks, plan and execute them safely, recover from interruption, verify the actual deliverable, and return a usable result.

The first two domains are:

- **Autonomous Coding** — understand a repository, plan software changes, edit code, run checks, diagnose and repair defects, and deliver verified code.
- **Autonomous Video Editing** — understand natural-language editing instructions and source media, analyze assets, construct a timeline, render a finished video, inspect the output, and deliver the video.

The product is **one Kernel with domain-specific intelligence and execution**, not two independent agent products joined by an adapter.

The Video Editing first phase is deliberately narrow: natural-language-driven automatic editing. It is not a full nonlinear video editor or professional post-production workstation. See [Video Editing domain design](../research/multimedia-domain-architecture/design.md).

## 2. Three architectural layers

| Layer | Shared or independent | Responsibility |
| --- | --- | --- |
| **Agent Kernel** | Shared | Task lifecycle, GoalContract/PlanRevision envelopes, model admission, scheduling, permissions, budgets, journal, ToolInvocation, Host execution boundary, cancellation, recovery, evidence binding, completion and delivery |
| **Domain Intelligence** | Independent per domain | Interpret domain goals, build domain models, choose workflow, plan/replan, form domain-specific hypotheses, assess domain semantics, and define criterion-specific verification |
| **Domain Execution** | Independent capability sets over shared execution controls | Expose domain tools and artifact operations; submit every operation through the shared Tool Runtime, Kernel admission, and Trusted ToolHost |

A logical view:

    User request + source assets
              |
       Agent Application
              |
       Shared Agent Kernel
       - Task / Turn / Step
       - GoalContract / PlanRevision envelopes
       - Model Gateway / Context Engine
       - Tool Runtime / Permission / Budget
       - Journal / Host Ledger references
       - Cancellation / Recovery / Completion Guard
              |
       Domain Workflow Profile
          /                 \
    Coding Intelligence   Video Intelligence
    RepositoryModel       MediaProjectModel
    Coding PlanSteps      Video PlanSteps
    Coding verifier       Media / timeline verifier
          |                 |
    Coding tool set       Media tool set
    Git / FS / tests      Probe / Analyze / Timeline / Render
          \                 /
       Shared admission, process control,
       resource accounting and evidence binding
              |
         Trusted ToolHost
              |
       Domain artifacts + verification
              |
           Delivery

This is a responsibility diagram, not a process topology. It does not prescribe microservices, package boundaries, language, or deployment.

## 3. Shared Agent Kernel

The following responsibilities remain domain-neutral:

- Task, Turn, runtime Step, ModelStep, ModelAttempt, ActionProposal, ToolInvocation, and delivery lifecycles.
- Immutable user intent, versioned GoalContract and PlanRevision envelopes, legal transitions, and the plan-switch barrier.
- Model Gateway request/response normalization, usage evidence, hard model budgets, and cancellation.
- Context assembly with source provenance, version binding, freshness, and checkpoint/recovery contracts.
- Tool definition snapshots, effect/conflict-aware scheduling, independent invocation admission, permission and approval checks.
- Hard resource budgets and reservations. The resource vocabulary must be extensible beyond tokens to host CPU, memory, disk, GPU, wall time, and output-size dimensions.
- Kernel Journal, durable intent, idempotency, UNKNOWN handling, Host Ledger/receipt reconciliation, and fencing.
- Artifact identity, content digest, provenance, immutable version references, and delivery records.
- A common VerificationReport envelope and Completion Guard that checks evidence obligations and bindings without interpreting domain semantics.

Kernel must not import or reason over RepositoryModel or MediaProjectModel semantics. It validates domain payload schema/version, references, authority envelope, and legal state transitions; it does not decide whether a code fix is good or whether a video edit is aesthetically coherent.

The existing authority boundaries remain in force: Orchestration proposes; Kernel commits; Tool Runtime dispatches only admitted operations; Trusted ToolHost records physical execution facts. See [Architecture overview](overview.md).

## 4. Domain Intelligence

Each domain owns its own cognitive model and workflow.

| Concern | Autonomous Coding | Autonomous Video Editing |
| --- | --- | --- |
| Domain model | RepositoryModel | MediaProjectModel |
| Persistent project container | Repository/workspace identity and commit-bound artifacts | MediaProject ID/generation grouping immutable media assets, timeline revisions, renders, and reports |
| Core evidence | Source/symbol/test/build/diff/Host evidence | Media metadata, stream facts, shot/scene analysis, transcript/audio observations, timeline/render evidence |
| Planning semantics | Dependencies, code changes, migrations, tests, compatibility | Story/pacing, source ranges, shot selection/order, track layout, audio/subtitle timing, output profile |
| Repair loop | Hypothesis-driven code/debug/test loop | Timeline adjustment, render diagnosis, targeted re-render and output inspection |
| Verification | Tests, builds, static analysis, API/compatibility/security checks | Timeline invariants, decode/probe, audio/video integrity, temporal/content match, perceptual review |
| Deliverable | Patch, commit or repository artifacts, verification report | Rendered video, canonical timeline revision, render manifest, verification report |

These are not two names for one generic cognition model. The shared EvidenceGraph and VerificationReport are provenance/evidence envelopes; the domain-specific claim vocabulary, models, planners, and verifiers remain separate projections and policies.

A domain may reuse generic orchestration primitives such as hypothesis records, dependency DAGs, evidence relations, and bounded replan policies. Reuse does not imply sharing its semantic model.

## 5. Domain Execution and Workflow Profiles

Each task is bound to one immutable **Workflow Profile**. A profile composes a domain's schemas, cognitive policy, tool capabilities, resource envelope, and verification obligations.

A Workflow Profile is a configuration/policy snapshot, not an agent process, microservice, or new security principal. It cannot grant permissions by itself. Kernel admission and current authorization remain authoritative.

A Workflow Profile declares at least:

- domain ID, profile ID/version, and compatible contract/schema versions;
- GoalContract domain-payload schema and acceptance-criterion vocabulary;
- domain PlanStep kinds and expected artifact types;
- domain context/model projection versions and evidence kinds;
- allowed tool-definition snapshot references and effect/conflict classifications;
- resource dimensions, hard limits, reservation rules, and verification/repair reserve;
- criterion-to-evidence mapping and required evidence-independence level;
- output artifact and delivery requirements;
- cancellation, recovery, and reconciliation requirements for long-running operations.

A Task, accepted GoalContract, PlanRevision, relevant ModelSteps, ToolInvocations, artifacts, and VerificationReport bind the same profile identity/version unless a separately accepted profile migration triggers impact analysis and a safe plan switch.

The shared Tool Runtime and Trusted ToolHost execute domain tools under the same admission and process-control contracts. The tool set differs by profile:

- Coding: bounded repository inspection, file edits, Git, build/test/static-analysis and related development tools.
- Video: media ingest/probe, frame sampling, scene detection, transcription/audio analysis, timeline validation/compilation, FFmpeg render, and rendered-output inspection.

No domain tool may invoke a provider or perform a side effect outside the shared Kernel/Host boundary.

## 6. Shared contracts with domain-specific extensions

The architecture reuses the existing GoalContract and PlanRevision lifecycle without forcing their domain semantics into one schema.

- **GoalContract:** a common envelope for desired outcome, scope, exclusions, constraints, acceptance criteria, risk, provenance, and user-control policy. A versioned domain payload carries coding-specific or video-specific intent. Kernel checks envelope and schema bindings; Domain Intelligence decides semantic fidelity.
- **PlanRevision:** a common immutable dependency graph with generic PlanStep lifecycle, authority, resource, and evidence fields. A typed domain step payload describes the engineering outcome. Kernel validates graph structure and authority; Domain Intelligence decides whether the plan is semantically sufficient.
- **EvidenceGraph:** common provenance, claim/evidence/relation/freshness envelope. RepositoryModel and MediaProjectModel remain separate domain projections.
- **Artifact:** common immutable identity, content digest, provenance, workspace/project binding, and lineage. Artifact payloads remain typed by domain.
- **VerificationReport:** common criterion-to-evidence envelope. Each domain supplies its own verifier and criterion-specific evidence; Completion Guard checks declared obligations and freshness.

Detailed binding rules are in [Domain Workflow contract](../contracts/domain-workflow.md).

## 7. Task and domain isolation

For the first platform scope:

1. One Kernel supports multiple Coding and Video Editing tasks.
2. Each Task is bound to exactly one domain and one Workflow Profile version.
3. Each domain has its own context projection, planner semantics, tool capability set, and verifier.
4. The domains share Task/Plan/Tool/Host/Journal/Budget/Recovery/Completion contracts.
5. A task that requires a Coding task and a Video task may be represented as separately authorized tasks linked by artifact references; a composite cross-domain autonomous workflow is **OPEN / DEFERRED** until separately designed.
6. Domain-specific artifacts and evidence are not silently interpreted by the other domain.

This avoids turning the Kernel into a universal semantic model and keeps cross-domain coupling explicit.

## 8. Scope boundaries

**In scope for architecture research**

- Unified shared Kernel contracts and two independent Workflow Profiles.
- Autonomous Coding domain design retained from the first and second rounds.
- Natural-language-driven automatic Video Editing domain design.
- Persistent media/timeline artifacts, long-running render lifecycle, recovery, and output verification.
- Separate Coding and Video evaluation protocols plus shared Kernel safety metrics.
- Cross-domain consistency and reference-implementation review.

**Out of scope for the current Video Editing first phase**

- A complete visual nonlinear editor or manual multitrack editing workstation.
- A professional effects/compositing/color-grading suite, 3D/VFX system, or keyframe animation editor.
- A plugin marketplace or user-authored editing-code platform.
- Multi-Agent / D9, autonomous agent teams, or distributed domain agents.
- Runtime implementation, production dependencies, or final technology/deployment selection.

The timeline is a canonical engineering artifact that the agent creates and revises. It is not a requirement to build a timeline GUI.

## 9. Architecture invariants

1. One shared Kernel owns all authoritative task and execution state for both domains.
2. Domain Intelligence owns semantic interpretation and domain plan quality.
3. Kernel remains domain-neutral and validates typed envelopes, references, authority, and legal transitions deterministically.
4. Each Task has one immutable domain/profile binding at a time.
5. Domain tools use the same ToolInvocation, budget, permission, Host, receipt, cancellation, and recovery controls.
6. A successful tool exit is not proof that a domain deliverable is correct.
7. Domain artifacts are immutable/versioned and provenance-bound; new user instructions create new revisions rather than silently overwriting prior results.
8. Completion is criterion- and evidence-gated, with domain-specific verification obligations.
9. No full Video Editor and no Multi-Agent implementation is implied.
10. The current work remains architecture research and documentation; Runtime development is not authorized.

## 10. Open design questions

The current cross-document consistency findings are recorded in [Cross-domain architecture review](../decisions/cross-domain-architecture-review.md). The following questions remain open:

- Which fields belong in the minimal common GoalContract/PlanRevision envelope versus typed domain payloads?
- How should a Workflow Profile be versioned, accepted, revoked, and migrated during a long-running Task?
- Which generic artifact storage and streaming contracts are needed without choosing a storage technology?
- Which host resource dimensions can be enforced consistently across platforms?
- How should cross-domain linked tasks exchange artifacts without sharing domain authority?
- What minimal Video Editing operation set gives useful results without expanding into a full editor?
- Which subjective video-quality criteria require explicit human review?
