'use strict';

// Usage: node tools/generate-single-dut-reference-graph.js input.csv output.svg
const fs = require('fs');
const path = require('path');

const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath) throw new Error('Usage: node tools/generate-single-dut-reference-graph.js input.csv output.svg');

function csvRows(text) {
  const rows = []; let row = []; let field = ''; let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') { field += char; index += 1; }
      else quoted = !quoted;
    } else if (char === ',' && !quoted) { row.push(field); field = ''; }
    else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      row.push(field); if (row.length > 1) rows.push(row); row = []; field = '';
    } else field += char;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [headers, ...data] = rows;
  return data.map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] || ''])));
}

const observations = csvRows(fs.readFileSync(inputPath, 'utf8')).filter((row) => row.Event === 'OBSERVATION');
const points = new Map();
observations.forEach((row) => {
  const x = Number(row.X), y = Number(row.Y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  const key = `${x}|${y}`;
  const point = points.get(key) || { x, y, triggered: 0, notTriggered: 0, invalid: 0 };
  if (row.ActualDetected === 'true') point.triggered += 1;
  else if (row.ActualDetected === 'false') point.notTriggered += 1;
  else point.invalid += 1;
  points.set(key, point);
});

// Match the bottom-left active-points panel exactly; only the CSV data differs.
const W = 496, H = 322, plot = { left: 63, right: 2, top: 20, bottom: 44 };
const bounds = { minX: 33, maxX: 1717, minY: 359, maxY: 1486 };
const dut = { minX: 744, maxX: 1006, minY: 1100, maxY: 1420 };
const innerW = W - plot.left - plot.right, innerH = H - plot.top - plot.bottom;
const sx = (x) => plot.left + (x - bounds.minX) / (bounds.maxX - bounds.minX) * innerW;
const sy = (y) => plot.top + (bounds.maxY - y) / (bounds.maxY - bounds.minY) * innerH;
const esc = (text) => String(text).replace(/[&<>]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[char]));

function frontBand(radius) {
  const left = dut.minX - radius, right = dut.maxX + radius, front = dut.minY - radius;
  return `M ${sx(left).toFixed(1)} ${sy(dut.maxY).toFixed(1)} L ${sx(left).toFixed(1)} ${sy(dut.minY).toFixed(1)} `
    + `Q ${sx(left).toFixed(1)} ${sy(front).toFixed(1)} ${sx(dut.minX).toFixed(1)} ${sy(front).toFixed(1)} `
    + `L ${sx(dut.maxX).toFixed(1)} ${sy(front).toFixed(1)} Q ${sx(right).toFixed(1)} ${sy(front).toFixed(1)} ${sx(right).toFixed(1)} ${sy(dut.minY).toFixed(1)} `
    + `L ${sx(right).toFixed(1)} ${sy(dut.maxY).toFixed(1)}`;
}

const grid = [];
[33, 370, 707, 1043, 1380, 1717].forEach((x) => grid.push(`<line x1="${sx(x)}" y1="${plot.top}" x2="${sx(x)}" y2="${plot.top + innerH}"/><text x="${sx(x)}" y="${H - 17}" text-anchor="middle">${x}</text>`));
[359, 584, 810, 1035, 1261, 1486].forEach((y) => grid.push(`<line x1="${plot.left}" y1="${sy(y)}" x2="${plot.left + innerW}" y2="${sy(y)}"/><text x="${plot.left - 22}" y="${sy(y) + 4}" text-anchor="end">${y}</text>`));

const markers = [...points.values()].map((point) => {
  const x = sx(point.x).toFixed(1), y = sy(point.y).toFixed(1);
  if (point.triggered > point.notTriggered) return `<circle cx="${x}" cy="${y}" r="6.5" class="triggered"/>`;
  if (point.notTriggered > point.triggered) return `<path d="M ${Number(x)-6} ${Number(y)-6} L ${Number(x)+6} ${Number(y)+6} M ${Number(x)+6} ${Number(y)-6} L ${Number(x)-6} ${Number(y)+6}" class="miss"/>`;
  return `<path d="M ${Number(x)} ${Number(y)-7} L ${Number(x)+7} ${Number(y)+7} L ${Number(x)-7} ${Number(y)+7} Z" class="invalid"/>`;
}).join('');

const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <style>
    text { font-family: Segoe UI, Arial, sans-serif; fill: #637089; font-size: 10px; }
    .grid { stroke: rgba(255,255,255,.07); stroke-width: 1; } .axis { stroke: #637089; stroke-width: 1; }
    .dut { fill: rgba(245,158,11,.20); stroke: #f59e0b; stroke-width: 2; } .front { stroke: #22d3ee; stroke-width: 3; }
    .band12 { fill: rgba(0,212,255,.035); stroke: rgba(0,212,255,.9); stroke-width: 1.5; } .band24 { fill: none; stroke: rgba(155,165,180,.65); stroke-width: 1.5; stroke-dasharray: 5 4; }
    .triggered { fill: #00e87b; stroke: #00e87b; } .miss { fill: none; stroke: #ff405c; stroke-width: 2; stroke-linecap: round; }
    .invalid { fill: #69788f; } .label { fill: #fbbf24; font-size: 10px; font-weight: 700; } .title { display: none; }
  </style>
  <rect width="100%" height="100%" fill="#0b1220"/>
  <text x="${plot.left}" y="31" class="title">Crumble Single Known-Working MoreSense Radar — Characterization</text>
  <g class="grid">${grid.join('')}</g>
  <rect x="${plot.left}" y="${plot.top}" width="${innerW}" height="${innerH}" fill="none" class="axis"/>
  <path d="${frontBand(609.6)}" class="band24"/><path d="${frontBand(304.8)}" class="band12"/>
  <rect x="${sx(dut.minX)}" y="${sy(dut.maxY)}" width="${sx(dut.maxX)-sx(dut.minX)}" height="${sy(dut.minY)-sy(dut.maxY)}" class="dut"/>
  <line x1="${sx(dut.minX)}" y1="${sy(dut.minY)}" x2="${sx(dut.maxX)}" y2="${sy(dut.minY)}" class="front"/>
  <text x="${sx(dut.minX)+4}" y="${sy(dut.maxY)-5}" class="label">DUT</text><text x="${sx(875)}" y="${sy(1260)+5}" text-anchor="middle" fill="#f8fafc" font-size="20">+</text>
  <g>${markers}</g>
  <g display="none" transform="translate(${W-306},${H-72})"><line x1="0" y1="0" x2="30" y2="0" class="band12"/><text x="40" y="5" class="key">12 in. DUT-edge reference</text><line x1="0" y1="28" x2="30" y2="28" class="band24"/><text x="40" y="33" class="key">24 in. DUT-edge reference</text></g>
  <text display="none" x="${W / 2}" y="${H - 10}" text-anchor="middle">X position (mm)</text><text display="none" transform="translate(25 ${H / 2}) rotate(-90)" text-anchor="middle">Y position (mm)</text>
</svg>`;

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, svg);
console.log(`Wrote ${outputPath} from ${observations.length} observations across ${points.size} positions.`);
