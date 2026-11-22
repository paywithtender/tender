@echo off
rem Builds and publishes @paywithtender/sdk to npm (logs in first if needed)
cd /d "%~dp0packages\sdk"
node build-npm.mjs || goto :end
cd npm
call npm whoami >nul 2>&1 || call npm login
call npm publish --access public
:end
echo.
pause
