'use strict';

const fs = require('fs');
const path = require('path');

class StructuredLogger {
  constructor(filePath, context = () => ({})) { this.filePath = filePath; this.context = context; }
  write(level, event, details = {}) {
    const record = { timestamp: new Date().toISOString(), level, event, ...this.context(), ...details };
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.appendFileSync(this.filePath, `${JSON.stringify(record)}\n`, 'utf8');
    } catch (error) {
      console.error('Structured diagnostic write failed:', error?.message || error);
    }
    return record;
  }
  info(event, details) { return this.write('info', event, details); }
  warn(event, details) { return this.write('warn', event, details); }
  error(event, details) { return this.write('error', event, details); }
}

module.exports = { StructuredLogger };
