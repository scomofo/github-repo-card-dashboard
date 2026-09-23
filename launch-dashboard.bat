@echo off
setlocal

cd /d "%~dp0"

if "%PORT%"=="" set "PORT=8787"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required for chat commands.
  echo Install it from https://nodejs.org/ and run this launcher again.
  pause
  exit /b 1
)

if not exist "server.mjs" (
  echo Could not find server.mjs next to this launcher.
  pause
  exit /b 1
)

if "%OPENAI_API_KEY%"=="" (
  echo OPENAI_API_KEY is not set.
  echo Chat will still understand a few basic read-only commands, but OpenAI parsing will be disabled.
  echo.
  set /p OPENAI_API_KEY=Paste OpenAI API key for this session, or press Enter to skip: 
)

set "HEALTH_URL=http://127.0.0.1:%PORT%/api/health"

start "Repo Dashboard" node server.mjs

rem Wait for the server to answer /api/health before opening the browser.
for /l %%i in (1,1,30) do (
  curl -fsS "%HEALTH_URL%" >nul 2>nul && goto :open
  powershell -NoProfile -Command "try { $null = Invoke-WebRequest -UseBasicParsing '%HEALTH_URL%' -TimeoutSec 2; exit 0 } catch { exit 1 }" >nul 2>nul && goto :open
  timeout /t 1 /nobreak >nul
)

echo The dashboard server did not become ready on port %PORT%.
echo Check the "Repo Dashboard" window for errors, then close this window.
pause
exit /b 1

:open
start "" "http://127.0.0.1:%PORT%/"
