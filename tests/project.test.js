const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const TrackerState = require('../src/core/tracker_state.js');
const { buildSEQ, parseSEQ } = require('../src/io/seq_io.js');
const { buildMIDI, parseMIDI } = require('../src/io/midi_io.js');

// -- helpers --

function makeState() {
    var insts = [
        { name: 'Lead Synth', operators: [{ freq_ratio: 1, level: 0.8, ar: 31, d1r: 0, dl: 0, d2r: 0, rr: 14, mdl: 0, mod_source: -1, feedback: 0, is_carrier: true, waveform: 0, loop_mode: 1, loop_start: 0, loop_end: 1024 }] },
        { name: 'Bass', operators: [{ freq_ratio: 0.5, level: 1.0, ar: 28, d1r: 5, dl: 10, d2r: 0, rr: 10, mdl: 0, mod_source: -1, feedback: 0, is_carrier: true, waveform: 0, loop_mode: 1, loop_start: 0, loop_end: 1024 }] },
    ];
    return TrackerState.create(insts);
}

function makePattern(length, channelData, numChannels) {
    numChannels = numChannels || 8;
    var channels = [];
    for (var ch = 0; ch < numChannels; ch++) {
        var rows = [];
        for (var r = 0; r < length; r++) rows.push({ note: null, inst: null, vol: null });
        channels.push({ defaultInst: Math.min(ch, 1), rows: rows });
    }
    for (var chKey of Object.keys(channelData)) {
        var notes = channelData[chKey];
        for (var n of notes) {
            channels[parseInt(chKey)].rows[n[0]] = { note: n[1], inst: null, vol: n[2] !== undefined ? n[2] : null };
        }
    }
    return { length: length, channels: channels };
}

function serializeProject(state) {
    return {
        version: 1,
        bpm: state.bpm,
        stepsPerBeat: state.stepsPerBeat,
        patternLength: state.patternLength,
        instruments: state.instruments,
        patterns: state.patterns,
        song: state.song,
        channelStates: TrackerState.getChannelStates(),
    };
}

// ═══════════════════════════════════════════════
// .beb project serialization
// ═══════════════════════════════════════════════

describe('.beb project format', () => {
    beforeEach(() => { TrackerState.resetChannelState(); });

    it('round-trips state through JSON', () => {
        var state = makeState();
        state.bpm = 140;
        state.stepsPerBeat = 8;
        state.patterns[0].channels[0].rows[0] = { note: 60, inst: null, vol: 100 };
        state.patterns[0].channels[1].rows[2] = { note: 48, inst: 1, vol: 80 };

        var project = serializeProject(state);
        var json = JSON.stringify(project);
        var restored = JSON.parse(json);

        assert.equal(restored.version, 1);
        assert.equal(restored.bpm, 140);
        assert.equal(restored.stepsPerBeat, 8);
        assert.equal(restored.patternLength, 32);
        assert.equal(restored.instruments.length, 2);
        assert.equal(restored.patterns.length, 1);
        assert.deepEqual(restored.song, [0]);
    });

    it('preserves instrument names', () => {
        var state = makeState();
        var project = serializeProject(state);
        var json = JSON.stringify(project);
        var restored = JSON.parse(json);

        assert.equal(restored.instruments[0].name, 'Lead Synth');
        assert.equal(restored.instruments[1].name, 'Bass');
    });

    it('preserves pattern data', () => {
        var state = makeState();
        state.patterns[0].channels[0].rows[0] = { note: 60, inst: null, vol: 100 };
        state.patterns[0].channels[0].rows[4] = { note: 64, inst: 1, vol: null };

        var project = serializeProject(state);
        var json = JSON.stringify(project);
        var restored = JSON.parse(json);

        assert.deepEqual(restored.patterns[0].channels[0].rows[0], { note: 60, inst: null, vol: 100 });
        assert.deepEqual(restored.patterns[0].channels[0].rows[4], { note: 64, inst: 1, vol: null });
        // Empty cells remain null
        assert.deepEqual(restored.patterns[0].channels[0].rows[1], { note: null, inst: null, vol: null });
    });

    it('preserves song arrangement', () => {
        var state = makeState();
        TrackerState.newPattern(state, 0);
        TrackerState.addSongSlot(state, 0);
        // song = [0, 1, 0]
        assert.equal(state.song.length, 3);

        var project = serializeProject(state);
        var json = JSON.stringify(project);
        var restored = JSON.parse(json);

        assert.deepEqual(restored.song, state.song);
    });

    it('preserves channel mute states', () => {
        TrackerState.toggleMute(2);
        TrackerState.toggleMute(5);

        var state = makeState();
        var project = serializeProject(state);
        var json = JSON.stringify(project);
        var restored = JSON.parse(json);

        assert.equal(restored.channelStates[0], 'on');
        assert.equal(restored.channelStates[2], 'muted');
        assert.equal(restored.channelStates[5], 'muted');
        assert.equal(restored.channelStates[7], 'on');
    });

    it('preserves channel solo state', () => {
        TrackerState.toggleSolo(3);

        var state = makeState();
        var project = serializeProject(state);
        var json = JSON.stringify(project);
        var restored = JSON.parse(json);

        assert.equal(restored.channelStates[3], 'solo');
        assert.equal(restored.channelStates[0], 'on');
    });

    it('preserves operator parameters', () => {
        var state = makeState();
        var project = serializeProject(state);
        var json = JSON.stringify(project);
        var restored = JSON.parse(json);

        var op = restored.instruments[0].operators[0];
        assert.equal(op.freq_ratio, 1);
        assert.equal(op.level, 0.8);
        assert.equal(op.ar, 31);
        assert.equal(op.is_carrier, true);
        assert.equal(op.waveform, 0);
    });
});

