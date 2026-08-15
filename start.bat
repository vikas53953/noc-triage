@echo off
title Mission Control Dashboard
color 0A

echo.
echo  ========================================
echo   Mission Control - AI Agent Dashboard
echo  ========================================
echo.

cd /d "%~dp0"

:: Check if node_modules exists
if not exist "node_modules" (
    echo [*] Installing dependencies...
    call npm install
    echo.
)

echo [*] Starting Mission Control server...
echo [*] Dashboard will open at http://localhost:3000
echo.

:: Start the server and open browser after 2 seconds
start "" cmd /c "timeout /t 2 /nobreak >nul && start http://localhost:3000"

:: Run the server
node server.js

pause
