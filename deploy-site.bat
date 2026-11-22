@echo off
rem Publishes the Tender website to Vercel. Logs in first if needed.
cd /d "%~dp0site"
call npx --yes vercel@latest whoami >nul 2>&1
if errorlevel 1 (
  echo Logging in to Vercel - use the Tender email...
  call npx --yes vercel@latest login
)
call npx --yes vercel@latest deploy --prod
echo.
pause
