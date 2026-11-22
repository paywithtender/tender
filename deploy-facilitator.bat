@echo off
rem Deploys the Tender facilitator to Fly.io (Tender account). Safe to run again for updates.
cd /d "%~dp0"
call fly apps list | findstr /C:"paywithtender-facilitator" >nul
if errorlevel 1 (
  echo Creating app...
  call fly apps create paywithtender-facilitator
  call fly volumes create tender_data --region iad --size 1 --app paywithtender-facilitator --yes
)
echo Setting secrets (relayer key + Uniswap key only)...
findstr /B /C:"RELAYER_PRIVATE_KEY=" /C:"UNISWAP_API_KEY=" packages\facilitator\.env | fly secrets import --stage --app paywithtender-facilitator
echo Deploying...
call fly deploy --app paywithtender-facilitator --ha=false
echo.
echo Health check:
curl -s https://paywithtender-facilitator.fly.dev/healthz
echo.
pause
