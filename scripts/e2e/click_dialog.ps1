# Bấm một nút của hộp thoại MessageBox gốc của CHÍNH bản test: tìm cửa sổ theo tiêu đề rồi gửi BM_CLICK
# tới nút theo ID chuẩn (OK=1, Cancel=2) — ổn định hơn UI Automation (nút MessageBox không có InvokePattern).
# Không chụp/quay màn hình. Dùng cho s13_mcp.mjs (hộp thoại "AI agent xin xác nhận").
param(
  [string]$Title = $env:E2E_DIALOG_TITLE,   # qua biến môi trường: tham số dòng lệnh bị hỏng dấu tiếng Việt (codepage ANSI)
  [Parameter(Mandatory = $true)][ValidateSet("OK", "Cancel")][string]$Button,
  [int]$TimeoutSec = 30
)
Add-Type -MemberDefinition @'
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindowW(string cls, string title);
[DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr hDlg, int id);
[DllImport("user32.dll")] public static extern IntPtr SendMessageW(IntPtr h, uint msg, IntPtr w, IntPtr l);
'@ -Name Dlg -Namespace SnapDocE2E
if (-not $Title) { Write-Output "no-title"; exit 2 }
$id = if ($Button -eq "OK") { 1 } else { 2 }
$end = (Get-Date).AddSeconds($TimeoutSec)
while ((Get-Date) -lt $end) {
  $w = [SnapDocE2E.Dlg]::FindWindowW($null, $Title)
  if ($w -ne [IntPtr]::Zero) {
    $b = [SnapDocE2E.Dlg]::GetDlgItem($w, $id)
    if ($b -ne [IntPtr]::Zero) {
      [SnapDocE2E.Dlg]::SendMessageW($b, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null  # BM_CLICK
      Write-Output "clicked"
      exit 0
    }
  }
  Start-Sleep -Milliseconds 250
}
Write-Output "not-found"
exit 1
