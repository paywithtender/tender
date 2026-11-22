@echo off
rem Real $0.01 payment in USDG from the test agent, through Tender, on Robinhood Chain.
cd /d "%~dp0packages\facilitator"
set PAY_WITH=
call node --env-file=.env --import tsx ..\..\e2e\mainnet-pay.ts
echo.
pause
