@echo off
rem Connects facilitator.paywithtender.com to the Fly app
fly certs add facilitator.paywithtender.com --app paywithtender-facilitator
echo.
echo ---- current status ----
fly certs show facilitator.paywithtender.com --app paywithtender-facilitator
echo.
pause
