# Liet ke cua so TOP-LEVEL dang HIEN, lon (>=1000x600, bo qua cua so Editor), thuoc tien trinh co duong dan exe = -Exe.
# Dung de dem overlay (phu kin man hinh) dang mo that tren OS. In so luong + rect.
param([Parameter(Mandatory = $true)][string]$Exe)
Add-Type @"
using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;
public class SdWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  public static List<string> Big(HashSet<uint> pids) {
    var res = new List<string>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (!pids.Contains(pid)) return true;
      RECT r; GetWindowRect(h, out r);
      if (r.R - r.L >= 1000 && r.B - r.T >= 600) { var sb = new StringBuilder(80); GetWindowText(h, sb, 80); if (sb.ToString().Contains("Editor")) return true; res.Add(r.L + "," + r.T + "," + (r.R - r.L) + "," + (r.B - r.T) + " ex=" + GetWindowLong(h, -20).ToString("X") + " '" + sb + "'"); }
      return true;
    }, IntPtr.Zero);
    return res;
  }
}
"@
$pids = New-Object 'System.Collections.Generic.HashSet[uint32]'
Get-CimInstance Win32_Process -Filter "Name='snapdoc.exe'" | Where-Object { $_.ExecutablePath -ieq $Exe } | ForEach-Object { [void]$pids.Add([uint32]$_.ProcessId) }
$list = [SdWin]::Big($pids)
[pscustomobject]@{ pids = @($pids).Count; count = $list.Count; rects = @($list) } | ConvertTo-Json -Compress
