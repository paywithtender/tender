@echo off
rem Lists @paywithtender/mcp in the official MCP Registry (registry.modelcontextprotocol.io).
rem Run publish-mcp.bat first so version 0.1.1 is on npm.
rem Uses mcp-publisher, the official tool from github.com/modelcontextprotocol/registry.
cd /d "%~dp0packages\mcp"
if not exist mcp-publisher.exe (
  echo Downloading mcp-publisher from github.com/modelcontextprotocol/registry ...
  powershell -NoProfile -Command "$arch = if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -eq 'Arm64') { 'arm64' } else { 'amd64' }; Invoke-WebRequest -Uri ('https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_windows_' + $arch + '.tar.gz') -OutFile mcp-publisher.tar.gz"
  tar xf mcp-publisher.tar.gz mcp-publisher.exe
  del mcp-publisher.tar.gz
)
echo.
echo Sign in as paywithtender when GitHub asks. Open the link it prints and enter the code.
echo.
mcp-publisher.exe login github || goto :end
mcp-publisher.exe publish
:end
echo.
pause
