@echo off
rem Real $0.01 payment in any token from the test agent, swapped to USDG through Tender.
cd /d "%~dp0packages\facilitator"
set /p PAY_WITH=Token contract address to pay with: 
call node --env-file=.env --import tsx ..\..\e2e\mainnet-pay.ts
echo.
pause
