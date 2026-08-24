'use strict';

const TERMINAL = new Set(['complete', 'failed', 'aborted']);
const PHASES = new Set([
  'preflight', 'home', 'move', 'settle', 'baseline', 'trigger', 'hold',
  'recording', 'next', 'retry', 'return', 'finalizing',
]);

class RunController {
  constructor(store, onChange = () => {}) {
    this.store = store;
    this.onChange = onChange;
    this.state = this._recover();
  }

  _recover() {
    const recovered = this.store?.load?.();
    if (!recovered || TERMINAL.has(recovered.status)) return null;
    const state = {
      ...recovered,
      status: 'recovery_required',
      phase: 'recovery_required',
      reason: recovered.reason || 'Application stopped before the run finalized',
      recoveredAt: new Date().toISOString(),
    };
    this.store?.save?.(state);
    return state;
  }

  snapshot() { return this.state ? JSON.parse(JSON.stringify(this.state)) : null; }
  isActive() { return !!this.state && ['active', 'abort_requested', 'faulted'].includes(this.state.status); }
  shouldAbort() { return !!this.state && ['abort_requested', 'faulted', 'recovery_required'].includes(this.state.status); }

  begin(metadata = {}) {
    if (this.state && !TERMINAL.has(this.state.status) && this.state.status !== 'recovery_required') {
      throw new Error('A run is already active');
    }
    const now = new Date().toISOString();
    this.state = {
      schemaVersion: 1,
      runId: String(metadata.runId || `run-${Date.now()}`),
      status: 'active', phase: 'preflight', reason: '',
      startedAt: now, updatedAt: now, metadata: { ...metadata }, progress: {},
    };
    return this._commit();
  }

  transition(phase, progress = {}) {
    if (!this.isActive()) throw new Error('No active run');
    if (!PHASES.has(phase)) throw new Error(`Unsupported run phase: ${phase}`);
    if (this.shouldAbort()) throw new Error(this.state.reason || 'Run cancellation requested');
    this.state = { ...this.state, phase, progress: { ...this.state.progress, ...progress }, updatedAt: new Date().toISOString() };
    return this._commit();
  }

  requestAbort(reason = 'Operator requested cancellation') {
    if (!this.state || TERMINAL.has(this.state.status)) return this.snapshot();
    this.state = { ...this.state, status: 'abort_requested', reason: String(reason), updatedAt: new Date().toISOString() };
    return this._commit();
  }

  fault(reason) {
    if (!this.state || TERMINAL.has(this.state.status)) return this.snapshot();
    this.state = { ...this.state, status: 'faulted', reason: String(reason || 'Fixture fault'), updatedAt: new Date().toISOString() };
    return this._commit();
  }

  finish(status, reason = '', details = {}) {
    if (!['complete', 'failed', 'aborted'].includes(status)) throw new Error(`Invalid terminal run status: ${status}`);
    if (!this.state) throw new Error('No run to finalize');
    this.state = { ...this.state, status, phase: status, reason: String(reason), details: { ...details }, updatedAt: new Date().toISOString(), completedAt: new Date().toISOString() };
    const result = this._commit();
    this.store?.clear?.();
    return result;
  }

  resolveRecovery(reason = 'Recovered run acknowledged') {
    if (this.state?.status !== 'recovery_required') return this.snapshot();
    return this.finish('aborted', reason);
  }

  _commit() {
    this.store?.save?.(this.state);
    const snapshot = this.snapshot();
    this.onChange(snapshot);
    return snapshot;
  }
}

module.exports = { RunController, PHASES, TERMINAL };
