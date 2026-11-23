@echo off
rem Real $0.01 payment through the live Tender facilitator, made with Coinbase's stock x402 SDKs.
rem Press Enter to pay in USDG (standard exact), or paste a token address to pay in that token via @paywithtender/x402.
cd /d "%~dp0e2e\x402"
if not exist node_modules call npm install --no-workspaces
cd /d "%~dp0packages\x402"
if not exist node_modules call npm install --no-workspaces
cd /d "%~dp0"
set PAY_WITH=
set /p PAY_WITH=Token to pay with (press Enter for USDG): 
call node --import tsx e2e\x402\mainnet.mts
echo.
pause
