@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"

echo ================================================================
echo   Radar Validation Fixture - Windows Build
echo ================================================================
echo.

rem 1. Find or download portable Node.js.
set "NODE_VER=v20.17.0"
set "NODE_DIR=%~dp0_build_node\node-%NODE_VER%-win-x64"
set "NODE_EXE=%NODE_DIR%\node.exe"

where node >nul 2>&1
if not errorlevel 1 (
    for /f "tokens=*" %%v in ('node --version 2^>nul') do set "NODEVER=%%v"
    echo [OK] Node.js !NODEVER! on PATH
    goto :run_build
)

if exist "%NODE_EXE%" (
    echo [OK] Using cached portable Node.js %NODE_VER%
    set "PATH=%NODE_DIR%;%PATH%"
    goto :run_build
)

echo [INFO] Node.js not found. Downloading portable Node.js %NODE_VER%...
echo        This is a one-time download of approximately 18 MB.
echo.
set "NODE_ZIP=%TEMP%\node_%NODE_VER%_win_x64.zip"
set "NODE_URL=https://nodejs.org/dist/%NODE_VER%/node-%NODE_VER%-win-x64.zip"

powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-WebRequest '%NODE_URL%' -OutFile '%NODE_ZIP%'"
if errorlevel 1 (
    echo [ERROR] Download failed. Check the internet connection.
    pause
    exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -Path '%NODE_ZIP%' -DestinationPath '%~dp0_build_node' -Force"
if errorlevel 1 (
    echo [ERROR] Node.js extraction failed.
    pause
    exit /b 1
)

set "PATH=%NODE_DIR%;%PATH%"
echo [OK] Portable Node.js %NODE_VER% ready
echo.

:run_build
echo [INFO] Building the Windows installer...
echo.

node node_modules\electron-builder\cli.js --win --publish never
if errorlevel 1 (
    echo.
    echo [ERROR] Build failed. Review the output above.
    pause
    exit /b 1
)

for /f "usebackq delims=" %%v in (`node -p "require('./package.json').version"`) do set "APP_VERSION=%%v"
set "INSTALLER=%~dp0dist\Radar Validation Fixture Setup !APP_VERSION!.exe"

if not exist "!INSTALLER!" (
    echo.
    echo [ERROR] Builder completed but the expected installer was not found:
    echo         !INSTALLER!
    pause
    exit /b 1
)

for %%f in ("!INSTALLER!") do (
    set /a "MB=%%~zf / 1048576"
    echo.
    echo ================================================================
    echo   Build complete
    echo   File: %%~nxf
    echo   Size: !MB! MB
    echo   Path: %%~ff
    echo ================================================================
)
echo.
echo Hand this installer to the end user.
pause
exit /b 0
