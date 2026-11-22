@echo off
cd /d "%~dp0"
if not exist node_modules (
  echo Installing packages, this takes a couple of minutes...
  call npm install
)
cd contracts
node scripts\new-wallets.js
pause
