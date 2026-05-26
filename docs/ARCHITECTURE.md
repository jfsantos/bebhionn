# Bebhionn Architecture & Onboarding Guide

This document is the entry point for anyone new to the codebase. It explains
**what Bebhionn is**, **how the pieces fit together**, **the decisions behind
the design**, and **where to start hacking**. For the binary file formats see
[file-formats.md](file-formats.md); for the running list of rough edges and
tech debt see [known-issues.md](known-issues.md); for writing a replacement
sound engine see [engine-guide.md](engine-guide.md).

---

## 1. What is Bebhionn?

Bebhionn is a **browser-based vertical tracker** for composing music on the
Sega Saturn's **SCSP** sound chip (Yamaha YMF292-F). It is delivered as a
**single self-contained HTML file** — no server, no build step at runtime, no
dependencies. You open the file, you get a tracker.

The defining characteristic: the sound you hear is produced by a
**cycle-accurate SCSP emulator compiled to WebAssembly** (extracted from MAME).
What plays in the browser is what the real hardware would play. The tracker can
then **export the song and instruments as native Saturn `SEQ` + `TON` files**
for use on real hardware or in Saturn homebrew.

It is an **FM synthesizer tracker**: instruments are multi-operator FM patches
(à la DX7), but the SCSP also supports PCM samples and an on-board programmable
DSP for effects.

### The three "languages" of the project

| Layer | Language | Why |
|-------|----------|-----|
| Tracker app (UI, state, sequencer, file I/O) | Vanilla ES5-style JavaScript | Runs unbundled in any browser; no toolchain |
| SCSP emulator + bridge | C / C++ → WebAssembly | The emulator is C++ from MAME; real-time perf needs native speed |
| Bundler / dev server | Python 3 (`generate.py`) | Zero-dependency way to inline everything into one HTML file |

---

## 2. The 30-second mental model

```
                      generate.py  (bundles everything into one .html)
                            │
        ┌───────────────────┴────────────────────────────────┐
        │                  tracker.html                       │
        │                                                     │
        │   ┌─────────────────────────────────────────────┐  │
        │   │  ENGINE-AGNOSTIC CORE  (src/core/)           │  │
        │   │   tracker_state   — data model               │  │
        │   │   tracker_playback— step sequencer           │  │
        │   │   tracker_ui      — grid, keyboard, transport │  │
        │   │   note_util       — MIDI note names           │  │
        │   └───────────────┬─────────────────────────────┘  │
        │                   │ SoundEngine interface (≈11 methods)
        │   ┌───────────────▼─────────────────────────────┐  │
        │   │  SCSP ENGINE  (src/engines/scsp/)            │  │
        │   │   scsp_engine — FM synth, voice allocation    │  │
        │   │   scsp_panels — detail/DSP/MIDI UI (optional) │  │
        │   │   scspdspasm  — SCSP DSP assembler            │  │
        │   │   wasm/       — MAME SCSP emulator (WASM)      │  │
        │   └─────────────────────────────────────────────┘  │
        │                                                     │
        │   FILE I/O  (src/io/)                               │
        │     midi_io · seq_io · ton_io · dx7_import          │
        └─────────────────────────────────────────────────────┘
```

The **core never references the SCSP directly.** It talks to whatever object
is passed in as "the engine" through a small interface (§6). This is the single
most important architectural decision in the project — see §10.

---

## 3. Repository layout

