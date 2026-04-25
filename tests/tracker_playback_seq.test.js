const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const TrackerState = require('../src/core/tracker_state.js');
const TrackerPlayback = require('../src/core/tracker_playback.js');
const { buildSEQ } = require('../src/io/seq_io.js');

function createMockEngine() {
    return {
        sampleCounter: 0,
        calls: [],
        triggerNote: function (ch, note, instIdx) {
            this.calls.push({ fn: 'triggerNote', ch, note, instIdx, at: this.sampleCounter });
        },
        releaseChannel: function (ch) {
            this.calls.push({ fn: 'releaseChannel', ch, at: this.sampleCounter });
        },
        releaseAll: function () { this.calls.push({ fn: 'releaseAll', at: this.sampleCounter }); },
        getSampleRate: function () { return 44100; },
    };
}

function makeStateWithNotes(noteMap, len, song) {
    var instruments = [
        { name: 'A', operators: [{ ar: 31 }] },
        { name: 'B', operators: [{ ar: 31 }] },
    ];
    var state = TrackerState.create(instruments);
    state.bpm = 120;
    state.stepsPerBeat = 4;
    state.patterns = [TrackerState.createEmptyPattern(state, len || 8)];
    state.song = song || [0];
    var pat = state.patterns[0];
    for (var ch in noteMap) {
        for (var i = 0; i < noteMap[ch].length; i++) {
            var entry = noteMap[ch][i];
            pat.channels[parseInt(ch)].rows[entry[0]] = { note: entry[1], inst: null, vol: entry[2] || null };
        }
    }
    return state;
}

function runBlocks(pb, engine, totalSamples, blockSize) {
    var done = 0;
    while (done < totalSamples) {
        var n = Math.min(blockSize, totalSamples - done);
        // Drive the same interleaved path the audio callback uses, so triggers
        // are reported at their actual sub-block sample positions.
        pb.processBlockSeq(n, function (slice) {
            engine.sampleCounter += slice;
        });
        done += n;
    }
}

