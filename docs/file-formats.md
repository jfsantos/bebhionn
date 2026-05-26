# File Formats Reference

Bebhionn reads and writes several binary formats. Two are standard (MIDI), two
are obscure Sega Saturn driver formats reverse-engineered from real data
(`SEQ`, `TON`, `EXB`), and one is an import-only synth dump (DX7 SysEx). This
document is the human-readable companion to the parsers; **the source files are
the authoritative spec** when bytes disagree with prose.

| Format | Module | Direction | Endianness | Purpose |
|--------|--------|-----------|------------|---------|
| Standard MIDI File | `src/io/midi_io.js` | read + write | big-endian | Interchange with DAWs |
| Saturn SEQ | `src/io/seq_io.js` | read + write | big-endian | Native Saturn sequence playback |
| Saturn TON | `src/io/ton_io.js` | read + write | big-endian (on disk) | Native Saturn instrument/tone bank |
| DX7 SysEx | `src/io/dx7_import.js` | read only | per Yamaha spec | Import 32-voice DX7 banks as FM patches |
| Saturn EXB | `src/engines/scsp/scspdspasm.js` | read + write | — | SCSP DSP effect programs |

A note shared by all of them: the tracker's internal `Pattern` model
(`channels[].rows[] = {note, inst, vol}`) is the common currency. MIDI and SEQ
parsers/builders convert to/from it; TON/DX7 convert to/from the engine's
instrument objects.

---

## 1. Standard MIDI File (`midi_io.js`)

`parseMIDI(arrayBuffer)` and `buildMIDI(options)`.

**Parsing** handles MThd + MTrk chunks, variable-length delta times, running
status, and merges all tracks into one absolute-time event list. It extracts
note-on/off (treating note-on velocity 0 as note-off), program change, and
tempo (`FF 51`). **Everything else is discarded** — control changes, pitch
bend, aftertouch, SysEx, and non-tempo meta events. So mod wheel, expression,
sustain pedal, etc. are *not* round-tripped.

**Building** always writes a **Format 0** (single track), **480 ticks/quarter**
file: one tempo meta event, then program-change + note-on/off pairs in delta
order, then end-of-track. Note durations are written as explicit note-offs.
Muted channels (`mutedChannels`) are omitted.

**Watch out:**
- The builder is fixed at 480 PPQ regardless of an imported file's division, so
  a non-480 file loses timing precision on round-trip.
- On import, note **gate** (duration) is *inferred* from the distance to the
  next note on the same channel — there is no explicit duration in the tracker
  cell model.

---

## 2. Saturn SEQ (`seq_io.js`)

A compact event stream consumed by the Saturn sound driver. This is the format
the **Play button renders internally** (see ARCHITECTURE §7) and what "Export
SEQ" produces. `parseSEQ(buf)` → `{resolution, bpm, events[]}`;
`buildSEQ(options)` → `Uint8Array`.

### On-disk structure (all big-endian)

```
Bank header (6 bytes)
  u16  numSongs            (builder writes 1)
  u32  songPtr             byte offset to the SEQ header (builder: 6)

SEQ header (8 bytes, at songPtr)
  u16  resolution          ticks per quarter note (480)
  u16  numTempoEvents      (builder writes 2: start + loop)
  u16  dataOffset          offset from SEQ header to the event stream
  u16  tempoLoopOffset

Tempo table (numTempoEvents × 8 bytes)
  u32  stepTime            tick position the tempo applies at
  u32  mspb                microseconds per beat (bpm = 60_000_000 / mspb)

Event stream (at songPtr + dataOffset) … terminated by 0x83
```

### Event stream encoding

The clever/compact part. Two running accumulators, `deltaPending` (time until
the event) and `gatePending` (note duration), are built up by **extend-prefix
bytes**, then consumed by the next real event:

| Prefix | Adds to |
|--------|---------|
| `0x8F`/`0x8E`/`0x8D`/`0x8C` | delta += `0x1000` / `0x0800` / `0x0200` / `0x0100` |
| `0x8B`/`0x8A`/`0x89`/`0x88` | gate += `0x2000` / `0x1000` / `0x0800` / `0x0200` |

