# PS2 core (Play! for the web, WebStationX edition)

PS2 games run on [Play!](https://github.com/jpd002/Play-) (BSD-2), compiled to WebAssembly with
Emscripten and patched for speed and for embedding in WebStationX. The build lands in
`public/cores/play/` (`Play.js` + `Play.wasm`), which the app loads on the first PS2 launch.

**Core accuracy work:** [the accuracy roadmap and regression workflow](CORE-ACCURACY.md)
tracks subsystem improvements, hardware-model limitations, EE memory fixes,
sound-state restoration, and general Wasm vector multiplication. Run
`tests/run-ee-memory-tests.sh`, `tests/run-vu-tests.sh`,
`tests/run-spu-state-tests.sh`, and `tests/run-wasm-multiply-tests.sh` for component
regressions, and `tests/compare-core-states.mjs` for fixed-frame game comparisons.

**Current validation and limitations:** see [the October 1 review](REVIEW-2026-10-01.md) (ATV Offroad Fury 2:
correct terrain, full speed, ~40 game frames per second in a race on the desktop below; what is left and why) and
[the September 30 one](REVIEW-2026-09-30.md) (Dave Mirra's loading freeze, threaded saves, limiter pacing).
Menu FPS is not a gameplay compatibility result.

Play! is the only PS2 emulator with a working browser port: it has a MIPS → WebAssembly JIT (each
compiled block of guest code becomes a small wasm module) and an OpenGL ES renderer that maps onto
WebGL2. Its HLE BIOS means no PS2 BIOS file is needed.

## Threads

```
page (main thread)          VM worker                  VPU1 worker               GS worker
 ├ UI, input sampling  ──►   EE + VU0 JIT, IOP, SPU ──► VIF1, VU1 JIT, GIF  ──►  GS emulation + WebGL2 on its own
 │  setPadState()            DMAC (block-linked wasm)   (queues from the EE)      OffscreenCanvas
 ├ disc streaming      ◄──   disc reads                                            │
 └ bitmaprenderer canvas ◄──────────────────────────── ImageBitmap per frame ─────┘ (zero copy)
```

The VPU1 worker exists when the page asks for it (`setVpu1ThreadMode(2)`, the app does on 4+ cores);
without it VIF1/VU1/GIF run on the VM worker as upstream does.

Disc images are read through `Module.discImageDevice` (`src/emu/ps2/disc.ts` in the app, `RangeDiscDevice`
in the bench): `getFileSize()` and `fetchBlock(index)` returning a Promise of that 1 MiB block's bytes (or null
once the disc is closed). The core keeps 40 blocks and reads 8 ahead, so the VM only waits on truly cold data.

The page must be cross-origin isolated (COOP/COEP headers, set by `server/index.ts` and
`vite.config.ts`) because the threads share memory. That also means PS2 games need HTTPS or localhost.

## Patches (`patches/`)

Pinned upstream: Play! `83700b2c` (0.77-12), CodeGen `a5009f7`.

| Patch | What | Why |
|---|---|---|
| play/0001 | GS host→local transfers written in page runs (`GsTransferFast.h`) | Texture uploads (PSMT4/PSMT8) were over half the GS thread; bit-identical to the per-pixel code, 1.3–2.2× faster (`tests/transfer-test.cpp`) |
| play/0002 | GS thread owns its WebGL2 context on an OffscreenCanvas; frames posted as ImageBitmaps; hosted API (`initVmHosted`, `setPadState`, async pause/resume/save/load state, presentation, resolution, volume, EE clock scale, EE PC + disassembler for profiling) | Emscripten proxied *every* GL call synchronously to the main thread; the GS and EE threads spent their time waiting on those round trips |
| codegen/0001 + play/0003 | Block linking on WebAssembly: a block tail-calls (`return_call_indirect`) the next block through a link slot in linear memory; each module instance gets its slot base as an imported global | Upstream disables linking on wasm, so every block returned to the dispatcher (38% of EE time) |
| play/0004 | Detects idle loops that poll through a call to a leaf function (T: `JAL f` → B: compare → branch back) | THPS4 spends ~half its EE time spinning on a vblank counter this way; now the VM skips the rest of the slice |
| play/0005 | Deadline-based frame pacing | The average-based limiter leaked time and settled around 55 fps even with headroom |
| play/0006 | Keep compiled EE/VU blocks across a reset when the same disc boots again | Compiling blocks is the slow part of warm-up; Continue/Restart are now instant |
| play/0007 | Disc image read in 1 MiB blocks cached in the wasm heap; misses and read-ahead requested from the page asynchronously (`discImageDevice.fetchBlock`), data written in place, VM woken with `Atomics.notify` | Every CHD hunk read was a synchronous round trip to the main thread plus 100 µs polling (more round trips); over the network the VM stalled for whole fetches, which is what made loading and FMVs stutter |
| play/0008 | `-fwasm-exceptions`, `-msimd128`, `-sMALLOC=mimalloc` | JS-emulated C++ exceptions sent calls through 34 `invoke_*` JS trampolines; dlmalloc's single lock serialized the JIT and GS threads. +20% uncapped speed |
| play/0009 | Hosted API: `takeDiscWaitMs()`, `getVblankCount()` | Bench measurement of disc stalls; heartbeat for the app's freeze watchdog |
| play/0010 | Idle strategy for threads that only yield to each other: 16 RotateThreadReadyQueue calls under 64 EE cycles apart make the EE idle for the rest of its slice; any other syscall or an interrupt ends it | THPS4's FMV threads bounce ~5.5 million times per emulated second while the IPU decodes; interrupts reset the stock bounce strategy long before its 1000-bounce threshold. FMVs went from 27–30 fps (slow motion) to 60 |
| play/0011 | GS thread runs in slices on its worker's event loop (MessageChannel yield after each picture); lost WebGL contexts rebuilt on a fresh OffscreenCanvas; per-frame timing rings (`getFrameStatsAddress`); limiter paces right before vblank start | The browser recycles each `transferToImageBitmap` buffer on the presenting thread's event loop, which the GS worker never returned to: one frame of video memory leaked per picture (27 GB in 3 min at 2x), then the GPU process died and the picture went black while the game ran on |
| play/0012 | Sound through a ring in the heap (`CSH_WsxRing`, `getAudioRingAddress`) in ~11 ms pieces, played by the page's AudioWorklet | OpenAL queued ~100 ms buffers via the main thread and started with one queued: every hiccup was a gap |
| play/0013 | Persistent compiled code cache (`WsxJitCache.h`): blocks keyed by XXH3-128 of instructions, range, category, hints and a per-type salt; the page stores entries in IndexedDB per game and core build | Skips the Jitter (2/3 of compile time) for code run in earlier sessions: 4.06 s -> 1.75 s of compiling in the 40 s after loading a level; verify mode found 0 mismatches in 13,837 hits |
| play/0014 | Frame limiter tracks how late sleeps wake up and only sleeps while the deadline is further away than that; the rest goes to idle work, then a spin | Windows wakes a sleeping thread up to a timer tick (15.6 ms) late: 466 of 537 slow VM frames in a THPS4 run were oversleeps, and 44% of pictures left more than 4 ms off the 16.7 ms beat |
| play/0015 | Precompiling: in limiter idle time and while paused, the VM thread instantiates cached entries ahead of use (first-seen order), each with link slots from an arena that the block hitting the entry adopts; `jitCacheSetPrecompile(n)` | A cache hit still cost a `WebAssembly.Module` + `Instance` (~100 µs), the hitch left when a session first reaches code. The app also gives the paused VM up to 1.5 s before resuming a save state (a level needs ~8k blocks at once) |
| play/0016 | GS column writers in wasm SIMD for column aligned PSMT8/PSMT4 uploads: four source rows become a column's 64 bytes through `i8x16.swizzle`, tables derived from `CPixelIndexor` and checked when built | Nearly every upload is column aligned (THPS4: all PSMT8, 99% of PSMT4, one piece each). Bit-identical (`tests/transfer-test.cpp`), 9.8x (PSMT8) and 19x (PSMT4) the reference, vs 2x for 0001 |
| play/0017 | Texture/palette cache: area page count kept by `SetArea`; searches stop copying each entry's `shared_ptr` | Every upload invalidates against 256 cached textures, each recomputing its page rect through a non-inlined call |
| codegen/0002 | The wasm backend takes the Jitter's register allocation onto temporaries (function locals): `UsesLocalsAsRegisters` | It reported 0 registers, so every guest register access went through linear memory. Allocation is per basic block, and every EE memory access is an if/else, so the gain is modest; a function-wide write-through cache was tried on top and measured no faster (V8 runs most blocks in its baseline tier) |
| play/0020 | Debug: which unit the VM thread is emulating, one word per thread sampled by the page (`probe.mjs --vmprof`) | Where the time goes: in THPS4 the VM thread was EE 46%, VU1 20%, VIF1 12%, GIF 9% |
| play/0021 | Debug: machine fingerprint N frames after a state load or boot (`?hash=N`, `getStateHash`) | Proof that a core change emulates exactly the same thing (RAM, registers, VU and IOP memory) |
| codegen/0003 + play/0022 | **VIF1, VU1 and the GIF on a thread of their own** (`ee/Vpu1Thread.*`), `setVpu1ThreadMode(0/1/2)` before `initVmHosted`. The EE copies DMA channel 1/2 transfers and FIFO writes into two queues and carries on; it waits (`Drain`) only before looking at VIF1/GIF/VU1 registers or memory. Display register writes and the end of a frame (`FinishFrame`) go through the queue, so the GS sees everything in order. VU1 code is compiled and run on that thread (its executor is rebuilt there: wasm function tables and the helper import table are per thread), and the Jitter instance is per thread | That work was ~40% of the VM thread. Synchronous mode (drain after every hand-over) emulates exactly what one thread did: fingerprints match for THPS4 and Harry Potter (RE Outbreak's boot isn't deterministic even single threaded: disc timing). THPS4 uncapped, all variants run side by side on a loaded machine: 61.6 fps single threaded, 87 fps with the thread (+40%). It still drains once a frame: THPS4 asks whether the GPU is idle (VIF1_STAT at EE pc `0x2b0e38`) |
| codegen/0004 + play/0023 | Idle loop counters reset on state load (not part of a state); debug hooks: EE block IR dump, locals switch, hash timing | Made the fingerprint independent of how long the machine ran before the load |
| play/0024 | Debug: GS thread work counters per frame (`getGsStats`): transfers and how many changed GS memory, texture and palette uploads, CLUT reads, draws, vertices, texture rebinds, register writes, mailbox calls; the bench prints them with `--vmprof` | What a frame costs the GS thread, which is what a phone's GPU driver will multiply |
| codegen/0005 | Encode function body sizes using the actual LEB128 size of each local count | Large ATV2 VU1 blocks with 128+ locals generated invalid wasm and killed a worker |
| play/0025 | Format-aware local GS copies, including color/depth readback; restrict the framebuffer shortcut to compatible full copies | ATV2 uses rendered pixels as VIF commands: wrong formats or alpha corrupt the command stream |
| play/0026 | Don't sleep a full frame after missing a deadline; reuse completed drains until new work/kicks; retry VIF after a VU program completes | Removes avoidable delay and millions of repeated lock/timer operations in polling-heavy games |
| play/0027 | Recheck `CdSync` after a sleeping IOP thread wakes; reschedule released waiters | A higher-priority disc client can start another read before a lower-priority waiter resumes. Returning early let Mirra's level loader parse stale bytes as a directory and hang |
| play/0028 | Rebase the frame deadline after a hitch or late wakeup, keeping sub-ms timer noise on the cadence | Prevents the burst of unthrottled catch-up frames that followed 35–70 ms hitches; preserves normal pacing and uncapped mode |
| play/0029 | Deliver pending worker interrupts into device state before saving; discard stale interrupts on load/reset | A VIF interrupt stall must retain the interrupt that releases it |
| play/0030 | Defer capture until vector queues are empty, letting the normal VM loop resolve stalls | Parked queues can still contain accepted DMA bytes and GS calls. Saves briefly advance a paused machine to a safe boundary, or fail after five seconds rather than produce an incomplete state |
| play/0031 | **Software rasterizer for render targets a game downloads** (`gs/GsSwRaster.h`): draws straight into GS memory by the GS rules (top-left fill, 4 bit bilinear weights, mip level from Q/L/K, integer blending and tests, any frame/Z format). A target becomes a software one when the game downloads it, or downloads memory it copied it to | ATV Offroad Fury 2 computes its near terrain on the GS: VIF codes drawn as flat sprites, vertex bytes from noise textures blended per mip level, heights from interpolated Z, copied column by column into Z buffer memory and downloaded as VIF packets. A GPU can't give those bits back (alpha kept at twice its value, no mip levels, float depth): the terrain came out as stripes |
| play/0032 | **Real-time catch-up** (`CPS2VM::TakeCatchUpTicks`, `setCatchUp`): once a frame is overdue the EE cycles it is behind by count as run (bounded: time spent waiting on the other threads, plus three cycles per cycle run). Nothing is skipped while emulation is on schedule. Debug counters: `getEeStats`, VU1 pc and disassembly, game frame counters in `getGsStats` | The vector unit and the GS take no emulated time, so a game that waits for its display list before every flip drew 60 frames per emulated second however long they took, in slow motion (ATV2: 30% speed). A machine that can't keep up now makes the game drop frames at full speed, with sound and timers in real time |
| play/0033 | Hand-overs spin before they sleep (`setVpu1SpinCount`), condition variables and the GS mailbox signal only a waiting receiver, clock reads only around real waits; **VU1 skips MAC and sticky flags nothing in micro memory reads** (`CVuExecutor::UpdateFlagUse`); software rasterizer row tables and lazy texel decode | ATV2 hands over between the EE and VIF1 260 times a frame. Every VU1 FMAC instruction computed and queued sign/zero flags (about ten IR statements each) that its microcode never reads: 25% of the VPU1 thread |
| play/0034 | **DMA channel 1 stays busy until the VPU1 thread took its data** (`CChannel::SetBusyHandler`); reading VIF1_STAT while a VIF1 interrupt is on its way is idle time; GS register writes handled in runs (`WriteRegistersImpl`: no virtual call or atomic per write, drawing context compared only after a context register was written, strip vertices converted once), texture parameters set only when they change; `vifTrace`, VU1 IR dump | The thread's queue takes a whole display list at once, so the channel looked finished at once: ATV2 moved on to the next frame's texture list while VIF interrupts of the list in flight were still being served (wrong textures, garbage downloads) with the thread on; one thread and synchronous mode were right. The GS thread was the bottleneck after that |
| play/0035 | A frame may end up to 8 ms late with catch-up without the limiter restarting its cadence | Waits are counted once they return, so frames routinely end a little late: restarting the cadence each time cost 1.5% of speed (sound underruns) |
| play/0036 | A VIF1 interrupt from the thread ends the EE's slice and is raised 256 cycles later instead of 4096 (asynchronous mode); VPU1 stall/idle counters; 16/32 bit texture updaters walk rows with the page offset table | The stalled VIF waited up to two EE slices for each of ATV2's 130 interrupts a frame |
| play/0037 | The draw context caches (texture parameters, converted vertices) are reset with the GL context | A rebuilt WebGL context starts its texture names over |
| play/0038 | **Saving hands the GS thread the register writes still waiting in the write buffer; loading drops them and lets the GS thread finish first**; `getPipelineState` (VIF1/GIF/DMA/INTC registers and the thread's queue, for stall reports) | With the VPU1 thread a state is captured in the middle of a frame. Up to 255 register writes were neither in the state nor dropped on load: they were drawn into the loaded frame later. In ATV2 that put a stray VIF code into the downloaded terrain packets about one load in four, and VIF1 stayed stalled on a MARK the game's interrupt handler didn't know |
| play/0039 | **The software rasterizer is off by default** (`setSwRaster(true)` / bench `?swraster=1` turns it back on) | Entering a race from the menus (and some states) drew translucent sheets and spikes over ATV2's track: the software rasterizer computed some terrain batches wrong. With it off, the GL path's downloads give a clean track at 1x/2x/3x and the same speed (the stripes play/0031 was written for were most likely the DMA channel 1 bug fixed in play/0034). THPS4 and Mirra never used it (0 software prims) |
| play/0040 + play/0041 | Register TLB exception helpers with the Wasm JIT; restore TLB mode after state loading | Checked loads must compile in the browser, and state restores must select the matching translation mode |
| play/0042 | Runtime console logging and EE kernel state inspection | Diagnose core failures without recompiling for every trace |
| play/0043 | Download rendered 32/24-bit color buffers through GL readback; GS memory inspection tools | Drawn pixels must be brought back into GS RAM before a host download |
| play/0044 | TLB checks for wide/FPU/COP2 memory instructions; mode-aware EE code caches and active-block invalidation; translated Wasm COP2 quadword access and alignment | Prevent skipped memory faults, reuse of unchecked code, translated vector-access traps, and misaligned quadword corruption; 260 executable Wasm regression checks |
| play/0045 | Shared paired-page/ASID/global TLB matching; all 48 indexed slots and probing; data faults, EPC/BD and common-handler routing | 525 EE Wasm checks cover instructions, permissions, handler state and retry; preserves documented HLE limitations |
| play/0046 | Preserve VU flags across future microprogram uploads; reliable upstream test assertions | Upload regression now passes; Wasm runner exposes the pre-existing Tri-Ace one-ULP arithmetic failure (20/21 upstream tests pass) |
| play/0047 | Restore SPU input FIFO, DMA cursor, bypass, reverb phase and source clocks; deterministic legacy clock fallback | 112 replay/clock checks; fixes boot progress leaking into restored audio and the reproduced THPS4 state mismatch |
| codegen/0007 + play/0048 | General Wasm vector multiply truncation and simpler sign/zero extraction | 320,000 multiply and 40,000 flag checks; all 21 upstream VU tests now pass without changing expected results |


## Build

Needs git, CMake, `ninja` (`pip install ninja`) and an activated Emscripten SDK (6.0.10 tested):

```bash
source /path/to/emsdk/emsdk_env.sh
engine/play/build.sh
```

The script clones Play! into `work/play-src` (override with `PLAY_SRC`), applies the patches on a
`webstationx` branch, builds, checks the Emscripten worker message it relies on, and copies the core
into `public/cores/play/`. To change the core, edit on that branch, commit, and re-export:

```bash
git -C work/play-src format-patch -o "$PWD/engine/play/patches/play" 83700b2c..webstationx -- . ':!deps/CodeGen'
git -C work/play-src/deps/CodeGen format-patch -o "$PWD/engine/play/patches/codegen" a5009f7..webstationx
```

## Bench

`bench/` is a bare page around the core (no app UI) for measuring it on the real GPU:

```bash
node engine/play/bench/server.mjs 8123          # serves public/cores/play and discs from PS2/
node engine/play/bench/probe.mjs --disc "Game.chd" --secs 120 --press "60:Enter,75:KeyZ"
node engine/play/bench/probe.mjs --query "state=thps4-foundry.st" --cpuprof 40:10 --pcprof 40:6
```

Each second the bench prints fps, the worst gap between presented frames (hitches), disc blocks requested and
how long the VM thread was actually blocked on them. `DISC_DELAY_MS=40` on the server delays every range
request, like the app's server across a network. `jit` in the query loads the core from `/corejit/`, which
counts JIT block compiles (`jitwrap.js`); `bench/callers.mjs <cpuprofile> <function>` groups a hot function's
samples by call stack. `CORE_DIR=<dir>` serves another build, for A/B runs on a second port.

Trial builds side by side on one server: `engine/play/build-dev.sh <name> [--install]` builds the Play! tree as it
is (uncommitted work included) into `work/cores-trial/<name>`, and the page loads it with `core=<name>` in the query.
More query switches: `catchup=0` (a slow machine slows the console down, as before play/0032), `spin=N`,
`gstrace=N` / `viftrace=N` (trace the first frames after a state load: diffing a synchronous and an asynchronous run
is how the DMA bug of play/0034 was found). More probe flags: `--vuprof at:secs` (VU1 pc histogram and the microcode
disassembly), `--pcprof` also writes the whole histogram and its share per 256 bytes of code.
`bench/top.mjs <cpuprofile> [count] [--busy]` ranks a thread's self time. In the page console:
`Module.getEeStats()`, `Module.getVpu1Stats()`, `Module.getGsStats()` (`bufferFlips` / `newFrames` are the game's own
frame rate, which is no longer the vblank rate), `Module.vifTrace(n)`, `Module.debugRequestVu1BlockDump(pc)` then
`Module.debugTakeEeBlockDump()`.

**Android.** `probe.mjs --android` runs the same bench on a phone or tablet's own Chrome (Galaxy S24 Ultra, Tab S9+) over
USB. Prerequisites: USB debugging on and the device authorized, Chrome installed on it, `adb` on PATH (or in
`%LOCALAPPDATA%/Android/Sdk/platform-tools`), and the bench server running on the PC. The probe sets up `adb reverse` for the
server port (so the page is still `http://localhost:<port>/`, which cross-origin isolation needs) and `adb forward` for DevTools
(`--android-port`, default 9222; `--android-serial S` picks a device), opens a tab, and removes both on exit; it leaves your Chrome
running. All other flags work unchanged, and the fps and per-thread profiles are the device's own:

```bash
node engine/play/bench/probe.mjs --android --url http://localhost:8123/ --query "state=thps4-foundry.st&vu1thread=async" --secs 60 --cpuprof 30:15 --vmprof 30:15
```

`--savestate at:name` saves a state (to `work/ps2-bench-states`) so later runs can start in the same
spot with `--query state=name`. `--cpuprof` samples every thread with the V8 profiler; `--pcprof`
samples the guest EE program counter from a worker reading the shared wasm memory and disassembles
the hottest blocks (how the THPS4 vblank spin was found). `nolimit` in the query disables the frame
limiter (raw speed); `ee=3/4` scales the EE clock; `res=2` sets the resolution factor (default 1);
`precompile=N` enables precompiling (with `jitcache`) and `warm=ms` pauses the VM that long before booting,
like the app resuming a save state. `bench/frames-summary.cjs <out dir>` condenses a run's frame timings.

## Results (Tony Hawk's Pro Skater 4, Ryzen 7 9800X3D + RTX 5090, Chrome, 2x resolution)

| | fps in gameplay | EE thread idle |
|---|---|---|
| Public Play!.js | 30–50 | ~0% |
| + GS transfers, GS-owned WebGL | 47–54 | 0% |
| + block linking | 53–59 | 0% |
| + call-spin idle loops, pacing | **locked 60** (uncapped 70–150) | ~28% |

Uncapped speed from the same Foundry save state (`--query "state=thps4-foundry.st&nolimit"`, average of the
last 25 s, two rounds each): 71.7 fps before play/0007–0008, 75.5 with wasm exceptions, **85.7** with SIMD and
mimalloc. Booting to a level with 40 ms of network latency per disc request, the VM used to block on every
hunk; now it waits under 100 ms per second of loading and 0 ms during FMVs. What remains:

- **JIT warm-up.** THPS4 compiles ~26,000 blocks between boot and a few minutes in a level. Each costs ~100 µs
  in `new WebAssembly.Module` plus about twice that in the Jitter, and they bunch up at transitions (level
  start, first pause menu). play/0013 caches the Jitter's output across sessions and play/0015 instantiates
  cached code before it's needed, so only code never run on this device before still hitches (a first
  session, or a new level). What's left per miss is the Jitter plus V8; lazy wasm compilation adds ~5 µs on
  a block's first call.
- **FMVs** used to run ~27 fps in slow motion: the game's threads spun on RotateThreadReadyQueue while the IPU
  decoded (found with a temporary cycles-between-rotations histogram). play/0010 makes them 60.
- **Loading screens** are paced by emulated DVD timing (0.5 ms per sector); the VM idles ~60% there.

Second session from the Foundry save state at 2x resolution (45 s, `jitcache` from a first session; the
session-start core vs play/0014–0017 with `precompile=30000&warm=1500`):

| | before | after |
|---|---|---|
| frames over 50 ms | 15 | 1 |
| VM frames over 18 ms | 597 / 1889 | 72 / 1923 |
| GS thread busy per picture, avg / p90 | 11.5 / 14.7 ms | 6.1 / 7.9 ms |
| pictures more than 4 ms off the 16.7 ms beat | 798 / 1825 | 62 / 1860 |

GS time barely depends on resolution on an RTX 5090 (6.4 / 6.1 / 6.6 ms at 1x / 2x / 3x). The VM thread is
now the busier one (~12 ms of work per 16.7 ms frame): EE/VU emulation itself.

## Results (ATV Offroad Fury 2, race start, same desktop, asynchronous VPU1 thread)

| | game frames per second | emulation speed | picture |
|---|---|---|---|
| core 30b2881fcbc9 (before) | 17–20 | ~30% (slow motion) | striped terrain, font atlas for a minimap |
| + software targets, catch-up | 22 | 97% | terrain right with one thread; wrong with the thread on |
| + hand-over spins, VU1 dead flags, VIF poll idle | 30 | 99% | |
| + DMA channel busy until consumed | 37 | 97% | right in every mode |
| + GS register runs, late tolerance, interrupt latency | **40** | **100%** | |

Those were measured one after the other while the work went on; the machine's own load moves them by a fifth. Back to
back at the end (2x): the old core 25 frames per second at 41% speed with the corrupt picture, the new one 47–48 at
100% with the right one.

What a game frame cost at the 40 fps measurement (24.5 ms): the VPU1 thread works 15.8 ms (VU1 code 8, GIF packets 2.5, VIF 2) and waits
6.7 ms for the EE, which is itself waiting 5.2 ms for the GS thread at each download (the GS thread finishes the
previous frame's drawing, then rasterizes the terrain pass in software: ~2.5 ms). The GS thread is ~70% busy
(vertex assembly 25%, the software rasterizer 18%, texture uploads 16%, WebGL calls 15%). The EE thread spends most of
its time in the game's own wait loop; its real code runs at ~5 ns per cycle because blocks are 4–5 instructions long
with a 22 statement epilog each and every `JR`/`JALR` goes back to the dispatcher. Next, in the order the numbers
suggest: split the GS thread (vertex assembly, transfers and software targets on one thread, WebGL calls on another,
so a download stops waiting for drawing), an inline cache for indirect jumps and a leaner block epilog in the EE JIT,
GIF packets parsed where they are drawn.

## Phones and tablets (Galaxy Tab S9+, S24 Ultra)

The goal is steady, playable gameplay on Snapdragon 8 Gen 2/3 class devices. Their big cores run this kind of
workload at roughly half the speed of the desktop above, so every thread's per-frame cost matters. What a THPS4
gameplay frame costs on the desktop at 1x, 60 fps capped (bench frame rings + `getGsStats`, 2026-09-30):

| thread | per frame |
|---|---|
| VM (EE, IOP, SPU, DMAC) | ~8 ms busy: 51% EE JIT code, 8% block dispatch, 2% SPU, 2% IOP, the rest waiting on the VPU1 thread |
| VPU1 (VIF1, VU1, GIF) | ~4.5 ms |
| GS (WebGL) | 7.4 ms average, p90 13.7 ms: 1,190 host→local transfers (3.8 MB, 96% of them change GS memory), 63 texture uploads (0.7 Mpx), 235 CLUT reads, 113 draws / 30k vertices, 106 texture rebinds (10 GL calls each), 60k register writes, 2,550 mailbox calls |

At half speed the GS thread misses the 16.7 ms frame first, then the VM thread. Measured and rejected on the way:
forcing V8's optimizing tier (`--chrome-flags "--js-flags=--no-liftoff"`) is *slower* (80 vs 87 fps uncapped), so
wasm tiering isn't the lever; the EE clock at 3/4 doesn't change uncapped speed, because uncapped the VPU1→GS
pipeline is the ceiling (the VM waits on drains a third of the time). The JIT's memory access looks the page up
twice per load/store (see it with `debugRequestEeBlockDump(pc)` / `debugTakeEeBlockDump()`), but the Jitter can't
keep a value across an `if`, so fixing it is a CodeGen change worth a few percent.

What's in place for them:

- **Real-time catch-up** (play/0032; Settings → PS2 CPU speed: Auto). When the device can't run the EE fast enough,
  or the EE waits on the vector unit, the cycles it is behind by are skipped at the end of the frame: the game drops
  frames at full speed, the way it would on a slow PS2, instead of the console slowing down. Full turns it off;
  75% and 50% (`setEeFrequencyScale`) always give the game fewer cycles. THPS4 keeps a locked 60 at 1/2 on the desktop.
- **The bench on the device**: `probe.mjs --android` (Bench, above) reports the phone's own fps and per-thread
  profiles, so the next round of work can be measured where it matters.
- `getGsStats` (play/0024) for the GS composition per frame.

Next, in the order the numbers suggest, once there are device profiles:

1. GS thread: fewer WebGL calls per draw (sampler objects instead of nine `glTexParameteri` per draw, a vertex ring
   instead of `glBufferData` per draw). A sampler-object build was tried on 2026-09-30 and stalled the pipeline in 3 of
   6 async runs (17–21 s into the Foundry state: VPU1 thread idle, GS thread idle, EE running, no more flips) where the
   shipped core did 0 of 6, so it was reverted. That looks like a latent VPU1-thread stall race that different GS timing
   exposes: extend `getVpu1Stats` with the parked flag and last stall reason and diagnose it before retrying.
2. VM thread: a second JIT tier that batches hot blocks into one wasm module (direct calls instead of cross-instance
   table calls: the dispatcher and transitions are ~10%), then a single page lookup with a RAM fast path in memory access.
3. Seed a game's JIT cache from the server, so a phone's first session doesn't compile 26k blocks itself.

In the app, `node tools/ps2-test.mjs` plays THPS4 into Career mode and exercises save/load/suspend/continue.
