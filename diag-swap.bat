@echo off
rem Read-only: shows why a token's swap fails inside Tender (sends no transactions)
cd /d "%~dp0packages\facilitator"
set /p TOKEN=Token contract address: 
call node --env-file=.env --import tsx ..\..\e2e\diag-swap.mts
echo.
pause
