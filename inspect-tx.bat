@echo off
set /p TX=Transaction hash: 
node "%~dp0e2e\inspect-tx.mjs" %TX%
echo.
pause
