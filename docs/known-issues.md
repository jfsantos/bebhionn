# Known Issues, Rough Edges & Tech Debt

An honest catalogue of what's fragile, stale, or papered-over in the codebase,
so a new contributor isn't surprised and knows where the dragons are. Grouped by
severity-ish. None of these block the app from working today; they're the gap
between "works" and "robust/maintainable".

Most of this stems from the project's foundational constraint — **one
self-contained HTML file, no build tools, no module system** (see
[ARCHITECTURE.md](ARCHITECTURE.md) §4/§10). That constraint is a feature, not a
bug, but it has predictable consequences listed here.

---

## A. Documentation that is stale or wrong

These are the highest-value, lowest-risk fixes — wrong docs actively mislead.

1. **README licensing was wrong.** It described the SCSP emulator as under the
   "MAME license (pre-2016), prohibits commercial use." The sources were
   **relicensed to BSD-3-Clause** (MAME's modern device, commit `857b9f9`).
   Commercial use is now permitted. *(Fixed in this pass; mentioned here so the
   history is recorded.)* Source of truth: `src/engines/scsp/wasm/LICENSE` and
   the SPDX headers in `scsp.cpp` / `scspdsp.cpp`.

2. **README feature list said "8-channel."** The tracker is now **16-channel**
   (`TrackerState.NUM_CHANNELS = 16`, commit `ce45ab7`). *(Fixed in this pass.)*

3. **`PORTING_NOTES.md` references `fm_editor.py`.** That bundler is now
   `generate.py`. (Two occurrences, in §"Build Setup" and §"Embedding".)

4. **`PORTING_NOTES.md` "Known Limitations" is obsolete.** It claims "single
   waveform (sine only)", "no DSP effects", and "single-voice polyphony" — all
   three have since been implemented (10 built-in waveforms + custom PCM, a full
   DSP assembler/editor, and slot-allocation polyphony with the 32-slot budget).
   The list reads as a roadmap that's already done.

5. **`PORTING_NOTES.md` attributes the emulator to "aosdk."** The current
   sources are extracted from **MAME**, not aosdk (the aosdk-derived port was
   the *previous*, non-commercial version that was replaced). The porting
   lessons are still valid; the provenance line is stale.

6. **`engine-guide.md` wiring example uses a `tools/` path prefix** for the JS
   includes (`<script src="tools/note_util.js">`), but the real layout is
   `src/core/` and `src/io/`. The conceptual content is fine; the paths in the
   copy-paste HTML are wrong.

---

## B. Architecture / design smells

7. **The live-mode sequencer (`processBlock`) is effectively dead code.** The UI
   always plays via `startSeqPlayback` (SEQ mode, sample-accurate). `processBlock`
   still exists, is unit-tested, and is referenced as a fallback in the SCSP
   engine's audio callback, but no user action reaches it. Either delete it (and
   the dual-mode branching it forces) or document it as a public API for
   alternate engines. Right now it's "two timing systems, one used."