```
generate.py            Bundler + dev server. Produces the HTML. Start here.
README.md              Project overview, quick start.
LICENSE                BSD 3-Clause (first-party code).

src/
  core/                Engine-agnostic tracker
    tracker_state.js     Pure data model (patterns, song, instruments, cursor)
    tracker_playback.js  Sample-accurate step sequencer
    tracker_ui.js        DOM: grid, keyboard input, transport, import/export glue
    note_util.js         noteName() / NOTE_NAMES
  io/                  File-format handlers (all engine-agnostic except dx7/ton)
    midi_io.js           Standard MIDI File read/write
    seq_io.js            Saturn SEQ sequence read/write
    ton_io.js            Saturn TON instrument-bank read/write
    dx7_import.js        Yamaha DX7 SysEx → SCSP FM operators
  engines/
    scsp/
      scsp_engine.js     The SoundEngine impl: FM synthesis, voice/slot allocation
      scsp_panels.js     SCSP-specific UI panels (instrument detail, DSP editor, MIDI in)
      scspdspasm.js      Assembler for the SCSP on-board DSP microcode
      wasm/              The emulator
        scsp.cpp/.h        MAME SCSP device (BSD-3-Clause)
        scspdsp.cpp/.h     MAME SCSP DSP
        scsp_wasm.cpp      First-party C bridge exposing a flat C API to JS
        scsp_waveforms.c/h First-party built-in waveform generators
        Makefile           Emscripten build
        PORTING_NOTES.md   **Essential** hardware reference (read this!)
        scsp.js/.wasm      Build artifacts (committed)

docs/                  This guide, file-formats, known-issues, engine-guide
tests/                 Node `node:test` unit/integration tests + e2e/ (Playwright)
test_ton/              Example Saturn .TON banks (bundled as built-in instruments)
examples/              Demo MIDI file (bundled as the demo song)
```

---

## 4. The build & bundle model (`generate.py`)

`generate.py` is the only "build tool" for the app layer. It does **string
templating**, not compilation:

- It holds the full HTML/CSS shell (`_HTML_TEMPLATE`) with a `__SCRIPTS__`
  placeholder, plus the menu/overlay bootstrap script.
- `_JS_MODULES` lists every JS file **in dependency order**, each paired with a
  tiny fallback stub used if the file is missing.
- Two modes:

| Command | Mode | What it emits |
|---------|------|---------------|
| `python3 generate.py` | **bundled** (default) | One self-contained HTML: every JS file inlined, WASM base64-embedded, demo MIDI + example TONs embedded. Opens in browser. |
| `python3 generate.py --dev -o tracker.html` | **dev** | HTML with `<script src="src/...">` tags; WASM fetched at runtime. Edit a JS file, reload the browser. Must be served from repo root. |

### Two placeholders baked at bundle time

`tracker_ui.js` contains the literal tokens `__DEMO_MIDI_B64__` and
`__EXAMPLE_TONS_JSON__`. `generate.py` string-replaces these with base64 of
`examples/kit_demo.mid` and a JSON map of every `test_ton/*.TON`. This is how
the demo song and the "Instruments" dropdown of built-in banks get into the
single-file build. **If you grep for those tokens you'll find the seams.**

### The bootstrap (last script block)

Both modes end by wiring the four singletons together — this is the canonical
startup sequence:

```js
var state    = TrackerState.create(SCSPEngine.getPresets());
var playback = TrackerPlayback.create(state, SCSPEngine);
TrackerUI.init(state, playback, SCSPEngine);
SCSPPanels.init(state, SCSPEngine, TrackerUI);
```

> **Decision: one file, no server.** Targeting hobbyist Saturn musicians, the
> friction of "npm install / run a dev server" was deemed unacceptable. A
> double-clickable HTML file that works offline (`file://`) is the product.
> The cost is paid in §10 (no module system, globals, manual dependency order).

---

## 5. The data model (`tracker_state.js`)

`TrackerState` is a **pure data module**: no DOM, no audio, no engine
references. It is the serializable heart of a project. Conceptually:

```js
state = {
  bpm: 120,
  stepsPerBeat: 4,        // grid quantization (rows per beat)
  patternLength: 32,      // rows per pattern
  instruments: [ Instrument, ... ],   // engine-opaque objects (see below)
  patterns:    [ Pattern, ... ],      // grows as you add patterns
  song:        [0, 1, 0, 2, ...],     // arrangement: ordered pattern indices
  cursor: { row, ch, col },           // edit cursor; col 0=note 1=inst 2=vol
}
```

