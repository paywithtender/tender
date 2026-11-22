@echo off
rem Connects paywithtender.com and www.paywithtender.com to the Vercel project
cd /d "%~dp0site"
call npx --yes vercel@latest domains add paywithtender.com paywithtender
call npx --yes vercel@latest domains add www.paywithtender.com paywithtender
echo.
pause
