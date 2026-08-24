'use strict';

(function exposeRendererStore(global) {
  function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
  function createStore(initialState = {}) {
    let state = clone(initialState) || {};
    const listeners = new Set();
    return Object.freeze({
      getState: () => state,
      dispatch(action) {
        if (!action || typeof action.type !== 'string') throw new Error('Store actions require a type');
        switch (action.type) {
          case 'CONFIG_LOADED': state = { ...state, config: clone(action.config), configDraft: null }; break;
          case 'CONFIG_DRAFT_OPENED': state = { ...state, configDraft: clone(action.config) }; break;
          case 'CONFIG_DRAFT_DISCARDED': state = { ...state, configDraft: null }; break;
          case 'CONFIG_COMMITTED': state = { ...state, config: clone(action.config), configDraft: null }; break;
          case 'RUN_STATE_CHANGED': state = { ...state, run: clone(action.run) }; break;
          case 'CONNECTION_CHANGED': state = { ...state, connection: { ...(state.connection || {}), ...clone(action.connection) } }; break;
          default: throw new Error(`Unknown store action: ${action.type}`);
        }
        listeners.forEach((listener) => listener(state, action));
        return action;
      },
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    });
  }
  global.RendererStore = Object.freeze({ createStore });
})(window);
