@echo off
rem The test agent pays Tender's live paid API ($0.01) through the MCP server, in any token.
cd /d "%~dp0"
set /p PAY_WITH=Token to pay with (press Enter for USDG): 
echo 1 = /api/gas    2 = /api/token (price of the token you pay with)
set /p WHICH=Which endpoint (1 or 2): 
set PAY_URL=https://facilitator.paywithtender.com/api/gas
if "%WHICH%"=="2" set PAY_URL=https://facilitator.paywithtender.com/api/token?address=%PAY_WITH%
call node --import tsx e2e\mcp-mainnet.mts
echo.
pause
