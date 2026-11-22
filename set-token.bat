@echo off
rem Launch day: shows the $TENDER CA on the site, redeploys it, and makes $TENDER fee-free on the contract.
cd /d "%~dp0"
set /p CA=$TENDER contract address: 
set /p BUY=Buy link (Pons page, or press Enter to skip): 
node site\set-token.mjs %CA% %BUY% || goto :end
cd site
call npx --yes vercel@latest deploy --prod
cd ..\contracts
echo Making $TENDER fee-free on the contract (owner wallet signs)...
set ACTION=fee-exempt
set TOKEN=%CA%
set EXEMPT=true
call npx hardhat run scripts\admin.js --network robinhood
:end
echo.
pause
