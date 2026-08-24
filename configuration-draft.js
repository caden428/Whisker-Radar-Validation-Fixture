'use strict';

(function exposeConfigurationDraft(global) {
  let applied = null;
  let draft = null;
  const clone = (value) => JSON.parse(JSON.stringify(value));
  global.ConfigurationDraft = Object.freeze({
    open(config) { applied = clone(config); draft = clone(config); return draft; },
    editable() { if (!draft) throw new Error('Configuration draft is not open'); return draft; },
    commit(config) { applied = clone(config); draft = null; return clone(applied); },
    discard() { const restored = applied ? clone(applied) : null; draft = null; return restored; },
    isOpen() { return !!draft; },
  });
})(window);