// ═══════════════════════════════════════════════
// Channel state get/set
// ═══════════════════════════════════════════════

describe('TrackerState.getChannelStates / setChannelStates', () => {
    beforeEach(() => { TrackerState.resetChannelState(); });

    it('getChannelStates returns array of 8 states', () => {
        var states = TrackerState.getChannelStates();
        assert.equal(states.length, 8);
        for (var i = 0; i < 8; i++) {
            assert.equal(states[i], 'on');
        }
    });

    it('getChannelStates returns a copy, not a reference', () => {
        var states = TrackerState.getChannelStates();
        states[0] = 'muted';
        assert.equal(TrackerState.getChannelState(0), 'on');
    });

    it('setChannelStates restores mute state', () => {
        TrackerState.setChannelStates(['on', 'muted', 'on', 'on', 'muted', 'on', 'on', 'on']);
        assert.equal(TrackerState.getChannelState(1), 'muted');
        assert.equal(TrackerState.getChannelState(4), 'muted');
        assert.equal(TrackerState.getChannelState(0), 'on');
        assert.ok(!TrackerState.isChannelAudible(1));
        assert.ok(!TrackerState.isChannelAudible(4));
        assert.ok(TrackerState.isChannelAudible(0));
    });

    it('setChannelStates restores solo state', () => {
        TrackerState.setChannelStates(['on', 'on', 'solo', 'on', 'on', 'on', 'on', 'on']);
        assert.equal(TrackerState.getChannelState(2), 'solo');
        assert.ok(TrackerState.isChannelAudible(2));
        assert.ok(!TrackerState.isChannelAudible(0));
    });

    it('setChannelStates defaults missing entries to on', () => {
        TrackerState.setChannelStates(['muted', 'muted']);
        assert.equal(TrackerState.getChannelState(0), 'muted');
        assert.equal(TrackerState.getChannelState(1), 'muted');
        assert.equal(TrackerState.getChannelState(2), 'on');
    });

    it('setChannelStates handles null input', () => {
        TrackerState.toggleMute(0);
        TrackerState.setChannelStates(null);
        assert.equal(TrackerState.getChannelState(0), 'on');
    });

    it('round-trips through JSON', () => {
        TrackerState.toggleMute(1);
        TrackerState.toggleMute(6);
        var saved = JSON.parse(JSON.stringify(TrackerState.getChannelStates()));
        TrackerState.resetChannelState();
        TrackerState.setChannelStates(saved);
        assert.equal(TrackerState.getChannelState(1), 'muted');
        assert.equal(TrackerState.getChannelState(6), 'muted');
        assert.equal(TrackerState.getChannelState(0), 'on');
    });
});

// ═══════════════════════════════════════════════
// Muted channels excluded from SEQ export
// ═══════════════════════════════════════════════

