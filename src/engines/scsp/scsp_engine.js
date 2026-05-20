/**
 * @module scsp_engine
 * @description SCSP (Saturn Custom Sound Processor) sound engine for Bebhionn tracker.
 * Wraps all SCSP-specific code as an IIFE implementing the SoundEngine interface.
 * Provides FM synthesis, waveform generation, voice allocation, TON bank import/export,
 * and a DOM-based instrument editor. Communicates with an Emscripten-compiled SCSP
 * emulator via WASM for real-time audio rendering.
 *
 * @typedef {Object} SoundEngine
 * @property {function(): Promise<void>} init
 * @property {function(Object): void} startAudio
 * @property {function(number, number, number, Object): void} triggerNote
 * @property {function(number): void} releaseChannel
 * @property {function(): void} releaseAll
 * @property {function(ArrayBuffer, string): {instruments: Object[], message: string}} importBank
 * @property {function(ArrayBuffer, string): {instruments: Object[], message: string}} importDx7Sysex
 * @property {function(Object[]): ?Uint8Array} exportBank
 * @property {function(HTMLElement, Object, number, function): void} renderInstEditor
 * @property {function(): Object} createDefaultInstrument
 * @property {function(): Object[]} getPresets
 * @property {function(): number} getSampleRate
 */
var SCSPEngine = (function() {
    'use strict';

    // ── Constants ──────────────────────────────────────────────────────

    /** @constant {number} SAMPLE_RATE - Audio sample rate in Hz */
    var SAMPLE_RATE = 44100;
    /** @constant {number} WAVE_LEN - Default waveform length in samples */
    var WAVE_LEN = 1024;
    /** @constant {number} WAVE_BYTES - Default waveform size in bytes (16-bit samples) */
    var WAVE_BYTES = WAVE_LEN * 2;
    /** @constant {number} SINE_BASE_FREQ - Base frequency of a WAVE_LEN-sample waveform at SAMPLE_RATE */
    var SINE_BASE_FREQ = SAMPLE_RATE / WAVE_LEN;
    /** @constant {number} SINE_BASE_NOTE - MIDI note corresponding to SINE_BASE_FREQ */
    var SINE_BASE_NOTE = 69 + 12 * Math.log2(SINE_BASE_FREQ / 440);
    /** @constant {string[]} WAVE_NAMES - Names of the 10 built-in waveform types */
    var WAVE_NAMES = ['Sine','Sawtooth','Square','Triangle','Organ','Brass','Strings','Piano','Flute','Bass'];
    /** @constant {number} MAX_SLOTS - Maximum number of SCSP sound slots */
    var MAX_SLOTS = 32;
    /** @constant {number} SCSP_RAM_SIZE - Total SCSP RAM in bytes (512KB) */
    var SCSP_RAM_SIZE = 512 * 1024;

    // ── State ──────────────────────────────────────────────────────────
    var scsp = null, scspReady = false;
    var actx = null, fmNode = null, fmGain = null;
    var playbackRef = null;
    var waveStore = { waves: [], nextOffset: 0 };
    var slotPostProgramHook = null; // called after each slot is programmed: fn(slot)

    // ── Preset instruments (EBM / Industrial kit) ──────────────────────
    var PRESET_INSTRUMENTS = [
        // 1. FM Kick — fast-decaying modulator simulates pitch sweep; high MDL for transient click
        { name: 'FM Kick', operators: [
            { freq_ratio:1.0, freq_fixed:0, level:0.95, ar:31, d1r:24, dl:22, d2r:0, rr:26, mdl:0, mod_sources:[], feedback:5, is_carrier:false, waveform:0, loop_mode:1, loop_start:0, loop_end:1024 },
            { freq_ratio:1.0, freq_fixed:0, level:0.95, ar:31, d1r:12, dl:8, d2r:4, rr:22, mdl:13, mod_sources:[0], feedback:0, is_carrier:true, waveform:0, loop_mode:1, loop_start:0, loop_end:1024 },
        ]},
        // 2. Noise Snare — high feedback + inharmonic ratio → noise-like texture
        { name: 'Noise Snare', operators: [
            { freq_ratio:3.53, freq_fixed:0, level:0.85, ar:31, d1r:16, dl:12, d2r:6, rr:20, mdl:0, mod_sources:[], feedback:13, is_carrier:false, waveform:0, loop_mode:1, loop_start:0, loop_end:1024 },
            { freq_ratio:1.0,  freq_fixed:0, level:0.9,  ar:31, d1r:14, dl:10, d2r:4, rr:20, mdl:12, mod_sources:[0], feedback:0, is_carrier:true, waveform:0, loop_mode:1, loop_start:0, loop_end:1024 },
        ]},
        // 3. Metal Hat — inharmonic ratios (5.19, 1.414) for metallic character; short decay
        { name: 'Metal Hat', operators: [
            { freq_ratio:5.19,  freq_fixed:0, level:0.9, ar:31, d1r:18, dl:14, d2r:8, rr:22, mdl:0,  mod_sources:[], feedback:6, is_carrier:false, waveform:0, loop_mode:1, loop_start:0, loop_end:1024 },
            { freq_ratio:1.414, freq_fixed:0, level:0.7, ar:31, d1r:20, dl:18, d2r:10, rr:24, mdl:11, mod_sources:[0], feedback:0, is_carrier:true, waveform:0, loop_mode:1, loop_start:0, loop_end:1024 },
        ]},
        // 4. Acid Bass — self-feedback modulator creates saw-like harmonics; high MDL for grit
        { name: 'Acid Bass', operators: [
            { freq_ratio:1.0, freq_fixed:0, level:0.9, ar:31, d1r:8,  dl:4, d2r:0, rr:16, mdl:0,  mod_sources:[], feedback:8, is_carrier:false, waveform:0, loop_mode:1, loop_start:0, loop_end:1024 },
            { freq_ratio:1.0, freq_fixed:0, level:0.9, ar:31, d1r:10, dl:6, d2r:2, rr:16, mdl:11, mod_sources:[0],  feedback:0, is_carrier:true, waveform:0, loop_mode:1, loop_start:0, loop_end:1024 },
        ]},
        // 5. Harsh Lead — 3-op stacked chain (mod→mod→carrier); square-wave modulator for extra edge
        { name: 'Harsh Lead', operators: [
            { freq_ratio:3.0, freq_fixed:0, level:0.7,  ar:31, d1r:4, dl:2, d2r:0, rr:14, mdl:0,  mod_sources:[], feedback:7, is_carrier:false, waveform:2, loop_mode:1, loop_start:0, loop_end:1024 },
            { freq_ratio:1.0, freq_fixed:0, level:0.85, ar:31, d1r:2, dl:0, d2r:0, rr:14, mdl:10, mod_sources:[0],  feedback:0, is_carrier:false, waveform:0, loop_mode:1, loop_start:0, loop_end:1024 },
            { freq_ratio:1.0, freq_fixed:0, level:0.85, ar:31, d1r:2, dl:0, d2r:0, rr:14, mdl:11, mod_sources:[1],  feedback:0, is_carrier:true, waveform:0, loop_mode:1, loop_start:0, loop_end:1024 },
        ]},
        // 6. Dark Pad — slow attack, slight detune (1.003) for chorus warmth; strings waveform carrier
        { name: 'Dark Pad', operators: [
            { freq_ratio:1.003, freq_fixed:0, level:0.5, ar:16, d1r:0, dl:0, d2r:0, rr:12, mdl:0, mod_sources:[], feedback:5, is_carrier:false, waveform:0, loop_mode:1, loop_start:0, loop_end:1024 },
            { freq_ratio:1.0,   freq_fixed:0, level:0.7, ar:16, d1r:0, dl:0, d2r:0, rr:12, mdl:7, mod_sources:[0],  feedback:0, is_carrier:true, waveform:6, loop_mode:1, loop_start:0, loop_end:1024 },
        ]},
        // 7. Seq Pluck — fast-decaying modulator for percussive brightness; short body
        { name: 'Seq Pluck', operators: [
            { freq_ratio:2.0, freq_fixed:0, level:0.85, ar:31, d1r:18, dl:14, d2r:6, rr:20, mdl:0,  mod_sources:[], feedback:6, is_carrier:false, waveform:0, loop_mode:1, loop_start:0, loop_end:1024 },
            { freq_ratio:1.0, freq_fixed:0, level:0.8,  ar:31, d1r:14, dl:10, d2r:4, rr:18, mdl:10, mod_sources:[0],  feedback:0, is_carrier:true, waveform:0, loop_mode:1, loop_start:0, loop_end:1024 },
        ]},
        // 8. Industrial Hit — max feedback = white noise source; inharmonic carrier + square wave for metallic body
        { name: 'Industrial Hit', operators: [
            { freq_ratio:1.0,  freq_fixed:0, level:0.9,  ar:31, d1r:14, dl:10, d2r:6, rr:18, mdl:0,  mod_sources:[], feedback:15, is_carrier:false, waveform:0, loop_mode:1, loop_start:0, loop_end:1024 },
            { freq_ratio:1.73, freq_fixed:0, level:0.85, ar:31, d1r:12, dl:8,  d2r:4, rr:18, mdl:13, mod_sources:[0],  feedback:0, is_carrier:true, waveform:2, loop_mode:1, loop_start:0, loop_end:1024 },
        ]},
    ];

    // ── Internal functions ─────────────────────────────────────────────

    /**
     * @description Generate a waveform via additive synthesis, normalized to [-1, 1].
     * @param {number} n - Number of samples to generate
     * @param {Array<[number, number]>} harmonics - Array of [harmonic_number, amplitude] pairs
     * @returns {Float32Array} Peak-normalized waveform samples
     */
    function genAdditive(n, harmonics) {
        var out = new Float32Array(n);
        for (var k = 0; k < harmonics.length; k++) {
            var h = harmonics[k][0], a = harmonics[k][1];
            for (var i = 0; i < n; i++) out[i] += a * Math.sin(2 * Math.PI * h * i / n);
        }
        var peak = 0;
        for (var i = 0; i < n; i++) if (Math.abs(out[i]) > peak) peak = Math.abs(out[i]);
        if (peak > 0) for (var i = 0; i < n; i++) out[i] /= peak;
        return out;
    }

    /**
     * @description Generate one of 10 named waveforms by type index.
     * 0=Sine, 1=Sawtooth, 2=Square, 3=Triangle, 4=Organ, 5=Brass,
     * 6=Strings, 7=Piano, 8=Flute, 9=Bass.
     * @param {number} type - Waveform type index (0-9)
     * @param {number} n - Number of samples to generate
     * @returns {Float32Array} Generated waveform samples
     */
    function generateWaveform(type, n) {
        switch (type) {
        case 0: return genAdditive(n, [[1, 1.0]]);
        case 1: return genAdditive(n, Array.from({length:15}, function(_, i) { return [i+1, (((i+1)%2===0)?-1:1)/(i+1)]; }));
        case 2: return genAdditive(n, Array.from({length:8}, function(_, i) { return [2*i+1, 1.0/(2*i+1)]; }));
        case 3: return genAdditive(n, Array.from({length:8}, function(_, i) { return [2*i+1, ((i%2===0)?1:-1)/((2*i+1)*(2*i+1))]; }));
        case 4: return genAdditive(n, [[1,1],[2,0.8],[3,0.6],[4,0.3],[6,0.2],[8,0.15],[10,0.1]]);
        case 5: return genAdditive(n, [[1,1],[2,0.3],[3,0.7],[4,0.15],[5,0.5],[6,0.1],[7,0.3],[9,0.15]]);
        case 6: return genAdditive(n, Array.from({length:20}, function(_, i) { return [i+1, 1.0/Math.pow(i+1, 1.2)]; }));
        case 7: return genAdditive(n, [[1,1],[2,0.7],[3,0.4],[4,0.25],[5,0.15],[6,0.1],[7,0.08],[8,0.05]]);
        case 8: return genAdditive(n, [[1,1],[2,0.15],[3,0.05]]);
        case 9: return genAdditive(n, [[1,1],[2,0.5],[3,0.2],[4,0.1]]);
        default: return new Float32Array(n);
        }
    }

    /**
     * @description Store a waveform in SCSP RAM as 16-bit PCM. Converts float samples
     * to signed 16-bit and writes them at the next available offset.
     * @param {number} ramPtr - Pointer to SCSP RAM base in WASM heap
     * @param {Float32Array} floatSamples - Waveform samples in [-1, 1] range
     * @param {number} loopStart - Loop start point in samples
     * @param {number} loopEnd - Loop end point in samples
     * @param {number} loopMode - SCSP loop control mode (0=off, 1=forward, 2=reverse, 3=alternating)
     * @returns {number} Waveform ID, or 0 if RAM is full
     */
    function waveStoreAdd(ramPtr, floatSamples, loopStart, loopEnd, loopMode) {
        var offset = waveStore.nextOffset;
        var len = floatSamples.length;
        var byteSize = len * 2;
        if (offset + byteSize > SCSP_RAM_SIZE) {
            console.warn('waveStoreAdd: skipping, would exceed 512KB RAM');
            return 0;
        }
        for (var i = 0; i < len; i++) {
            var val = Math.round(floatSamples[i] * 32767);
            scsp.HEAPU8[ramPtr + offset + i * 2]     = val & 0xFF;
            scsp.HEAPU8[ramPtr + offset + i * 2 + 1] = (val >> 8) & 0xFF;
        }
        var id = waveStore.waves.length;
        waveStore.waves.push({ offset: offset, length: len, loopStart: loopStart, loopEnd: loopEnd, loopMode: loopMode });
        waveStore.nextOffset = offset + byteSize;
        return id;
    }

    // ── Voice allocator ────────────────────────────────────────────────

    var voiceAlloc = {
        voices: [],
        time: 0,
        allocate: function(ch, note, numOps) {
            this.release(ch);
            var used = new Set();
            for (var v = 0; v < this.voices.length; v++)
                for (var s = 0; s < this.voices[v].slots.length; s++) used.add(this.voices[v].slots[s]);
            var startSlot = -1;
            for (var s = 0; s <= MAX_SLOTS - numOps; s++) {
                var ok = true;
                for (var j = 0; j < numOps; j++) { if (used.has(s + j)) { ok = false; break; } }
                if (ok) { startSlot = s; break; }
            }
            if (startSlot < 0) {
                if (this.voices.length > 0) {
                    this.voices.sort(function(a, b) { return a.time - b.time; });
                    var stolen = this.voices.shift();
                    for (var s2 = 0; s2 < stolen.slots.length; s2++) scsp._scsp_key_off(stolen.slots[s2]);
                    startSlot = stolen.slots[0];
                } else {
                    startSlot = 0;
                }
            }
            var slots = [];
            for (var j2 = 0; j2 < numOps; j2++) slots.push(startSlot + j2);
            this.voices.push({ ch: ch, note: note, slots: slots, time: this.time++ });
            return slots;
        },
        release: function(ch, note) {
            var idx = note !== undefined
                ? this.voices.findIndex(function(v) { return v.ch === ch && v.note === note; })
                : this.voices.findIndex(function(v) { return v.ch === ch; });
            if (idx >= 0) {
                var v = this.voices[idx];
                for (var s = 0; s < v.slots.length; s++) scsp._scsp_key_off(v.slots[s]);
                this.voices.splice(idx, 1);
            }
        },
        releaseAll: function() {
            for (var v = 0; v < this.voices.length; v++)
                for (var s = 0; s < this.voices[v].slots.length; s++) scsp._scsp_key_off(this.voices[v].slots[s]);
            this.voices = [];
        }
    };

    // ── resetSCSP ──────────────────────────────────────────────────────

    /**
     * @description Reset SCSP emulator state: re-initialize hardware, release all voices,
     * clear waveform store, and reload the 10 built-in waveforms into RAM.
     */
    function resetSCSP() {
        scsp._scsp_init();
        voiceAlloc.releaseAll();
        waveStore.waves = [];
        waveStore.nextOffset = 0;
        var ramPtr = scsp._scsp_get_ram_ptr();
        for (var t = 0; t < WAVE_NAMES.length; t++) {
            var samples = generateWaveform(t, WAVE_LEN);
            waveStoreAdd(ramPtr, samples, 0, WAVE_LEN, 1);
        }
    }

    // ── Shared slot programming helpers ─────────────────────────────────
    //
    // programSlot (high-level) and programSlotRaw (TON passthrough) used to
    // duplicate pitch math, envelope packing, FM ring-buffer offset remap,
    // and the 12-line scsp_write_slot sequence at the bottom. These helpers
    // consolidate everything that's actually shareable. What still differs
    // intentionally is the *source* of each register word (derived from op
    // vs. passed through from rawRegs) and the base-note formula (see
    // project_bebhionn_basenote_bug.md for a known latent pitch divergence
    // that we preserve here rather than silently change).

    /** Natural base MIDI note of a waveform: the note at which its natural
     *  period plays back at OCT=0 FNS=0 (no hardware pitch shift). */
    function wavBaseNoteFor(wavLen) {
        return 69 + 12 * Math.log2(SAMPLE_RATE / wavLen / 440);
    }

    /** Pack OCT/FNS register bits from a desired MIDI note and the base note
     *  at which the underlying sample plays unshifted. */
    function computeOctFnsBits(midiNote, opBaseNote) {
        var semi = midiNote - opBaseNote;
        var octave = Math.max(-8, Math.min(7, Math.floor(semi / 12)));
        var frac = semi - octave * 12;
        var fns = Math.max(0, Math.min(1023, Math.round(1024 * (Math.pow(2, frac / 12) - 1))));
        return ((octave & 0xF) << 11) | (fns & 0x3FF);
    }

    /** Normalize an operator's modulation-source list. Accepts either the
     *  new mod_sources: int[] field or the legacy mod_source: int (-1 = none)
     *  for backward compatibility with older saved projects. Returns a clean
     *  array of 0..2 op indices (capped because the SCSP only has X and Y
     *  modulation inputs).
     */
    function getModSources(op) {
        var arr = [];
        if (Array.isArray(op.mod_sources)) {
            for (var i = 0; i < op.mod_sources.length; i++) {
                var s = op.mod_sources[i];
                if (typeof s === 'number' && s >= 0) arr.push(s);
            }
        } else if (typeof op.mod_source === 'number' && op.mod_source >= 0) {
            arr.push(op.mod_source);
        }
        return arr.slice(0, 2);
    }

    /** Compute d7 (MDL|MDXSL|MDYSL) from a high-level op, resolving each
     *  mod source in op.mod_sources to an absolute slot via slotBase.
     *  Used by programSlot.
     *
     *  Sound-stack indexing (Sega SCSP doc 4.2/4.3): the chip reads two 6-bit
     *  ring offsets into a 64-entry sound stack updated 32×/Fs. MDXSL and
     *  MDYSL are independent — slots can have up to two distinct external
     *  modulators (the doc's slot-2-modulated-by-{0,1} example). For an
     *  external mod at slot M reading from carrier at slot C, the modulator's
     *  previous-Fs write sits at (M-C)&63 — the standard 1-Fs-latency FM
     *  convention. Ring offset 0x20 is "1 Fs ago" (the doc's "latest") and
     *  0x00 is "2 Fs ago" ("past") for the slot's own output.
     *
     *  Wiring rules (from p04_fm1/2/3):
     *   - 1 external mod: MDXSL = MDYSL = (M-C)&63. Doc: "If you set it to
     *     input only on one side, unexpected data may be mixed in or the
     *     FM modulation degree may seem small."
     *   - 2 external mods: MDXSL = distA, MDYSL = distB, both at the
     *     latest sample. Doc: "Basically, when entering slots with different
     *     numbers, enter samples of the same generation."
     *   - Pure self-feedback: MDXSL = 0x20 (latest), MDYSL = 0x00 (past).
     *     Doc: feeding the same self-output to both inputs can oscillate.
     *   - 1 external mod + self-feedback: X = mod's latest, Y = self past.
     *   - 2 external mods + self-feedback: doesn't fit in the chip's two
     *     inputs. Self-FB wins on Y, mod #2 is dropped.
     */
    function computeD7FromOp(op, slot, slotBase) {
        var SELF_LATEST = 0x20;
        var SELF_PAST   = 0x00;
        var mdl = 0, mdxsl = 0, mdysl = 0;
        var sources = getModSources(op);
        var hasMod = (sources.length > 0 && op.mdl > 0);
        var fbMdl = Math.round(op.feedback || 0) & 0xF;
        if (hasMod) {
            mdl = Math.round(op.mdl) & 0xF;
            var dist1 = (slotBase + sources[0] - slot) & 63;
            mdxsl = dist1;
            if (sources.length >= 2 && !(fbMdl > 0)) {
                mdysl = (slotBase + sources[1] - slot) & 63;
            } else {
                mdysl = dist1;
            }
        }
        if (fbMdl > 0) {
            if (hasMod) {
                mdysl = SELF_PAST;
                if (fbMdl > mdl) mdl = fbMdl;
            } else {
                mdl = fbMdl;
                mdxsl = SELF_LATEST;
                mdysl = SELF_PAST;
            }
        }
        return ((mdl & 0xF) << 12) | ((mdxsl & 0x3F) << 6) | (mdysl & 0x3F);
    }

    /** Remap d7's MDXSL/MDYSL fields from a TON-imported raw d7 to reflect
     *  the current slot allocation; preserves MDL as-is. Used by
     *  programSlotRaw. Mirrors computeD7FromOp's wiring rules for 0/1/2
     *  external modulators and the self-FB fallback. */
    function remapD7Raw(rawD7, modSources, slot, slotBase) {
        var mdl = (rawD7 >> 12) & 0xF;
        if (mdl === 0) return rawD7 & 0xF000;
        var sources = Array.isArray(modSources) ?
            modSources.filter(function(s) { return typeof s === 'number' && s >= 0; }) :
            (typeof modSources === 'number' && modSources >= 0 ? [modSources] : []);
        sources = sources.slice(0, 2);
        if (sources.length >= 2) {
            var distA = (slotBase + sources[0] - slot) & 63;
            var distB = (slotBase + sources[1] - slot) & 63;
            return (mdl << 12) | (distA << 6) | distB;
        }
        if (sources.length === 1) {
            var dist = (slotBase + sources[0] - slot) & 63;
            return (mdl << 12) | (dist << 6) | dist;
        }
        return (mdl << 12) | (0x20 << 6) | 0x00; // self-FB
    }

    /** Write a pre-computed register bundle to a SCSP slot. This is the single
     *  low-level write sequence shared by programSlot and programSlotRaw. */
    function writeSlotRegisters(slot, regs) {
        var d0 = ((regs.lpctl & 3) << 5) | ((regs.sa >> 16) & 0xF);
        scsp._scsp_write_slot(slot, 0x0, d0);
        scsp._scsp_write_slot(slot, 0x1, regs.sa & 0xFFFF);
        scsp._scsp_write_slot(slot, 0x2, regs.lsa);
        scsp._scsp_write_slot(slot, 0x3, regs.lea);
        scsp._scsp_write_slot(slot, 0x4, regs.d4);
        scsp._scsp_write_slot(slot, 0x5, regs.d5);
        scsp._scsp_write_slot(slot, 0x6, regs.tl & 0xFF);
        scsp._scsp_write_slot(slot, 0x7, regs.d7);
        scsp._scsp_write_slot(slot, 0x8, regs.octBits);
        scsp._scsp_write_slot(slot, 0x9, 0);
        scsp._scsp_write_slot(slot, 0xA, 0);
        // Write DISDL/DIPAN (upper byte of 0xB) preserving EFSDL/EFPAN (lower byte)
        scsp._scsp_slot_set_direct_output(slot, regs.disdl & 7, regs.dipan & 0x1F);
        if (slotPostProgramHook) slotPostProgramHook(slot);
    }

    // ── programSlot ────────────────────────────────────────────────────

    /**
     * @description Program a SCSP slot from high-level operator parameters.
     * Derives pitch (from freq_ratio or freq_fixed via the waveform's natural
     * base note), envelope registers, TL from level, and FM routing from
     * mod_source + feedback. Modulators and FM carriers are forced onto the
     * default 1024-sample waveform because the SCSP's FM math assumes a
     * 1024-sample cycle.
     * @param {number} slot - SCSP slot index (0-31)
     * @param {Object} op - High-level operator parameters (freq_ratio, level, ar, d1r, etc.)
     * @param {number} midiNote - MIDI note number to play (0-127)
     * @param {number} slotBase - First slot index of this voice (used to resolve mod_source to an absolute slot)
     */
    function programSlot(slot, op, midiNote, slotBase) {
        var wid = op.waveform || 0;
        var wav = waveStore.waves[wid] || waveStore.waves[0];

        var lsa = op.loop_start >= 0 ? op.loop_start : wav.loopStart;
        var lea = op.loop_end > 0 ? op.loop_end : wav.loopEnd;
        var lpctl = op.loop_mode >= 0 ? op.loop_mode : wav.loopMode;
        var sa = wav.offset;

        var usesFM = (getModSources(op).length > 0 && op.mdl >= 5) || op.feedback > 0;
        var isMod = !op.is_carrier;
        if (usesFM || isMod) {
            if (wav.length !== WAVE_LEN) {
                wav = waveStore.waves[0];
                sa = wav.offset;
            }
            lsa = 0; lea = WAVE_LEN; lpctl = 1;
        }

        var wavLen = wav.length || WAVE_LEN;

        // Pitch base note: PCM samples and period waveforms anchor differently.
        //  - PCM sample (sample_rate set, not driving FM): the stored buffer
        //    is an arbitrary recording, not one period. At OCT=0/FNS=0 the
        //    SCSP advances one stored sample per output sample (playback rate
        //    = SAMPLE_RATE). So to make the recording sound at its natural
        //    pitch when the user plays op.root_note, the OCT=0 anchor note is
        //    root_note shifted by the rate ratio: an N-fold rate increase is
        //    +12·log2(N) semitones.
        //  - Period waveform (built-in sine/saw/etc., or any FM role): the
        //    buffer is one cycle, so opBaseNote derives from its natural
        //    period at SAMPLE_RATE.
        // Either way, wavBaseFreq = 440 * 2^((wavBaseNote-69)/12) gives the
        // audible Hz at the OCT=0 anchor (this expression equals SAMPLE_RATE/
        // wavLen for the period case — same formula, different anchor).
        // freq_ratio applies as a semitone offset on top of either base.
        var isPcmSample = !usesFM && !isMod && op.sample_rate > 0;
        var wavBaseNote;
        if (isPcmSample) {
            var rootNote = (op.root_note != null) ? op.root_note : 69;
            wavBaseNote = rootNote + 12 * Math.log2(SAMPLE_RATE / op.sample_rate);
        } else {
            wavBaseNote = wavBaseNoteFor(wavLen);
        }
        var wavBaseFreq = 440 * Math.pow(2, (wavBaseNote - 69) / 12);

        // Pitch (OCT/FNS): two cases.
        //  - freq_ratio mode: opBaseNote = wavBaseNote shifted down by the ratio
        //    in semitones, so midiNote=69 with ratio=1 plays at A4. OCT/FNS is
        //    derived from (midiNote - opBaseNote) so the tracker note controls
        //    pitch as usual.
        //  - freq_fixed mode: the operator's audible frequency must stay at
        //    op.freq_fixed Hz regardless of the tracker note. Map freq_fixed
        //    onto the MIDI scale and use *that* as the effective note relative
        //    to wavBaseNote — the tracker midiNote drops out of the math.
        //    (Per SCSP doc §4.2.5: OCT/FNS is a multiplier of the sample's
        //    native rate.)
        var octBits;
        if (op.freq_fixed > 0) {
            var fixedNote = wavBaseNote + 12 * Math.log2(op.freq_fixed / wavBaseFreq);
            octBits = computeOctFnsBits(fixedNote, wavBaseNote);
        } else {
            var opBaseNote = wavBaseNote - 12 * Math.log2(op.freq_ratio || 1);
            octBits = computeOctFnsBits(midiNote, opBaseNote);
        }

        // TL: match TON persistence (ton_io.js exportTon/importTon) and syncRawRegs.
        // Linear-in-level formula is kept here for consistency with the on-disk
        // format; log-domain TL mapping is a separate discussion (see DX7
        // converter loudness work).
        var tl = Math.max(0, Math.min(255, Math.round((1.0 - (op.level || 0)) * 128)));

        var d4 = ((op.d2r & 0x1F) << 11) | ((op.d1r & 0x1F) << 6) | (op.ar & 0x1F);
        // KRS=0xf disables key-rate scaling so the effective envelope rate
        // is 2*R rather than octave+2*R+fns_msb. Without this, the documented
        // AR_TIMES/DR_TIMES tables (which assume KRS=0xf) disagree with what
        // the hardware actually produces, and the DX7 converter's rate→time
        // mapping is wrong for any note other than ~A3. Matches scsp_voice.c.
        var d5 = (0xF << 10) | ((op.dl & 0x1F) << 5) | (op.rr & 0x1F);
        var d7 = computeD7FromOp(op, slot, slotBase);

        // DISDL: per-op override wins (used by the DX7 importer to avoid
        // multi-carrier saturation — scsp.c's per-slot mixer applies a 4×
        // gain so DISDL=7 on a single unity carrier already clips). Legacy
        // UI presets and TON-imported patches still fall back to the
        // is_carrier ? 7 : 0 heuristic they were authored against.
        var disdl = (typeof op.disdl === 'number') ?
            (op.disdl & 7) : (op.is_carrier ? 7 : 0);

        writeSlotRegisters(slot, {
            sa: sa, lsa: lsa, lea: lea, lpctl: lpctl,
            d4: d4, d5: d5, tl: tl, d7: d7, octBits: octBits,
            disdl: disdl, dipan: 16,
        });
    }

    // ── programSlotRaw ─────────────────────────────────────────────────

    /**
     * @description Program a SCSP slot from raw TON register data. Only recalculates
     * pitch (octave + FNS) and FM ring buffer offsets (to account for the current
     * slot allocation); all other register values pass through from the imported TON.
     *
     * The TON format's baseNote convention anchors freq_ratio=1.0 to MIDI 69
     * (saturn_kit's 100-sample-wave assumption). For our actual 1024-sample
     * waveforms the natural base note is `wavBaseNoteFor(wavLen)` ≈ 28.75, so
     * we shift by `(wavBaseNote - 69)` before computing OCT/FNS. Without this
     * shift TON-imported patches play ~40 semitones lower than the same patch
     * via programSlot, which radically changes the FM character (the modulator
     * runs at sub-audio rate and degrades into LFO-style wobble).
     *
     * dipan is also forced to 16 (center) to match programSlot — both
     * saturn_kit and ton_io.js export with DIPAN=0 (hard right), so without
     * this override every TON-loaded voice pans to one side.
     *
     * @param {number} slot - SCSP slot index (0-31)
     * @param {Object} rawRegs - Raw register values (d0, d4, d5, d7, tl, dB, baseNote, lsa, lea, sa)
     * @param {number} midiNote - MIDI note number to play (0-127)
     * @param {number} sa - Sample address (byte offset in SCSP RAM)
     * @param {number} slotBase - First slot index of this voice (for relative mod_source calculation)
     * @param {number} opIndex - Operator index within the instrument (currently unused but kept for future per-op routing)
     * @param {number} wavLen - Waveform length in samples (for clamping loop points)
     * @param {number[]} modSources - Modulation source operator indices (0..2 entries; empty for none/feedback)
     * @param {number} freqFixed - If > 0, play at this absolute Hz instead of letting midiNote drive pitch (matches programSlot's freq_fixed path)
     */
    function programSlotRaw(slot, rawRegs, midiNote, sa, slotBase, opIndex, wavLen, modSources, freqFixed) {
        var octBits;
        if (freqFixed > 0) {
            var wavBaseFreq = SAMPLE_RATE / wavLen;
            var wavBaseNote = wavBaseNoteFor(wavLen);
            var fixedNote = wavBaseNote + 12 * Math.log2(freqFixed / wavBaseFreq);
            octBits = computeOctFnsBits(fixedNote, wavBaseNote);
        } else {
            var opBaseNote = rawRegs.baseNote + (wavBaseNoteFor(wavLen) - 69);
            octBits = computeOctFnsBits(midiNote, opBaseNote);
        }
        var d7 = remapD7Raw(rawRegs.d7, modSources, slot, slotBase);
        var lpctl = (rawRegs.d0 >> 5) & 3;

        writeSlotRegisters(slot, {
            sa: sa,
            lsa: Math.min(rawRegs.lsa, wavLen),
            lea: Math.min(rawRegs.lea, wavLen),
            lpctl: lpctl,
            d4: rawRegs.d4,
            d5: rawRegs.d5,
            tl: rawRegs.tl,
            d7: d7,
            octBits: octBits,
            disdl: (rawRegs.dB >> 13) & 7,
            dipan: 16,
        });
    }

    // ── syncRawRegs ────────────────────────────────────────────────────

    /**
     * @description Sync high-level operator parameters back to raw SCSP registers.
     * Called when the user edits a parameter in the instrument editor, so that
     * subsequent programSlotRaw calls reflect the changes.
     * @param {Object} op - Operator object with both high-level params and a rawRegs sub-object
     */
    function syncRawRegs(op) {
        if (!op.rawRegs) return;
        if (op.freq_ratio > 0) {
            var ratioSemitones = Math.round(12 * Math.log2(op.freq_ratio));
            op.rawRegs.baseNote = Math.max(0, Math.min(127, 69 - ratioSemitones));
        }
        op.rawRegs.tl = Math.max(0, Math.min(255, Math.round((1.0 - (op.level || 0)) * 128)));
        var ar = Math.round(op.ar || 0) & 0x1F;
        var d1r = Math.round(op.d1r || 0) & 0x1F;
        var d2r = Math.round(op.d2r || 0) & 0x1F;
        op.rawRegs.d4 = (d2r << 11) | (d1r << 6) | ar;
        var krs = (op.rawRegs.d5 >> 10) & 0xF;
        var dl = Math.round(op.dl || 0) & 0x1F;
        var rr = Math.round(op.rr || 0) & 0x1F;
        op.rawRegs.d5 = (krs << 10) | (dl << 5) | rr;
        var mdl = Math.round(op.mdl || 0) & 0xF;
        op.rawRegs.d7 = (op.rawRegs.d7 & 0x0FFF) | (mdl << 12);
        var disdl = op.is_carrier ? 7 : 0;
        var dipan = (op.rawRegs.dB >> 8) & 0x1F;
        op.rawRegs.dB = ((disdl << 5) | dipan) << 8 | (op.rawRegs.dB & 0xFF);
        op.rawRegs.lsa = op.loop_start || 0;
        op.rawRegs.lea = op.loop_end || 1024;
        var lpctl = (op.loop_mode !== undefined ? op.loop_mode : 1) & 3;
        op.rawRegs.d0 = (op.rawRegs.d0 & 0x1F) | (lpctl << 5);
    }

    // ── _triggerNote ───────────────────────────────────────────────────

    /**
     * @description Play a note: allocate voice slots via the voice allocator, program each
     * operator's slot (using raw or high-level path), then key-on all slots.
     * @param {number} ch - Channel number (used for voice allocation/release tracking)
     * @param {number} midiNote - MIDI note number (0-127)
     * @param {number} instIdx - Instrument index (for logging only)
     * @param {Object} inst - Instrument object with an operators array
     */
    function _triggerNote(ch, midiNote, instIdx, inst) {
        if (!inst) { console.warn('[triggerNote] no inst at', instIdx); return; }
        var ops = inst.operators;
        var slots = voiceAlloc.allocate(ch, midiNote, ops.length);
        var slotBase = slots[0];
        for (var i = 0; i < ops.length; i++) {
            var op = ops[i];
            if (op.rawRegs) {
                if (op.useTonSA) {
                    var origSA = ((op.rawRegs.d0 & 0x0F) << 16) | op.rawRegs.sa;
                    programSlotRaw(slots[i], op.rawRegs, midiNote, origSA, slotBase, i, op.rawRegs.lea, getModSources(op), op.freq_fixed || 0);
                } else {
                    var wav = waveStore.waves[op.waveform || 0] || waveStore.waves[0];
                    programSlotRaw(slots[i], op.rawRegs, midiNote, wav.offset, slotBase, i, wav.length, getModSources(op), op.freq_fixed || 0);
                }
            } else {
                programSlot(slots[i], op, midiNote, slotBase);
            }
        }
        for (var s = 0; s < slots.length; s++) scsp._scsp_key_on(slots[s]);
    }

    // ── _importBank ────────────────────────────────────────────────────

    /**
     * @description Import a TON file: byte-swap and copy into SCSP RAM, parse instrument
     * definitions via TonIO, then reload built-in waveforms after the TON data.
     * On error, resets to preset instruments.
     * @param {ArrayBuffer} arrayBuffer - Raw TON file contents
     * @param {string} label - Display name for status messages (e.g. filename)
     * @returns {{instruments: ?Object[], message: string}} Parsed instruments and status message
     */
    function _importBank(arrayBuffer, label) {
        try {
            scsp._scsp_init();
            voiceAlloc.releaseAll();
            var ramPtr = scsp._scsp_get_ram_ptr();
            var tonBytes = new Uint8Array(arrayBuffer);

            if (tonBytes.length > SCSP_RAM_SIZE) {
                return { instruments: null, message: label + ' exceeds 512KB SCSP RAM' };
            }

            if (ramPtr + tonBytes.length > scsp.HEAPU8.length) {
                return { instruments: null, message: 'TON too large for WASM heap' };
            }

            // Byte-swap entire file (BE->LE) into SCSP RAM
            for (var i = 0; i < tonBytes.length - 1; i += 2) {
                scsp.HEAPU8[ramPtr + i]     = tonBytes[i + 1];
                scsp.HEAPU8[ramPtr + i + 1] = tonBytes[i];
            }

            var result = TonIO.importTon(arrayBuffer);

            // Reset waveStore and load built-in waveforms after TON data
            waveStore.waves = [];
            waveStore.nextOffset = tonBytes.length;
            for (var t = 0; t < WAVE_NAMES.length; t++) {
                var samples = generateWaveform(t, WAVE_LEN);
                waveStoreAdd(ramPtr, samples, 0, WAVE_LEN, 1);
            }

            var instruments = [];
            for (var pi = 0; pi < result.patches.length; pi++) {
                var p = result.patches[pi];
                instruments.push({
                    name: p.name || ('Voice ' + pi),
                    operators: p.operators.map(function(o) {
                        return {
                            freq_ratio: o.freq_ratio || 1, freq_fixed: 0,
                            level: o.level !== undefined ? o.level : 0.8,
                            ar: o.ar !== undefined ? o.ar : 31, d1r: o.d1r || 0, dl: o.dl || 0,
                            d2r: o.d2r || 0, rr: o.rr !== undefined ? o.rr : 14,
                            mdl: o.mdl || 0,
                            mod_sources: Array.isArray(o.mod_sources) ? o.mod_sources.slice() :
                                (typeof o.mod_source === 'number' && o.mod_source >= 0 ? [o.mod_source] : []),
                            feedback: o.feedback || 0, is_carrier: o.is_carrier !== undefined ? o.is_carrier : true,
                            waveform: 0, loop_mode: o.loop_mode !== undefined ? o.loop_mode : 1,
                            loop_start: o.loop_start || 0, loop_end: o.loop_end || 1024,
                            rawRegs: o.rawRegs || null,
                            useTonSA: true,
                        };
                    })
                });
            }

            scspReady = true;
            return { instruments: instruments, message: 'Loaded ' + instruments.length + ' instruments from ' + label + ' (' + Math.round(tonBytes.length/1024) + 'KB)' };
        } catch (err) {
            console.error('TON load error:', err);
            resetSCSP();
            scspReady = true;
            return { instruments: JSON.parse(JSON.stringify(PRESET_INSTRUMENTS)), message: 'Error loading ' + label + ': ' + err.message + ' — reset to presets' };
        }
    }

    // ── _renderInstEditor ──────────────────────────────────────────────

    /**
     * @description Build SCSP-specific instrument editor DOM. Renders operator tabs
     * (with add/remove), parameter sliders (ratio, level, AR, D1R, DL, D2R, RR, FB, MDL),
     * mod source and waveform dropdowns, carrier toggle, and a test-note button.
     * Each parameter change calls syncRawRegs to keep raw registers in sync.
     * @param {HTMLElement} container - DOM element to render into (cleared first)
     * @param {Object} inst - Instrument object with operators array
     * @param {number} selectedOp - Currently selected operator index
     * @param {function} onChange - Callback invoked when any parameter changes
     */
    function _renderInstEditor(container, inst, selectedOp, onChange) {
        container.innerHTML = '';
        if (!inst) return;

        // Operator tabs
        var tabBar = document.createElement('div');
        tabBar.style.marginBottom = '4px';
        for (var i = 0; i < inst.operators.length; i++) {
            var tab = document.createElement('span');
            tab.className = 'op-tab' + (i === selectedOp ? ' sel' : '') + (inst.operators[i].is_carrier ? ' carrier' : '');
            tab.textContent = 'Op' + (i + 1);
            tab.title = inst.operators[i].is_carrier ? 'Carrier — outputs audio directly' : 'Modulator — shapes other operators\' timbre via FM';
            tab.onclick = (function(idx) { return function() { _renderInstEditor(container, inst, idx, onChange); if (onChange) onChange({selectedOp: idx}); }; })(i);
            tabBar.appendChild(tab);
        }
        var addOp = document.createElement('span');
        addOp.className = 'op-tab'; addOp.textContent = '+';
        addOp.title = 'Add operator (up to 6). New operators start as carriers — set Mod source on another op to use as modulator.';
        addOp.onclick = function() {
            if (inst.operators.length >= 6) return;
            inst.operators.push({ freq_ratio:1.0, freq_fixed:0, level:0.8, ar:31, d1r:0, dl:0, d2r:0, rr:14, mdl:0, mod_sources:[], feedback:0, is_carrier:true, waveform:0, loop_mode:1, loop_start:0, loop_end:1024 });
            _renderInstEditor(container, inst, inst.operators.length - 1, onChange);
            if (onChange) onChange();
        };
        tabBar.appendChild(addOp);
        if (inst.operators.length > 1) {
            var rmOp = document.createElement('span');
            rmOp.className = 'op-tab'; rmOp.textContent = '-';
            rmOp.title = 'Remove the selected operator';
            rmOp.onclick = function() {
                inst.operators.splice(selectedOp, 1);
                var newSel = selectedOp >= inst.operators.length ? inst.operators.length - 1 : selectedOp;
                _renderInstEditor(container, inst, newSel, onChange);
                if (onChange) onChange();
            };
            tabBar.appendChild(rmOp);
        }
        container.appendChild(tabBar);

        // Collapsible help section
        var helpToggle = document.createElement('div');
        helpToggle.style.cssText = 'font-size:9px;color:#668;cursor:pointer;margin:4px 0 6px;user-select:none;';
        helpToggle.textContent = '\u24d8 Operator help';
        var helpBox = document.createElement('div');
        helpBox.style.cssText = 'display:none;font-size:9px;color:#889;background:#0e0e22;border:1px solid #2a2a4e;border-radius:3px;padding:6px 8px;margin-bottom:6px;line-height:1.5;';
        helpBox.innerHTML =
            '<b style="color:#00d4ff;">FM Synthesis Basics</b><br>' +
            '<b>Carriers</b> (green tabs) produce audible sound. ' +
            '<b>Modulators</b> shape the timbre of the operator they feed into.<br><br>' +
            '<b style="color:#00d4ff;">Adding Operators</b><br>' +
            'Click <b>+</b> to add (up to 6). New ops start as carriers.<br><br>' +
            '<b style="color:#00d4ff;">Wiring Operators</b><br>' +
            '1. Add a second operator<br>' +
            '2. Uncheck <b>Carrier</b> on the modulator op<br>' +
            '3. On the carrier op, set <b>Mod</b> to the modulator<br>' +
            '4. Adjust <b>MDL</b> to control modulation intensity<br>' +
            'The modulator\'s <b>Ratio</b> sets the harmonic relationship.<br><br>' +
            '<b style="color:#00d4ff;">Envelope (ADSR)</b><br>' +
            '<b>AR</b> \u2192 attack, <b>D1R</b> \u2192 decay to <b>DL</b> sustain level, ' +
            '<b>D2R</b> \u2192 sustain fade, <b>RR</b> \u2192 release after note-off.<br>' +
            'On modulators, the envelope shapes how the timbre evolves over time.';
        helpToggle.onclick = function() {
            var open = helpBox.style.display !== 'none';
            helpBox.style.display = open ? 'none' : 'block';
            helpToggle.textContent = (open ? '\u24d8' : '\u24e7') + ' Operator help';
        };
        container.appendChild(helpToggle);
        container.appendChild(helpBox);

        var op = inst.operators[selectedOp];
        if (!op) return;

        // ── Frequency block (mode toggle + ratio OR fixed-Hz input) ──
        // Two mutually exclusive modes: Ratio (tracks the tracker note) and
        // Fixed Hz (constant frequency regardless of note — useful for bell
        // partials, formant ops, kick clicks). freq_fixed = 0 means Ratio
        // mode is in effect; freq_fixed > 0 wins over freq_ratio in
        // programSlot.
        var freqRow = document.createElement('div'); freqRow.className = 'op-param';
        freqRow.title = 'Frequency mode. Ratio: pitch tracks the tracker note (×ratio). Fixed Hz: constant frequency regardless of note. Toggling switches which value drives this operator.';
        var freqLbl = document.createElement('label'); freqLbl.textContent = 'Freq';
        var freqMode = document.createElement('select');
        var optRatio = document.createElement('option'); optRatio.value = 'ratio'; optRatio.textContent = 'Ratio';
        var optFixed = document.createElement('option'); optFixed.value = 'fixed'; optFixed.textContent = 'Hz';
        freqMode.appendChild(optRatio); freqMode.appendChild(optFixed);
        freqMode.value = (op.freq_fixed > 0) ? 'fixed' : 'ratio';

        var ratioInp = document.createElement('input'); ratioInp.type = 'range';
        ratioInp.min = 0.5; ratioInp.max = 16; ratioInp.step = 0.001;
        ratioInp.value = op.freq_ratio || 1;
        ratioInp.title = 'Frequency multiplier relative to the note. 1.0 = fundamental, 2.0 = octave up. Non-integer values create inharmonic timbres.';

        var fixedInp = document.createElement('input'); fixedInp.type = 'number';
        fixedInp.min = 1; fixedInp.max = 16000; fixedInp.step = 1;
        fixedInp.value = op.freq_fixed || 440;
        fixedInp.style.width = '64px';
        fixedInp.title = 'Fixed frequency in Hz. The operator plays at this frequency regardless of the tracker note (per SCSP doc §4.2.5: OCT/FNS is a multiplier of the sample\'s native rate).';

        var freqVal = document.createElement('span'); freqVal.className = 'val';
        function updateFreqVal() {
            if (freqMode.value === 'fixed') freqVal.textContent = Math.round(op.freq_fixed) + ' Hz';
            else freqVal.textContent = (op.freq_ratio || 1).toFixed(3);
        }
        function applyFreqMode() {
            if (freqMode.value === 'fixed') {
                if (!(op.freq_fixed > 0)) op.freq_fixed = parseFloat(fixedInp.value) || 440;
                ratioInp.style.display = 'none';
                fixedInp.style.display = '';
            } else {
                op.freq_fixed = 0;
                fixedInp.style.display = 'none';
                ratioInp.style.display = '';
            }
            updateFreqVal();
            syncRawRegs(op);
        }
        freqMode.onchange = function() { applyFreqMode(); if (onChange) onChange({paramTweak: true}); };
        ratioInp.oninput = function() { op.freq_ratio = parseFloat(ratioInp.value); updateFreqVal(); syncRawRegs(op); if (onChange) onChange({paramTweak: true}); };
        fixedInp.oninput = function() { op.freq_fixed = Math.max(0, parseFloat(fixedInp.value) || 0); updateFreqVal(); syncRawRegs(op); if (onChange) onChange({paramTweak: true}); };

        freqRow.appendChild(freqLbl); freqRow.appendChild(freqMode);
        freqRow.appendChild(ratioInp); freqRow.appendChild(fixedInp); freqRow.appendChild(freqVal);
        container.appendChild(freqRow);
        applyFreqMode();

        var params = [
            { key:'level', label:'Level', min:0, max:1, step:0.01, fmt: function(v) { return v.toFixed(2); },
              help:'Output level of this operator. For carriers, controls volume. For modulators, controls how much FM modulation is applied.' },
            { key:'ar', label:'AR', min:0, max:31, step:1, fmt: function(v) { return Math.round(v); },
              help:'Attack Rate — how fast the sound reaches peak level. 31 = instant attack, lower = slower fade in.' },
            { key:'d1r', label:'D1R', min:0, max:31, step:1, fmt: function(v) { return Math.round(v); },
              help:'Decay 1 Rate — how fast the sound drops from peak to the sustain level (DL). 0 = no decay, higher = faster.' },
            { key:'dl', label:'DL', min:0, max:31, step:1, fmt: function(v) { return Math.round(v); },
              help:'Decay Level (sustain) — the level held after the first decay. 0 = full volume sustain, 31 = silence.' },
            { key:'d2r', label:'D2R', min:0, max:31, step:1, fmt: function(v) { return Math.round(v); },
              help:'Decay 2 Rate — slow decay during the sustain phase. 0 = hold forever, higher = gradual fade.' },
            { key:'rr', label:'RR', min:0, max:31, step:1, fmt: function(v) { return Math.round(v); },
              help:'Release Rate — how fast the sound fades after note-off. Higher = faster release, lower = long tail.' },
            { key:'feedback', label:'FB', min:0, max:15, step:1, fmt: function(v) { return Math.round(v); },
              help:'Self-feedback nibble (0..15) — operator modulates itself. Maps directly to the SCSP MDL feedback register. Low values add harmonics, higher values create noise/distortion.' },
            { key:'mdl', label:'MDL', min:0, max:15, step:1, fmt: function(v) { return Math.round(v); },
              help:'Modulation Depth Level — how strongly the mod source affects this operator. 0 = none, 15 = maximum FM depth.' },
        ];

        for (var pi = 0; pi < params.length; pi++) {
            var p = params[pi];
            var row = document.createElement('div'); row.className = 'op-param';
            if (p.help) row.title = p.help;
            var lbl = document.createElement('label'); lbl.textContent = p.label;
            var inp = document.createElement('input'); inp.type = 'range';
            inp.min = p.min; inp.max = p.max; inp.step = p.step; inp.value = op[p.key] || 0;
            var val = document.createElement('span'); val.className = 'val'; val.textContent = p.fmt(op[p.key] || 0);
            (function(p2, inp2, val2) {
                inp2.oninput = function() { op[p2.key] = parseFloat(inp2.value); val2.textContent = p2.fmt(op[p2.key]); syncRawRegs(op); if (onChange) onChange({paramTweak: true}); };
            })(p, inp, val);
            row.appendChild(lbl); row.appendChild(inp); row.appendChild(val);
            container.appendChild(row);
        }

        // Mod source dropdowns — the SCSP has two modulation inputs (X and Y)
        // per slot, so each op can take up to two distinct modulators. With
        // one mod, both inputs feed from the same source (per Sega doc 4.3,
        // single-side input "may make the FM modulation degree seem small").
        // With two mods, X = Mod 1 and Y = Mod 2, both at the latest sample.
        if (!Array.isArray(op.mod_sources)) op.mod_sources = [];
        function _makeModSel(label, slotIdx, helpText) {
            var row = document.createElement('div'); row.className = 'op-param';
            row.title = helpText;
            var lbl = document.createElement('label'); lbl.textContent = label;
            var sel = document.createElement('select');
            var none = document.createElement('option'); none.value = -1; none.textContent = 'None';
            sel.appendChild(none);
            for (var mi = 0; mi < inst.operators.length; mi++) {
                if (mi === selectedOp) continue;
                var o = document.createElement('option'); o.value = mi; o.textContent = 'Op' + (mi + 1);
                sel.appendChild(o);
            }
            var cur = op.mod_sources[slotIdx];
            sel.value = (typeof cur === 'number' && cur >= 0) ? cur : -1;
            sel.onchange = function() {
                var v = parseInt(sel.value);
                var arr = (op.mod_sources || []).slice();
                while (arr.length <= slotIdx) arr.push(-1);
                arr[slotIdx] = v;
                // Compact: drop -1 entries, dedupe, cap at 2.
                var seen = {};
                op.mod_sources = arr.filter(function(s) {
                    if (typeof s !== 'number' || s < 0) return false;
                    if (seen[s]) return false;
                    seen[s] = true;
                    return true;
                }).slice(0, 2);
                syncRawRegs(op);
            };
            row.appendChild(lbl); row.appendChild(sel); container.appendChild(row);
        }
        _makeModSel('Mod 1', 0, 'First modulation source (drives MDXSL). With only Mod 1 set, the chip feeds it into both X and Y inputs (recommended for single-modulator FM).');
        _makeModSel('Mod 2', 1, 'Second modulation source (drives MDYSL). Set this in addition to Mod 1 for two-modulator FM (the SCSP averages X and Y). Has no effect when self-feedback is also active — the SCSP only has two modulation inputs total.');

        // Waveform dropdown
        var wvRow = document.createElement('div'); wvRow.className = 'op-param';
        wvRow.title = 'Base waveform for this operator. Sine is classic FM; other waveforms produce different harmonic content.';
        var wvLbl = document.createElement('label'); wvLbl.textContent = 'Wave';
        var wvSel = document.createElement('select');
        for (var wi = 0; wi < WAVE_NAMES.length; wi++) {
            var wo = document.createElement('option'); wo.value = wi; wo.textContent = WAVE_NAMES[wi]; wvSel.appendChild(wo);
        }
        wvSel.value = op.waveform || 0;
        wvSel.onchange = function() { op.waveform = parseInt(wvSel.value); syncRawRegs(op); };
        wvRow.appendChild(wvLbl); wvRow.appendChild(wvSel); container.appendChild(wvRow);

        // Carrier toggle
        var cRow = document.createElement('div'); cRow.className = 'op-param';
        cRow.title = 'Carrier operators produce audible output. Uncheck to make this a modulator (shapes timbre of the operator it feeds into via Mod source).';
        var cLbl = document.createElement('label'); cLbl.textContent = 'Carrier';
        var cChk = document.createElement('input'); cChk.type = 'checkbox'; cChk.checked = op.is_carrier;
        cChk.onchange = function() { op.is_carrier = cChk.checked; syncRawRegs(op); _renderInstEditor(container, inst, selectedOp, onChange); };
        cRow.appendChild(cLbl); cRow.appendChild(cChk); container.appendChild(cRow);

        // Test button. For PCM samples (sample_rate set on the selected op),
        // play at the op's root_note so the user always hears the recording
        // unshifted — auditioning the sample, not the transposition. For all
        // other ops the conventional middle-C test note (MIDI 60 = C4) is
        // used. The played note is resolved on click so root_note edits don't
        // need a re-render.
        function _testNoteFor(o) {
            return (o.sample_rate > 0 && o.root_note != null) ? o.root_note : 60;
        }
        var testRow = document.createElement('div'); testRow.style.marginTop = '8px';
        var testBtn = document.createElement('button');
        testBtn.textContent = 'Test (' + noteName(_testNoteFor(op)) + ')';
        testBtn.style.cssText = 'background:#2a4a2e;color:#8c8;border:1px solid #4a4;padding:4px 12px;cursor:pointer;border-radius:3px;font-family:inherit;font-size:10px;';
        testBtn.onclick = function() {
            api.init().then(function() {
                if (playbackRef) api.startAudio(playbackRef);
                var note = _testNoteFor(inst.operators[selectedOp]);
                _triggerNote(99, note, 0, inst);
                setTimeout(function() { voiceAlloc.release(99); }, 500);
            });
        };
        testRow.appendChild(testBtn);
        container.appendChild(testRow);
    }

    // ── Public API ─────────────────────────────────────────────────────

    /** @type {SoundEngine} */
    var api = {
        /** @constant {string[]} Built-in waveform names */
        WAVE_NAMES: WAVE_NAMES,
        /** @constant {number} Default waveform length in samples */
        WAVE_LEN: WAVE_LEN,

        /** @description Initialize SCSP WASM module and load built-in waveforms. No-op if already ready.
         *  @returns {Promise<void>} */
        init: function() {
            if (scspReady) return Promise.resolve();
            if (typeof SCSP_WASM_B64 === 'undefined' || !SCSP_WASM_B64) return Promise.reject(new Error('No SCSP WASM'));
            var wasmBytes = Uint8Array.from(atob(SCSP_WASM_B64), function(c) { return c.charCodeAt(0); });
            return SCSPModule({ wasmBinary: wasmBytes.buffer }).then(function(mod) {
                scsp = mod;
                resetSCSP();
                scspReady = true;
            });
        },

        /** @description Create AudioContext, ScriptProcessor node, and audio chain (gain -> LPF -> compressor). Stores playback ref for sequencer tick processing.
         *  @param {Object} playback - Playback controller with playing flag and processBlock method */
        startAudio: function(playback) {
            playbackRef = playback;
            if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SAMPLE_RATE });
            if (actx.state === 'suspended') actx.resume();
            if (!fmNode && scspReady) {
                fmNode = actx.createScriptProcessor(2048, 0, 2);
                fmGain = actx.createGain();
                fmGain.gain.value = 0.35;
                var lpf = actx.createBiquadFilter();
                lpf.type = 'lowpass';
                lpf.frequency.value = 16000;
                lpf.Q.value = 0.707;
                var compressor = actx.createDynamicsCompressor();
                compressor.threshold.value = -6;
                compressor.knee.value = 12;
                compressor.ratio.value = 8;
                compressor.attack.value = 0.002;
                compressor.release.value = 0.05;
                fmNode.connect(fmGain);
                fmGain.connect(lpf);
                lpf.connect(compressor);
                compressor.connect(actx.destination);
                fmNode.onaudioprocess = function(e) {
                    var outL = e.outputBuffer.getChannelData(0);
                    var outR = e.outputBuffer.numberOfChannels > 1 ? e.outputBuffer.getChannelData(1) : outL;
                    var n = outL.length;
                    if (!scspReady) { for (var i = 0; i < n; i++) { outL[i] = 0; outR[i] = 0; } return; }

                    if (playbackRef && playbackRef.playing &&
                        playbackRef.mode === 'seq' && playbackRef.processBlockSeq) {
                        // Sample-accurate SEQ mode: dispatch events between scsp_render slices
                        // so key-ons take effect at the precise sample, not just at block boundaries.
                        var writeOffset = 0;
                        playbackRef.processBlockSeq(n, function (slice) {
                            if (slice <= 0) return;
                            var bp = scsp._scsp_render(slice);
                            var h16 = new Int16Array(scsp.HEAP16.buffer, bp, slice * 2);
                            for (var k = 0; k < slice; k++) {
                                outL[writeOffset + k] = h16[k * 2] / 32768.0;
                                outR[writeOffset + k] = h16[k * 2 + 1] / 32768.0;
                            }
                            writeOffset += slice;
                        });
                        // Safety: render any leftover samples (shouldn't happen if processBlockSeq
                        // accounts for the whole block, but guard against drift).
                        if (writeOffset < n) {
                            var rem = n - writeOffset;
                            var bp2 = scsp._scsp_render(rem);
                            var h16b = new Int16Array(scsp.HEAP16.buffer, bp2, rem * 2);
                            for (var m = 0; m < rem; m++) {
                                outL[writeOffset + m] = h16b[m * 2] / 32768.0;
                                outR[writeOffset + m] = h16b[m * 2 + 1] / 32768.0;
                            }
                        }
                        return;
                    }

                    if (playbackRef && playbackRef.playing) playbackRef.processBlock(n);
                    var bufPtr = scsp._scsp_render(n);
                    var heap16 = new Int16Array(scsp.HEAP16.buffer, bufPtr, n * 2);
                    for (var i = 0; i < n; i++) {
                        outL[i] = heap16[i * 2] / 32768.0;
                        outR[i] = heap16[i * 2 + 1] / 32768.0;
                    }
                };
            }
        },

        /** @description Trigger a note on the given channel.
         *  @param {number} ch - Channel number
         *  @param {number} midiNote - MIDI note (0-127)
         *  @param {number} instIdx - Instrument index
         *  @param {Object} inst - Instrument object */
        triggerNote: function(ch, midiNote, instIdx, inst) {
            _triggerNote(ch, midiNote, instIdx, inst);
        },

        /** @description Release (key-off) all voices on a channel.
         *  @param {number} ch - Channel number */
        releaseChannel: function(ch) {
            voiceAlloc.release(ch);
        },

        /** @description Release all active voices across all channels. */
        releaseAll: function() {
            voiceAlloc.releaseAll();
        },

        /** @description Import a TON bank file into SCSP RAM.
         *  @param {ArrayBuffer} arrayBuffer - Raw TON file data
         *  @param {string} label - Display name for messages
         *  @returns {{instruments: ?Object[], message: string}} */
        importBank: function(arrayBuffer, label) {
            return _importBank(arrayBuffer, label);
        },

        /** @description Import a DX7 SysEx bank (.syx) and convert all 32
         *  voices into bebhionn instruments using the DX7Import module.
         *  Resets SCSP so the built-in waveforms are freshly loaded (DX7
         *  converted ops all use waveform 0, sine). Returns in the same
         *  shape as importBank so tracker_ui's loadTonData flow works
         *  directly.
         *  @param {ArrayBuffer} arrayBuffer - Raw .syx file data
         *  @param {string} label - Display name for messages
         *  @returns {{instruments: ?Object[], message: string}} */
        importDx7Sysex: function(arrayBuffer, label) {
            if (typeof DX7Import === 'undefined' || !DX7Import) {
                return { instruments: null, message: 'DX7Import module not loaded' };
            }
            try {
                resetSCSP();
                scspReady = true;
                var result = DX7Import.convertBank(arrayBuffer, 6);
                if (!result.instruments.length) {
                    return { instruments: null, warnings: [], message: 'No audible voices in ' + label };
                }
                return {
                    instruments: result.instruments,
                    warnings: result.warnings || [],
                    message: 'Imported ' + result.instruments.length + ' DX7 voices from ' + label
                };
            } catch (err) {
                console.error('DX7 SysEx import error:', err);
                return { instruments: null, warnings: [], message: 'Error importing ' + label + ': ' + err.message };
            }
        },

        /** @description Export instruments to TON binary format via TonIO.
         *  @param {Object[]} instruments - Array of instrument objects
         *  @returns {?Uint8Array} TON file bytes, or null if TonIO unavailable */
        exportBank: function(instruments) {
            if (!TonIO) return null;
            return TonIO.exportTon(instruments, generateWaveform);
        },

        /** @description Render SCSP instrument editor into a DOM container.
         *  @param {HTMLElement} container - Target element
         *  @param {Object} inst - Instrument to edit
         *  @param {number} selectedOp - Active operator tab index
         *  @param {function} onChange - Change callback */
        renderInstEditor: function(container, inst, selectedOp, onChange) {
            _renderInstEditor(container, inst, selectedOp, onChange);
        },

        /** @description Create a new single-operator default instrument.
         *  @returns {Object} Instrument with one carrier operator */
        createDefaultInstrument: function() {
            return { name: 'New', operators: [{ freq_ratio:1.0, freq_fixed:0, level:0.8, ar:31, d1r:0, dl:0, d2r:0, rr:14, mdl:0, mod_sources:[], feedback:0, is_carrier:true, waveform:0, loop_mode:1, loop_start:0, loop_end:1024 }] };
        },

        /** @description Get deep copies of all preset instruments.
         *  @returns {Object[]} Array of preset instrument objects */
        getPresets: function() {
            return JSON.parse(JSON.stringify(PRESET_INSTRUMENTS));
        },

        /** @description Get the engine sample rate.
         *  @returns {number} Sample rate in Hz (44100) */
        getSampleRate: function() {
            return SAMPLE_RATE;
        },

        /** @description Exposed waveform generator for TON export. See {@link generateWaveform}. */
        generateWaveform: generateWaveform,

        // ── Constants for instrument detail / panels ──────────────

        /** @constant {string[]} Loop mode names */
        LOOP_NAMES: ['Off', 'Forward', 'Reverse', 'Ping-pong'],

        /** @constant {number[]} Attack rate → milliseconds lookup (index 0-31) */
        AR_TIMES: [
            100000, 100000, 8100, 6900, 6000, 4800, 4000, 3400,
            3000, 2400, 2000, 1700, 1500, 1200, 1000, 860,
            760, 600, 500, 430, 380, 300, 250, 220,
            190, 150, 130, 110, 95, 76, 63, 55
        ],

        /** @constant {number[]} Decay/release rate → milliseconds lookup (index 0-31) */
        DR_TIMES: [
            100000, 100000, 118200, 101300, 88600, 70900, 59100, 50700,
            44300, 35500, 29600, 25300, 22200, 17700, 14800, 12700,
            11100, 8900, 7400, 6300, 5500, 4400, 3700, 3200,
            2800, 2200, 1800, 1600, 1400, 1100, 920, 790
        ],

        // ── Custom wave and waveform store access ─────────────────

        /** @description Per-operator custom wave storage (keyed by "instIdx_opIdx").
         *  @type {Object<string, Float32Array>} */
        customWaves: {},

        /** @description Get waveform length for a given wave index.
         *  @param {number} wid - Waveform index
         *  @returns {number} Length in samples */
        getWaveLength: function(wid) {
            var w = waveStore.waves[wid] || waveStore.waves[0];
            return w ? w.length : WAVE_LEN;
        },

        /** @description Add a custom waveform to the wave store (writes PCM into SCSP RAM).
         *  @param {Float32Array} samples - Waveform data (-1..1)
         *  @param {number} loopStart
         *  @param {number} loopEnd
         *  @param {number} loopMode
         *  @returns {number} New waveform index */
        addWaveform: function(samples, loopStart, loopEnd, loopMode) {
            if (!scsp) return 0;
            var ramPtr = scsp._scsp_get_ram_ptr();
            return waveStoreAdd(ramPtr, samples, loopStart, loopEnd, loopMode);
        },

        /** @description Sync an operator's rawRegs from its high-level params. */
        syncRawRegs: syncRawRegs,

        /** @description Read PCM samples from SCSP RAM.
         *  @param {number} byteOffset - Start address in SCSP RAM
         *  @param {number} numSamples - Number of samples to read
         *  @param {boolean} pcm8b - True for 8-bit, false for 16-bit
         *  @returns {?Float32Array} Normalized samples, or null if engine not ready */
        readRamPCM: function(byteOffset, numSamples, pcm8b) {
            if (!scsp) return null;
            var ramPtr = scsp._scsp_get_ram_ptr();
            var out = new Float32Array(numSamples);
            if (pcm8b) {
                for (var i = 0; i < numSamples; i++) {
                    var addr = ramPtr + byteOffset + i;
                    var swapped = (i & 1) ? addr - 1 : addr + 1;
                    var s8 = scsp.HEAPU8[swapped];
                    out[i] = ((s8 << 24) >> 24) / 128;
                }
            } else {
                for (var i = 0; i < numSamples; i++) {
                    var addr = ramPtr + byteOffset + i * 2;
                    var s16 = scsp.HEAPU8[addr] | (scsp.HEAPU8[addr + 1] << 8);
                    out[i] = ((s16 << 16) >> 16) / 32768;
                }
            }
            return out;
        },

        /** @description Update SCSP slot registers for any currently-previewing voices
         *  after parameter changes. Only affects test/live-preview channels.
         *  @param {Object[]} instruments - Full instruments array
         *  @param {number} instIdx - Which instrument was changed
         *  @param {number} opIdx - Which operator was changed */
        liveUpdatePreview: function(instruments, instIdx, opIdx) {
            if (!scsp) return;
            var inst = instruments[instIdx];
            if (!inst) return;
            var ops = inst.operators;
            for (var vi = 0; vi < voiceAlloc.voices.length; vi++) {
                var v = voiceAlloc.voices[vi];
                if (v.ch === 99 || v.ch >= 100) {
                    if (v.slots.length !== ops.length) continue;
                    var slotBase = v.slots[0];
                    for (var i = 0; i < ops.length; i++) {
                        var op = ops[i];
                        if (op.rawRegs) {
                            if (op.useTonSA) {
                                var origSA = ((op.rawRegs.d0 & 0x0F) << 16) | op.rawRegs.sa;
                                programSlotRaw(v.slots[i], op.rawRegs, v.note, origSA, slotBase, i, op.rawRegs.lea, getModSources(op), op.freq_fixed || 0);
                            } else {
                                var wav = waveStore.waves[op.waveform || 0] || waveStore.waves[0];
                                programSlotRaw(v.slots[i], op.rawRegs, v.note, wav.offset, slotBase, i, wav.length, getModSources(op), op.freq_fixed || 0);
                            }
                        } else {
                            programSlot(v.slots[i], op, v.note, slotBase);
                        }
                    }
                }
            }
        },

        // ── DSP abstraction ───────────────────────────────────────

        /** @description Load assembled DSP program into SCSP.
         *  @param {Uint16Array} mpro - Microprogram words
         *  @param {Int16Array} coef - Coefficient table
         *  @param {Uint16Array} madrs - Memory address table
         *  @param {number} rbl - Ring buffer length selector (0-3)
         *  @returns {boolean} True if loaded */
        dspLoadProgram: function(mpro, coef, madrs, rbl) {
            if (!scsp) return false;
            var mproPtr = scsp._malloc(mpro.byteLength);
            var coefPtr = scsp._malloc(coef.byteLength);
            var madrsPtr = scsp._malloc(madrs.byteLength);
            scsp.HEAPU16.set(mpro, mproPtr >> 1);
            scsp.HEAP16.set(coef, coefPtr >> 1);
            scsp.HEAPU16.set(madrs, madrsPtr >> 1);
            scsp._scsp_dsp_load_arrays(mproPtr, mpro.length, coefPtr, coef.length,
                                        madrsPtr, madrs.length, rbl);
            scsp._free(mproPtr);
            scsp._free(coefPtr);
            scsp._free(madrsPtr);
            return true;
        },

        /** @description Load a binary EXB DSP program file.
         *  @param {Uint8Array} bytes - Raw EXB data
         *  @returns {boolean} True if loaded */
        dspLoadExb: function(bytes) {
            if (!scsp) return false;
            var ptr = scsp._malloc(bytes.byteLength);
            scsp.HEAPU8.set(bytes, ptr);
            scsp._scsp_dsp_load_exb(ptr, bytes.byteLength);
            scsp._free(ptr);
            return true;
        },

        dspStart: function() { if (scsp) scsp._scsp_dsp_start(); },
        dspStop: function() { if (scsp) scsp._scsp_dsp_stop(); },
        dspClear: function() { if (scsp) scsp._scsp_dsp_clear(); },

        dspGetCoef: function(idx) { return scsp ? scsp._scsp_dsp_get_coef(idx) : 0; },
        dspSetCoef: function(idx, val) { if (scsp) scsp._scsp_dsp_set_coef(idx, val); },
        dspGetMadrs: function(idx) { return scsp ? scsp._scsp_dsp_get_madrs(idx) : 0; },
        dspSetMadrs: function(idx, val) { if (scsp) scsp._scsp_dsp_set_madrs(idx, val); },

        /** @description Set effect send level (IMXL) for a slot.
         *  @param {number} slot - Slot index (0-31)
         *  @param {number} level - Send level (0-7) */
        dspSetSlotSend: function(slot, level) {
            if (scsp) scsp._scsp_slot_set_effect_send(slot, 0, level);
        },

        /** @description Set effect output (EFSDL/EFPAN) for a slot.
         *  @param {number} slot - Slot index
         *  @param {number} efsdl - Effect send direct level
         *  @param {number} efpan - Effect pan */
        dspSetSlotOutput: function(slot, efsdl, efpan) {
            if (scsp) scsp._scsp_slot_set_effect_output(slot, efsdl, efpan);
        },

        /** @description Write a raw register value to a slot.
         *  @param {number} slot - Slot index
         *  @param {number} reg - Register offset
         *  @param {number} val - 16-bit value */
        dspWriteSlotReg: function(slot, reg, val) {
            if (scsp) scsp._scsp_write_slot(slot, reg, val);
        },

        /** @description Check if the SCSP WASM module is initialized.
         *  @returns {boolean} */
        isReady: function() { return scspReady; },

        /** @description Register a callback invoked after each slot is programmed (note-on).
         *  Used by the DSP panels to inject effect send levels into register 0xA.
         *  @param {?function(number)} fn - callback receiving the slot number, or null to clear */
        setSlotPostProgramHook: function(fn) { slotPostProgramHook = fn; },
    };

    return api;
})();
