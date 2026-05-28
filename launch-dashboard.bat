@echo off
setlocal

set "DASHBOARD=%~dp0index.html"

if not exist "%DASHBOARD%" (
  echo Could not find index.html next to this launcher.
  echo Expected: "%DASHBOARD%"
  pause
  exit /b 1
)

start "" "%DASHBOARD%"
