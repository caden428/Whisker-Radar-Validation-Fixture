(function installTextInputCore(globalScope) {
  'use strict';

/**
 * Inserts text at an input's current selection without relying on Chromium's
 * occasionally lost default insertion or HTMLInputElement.setRangeText().
 */
function insertAtSelection(input, text) {
  if (!input || typeof input.value !== 'string') return false;
  const value = input.value;
  const start = Number.isInteger(input.selectionStart) ? input.selectionStart : value.length;
  const end = Number.isInteger(input.selectionEnd) ? input.selectionEnd : start;
  const insertion = String(text);
  input.value = value.slice(0, start) + insertion + value.slice(end);
  const caret = start + insertion.length;
  if (typeof input.setSelectionRange === 'function') input.setSelectionRange(caret, caret);
  else {
    input.selectionStart = caret;
    input.selectionEnd = caret;
  }
  return true;
}

/** Applies the text-editing keys the campaign form must preserve reliably. */
function applyKey(input, key) {
  if (!input || typeof input.value !== 'string') return false;
  const value = input.value;
  const start = Number.isInteger(input.selectionStart) ? input.selectionStart : value.length;
  const end = Number.isInteger(input.selectionEnd) ? input.selectionEnd : start;
  if (key === 'Backspace') {
    if (start !== end) return insertAtSelection(input, '');
    if (start <= 0) return true;
    input.selectionStart = start - 1;
    return insertAtSelection(input, '');
  }
  if (key === 'Delete') {
    if (start !== end) return insertAtSelection(input, '');
    if (start >= value.length) return true;
    input.selectionEnd = start + 1;
    return insertAtSelection(input, '');
  }
  return String(key).length === 1 && insertAtSelection(input, key);
}

  const textInputApi = { insertAtSelection, applyKey };
  if (typeof module !== 'undefined' && module.exports) module.exports = textInputApi;
  if (globalScope) globalScope.TextInputCore = textInputApi;
}(typeof globalThis !== 'undefined' ? globalThis : this));
