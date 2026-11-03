# FFmpeg RenderPlan security contract

> **Status: ACCEPTED for construction (ARB-01, 2026-11-03); implementation NOT started; media-quality and runtime claims UNVERIFIED.** FFmpeg is the named first-phase render backend, but no FFmpeg build, packaging strategy, sandbox, host OS, or production dependency stack is selected. Requirements below define a fail-closed boundary; enforcement is UNVERIFIED until implemented and tested on each supported Host profile. The v1 filter allowlist is fixed by the [Render Compiler](render-compiler.md) and is versioned with the compiler and pinned build.

## 1. Purpose and threat model

RenderPlan is the deterministic, versioned compilation of one accepted TimelineRevision into a bounded media operation. It is not an arbitrary command supplied by a model or user.

Treat as untrusted source media bytes, container metadata, embedded subtitles/chapters/attachments, playlists/manifests/file names; model-produced summaries/timestamps/filter parameters/edit operations; external URLs and redirects; subtitle/font/image/LUT/sidecar files; and FFmpeg demuxers, decoders, filters, muxers, and optional libraries as a large parser/processing attack surface.

Threats include path traversal, symlink/hardlink escape, time-of-check/time-of-use races, nested protocol access, SSRF/local-network access, unexpected secondary file reads, filtergraph injection, resource exhaustion, child-process escape, output overwrite, partial output publication, and malicious/corrupt media parser inputs.

## 2. Authority and RenderPlan binding

- Video Domain Intelligence proposes a TimelineRevision and desired render behavior.
- The trusted [Render Compiler](render-compiler.md) validates the timeline operation registry and emits a canonical RenderPlan; the Host independently re-validates the emitted AST before spawn.
- Kernel validates the exact artifact, profile, authorization, budget, output target, and invocation binding at admission.
- Tool Runtime dispatches only the admitted invocation.
- Trusted ToolHost establishes the physical filesystem/network/process/resource boundary and records execution facts.
- Host Ledger records process and output facts; Kernel Journal records intent, admission, cancellation/fencing, and authoritative task state.
- A verifier evaluates staged output; Kernel Completion Guard decides whether the accepted task can complete.

Minimum RenderPlan fields:

- RenderPlan ID/schema version/content digest;
- exact TimelineRevision ID/digest and accepted GoalContract/PlanRevision/DomainBinding;
- ProjectSnapshot, source MediaAsset digests, stream identities, and source-time mappings;
- typed operation/filtergraph AST and compiler version;
- canonical executable identity/build digest and argument-vector digest;
- input format/demuxer/decoder and protocol policy IDs;
- exact staged input artifact references and read-only mount bindings;
- working directory and environment-allowlist digest;
- unique temporary output artifact/path binding and publication policy;
- output profile, resource reservation, hard limits, Host capability profile;
- verification obligations and expected provenance mapping;
- idempotency key, invocation identity, and fencing epoch.

The plan digest covers all execution-affecting fields. Any changed source, timeline, compiler, FFmpeg build, filtergraph, profile, path binding, environment, budget, or Host isolation profile makes the plan stale and requires revalidation.

## 3. Input protocol and demuxer policy

### 3.1 Initial input rule

The initial render boundary consumes only immutable, already-ingested, locally staged MediaAsset artifacts. FFmpeg must not fetch user-provided remote URLs, follow redirects, resolve DNS, access network shares, or load remote playlists during a render.

If remote source acquisition is added later, it is a separate explicitly authorized ingest operation with its own URL validation, redirect/DNS/IP policy, size/time budget, content digest, and quarantine. A render consumes the resulting immutable local artifact, not the original URL.

### 3.2 Protocol allowlist

FFmpeg protocol access is deny-by-default for each input context. The plan declares the minimum protocols required by the supported local input path; no wildcard ALL policy is permitted. The initial candidate is local file access only, subject to the Host filesystem sandbox. Pipe or nested protocols are not enabled unless a specific typed operation requires them and its risks are reviewed.

