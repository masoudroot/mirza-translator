# host.ps1 — میزبان به‌روزرسان مترجم میرزا (Native Messaging)
# کروم این اسکریپت را صدا می‌زند؛ اسکریپت با پروتکل پیام‌رسانی بومی حرف می‌زند:
# چهار بایت طول (little-endian) + JSON با کدگذاری UTF-8، در stdin و stdout.
# کارش فقط یکی است: گرفتن فایل‌های تازه از گیت‌هاب و گذاشتنشان روی پوشه افزونه.
# هیچ‌وقت از هیچ آدرس دیگری فایل نمی‌گیرد و هیچ‌وقت چیزی را اجرا نمی‌کند.

$ErrorActionPreference = 'Stop'

$stdin = [Console]::OpenStandardInput()
$stdout = [Console]::OpenStandardOutput()
$reader = New-Object System.IO.BinaryReader($stdin)
$writer = New-Object System.IO.BinaryWriter($stdout)

# پوشه افزونه = پوشه بالاتر از پوشه updater که این اسکریپت در آن است
$extRoot = Split-Path -Parent $PSScriptRoot

function Read-Message {
    $lenBytes = $reader.ReadBytes(4)
    if ($lenBytes.Length -lt 4) { return $null }
    $len = [BitConverter]::ToInt32($lenBytes, 0)
    if ($len -le 0 -or $len -gt 1048576) { return $null }
    $bytes = $reader.ReadBytes($len)
    if ($bytes.Length -lt $len) { return $null }
    $json = [Text.Encoding]::UTF8.GetString($bytes)
    return $json | ConvertFrom-Json
}

function Write-Message($obj) {
    $json = ($obj | ConvertTo-Json -Compress -Depth 5)
    $bytes = [Text.Encoding]::UTF8.GetBytes($json)
    $writer.Write([BitConverter]::GetBytes($bytes.Length))
    $writer.Write($bytes)
    $writer.Flush()
}

function Update-Extension($base, $files) {
    # فقط از گیت‌هاب خام فایل می‌گیریم؛ هر میزبان دیگری رد است
    $uri = [Uri]$base
    if ($uri.Host -ne 'raw.githubusercontent.com') { throw "host not allowed: $($uri.Host)" }
    if ($uri.Scheme -ne 'https') { throw 'only https is allowed' }
    if (-not $files -or $files.Count -eq 0) { throw 'empty file list' }

    $tmpDir = Join-Path $env:TEMP ("mirza-update-" + [Guid]::NewGuid().ToString())
    New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null
    try {
        # مرحله ۱: همه فایل‌ها را اول در پوشه موقت بگیر؛ اگر یکی هم نرسید، هیچ‌چیز را عوض نکن
        foreach ($rel in $files) {
            $rel = [string]$rel
            if ($rel -match '(^|/)\.\.(/|$)' -or [System.IO.Path]::IsPathRooted($rel)) {
                throw "unsafe path: $rel"
            }
            $url = $base.TrimEnd('/') + '/' + $rel.Replace('\', '/')
            $dest = Join-Path $tmpDir $rel
            $destDir = Split-Path -Parent $dest
            if ($destDir) { New-Item -ItemType Directory -Path $destDir -Force | Out-Null }
            Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing
            if (-not (Test-Path $dest)) { throw "download failed: $rel" }
        }
        # مرحله ۲: همه رسیدند؛ حالا روی پوشه افزونه کپی کن
        foreach ($rel in $files) {
            $src = Join-Path $tmpDir ([string]$rel)
            $dest = Join-Path $extRoot ([string]$rel)
            $destDir = Split-Path -Parent $dest
            if ($destDir) { New-Item -ItemType Directory -Path $destDir -Force | Out-Null }
            Copy-Item -Path $src -Destination $dest -Force
        }
    }
    finally {
        Remove-Item $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

while ($true) {
    $msg = $null
    try { $msg = Read-Message } catch { break }
    if ($null -eq $msg) { break }
    try {
        if ($msg.action -eq 'ping') {
            Write-Message @{ ok = $true; root = $extRoot }
        }
        elseif ($msg.action -eq 'update') {
            Update-Extension -base ([string]$msg.base) -files $msg.files
            Write-Message @{ ok = $true }
        }
        else {
            Write-Message @{ ok = $false; error = 'unknown action' }
        }
    }
    catch {
        try { Write-Message @{ ok = $false; error = $_.Exception.Message } } catch { }
    }
}
