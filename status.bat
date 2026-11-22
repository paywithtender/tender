@echo off
cd /d "%~dp0contracts"
call npx hardhat run scripts\admin.js --network robinhood
echo.
pause