8. **Magic-number row encoding in playback.** `tracker_playback.js` encodes a
   position as `currentSongSlot * 10000 + row` (live mode). A pattern with
   ≥10000 rows would collide across song slots. Harmless in practice (patterns
   are ≤64 rows), but it's an undocumented hidden limit; a `{slot, row}` struct
   would be safer. (Tied to #7 — lives in the dead path.)

9. **Channel mute/solo state lives outside `state`.** It's module-local closure
   state in `tracker_state.js`, bridged via `getChannelStates()` /
   `setChannelStates()`. Project save/load has to remember to serialize it
   separately, and a plain page reload drops it. It belongs in the `state`
   object (or at least auto-persisted) so there's one serializable source of
   truth.

10. **"Engine-agnostic" is true for playback, leaky for the UI.**
    `tracker_ui.js` calls engine methods that aren't in the published
    SoundEngine interface (`liveUpdatePreview`, `importDx7Sysex`,
    `createDefaultInstrument`, …), and `scsp_panels.js` calls SCSP-only hooks
    (`setSlotPostProgramHook`, `dspSetSlotSend`, `dspSetSlotOutput`). A drop-in
    engine needs stubs for all of these or it throws. The interface in
    [engine-guide.md](engine-guide.md) should be expanded to match reality (or
    the UI should degrade gracefully when methods are absent).

11. **No undo/redo.** All edits mutate `state` in place. The only "rollback" is
    `commitCellEdit` reverting an over-budget edit. Adding history means
    snapshotting `state` (it's plain JSON, so feasible) around mutations.

12. **Single global WASM instance.** `scsp_wasm.cpp` uses one static
    `scsp_device` + one 512 KB RAM array. Fine for one tracker per page;
    precludes A/B-ing two engine states or multi-instance hosting without a
    rework.

---

## C. UI fragility

13. **Tight coupling to HTML element IDs and global function names.**
    `tracker_ui.js` and `scsp_panels.js` reach for dozens of literal IDs
    (`'grid'`, `'btn-play'`, `'octave'`, `'dsp-code'`, …) and expose handlers as
    `window.*` for inline `onclick=` attributes in `generate.py`'s template.
    Rename an ID in the HTML and code breaks silently (`getElementById` → null).
    This is the cost of "no framework"; if it grows, a small typed
    selector/registry layer would help.

14. **Full grid re-render on every keystroke.** `renderGrid()` rebuilds the
    entire pattern DOM (rows × 16 channels × sub-columns) on each cursor move or
    edit. Fine at 32–64 rows; sluggish for very large patterns. Incremental
    cell updates or virtual scrolling would fix it if it ever bites.

15. **Grid-focus tracking via `mousedown` containment.** Whether the grid "has
    focus" is inferred from where you last clicked. Overlays/dialogs can confuse
    it. `document.activeElement` or a real focus manager would be sturdier.

16. **Hand-rolled modal/overlay code.** The DX7 drop-warning dialog and the
    keyboard/about overlays are built with inline styles and ad-hoc drag
    handlers. They work but duplicate logic; a tiny shared overlay helper would
    DRY them up.

17. **Selection-change listeners have no unsubscribe.** `onSelectionChange`
    pushes callbacks into an array that's never cleaned up. Harmless given the
    singletons live for the page lifetime, but it's a latent leak pattern.

---

## D. Silent failures & lossy conversions

The recurring theme: errors are swallowed (logged at most) instead of surfaced.

18. **Waveform RAM overflow is silent.** Adding waveforms past the 512 KB sound
    RAM just `console.warn`s and skips; the user gets no feedback and an
    instrument silently lacks its sample.

19. **DSP program overflow is silent.** If NOP-alignment pushes a program past
    128 steps, the tail is dropped without a hard error.

20. **TON `level→TL` and DX7 hot patches clamp silently.** Out-of-range levels
    saturate to the register limits with no warning.

21. **Frequency ratios are rounded to 3 decimals** in TON (and DX7) conversion.
    Fine detune accumulates drift across repeated import/export round-trips.

22. **MIDI import drops all non-note data** (CC, pitch bend, aftertouch, SysEx,
    text meta). Not surfaced to the user; a file's expression/mod-wheel
    automation just vanishes.

23. **Velocity is stored but not sounded.** Cells carry a volume/velocity value
    and it round-trips through MIDI/SEQ, but playback envelopes are static —
    velocity currently doesn't scale amplitude. It's metadata only.

24. **Modulator-count fidelity across DX7→engine→TON.** DX7 import drops
    modulators beyond the SCSP's 2-per-slot limit (with a warning). Confirm the
    TON layer actually stores both modulator links before assuming
    two-modulator patches survive a TON round-trip end to end.

---

## E. Build / project hygiene

25. **No `package.json` / npm scripts.** JS tests are run by hand with
    `node --test`; e2e via `python3 -m pytest`. A `package.json` with `test`
    scripts (even with zero deps) would make the entry points discoverable and
    enable CI.

26. **No CI configuration.** Nothing runs the test suites automatically. Both
    suites are CI-friendly (Node built-in runner; Playwright headless).

27. **Committed build artifacts.** `scsp.js` / `scsp.wasm` are committed (so the
    repo works without Emscripten) and `.o` files are gitignored. Reasonable,
    but means the binary can drift from the C sources if someone forgets to
    rebuild; a CI step that rebuilds and diffs would catch it.

28. **`ALLOW_MEMORY_GROWTH=0`.** The WASM heap is fixed at 4 MB. Large custom
    sample sets could exhaust it; failures would be allocation errors rather
    than graceful messages.

---

## Quick triage suggestion

If you want to spend an afternoon making the project meaningfully more solid,
the highest value-to-effort items are: **A (1–6)** stale docs, **#9** (move
mute/solo into state), **#25/26** (`package.json` + CI), and **#7** (decide the
fate of the dead live-playback path). Sections C/D are mostly latent — fix them
when they actually bite or when you're already in that file.
