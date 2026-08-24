'use strict';

class FakeFixtureAdapter {
  constructor(responses = {}) { this.responses = responses; this.commands = []; this.estopped = false; }
  async command(name, payload = {}) {
    this.commands.push({ name, payload });
    if (this.estopped && name !== 'estop') return { success: false, code: 'ERR_ESTOP', error: 'Fixture is emergency-stopped' };
    const response = this.responses[name];
    return typeof response === 'function' ? response(payload) : response || { success: true };
  }
  async estop() { this.estopped = true; this.commands.push({ name: 'estop', payload: {} }); return { success: true }; }
  clearEstop() { this.estopped = false; }
}

module.exports = { FakeFixtureAdapter };
