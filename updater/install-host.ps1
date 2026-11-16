# install-host.ps1 — نصب یک‌باره میزبان به‌روزرسان مترجم میرزا
# با دابل‌کلیک روی install-host.bat اجرا می‌شود. نیاز به دسترسی مدیر ندارد.
# کاری که می‌کند: فایل host-manifest.json را می‌سازد و نشانی‌اش را در رجیستری کروم ثبت می‌کند
# تا افزونه بتواند با میزبان حرف بزند.

$ErrorActionPreference = 'Stop'

$updaterDir = $PSScriptRoot
$manifestPath = Join-Path $updaterDir 'host-manifest.json'
$launcherPath = Join-Path $updaterDir 'host-launcher.bat'
$extensionId = 'ofhoaahgmddcngeojfpnffnfhmdangcj'

$manifest = @{
    name            = 'com.mirza.translator'
    description     = 'Mirza Translator update host'
    path            = $launcherPath
    type            = 'stdio'
    allowed_origins = @("chrome-extension://$extensionId/")
}

# JSON بدون BOM می‌نویسیم تا کروم بی‌درنگ بخواندش
$json = ($manifest | ConvertTo-Json)
[System.IO.File]::WriteAllText($manifestPath, $json, (New-Object System.Text.UTF8Encoding($false)))

$regPath = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.mirza.translator'
if (-not (Test-Path $regPath)) { New-Item -Path $regPath -Force | Out-Null }
Set-ItemProperty -Path $regPath -Name '(default)' -Value $manifestPath

$saved = (Get-ItemProperty -Path $regPath -Name '(default)').'(default)'
if ($saved -ne $manifestPath) { throw 'ثبت در رجیستری انجام نشد.' }

Write-Host ''
Write-Host 'میزبان به‌روزرسان نصب شد.'
Write-Host 'از این به بعد دکمه «به‌روزرسانی» در افزونه کار می‌کند.'
