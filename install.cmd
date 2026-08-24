@echo off
REM Radar Validation Fixture - First-Time Setup
REM Installs Electron + electron-builder. No native/serial dependencies are
REM required — the app talks to the fixture over HTTP (Moonraker API), so a
REM plain "npm install" is all that's needed.

cd /d "%~dp0"

where npm >nul 2>&1
if %errorlevel% neq 0 (
    echo ERROR: Node.js/npm not found on PATH.
    echo Install Node.js from https://nodejs.org/ then re-run this script.
    pause
    exit /b 1
)

echo Installing dependencies...
call npm install
if %errorlevel% neq 0 (
    echo.
    echo ERROR: npm install failed - see output above.
    pause
    exit /b 1
)

if not exist "node_modules\electron\dist\electron.exe" (
    echo.
    echo ERROR: Electron's required install script did not produce its runtime.
    echo The project allows only the pinned Electron 28.3.3 install script.
    echo Re-run install.cmd from this project folder.
    pause
    exit /b 1
)

echo.
echo Setup complete. Run launch.cmd to start the app.
pause
