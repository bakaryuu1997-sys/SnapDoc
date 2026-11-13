# Gui to hop phim toan cuc (mac dinh Ctrl+Alt+Shift+F10) bang keybd_event.
param([int]$Vk = 0x79)
Add-Type @"
using System.Runtime.InteropServices;
public class SdKeys { [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, System.UIntPtr extra); }
"@
$mods = 0x11, 0x12, 0x10   # Ctrl, Alt, Shift
foreach ($m in $mods) { [SdKeys]::keybd_event($m, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 15 }
[SdKeys]::keybd_event($Vk, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 40
[SdKeys]::keybd_event($Vk, 0, 2, [UIntPtr]::Zero)
[array]::Reverse($mods)
foreach ($m in $mods) { [SdKeys]::keybd_event($m, 0, 2, [UIntPtr]::Zero); Start-Sleep -Milliseconds 15 }
