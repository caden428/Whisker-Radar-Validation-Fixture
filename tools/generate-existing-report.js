'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ValidationCore = require('../validation-core');
const RunNamingCore = require('../run-naming-core');

/** Parses csv. */
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

/** Loads the canonical report builder from the application source for legacy CSV conversion. */
function reportBuilderFromApplication(root) {
  const source = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const start = source.indexOf('function escapeHtml(value)');
  const end = source.indexOf('/** Creates the run folder', start);
  if (start < 0 || end < 0) throw new Error('Could not locate the application report builder');
  const context = {};
  vm.createContext(context);
  vm.runInContext(`${source.slice(start, end)};this.buildReportHtml=buildReportHtml;`, context);
  return context.buildReportHtml;
}

/** Recovers the precise ISO start timestamp embedded in current and legacy run IDs. */
function startedAtFor(manifest, observations) {
  if (manifest.startedAt && Number.isFinite(Date.parse(manifest.startedAt))) return manifest.startedAt;
  const match = String(manifest.runId || '').match(/^run_(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/);
  if (match) return `${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`;
  return observations[0]?.timestamp || new Date().toISOString();
}

/** Implements the main operation for this module. */
function main() {
  const csvPath = path.resolve(process.argv[2] || '');
  if (!fs.existsSync(csvPath)) throw new Error(`CSV not found: ${csvPath}`);
  const sourceDir = path.dirname(csvPath);
  const baseName = path.basename(csvPath, path.extname(csvPath));
  const legacyManifestPath = path.join(sourceDir, `${baseName}.manifest.json`);
  const legacySummaryPath = path.join(sourceDir, `${baseName}.summary.json`);
  const manifestPath = fs.existsSync(legacyManifestPath) ? legacyManifestPath : path.join(sourceDir, 'manifest.json');
  const summaryPath = fs.existsSync(legacySummaryPath) ? legacySummaryPath : path.join(sourceDir, 'summary.json');
  const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : {};
  let summary = fs.existsSync(summaryPath) ? JSON.parse(fs.readFileSync(summaryPath, 'utf8')) : null;
  const rows = parseCsv(fs.readFileSync(csvPath, 'utf8'));
  const headers = rows.shift();
  const records = rows.filter((row) => row.length > 1).map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index] ?? ''])));
  const number = (value) => value === '' ? null : Number(value);
  const boolean = (value) => String(value).toLowerCase() === 'true' ? true : String(value).toLowerCase() === 'false' ? false : null;
  const observations = records.filter((row) => row.Event === 'OBSERVATION').map((row) => ({
    timestamp: row.Timestamp,
    runId: row.RunId,
    testId: row.TestId,
    cycleNumber: number(row.CycleNumber),
    pointId: row.PointId,
    x: number(row.X), y: number(row.Y), z: number(row.Z),
    distanceMm: number(row.DistanceMm),
    expectedDetected: boolean(row.ExpectedDetected),
    actualDetected: boolean(row.ActualDetected),
    outcome: row.Outcome,
    detectionLatencyMs: number(row.DetectionLatencyMs),
    valid: boolean(row.Valid),
  }));
  if (!observations.length) throw new Error('CSV contains no OBSERVATION rows');
  const observedCycles = [...new Set(observations.map((row) => row.cycleNumber).filter(Number.isFinite))];
  const cyclesPlanned = Math.max(1, Math.floor(Number(manifest.cyclesPlanned) || observedCycles.length || 1));
  const firstObservation = observations[0];
  manifest.runId ||= firstObservation.runId;
  manifest.dutId ||= records.find((row) => row.DUTIdentifier)?.DUTIdentifier || '';
  manifest.cyclesPlanned ||= cyclesPlanned;
  manifest.activeSequence ||= 'Legacy characterization CSV';
  manifest.testDefinition ||= { id: firstObservation.testId || 'characterization', name: 'Trigger Zone Characterization' };
  manifest.geometry ||= {};
  if (!summary) {
    const calculated = ValidationCore.summarize(observations, null);
    summary = {
      ...calculated,
      completedAt: observations[observations.length - 1].timestamp || new Date().toISOString(),
    };
  }
  const aggregates = ValidationCore.aggregateByPoint(observations, cyclesPlanned);
  const firstRadarRow = records.find((row) => row.RadarGainCode || row.RadarThreshold);
  if (!manifest.radarSettings && firstRadarRow) {
    const gainCode = /^0x/i.test(firstRadarRow.RadarGainCode || '')
      ? Number.parseInt(firstRadarRow.RadarGainCode, 16) : number(firstRadarRow.RadarGainCode);
    const threshold = number(firstRadarRow.RadarThreshold);
    const verifiedPair = boolean(firstRadarRow.RadarSettingsVerified) === true;
    const sensor = { online: true, verified: verifiedPair, gainCode, threshold };
    manifest.radarSettings = { verifiedPair, sensors: { A: sensor, B: { ...sensor } } };
  }
  const proposedBaseName = RunNamingCore.buildRunBase(manifest, startedAtFor(manifest, observations));
  const currentBaseName = path.basename(sourceDir);
  const alreadyUsesProposedName = currentBaseName === proposedBaseName
    || new RegExp(`^${proposedBaseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_\\d+$`).test(currentBaseName);
  const outputBaseName = alreadyUsesProposedName
    ? currentBaseName
    : RunNamingCore.uniqueRunBase(proposedBaseName, (candidate) => fs.existsSync(path.join(sourceDir, candidate)));
  const destination = path.basename(sourceDir) === outputBaseName ? sourceDir : path.join(sourceDir, outputBaseName);
  fs.mkdirSync(destination, { recursive: true });
  const observationsTarget = path.join(destination, 'observations.csv');
  if (path.resolve(csvPath) !== path.resolve(observationsTarget)) fs.copyFileSync(csvPath, observationsTarget);
  fs.writeFileSync(path.join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  fs.writeFileSync(path.join(destination, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');
  const report = {
    completedAt: summary.completedAt,
    runId: manifest.runId,
    testId: manifest.testDefinition?.id || 'characterization',
    testName: manifest.testDefinition?.id === 'inside' ? 'Test 10.1 — Inside Detection Validation'
      : manifest.testDefinition?.id === 'outside' ? 'Test 10.2 — Outside Boundary Validation'
        : manifest.testDefinition?.name || 'Trigger Zone Characterization',
    dutId: manifest.dutId,
    cyclesPlanned,
    result: ['inside', 'outside'].includes(manifest.testDefinition?.id) ? (summary.accepted ? 'PASS' : 'FAIL') : 'COMPLETE',
    reason: ['inside', 'outside'].includes(manifest.testDefinition?.id)
      ? `${summary.correct}/${summary.assessed} correct (${summary.correctRate == null ? '—' : (summary.correctRate * 100).toFixed(1) + '%'}), ${summary.counts?.FP || 0} FP, ${summary.counts?.FN || 0} FN, ${summary.counts?.INVALID || 0} invalid`
      : `Characterization complete — ${observations.length} raw trigger measurements captured`,
    durationMs: records.length ? number(records[records.length - 1].ElapsedMs) : null,
    geometry: manifest.geometry,
    radarSettings: manifest.radarSettings || null,
    boundary: ['inside', 'outside'].includes(manifest.testDefinition?.id) ? ValidationCore.manualLobeBoundary(manifest.geometry) : [],
    observations,
    aggregates,
    summary,
  };
  const buildReportHtml = reportBuilderFromApplication(path.resolve(__dirname, '..'));
  const outputPath = path.join(destination, 'report.html');
  fs.writeFileSync(outputPath, buildReportHtml(report), 'utf8');
  process.stdout.write(JSON.stringify({ outputPath, observations: observations.length, triggered: observations.filter((row) => row.actualDetected).length, missed: observations.filter((row) => !row.actualDetected).length }, null, 2));
}

main();
