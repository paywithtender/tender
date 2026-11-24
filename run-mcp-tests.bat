@echo off
rem Runs the MCP server's end-to-end tests on a local chain (no real money), including the daily-limit-after-restart check.
cd /d "%~dp0"
call npm run test:mcp
echo.
pause
