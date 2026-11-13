# Gia lap CHUOT/PHIM THAT cua OS (overlay nhan press/release tu vong lap input goc cua Rust, khong phai su kien DOM
# nen CDP khong keo duoc). Toa do la toa do MAN HINH vat ly (process DPI-aware).
#   -Action drag  -X1 -Y1 -X2 -Y2   : giu chuot trai, keo, tha
#   -Action rclick -X1 -Y1          : bam chuot phai
#   -Action key   -Vk 27            : bam 1 phim (27 = Esc)
param([string]$Action, [int]$X1, [int]$Y1, [int]$X2, [int]$Y2, [int]$Vk = 27)
Add-Type @"
using System; using System.Runtime.InteropServices;
public class SdIn {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
}
"@
[void][SdIn]::SetProcessDPIAware()
$LD = 0x2; $LU = 0x4; $RD = 0x8; $RU = 0x10
switch ($Action) {
  'drag' {
    [void][SdIn]::SetCursorPos($X1, $Y1); Start-Sleep -Milliseconds 120
    [SdIn]::mouse_event($LD, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 80
    $steps = 14
    for ($i = 1; $i -le $steps; $i++) {
      [void][SdIn]::SetCursorPos([int]($X1 + ($X2 - $X1) * $i / $steps), [int]($Y1 + ($Y2 - $Y1) * $i / $steps)); Start-Sleep -Milliseconds 25
    }
    Start-Sleep -Milliseconds 100
    [SdIn]::mouse_event($LU, 0, 0, 0, [UIntPtr]::Zero)
  }
  'rclick' {
    [void][SdIn]::SetCursorPos($X1, $Y1); Start-Sleep -Milliseconds 150
    [SdIn]::mouse_event($RD, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 60
    [SdIn]::mouse_event($RU, 0, 0, 0, [UIntPtr]::Zero)
  }
  'key' {
    [SdIn]::keybd_event([byte]$Vk, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 50
    [SdIn]::keybd_event([byte]$Vk, 0, 2, [UIntPtr]::Zero)
  }
}
