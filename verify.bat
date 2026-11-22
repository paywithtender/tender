@echo off
rem Verifies TenderSettlement source code on the Robinhood Chain explorer (Blockscout)
cd /d "%~dp0contracts"
call npx hardhat verify --network robinhood 0x7A93fE8C092b1929d6FFe5085b3619B9071b97C4 0x6b9897f462edaf27b6F90dE6b595EEd8b776A725 0x000000000022D473030F116dDEE9F6B43aC78BA3 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168 0x825048c08556E5B2a9BDaF28200b13C2A02caf99
echo.
pause