Explicitly deny network-capable and device protocols in the initial render profile, including HTTP(S), FTP, RTMP, RTSP, TCP, UDP, SMB, SFTP, and other remote/device transports. The exact list must be checked against the pinned build's available protocols; no build is selected here.

Apply protocol policy per input, including nested protocols opened by demuxers. Do not assume one top-level URL check covers playlist/segment/secondary-resource access. FFmpeg documents protocol access at the libavformat layer and states that all protocols are allowed by default unless restricted; an explicit allowlist is therefore a defense, not an optional optimization.

### 3.3 Format and stream policy

- Apply a Workflow Profile allowlist for supported containers/demuxers and selected stream types.
- Reject unknown, unsupported, or disallowed input formats rather than falling back to arbitrary probing behavior.
- Bind selected streams explicitly; do not rely on "first matching stream" defaults where a source has multiple audio/video/subtitle/data streams.
- Ignore embedded attachments/data streams unless a declared operation requires them.
- Bound probe/analyze duration, packet/frame count, metadata size, stream count, and decoded dimensions/pixel workload.
- A successful ffprobe result is metadata evidence, not proof that a full decode is safe or complete.

The demuxer/decoder allowlist is a profile value pinned to the FFmpeg build and the supported container matrix; a profile that does not enumerate an input format denies it. The initial profile explicitly denies the concat demuxer, HLS/DASH and other playlist/segment demuxers, and image2. The concrete container/decoder matrix remains a profile decision with a pinned build identity, not an optional check: an unlisted format yields `CompilerProfileUnsupported`, never a fallback probe.

## 4. Filesystem and path confinement

The Host exposes a minimal per-invocation filesystem view:

- source assets and approved sidecar assets are read-only;
- only the unique invocation staging directory is writable;
- the final artifact namespace is not writable by FFmpeg;
- no home directories, secrets, credential stores, Kernel Journal, Host Ledger, unrelated workspaces/projects, host sockets, device nodes, or system configuration are mounted into the worker;
- temporary storage has a hard quota and is isolated from unrelated tasks.

Model- or user-provided strings are never interpreted as arbitrary filesystem paths. Artifact IDs are resolved by a trusted Host/artifact layer into exact staged bindings. Reject path traversal, absolute paths outside staged roots, alternate path separators, device paths, symlink escapes, hardlink aliases, mount crossings, and path-substitution races.

The Host pins the opened input identity and verifies content digest against the admitted artifact manifest. The staged read-only view remains stable for the full invocation. Where the OS/storage boundary cannot prevent a source from being replaced or modified while FFmpeg reads it, the Host must use a verified immutable snapshot/copy or fail closed.

Generated subtitle, font, image, LUT, and overlay inputs are separate immutable artifacts. They are mounted only when declared in RenderPlan and only at compiler-selected paths. Arbitrary font lookup, textfile, image-sequence, or sidecar path access is not allowed.

## 5. Filtergraph and argument construction

### 5.1 No shell and no raw model graph

- Execute a canonical executable plus an argv array; never compose a shell command string.
- The model never supplies raw argv, raw filtergraph text, filter names, protocol names, file paths, environment variables, or output targets.
- Timeline operations are typed and schema-validated. A deterministic compiler maps only supported operations to a filtergraph AST and canonical serializer.
- The compiler validates graph topology, input/output labels, stream types, node/edge count, operation order, parameter ranges, duration bounds, and expression complexity.
- Unknown filter names/options, arbitrary expressions, unsupported cycles, and unbounded graph sizes are rejected.

Using argv rather than a shell prevents shell-language interpretation; it does not make FFmpeg's own filtergraph grammar safe. FFmpeg filtergraphs have their own separators, quoting, escaping, and nested expression syntax. Typed construction and validation are required even when no shell is involved.

### 5.2 Filter allowlist

Use an explicit per-profile filter allowlist, not a denylist alone. The allowlist is versioned with the FFmpeg build and compiler and includes only filters required by the supported operation registry.

By default, exclude filters or source nodes that can open secondary files, streams, devices, or external resources (for example, movie/amovie sources, arbitrary subtitle/ASS file loading, arbitrary textfile/font paths, image-sequence inputs, plugin-backed filters, or command/message-control filters). If a later feature requires one of these capabilities, it must consume a declared staged ArtifactRef through a typed compiler operation and receive a separate threat review.

