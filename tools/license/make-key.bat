@echo off
rem Sepan install approval: makes the private key ONCE (sepan-license.key next to this file).
cd /d "%~dp0"
sepan-license.exe keygen
pause
