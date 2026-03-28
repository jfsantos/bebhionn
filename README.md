# Bebhionn

![Bebhionn Tracker](screenshot.png)

| Instrument Editor | Instrument Detail | DSP Effect Editor |
|:-:|:-:|:-:|
| ![Instrument Editor](screenshot_inst.png) | ![Instrument Detail](screenshot_detail.png) | ![DSP Effect Editor](screenshot_dsp.png) |

Bebhionn (pronounced /ˈbeɪvɪn/, or BAY-vin) is a browser-based vertical tracker
for composing music with the Sega Saturn's SCSP (YMF292-F) sound chip. Uses a
hardware-accurate WASM emulator — what you hear is what the Saturn plays (-ish).
Exports SEQ + TON files directly.

## Quick Start

```bash
python3 generate.py
```

This opens the tracker in your browser. No server needed — everything is
bundled into a single HTML file.

## Features

- **8-channel FM tracker** with classic ProTracker-style keyboard input
- **Hardware-accurate SCSP emulation** via WebAssembly (ported from aosdk)
- **FM synthesis editor** with per-operator envelopes, waveforms, and routing
- **DSP effect engine** with in-browser SCSP DSP assembler and real-time parameter knobs
- **MIDI input** for live playing and step entry (Web MIDI API)
- **Import/Export**: MIDI files, Saturn SEQ sequences, TON instrument banks
- **Song arrangement** with pattern reuse, mute/solo, per-channel instruments

## Development

For iterating on the JS without rebundling:

```bash
python3 generate.py --dev -o tracker.html
# Serve from repo root and reload the browser after editing
```

## Project Layout

```
src/
  core/       Engine-agnostic tracker (UI, state, playback, note utils)
  io/         File format handlers (MIDI, SEQ, TON)
  engines/
    scsp/     SCSP FM engine, panels, DSP assembler, WASM build
docs/         Engine guide for building custom sound engines
examples/     Demo MIDI file
test_ton/     Example Saturn TON instrument banks
tests/        Unit and integration tests
generate.py   Generates the self-contained tracker HTML
```

## Custom Engines

The tracker core is engine-agnostic. You can replace the SCSP engine with
any synthesizer that implements the SoundEngine interface (11 methods).
See [docs/engine-guide.md](docs/engine-guide.md) for a full walkthrough
and a complete Web Audio subtractive synth example.

## License

All original code is under the [BSD 3-Clause License](LICENSE).

The SCSP emulator (`src/engines/scsp/wasm/`) is derived from the
[Audio Overload SDK](https://github.com/kode54/aosdk) (originally from MAME)
and is licensed under the **MAME license (pre-2016)**, which prohibits
commercial use. The bundled HTML output embeds the WASM binary and is
therefore subject to the same terms. See
[src/engines/scsp/wasm/LICENSE](src/engines/scsp/wasm/LICENSE) for details.
