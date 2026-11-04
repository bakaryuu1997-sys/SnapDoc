param([string]$ImagePath, [string]$Lang = "")

if (-not (Test-Path $ImagePath)) {
    Write-Output '{"text":"","words":[],"lines":[]}'
    exit 0
}

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]

function Await($asyncOp, $type) {
    $m = $asTaskGeneric.MakeGenericMethod($type)
    $task = $m.Invoke($null, @($asyncOp))
    $task.Wait()
    return $task.Result
}

[Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime] | Out-Null
[Windows.Media.Ocr.OcrEngine, Windows.Foundation.Metadata, ContentType = WindowsRuntime] | Out-Null
[Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime] | Out-Null

$resolvedPath = (Resolve-Path $ImagePath).Path
$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($resolvedPath)) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])

$engine = $null
if ($Lang) {
    try {
        if ([Windows.Globalization.Language]::IsWellFormed($Lang)) {
            $langObj = New-Object Windows.Globalization.Language($Lang)
            $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($langObj)
        }
    } catch {}
}

if (-not $engine) {
    try {
        $langEn = New-Object Windows.Globalization.Language("en-US")
        $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($langEn)
    } catch {}
}

if (-not $engine) {
    try {
        $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
    } catch {}
}

if (-not $engine) {
    Write-Output '{"text":"","words":[],"lines":[]}'
    exit 0
}

$ocrResult = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])

$wordsList = New-Object System.Collections.Generic.List[PSObject]
$linesList = New-Object System.Collections.Generic.List[PSObject]
if ($ocrResult -and $ocrResult.Lines) {
    foreach ($line in $ocrResult.Lines) {
        $lineWords = New-Object System.Collections.Generic.List[PSObject]
        foreach ($w in $line.Words) {
            $wObj = [PSCustomObject]@{
                text = $w.Text
                x = [math]::Round($w.BoundingRect.X, 1)
                y = [math]::Round($w.BoundingRect.Y, 1)
                w = [math]::Round($w.BoundingRect.Width, 1)
                h = [math]::Round($w.BoundingRect.Height, 1)
            }
            $lineWords.Add($wObj)
            $wordsList.Add($wObj)
        }
        if ($lineWords.Count -gt 0) {
            $minX = ($lineWords | Measure-Object -Property x -Minimum).Minimum
            $minY = ($lineWords | Measure-Object -Property y -Minimum).Minimum
            $maxX = ($lineWords | ForEach-Object { $_.x + $_.w } | Measure-Object -Maximum).Maximum
            $maxY = ($lineWords | ForEach-Object { $_.y + $_.h } | Measure-Object -Maximum).Maximum
            $linesList.Add([PSCustomObject]@{
                text = $line.Text
                x = $minX
                y = $minY
                w = [math]::Max($maxX - $minX, 10)
                h = [math]::Max($maxY - $minY, 12)
                words = $lineWords
            })
        }
    }
}

$resultObj = [PSCustomObject]@{
    text = if ($ocrResult) { $ocrResult.Text } else { "" }
    words = $wordsList
    lines = $linesList
}

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$json = $resultObj | ConvertTo-Json -Depth 5 -Compress
Write-Output $json
