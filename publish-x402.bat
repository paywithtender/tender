@echo off
rem Builds and publishes @paywithtender/x402 to npm (logs in first if needed)
cd /d "%~dp0packages\x402"
call npm install --no-workspaces
call npx tsc -p tsconfig.json || goto :end
call npm whoami >nul 2>&1 || call npm login
call npm publish --access public
:end
echo.
pause
