@echo off
rem Runs the paywithtender.com/try payment ($0.01 to /api/gas) with the test agent wallet, in any coin.
cd /d "%~dp0"
echo 1 = USDG    2 = $TENDER    3 = paste another coin
set /p CHOICE=Pay with (1, 2 or 3):
set PAY_WITH=
if "%CHOICE%"=="2" set PAY_WITH=0xda4a075417d613ec018c8959fea6ab5ac5d5b78c
if "%CHOICE%"=="3" set /p PAY_WITH=Coin contract address:
call node --import tsx e2e\try-mainnet.mts
echo.
pause