```js
Pattern = {
  length: 32,
  channels: [                         // NUM_CHANNELS (16) of these
    { defaultInst: 0,
      rows: [ { note, inst, vol }, ... ] }  // one cell per row
  ]
}
```

A **cell** is sparse: `null` means "unset". `note` is a MIDI number 0–127,
`-1` is an explicit note-OFF marker, `null` is empty.

### Key constants

- `NUM_CHANNELS = 16` — capped at 16 because SEQ/MIDI channels are a 4-bit
  field. (The README historically said "8-channel"; it is now 16.)
- `MAX_SLOTS = 32` — the SCSP has 32 hardware voice "slots". This is the hard
  polyphony ceiling, enforced at edit time (see below).
- `KEY_NOTE_MAP` — ProTracker-style computer-keyboard → semitone mapping.

### Hardware-aware editing: the slot budget

Each FM instrument consumes **one SCSP slot per operator** while sounding. A
3-operator patch playing on 4 channels at once = 12 slots. The total can never
exceed 32. `computeSongSlotUsage(state)` unrolls the entire song and returns
the **peak simultaneous slot count**. `tracker_ui.js` calls this after every
note/instrument edit (`commitCellEdit`) and **refuses + reverts the edit** if it
would exceed `MAX_SLOTS`, showing where the peak occurred. The "Slots N/32"
meter in the transport bar reflects this.

> **Decision: enforce the hardware limit in the editor, not at export.** A song
> that plays in the browser is guaranteed to play on hardware. The tradeoff is
> an O(song × pattern × channels) recompute on each edit — acceptable because it
> only runs on edits, never per audio frame.

### Mute / solo lives *outside* `state`

Channel mute/solo is **module-local closure state in `tracker_state.js`, not a
field of the `state` object** (`getChannelStates()` / `setChannelStates()`
bridge it). Project save/load explicitly serializes it on the side. This is a
known footgun — see [known-issues.md](known-issues.md).

There is **no undo/redo.** Edits mutate `state` in place.

---

## 6. The SoundEngine interface (the core ↔ engine contract)

This is the seam that makes the tracker engine-agnostic. The full contract is
documented in [engine-guide.md](engine-guide.md); here is the contract as it is
*actually exercised* in the code, split by who calls it.

**Called by `tracker_playback.js` (the sequencer):**

| Method | When |
|--------|------|
| `getSampleRate()` | On tempo calc and playback start |
| `triggerNote(ch, midiNote, instIdx, inst)` | On each note-on row event |
| `releaseChannel(ch)` | On note-off, note replacement, and mute |
| `releaseAll()` | On stop |

**Called by `tracker_ui.js` (the app):**

| Method | When |
|--------|------|
| `init()` → Promise | Before first sound (compile WASM, make AudioContext) |
| `startAudio(playback)` | On first play; engine creates the audio loop |
| `getPresets()` | At bootstrap, to seed `state.instruments` |
| `renderInstEditor(container, inst, selectedOp, onChange)` | Sidebar instrument editor |
| `importBank(buf, label)` | "Import TON…" |

> **Reality check:** `tracker_ui.js` also calls engine methods that are *not*
> part of the published interface — `liveUpdatePreview`, `importDx7Sysex`,
> `createDefaultInstrument`, `dupInstrument`-helpers, plus the panels call
> `setSlotPostProgramHook`, `dspSetSlotSend`, `dspSetSlotOutput`. A drop-in
> replacement engine needs stubs for these or it will throw. The
> "engine-agnostic" claim holds for *playback* but is looser for the *UI*. See
> [known-issues.md](known-issues.md).

Instruments are **opaque to the core** — the only field the tracker reads is
`name`. Everything else (operators, envelopes, waveforms, raw registers) is the
engine's private schema, stored verbatim and handed back on `triggerNote`.

---

## 7. Playback & timing (`tracker_playback.js`)

`TrackerPlayback.create(state, engine)` returns a sequencer object with two
**distinct timing engines**:

### Live mode (`processBlock`) — coarse, block-quantized

