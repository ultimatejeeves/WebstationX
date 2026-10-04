# PS2 core accuracy work

This is the development direction starting October 4, 2026: improve shared hardware
and BIOS behavior, keep the patched Play! baseline, and turn each reproduced defect
into a regression that does not need a particular commercial game. Games remain
integration tests. A title reaching a menu, or reporting 60 vblanks per second, is
not evidence of correct gameplay.

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

## Validation commands

Activate Emscripten, set `PLAY_SRC` if needed, and use Git Bash on Windows:

```bash
source /d/ps2build/emsdk/emsdk_env.sh
engine/play/tests/run-ee-memory-tests.sh
engine/play/build-dev.sh accuracy-memory
```

The test runner rebuilds `PlayCore`, derives JIT helper imports from the hosted VM,
links against its actual libraries, and exits unsuccessfully on failed checks.
Logs and generated test binaries go to `work/ee-memory-tests/`.

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
`--modes off,sync`, and `--secs 30` for slower hosts. These tests require local
disc images and the existing states; neither is distributed with the tests.

Matching fingerprints establish that these workloads compute the same machine
state. They do not prove that the baseline is hardware-correct, that asynchronous
threading is deterministic, or that rendering is accurate. Keep fresh boot,
gameplay, audio and save/load tests alongside them.

## Next work, ordered by correctness dependencies

| Area | Evidence in the current source | Next implementation and acceptance test |
|---|---|---|
| EE MMU and exceptions | `CPS2OS::CheckTLBExceptions` returns success when no entry matches; dirty/global assumptions use assertions. Fault handling does not establish full branch-delay exception semantics. | Test paired pages, page sizes, ASIDs/global entries, invalid and read-only pages, refill and modification exceptions, EPC/BD and retry. Implement exception routing together with translation, preserving the HLE kernel's default mappings. Compare with hardware test outputs before changing defaults. |
| EE/VU floating point and flags | Accurate arithmetic is selected for some blocks; `CVuExecutor::UpdateFlagUse` infers VU1 flag use from current micro memory. | Make upstream VU tests runnable on the Wasm backend with reliable failing assertions, then add hardware-derived rounding, denormal, saturation and flag-pipeline cases. Exercise flags produced by one microprogram and read after another is uploaded, plus VU0 reads of VU1 state. |
| Guest timing | `CPS2VM::TakeCatchUpTicks` advances guest time based on host lateness; the existing VU/GIF model does not account for all device work in guest cycles. | Establish cycle-based VU/VIF/GIF completion and interrupt tests. Replace host-dependent timing shortcuts only when the modeled devices can deliver the same ordering under different host loads. Always disable catch-up in accuracy comparisons. |
| DMA/VIF/GIF ordering | The asynchronous VPU1 queue has already required completion, interrupt and snapshot fixes. | Add small command-stream tests for partial transfers, FIFO backpressure, stalled interrupt delivery, DMA STR completion, reset and save/load. Compare single-thread and synchronous modes exactly; validate asynchronous mode by observable device ordering and gameplay, not wall-time fingerprints. |
| GS memory coherence and pixels | OpenGL readback supports only part of the color/depth/format space; the software target path remains disabled after incorrect output. | Establish transfer/readback fixtures for 16/24/32-bit color/depth, aliasing, overlap, alpha, masks and scaled targets. Compare integer pixel values against hardware results, then fix format/coherence rules. Screenshot appearance alone cannot validate GS data used as commands. |
| IOP HLE and disc/SPU scheduling | Past `CdSync` failure involved a waiter waking after another thread started a read. | Add scheduler-level tests for multiple waiters, callbacks, cancellation, priorities and read completion; add SPU DMA/IRQ and voice-state fixtures. Keep disc delays and audio-rate variations in integration runs. |

The next concrete tranche is MMU matching and exception routing. It depends on
the instruction and cache fixes above: a correct matcher cannot help instructions
that never call it or blocks cached without the check.

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
console timing. This work does not silently change that default or the VU flag
optimization; both need their own evidence and performance assessment.
