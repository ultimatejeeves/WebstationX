# PS2 core accuracy work

This is the development direction starting October 4, 2026: improve shared hardware
and BIOS behavior, keep the patched Play! baseline, and turn each reproduced defect
into a regression that does not need a particular commercial game. Games remain
integration tests. A title reaching a menu, or reporting 60 vblanks per second, is
not evidence of correct gameplay.

Current installed core: **`a9435d52a35a`**, validated and installed locally on
October 4. The third iteration below resolves the reproduced sound-clock and
vector-multiply defects. Earlier sections retain the evidence and promotion decisions from those
iterations.

## First implementation: EE memory access

Patch `play/0044` addresses three shared defects found in the code audit:

- `LD`, `SD`, `LDL`, `LDR`, `SDL`, `SDR`, `LQ`, `SQ`, `LWC1`, `SWC1`,
  `LQC2`, and `SQC2` now use the existing TLB exception check before accessing
  memory or writing a destination. Checks also precede the zero-register shortcut.
  These instructions previously bypassed checks already used by `LW` and `SW`.
- EE compiled blocks distinguish whether TLB checks were enabled when compiled.
  The in-memory cache and persistent Wasm cache both include this input. Changing
  the mode drops active block lookups and links before the next execution slice.
  Installing a handler, restoring a state, or restarting with retained code can no
  longer accidentally reuse the other mode's code.
- Wasm `LQC2`/`SQC2` can access memory through the translated/helper path instead
  of executing an unconditional trap. The four-word fallback for all four
  quadword instructions aligns the address to 16 bytes, matching the direct-page
  and native quadword paths. Previously `LQ`/`SQ` used the unaligned address there.

