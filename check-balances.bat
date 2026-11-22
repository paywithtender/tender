@echo off
rem Robinhood Chain ETH + USDG balances for any addresses (space-separated)
set /p ADDRS=Addresses to check: 
node "%~dp0e2e\balances.mjs" %ADDRS%
echo.
pause
