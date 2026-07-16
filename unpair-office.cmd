@echo off
setlocal EnableExtensions
call "%~dp0xcode.cmd" unpair
set "XCODE_EXIT=%ERRORLEVEL%"
echo.
if not "%XCODE_EXIT%"=="0" echo Unpair stopped with exit code %XCODE_EXIT%.
pause
exit /b %XCODE_EXIT%
