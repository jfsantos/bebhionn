const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { NOTE_NAMES, noteName } = require('../src/core/note_util.js');

describe('NOTE_NAMES', () => {
    it('has 12 entries', () => {
        assert.equal(NOTE_NAMES.length, 12);
    });

    it('starts with C and ends with B', () => {
        assert.equal(NOTE_NAMES[0], 'C-');
        assert.equal(NOTE_NAMES[11], 'B-');
    });
});

describe('noteName', () => {
    // Standard MIDI / DAW octave convention: MIDI 60 = middle C = C4.
    // Matches MIDI files, SF2/SFZ root keys, WAV smpl chunks, and every DAW.
    it('converts middle C (60) to C-4', () => {
        assert.equal(noteName(60), 'C-4');
    });

    it('converts concert A (69) to A-4', () => {
        assert.equal(noteName(69), 'A-4');
    });

    it('converts MIDI 12 to C-0', () => {
        assert.equal(noteName(12), 'C-0');
    });

    it('converts MIDI 127 to G-9', () => {
        assert.equal(noteName(127), 'G-9');
    });

    it('handles sharps', () => {
        assert.equal(noteName(61), 'C#4');
        assert.equal(noteName(70), 'A#4');
    });

    it('returns ??? for out of range values', () => {
        assert.equal(noteName(-1), '???');
        assert.equal(noteName(128), '???');
    });
});