**v1 allowlist.** The v1 compiler may emit only `trim, atrim, setpts, asetpts, fps, scale, format, aresample, aformat, concat, xfade, fade, afade, volume`. The list is versioned with `compiler_version` and the pinned build; a profile may narrow it, never widen it. Source filters (`movie`, `amovie`, `color`, `testsrc`, `sine`), subtitle/ASS/font/textfile loaders, image-sequence inputs, external-input overlays, command/message filters and plugin-backed filters are denied in v1. The Host parses the emitted AST and rejects any node whose filter, option or parameter is not allowlisted and within bounds, any dangling or duplicate label, any input not bound to the admitted artifact set, and any output that is not the unique staging binding. Host validation is independent of the compiler: a compiler defect must not be able to smuggle a node the profile disallows.

Do not permit user/model-provided filter scripts or arbitrary filter_complex_script paths. If an implementation needs a generated script file for size reasons, the Host creates it inside the isolated invocation directory from the validated AST, pins its digest, and prevents the model from choosing its path or contents.

### 5.3 Parameter and output constraints

- Numeric parameters have type, unit, minimum/maximum, and canonical rounding rules.
- Registered `volume`, `fade`, `afade`, `xfade` and profile-raster `scale` expressions are generated from bounded typed values; crop, rotation, overlay and free-form expressions do not exist in v1.
- Encoder, muxer, pixel format, channel layout, frame rate, color metadata, and metadata-writing operations are selected only from the immutable Output Profile registry.
- Arbitrary metadata writes, attachment inclusion, data-stream mapping, or container-specific private options are rejected unless explicitly modeled.
- Output file names/extensions are generated by the trusted compiler/artifact layer, not the model.

## 6. Network isolation

The render worker has no network egress in the initial profile. Prefer an OS-level network isolation boundary with no usable external interfaces/routes; FFmpeg protocol allowlisting is defense in depth, not the sole network boundary.

The worker receives no credentials, proxy variables, DNS configuration, cloud metadata access, or host network sockets. It cannot reach localhost services, private address ranges, public endpoints, or host control planes. Any exception requires an explicit capability, destination policy, separate approval, and a new security review.

A protocol whitelist does not replace OS-level network isolation: non-FFmpeg libraries, filters, plugins, or compromised native code may attempt network access independently.

## 7. Process isolation and resource enforcement

Each RenderJob attempt runs in a Host-owned isolated process boundary under an unprivileged identity. The Host profile declares which controls are enforced versus advisory.

Required controls where supported:

- process/job containment that includes descendants and prevents unapproved breakaway;
- filesystem/mount isolation and read-only source bindings;
- network isolation;
- syscall/OS security policy and privilege reduction;
- CPU time/rate, memory, process/thread count, wall-clock, open-file, disk/temp quota, output-size, and I/O limits;
- controlled environment, locale, timezone, and deterministic execution metadata where relevant;
- process and writable-handle convergence before output is sealed.

GPU access is optional and unavailable unless the Host can enforce and account for the relevant device/resource boundary. FFmpeg thread/codec options are workload controls, not a substitute for Host-enforced limits. Numeric caps remain OPEN until supported Host profiles and representative task sizes are measured.

Linux namespaces, cgroup v2, and seccomp are candidate primitives only. Linux kernel documentation explicitly notes that seccomp system-call filtering is not a complete sandbox and must be combined with other controls. Windows Job Objects are a candidate process-group/resource-accounting mechanism, but descendant breakaway behavior and platform-version differences must be tested. No OS implementation is selected by this contract.

If the selected Host cannot establish a required hard boundary, Kernel admission rejects the operation or classifies it as unsupported; it must not silently downgrade a hard limit to best effort.

## 8. Render output and publication boundary

FFmpeg writes only to a unique per-attempt staging target. It cannot write to a prior deliverable, project manifest, or final publication namespace.

After process-tree convergence:

