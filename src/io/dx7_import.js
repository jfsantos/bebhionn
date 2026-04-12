/**
 * @module dx7_import
 * @description DX7 SysEx → SCSP instrument converter. Parses a Yamaha DX7
 * 32-voice bank dump (.syx) and returns bebhionn-format instrument objects.
 *
 * Ported from tools/dx7_to_saturn.py in the mid2seq repo. The DX7 envelope
 * math is Dexed-faithful (verified byte-for-byte against pydx7). The
 * DX7-to-SCSP envelope mapping, algorithm decoder, and loudness (log-domain
 * level) conversion match the Python reference so bebhionn-imported patches
 * sound identical to what dx7_to_saturn.py produces.
 *
 * Exposes a single global `DX7Import` with:
 *   parseSysex(arrayBuffer)            → Array<DX7Voice>
 *   voiceToOperators(voice, maxOps=6)  → Array<bebhionn op>
 *   convertBank(arrayBuffer, maxOps=6) → Array<bebhionn instrument>
 */
var DX7Import = (function() {
    'use strict';

    // ── DX7 algorithm routing table ────────────────────────────────────
    // Raw algorithm bytes verbatim from Dexed's fm_core.cc. Six bytes per
    // algorithm, in processing order op6→op1. Flag bits encode bus routing.

    var _OUT_BUS_ONE = 0x01;
    var _OUT_BUS_TWO = 0x02;
    var _OUT_BUS_ADD = 0x04;
    var _IN_BUS_ONE  = 0x10;
    var _IN_BUS_TWO  = 0x20;
    var _FB_IN       = 0x40;
    var _FB_OUT      = 0x80;

    var _DX7_ALG_BYTES = [
        [0xc1, 0x11, 0x11, 0x14, 0x01, 0x14],  // 1
        [0x01, 0x11, 0x11, 0x14, 0xc1, 0x14],  // 2
        [0xc1, 0x11, 0x14, 0x01, 0x11, 0x14],  // 3
        [0xc1, 0x11, 0x94, 0x01, 0x11, 0x14],  // 4
        [0xc1, 0x14, 0x01, 0x14, 0x01, 0x14],  // 5
        [0xc1, 0x94, 0x01, 0x14, 0x01, 0x14],  // 6
        [0xc1, 0x11, 0x05, 0x14, 0x01, 0x14],  // 7
        [0x01, 0x11, 0xc5, 0x14, 0x01, 0x14],  // 8
        [0x01, 0x11, 0x05, 0x14, 0xc1, 0x14],  // 9
        [0x01, 0x05, 0x14, 0xc1, 0x11, 0x14],  // 10
        [0xc1, 0x05, 0x14, 0x01, 0x11, 0x14],  // 11
        [0x01, 0x05, 0x05, 0x14, 0xc1, 0x14],  // 12
        [0xc1, 0x05, 0x05, 0x14, 0x01, 0x14],  // 13
        [0xc1, 0x05, 0x11, 0x14, 0x01, 0x14],  // 14
        [0x01, 0x05, 0x11, 0x14, 0xc1, 0x14],  // 15
        [0xc1, 0x11, 0x02, 0x25, 0x05, 0x14],  // 16
        [0x01, 0x11, 0x02, 0x25, 0xc5, 0x14],  // 17
        [0x01, 0x11, 0x11, 0xc5, 0x05, 0x14],  // 18
        [0xc1, 0x14, 0x14, 0x01, 0x11, 0x14],  // 19
        [0x01, 0x05, 0x14, 0xc1, 0x14, 0x14],  // 20
        [0x01, 0x14, 0x14, 0xc1, 0x14, 0x14],  // 21
        [0xc1, 0x14, 0x14, 0x14, 0x01, 0x14],  // 22
        [0xc1, 0x14, 0x14, 0x01, 0x14, 0x04],  // 23
        [0xc1, 0x14, 0x14, 0x14, 0x04, 0x04],  // 24
        [0xc1, 0x14, 0x14, 0x04, 0x04, 0x04],  // 25
        [0xc1, 0x05, 0x14, 0x01, 0x14, 0x04],  // 26
        [0x01, 0x05, 0x14, 0xc1, 0x14, 0x04],  // 27
        [0x04, 0xc1, 0x11, 0x14, 0x01, 0x14],  // 28
        [0xc1, 0x14, 0x01, 0x14, 0x04, 0x04],  // 29
        [0x04, 0xc1, 0x11, 0x14, 0x04, 0x04],  // 30
        [0xc1, 0x14, 0x04, 0x04, 0x04, 0x04],  // 31
        [0xc4, 0x04, 0x04, 0x04, 0x04, 0x04]   // 32
    ];

    /**
     * Decode a DX7 algorithm (0-31) into {carriers, connections, fbOp}.
     *   carriers:    1-indexed op numbers feeding the speaker mix
     *   connections: [{mod, car}] edges (1-indexed)
     *   fbOp:        1-indexed op with self-feedback, or null
     *
     * Operators are processed op6→op1, writing and reading two internal
     * modulation buses. Reading a bus pulls in *all* ops currently
     * accumulated on it — this is how parallel modulation stacks work.
     */
    function decodeAlgorithm(algIndex) {
        algIndex = Math.max(0, Math.min(31, algIndex));
        var flagsList = _DX7_ALG_BYTES[algIndex];
        var carriers = [];
        var connections = [];
        var fbOp = null;
        var busAccum = {1: [], 2: []};

        for (var pos = 0; pos < flagsList.length; pos++) {
            var flags = flagsList[pos];
            var op = 6 - pos; // bytes are op6→op1

            var inBus = (flags & _IN_BUS_ONE) ? 1 : ((flags & _IN_BUS_TWO) ? 2 : 0);
            var incoming = inBus ? busAccum[inBus].slice() : [];

            var outBus = (flags & _OUT_BUS_ONE) ? 1 : ((flags & _OUT_BUS_TWO) ? 2 : 0);

            for (var m = 0; m < incoming.length; m++) {
                connections.push({mod: incoming[m], car: op});
            }

            if (outBus === 0) {
                carriers.push(op);
            } else if (flags & _OUT_BUS_ADD) {
                busAccum[outBus].push(op);
            } else {
                busAccum[outBus] = [op];
            }

            if ((flags & _FB_OUT) && (flags & _FB_IN)) fbOp = op;
        }
        return {carriers: carriers, connections: connections, fbOp: fbOp};
    }

    // ── SysEx parser ───────────────────────────────────────────────────

    /**
     * Parse a DX7 32-voice bank dump (.syx bytes or raw 4096-byte blob).
     * Returns an array of voice objects: {name, operators[6], algorithm,
     * feedback, transpose, ...}. Each operator has egRates, egLevels,
     * outputLevel, freqCoarse, freqFine, oscMode, plus freqRatio/isFixed
     * helper accessors (computed lazily).
     */
    function parseSysex(arrayBuffer) {
        var data = new Uint8Array(arrayBuffer);
        var voices = [];

        // Find the voice-data start. Standard header F0 43 00 09 20 00.
        var start = 0;
        if (data.length > 6 && data[0] === 0xF0) {
            start = 6;
        } else if (data.length >= 4096) {
            start = 0;
        } else {
            for (var i = 0; i < data.length - 6; i++) {
                if (data[i] === 0xF0 && data[i + 1] === 0x43) {
                    start = i + 6;
                    break;
                }
            }
        }

        for (var vi = 0; vi < 32; vi++) {
            var off = start + vi * 128;
            if (off + 128 > data.length) break;

            // 6 operators, 17 bytes each, SysEx order op6→op1 → reverse.
            var ops = [];
            for (var oi = 0; oi < 6; oi++) {
                var o = off + oi * 17;
                ops.push({
                    egRates:       [data[o],     data[o + 1], data[o + 2], data[o + 3]],
                    egLevels:      [data[o + 4], data[o + 5], data[o + 6], data[o + 7]],
                    kbdLevBrkPt:   data[o + 8],
                    kbdLevLDepth:  data[o + 9],
                    kbdLevRDepth:  data[o + 10],
                    kbdLevLCurve:  data[o + 11] & 0x03,
                    kbdLevRCurve:  (data[o + 11] >> 2) & 0x03,
                    oscRateScale:  data[o + 12] & 0x07,
                    oscDetune:     (data[o + 12] >> 3) & 0x0F,
                    ampModSens:    data[o + 13] & 0x03,
                    keyVelSens:    (data[o + 13] >> 2) & 0x07,
                    outputLevel:   data[o + 14],
                    oscMode:       data[o + 15] & 0x01,
                    freqCoarse:    (data[o + 15] >> 1) & 0x1F,
                    freqFine:      data[o + 16]
                });
            }
            ops.reverse(); // op1 first

            // Voice parameters at bytes 102..127
            var vp = off + 102;
            var nameBytes = [];
            for (var nb = 0; nb < 10; nb++) {
                var c = data[vp + 16 + nb];
                nameBytes.push(c >= 0x20 && c < 0x7F ? String.fromCharCode(c) : ' ');
            }

            voices.push({
                operators: ops,
                pitchEgRates:  [data[vp], data[vp + 1], data[vp + 2], data[vp + 3]],
                pitchEgLevels: [data[vp + 4], data[vp + 5], data[vp + 6], data[vp + 7]],
                algorithm:     data[vp + 8] & 0x1F,
                feedback:      data[vp + 9] & 0x07,
                oscKeySync:    (data[vp + 9] >> 3) & 0x01,
                lfoSpeed:      data[vp + 10],
                lfoDelay:      data[vp + 11],
                lfoPmd:        data[vp + 12],
                lfoAmd:        data[vp + 13],
                lfoSync:       data[vp + 14] & 0x01,
                lfoWave:       (data[vp + 14] >> 1) & 0x07,
                transpose:     data[vp + 15],
                name:          nameBytes.join('').replace(/\s+$/, '')
            });
        }
        return voices;
    }

    /**
     * Compute the frequency ratio (relative to carrier pitch) for a DX7
     * operator. Ratio mode: coarse=0 means 0.5, otherwise coarse*(1+fine/100).
     * Fixed mode: returns actual Hz / 440 — the caller should treat this as
     * an absolute frequency (bebhionn's freq_fixed flag), not a ratio.
     */
    function operatorFreqRatio(op) {
        if (op.oscMode === 1) {
            // Fixed: coarse selects decade (0=1Hz, 1=10Hz, 2=100Hz, 3=1000Hz)
            var decade = Math.pow(10, Math.min(op.freqCoarse, 3));
            var freqHz = decade * (1.0 + op.freqFine * 0.0099);
            return freqHz / 440.0;
        }
        var coarse = op.freqCoarse === 0 ? 0.5 : op.freqCoarse;
        return coarse + coarse * op.freqFine / 100.0;
    }

    // ── DX7 envelope math (Dexed-faithful) ─────────────────────────────
    //
    // The DX7 does everything in a logarithmic "outlevel" domain. Every
    // envelope level (L1..L4) and the operator output_level map through
    // scaleoutlevel(), then combine additively in log-amp space. Rates
    // map through an exponential inc/block table and are applied to an
    // 18-bit fixed-point level. Attack is an exponential approach toward
    // a ceiling of 17<<24; decay is a linear decrement in log domain.
    //
    // Functions below reproduce Dexed's integer math exactly, verified by
    // the Python port against pydx7's EnvelopeGenerator.

    var _DX7_LEVEL_LUT = [
        0, 5, 9, 13, 17, 20, 23, 25, 27, 29,
        31, 33, 35, 37, 39, 41, 42, 43, 45, 46
    ];
    var _DX7_LG_N = 6;
    var _DX7_BLOCK = 1 << _DX7_LG_N;
    var _DX7_SAMPLE_RATE = 44100;

    function _dx7ScaleOutlevel(ol) {
        if (ol >= 20) return 28 + ol;
        if (ol < 0) return 0;
        return _DX7_LEVEL_LUT[ol];
    }

    function _dx7ActualLevel(ol, L) {
        var al = (_dx7ScaleOutlevel(L) >> 1) * 64 + _dx7ScaleOutlevel(ol) * 32 - 4256;
        if (al < 16) al = 16;
        else if (al > 3840) al = 3840;
        return al;
    }

    /**
     * Peak linear amplitude (0..2) for an op with outlevel `ol` at env level
     * `L`. At (99, 99) returns 2.0 — Dexed's ceiling (the theoretical 2.18
     * is clamped by the 3840 level cap). At (0, 0) returns ~6.5e-5.
     */
    function _dx7Amp(ol, L) {
        var al = _dx7ActualLevel(ol, L);
        return Math.pow(2, al / 256 - 14);
    }

    function _dx7RateInc(rate) {
        var qrate = Math.min(63, (rate * 41) >> 6);
        return (4 + (qrate & 3)) << (2 + _DX7_LG_N + (qrate >> 2));
    }

    /**
     * Wall-clock time (ms) for a DX7 envelope segment to traverse
     * L_start → L_end at the given rate and operator output level. Matches
     * pydx7's simulated envelope to the block (1.45 ms @ 44.1 kHz),
     * including the 1-block minimum from Dexed's update-then-advance state
     * machine. Uses block counting — no floating-point drift.
     */
    function _dx7SegmentMs(rate, Lstart, Lend, ol) {
        var startLv = _dx7ActualLevel(ol, Lstart) << 16;
        var endLv = _dx7ActualLevel(ol, Lend) << 16;
        var inc = _dx7RateInc(rate);
        var rising = endLv > startLv;
        var level = startLv;
        var blocks = 0;
        var maxBlocks = 2000000; // ~46 min @ 44.1 kHz
        while (blocks < maxBlocks) {
            if (rising) {
                // Dexed clamps rising levels to a "jumptarget" floor so very
                // low starts don't crawl imperceptibly toward the ceiling.
                if (level < (1716 << 16)) level = 1716 << 16;
                var step = ((17 << 24) - level) >> 24;
                level += step * inc;
                blocks += 1;
                if (level >= endLv) break;
            } else {
                level -= inc;
                blocks += 1;
                if (level <= endLv) break;
            }
        }
        if (blocks < 1) blocks = 1;
        return blocks * _DX7_BLOCK / _DX7_SAMPLE_RATE * 1000.0;
    }

    // ── SCSP (MAME) envelope rate tables ───────────────────────────────
    //
    // Full-range time in ms for each SCSP rate register value R=0..31, with
    // KRS=0xf (which scsp_voice.c writes on every slot). With KRS=0xf the
    // effective rate is `2*R`, so these values are indexed by R and sampled
    // from the even entries of MAME's 64-entry ARTimes/DRTimes tables.

    var _SCSP_AR_MS = [
        100000.0, 8100.0, 6000.0, 4000.0, 3000.0, 2000.0, 1500.0, 1000.0,
        760.0, 500.0, 380.0, 250.0, 190.0, 130.0, 95.0, 63.0,
        47.0, 31.0, 24.0, 15.0, 12.0, 7.9, 6.0, 3.8,
        3.0, 2.0, 1.6, 1.1, 0.85, 0.53, 0.40, 0.0
    ];
    var _SCSP_DR_MS = [
        100000.0, 118200.0, 88600.0, 59100.0, 44300.0, 29600.0, 22200.0, 14800.0,
        11100.0, 7400.0, 5500.0, 3700.0, 2800.0, 1800.0, 1400.0, 920.0,
        690.0, 460.0, 340.0, 230.0, 170.0, 110.0, 85.0, 57.0,
        43.0, 28.0, 22.0, 14.0, 11.0, 7.1, 5.4, 3.6
    ];

    /**
     * Pick the SCSP rate (0-31) whose full-range time is closest to targetMs
     * in the log domain. Log matching matters because consecutive rates
     * differ by ~20% — linear distance biases toward slower rates.
     */
    function _scspRateClosest(targetMs, table) {
        if (targetMs <= 0) return 31;
        if (targetMs >= table[0]) return 0;
        var bestRate = 0;
        var bestDiff = Infinity;
        var logTarget = Math.log(targetMs);
        for (var r = 0; r < 32; r++) {
            if (table[r] <= 0) continue;
            var diff = Math.abs(Math.log(table[r]) - logTarget);
            if (diff < bestDiff) {
                bestDiff = diff;
                bestRate = r;
            }
        }
        return bestRate;
    }

    // ── DX7 → SCSP conversion ──────────────────────────────────────────

    /**
     * Convert a linear amplitude ratio (0..1) to SCSP log-domain volume
     * units (0..1023) — the inverse of fm_sim's EG_TABLE[v] = 10^((v-1023)*3/640).
     * Used to compute the sustain threshold (DL) from the DX7 sustain/peak
     * amplitude ratio.
     */
    function _ampToScspVol(ratio) {
        if (ratio <= 1e-6) return 0.0;
        var vol = 1023.0 + (640.0 / 3.0) * Math.log10(ratio);
        return Math.max(0.0, Math.min(1023.0, vol));
    }

    /**
     * Convert a linear amplitude (0..1) to a Saturn-side 'level' (0..1)
     * such that the downstream `tl = round((1 - level) * 128)` mapping
     * (bebhionn, saturn_kit, scsp_voice.c) produces an SCSP TL whose
     * hardware attenuation matches 20*log10(amp). Pre-distorts `amp` so
     * the SCSP's log-domain TL ends up linear in the amplitude.
     *
     *   amp=1.00 → level=1.000 → TL=0   (0 dB)
     *   amp=0.50 → level=0.875 → TL=16  (-6 dB)
     *   amp=0.25 → level=0.750 → TL=32  (-12 dB)
     *   amp=0.10 → level=0.583 → TL=53  (-19.9 dB)
     */
    function _ampToLevel(amp) {
        if (amp <= 0.0) return 0.0;
        if (amp >= 1.0) return 1.0;
        var level = 1.0 + 20.0 * Math.log10(amp) / 48.0;
        return Math.max(0.0, Math.min(1.0, level));
    }

    /**
     * Map one DX7 envelope (4 rates + 4 levels + outputLevel) onto an SCSP
     * envelope {ar, d1r, dl, d2r, rr, peakAmp, sustainAmp}. See comments in
     * tools/dx7_to_saturn.py dx7_eg_to_scsp() for derivation.
     */
    function _dx7EgToScsp(rates, levels, outputLevel) {
        var r1 = rates[0], r2 = rates[1], r3 = rates[2], r4 = rates[3];
        var l1 = levels[0], l2 = levels[1], l3 = levels[2], l4 = levels[3];

        var peakAmp = _dx7Amp(outputLevel, l1);
        var sustainAmp = _dx7Amp(outputLevel, l3);
        // Dexed's gain ceiling is 2.0 — halve so op.level ∈ [0..1]. The
        // MDL=11 calibration in voiceToOperators reproduces Dexed's β = 2π.
        peakAmp = Math.min(1.0, peakAmp / 2.0);
        sustainAmp = Math.min(peakAmp, sustainAmp / 2.0);

        var sustainRatio = peakAmp > 0 ?
            Math.max(0.0, Math.min(1.0, sustainAmp / peakAmp)) : 0.0;

        // DL: linear sustain ratio → SCSP log-volume → 5-bit threshold.
        // scsp.c decay1 exits when (volume >> 5) <= (0x1f - DL).
        var sustainVol = _ampToScspVol(sustainRatio);
        var dlThresh = Math.floor(sustainVol) >> 5;
        var dl = Math.max(0, Math.min(31, 31 - dlThresh));

        // Attack: SCSP traverses 0x17F..0x3ff (642 of 1023 units) so the
        // real attack time is 0.627 × AR_TIMES[ar]. Scale the target up so
        // the table lookup picks a rate whose perceived attack matches.
        var attackMs = _dx7SegmentMs(r1, 0, l1, outputLevel);
        var arTableMs = attackMs * 1023.0 / 642.0;
        var ar = _scspRateClosest(arTableMs, _SCSP_AR_MS);

        // D1R: decay1 traverses 0x3ff → (31-dl)*32 in log-volume units.
        // DR_TIMES[i] is the full 0→1023 traversal time, so we want
        // traversal_units/1023 × DR_TIMES[d1r] = decay_ms
        var decayMs =
            _dx7SegmentMs(r2, l1, l2, outputLevel) +
            _dx7SegmentMs(r3, l2, l3, outputLevel);
        var d1Units = 1023 - (31 - dl) * 32;
        var d1r = 0;
        if (d1Units > 0 && decayMs > 0) {
            d1r = _scspRateClosest(decayMs * 1023.0 / d1Units, _SCSP_DR_MS);
        }

        // D2R off — DX7 holds at sustain, SCSP D2R would drop below it.
        var d2r = 0;

        // RR: traverse sustainVol → ~0x17F (silence floor).
        var releaseMs = _dx7SegmentMs(r4, l3, l4, outputLevel);
        var rrUnits = Math.max(1.0, sustainVol - 0x17F);
        var rr = releaseMs > 0 ?
            _scspRateClosest(releaseMs * 1023.0 / rrUnits, _SCSP_DR_MS) : 31;

        return {ar: ar, d1r: d1r, dl: dl, d2r: d2r, rr: rr,
                peakAmp: peakAmp, sustainAmp: sustainAmp};
    }

    /**
     * Convert a DX7 voice to bebhionn operator objects. `maxOps` caps
     * operator count (default 6 = full DX7). Lower values sacrifice
     * mod-chain depth for polyphony since each voice consumes maxOps
     * slots out of the SCSP's 32.
     *
     * Produces operator dicts with all fields bebhionn's SCSPEngine
     * expects (waveform=0 sine, loop_mode=1, loop_start=0, loop_end=1024).
     */
    function voiceToOperators(voice, maxOps) {
        if (maxOps === undefined) maxOps = 6;
        var alg = decodeAlgorithm(voice.algorithm);

        function isActive(opNum) {
            return voice.operators[opNum - 1].outputLevel > 0;
        }

        // Silenced carriers contribute nothing audible — prune. Keep at
        // least one so the voice still makes sound.
        var liveCarriers = alg.carriers.filter(isActive);
        if (!liveCarriers.length) {
            liveCarriers = alg.carriers.length ? [alg.carriers[0]] : [1];
        }

        var liveConnections = alg.connections.filter(function(c) {
            return isActive(c.mod) &&
                (liveCarriers.indexOf(c.car) >= 0 || isActive(c.car));
        });

        // Breadth-first walk outward from carriers so direct modulators are
        // kept before deeper ones. When voice has more ops than maxOps,
        // deepest (farthest from carrier) modulators get shed first.
        var keep = liveCarriers.slice();
        var frontier = liveCarriers.slice();
        while (frontier.length && keep.length < maxOps) {
            var nextFrontier = [];
            for (var i = 0; i < liveConnections.length; i++) {
                var c = liveConnections[i];
                if (frontier.indexOf(c.car) >= 0 && keep.indexOf(c.mod) < 0) {
                    if (keep.length >= maxOps) break;
                    keep.push(c.mod);
                    nextFrontier.push(c.mod);
                }
            }
            frontier = nextFrontier;
        }

        var activeList = keep.slice().sort(function(a, b) { return a - b; });
        var opToLayer = {};
        for (var j = 0; j < activeList.length; j++) opToLayer[activeList[j]] = j;
        var carrierSet = {};
        for (var k = 0; k < liveCarriers.length; k++) carrierSet[liveCarriers[k]] = true;

        var fmOps = [];
        for (var a = 0; a < activeList.length; a++) {
            var opNum = activeList[a];
            var dxOp = voice.operators[opNum - 1];
            var isCarrier = !!carrierSet[opNum];

            // SCSP layers reference a single mod_source per op. When multiple
            // modulators feed one op (algs 7, 10, 16), keep the first
            // surviving one — the others' contribution is lost.
            var modSource = -1;
            for (var lc = 0; lc < liveConnections.length; lc++) {
                var conn = liveConnections[lc];
                if (conn.car === opNum && conn.mod in opToLayer) {
                    modSource = opToLayer[conn.mod];
                    break;
                }
            }

            // MDL=11 calibration: β = op.level × π × 2^(mdl-10), and
            // op.level = dx7_amp/2, so mdl=11 cancels the /2 to reproduce
            // Dexed's β_peak = 2π at a fully open modulator.
            var mdl = 0;
            if (modSource >= 0) {
                var modOpNum = activeList[modSource];
                if (voice.operators[modOpNum - 1].outputLevel > 0) mdl = 11;
            }

            // Self-feedback applies to the DX7-designated op (not always op1).
            var feedback = (opNum === alg.fbOp && voice.feedback > 0) ?
                voice.feedback / 7.0 : 0.0;

            var env = _dx7EgToScsp(dxOp.egRates, dxOp.egLevels, dxOp.outputLevel);
            var level = _ampToLevel(env.peakAmp);

            var freqRatio = operatorFreqRatio(dxOp);
            // DX7 fixed-frequency mode: operatorFreqRatio returns Hz/440,
            // which bebhionn can't represent directly. Treat as ratio mode
            // for now — the pitch will drift with key. This matches Python.
            var freqFixed = 0;

            fmOps.push({
                freq_ratio: Math.round(freqRatio * 1000) / 1000,
                freq_fixed: freqFixed,
                level: Math.round(level * 1000) / 1000,
                ar: env.ar, d1r: env.d1r, dl: env.dl, d2r: env.d2r, rr: env.rr,
                mdl: mdl,
                mod_source: modSource,
                feedback: Math.round(feedback * 1000) / 1000,
                is_carrier: isCarrier,
                waveform: 0,
                loop_mode: 1,
                loop_start: 0,
                loop_end: 1024,
                // DISDL=5 (-12 dB) cancels the SCSP slot mixer's 4× gain so a
                // carrier at level=1.0 produces unity sample amplitude without
                // clipping. Matches scsp_voice.c:scsp_program_slot. DX7 patches
                // regularly stack multiple coherent carriers at max level, so
                // the UI default of DISDL=7 saturates into distortion.
                disdl: isCarrier ? 5 : 0
            });
        }
        return fmOps;
    }

    /**
     * Convert an entire DX7 bank into bebhionn instrument objects.
     * Skips voices with all operators silenced (outputLevel=0).
     *
     * @param {ArrayBuffer} arrayBuffer - DX7 .syx file contents
     * @param {number} [maxOps=6] - Operator count cap per voice
     * @returns {Array<{name: string, operators: Object[]}>}
     */
    function convertBank(arrayBuffer, maxOps) {
        var voices = parseSysex(arrayBuffer);
        var instruments = [];
        for (var i = 0; i < voices.length; i++) {
            var v = voices[i];
            var hasAudibleOp = false;
            for (var o = 0; o < v.operators.length; o++) {
                if (v.operators[o].outputLevel > 0) { hasAudibleOp = true; break; }
            }
            if (!hasAudibleOp) continue;
            instruments.push({
                name: v.name || ('DX7 ' + i),
                operators: voiceToOperators(v, maxOps)
            });
        }
        return instruments;
    }

    return {
        parseSysex: parseSysex,
        decodeAlgorithm: decodeAlgorithm,
        voiceToOperators: voiceToOperators,
        convertBank: convertBank
    };
})();