Prefixes are **cumulative** — emit several to reach large values. After the
prefixes:

- **Note-on** (`0x0N`, N = channel): `note`, `vel`, `gateLow`, `deltaLow`.
  Bits 5/6 of the control byte add 256 to `deltaLow`/`gateLow` respectively, on
  top of the pending accumulators. (So `gate = gatePending + (bit6?256:0) + gateLow`.)
- **Program change** (`0xC0|ch`): `prog`, `deltaLow`.
- `0x83` ends the track.

Other channel-voice messages (CC `0xB0`, poly pressure `0xA0`, pitch bend
`0xE0`, channel pressure `0xD0`) are recognized and skipped on parse.

### Builder specifics & limitations

- Emits exactly **two tempo events** (start tick + total-length loop point) — a
  multi-tempo song would have to be approximated.
- Injects a **bank-select CC#32 = 1** on all 16 channels at the start (the
  Saturn driver expects it); those are filtered back out on import.
- Unlike MIDI, **gate (duration) is stored explicitly** per note, so SEQ
  round-trips note lengths faithfully.
- Loop-control (LPCTL) is not encoded.

---

## 3. Saturn TON (`ton_io.js`)

The Saturn "tone bank": FM operator definitions **plus** the PCM waveform data
they reference. Compatible with `saturn_kit.py`. `TonIO` exports `exportTon`,
`importTon`, `mergeTon`, `extractVoice`.

The defining property: **a TON layer is essentially a dump of the SCSP slot
registers byte-for-byte.** This makes hardware programming zero-copy, but means
the format is tightly coupled to the chip and not portable.

### On-disk structure (big-endian)

```
Header
  u16  offset → mixer table
  u16  offset → VL table
  u16  offset → PEG table
  u16  offset → PLFO table
  u16 × numVoices   offset → each voice   (voice count = (mixerOffset - 8) / 2)

Mixer table (0x12 bytes)   routes EFREG0→L, EFREG1→R at full level
VL table   (0x0A bytes)    fixed magic sequence carried from reference banks
PEG/PLFO   (zeroed)        pitch-EG / pitch-LFO state (not used by the editor)

Per voice
  byte  bend_range (=2)
  byte  reserved
  byte  nlayers - 1        (operator count minus one)
  byte  reserved
  layer × nlayers          0x20 bytes each (see below)

PCM data (after all voices)   int16 or int8, big-endian
```

### Layer = 0x20 bytes = one SCSP slot

The layer maps directly onto the SCSP slot registers documented in
[PORTING_NOTES.md](../src/engines/scsp/wasm/PORTING_NOTES.md) §"Slot Register
Layout": start/end note range, `LPCTL` + sample-address high nibble, 16-bit SA
low / `LSA` / `LEA`, the envelope rates (`D2R`/`D1R`/`AR`, `KRS`/`DL`/`RR`),
`TL`, the FM routing nibbles (`MDL`/`MDXSL`/`MDYSL`), `DISDL`/`DIPAN`, the
`base_note` anchor pitch, and an FM modulator-link byte. PCM bit-depth (8 vs 16)
comes from the `PCM8B` bit.

### Conversions and lossy spots

- **level ↔ TL**: `tl = (1 - level) * 128` on export; inverse on import. TL is
  clamped to 0–255 (very hot levels saturate silently).
- **freq_ratio ↔ base_note**: ratio 1.0 ⇒ A4 (MIDI 69); other ratios shift the
  base note by `12·log2(ratio)`. **The ratio is rounded to 3 decimal places**,
  so fine detune drifts over repeated round-trips.
- **PCM**: built-in waveforms are deduplicated by type across voices; custom
  per-operator waveforms are always written fresh. Sample addresses are
  back-patched in a second pass once the PCM base offset is known.
- **Modulation**: the operator model carries up to two `mod_sources`; verify how
  many distinct modulator links the on-disk layer round-trips before assuming
  full fidelity for two-modulator patches (see known-issues).