describe('buildSEQ with mutedChannels', () => {
    it('excludes muted channels from note events', () => {
        var pat = makePattern(4, {
            0: [[0, 60, 100]],
            1: [[0, 48, 80]],
            2: [[0, 72, 90]],
        });
        var seq = buildSEQ({ patterns: [pat], song: [0], bpm: 120, stepsPerBeat: 4, numChannels: 8, mutedChannels: [1] });
        var parsed = parseSEQ(seq.buffer);

        // Should have notes on ch 0 and 2, but not ch 1
        var noteChannels = parsed.events
            .filter(function(e) { return e.type === 'on'; })
            .map(function(e) { return e.ch; });
        assert.ok(noteChannels.includes(0), 'ch 0 should be present');
        assert.ok(noteChannels.includes(2), 'ch 2 should be present');
        assert.ok(!noteChannels.includes(1), 'ch 1 should be muted');
    });

    it('excludes muted channels from program change events', () => {
        var pat = makePattern(4, {
            0: [[0, 60, 100]],
            1: [[0, 48, 80]],
        });
        var seq = buildSEQ({ patterns: [pat], song: [0], bpm: 120, stepsPerBeat: 4, numChannels: 8, mutedChannels: [1] });
        var parsed = parseSEQ(seq.buffer);

        var pcChannels = parsed.events
            .filter(function(e) { return e.type === 'pc'; })
            .map(function(e) { return e.ch; });
        assert.ok(!pcChannels.includes(1), 'ch 1 should not have program change');
    });

    it('exports all channels when mutedChannels is empty', () => {
        var pat = makePattern(4, {
            0: [[0, 60, 100]],
            1: [[0, 48, 80]],
        });
        var seqMuted = buildSEQ({ patterns: [pat], song: [0], bpm: 120, stepsPerBeat: 4, numChannels: 8, mutedChannels: [] });
        var seqNone = buildSEQ({ patterns: [pat], song: [0], bpm: 120, stepsPerBeat: 4, numChannels: 8 });

        assert.equal(seqMuted.length, seqNone.length);
    });

    it('exports all channels when mutedChannels is omitted', () => {
        var pat = makePattern(4, {
            0: [[0, 60, 100]],
            1: [[0, 48, 80]],
        });
        var seq = buildSEQ({ patterns: [pat], song: [0], bpm: 120, stepsPerBeat: 4, numChannels: 8 });
        var parsed = parseSEQ(seq.buffer);

        var noteChannels = parsed.events
            .filter(function(e) { return e.type === 'on'; })
            .map(function(e) { return e.ch; });
        assert.ok(noteChannels.includes(0));
        assert.ok(noteChannels.includes(1));
    });
});

// ═══════════════════════════════════════════════
// Muted channels excluded from MIDI export
// ═══════════════════════════════════════════════

describe('buildMIDI with mutedChannels', () => {
    it('excludes muted channels from note events', () => {
        var pat = makePattern(4, {
            0: [[0, 60, 100]],
            1: [[0, 48, 80]],
            2: [[0, 72, 90]],
        });
        var midi = buildMIDI({ patterns: [pat], song: [0], bpm: 120, stepsPerBeat: 4, numChannels: 8, mutedChannels: [1] });
        var parsed = parseMIDI(midi.buffer);

        var noteOnChannels = parsed.events
            .filter(function(e) { return e.type === 'on'; })
            .map(function(e) { return e.ch; });
        assert.ok(noteOnChannels.includes(0), 'ch 0 should be present');
        assert.ok(noteOnChannels.includes(2), 'ch 2 should be present');
        assert.ok(!noteOnChannels.includes(1), 'ch 1 should be muted');
    });

    it('excludes muted channels from note-off events', () => {
        var pat = makePattern(4, {
            0: [[0, 60, 100]],
            1: [[0, 48, 80]],
        });
        var midi = buildMIDI({ patterns: [pat], song: [0], bpm: 120, stepsPerBeat: 4, numChannels: 8, mutedChannels: [1] });
        var parsed = parseMIDI(midi.buffer);

        var noteOffChannels = parsed.events
            .filter(function(e) { return e.type === 'off'; })
            .map(function(e) { return e.ch; });
        assert.ok(!noteOffChannels.includes(1), 'ch 1 should have no note-off');
    });

    it('can mute multiple channels', () => {
        var pat = makePattern(4, {
            0: [[0, 60, 100]],
            1: [[0, 48, 80]],
            2: [[0, 72, 90]],
            3: [[0, 36, 70]],
        });
        var midi = buildMIDI({ patterns: [pat], song: [0], bpm: 120, stepsPerBeat: 4, numChannels: 8, mutedChannels: [0, 2, 3] });
        var parsed = parseMIDI(midi.buffer);

        var noteOnChannels = parsed.events
            .filter(function(e) { return e.type === 'on'; })
            .map(function(e) { return e.ch; });
        assert.deepEqual(noteOnChannels, [1]);
    });

    it('exports all channels when mutedChannels is omitted', () => {
        var pat = makePattern(4, {
            0: [[0, 60, 100]],
            1: [[0, 48, 80]],
        });
        var midi = buildMIDI({ patterns: [pat], song: [0], bpm: 120, stepsPerBeat: 4, numChannels: 8 });
        var parsed = parseMIDI(midi.buffer);

        var noteOnChannels = parsed.events
            .filter(function(e) { return e.type === 'on'; })
            .map(function(e) { return e.ch; });
        assert.ok(noteOnChannels.includes(0));
        assert.ok(noteOnChannels.includes(1));
    });
});
