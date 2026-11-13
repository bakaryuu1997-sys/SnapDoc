# Khoi dong lai CHI app e2e (khop dung duong dan exe) voi CDP :9333. Tham so: -Exe duong dan snapdoc.exe cua ban e2e.
param([Parameter(Mandatory = $true)][string]$Exe)
if ($Exe -like '*AppData\Local\SnapDoc\*') { throw 'Tu choi: day la ban da cai.' }
Get-CimInstance Win32_Process -Filter "Name='snapdoc.exe'" | Where-Object { $_.ExecutablePath -ieq $Exe } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-Sleep 3
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9333 --remote-allow-origins=*'
$dir = Split-Path $Exe
Start-Process $Exe -WorkingDirectory $dir -RedirectStandardError "$dir\err.log" -RedirectStandardOutput "$dir\out.log"
Start-Sleep 10
