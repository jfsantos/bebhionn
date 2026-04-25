/**
 * @module tracker_state
 * @description Pure data model for the tracker. No DOM or sound engine dependencies.
 * Manages patterns, song arrangement, instruments, channel mute/solo, and cursor state.
 */

var TrackerState = (function () {
    'use strict';

    /** @constant {number} Number of tracker channels.
     *  Capped at 16 because the Saturn SEQ format and MIDI channel field both use a
     *  4-bit channel low-nibble (0x90 | ch). Hardware polyphony is bounded separately
     *  by MAX_SLOTS (=32) summed over all sounding instruments' operator counts —
     *  see computeSongSlotUsage. */
    var NUM_CHANNELS = 16;
    /** @constant {number} SCSP slot budget — hardware polyphony limit. */
    var MAX_SLOTS = 32;

    /**
     * ProTracker-style keyboard to note offset mapping.
     * @constant {Object<string, number>}
     */
    var KEY_NOTE_MAP = {
        'z':0, 's':1, 'x':2, 'd':3, 'c':4, 'v':5, 'g':6, 'b':7, 'h':8, 'n':9, 'j':10, 'm':11,
        'q':12,'2':13,'w':14,'3':15,'e':16, 'r':17,'5':18,'t':19,'6':20,'y':21,'7':22,'u':23,
        'i':24,'9':25,'o':26,'0':27,'p':28,
    };

    /**
     * Create a new tracker state object.
     * @param {Object[]} [instruments] - Initial instruments (deep-cloned). Defaults to one empty instrument.
     * @returns {Object} State object with bpm, stepsPerBeat, patternLength, instruments, patterns, song, cursor
     */
    function create(instruments) {
        if (!instruments || instruments.length === 0) {
            instruments = [{
                name: 'Init',
                operators: [{ freq_ratio:1, freq_fixed:0, level:0.8, ar:31, d1r:0, dl:0, d2r:0, rr:14,
                              mdl:0, mod_source:-1, feedback:0, is_carrier:true, waveform:0,
                              loop_mode:1, loop_start:0, loop_end:1024 }]
            }];
        }
        var state = {
            bpm: 120,
            stepsPerBeat: 4,
            patternLength: 32,
            instruments: JSON.parse(JSON.stringify(instruments)),
            patterns: [],
            song: [0],
            cursor: { row: 0, ch: 0, col: 0 },
        };
        state.patterns.push(createEmptyPattern(state, state.patternLength));
        return state;
    }

    /**
     * Create an empty pattern with the given length.
     * @param {Object} state - Tracker state (reads instruments.length for defaultInst clamping)
     * @param {number} len - Number of rows
     * @returns {Object} Pattern with `length` and `channels` array
     */
    function createEmptyPattern(state, len) {
        var channels = [];
        for (var c = 0; c < NUM_CHANNELS; c++) {
            var rows = [];
            for (var r = 0; r < len; r++) rows.push({ note: null, inst: null, vol: null });
            channels.push({ defaultInst: Math.min(c, state.instruments.length - 1), rows: rows });
        }
        return { length: len, channels: channels };
    }

    /**
     * Get the pattern index for a song slot.
     * @param {Object} state
     * @param {number} songSlot
     * @returns {number} Pattern index
     */
    function getCurrentPatternIndex(state, songSlot) {
        return state.song[songSlot] || 0;
    }

    /**
     * Get the pattern object for a song slot.
     * @param {Object} state
     * @param {number} songSlot
     * @returns {Object} Pattern object
     */
    function getCurrentPattern(state, songSlot) {
        return state.patterns[getCurrentPatternIndex(state, songSlot)];
    }

    // ── Song arrangement ──

    /**
     * Append a song slot duplicating the current pattern reference.
     * @param {Object} state
     * @param {number} songSlot - Current song slot
     */
    function addSongSlot(state, songSlot) {
        state.song.push(getCurrentPatternIndex(state, songSlot));
    }

    /**
     * Remove the current song slot. Won't remove the last one.
     * @param {Object} state
     * @param {number} songSlot - Current song slot
     * @returns {number} New song slot index
     */
    function removeSongSlot(state, songSlot) {
        if (state.song.length <= 1) return songSlot;
        state.song.splice(songSlot, 1);
        if (songSlot >= state.song.length) songSlot = state.song.length - 1;
        return songSlot;
    }

    /**
     * Create a new empty pattern and insert a song slot after the current one.
     * @param {Object} state
     * @param {number} songSlot
     * @returns {number} New song slot index
     */
    function newPattern(state, songSlot) {
        var idx = state.patterns.length;
        state.patterns.push(createEmptyPattern(state, state.patternLength));
        state.song.splice(songSlot + 1, 0, idx);
        return songSlot + 1;
    }

    /**
     * Duplicate the current song slot (same pattern index, played again).
     * @param {Object} state
     * @param {number} songSlot
     * @returns {number} New song slot index
     */
    function dupPattern(state, songSlot) {
        var patIdx = getCurrentPatternIndex(state, songSlot);
        state.song.splice(songSlot + 1, 0, patIdx);
        return songSlot + 1;
    }

    // ── Pattern resize ──

    /**
     * Resize the current pattern to a new length.
     * @param {Object} state
     * @param {number} songSlot
     * @param {number} newLen
     */
    function resizePattern(state, songSlot, newLen) {
        state.patternLength = newLen;
        var pat = getCurrentPattern(state, songSlot);
        while (pat.length < newLen) {
            for (var ch = 0; ch < NUM_CHANNELS; ch++) {
                pat.channels[ch].rows.push({ note: null, inst: null, vol: null });
            }
            pat.length++;
        }
        pat.length = newLen;
        for (var ch2 = 0; ch2 < NUM_CHANNELS; ch2++) {
            pat.channels[ch2].rows.length = newLen;
        }
        if (state.cursor.row >= newLen) state.cursor.row = newLen - 1;
    }

    // ── Instruments ──

    /**
     * Add an instrument to the state.
     * @param {Object} state
     * @param {Object} inst - Instrument object to add
     * @returns {number} Index of the new instrument
     */
    function addInstrument(state, inst) {
        state.instruments.push(inst);
        return state.instruments.length - 1;
    }

    /**
     * Duplicate an instrument.
     * @param {Object} state
     * @param {number} instIdx - Index to duplicate
     * @returns {number} Index of the new copy
     */
    function dupInstrument(state, instIdx) {
        var dup = JSON.parse(JSON.stringify(state.instruments[instIdx]));
        dup.name += ' copy';
        state.instruments.push(dup);
        return state.instruments.length - 1;
    }

    /**
     * Delete an instrument. Won't delete the last one.
     * @param {Object} state
     * @param {number} instIdx - Index to delete
     * @returns {number} New selected instrument index
     */
    function delInstrument(state, instIdx) {
        if (state.instruments.length <= 1) return instIdx;
        state.instruments.splice(instIdx, 1);
        if (instIdx >= state.instruments.length) instIdx = state.instruments.length - 1;
        return instIdx;
    }

    // ── Channel mute/solo ──

    var channelState = new Array(NUM_CHANNELS).fill('on');

    /**
     * Check if a channel is audible given current mute/solo state.
     * @param {number} ch
     * @returns {boolean}
     */
    function isChannelAudible(ch) {
        var hasSolo = channelState.indexOf('solo') >= 0;
        if (hasSolo) return channelState[ch] === 'solo';
        return channelState[ch] !== 'muted';
    }

    /**
     * Toggle mute on a channel.
     * @param {number} ch
     * @returns {number[]} Array of channel indices that became inaudible (need engine.releaseChannel)
     */
    function toggleMute(ch) {
        if (channelState[ch] === 'muted') {
            channelState[ch] = 'on';
        } else {
            if (channelState[ch] === 'solo') channelState[ch] = 'on';
            channelState[ch] = 'muted';
        }
        var silenced = [];
        for (var i = 0; i < NUM_CHANNELS; i++) {
            if (!isChannelAudible(i)) silenced.push(i);
        }
        return silenced;
    }

    /**
     * Toggle solo on a channel.
     * @param {number} ch
     * @returns {number[]} Array of channel indices that became inaudible (need engine.releaseChannel)
     */
    function toggleSolo(ch) {
        if (channelState[ch] === 'solo') {
            channelState[ch] = 'on';
        } else {
            for (var i = 0; i < NUM_CHANNELS; i++) {
                if (channelState[i] === 'solo') channelState[i] = 'on';
            }
            channelState[ch] = 'solo';
        }
        var silenced = [];
        for (var j = 0; j < NUM_CHANNELS; j++) {
            if (!isChannelAudible(j)) silenced.push(j);
        }
        return silenced;
    }

    /**
     * Get the mute/solo state string for a channel.
     * @param {number} ch
     * @returns {string} 'on', 'muted', or 'solo'
     */
    function getChannelState(ch) {
        return channelState[ch];
    }

    /**
     * Reset all channels to 'on'.
     */
    function resetChannelState() {
        for (var i = 0; i < NUM_CHANNELS; i++) channelState[i] = 'on';
    }

    /**
     * Get a copy of the full channel state array.
     * @returns {string[]} Array of 'on', 'muted', or 'solo' per channel
     */
    function getChannelStates() {
        return channelState.slice();
    }

    /**
     * Restore channel state from a saved array.
     * @param {string[]} states - Array of 'on', 'muted', or 'solo' per channel
     */
    function setChannelStates(states) {
        for (var i = 0; i < NUM_CHANNELS; i++) {
            channelState[i] = (states && states[i]) || 'on';
        }
    }

    // ── Hardware slot-budget accounting ──

    /**
     * Walk every row of the unrolled song and compute peak simultaneous SCSP slot usage.
     * For each channel we track the operator count of the currently sounding instrument;
     * a `note === -1` cell zeros it, a positive note sets it to the new instrument's
     * operator count. Sum per row, then take the max — that's the song's polyphony cost.
     *
     * @param {Object} state - Tracker state.
     * @returns {{peak: number, peakSongSlot: number, peakRow: number, max: number}}
     */
    function computeSongSlotUsage(state) {
        var perChOps = new Array(NUM_CHANNELS).fill(0);
        var peak = 0;
        var peakSongSlot = 0, peakRow = 0;
        if (!state.song || state.song.length === 0) {
            return { peak: 0, peakSongSlot: 0, peakRow: 0, max: MAX_SLOTS };
        }
        for (var s = 0; s < state.song.length; s++) {
            var pat = state.patterns[state.song[s]];
            if (!pat) continue;
            for (var r = 0; r < pat.length; r++) {
                for (var ch = 0; ch < NUM_CHANNELS; ch++) {
                    var cell = pat.channels[ch].rows[r];
                    if (cell.note === -1) {
                        perChOps[ch] = 0;
                    } else if (cell.note !== null && cell.note >= 0) {
                        var instIdx = cell.inst !== null ? cell.inst : pat.channels[ch].defaultInst;
                        var inst = state.instruments[instIdx];
                        var ops = (inst && inst.operators && inst.operators.length) || 1;
                        perChOps[ch] = ops;
                    }
                }
                var rowSum = 0;
                for (var c2 = 0; c2 < NUM_CHANNELS; c2++) rowSum += perChOps[c2];
                if (rowSum > peak) { peak = rowSum; peakSongSlot = s; peakRow = r; }
            }
        }
        return { peak: peak, peakSongSlot: peakSongSlot, peakRow: peakRow, max: MAX_SLOTS };
    }

    // ── Public API ──

    var api = {
        NUM_CHANNELS: NUM_CHANNELS,
        MAX_SLOTS: MAX_SLOTS,
        computeSongSlotUsage: computeSongSlotUsage,
        KEY_NOTE_MAP: KEY_NOTE_MAP,
        create: create,
        createEmptyPattern: createEmptyPattern,
        getCurrentPatternIndex: getCurrentPatternIndex,
        getCurrentPattern: getCurrentPattern,
        addSongSlot: addSongSlot,
        removeSongSlot: removeSongSlot,
        newPattern: newPattern,
        dupPattern: dupPattern,
        resizePattern: resizePattern,
        addInstrument: addInstrument,
        dupInstrument: dupInstrument,
        delInstrument: delInstrument,
        isChannelAudible: isChannelAudible,
        toggleMute: toggleMute,
        toggleSolo: toggleSolo,
        getChannelState: getChannelState,
        getChannelStates: getChannelStates,
        setChannelStates: setChannelStates,
        resetChannelState: resetChannelState,
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }

    return api;
})();
