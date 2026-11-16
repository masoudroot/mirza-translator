@echo off
chcp 65001 >nul
REM install-host.bat — نصب یک‌باره میزبان به‌روزرسان مترجم میرزا
REM فقط یک بار، با دابل‌کلیک، اجرا می‌شود. نیاز به دسترسی مدیر ندارد.
REM کاری که می‌کند: نشانی فایل host-manifest.json را در رجیستری کروم ثبت می‌کند
REM تا افزونه بتواند با میزبان حرف بزند.

setlocal
set "DIR=%~dp0"
if "%DIR:~-1%"=="\" set "DIR=%DIR:~0,-1%"
set "ESCAPED=%DIR:\=\\%"

set "MANIFEST=%DIR%\updater\host-manifest.json"
(
echo {
echo   "name": "com.mirza.translator",
echo   "description": "Mirza Translator update host",
echo   "path": "%ESCAPED%\\updater\\host-launcher.bat",
echo   "type": "stdio",
echo   "allowed_origins": ["chrome-extension://ofhoaahgmddcngeojfpnffnfhmdangcj/"]
echo }
) > "%MANIFEST%"

reg add "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.mirza.translator" /ve /t REG_SZ /d "%MANIFEST%" /f

if %ERRORLEVEL%==0 (
  echo.
  echo میزبان به‌روزرسان نصب شد.
  echo از این به بعد دکمه «به‌روزرسانی» در افزونه کار می‌کند.
) else (
  echo.
  echo نصب نشد؛ خطایی پیش آمد. پنجره را نبند و پیام بالا را بخوان.
)
echo.
pause
