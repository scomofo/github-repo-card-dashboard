@echo off
setlocal

cd /d "%~dp0"

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

start "" http://localhost:8787
node server.mjs