- Mixer/VL tables are hardcoded — no configurable global routing.

---

## 4. DX7 SysEx import (`dx7_import.js`)

Import-only. Converts a Yamaha DX7 **32-voice bulk dump** (`.syx`) into
Bebhionn FM operator objects. Ported from `dx7_to_saturn.py`; the conversion
math is faithful to **Dexed** (the open-source DX7 emulation) so patches sound
the same.

`parseSysex(buf)` extracts the 32 voices (128 bytes each: six 17-byte operators
in reverse op6→op1 order, then voice params). `voiceToOperators(voice, maxOps)`
does the real work; `convertBank(buf, maxOps)` runs the whole bank and returns
`{instruments, warnings}`.

### What the converter has to reconcile

- **Algorithms.** DX7 has 32 fixed operator-routing algorithms (hardcoded as
  byte tables). `decodeAlgorithm()` walks them through two internal modulation
  buses to produce `{carriers, connections (mod→carrier edges), feedbackOp}`.
- **Envelopes.** DX7's 4-rate/4-level log-domain envelope is simulated
  block-by-block and mapped onto the SCSP's AR/D1R/DL/D2R/RR model — the
  trickiest, most empirically-tuned code in the file (magic constants like the
  `1023/642` attack scaling, `MDL=11` to reproduce Dexed's β≈2π).
- **Operator budget.** The SCSP allows 2 modulators per slot; the converter
  does a breadth-first walk from carriers outward, keeping the most direct
  modulators and **dropping deeper ones when a voice exceeds `maxOps` (default
  6) or a carrier has >2 modulators.** Dropped operators are reported in
  `warnings[]` and surfaced by the UI as a modal.

### Known lossy behaviour

DX7 LFO, pitch-EG, keyboard scaling, and velocity sensitivity are **not**
converted. Output is always sine FM (DX7 has no user wavetables). Frequency
ratios are rounded. Inactive (output-level 0) operators and all-silent voices
are pruned. Treat DX7 import as "a faithful starting point," not a bit-exact
clone.

---

## 5. Saturn EXB — SCSP DSP effects (`scspdspasm.js`)

The on-board DSP program format. `scspdspAssemble(text)` compiles the
`#COEF` / `#ADRS` / `#PROG` micro-source into three tables; `scspdspAssembleExb`
packs them into an `.EXB` file and `scspdspParseExb` reads one back.

### Compiled tables

| Table | Size | Meaning |
|-------|------|---------|
| **MPRO** | 128 steps × 4 × u16 | The microprogram (one MAC + I/O op per step) |
| **COEF** | 64 × 13-bit signed | Coefficient / filter taps |
| **MADRS** | 32 × u16 | Memory-address symbols |

Plus `RBL` (ring-buffer length: 8K/16K/32K/64K words) controlling how much of
sound RAM the delay line uses.

### Micro-source syntax (the DSP panel's default delay shows it)

- `#COEF` — `Name = value`, where value can be `&Hxx` (hex), `%nn` (percent),
  a float (÷2 fixed-point), or an integer.
- `#ADRS` — address labels, e.g. `ra = ms200.0` (milliseconds → samples).
- `#PROG` — one micro-instruction per line. The MAC line form is
  `@ INPUT * COEF + (TEMP * C +) > DEST`; plus `MR`/`MW` (memory read/write),
  `IW` (write to internal MEMS), `NOP`, and `=END`.

### The one rule you must respect (handled for you)

**Memory read/write instructions must execute on *odd* DSP steps.** The
assembler auto-inserts `NOP`s to align them and reports when it did (the panel's
status line). If a program would overflow 128 steps after alignment, the tail is
silently lost — keep programs short.

Each MPRO step packs ~30 bit-fields (TRA/TWT/XSEL/YSEL/IRA/MWT/MRD/CRA/MASA/…).
The exact bit layout lives in `packMpro()` in `scspdspasm.js`; consult it (and a
SCSP DSP register reference) before hand-encoding instructions.
