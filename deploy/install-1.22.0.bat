@echo off
rem Sepan 1.22.0 installer: copies code.tgz, the APK and the script to the server, then runs it.
rem Uses the SSH key on this PC (no password). Output also goes to install-1.22.0.log next to this file.
setlocal
cd /d "%~dp0"
set SRV=root@193.151.148.119
echo == Sepan 1.22.0: upload
ssh -o StrictHostKeyChecking=accept-new %SRV% "mkdir -p /root/sepan-1.22.0"
if errorlevel 1 goto fail
scp code.tgz sepan-1.22.0.apk rel-1.22.0.sh %SRV%:/root/sepan-1.22.0/
if errorlevel 1 goto fail
echo == Sepan 1.22.0: install (about 1 minute)
ssh %SRV% "bash /root/sepan-1.22.0/rel-1.22.0.sh 2>&1 | tee /root/sepan-1.22.0/install.log; exit ${PIPESTATUS[0]}" > install-1.22.0.log 2>&1
set RC=%errorlevel%
type install-1.22.0.log
if not "%RC%"=="0" goto fail
echo.
echo ==== OK: Sepan 1.22.0 installed. ====
pause
exit /b 0
:fail
echo.
echo ==== FAILED (see install-1.22.0.log). Nothing else to do; tell Claude. ====
pause
exit /b 1
