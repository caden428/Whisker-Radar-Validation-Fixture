'use strict';

const fs = require('fs');
const path = require('path');
const CampaignCore = require('../campaign-core');
const CampaignLedger = require('../campaign-ledger');

function main() {
  const logsDirectory = path.resolve(process.argv[2] || '');
  const reportFolder = path.resolve(process.argv[3] || '');
  const paths = CampaignLedger.pathsFor(logsDirectory);
  const html = fs.readFileSync(path.join(reportFolder, 'report.html'), 'utf8');
  const match = html.match(/<script>const R=([\s\S]*?);\s*const RAW=R\.observations/);
  if (!match) throw new Error('Unable to extract report payload');
  const report = JSON.parse(match[1]);
  const record = CampaignCore.buildCampaignRecord({ report, completedAt: report.completedAt, reportFolder });
  if (!record.clean) throw new Error('Corrected report is not a clean campaign record');

  const rows = CampaignLedger.parseCsv(fs.readFileSync(paths.history, 'utf8'));
  const headers = rows.shift();
  const idIndex = headers.indexOf('RecordId');
  const target = rows.findIndex((row) => row[idIndex] === record.recordId);
  if (target < 0) throw new Error(`Ledger record ${record.recordId} was not found`);
  const backup = `${paths.history}.before-manual-override`;
  if (!fs.existsSync(backup)) fs.copyFileSync(paths.history, backup);
  rows[target] = CampaignCore.recordToRow(record);
  CampaignLedger.atomicWrite(paths.history,
    CampaignLedger.csvLine(headers) + rows.map((row) => CampaignLedger.csvLine(row)).join(''));

  const complete = rows.filter((row) => row[headers.indexOf('Status')] === 'COMPLETE');
  const latest = new Map();
  complete.forEach((row) => latest.set(row[headers.indexOf('CampaignKey')], row));
  CampaignLedger.atomicWrite(paths.current,
    CampaignLedger.csvLine(headers) + [...latest.values()].map((row) => CampaignLedger.csvLine(row)).join(''));
  process.stdout.write(JSON.stringify({ recordId: record.recordId, status: record.status, backup }, null, 2));
}

main();
