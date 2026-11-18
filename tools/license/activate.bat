@echo off
rem Sepan install approval: turns a request code from a new server into an activation code.
cd /d "%~dp0"
sepan-license.exe sign
