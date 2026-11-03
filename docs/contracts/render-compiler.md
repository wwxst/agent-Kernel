# Timeline → RenderPlan deterministic compiler contract

> **Status: ACCEPTED for construction (ARB-01, 2026-11-03); implementation NOT started; media-quality and runtime claims UNVERIFIED.**

This contract fixes how one accepted TimelineRevision and one Output Profile become one canonical RenderPlan AST and argv. It is the normative `CompilerRule` set referenced by the Operation Registry in [Media Timeline](media-timeline.md). Canonical serialization and digest form follow [Kernel data model](kernel-data-model.md) §2.2. Execution, staging and publication follow [RenderJob](render-job.md) and [RenderPlan security](render-plan-security.md). It defines no codec or quality choice and makes no performance claim.

## 1. Determinism rule

The compiler is a pure function:

`Compile(timeline_revision, project_snapshot, output_profile, compiler_version, registry_version) → RenderPlan`

Same inputs must produce byte-identical canonical AST and argv, hence one `plan_digest`. Any behavior change requires a new `compiler_version`; a registry change requires a new `registry_version`. The plan body contains no wall-clock time, host name, user path, random value or model text.

## 2. Inputs and preconditions

| Input | Binding required |
| --- | --- |
| `timeline_revision` | id, digest, schema `media.timeline.v1`, `timeline_timebase` |
| `project_snapshot` | snapshot id/generation/`manifest_digest` |
| Source assets/streams | `media_asset_id` + content digest + stream identity + timebase |
| `output_profile` | id/version/digest: container, video codec/params, pixel format, raster, rational frame rate, color metadata, audio codec/sample rate/channel layout, container metadata policy |
| Resource reservation | reservation id for the render invocation |
| `compiler_version`, `registry_version` | exact versions; both are digest-bound in the plan |

Compilation is rejected unless: the revision is accepted and current; every operation is in the v1 registry with in-bounds arguments; every source range is verified against probed stream duration; the profile is supported by the selected Host profile; no conflicting UNKNOWN render exists on the same output target.

## 3. Canonical order

1. Tracks sorted by `track_id`.
2. Clips sorted by `start_tick`, then `clip_id`; a track must be gapless in v1.
3. Transitions attached to their clip boundary, ordered by boundary.
4. Normalization nodes emitted per distinct source stream in first-use order.
5. Graph nodes numbered `N0001…` in emission order; edges listed sorted by `(from_label, to_label)`.

## 4. Normalization prefix

Concat and xfade require uniform stream parameters, so the compiler emits a normalization stage per input stream before any editorial node. Every parameter comes from the profile; none comes from the model or timeline.

- **Video:** `fps` to the profile rational rate (or `preserve` only when all selected video streams share the identical rational rate), `scale` to the profile raster, `format` to the profile pixel format, and profile color metadata. No crop, rotation, zoom, reframing or speed change in v1.
- **Audio:** `aresample` to the profile sample rate and `aformat` to the profile channel layout/sample format. No mixing of multiple audio tracks in v1.
- Normalization nodes are emitted even when a stream already matches (identity parameters), so the graph shape is stable. A normalization decision is recorded as a `TimeMapping`-compatible conversion record when it changes frame or sample coordinates.

## 5. Operation mapping

| Op | Emitted nodes | Argument derivation | Reject when |
| --- | --- | --- | --- |
| `trim` | video `trim=start:end,setpts=PTS-STARTPTS`; audio `atrim=start_sample:end_sample,asetpts=PTS-STARTPTS` | timeline ticks → source PTS/sample positions per §7 | empty/inverted range; end beyond probed stream duration; missing stream timing |
| `place` | none | `start_tick` must equal the previous clip end on that track | gap or overlap; non-zero first start |
| `concat` | one video `concat=n=N:v=1:a=0` and one audio `concat=n=N:v=0:a=1` after normalization | segment order = timeline order | parameter mismatch after normalization (§9) |
| `fade` | `fade=t=in|out:st=S:d=D`; `afade=t=in|out:st=S:d=D` | tick offsets relative to clip start | `D ≤ 0`, `D > clip duration`, overlapping fades on one clip |
| `xfade` | `xfade=transition=fade:duration=D:offset=d_left−D`; audio per `audio` arg | adjacent clips on one video track | `D ≤ 0`; `D > floor(min(d_left,d_right)/2)`; non-adjacent clips; two transitions on one boundary |
| `audio` | `volume=<canonical dB>`; `afade` for fades; mute is `volume=0` | `gain_db` rational in `[-60, +12]`, 0.1 step; emitted with the fixed canonical decimal form | missing audio stream when mode is `preserve`; fade outside clip; unsupported mode |

Track duration is `Σ clip_duration − Σ transition_overlap` and must equal the declared track duration exactly; otherwise `CompilerInvalidTimeline`.

## 6. Audio rules

- Source audio stays aligned to the asset-relative clock; no per-stream zero reset and no implicit offset.
- `preserve` trims the audio to the interval mapped from the same timeline span as the picture. `mute` emits `volume=0` over the span so A/V timing is unchanged. `gain` is emitted as `volume=<dB>` using the **canonical decimal form** of `gain_db` (sign, integer part, at most one fractional digit as fixed by the 0.1 registry step). No floating-point conversion, no linear-factor rewrite and no locale-dependent formatting are permitted; the emitted token is part of the argv digest.
- Every `xfade` requires an explicit `audio` argument: `cut` (hard cut at the left clip end), `afade` (crossfade duration `D`), or `mute` (silence during overlap). No default is inferred.
- No channel up/down-mix beyond the profile layout; no `adelay`, `apad` or generated silence in v1 (gapless tracks only).

