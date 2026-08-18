@echo off
chcp 65001 >nul
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" -Profile web -StartAfterInstall
set EXIT_CODE=%ERRORLEVEL%
echo.
if not "%EXIT_CODE%"=="0" (
  echo 安装没有完成。上方是具体错误。
) else (
  echo 安装流程结束。
)
pause
exit /b %EXIT_CODE%