describe('TrackerPlayback SEQ mode', () => {
    it('startSeqPlayback enters seq mode and is playing', () => {
        var engine = createMockEngine();
        var state = makeStateWithNotes({ 0: [[0, 60, 100]] });
        TrackerState.resetChannelState();
        var pb = TrackerPlayback.create(state, engine);
        var seq = buildSEQ({
            patterns: state.patterns, song: state.song,
            bpm: state.bpm, stepsPerBeat: state.stepsPerBeat,
            numChannels: TrackerState.NUM_CHANNELS,
        });
        pb.startSeqPlayback(seq);
        assert.equal(pb.playing, true);
        assert.equal(pb.mode, 'seq');
        assert.ok(pb.seqEvents.length >= 2, 'has program-change + note-on events');
        assert.ok(pb.seqSamplesPerTick > 0);
    });

    it('triggers a note at sample-accurate position', () => {
        var engine = createMockEngine();
        var state = makeStateWithNotes({ 0: [[2, 60, 100]] });
        TrackerState.resetChannelState();
        var pb = TrackerPlayback.create(state, engine);
        var seq = buildSEQ({
            patterns: state.patterns, song: state.song,
            bpm: state.bpm, stepsPerBeat: state.stepsPerBeat,
            numChannels: TrackerState.NUM_CHANNELS,
        });
        pb.startSeqPlayback(seq);

        // Row 2 at 120 BPM 4 steps/beat: row tick = 2 * 480/4 = 240 ticks.
        // samplesPerTick = 44100 * 500000 / (480 * 1e6) = ~45.9375 samples/tick.
        var expectedSample = Math.round(240 * pb.seqSamplesPerTick);

        runBlocks(pb, engine, expectedSample + 200, 64);

        var triggers = engine.calls.filter(c => c.fn === 'triggerNote' && c.ch === 0 && c.note === 60);
        assert.equal(triggers.length, 1, 'note triggered exactly once');
        // With interleaved render slices, the trigger should land within ±1 sample
        // of the exact event tick — not just within one block.
        assert.ok(Math.abs(triggers[0].at - expectedSample) <= 1,
            'triggered at sample ' + triggers[0].at + ', expected ~' + expectedSample);
    });

    it('schedules note-off at gate end', () => {
        var engine = createMockEngine();
        // Two notes on ch 0: at row 0 and row 4. Gate of first = 4 rows.
        var state = makeStateWithNotes({ 0: [[0, 60, 100], [4, 62, 100]] }, 8);
        TrackerState.resetChannelState();
        var pb = TrackerPlayback.create(state, engine);
        var seq = buildSEQ({
            patterns: state.patterns, song: state.song,
            bpm: state.bpm, stepsPerBeat: state.stepsPerBeat,
            numChannels: TrackerState.NUM_CHANNELS,
        });
        pb.startSeqPlayback(seq);

        // Row 4 = 4 * 120 = 480 ticks worth of samples.
        var samples = Math.round(500 * pb.seqSamplesPerTick);
        runBlocks(pb, engine, samples, 64);

        var releases = engine.calls.filter(c => c.fn === 'releaseChannel' && c.ch === 0);
        assert.ok(releases.length >= 1, 'note-off was scheduled and fired');
    });

    it('honors mutedChannels from buildSEQ', () => {
        var engine = createMockEngine();
        var state = makeStateWithNotes({ 0: [[0, 60, 100]], 1: [[0, 64, 100]] });
        TrackerState.resetChannelState();
        var pb = TrackerPlayback.create(state, engine);
        var seq = buildSEQ({
            patterns: state.patterns, song: state.song,
            bpm: state.bpm, stepsPerBeat: state.stepsPerBeat,
            numChannels: TrackerState.NUM_CHANNELS,
            mutedChannels: [1],
        });
        pb.startSeqPlayback(seq);
        runBlocks(pb, engine, 8000, 64);

        var ch0 = engine.calls.filter(c => c.fn === 'triggerNote' && c.ch === 0);
        var ch1 = engine.calls.filter(c => c.fn === 'triggerNote' && c.ch === 1);
        assert.equal(ch0.length, 1, 'ch 0 plays');
        assert.equal(ch1.length, 0, 'muted ch 1 does not play');
    });

    it('uses program-change to pick instrument index for triggerNote', () => {
        var engine = createMockEngine();
        var state = makeStateWithNotes({ 0: [[0, 60, 100]] });
        // buildSEQ emits a 0xC0 program change at tick 0 carrying defaultInst.
        // Force defaultInst on ch 0 to 1 so we can verify instIdx === 1 reaches triggerNote.
        state.patterns[0].channels[0].defaultInst = 1;
        TrackerState.resetChannelState();
        var pb = TrackerPlayback.create(state, engine);
        var seq = buildSEQ({
            patterns: state.patterns, song: state.song,
            bpm: state.bpm, stepsPerBeat: state.stepsPerBeat,
            numChannels: TrackerState.NUM_CHANNELS,
        });
        pb.startSeqPlayback(seq);
        runBlocks(pb, engine, 4000, 64);

        var triggers = engine.calls.filter(c => c.fn === 'triggerNote' && c.ch === 0);
        assert.equal(triggers.length, 1);
        assert.equal(triggers[0].instIdx, 1, 'instrument index from program-change is forwarded');
    });

    it('fires onRowChange in sync with the SEQ tick clock', () => {
        var engine = createMockEngine();
        var state = makeStateWithNotes({}, 4);
        TrackerState.resetChannelState();
        var pb = TrackerPlayback.create(state, engine);
        var rowChanges = [];
        pb.onRowChange = function (row, slot) { rowChanges.push({ row, slot }); };
        var seq = buildSEQ({
            patterns: state.patterns, song: state.song,
            bpm: state.bpm, stepsPerBeat: state.stepsPerBeat,
            numChannels: TrackerState.NUM_CHANNELS,
        });
        pb.startSeqPlayback(seq);

        // Run for 3 full rows worth of samples.
        var samples = Math.round(3 * 120 * pb.seqSamplesPerTick) + 32;
        runBlocks(pb, engine, samples, 64);

        var rows = rowChanges.map(r => r.row);
        assert.ok(rows.includes(0));
        assert.ok(rows.includes(1));
        assert.ok(rows.includes(2));
    });

    it('stop() cleans up SEQ state and releases all', () => {
        var engine = createMockEngine();
        var state = makeStateWithNotes({ 0: [[0, 60, 100]] });
        TrackerState.resetChannelState();
        var pb = TrackerPlayback.create(state, engine);
        var seq = buildSEQ({
            patterns: state.patterns, song: state.song,
            bpm: state.bpm, stepsPerBeat: state.stepsPerBeat,
            numChannels: TrackerState.NUM_CHANNELS,
        });
        pb.startSeqPlayback(seq);
        runBlocks(pb, engine, 200, 64);
        pb.stop();

        assert.equal(pb.playing, false);
        assert.equal(pb.mode, 'live');
        assert.equal(pb.seqEvents, null);
        assert.ok(engine.calls.some(c => c.fn === 'releaseAll'));
    });

    it('consecutive notes are spaced sample-accurately (no drift)', () => {
        var engine = createMockEngine();
        // 4 notes one row apart on ch 0 of a long song (multiple slot loops).
        var state = makeStateWithNotes({ 0: [[0, 60, 100], [4, 60, 100], [8, 60, 100], [12, 60, 100]] }, 16);
        TrackerState.resetChannelState();
        var pb = TrackerPlayback.create(state, engine);
        var seq = buildSEQ({
            patterns: state.patterns, song: state.song,
            bpm: state.bpm, stepsPerBeat: state.stepsPerBeat,
            numChannels: TrackerState.NUM_CHANNELS,
        });
        pb.startSeqPlayback(seq);

        var spt = pb.seqSamplesPerTick;
        var perRowSamples = 120 * spt;     // 4 rows = 1 beat = 120 ticks worth of samples per row
        var samples = Math.round(15 * 120 * spt) + 64;
        runBlocks(pb, engine, samples, 2048); // simulate real 2048-sample audio blocks

        var triggers = engine.calls.filter(c => c.fn === 'triggerNote' && c.note === 60);
        assert.equal(triggers.length, 4);
        // Gap between consecutive triggers should equal 4 rows worth of samples ±1.
        for (var i = 1; i < triggers.length; i++) {
            var gap = triggers[i].at - triggers[i - 1].at;
            var expected = Math.round(4 * perRowSamples);
            assert.ok(Math.abs(gap - expected) <= 1,
                'trigger ' + i + ' gap=' + gap + ' expected~' + expected);
        }
    });

    it('processBlock dispatches to live or seq based on mode', () => {
        var engine = createMockEngine();
        var state = makeStateWithNotes({ 0: [[0, 60, 100]] });
        TrackerState.resetChannelState();
        var pb = TrackerPlayback.create(state, engine);

        // Live mode (default after start)
        pb.start(0, 0);
        assert.equal(pb.mode, 'live');
        pb.processBlock(100);

        // Switch to SEQ
        pb.stop();
        var seq = buildSEQ({
            patterns: state.patterns, song: state.song,
            bpm: state.bpm, stepsPerBeat: state.stepsPerBeat,
            numChannels: TrackerState.NUM_CHANNELS,
        });
        pb.startSeqPlayback(seq);
        assert.equal(pb.mode, 'seq');
        pb.processBlock(100);
    });
});
