'use strict';

const fs = require('fs');
const path = require('path');
const CampaignCore = require('./campaign-core');

function csvCell(value) {
  return `"${String(value == null ? '' : value).replace(/"/g, '""')}"`;
}

function csvLine(values) {
  return values.map(csvCell).join(',') + '\n';
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (quoted && character === '"' && text[index + 1] === '"') {
      cell += '"';
      index++;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (!quoted && character === ',') {
      row.push(cell);
      cell = '';
    } else if (!quoted && (character === '\n' || character === '\r')) {
      if (character === '\r' && text[index + 1] === '\n') index++;
      row.push(cell);
      if (row.some((value) => value !== '')) rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += character;
    }
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function atomicWrite(filePath, content) {
  const temporary = `${filePath}.tmp`;
  fs.writeFileSync(temporary, content, 'utf8');
  fs.renameSync(temporary, filePath);
}

function safeCampaignId(value) {
  return String(value || '').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

function pathsFor(logsDirectory, campaignId = '') {
  const root = path.join(logsDirectory, 'campaigns');
  const id = safeCampaignId(campaignId);
  const directory = id ? path.join(root, id) : root;
  return {
    directory,
    history: path.join(directory, 'campaign-history.csv'),
    current: path.join(directory, 'campaign-current.csv'),
  };
}

function ensureLedger(logsDirectory, campaignId = '') {
  const paths = pathsFor(logsDirectory, campaignId);
  fs.mkdirSync(paths.directory, { recursive: true });
  if (!fs.existsSync(paths.history)) {
    fs.writeFileSync(paths.history, csvLine(CampaignCore.HISTORY_COLUMNS), 'utf8');
  } else {
    migrateColumns(paths.history);
  }
  if (!fs.existsSync(paths.current)) {
    fs.writeFileSync(paths.current, csvLine(CampaignCore.HISTORY_COLUMNS), 'utf8');
  } else {
    migrateColumns(paths.current);
  }
  return paths;
}

function migrateColumns(filePath) {
  const rows = parseCsv(fs.readFileSync(filePath, 'utf8'));
  const headers = rows.shift() || [];
  if (headers.length === CampaignCore.HISTORY_COLUMNS.length
      && headers.every((header, index) => header === CampaignCore.HISTORY_COLUMNS[index])) return;
  const migrated = rows.map((row) => {
    const record = Object.fromEntries(headers.map((header, index) => [header, row[index] || '']));
    return CampaignCore.HISTORY_COLUMNS.map((column) => record[column] || '');
  });
  atomicWrite(filePath, csvLine(CampaignCore.HISTORY_COLUMNS)
    + migrated.map((row) => csvLine(row)).join(''));
}

function readHistory(paths) {
  const rows = parseCsv(fs.readFileSync(paths.history, 'utf8'));
  const headers = rows.shift() || [];
  return rows.map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index] || ''])));
}

function writeCurrent(paths, history) {
  const latest = new Map();
  history.filter((record) => ['COMPLETE', 'PASS', 'FAIL'].includes(String(record.Status).toUpperCase())).forEach((record) => {
    latest.set(record.ConditionId || record.CampaignKey, record);
  });
  const content = csvLine(CampaignCore.HISTORY_COLUMNS)
    + [...latest.values()].map((record) => csvLine(CampaignCore.HISTORY_COLUMNS.map((column) => record[column] || ''))).join('');
  atomicWrite(paths.current, content);
}

function recordCampaign(logsDirectory, input) {
  const paths = ensureLedger(logsDirectory, input.campaignId);
  const existing = readHistory(paths);
  const preview = CampaignCore.buildCampaignRecord(input);
  const priorAttempts = existing.filter((record) => preview.conditionId
    ? record.ConditionId === preview.conditionId
    : record.CampaignKey === preview.campaignKey).length;
  const record = CampaignCore.buildCampaignRecord({ ...input, retryNumber: priorAttempts });
  if (existing.some((item) => item.RecordId === record.recordId)) {
    return { record, duplicate: true, paths };
  }
  fs.appendFileSync(paths.history, csvLine(CampaignCore.recordToRow(record)), 'utf8');
  const updated = readHistory(paths);
  writeCurrent(paths, updated);
  return { record, duplicate: false, paths };
}

function getStatus(logsDirectory, campaignId = '') {
  const paths = ensureLedger(logsDirectory, campaignId);
  return {
    paths,
  };
}

module.exports = {
  csvCell, csvLine, parseCsv, atomicWrite, safeCampaignId, pathsFor, ensureLedger,
  recordCampaign, getStatus,
};