Accumulates samples per audio block; when `samplePos >= samplesPerStep`, it
fires the row and advances. Step length is
`sampleRate * 60 / (bpm * stepsPerBeat)`. Rounding error accrues per step.

### SEQ mode (`startSeqPlayback` / `processBlockSeq`) — sample-accurate

This is what the **Play button actually uses.** `togglePlay()` in
`tracker_ui.js` *always* builds a real SEQ byte stream via `buildSEQ(...)` and
calls `playback.startSeqPlayback(seqBytes)`. The engine's audio callback then
slices each audio block at the exact sample of each note/row boundary so events
land sample-accurately — identical to how the exported `.SEQ` will sound.

> **Consequence worth knowing:** the **live `processBlock` path is effectively
> vestigial** — nothing in the current UI triggers it (the engine's audio
> callback keeps a fallback call to it, but `mode` is always `'seq'` in
> practice). It's tested, but unreachable from the app. See known-issues.

> **Decision: play through the export path.** Rather than maintain two
> behaviours, "Play" renders the same SEQ you'd export, guaranteeing
> what-you-hear-is-what-you-ship. The price is the dual-mode complexity and a
> magic-number row-position encoding (`songSlot * 10000 + row`) in the live
> path.

The UI registers `onRowChange` / `onStop` callbacks; the sequencer never
touches the DOM.

---

## 8. The SCSP engine & the WASM bridge

`scsp_engine.js` is the bridge between high-level FM instruments and the
register-level reality of the chip. Read
[wasm/PORTING_NOTES.md](../src/engines/scsp/wasm/PORTING_NOTES.md) — it is the
authoritative, well-written reference for everything below.

### What the emulator gives you (C API in `scsp_wasm.cpp`)

A single global SCSP instance + a fixed **512 KB sound RAM** array (mirrors real
hardware). The exported C functions (whitelisted in the `Makefile`) are roughly:

- `scsp_init()` — placement-new reset of the device, zero RAM
- `scsp_get_ram_ptr()` / `scsp_get_ram_size()` — pointer into the WASM heap so
  JS can write sample data directly
- `scsp_write_reg(addr,val)` / `scsp_write_slot(slot,word,val)` — register pokes
- `scsp_key_on(slot)` / `scsp_key_off(slot)` — the two-step key-on dance
- `scsp_render(n)` → pointer to an interleaved int16 stereo buffer
- `scsp_dsp_load_arrays(...)` / `scsp_dsp_load_exb(...)` — load DSP microcode
- `scsp_dsp_set_coef(...)` / `scsp_slot_set_*` — live tweaks

### How JS drives it (the SCSP slot model)

The chip is **32 time-multiplexed slots**. Each operator of a playing note owns
one slot, programmed via 12 16-bit registers (sample address, loop, envelope
AR/D1R/DL/D2R/RR, total level, FM routing, OCT/FNS pitch, direct output/pan).
`scsp_engine.js`:

1. **Voice allocation** maps tracker channels → contiguous slot ranges, stealing
   least-recently-used voices when full.
2. For each operator, computes register values (`programSlot`) — or replays raw
   register values for TON-imported patches (`programSlotRaw`, preserving the
   original chip programming).
3. Writes the registers, then issues the **two-step key-on** (force RELEASE,
   then KEY_ON) the hardware requires.

### Three hardware facts that shape the whole engine

These are non-obvious and cost real debugging time — they're spelled out fully
in PORTING_NOTES, summarized here so you recognize them:

1. **FM waveforms must be exactly 1024 samples.** The chip's FM phase-modulation
   math is hardcoded to a 1024-sample cycle (`smp <<= 0xA`). Any operator used
   as a modulator (or doing FM) is forced to a 1024-sample wave. This is why
   custom/short PCM is only allowed on non-FM carriers.

2. **FM is done through a 64-entry ring buffer, not direct routing.** A slot
   modulates another by reading entries *N positions back* in a shared ring
   buffer (`MDXSL`/`MDYSL` are *offsets*, not slot indices). Self-feedback =
   offset 32. The chip supports **two modulation inputs per slot** (averaged),
   so an operator can have up to two modulators.

