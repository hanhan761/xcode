@echo off
setlocal EnableExtensions
call "%~dp0xcode.cmd" main
set "XCODE_EXIT=%ERRORLEVEL%"
echo.
if not "%XCODE_EXIT%"=="0" echo Main-PC setup stopped with exit code %XCODE_EXIT%.
pause
exit /b %XCODE_EXIT%
