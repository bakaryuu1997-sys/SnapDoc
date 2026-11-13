# Hien mot cua so TOPMOST co chu gia co dinh o GIUA MOI MAN HINH (de test Text Grab 2 man hinh).
# In ra 1 dong JSON mo ta cac man hinh + chu mong doi, roi giu cua so cho den khi bi kill.
# Chi dung chu gia, khong chup/luu man hinh that cua nguoi dung.
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type @"
using System.Runtime.InteropServices;
public class SdDpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }
"@
[void][SdDpi]::SetProcessDPIAware()
[System.Windows.Forms.Application]::EnableVisualStyles()
$tokens = @("12345", "67890", "24680", "13579")
$forms = @()
$info = @()
$i = 0
foreach ($s in [System.Windows.Forms.Screen]::AllScreens) {
  $b = $s.Bounds
  $tok = $tokens[$i % $tokens.Count]
  $text = "SNAPDOC GRAB M$i $tok"
  $fw = [int]($b.Width * 0.6); $fh = [int]($b.Height * 0.3)
  $f = New-Object System.Windows.Forms.Form
  $f.FormBorderStyle = 'None'
  $f.StartPosition = 'Manual'
  $f.ShowInTaskbar = $false
  $f.TopMost = $true
  $f.BackColor = [System.Drawing.Color]::White
  $f.Bounds = New-Object System.Drawing.Rectangle(($b.X + [int](($b.Width - $fw) / 2)), ($b.Y + [int](($b.Height - $fh) / 2)), $fw, $fh)
  $em = [single](0.8 * $fw / ($text.Length * 0.6))
  $l = New-Object System.Windows.Forms.Label
  $l.Dock = 'Fill'
  $l.TextAlign = 'MiddleCenter'
  $l.ForeColor = [System.Drawing.Color]::Black
  $l.Font = New-Object System.Drawing.Font("Consolas", $em, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $l.Text = $text
  $f.Controls.Add($l)
  $f.Show()
  $forms += $f
  $info += [pscustomobject]@{ index = $i; x = $b.X; y = $b.Y; w = $b.Width; h = $b.Height; primary = $s.Primary; token = $tok; text = $text }
  $i++
}
[System.Windows.Forms.Application]::DoEvents()
($info | ConvertTo-Json -Compress) | Write-Output
[Console]::Out.Flush()
while ($true) { [System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 80 }
