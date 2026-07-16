@echo off
setlocal EnableExtensions
node.exe "%~dp0bin\xcode.js" %*
exit /b %ERRORLEVEL%