1. Host records process outcome, resource settlement, output file identity/size, and staged output digest.
2. Host seals the staging output against further writes and issues a receipt bound to the exact RenderJob/ToolInvocation/RenderPlan/fencing epoch.
3. Technical verifier independently reads the staged artifact and performs required probe/decode/profile checks.
4. Video Domain Intelligence's independent content verifier checks actual output against accepted criteria, timeline, and source lineage; required human disposition is collected.
5. Kernel rechecks that GoalContract, PlanRevision, DomainBinding, RenderPlan, authorization, and fencing epoch are current and that no conflicting UNKNOWN/cancellation exists.
6. The artifact is finalized under a new immutable Artifact ID/digest. The final deliverable pointer/manifest is committed only after finalization evidence is reconciled.
7. Completion Guard evaluates all evidence and budget/authorization conditions.

A successful FFmpeg exit, complete progress stream, or file that merely exists is never enough to publish. A superseded or cancelled render may be retained as quarantined evidence but cannot replace the current deliverable.

Kernel and Host cannot atomically commit a physical file and a Kernel state transition in one distributed transaction. Publication is an explicit recoverable protocol with idempotent artifact identity and reconciliation of orphaned, finalized-but-unreferenced, or missing objects.

## 9. Required adversarial review cases

Before any implementation claim, future verification must cover nested playlist/segment references attempting HTTP/local-file/private-network access; path traversal, absolute paths, symlink/hardlink escapes, mount crossings and source replacement races; filtergraph separator/quote/escape injection and unsupported filter/source nodes; malformed/adversarial container metadata, embedded subtitles/attachments, huge stream counts, oversized dimensions and decoder failure; frame/packet/metadata expansion, memory/disk exhaustion, CPU starvation and output-size overruns; descendant process breakaway, leaked file handles, cancellation races, Host restart and PID reuse; output path collision, partial output, digest mismatch, late writes and stale RenderPlan publication; unavailable isolation capability and unsupported Host profile.

## 10. Acceptance criteria before implementation planning exits

- RenderPlan schema binds every execution-affecting input, tool/build, filter, path, output, resource, and fencing value.
- Input protocol, format, stream, and filter allowlists are explicit and versioned.
- Model output cannot inject shell syntax, arbitrary FFmpeg options, raw filtergraph, external paths, URLs, or environment values.
- Host read/write/network/process/resource boundaries are independently specified and fail closed when unsupported.
- RenderJob/ToolInvocation/Host Ledger state authority and publication reconciliation are unambiguous.
- Partial/UNKNOWN/superseded outputs cannot be published as current deliverables.
- Every final output digest is independently read and bound to source/timeline/render provenance and VerificationReport.
- Platform-specific controls are labeled candidates until proven on a named environment.

## 11. External technical references

- [FFmpeg Protocols](https://ffmpeg.org/ffmpeg-protocols.html) — protocol access, protocol_whitelist, and default protocol surface.
- [FFmpeg Formats](https://ffmpeg.org/ffmpeg-formats.html) — demuxer behavior and concat demuxer safe path restrictions; safe is not a general filesystem sandbox.
- [FFmpeg Filters](https://ffmpeg.org/ffmpeg-filters.html) — filtergraph grammar, filter options, source filters, and parsing surface.
- [FFmpeg Utilities](https://ffmpeg.org/ffmpeg-utils.html) — quoting and escaping rules; command/graph strings have multiple parsing layers.
- [Linux namespaces](https://man7.org/linux/man-pages/man7/namespaces.7.html) and [cgroup v2](https://docs.kernel.org/admin-guide/cgroup-v2.html) — candidate isolation/resource primitives.
- [Linux seccomp filter documentation](https://docs.kernel.org/userspace-api/seccomp_filter.html) — syscall filtering reduces exposed kernel surface but is explicitly not a complete sandbox.
- [Windows Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects) — process grouping, resource accounting, termination, and descendant-process caveats.

The exact FFmpeg version/build, container/decoder matrix, Host OS, sandbox mechanism and numerical resource limits remain OPEN profile values; the v1 filter allowlist is fixed above and versioned with the compiler and pinned build.
