/**
 * @module note_util
 * @description MIDI note name utilities.
 */

/**
 * Note name prefixes indexed by pitch class (0–11).
 * @constant {string[]}
 */
const NOTE_NAMES = ['C-','C#','D-','D#','E-','F-','F#','G-','G#','A-','A#','B-'];

/**
 * Convert a MIDI note number to a display string using the standard MIDI /
 * DAW octave convention where MIDI 60 (middle C) is labeled C4. This matches
 * what every DAW, sample library, SF2/SFZ root key, and WAV smpl chunk uses,
 * so root-note pickers and pattern labels line up with external tools.
 *
 * @param {number} midi - MIDI note number (0–127)
 * @returns {string} Note name with octave, e.g. `"C-4"`, `"F#5"`. Returns `"???"` if out of range.
 *
 * @example
 * noteName(60)  // "C-4" (middle C)
 * noteName(69)  // "A-4" (A440)
 * noteName(128) // "???"
 */
function noteName(midi) {
    if (midi < 0 || midi > 127) return '???';
    return NOTE_NAMES[midi % 12] + (Math.floor(midi / 12) - 1);
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { NOTE_NAMES, noteName };
}
