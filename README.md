# Agent Kernel

> **Project status: CONSTRUCTION BASELINE v1 — DF PASS (ARB-01, 2026-11-03). Ready for Implementation at the documentation/design level. No implementation exists; PE (prototype evidence) and VI (verified implementation) are NOT RUN; all runtime, performance and quality claims are UNVERIFIED.**

## Purpose

Build one autonomous Agent platform that can understand different classes of work, plan and execute them safely, recover from interruption, verify the actual deliverable, and return a usable result.

The first two domains are:

- **Autonomous Coding** — understand repositories, plan changes, edit code, run checks, diagnose/repair, and deliver verified code.
- **Autonomous Video Editing** — understand natural-language editing intent and source media, analyze assets, construct a timeline, render, inspect the actual output, and deliver the video.

The product principle is **one Kernel, independent domain strategies**. Coding and Video share execution authority, lifecycle mechanics and evidence contracts; they do not share a forced cognitive model or an identical execution strategy.

## Architecture in one page

| Layer | Responsibility |
| --- | --- |
| **Shared Agent Kernel** | Task/Goal/Plan state, model admission, tool admission, budgets, permissions, Journal/Inbox/Outbox, Host boundary, cancellation, recovery, completion and delivery |
| **Domain Extension** | Version-pinned manifest and adapter ports (`interpretGoal`, `projectContext`, `decideNext`, `interpretOutcome`, `verifyCriteria`, `describeRecovery`); proposal-only |
| **Domain Strategy** | Data-driven per-domain policy (fast path, context budget, scheduling, waits, resources, verification triggers, termination bounds) |
| **Domain Execution** | Domain tools and artifacts executed only through Kernel admission and Trusted ToolHost |

The Kernel never branches on `domain_id`. Adding a domain means adding a manifest, adapter, tools, task strategy and verification policy — not editing the Kernel state machine. A fourth domain is required to land with a **zero Kernel diff** ([Domain Extension](docs/contracts/domain-extension.md)).

Normative starting points:

- [Kernel data model](docs/contracts/kernel-data-model.md) — records, enums, events, commands, errors, invariants.
- [Core protocol](docs/contracts/core-protocol.md) — transaction ownership, transitions, loop, terminalization.
- [Execution Strategy](docs/contracts/execution-strategy.md) — why domains differ without forking the Kernel.
- [Permissions](docs/security/permissions.md) — capability grants, one-use approvals, separation of duties, tenancy.
- [Trusted Host](docs/security/trusted-host.md) — LaunchGate, effect classes, UNKNOWN reconciliation.
- [Completion](docs/contracts/completion.md) — assurance floor, evidence, Guard, holds.
- [Roadmap and construction plan](docs/development/roadmap.md) — DF/SA/PE/VI gates and the work breakdown.

## Video Editing capability boundary

The first Video capability is natural-language-driven automatic editing, not a full video editor (ADP-01 REVISED, approved 2026-11-02):

- **Core automatic editing:** ingest/probe; task-conditioned analysis; moment selection; basic NarrativePlan; trim/reorder/hard cut/concatenate; simple fade/crossfade; limited source-audio controls; immutable timeline; bounded FFmpeg render; actual-output checks; revision/re-render/re-verification.
- **Deferred:** captions/music generation, multi-track audio, advanced transitions, compositing/color/VFX, manual NLE, plugin marketplace, external publication.

See [Video design](docs/research/multimedia-domain-architecture/design.md) and [Video intelligence](docs/research/multimedia-domain-architecture/intelligence.md).

## Coding and Video construction specs

- Coding: [design](docs/research/autonomous-coding-agent/design.md) (tools, patch, recon budget, test selection, fast path), [failure model](docs/research/autonomous-coding-agent/failure-model.md), [evaluation](docs/research/autonomous-coding-agent/evaluation.md) (C-01…C-15).
- Video: [design](docs/research/multimedia-domain-architecture/design.md), [operation registry and timeline](docs/contracts/media-timeline.md), [render compiler](docs/contracts/render-compiler.md), [RenderJob](docs/contracts/render-job.md), [evaluation](docs/research/multimedia-domain-architecture/evaluation.md) (V-01…V-13).

## Office as the third-domain test

Office is **design-only** in this baseline. It registers a manifest, two R0/R1 tools (`office.document.read`, `office.document.export`), typed criteria and UNKNOWN/wait paths — without changing a single Kernel state, enum or event. External in-place edits remain R2 and disabled.

- [Domain Extension §6](docs/contracts/domain-extension.md) — Office sample and X1–X13 fixtures.
- Falsification: if Office requires a Kernel state-machine change, the extension boundary is rejected and the architecture re-opened.

## Readiness: what is claimed, and what is not

**Claimed:** the construction baseline is frozen; a competent team can build directly from the documents; the P0 documentation defects found in review have been repaired; the work breakdown has dependencies and acceptance conditions. The final independent acceptance verdict is recorded in the [readiness review](docs/decisions/construction-readiness-review.md).

**Not claimed:**

- No runtime code exists; no fixture has been executed (`M1–M6`, `R1–R7`, `S1–S3`, `C-01…`, `V-01…`, `X1–X13` are all NOT RUN).
- No provider, OS, storage, sandbox or media-analysis stack is selected, and no FFmpeg build is selected; FFmpeg is the named first-phase render backend per ADP-01, not a selected build or package.
- No performance, token, quality or reliability result is measured.
- R2/external/destructive effects are disabled by default.
- Multi-Agent / D9 remains deferred and unauthorized.

Release-level claims require the PE (Prototype Evidence) and VI (Verified Implementation) gates, not this document. See [Roadmap §2](docs/development/roadmap.md) and the [readiness review](docs/decisions/construction-readiness-review.md).

## Repository rules

- This repository is the sole formal development home for the Kernel. The former `wwxst/agent-` repository is deleted and is not a source, dependency or authority.
- No old code, history or obsolete design is imported. Knowledge is re-authored and reviewed here.
- Architecture principles and contracts are versioned here; unresolved external facts remain explicitly OPEN.
- No production implementation, dependency stack or security capability is claimed until implemented and verified.
- Do not create a PR, release or deployment without an explicit request.

## How to work in this repository

Read [AGENTS.md](AGENTS.md) first, then the [documentation map](docs/README.md). The map defines document classes, precedence and the normative surface. Change the owning document — never a restatement — and record a decision when authority or a safety property changes.