The [Sony EE instruction manual, version 6.0](https://studylib.net/doc/28989088/ee-insns)
specifies TLB exceptions for memory instructions and masked low address bits for
`LQ`/`SQ` (printed pages 141 and 287). This patch extends the current HLE exception
model; it does **not** implement a complete EE MMU.

`tests/ee-memory-test.cpp` compiles and executes actual EE blocks through the same
Wasm JIT and core libraries as the browser. It uses a controlled translation and
exception callback so that access suppression is observable independently of HLE
TLB matching. Its 260 checks cover:

- Faults in the first and second instruction, with ordinary and zero destinations,
  direct-page and helper paths, read/write direction, negative address offsets,
  EPC, unchanged registers/RAM, and suppression of translation/memory callbacks.
- All 16 address offsets for four quadword instructions on both access paths,
  checking all destination words and neighboring memory.
- Both TLB mode transitions in compiled and imported persistent caches, active
  linked blocks, and retained code across resets.

On the original source, the fault cases failed, the translated COP2 path trapped,
misaligned quadwords failed, and cache tests reused unchecked blocks. The patched
suite passes. Expected values are instruction behavior, not game-specific hashes.

The trial build script also now stops on a compiler/linker error. Previously its
output-filter pipeline could hide failure and copy an older core as the candidate.

### October 4 validation

Source change: `fa67e3b4` on the core's `webstationx` branch, based on `9a46242c`.
Tested core: `450b7448e948`; previous installed core: `805096353c42`. The first
THPS4 single-thread comparison used candidate `e23a54786fd2`; the final revision
uses the executor's existing unlink bookkeeping when changing TLB mode. Its
instruction suite and subsequent integration checks were rerun on the final build.

| Check | Result |
|---|---|
| EE Wasm component suite | 260 checks, zero failures |
| Mirra and ATV2, 120 frames from gameplay states, thread off | All eight fingerprint fields match the previous installed core |
| THPS4, 120 frames, synchronous VPU1 | All eight fingerprint fields match the previous installed core |
| THPS4, asynchronous VPU1, gameplay save/load | Save and load succeeded; rendering continued afterwards |
| Enter the Matrix, asynchronous VPU1, gameplay save/load | Save and load succeeded; gameplay image inspected after load |
| Enter the Matrix, fresh boot | Reaches the main menu without a reported browser/worker exception |
| App PS2 unit and audio suites | Pass |
| App TypeScript and production build | Pass; existing large-bundle warning remains |

Raw logs, screenshots and comparison reports: `work/accuracy-memory/`,
`work/accuracy-*.log`, and `work/ee-memory-tests/`. The previous binary is retained
as trial `accuracy-baseline-805096353c42` so comparisons remain meaningful after
installing the candidate. The changes are installed locally; no server deployment
was performed. These short runs do not establish new title compatibility, complete
game coverage, hardware equivalence, or mobile performance.

## Second implementation: data TLB semantics and VU flag lifetime

The next iteration adds shared data-side MMU behavior, with no title identifiers:

- `TLBWI` and `TLBR` address all 48 entries correctly. The old bitwise mask aliased
  entries 16-31 onto 0-15. Reserved indices no longer alias valid entries.
- `TLBP` now searches by paired VPN, page mask, ASID and the combined global bit,
  including invalid entries and virtual page zero. All three instruction helpers
  are registered and exported on Wasm; the old read/write path trapped there.
- Translation and permission checks share the matcher. Large pages mask low PFN
  bits. Misses and invalid pages raise load/store faults; writes to clean valid
  pages raise modification faults. BadVAddr, EntryHi and Context are updated.
- Faulting instructions establish EPC and Cause.BD for taken and untaken branches,
  preserve EPC/BD under EXL, and suppress the memory access. Common TLB handlers
  can be registered, survive RAM-state restoration, and are selected for invalid,
  modification and nested refill exceptions. TLB exceptions do not require enabled
  interrupts. Pending branches are discarded before entering a handler.
- VU flags remain available after later microprogram uploads. The prior scan of
  current micro memory could discard flag production before a reader existed.
  Removing that scan preserves existing local instruction-level MAC flag analysis.

The [Toshiba TX79 architecture manual](https://lukasz.dk/files/tx79architecture.pdf)
provides the paired-page, ASID/global, exception-register and EPC/BD rules used by
these tests. This is still an HLE data MMU: default kernel mappings remain built in,
custom scratchpad remapping and full instruction-fetch faults are not implemented,
and invalid-page clients with no common handler retain the historical refill-handler
fallback. There are no console hardware traces in this repository validating the
whole MMU. Those limits must not be confused with full hardware equivalence.

The EE suite now has 525 passing checks. It executes real COP0/load instructions
and the actual HLE matcher, handler-registration syscalls and exception router.
It includes retry after repairing a mapping and restoring handler state. Before
these fixes, matching/permission cases failed and TLB instruction compilation
trapped. The VU upload regression also fails before the change and passes after it,
including retained compiled blocks across reset.

### Arithmetic failure recorded at the end of the second iteration

`tests/run-vu-tests.sh` runs all 21 upstream VU tests on Wasm and the new upload
regression. Assertions now throw with their source location instead of relying on
undefined null-pointer writes, and failures produce a nonzero process exit status.
An intentional `--assertion-self-test` verifies that failure reporting works.

At that revision, twenty upstream tests pass. `TriAceTest` fails on both the previous implementation
and this candidate: VF3.z is `4b1ed5e8`, expected `4b1ed5e7`. A nearest-rounded
Wasm multiplication is one ULP above the truncated product in that sequence; the
source also disables its accurate ADDi helper on Wasm. The suite keeps the original
expected value and reports failure. This is a tracked arithmetic defect, not a new
regression or a passing full VU suite. Correct general arithmetic needs its own
edge-case fixtures and performance assessment; adding another block hash exception
would not meet this project's direction.

Run `tests/run-vu-tests.sh --uploads` for the isolated passing lifetime regression.
At that revision the full command intentionally remained red. The third iteration
below fixes this discrepancy without changing the expected result.
Raw evidence is in `work/ee-tlb-before.log`, `work/ee-tlb-after.log`,
`work/vu-uploads-before.log`, `work/vu-uploads-after.log`, `work/vu-upstream-before.log`,
`work/vu-after.log`, and `work/vu-assertion-self-test.log`.

### Second-iteration integration and promotion status

Core source commits: `6176c479` (data TLB) and `2346f285` (VU flag lifetime/tests).
The final combined trial is `accuracy-tlb-vu`, binary `89f67a2e0c88`. Patches 0045
and 0046 have been exported and checked against the committed source. The source
checkout is clean. The installed/public core remains `450b7448e948`: **the new
candidate has not been promoted or deployed**.

The final six fixed-frame comparisons against `accuracy-memory` matched all eight
fingerprint fields for THPS4/off, Mirra/off+sync and ATV2/off+sync. THPS4/sync had
an EE RAM mismatch, so the comparison script correctly returned failure. An earlier
TLB-only trial showed the inverse THPS4 result (off differed, sync matched). Two
same-baseline control pairs matched. This does not establish the mismatch's cause
and must not be reported as a clean six-case pass.

Paused-state byte inspection found 121 differing RAM bytes in the THPS4/sync pair,
including SIF DMA bookkeeping and a game RAM location; the full state also differed
in flag pipeline histories and SPU state. The THPS4/off snapshots were byte-identical
across every archive member. ATV2's full states differed only in 17 VU1 bytes in the
flag pipeline region, consistent with restoring flag production; its compared RAM,
GPR and vector values matched. The existing eight-field fingerprint does not cover
all device or flag state, which is why full snapshots are retained for diagnosis.

A paired 35-second ATV2 run with VPU1 off and catch-up disabled measured 34.3 versus
30.5 delivered pictures/sec over the last ten samples (baseline versus candidate),
about 11% lower. These are local single-pass measurements, not a cross-device
performance claim. The new flag behavior needs optimization that preserves flags
observable by future uploads; reinstating the whole-memory scan is not a correct fix.

THPS4 and Enter the Matrix also completed 35-second asynchronous VPU1 gameplay
runs with successful save/load cycles at 18 seconds. The final ten samples delivered
59.8 and 59.9 pictures/sec respectively; post-load gameplay images were inspected,
and neither run reported a browser/worker exception. These are lifecycle smoke
checks, not long-play compatibility claims.

Raw reports and snapshots are in `work/accuracy-tlb/`, `work/accuracy-tlb-vu/`,
`work/accuracy-baseline-control/` and `work/ps2-bench-states/compare-*`. Promotion
requires explaining the intermittent THPS4 state difference. The known arithmetic
failure and measured cost remain explicit follow-up work.

## Third implementation: SPU state and general Wasm vector multiplication

Play patches 0047/0048 and CodeGen patch 0007 change shared implementation paths,
with no game identifiers or block-hash exceptions. Source commits are `cb5a8df2`
(SPU state), `63f2ddb2` (core arithmetic selection), and CodeGen `fd9c088`.
The combined trial is `accuracy-rounding-state`, binary `a9435d52a35a`.

### Reproduced cause of the THPS4 mismatch

The old SPU snapshot omitted its source clock, input sample cursor and buffer,
partially accepted input DMA position, bypass setting, and reverb tick phase.
Loading therefore inherited state from the previous execution. In the original
mismatched pair, voice zero had the same pitch, 1896, but source rates of
`0x04fbd7a0` and `0x056cac00`: exactly `44100 * 1896` and `48000 * 1896`.
Subsequent pitch writes used whichever base clock boot had happened to establish.

The benchmark now accepts `bootwait` in milliseconds. A same-core control using
`accuracy-tlb-vu`, the same THPS4 state, 120 frames and catch-up disabled reproduces
the EE RAM difference when loading after 100 ms versus 5000 ms. The captured
single-thread pair has exactly the same 121 differing RAM bytes and the same
44.1/48 kHz source-clock split as the earlier intermittent failure.

New snapshots explicitly save and restore both the clock and buffered input state.
Legacy snapshots cannot reconstruct an omitted FIFO; loading them deterministically
empties it and uses the machine's conventional clock (48 kHz for PS2, 44.1 kHz for
PS1), instead of keeping the previous run's values. Existing per-voice sample rates
remain restored as before. This is backward-compatible loading, not exact recovery
of information absent from old snapshots. The host's output sampling rate stays a
host setting.

The SPU component test replays DMA acceptance and audio samples across 96 cases
covering both cores, multiple FIFO phases/partial writes, clocks and bypass modes.
Sixteen further cases verify future pitch writes after clock changes and new/legacy
restores. All 112 pass; the original 24-case input-buffer reproducer had 18 failures
before the fix. This does not claim complete serialization of every SPU2 wrapper
register or hardware-accurate SPU DMA timing.

### Arithmetic and flag extraction

The Wasm vector multiplier now corrects nearest rounding toward zero for finite
binary32 products. A binary64 product holds the exact product of two binary32
significands. Comparing its magnitude with the nearest binary32 result determines
whether to subtract one ULP from that result's magnitude. This handles signs,
zeros, gradual underflow and finite overflow without host rounding-mode changes.
The backend exposes an opt-in switch; Play enables it for its generated CPU blocks.
It applies to shared vector multiply operations, including those inside multiply-add
and multiply-subtract instructions. It does not change scalar FPU multiplication
or implement every PS2 floating-point operation.

The opcode implementation uses the standard
[WebAssembly SIMD instructions](https://github.com/WebAssembly/spec/blob/main/proposals/simd/SIMD.md).
The regression oracle independently multiplies integer significands and performs
integer truncation; it does not reuse the emitted floating-point algorithm.
All 320,000 checks pass, covering signed finite edge cases, seeded random inputs,
local-register allocation on/off and an aliased destination. The uncorrected backend
fails 168,432 of those checks. All 21 upstream VU tests, including the unchanged
TriAce result, and the future-upload regression now pass.

This fixes the reproduced rounding defect within Play's existing floating-point
model. PS2 extended exponent behavior, multiplier low-bit peculiarities, denormal
policy and add/subtract rounding still need hardware-derived fixtures. Passing this
suite is not proof of a complete PS2 floating-point implementation.

Sign/zero extraction now selects the original sign bytes and uses an 8-bit-lane
mask, avoiding sign expansion and a 16-bit-lane mask. Its 40,000 independent checks
cover all combinations of eight edge values (including negative zero, subnormals,
infinity and NaN), plus random bit patterns and both local-allocation modes.
MAC/sticky production and pipeline timing stay intact. An experiment coalescing
identical sticky writes passed 76,800 queue-timing comparisons but did not improve
the gameplay measurement, so it was rejected. No whole-memory flag scan returns.

### Third-iteration integration and performance

Final component results: 525 EE checks, 112 SPU replay/clock checks, 320,000 vector
multiply checks, 40,000 sign/zero checks, and all 21 upstream VU tests plus uploads
pass. All 48 Play patches and all seven CodeGen patches replay from the pinned
baselines to the committed source exactly (excluding Play's separately managed
CodeGen gitlink).

The check also caught Git normalizing embedded CRLF context in the saved patches.
`patches/.gitattributes` now disables text conversion for patch files. Fifteen
existing patches retain their original line endings again; their normalized text
is unchanged. Replay was repeated using the staged Git blobs, so the committed
artifacts, rather than only the source checkout, are covered.

All six same-core boot-delay pairs pass: THPS4, Mirra and ATV2, each in single-thread
and synchronous VPU1 modes. Every pair is byte-identical across all 80 captured
save-state members, not only the eight fingerprint fields. The old THPS4 control
fails in both modes. These comparisons establish repeatable restoration for the
tested workloads; they do not establish equivalence to console hardware or to the
previous arithmetic results.

Two sequential 65-second ATV2 runs, VPU1 off and catch-up disabled, measured 25.0
versus 24.8 delivered pictures/sec over the final ten samples: corrected arithmetic
trial `dfe184c403d8` versus the previous `89f67a2e0c88` candidate. This is a local
single-pair result, effectively equal; it does not establish a cross-device speedup
or eliminate the earlier cost of restoring flag correctness. The initial shorter,
cold run substantially understated warmed performance. The final sign/zero emitter
build measured 25.2 delivered pictures/sec in the same 65-second workload. The
small difference is within the variation of these single runs; no speedup is claimed.

THPS4 and Enter the Matrix each completed a 35-second asynchronous VPU1 gameplay
run with a save/load cycle at 18 seconds. Both reported `saved loaded`, resumed
rendering, and had no reported browser/worker exception. The final ten samples
measured 60.0 and 59.8 delivered pictures/sec respectively. Post-load screenshots
were inspected. These are short lifecycle checks, not long-play compatibility
claims.

The tested `a9435d52a35a` binary is now installed in `public/cores/play/` and its
cache-busting version is updated. Its bytes were verified against the tested trial.
This also promotes the previously held TLB and VU flag fixes. The previous installed
`450b7448e948` core remains available as trial `accuracy-memory`. No deployment was
performed. Mobile performance, hardware equivalence, complete floating-point
semantics and further reduction of flag-correctness overhead remain open.

Raw evidence: `work/accuracy-clock-before/`, `work/accuracy-clock-after/`,
`work/wasm-arithmetic-final.log`, `work/wasm-multiply-before.log`,
`work/vu-accuracy-final.log`, `work/ee-accuracy-final.log`,
`work/spu-accuracy-final.log`, `work/perf-clock-multiply.log`, and
`work/perf-tlb-vu-repeat.log`, `work/perf-accuracy-final.log`,
`work/accuracy-thps-cycle.log`, and `work/accuracy-etm-cycle.log`. Diagnostic snapshots remain under
`work/ps2-bench-states/`.

### Fourth iteration: accurate-add edges and smaller flag code

`play/0049` fixes two Wasm integration gaps: VU ADDI ignored the existing
accurate-add hint, and the shared `FpAddTruncate` helper was absent from the
hosted import registry/export list. EE ADD.S/SUB.S blocks selecting that helper
could therefore fail to compile. Both call paths now work, including aliased
destinations and VU writes targeting the VF0 scratch result.

The helper now uses integer significands with one alignment guard bit. It
flushes exponent-zero inputs/results to signed zero, preserves exponent-255
finite encodings, and saturates overflow to the signed maximum PS2 encoding.
Its previous IEEE NaN/infinity branches, unnormalized denormal inputs and
underflow shifting are removed. Exact cancellation produces positive zero;
two negative zeros retain their sign.

The model follows the published
[PCSX2 add/subtract alignment research](https://pcsx2.net/blog/2009/ps2-vu-vector-unit-documentation-part-1/)
and [PS2Tek floating-point format](https://psi-rockin.github.io/ps2tek/).
The test expectations are **model-derived, not newly captured hardware traces**.
The independent oracle masks the smaller operand and uses double-precision
arithmetic; it does not call or reproduce the helper's integer normalization.
Fixed cases, all exponent fields, guard-bit boundary gaps, seeded random patterns,
all VU destination masks, aliases, both Wasm allocator modes, flag latency and
actual EE ADD.S/SUB.S instructions total **392,162 passing checks**. The initial
261,474-check reproducer failed 4,283 checks before the changes.

This retains existing accurate-block selection. It does **not** enable software
addition globally, change the ordinary vector add/subtract emitters, or implement
the remaining multiply/divide/square-root edge cases. U/O/I and their sticky
flags remain incomplete. Full PS2 floating-point equivalence remains open.

`play/0050` assembles STATUS with boolean comparisons and shifts, avoiding five conditional blocks.
The STATUS test passes **400,000 complete CPU-state comparisons**, including every
8-bit MAC/sticky combination with D clear/set, random queue indices and pending
write times. Flag queues, production and latency are retained.
Existing 40,000 sign/zero checks, 320,000 multiply checks, all 21 upstream VU tests,
upload regressions, 525 EE checks and 112 SPU checks also pass.

The generated STATUS test module shrinks from 1,371 to 1,250 bytes with locals,
and from 1,608 to 1,548 without. Its single-run microbenchmark is approximately
14 ns/call before and after; this is a code-size improvement, not evidence of a
runtime speedup. A separate sign/zero extraction experiment reduced its test
module from 187 to 184 bytes but showed no repeatable microbenchmark benefit
(roughly 3.6–4.2 ns/call across both versions). It was rejected; the previous
byte-mask emitter remains in place. Its patch is retained only as
`work/rejected-sign-extraction.patch`.

The initial candidate `accuracy-fp-flags-final`, binary `f8cce5eaa044`, matches all eight
fixed-frame machine fingerprint fields for THPS4, Mirra and ATV2 in both VPU1-off
and synchronous modes, with catch-up disabled. These comparisons cover six
workloads against `accuracy-rounding-state`; they do not compare entire save-state
archives or prove that either core matches hardware.

Warmed ATV2 measurements used 65-second runs, VPU1 off, catch-up off and no
limiter. In A/B/B/A order, the baseline measured 28.2 and 28.9 delivered
pictures/sec over the final ten samples; the initial candidate measured 28.1
and 27.4. After dropping the extraction experiment, `accuracy-fp-status`
(`709620516e21`) measured 28.7, followed by a baseline repeat at 24.7.
That variation prevents a reliable speedup claim. These are desktop measurements;
no target-device or mobile performance result is established.

The final `709620516e21` build also passes all six fixed-frame comparisons against
the saved baseline fingerprints. Its component rerun passes all 392,162 arithmetic
checks and 400,000 complete-state status comparisons; the retained sign/zero
emitter passes the existing 320,000 multiply and 40,000 sign/zero checks.

THPS4 and Enter the Matrix each passed a 35-second asynchronous VPU1 probe with
a save/load cycle at 18 seconds. Both returned `saved loaded`, resumed rendering,
and reported no browser/worker exception. Final-ten-sample presentation rates were
58.7 and 60.0 pictures/sec. Post-load screenshots were inspected; these are short
lifecycle checks, not long-play compatibility or hardware-accuracy claims.

The tested `709620516e21` files are installed in `public/cores/play/` with the
matching cache-busting version. The previous `a9435d52a35a` binary is preserved
as `accuracy-rounding-state`. No deployment was performed.

All 50 Play patches and seven CodeGen patches replay exactly from the pinned
baselines to the edited sources, excluding Play's separately managed CodeGen
gitlink. Raw results are in `work/vu-fp-edge-before.log`,
`work/vu-fp-edge-final.log`, `work/vu-status-before.log`,
`work/vu-status-after.log`, `work/wasm-arithmetic-round4.log`,
`work/vu-round4.log`, `work/ee-round4.log`, `work/spu-round4.log`,
`work/accuracy-round4/`, `work/perf-round4-{0,1,2,3}.log`,
`work/perf-status-{0,1}.log`, `work/sign-bench-{old,new}.log`,
`work/accuracy-status-final/`, `work/fp-status-edges.log`, `work/fp-status-flags.log`,
`work/round4-thps-cycle.log`, `work/round4-etm-cycle.log`,
and `work/patch-replay-round4/report.json`.

## Validation commands

Activate Emscripten, set `PLAY_SRC` if needed, and use Git Bash on Windows:

```bash
source /d/ps2build/emsdk/emsdk_env.sh
engine/play/tests/run-ee-memory-tests.sh
engine/play/tests/run-vu-tests.sh
engine/play/tests/run-spu-state-tests.sh
engine/play/tests/run-wasm-multiply-tests.sh
engine/play/tests/run-vu-fp-edge-tests.sh
engine/play/tests/run-vu-status-tests.sh
engine/play/build-dev.sh accuracy-rounding-state
```

The test runner rebuilds `PlayCore`, derives JIT helper imports from the hosted VM,
links against its actual libraries, and exits unsuccessfully on failed checks.
Logs and generated test binaries go to `work/<suite>-tests/`.

For deterministic game regressions, start the bench with `DISC_DIR` pointing to
`library/`, then compare the installed core with a named trial build:

```powershell
$env:DISC_DIR = (Resolve-Path library).Path
node engine/play/bench/server.mjs 8344
# In another terminal:
node engine/play/tests/compare-core-states.mjs --reference accuracy-baseline-805096353c42 --candidate accuracy-memory
```

The comparison runs 120 emulated frames from each local THPS4, Mirra and ATV2
gameplay snapshot, with catch-up disabled and VPU1 in `off` and `sync` modes. It
requires a successful state load and completed fingerprint, rejects reported
browser exceptions, compares every machine field except elapsed time, writes a
JSON report, and returns failure on differences or missing evidence. Use
`--reference <trial-name>` for a preserved baseline, `--cases thps,mirra,atv`,
`--modes off,sync`, and `--secs 30` for slower hosts. `--save-states` captures the
paused machine into `work/ps2-bench-states/` for byte-level diagnosis.
`--reference-bootwait 100 --candidate-bootwait 5000` varies pre-load boot progress;
use the same core on both sides to detect state leaking across loads. These tests require local
disc images and the existing states; neither is distributed with the tests.

Matching fingerprints establish that these workloads compute the same machine
state. They do not prove that the baseline is hardware-correct, that asynchronous
threading is deterministic, or that rendering is accurate. Keep fresh boot,
gameplay, audio and save/load tests alongside them.

## Next work, ordered by correctness dependencies

| Area | Evidence in the current source | Next implementation and acceptance test |
|---|---|---|
| EE MMU and exceptions | Data matching, COP0 TLB instructions and fault routing now have component coverage. HLE default mappings, instruction fetch and custom scratchpad mappings remain incomplete. | Obtain hardware traces; add fetch-fault and scratchpad fixtures before replacing HLE mappings or removing handler fallbacks. |
| EE/VU floating point and flags | Accurate EE ADD/SUB and VU ADDI now work on Wasm with model-derived range/denormal tests; ordinary vector add/subtract still uses host arithmetic. General Wasm multiply passes all 21 upstream tests, and smaller flag code preserves existing state. | Obtain hardware traces for add/subtract, signed underflow/overflow, multiplier low bits, divide/square-root and U/O/I flags. Extend uniform arithmetic only after those fixtures and performance checks, including VU0 mapped reads of VU1 state. |
| Guest timing | `CPS2VM::TakeCatchUpTicks` advances guest time based on host lateness; the existing VU/GIF model does not account for all device work in guest cycles. | Establish cycle-based VU/VIF/GIF completion and interrupt tests. Replace host-dependent timing shortcuts only when the modeled devices can deliver the same ordering under different host loads. Always disable catch-up in accuracy comparisons. |
| DMA/VIF/GIF ordering | The asynchronous VPU1 queue has already required completion, interrupt and snapshot fixes. | Add small command-stream tests for partial transfers, FIFO backpressure, stalled interrupt delivery, DMA STR completion, reset and save/load. Compare single-thread and synchronous modes exactly; validate asynchronous mode by observable device ordering and gameplay, not wall-time fingerprints. |
| GS memory coherence and pixels | OpenGL readback supports only part of the color/depth/format space; the software target path remains disabled after incorrect output. | Establish transfer/readback fixtures for 16/24/32-bit color/depth, aliasing, overlap, alpha, masks and scaled targets. Compare integer pixel values against hardware results, then fix format/coherence rules. Screenshot appearance alone cannot validate GS data used as commands. |
| IOP HLE and disc/SPU scheduling | Source-clock and input-buffer restoration now have replay tests. Past `CdSync` failure involved a waiter waking after another thread started a read. | Audit remaining SPU2 wrapper registers and IRQ state; add scheduler tests for multiple waiters, callbacks, cancellation, priorities and read completion. Keep boot delays and audio-rate variations in integration runs. |

The next concrete arithmetic tranche is uniform vector add/subtract rounding and PS2
range/denormal behavior beyond the selected accurate blocks, using hardware-derived
cases before broadening semantics. Device timing and GS coherence remain separate
workstreams requiring their own command-stream and hardware fixtures.

## Working rules

1. Preserve a baseline core and source revision; reproduce before changing behavior.
2. Isolate the smallest instruction or device sequence and define the expected
   behavior from a primary reference or hardware trace. Record uncertainty.
3. Change the subsystem implementation without title IDs or instruction-address
   exceptions. Retain existing compatibility options until their replacements pass.
4. Require a failing-before/passing-after component regression, fixed-frame game
   checks for unaffected workloads, and relevant lifecycle coverage.
5. Export core changes into the patch series and record the tested binary version.
   Report new game compatibility only after the affected gameplay has been tested.

The existing catch-up option is a performance compromise, not proof of original
console timing. Catch-up remains unchanged. VU flag lifetime is now tested across uploads; its
performance cost must be reported alongside integration results.
