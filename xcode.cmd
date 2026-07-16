@echo off
setlocal EnableExtensions
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\xcode.ps1" -RepositoryRoot "%~dp0" %*
exit /b %ERRORLEVEL%
