@echo off
REM Radar Validation Fixture - Launcher

cd /d "%~dp0"

set "ELECTRON=node_modules\electron\dist\electron.exe"
REM Prevent a machine-level developer variable from turning Electron into a
REM command-line Node process instead of launching the desktop application.
set "ELECTRON_RUN_AS_NODE="

if not exist "%ELECTRON%" (
    echo ERROR: Electron not found. Run install.cmd first.
    echo.
    echo   install.cmd
    echo.
    pause
    exit /b 1
)

"%ELECTRON%" .
