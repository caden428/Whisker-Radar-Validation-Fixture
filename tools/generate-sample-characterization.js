'use strict';

const fs = require('fs');
const path = require('path');

const outputPath = path.resolve(process.argv[2] || 'characterization_6_cycle_30_point_example.csv');
const startedAt = new Date('2026-07-23T18:30:00.123Z');
const runId = 'run_2026-07-23T18-30-00-123Z';
const dutId = 'Aqua Format Example';
const cycles = 6;
const gainCode = '0x53';
const threshold = 100;
const headers = [
  'Timestamp','ElapsedMs','RunId','TestId','TestVersion','DUTIdentifier','CycleNumber',
  'PointId','PositionIndex','AttemptNumber','X','Y','Z','DistanceMm','Zone',
  'ExpectedDetected','ActualDetected','Outcome','Valid','InvalidReason','Event',
  'MoveDurationMs','TriggerSentMs','DetectionLatencyMs','DefinitionFile','SoftwareRevision',
  'RadarGainCode','RadarThreshold','RadarSettingsVerified','Notes',
];

function csv(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

const points = [];
for (let row = 0; row < 5; row++) {
  for (let column = 0; column < 6; column++) {
    const x = 500 + column * 120;
    const y = 420 + row * 120;
    const distance = Math.hypot(x - 800, y - 660);
    const desiredTriggers = Math.max(0, Math.min(cycles, 6 - Math.floor(distance / 90)));
    points.push({ x, y, distance, desiredTriggers });
  }
}

const lines = [headers.join(',')];
let observationNumber = 0;
for (let cycle = 1; cycle <= cycles; cycle++) {
  points.forEach((point, index) => {
    observationNumber++;
    const rotatedCycle = ((cycle + index * 2) % cycles) + 1;
    const triggered = rotatedCycle <= point.desiredTriggers;
    const elapsedMs = observationNumber * 1850;
    const timestamp = new Date(startedAt.getTime() + elapsedMs).toISOString();
    const latency = triggered ? Math.round(115 + point.distance * 0.18 + ((cycle * 17 + index * 11) % 55)) : '';
    const values = [
      csv(timestamp), elapsedMs, csv(runId), csv('characterization'), 2, csv(dutId), cycle,
      csv(`characterization-${String(index + 1).padStart(3, '0')}`), index + 1, 1,
      point.x, point.y, 0, point.distance.toFixed(3), csv('characterization'),
      '', triggered ? 'true' : 'false', csv('UNASSESSED'), 'true', csv(''), csv('OBSERVATION'),
      1200 + ((index * 37) % 240), elapsedMs - 500, latency, '', csv(''), csv('0.4.2'),
      csv(gainCode), threshold, 'true', csv(triggered ? 'Radar triggered' : 'Radar timeout'),
    ];
    lines.push(values.join(','));
  });
}

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${lines.join('\n')}\n`, 'utf8');
process.stdout.write(JSON.stringify({ outputPath, cycles, points: points.length, observations: observationNumber }, null, 2));
