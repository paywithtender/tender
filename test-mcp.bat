@echo off
rem Real mainnet test of the Tender MCP server: the test agent pays a $0.01 demo API through the live facilitator.
cd /d "%~dp0packages\mcp"
if not exist node_modules call npm install --no-workspaces
cd /d "%~dp0"
set /p PAY_WITH=Token to pay with (press Enter for USDG): 
call node --import tsx e2e\mcp-mainnet.mts
echo.
pause
