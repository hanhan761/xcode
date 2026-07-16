@echo off
setlocal EnableExtensions
call "%~dp0xcode.cmd" office
if errorlevel 1 goto done
call "%~dp0xcode.cmd" pair
:done
set "XCODE_EXIT=%ERRORLEVEL%"
echo.
if not "%XCODE_EXIT%"=="0" echo Office-laptop setup stopped with exit code %XCODE_EXIT%.
pause
exit /b %XCODE_EXIT%
