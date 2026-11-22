@echo off
rem Finds Uniswap's router for Robinhood Chain and allowlists it on the Tender contract (owner wallet signs).
cd /d "%~dp0packages\facilitator"
set TOKEN=0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73
if exist data\router.txt del data\router.txt
call node --env-file=.env --import tsx scripts\find-router.ts
if not exist data\router.txt (
  echo.
  echo Could not get the router from Uniswap. Check UNISWAP_API_KEY in packages\facilitator\.env
  pause
  exit /b 1
)
set /p ROUTER=<data\router.txt
cd /d "%~dp0contracts"
set ACTION=set-router
set PERMIT2_MODE=false
call npx hardhat run scripts\admin.js --network robinhood
echo.
echo Router %ROUTER% allowlisted.
pause
