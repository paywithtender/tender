@echo off
rem Lists staged npm versions and approves one (asks for 2FA)
call npm stage list @paywithtender/sdk
echo.
set /p SID=Paste the id shown above and press Enter: 
call npm stage approve %SID%
echo.
pause
