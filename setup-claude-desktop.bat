@echo off
rem Adds the Tender MCP server to Claude Desktop with the test agent wallet (pays in $TENDER, $0.50/day limit)
cd /d "%~dp0"
call node scripts\setup-claude-desktop.mjs
echo.
pause
