@echo off
rem Test agent buys a token with 0.0005 ETH on Robinhood Chain (Uniswap)
cd /d "%~dp0packages\facilitator"
set /p TOKEN_OUT=Token contract address to buy: 
set AMOUNT_ETH=0.0005
call node --env-file=.env --import tsx ..\..\e2e\agent-swap.ts
echo.
pause
