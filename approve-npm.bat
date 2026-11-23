@echo off
rem Lists staged npm versions of a Tender package and approves one (asks for 2FA)
set /p PKG=Package (sdk or mcp): 
call npm stage list @paywithtender/%PKG%
echo.
set /p SID=Paste the id shown above and press Enter: 
call npm stage approve %SID%
echo.
pause
