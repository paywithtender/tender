@echo off
rem Real $0.01 USDG payment: an API built with Coinbase's @x402/express pays out through the live Tender facilitator,
rem paid by the test agent using Coinbase's @x402/fetch. Run deploy-facilitator.bat first.
cd /d "%~dp0e2e\x402"
if not exist node_modules call npm install --no-workspaces
cd /d "%~dp0"
call node --import tsx e2e\x402\mainnet.mts
echo.
pause
