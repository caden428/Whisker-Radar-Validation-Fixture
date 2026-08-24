'use strict';

const fs = require('fs');
const path = require('path');
const ValidationCore = require('../validation-core');

function parseCsv(text) {
  const rows = [];
  let row = [], value = '', quoted = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') { value += '"'; index++; }
      else if (character === '"') quoted = false;
      else value += character;
    } else if (character === '"') quoted = true;
    else if (character === ',') { row.push(value); value = ''; }
    else if (character === '\n') { row.push(value.replace(/\r$/, '')); rows.push(row); row = []; value = ''; }
    else value += character;
  }
  if (value || row.length) { row.push(value); rows.push(row); }
  return rows;
}

function csv(value) {
  const text = String(value == null ? '' : value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function main() {
  const runDirectory = path.resolve(process.argv[2] || '');
  const targetCycle = String(process.argv[3] || '');
  const targetPoint = String(process.argv[4] || '');
  const csvPath = path.join(runDirectory, 'observations.csv');
  const summaryPath = path.join(runDirectory, 'summary.json');
  if (!fs.existsSync(csvPath) || !fs.existsSync(summaryPath)) throw new Error('Run CSV or summary was not found');
  if (!targetCycle || !targetPoint) {
    throw new Error('Usage: override-characterization-observations.js <run-directory> <cycle> <point-id>');
  }

  const rows = parseCsv(fs.readFileSync(csvPath, 'utf8'));
  const headers = rows[0];
  const index = Object.fromEntries(headers.map((header, position) => [header, position]));
  const target = `${targetCycle}|${targetPoint}`;
  let changed = 0;
  rows.slice(1).forEach((row) => {
    if (row[index.Event] !== 'OBSERVATION') return;
    const key = `${row[index.CycleNumber]}|${row[index.PointId]}`;
    if (key !== target) return;
    if (String(row[index.Valid]).toLowerCase() !== 'false' && row[index.Outcome] !== 'INVALID') {
      throw new Error(`Target ${target} is not an invalid observation`);
    }
    const originalReason = row[index.InvalidReason] || row[index.Notes] || 'Unspecified acquisition failure';
    row[index.ActualDetected] = 'true';
    row[index.Outcome] = 'UNASSESSED';
    row[index.Valid] = 'true';
    row[index.InvalidReason] = '';
    row[index.Notes] = `MANUAL OVERRIDE ${new Date().toISOString()}: Operator directed this invalid acquisition to be treated as a positive trigger. Original acquisition flag: ${originalReason}`;
    changed++;
  });
  if (changed !== 1) throw new Error(`Expected exactly 1 observation to change; found ${changed}`);

  const backup = `${csvPath}.before-manual-override`;
  if (!fs.existsSync(backup)) fs.copyFileSync(csvPath, backup);
  fs.writeFileSync(csvPath, `${rows.map((row) => row.map(csv).join(',')).join('\r\n')}\r\n`, 'utf8');

  const number = (value) => value === '' ? null : Number(value);
  const boolean = (value) => String(value).toLowerCase() === 'true' ? true : String(value).toLowerCase() === 'false' ? false : null;
  const observations = rows.slice(1).filter((row) => row[index.Event] === 'OBSERVATION').map((row) => ({
    timestamp: row[index.Timestamp],
    cycleNumber: number(row[index.CycleNumber]),
    pointId: row[index.PointId],
    x: number(row[index.X]), y: number(row[index.Y]), z: number(row[index.Z]),
    expectedDetected: boolean(row[index.ExpectedDetected]),
    actualDetected: boolean(row[index.ActualDetected]),
    outcome: row[index.Outcome],
    detectionLatencyMs: number(row[index.DetectionLatencyMs]),
    valid: boolean(row[index.Valid]),
  }));
  const oldSummary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  const calculated = ValidationCore.summarize(observations, null);
  const summaryBackup = `${summaryPath}.before-manual-override`;
  if (!fs.existsSync(summaryBackup)) fs.copyFileSync(summaryPath, summaryBackup);
  fs.writeFileSync(summaryPath, JSON.stringify({
    ...calculated,
    completedAt: oldSummary.completedAt,
    runId: oldSummary.runId,
    testId: oldSummary.testId,
  }, null, 2), 'utf8');
  process.stdout.write(JSON.stringify({ changed, target, csvPath, backup, summaryBackup }, null, 2));
}

main();
