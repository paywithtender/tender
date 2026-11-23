@echo off
rem Builds and publishes @paywithtender/mcp to npm (logs in first if needed)
cd /d "%~dp0packages\mcp"
call npm install --no-workspaces
call npx tsc -p tsconfig.json || goto :end
call npm whoami >nul 2>&1 || call npm login
call npm publish --access public
:end
echo.
pause
