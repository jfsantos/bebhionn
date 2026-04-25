/**
 * @module tracker_playback
 * @description Step sequencer for the tracker. No DOM dependencies.
 * Calls the sound engine via the SoundEngine interface for note triggering.
 */

var TrackerPlayback = (function () {
    'use strict';

    // In Node.js, TrackerState must be required; in browser it's a global.
    var _TrackerState = (typeof TrackerState !== 'undefined') ? TrackerState : require('./tracker_state.js');
    var _parseSEQ = (typeof parseSEQ !== 'undefined') ? parseSEQ : require('../io/seq_io.js').parseSEQ;

    /**
     * Create a playback instance.
     *
     * @param {Object} state - TrackerState state object (read for patterns, song, bpm, stepsPerBeat, instruments)
     * @param {Object} engine - SoundEngine implementation (triggerNote, releaseChannel, releaseAll, getSampleRate)
     * @returns {Object} Playback object
     */
    function create(state, engine) {
        var pb = {
            playing: false,
            mode: 'live',
            currentRow: 0,
            currentSongSlot: 0,
            samplePos: 0,
            samplesPerStep: 0,
            pendingOffs: [],

            // SEQ-mode state (populated by startSeqPlayback)
            seqEvents: null,
            seqProgPerCh: null,
            seqNextEventIdx: 0,
            seqPendingOffs: null,
            seqSamplesAccum: 0,        // fractional samples-since-SEQ-start
            seqSamplesPerTick: 0,      // sampleRate * mspb / (resolution * 1e6)
            seqTotalTicks: 0,
            seqRowBoundaries: null,    // [{tick, row, slot}, ...] sorted by tick
            seqNextRowIdx: 0,

            /** Callback fired when the current row changes during playback. Set by UI. */
            onRowChange: null,
            /** Callback fired when playback stops. Set by UI. */
            onStop: null,

            /**
             * Start playback from a given position.
             * @param {number} row - Starting row
             * @param {number} songSlot - Starting song slot
             */
            start: function (row, songSlot) {
                this.playing = true;
                this.mode = 'live';
                this.currentRow = row;
                this.currentSongSlot = songSlot;
                this.samplePos = 0;
                this.pendingOffs = [];
                this.updateTempo();
            },

            /**
             * Start sample-accurate SEQ-mode playback from a built SEQ byte stream.
             * Notes are dispatched at exact sub-block sample positions instead of at
             * audio-block boundaries, eliminating the per-step rounding drift that
             * accumulates in live mode.
             *
             * @param {Uint8Array} seqBytes - Output of buildSEQ().
             * @param {Object} [opts]
             * @param {number} [opts.stepsPerBeat] - Mirrors state.stepsPerBeat at build time. Defaults to current state.
             * @param {number[][]} [opts.slotPatternLengths] - Optional per-slot pattern lengths (rows). Defaults to current state.
             */
            startSeqPlayback: function (seqBytes, opts) {
                var parsed = _parseSEQ(seqBytes.buffer ? seqBytes.buffer.slice(seqBytes.byteOffset, seqBytes.byteOffset + seqBytes.byteLength) : seqBytes);
                var events = parsed.events.slice().sort(function (a, b) {
                    if (a.absTime !== b.absTime) return a.absTime - b.absTime;
                    if (a.type === 'pc' && b.type !== 'pc') return -1;
                    if (a.type !== 'pc' && b.type === 'pc') return 1;
                    return 0;
                });

                var sampleRate = engine.getSampleRate();
                var mspb = Math.round(60000000 / state.bpm);
                this.seqSamplesPerTick = sampleRate * mspb / (parsed.resolution * 1000000);

                var stepsPerBeat = (opts && opts.stepsPerBeat) || state.stepsPerBeat;
                var ticksPerStep = parsed.resolution / stepsPerBeat;

                // Build row boundary table from current song layout. Mirrors buildSEQ's
                // stepOffset accumulation so the cursor lines up with what was rendered.
                var boundaries = [];
                var stepOffset = 0;
                for (var s = 0; s < state.song.length; s++) {
                    var pat = state.patterns[state.song[s]];
                    for (var r = 0; r < pat.length; r++) {
                        boundaries.push({
                            tick: Math.round((stepOffset + r) * ticksPerStep),
                            row: r,
                            slot: s,
                        });
                    }
                    stepOffset += pat.length;
                }
                this.seqRowBoundaries = boundaries;
                this.seqNextRowIdx = 0;
                this.seqTotalTicks = Math.round(stepOffset * ticksPerStep);

                this.seqEvents = events;
                this.seqProgPerCh = new Array(16);
                for (var c = 0; c < 16; c++) this.seqProgPerCh[c] = 0;
                this.seqNextEventIdx = 0;
                this.seqPendingOffs = [];
                this.seqSamplesAccum = 0;

                this.playing = true;
                this.mode = 'seq';
                this.currentRow = 0;
                this.currentSongSlot = 0;
            },

            /**
             * Stop playback and release all notes.
             */
            stop: function () {
                this.playing = false;
                this.mode = 'live';
                this.pendingOffs = [];
                this.seqEvents = null;
                this.seqProgPerCh = null;
                this.seqPendingOffs = null;
                this.seqRowBoundaries = null;
                this.seqNextEventIdx = 0;
                this.seqNextRowIdx = 0;
                this.seqSamplesAccum = 0;
                engine.releaseAll();
                if (this.onStop) this.onStop();
            },

            /**
             * Recalculate samples-per-step from current BPM and stepsPerBeat.
             */
            updateTempo: function () {
                var sampleRate = engine.getSampleRate();
                this.samplesPerStep = Math.round(sampleRate * 60 / state.bpm / state.stepsPerBeat);
            },

            /**
             * Process an audio block. Called from the engine's audio callback.
             * Advances the sequencer and triggers notes at step boundaries.
             * @param {number} numSamples - Number of samples in this block
             */
            processBlock: function (numSamples) {
                if (this.mode === 'seq') {
                    // No render callback supplied: degrade to block-bounded dispatch.
                    // The audio callback should call processBlockSeq(n, renderFn) directly
                    // to actually get sample-accurate key-ons.
                    return this.processBlockSeq(numSamples, null);
                }
                var remaining = numSamples;
                while (remaining > 0) {
                    var untilNext = this.samplesPerStep - this.samplePos;
                    if (untilNext <= 0) {
                        var pat = state.patterns[state.song[this.currentSongSlot]];
                        this.triggerRow(this.currentRow, pat);
                        if (this.onRowChange) this.onRowChange(this.currentRow, this.currentSongSlot);
                        this.currentRow++;
                        if (this.currentRow >= pat.length) {
                            this.currentRow = 0;
                            this.currentSongSlot++;
                            if (this.currentSongSlot >= state.song.length) {
                                this.currentSongSlot = 0; // loop song
                            }
                        }
                        this.samplePos = 0;
                        continue;
                    }
                    var advance = Math.min(remaining, untilNext);
                    this.samplePos += advance;
                    remaining -= advance;
                }
            },

            /**
             * Process an audio block in SEQ mode with sample-accurate dispatch.
             *
             * For real sample accuracy, key-ons must take effect *between* render slices,
             * not at the next block boundary. The audio callback owns scsp_render(n), so
             * it passes a renderFn(slice) here and we call it for every audio slice between
             * events. Without renderFn (testing or fallback), we still walk events but
             * effectively collapse to block-bounded timing.
             *
             * @param {number} numSamples
             * @param {function(number):void} [renderFn] - Render `slice` samples to output.
             */
            processBlockSeq: function (numSamples, renderFn) {
                var spt = this.seqSamplesPerTick;
                if (spt <= 0 || !this.seqEvents) {
                    if (renderFn) renderFn(numSamples);
                    return;
                }

                var samplesLeft = numSamples;
                while (samplesLeft > 0) {
                    // Earliest tick of: next event, next pending note-off, next row boundary,
                    // or end-of-song (to trigger loopback when everything else is exhausted).
                    var nextTick = Infinity;
                    if (this.seqNextEventIdx < this.seqEvents.length) {
                        nextTick = this.seqEvents[this.seqNextEventIdx].absTime;
                    }
                    for (var i = 0; i < this.seqPendingOffs.length; i++) {
                        if (this.seqPendingOffs[i].absTime < nextTick) nextTick = this.seqPendingOffs[i].absTime;
                    }
                    if (this.seqNextRowIdx < this.seqRowBoundaries.length) {
                        var rb = this.seqRowBoundaries[this.seqNextRowIdx];
                        if (rb.tick < nextTick) nextTick = rb.tick;
                    }
                    if (this.seqTotalTicks < nextTick &&
                        this.seqNextEventIdx >= this.seqEvents.length &&
                        this.seqPendingOffs.length === 0) {
                        nextTick = this.seqTotalTicks;
                    }

                    if (nextTick === Infinity) {
                        // No more events: render whatever's left of the block and exit.
                        this.seqSamplesAccum += samplesLeft;
                        if (renderFn) renderFn(samplesLeft);
                        return;
                    }

                    var samplesUntil = Math.max(0, Math.round(nextTick * spt - this.seqSamplesAccum));
                    if (samplesUntil > samplesLeft) {
                        // Event is past this block boundary — render the rest and return.
                        this.seqSamplesAccum += samplesLeft;
                        if (renderFn) renderFn(samplesLeft);
                        return;
                    }

                    // Render audio up to the exact sample of the upcoming event.
                    if (samplesUntil > 0 && renderFn) renderFn(samplesUntil);
                    this.seqSamplesAccum += samplesUntil;
                    samplesLeft -= samplesUntil;

                    // Loop back to song start when we've drained everything.
                    if (this.seqNextEventIdx >= this.seqEvents.length &&
                        this.seqPendingOffs.length === 0 &&
                        nextTick >= this.seqTotalTicks) {
                        this.seqSamplesAccum = 0;
                        this.seqNextEventIdx = 0;
                        this.seqNextRowIdx = 0;
                        for (var pc2 = 0; pc2 < 16; pc2++) this.seqProgPerCh[pc2] = 0;
                        continue;
                    }

                    // Fire every event/off/row-tick that lands at this tick (handles ties).
                    var firedAny = true;
                    while (firedAny) {
                        firedAny = false;
                        for (var j = 0; j < this.seqPendingOffs.length; j++) {
                            if (this.seqPendingOffs[j].absTime <= nextTick) {
                                engine.releaseChannel(this.seqPendingOffs[j].ch);
                                this.seqPendingOffs.splice(j, 1);
                                firedAny = true;
                                break;
                            }
                        }
                    }

                    while (this.seqNextEventIdx < this.seqEvents.length &&
                           this.seqEvents[this.seqNextEventIdx].absTime <= nextTick) {
                        var ev = this.seqEvents[this.seqNextEventIdx++];
                        if (ev.type === 'pc') {
                            this.seqProgPerCh[ev.ch] = ev.prog;
                        } else if (ev.type === 'on') {
                            var prog = this.seqProgPerCh[ev.ch] || 0;
                            var inst = state.instruments[prog] || state.instruments[0];
                            engine.releaseChannel(ev.ch);
                            engine.triggerNote(ev.ch, ev.note, prog, inst);
                            this.seqPendingOffs.push({ absTime: ev.absTime + ev.gate, ch: ev.ch });
                        }
                    }

                    while (this.seqNextRowIdx < this.seqRowBoundaries.length &&
                           this.seqRowBoundaries[this.seqNextRowIdx].tick <= nextTick) {
                        var rowB = this.seqRowBoundaries[this.seqNextRowIdx++];
                        this.currentRow = rowB.row;
                        this.currentSongSlot = rowB.slot;
                        if (this.onRowChange) this.onRowChange(rowB.row, rowB.slot);
                    }
                }
            },

            /**
             * Trigger notes for a single pattern row.
             * @param {number} row
             * @param {Object} pat - Pattern object
             */
            triggerRow: function (row, pat) {
                var NUM_CHANNELS = _TrackerState.NUM_CHANNELS;
                // Process pending note-offs that expire at this position
                var curPos = this.currentSongSlot * 10000 + row;
                this.pendingOffs = this.pendingOffs.filter(function (off) {
                    if (off.pos <= curPos) {
                        engine.releaseChannel(off.ch);
                        return false;
                    }
                    return true;
                });

                for (var ch = 0; ch < NUM_CHANNELS; ch++) {
                    if (!_TrackerState.isChannelAudible(ch)) continue;
                    var cell = pat.channels[ch].rows[row];
                    if (cell.note === -1) {
                        engine.releaseChannel(ch);
                    } else if (cell.note !== null) {
                        var instIdx = cell.inst !== null ? cell.inst : pat.channels[ch].defaultInst;
                        engine.releaseChannel(ch); // release previous note first
                        var inst = state.instruments[instIdx];
                        engine.triggerNote(ch, cell.note, instIdx, inst);

                        // Schedule note-off: find next note on this channel or end of pattern
                        var gateRows = pat.length - row;
                        for (var r = row + 1; r < pat.length; r++) {
                            if (pat.channels[ch].rows[r].note !== null) {
                                gateRows = r - row;
                                break;
                            }
                        }
                        var offPos = this.currentSongSlot * 10000 + row + gateRows;
                        this.pendingOffs.push({ pos: offPos, ch: ch });
                    }
                }
            }
        };

        return pb;
    }

    var api = { create: create };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }

    return api;
})();