## 7. Rounding and conversion

All arithmetic is exact integer/rational: source PTS is `int64`; timeline ticks are `uint64`; rationals are `int64` numerator/positive `int64` denominator. Floating point is never canonical. Overflow or an unrepresentable denominator fails with `CompilerRoundingOverflow`.

For timeline tick `T` with timebase `tb = n/d` seconds per tick and output rate `fps = fn/fd`:

`frame_index = RoundPolicy(T · n · fn / (d · fd))`

| Policy | Rule | Use |
| --- | --- | --- |
| `cover` | floor for interval start, ceil for interval end | source-range-preserving trim/placement |
| `nearest_ties_lower` | nearest integer; exact `.5` rounds toward −∞ | profile-raster placement where the operation explicitly allows nearest |
| `exact_required` | result must be integral; else reject | audio sample boundaries and any operation declaring exactness |

Each conversion records source basis, target basis, exact pre-quantization rational, policy id, resulting integer and the exact error. A composition of conversions records every step in order and never collapses intermediate results to seconds or milliseconds. The summed error must stay within the profile tolerance for the operation; otherwise reject. Estimation is prohibited.

## 8. Seek policy

Compiler v1 does **not** emit input-side `-ss`/`-to`. Every boundary is a filter `trim`/`atrim` after decode of the declared source range, because demuxer/keyframe seek behavior is not part of the canonical timeline. A future fast-seek path requires a separate contract version and evidence that it preserves the same boundaries.

## 9. Concat and transition equality

After normalization, the compiler compares canonical stream-parameter records for every concat/xfade participant: codec and parameters, width/height, sample aspect ratio and display aspect ratio, pixel format, rational frame rate, timebase, sample rate, channel layout and sample format. Any difference yields `CompilerNormalizationMismatch`; there is no silent re-encode fallback.

## 10. AST, argv and digest

- **AST:** `{nodes[{id, filter, params{typed}}], edges[{from, to}]}`. Parameter values are integers, rationals or closed enums; no free strings. Labels are `v0…`/`a0…`, assigned deterministically.
- **Argv:** fixed category order — global flags; one `-i` per distinct source in first-use order; `-filter_complex`; explicit `-map "[vout]"` and `-map "[aout]"`; profile codec/format options; `-f`; staging output reference. No shell string, no user path, no output name.
- **Two digests, two purposes.**
  - `plan_digest` is the **pure compile output**: `sha256:` over JCS of `{compiler_version, registry_version, timeline_digest, project_snapshot_digest, profile_digest, ast, argv}` excluding the digest field itself. Identical compile inputs must yield one `plan_digest`; it contains no path, host, environment, reservation or time value.
  - `execution_binding_digest` is **per attempt**: `sha256:` over JCS of `{plan_digest, input_artifact_ids_and_digests[], cwd, environment_digest, staging_output_ref, reservation_id, ticket_epoch, idempotency_key}`. It binds the plan to the exact execution context and may differ between attempts of the same plan.
  - The RenderPlan carries both. `plan_digest` is what proves deterministic compilation; `execution_binding_digest` is what proves the rendered bytes correspond to the admitted inputs, environment, staging target and fence. A Host receipt binds both; mismatching the plan is `CompilerDigestMismatch`, mismatching the execution binding is `ExecutionBindingMismatch` (quarantine, no publication).

## 11. Trusted boundary and Host re-validation

The compiler runs inside the trusted domain-execution boundary, never in model context and never from tool arguments. The Host receives the AST together with the argv and independently validates before spawn: node filter ∈ v1 allowlist; params within declared bounds; edges acyclic and type-correct; labels defined once; inputs equal the admitted artifact bindings; output equals the unique staging binding. Unknown node, filter or parameter rejects the plan (`CompilerFilterNotAllowed`) before any process is created. The Host records compiler identity digest and AST digest in its receipt; a mismatch with the plan digest is `CompilerDigestMismatch`.

## 12. Failure codes

| Code | Meaning | Disposition |
| --- | --- | --- |
| `CompilerUnsupportedOp` | op not in v1 registry | reject timeline candidate |
| `CompilerScopeViolation` | out-of-registry parameter (crop/rotation/overlay/playback-rate) | reject; needs plan revision |
| `CompilerInvalidTimeline` | bounds, gap/overlap, duration mismatch | reject before admission |
| `CompilerNormalizationMismatch` | concat/xfade participants not uniform | reject; requires timeline change |
| `CompilerRoundingOverflow` | unrepresentable rational/overflow/tolerance breach | reject; no float fallback |
| `CompilerFilterNotAllowed` | unknown/disallowed node (Host or compiler) | reject before spawn |
| `CompilerDigestMismatch` | plan/AST/receipt digest inconsistency | quarantine; reconcile |
| `ExecutionBindingMismatch` | receipt inputs/env/staging/reservation/fence differ from the admitted execution binding | quarantine; no publication; reconcile |
| `CompilerProfileUnsupported` | profile field unsupported by compiler/Host | reject admission |

## 13. Non-claims

This contract does not claim FFmpeg version/build behavior, codec quality, render speed or cross-platform determinism. The FFmpeg build, demuxer/decoder/filter allowlists and Host enforcement remain profile-pinned and **UNVERIFIED** until implemented and tested per [RenderPlan security](render-plan-security.md).
