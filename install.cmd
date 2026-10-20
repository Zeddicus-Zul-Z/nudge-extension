@echo off
rem Groundworks Nudge: one-step install on Windows (per user, no admin rights).
rem Runs the native host installer, the bridge dependency install and the agent
rem setup in order, and stops at the first failure.
rem
rem Usage, from PowerShell or cmd in the cloned repository:
rem   .\install.cmd                   install or repair
rem   .\install.cmd <extension-id>    when chrome://extensions shows a different id
rem   .\install.cmd --uninstall       remove what the installers added, keep the store
rem   --dry-run                       plan the registry calls instead of writing them
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo error: Node.js 22 or newer is required and node is not on PATH: https://nodejs.org
  exit /b 1
)

set "UNINSTALL="
for %%a in (%*) do if /i "%%~a"=="--uninstall" set "UNINSTALL=1"

if defined UNINSTALL (
  node bridge\install-native-host.mjs %*
  if errorlevel 1 exit /b 1
  node agent\setup-agent.mjs --uninstall
  if errorlevel 1 exit /b 1
  echo.
  echo Last step: remove the Groundworks Nudge card in chrome://extensions.
  exit /b 0
)

echo [1/3] Native messaging host
node bridge\install-native-host.mjs %*
if errorlevel 1 exit /b 1

echo.
echo [2/3] Bridge dependencies
call npm install --prefix bridge --no-audit --no-fund --prefer-offline
if errorlevel 1 exit /b 1

echo.
echo [3/3] Skill, hooks and the groundworks-nudge command
node agent\setup-agent.mjs
if errorlevel 1 exit /b 1

echo.
echo Last step, in Chrome: open chrome://extensions, switch on Developer mode,
echo click Load unpacked and select this folder:
echo   %~dp0extension
echo The card must show the extension id printed in step 1.
exit /b 0
