@echo off
rem Test agent swaps ETH for about $2 of USDG (0.0013 ETH) on Robinhood Chain (Uniswap)
cd /d "%~dp0packages\facilitator"
set TOKEN_OUT=
call node --env-file=.env --import tsx ..\..\e2e\agent-swap.ts
echo.
pause
