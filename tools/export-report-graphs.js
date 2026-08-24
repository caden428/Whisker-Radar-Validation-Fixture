'use strict';

const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');

async function run() {
  const reportPath = process.argv[2];
  if (!reportPath || !fs.existsSync(reportPath)) throw new Error('Pass an existing report.html path');
  const outputDirectory = path.dirname(reportPath);
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  try {
    await window.loadFile(reportPath);
    const images = await window.webContents.executeJavaScript(`
      new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => {
        const prepareForSheets = (canvas) => {
          if (!canvas) return;
          const context = canvas.getContext('2d');
          context.save();
          context.globalCompositeOperation = 'destination-over';
          context.fillStyle = '#ffffff';
          context.fillRect(0, 0, canvas.width, canvas.height);
          context.restore();
          const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
          for (let index = 0; index < pixels.data.length; index += 4) {
            const red = pixels.data[index], green = pixels.data[index + 1], blue = pixels.data[index + 2];
          if (
            red > 125
            && green > 135
            && blue > 145
            && blue - red >= 12
            && blue - green >= 5
          ) {
              pixels.data[index] = 31;
              pixels.data[index + 1] = 50;
              pixels.data[index + 2] = 64;
            }
          }
          context.putImageData(pixels, 0, 0);
        };
        const image = (id) => {
          const canvas = document.getElementById(id);
          prepareForSheets(canvas);
          return canvas ? canvas.toDataURL('image/png') : '';
        };
        resolve({ repeatability: image('repeatability'), latency: image('latency') });
      })))
    `);
    const written = {};
    for (const [name, dataUrl] of Object.entries(images || {})) {
      if (!dataUrl) continue;
      const image = nativeImage.createFromDataURL(dataUrl);
      const filePath = path.join(outputDirectory, `${name}.png`);
      const sheetImage = image.getSize().width > 1300 ? image.resize({ width: 1300, quality: 'best' }) : image;
      fs.writeFileSync(filePath, sheetImage.toPNG());
      written[name] = filePath;
    }
    process.stdout.write(JSON.stringify(written));
  } finally {
    window.destroy();
  }
}

app.whenReady().then(run).then(() => app.quit()).catch((error) => {
  process.stderr.write(String(error?.stack || error));
  app.exit(1);
});
