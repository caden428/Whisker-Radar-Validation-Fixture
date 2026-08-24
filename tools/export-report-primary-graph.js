'use strict';

const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');

async function main() {
  const reportPath = path.resolve(process.argv[2] || '');
  const outputPath = path.resolve(process.argv[3] || '');
  if (!fs.existsSync(reportPath) || !outputPath) throw new Error('Usage: electron export-report-primary-graph.js <report.html> <output.png>');
  const window = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  try {
    await window.loadFile(reportPath);
    const dataUrl = await window.webContents.executeJavaScript(`
      new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => {
        const canvas = document.getElementById('repeatability') || document.getElementById('spatial');
        if (!canvas) return resolve('');
        const context = canvas.getContext('2d');
        context.save();
        context.globalCompositeOperation = 'destination-over';
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.restore();
        resolve(canvas.toDataURL('image/png'));
      })))
    `);
    const image = nativeImage.createFromDataURL(dataUrl);
    if (image.isEmpty()) throw new Error('The report did not produce a primary results graph');
    const sheetImage = image.getSize().width > 1300 ? image.resize({ width: 1300, quality: 'best' }) : image;
    fs.writeFileSync(outputPath, sheetImage.toPNG());
    process.stdout.write(outputPath);
  } finally {
    if (!window.isDestroyed()) window.destroy();
  }
}

app.whenReady().then(main).then(() => app.quit()).catch((error) => {
  process.stderr.write(String(error?.stack || error));
  app.exit(1);
});
