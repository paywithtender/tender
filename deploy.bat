@echo off
cd /d "%~dp0contracts"
call npx hardhat run scripts\deploy.js --network robinhood
echo.
pause
