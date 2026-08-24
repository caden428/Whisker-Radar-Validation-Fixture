'use strict';

const assert = require('assert');
const TextInputCore = require('../text-input-core');

function input(value = '', start = value.length, end = start) {
  return {
    value,
    selectionStart: start,
    selectionEnd: end,
    setSelectionRange(nextStart, nextEnd) {
      this.selectionStart = nextStart;
      this.selectionEnd = nextEnd;
    },
  };
}

const rapid = input();
'Fast campaign typing 123'.split('').forEach((character) => {
  assert.strictEqual(TextInputCore.applyKey(rapid, character), true);
});
assert.strictEqual(rapid.value, 'Fast campaign typing 123', 'rapid consecutive keys must never be lost or duplicated');
assert.strictEqual(rapid.selectionStart, rapid.value.length, 'caret must advance after every character');

const selected = input('Radar old campaign', 6, 9);
TextInputCore.insertAtSelection(selected, 'new');
assert.strictEqual(selected.value, 'Radar new campaign', 'typing must replace the current selection');
assert.strictEqual(selected.selectionStart, 9);
assert.strictEqual(selected.selectionEnd, 9);

TextInputCore.applyKey(selected, 'Backspace');
assert.strictEqual(selected.value, 'Radar ne campaign', 'Backspace must remove text after reopening a campaign');
TextInputCore.applyKey(selected, 'w');
assert.strictEqual(selected.value, 'Radar new campaign', 'typing must add text again after deletion');

const deletion = input('Campaign old text', 9, 12);
TextInputCore.applyKey(deletion, 'Delete');
assert.strictEqual(deletion.value, 'Campaign  text', 'Delete must remove selected text');

assert.strictEqual(TextInputCore.insertAtSelection(null, 'x'), false);

console.log('text input core tests passed');
