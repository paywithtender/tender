@echo off
cd /d "%~dp0contracts"
call npx hardhat run scripts\accept-ownership.js --network robinhood
echo.
pause
