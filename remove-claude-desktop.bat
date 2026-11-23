@echo off
rem Removes the Tender MCP server from Claude Desktop
cd /d "%~dp0"
call node scripts\setup-claude-desktop.mjs --remove
echo.
pause