3. **`TL` (total level) is wildly non-linear**, and a modulator's loudness
   *is* its FM depth. Carriers and modulators therefore use **different
   level→TL mappings**, and modulators must keep `TL ≥ 24` or the ring buffer
   overflows int16 into noise. The engine compensates carrier `MDL` to hit a
   target modulation index.

### Endianness gotcha

Real Saturn sample RAM is big-endian; the MAME emulator assumes a
**little-endian** host (it was written for x86). So when JS writes samples into
sound RAM it must use **little-endian** byte order — the opposite of what you'd
write for actual hardware. (TON files on disk are big-endian; the engine swaps.)

### Built-in waveforms (`scsp_waveforms.c`)

Ten additively-synthesized 1024-sample waves (sine, saw, square, triangle,
organ, brass, strings, piano, flute, bass) are generated in C and laid into the
low end of sound RAM at reset. They occupy the first ~20 KB; TON/custom sample
data and the DSP ring buffer use the rest.

> **Decision: why WASM + ScriptProcessorNode (a deprecated API)?**
> The emulator is ~thousands of lines of pointer-heavy C++; running it in pure
> JS at 44.1 kHz × 32 slots would stall. WASM gets near-native speed in a 36 KB
> binary. `ScriptProcessorNode` (rather than the modern AudioWorklet) is used
> because it gives a synchronous per-block callback that can both render the
> emulator *and* advance the sample-accurate sequencer in the same place,
> without the cross-thread message plumbing and cross-origin-isolation
> requirements an AudioWorklet would add to a `file://` single-page app. The
> cost: it runs on the main thread and can glitch under load. Migrating to
> AudioWorklet is the most-discussed future change.

---

## 9. The SCSP DSP & its assembler (`scspdspasm.js`)

The SCSP has an **on-board 128-step DSP** for effects (reverb, delay, chorus).
`scspdspasm.js` is a hand-written assembler that turns a human-readable
micro-source (the `#COEF` / `#ADRS` / `#PROG` syntax you see in the DSP panel's
default delay program) into the three binary tables the hardware wants:

- **MPRO** — 128 × 4 × uint16 microprogram steps
- **COEF** — 64 coefficient/filter taps (13-bit signed)
- **MADRS** — 32 memory-address symbols

It also reads/writes Saturn `.EXB` effect files. A hardware quirk it handles for
you: **memory read/write ops must land on odd DSP steps**, so the assembler
auto-inserts `NOP`s and tells you when it did. The `scsp_panels.js` DSP editor
compiles on Ctrl+Enter, exposes each `#COEF` as a live knob, and wires the DSP's
stereo wet return back into slots 0–1 via `setSlotPostProgramHook`.

See [file-formats.md](file-formats.md) for the EXB layout and the microcode
field encoding.

---

## 10. The "engine-agnostic core" — promise and reality

The headline design goal: **the tracker core (`src/core/`) works with any sound
engine that implements the interface in §6.** You can drop in a Web Audio
subtractive synth or a MIDI-out engine ([engine-guide.md](engine-guide.md) walks
through a complete example).

This largely holds:

- `tracker_state.js`, `tracker_playback.js`, `note_util.js`, `midi_io.js`,
  `seq_io.js` have **zero SCSP knowledge.**
- The sequencer only ever calls the four playback-interface methods.

Where it's **leaky** (and you should know before relying on it):

- `tracker_ui.js` calls several engine methods beyond the published interface
  (§6) and hard-codes SCSP-flavored assumptions in places.
- `seq_io.js` / `ton_io.js` are Saturn-specific by nature; a non-Saturn engine
  would ignore them.
- The whole thing depends on **global function names** and a **fixed HTML
  structure** (element IDs) rather than a module system.

These are catalogued in [known-issues.md](known-issues.md). None of them are
fatal — they're the expected consequence of the "no build tools, one HTML file"
constraint (§4) — but they're the difference between "engine-agnostic in
principle" and "drop-in in practice".

