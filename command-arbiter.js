'use strict';

class CommandArbiter {
  constructor() { this.tail = Promise.resolve(); this.emergencyGeneration = 0; }

  run(task) {
    const generation = this.emergencyGeneration;
    const execute = async () => {
      if (generation !== this.emergencyGeneration) return { success: false, code: 'ERR_ESTOP', error: 'Command cancelled by emergency stop' };
      return task();
    };
    const result = this.tail.then(execute, execute);
    this.tail = result.catch(() => {});
    return result;
  }

  emergency(task) {
    this.emergencyGeneration += 1;
    return Promise.resolve().then(task);
  }
}

module.exports = { CommandArbiter };
