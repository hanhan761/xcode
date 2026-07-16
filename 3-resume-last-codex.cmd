@echo off
setlocal EnableExtensions
start "xcode - resume latest Codex conversation" powershell.exe -NoExit -Command "codex resume --last"
exit /b %ERRORLEVEL%