---

## 11. Testing

Two independent test suites, no `package.json` / npm script — they're run
directly:

### JavaScript unit + integration (`tests/*.test.js`)

Built on Node's built-in test runner (`node:test`), no dependencies. Each core
and io module has a suite; `integration.test.js` exercises
state → SEQ/MIDI export → re-parse round-trips with a **mock engine** (proving
the core really is engine-agnostic). The SCSP engine is tested headless by
mocking the browser/WASM APIs.

```bash
node --test                      # run everything
node --test tests/seq_io.test.js # one file
```

### End-to-end (`tests/e2e/`, Playwright + pytest)

`test_tracker.py` runs `generate.py` to produce a bundled HTML, loads it in
headless Chromium, and drives the real UI. `screenshot.py` regenerates the
README screenshots.

```bash
pip install playwright pytest && playwright install chromium
python3 -m pytest tests/e2e/test_tracker.py -v
```

---

## 12. Building the WASM emulator

The committed `scsp.js` + `scsp.wasm` are usually all you need. To rebuild
(after touching the C/C++ in `wasm/`), you need the **Emscripten SDK** (`emcc`):

```bash
cd src/engines/scsp/wasm
make            # → scsp.js (~13 KB glue) + scsp.wasm (~36 KB)
make clean
```

The `Makefile` whitelists exactly the C functions JS may call
(`EXPORTED_FUNCTIONS`) and fixes the heap at 4 MB (`INITIAL_MEMORY`,
`ALLOW_MEMORY_GROWTH=0`). See `PORTING_NOTES.md` §"Build Setup" for the header-
shimming tricks used to compile MAME sources without the rest of MAME.

---

## 13. Licensing (important, and previously mis-documented)

- **First-party code** (everything except `wasm/scsp*.cpp/.h`) is **BSD 3-Clause**
  (`LICENSE`).
- The **SCSP emulator** (`wasm/scsp.cpp`, `scspdsp.cpp`, and headers) is
  extracted from **MAME's modern SCSP device** and is **BSD-3-Clause** per the
  upstream per-file SPDX headers (which override MAME's project-wide GPL grant).
  Authors: ElSemi, R. Belmont, with fixes by kingshriek.
- The C bridge (`scsp_wasm.cpp`) and waveform helpers (`scsp_waveforms.c/h`) are
  first-party BSD-3-Clause.

> **This was relicensed** (commit `857b9f9`, "MAME relicense"). An earlier
> version used an aosdk-derived port under the **pre-2016 MAME license with a
> non-commercial clause**. That clause **no longer applies** — the current
> sources are GPL-compatible BSD-3-Clause and commercial use is permitted.
> Some prose (older README text, PORTING_NOTES headers) may still reference the
> old aosdk/non-commercial situation; trust `src/engines/scsp/wasm/LICENSE` and
> the SPDX headers in the `.cpp` files.

---

## 14. Where to start (suggested first tasks)

| You want to… | Start in |
|--------------|----------|
| Change grid/keyboard/transport behaviour | `src/core/tracker_ui.js` |
| Change the data model or song structure | `src/core/tracker_state.js` |
| Fix timing / playback | `src/core/tracker_playback.js` |
| Tweak FM synthesis or add a preset | `src/engines/scsp/scsp_engine.js` (+ `PORTING_NOTES.md`) |
| Edit the instrument-detail / DSP / MIDI panels | `src/engines/scsp/scsp_panels.js` |
| Add/fix a file format | `src/io/*.js` (+ [file-formats.md](file-formats.md)) |
| Touch the emulator itself | `src/engines/scsp/wasm/` (needs Emscripten) |
| Write a non-SCSP engine | [engine-guide.md](engine-guide.md) |

**Recommended reading order for a new contributor:** this file →
`PORTING_NOTES.md` → `tracker_state.js` (small, pure) → `tracker_playback.js` →
skim `scsp_engine.js`'s `triggerNote`/`programSlot` → [known-issues.md](known-issues.md).
