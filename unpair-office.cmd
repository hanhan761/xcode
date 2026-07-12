@echo off
setlocal EnableExtensions
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\unpair-office.ps1"
set "XCODE_EXIT=%ERRORLEVEL%"
echo.
if not "%XCODE_EXIT%"=="0" echo Unpair stopped with exit code %XCODE_EXIT%.
pause
exit /b %XCODE_EXIT%
