param(
  [Parameter(Mandatory = $true)][string]$InputDocx,
  [Parameter(Mandatory = $true)][string]$OutputDocx,
  [Parameter(Mandatory = $true)][string]$ChapterTextPath,
  [switch]$ExportPdf
)

$ErrorActionPreference = "Stop"

function Release-ComObject {
  param([object]$ComObject)
  if ($null -ne $ComObject) {
    try { [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($ComObject) } catch {}
  }
}

function Is-TableSeparatorLine {
  param([string]$Line)
  if ([string]::IsNullOrWhiteSpace($Line)) { return $false }
  $trimmed = $Line.Trim()
  return ($trimmed -match '^\|?\s*[:\- ]+\|[:\-\| ]+$')
}

function Parse-MarkdownTable {
  param([System.Collections.Generic.List[string]]$Lines, [ref]$Index)

  $tableLines = New-Object System.Collections.Generic.List[string]
  while ($Index.Value -lt $Lines.Count) {
    $candidate = $Lines[$Index.Value]
    if ([string]::IsNullOrWhiteSpace($candidate)) { break }
    if ($candidate.TrimStart().StartsWith('|')) {
      $tableLines.Add($candidate)
      $Index.Value += 1
      continue
    }
    break
  }

  if ($tableLines.Count -lt 2) { return $null }

  $separatorLinePos = -1
  for ($j = 0; $j -lt $tableLines.Count; $j += 1) {
    if (Is-TableSeparatorLine -Line $tableLines[$j]) {
      $separatorLinePos = $j
      break
    }
  }
  if ($separatorLinePos -lt 1) { return $null }

  $headerLine = $tableLines[0]
  $dataLines = @()
  for ($k = $separatorLinePos + 1; $k -lt $tableLines.Count; $k += 1) {
    $dataLines += $tableLines[$k]
  }
  if ($dataLines.Count -lt 1) { return $null }

  function Split-Cells([string]$line) {
    $cells = $line.Trim()
    if ($cells.StartsWith('|')) { $cells = $cells.Substring(1) }
    if ($cells.EndsWith('|')) { $cells = $cells.Substring(0, $cells.Length - 1) }
    return $cells.Split('|') | ForEach-Object { $_.Trim() }
  }

  $headerCells = Split-Cells $headerLine
  $rowObjects = @()
  foreach ($dl in $dataLines) {
    $cells = Split-Cells $dl
    $rowObjects += ,$cells
  }

  return [pscustomobject]@{
    Header = $headerCells
    Rows   = $rowObjects
  }
}

if (!(Test-Path -LiteralPath $InputDocx)) { throw "InputDocx not found: $InputDocx" }
if (!(Test-Path -LiteralPath $ChapterTextPath)) { throw "ChapterTextPath not found: $ChapterTextPath" }

$chapterText = Get-Content -LiteralPath $ChapterTextPath -Raw -Encoding UTF8
if ([string]::IsNullOrWhiteSpace($chapterText)) { throw "Chapter text file is empty." }

$word = $null
$doc = $null
$paras = $null

try {
  $word = New-Object -ComObject Word.Application
  $word.Visible = $false
  $word.DisplayAlerts = 0

  $doc = $word.Documents.Open($InputDocx)

  if ($doc.ProtectionType -ne -1) {
    throw "Document is protected. Disable protection/tracked restrictions first."
  }

  $paras = $doc.Paragraphs
  $startPara = $null
  $startIndex = -1
  $chapter3Count = 0

  for ($i = 1; $i -le $paras.Count; $i += 1) {
    $text = ($paras.Item($i).Range.Text -replace '[\r\a]', '').Trim()
    if ($text -match '^(?i)Chapter\s*3$') {
      $chapter3Count += 1
      if ($null -eq $startPara) {
        $startPara = $paras.Item($i)
        $startIndex = $i
      }
    }
  }

  if ($null -eq $startPara) {
    throw "Could not find Chapter 3 start marker."
  }

  if ($chapter3Count -gt 1) {
    Write-Warning "Multiple Chapter 3 markers found. Using first occurrence at paragraph index $startIndex."
  }

  $endRangeStart = $doc.Content.End
  for ($i = $startIndex + 1; $i -le $paras.Count; $i += 1) {
    $text = ($paras.Item($i).Range.Text -replace '[\r\a]', '').Trim()
    if ($text -match '^(?i)Chapter\s*4$') {
      $endRangeStart = $paras.Item($i).Range.Start
      break
    }
  }

  $replaceRange = $doc.Range($startPara.Range.Start, $endRangeStart)
  $replaceRange.Text = ""

  $insertPoint = $doc.Range($startPara.Range.Start, $startPara.Range.Start)

  $linesRaw = $chapterText -split "`r?`n"
  $lines = New-Object System.Collections.Generic.List[string]
  foreach ($ln in $linesRaw) { [void]$lines.Add($ln) }

  $h1Exact = @("Chapter 3", "METHODOLOGY")
  $h2Exact = @(
    "Requirements Analysis",
    "Requirements Documentation",
    "Design of Software, System, Product and or Processes",
    "Development and Testing (where applicable)",
    "Description of the Prototype (where applicable)",
    "Implementation Plan (where needed)",
    "Implementation Results (where applicable)"
  )

  $i = 0
  while ($i -lt $lines.Count) {
    $line = $lines[$i]
    $trimmed = $line.Trim()

    if ([string]::IsNullOrWhiteSpace($trimmed)) {
      $insertPoint.InsertParagraphAfter()
      $insertPoint.SetRange($insertPoint.End, $insertPoint.End)
      $i += 1
      continue
    }

    if ($trimmed.StartsWith('|')) {
      $idxRef = [ref]$i
      $table = Parse-MarkdownTable -Lines $lines -Index $idxRef
      if ($null -ne $table) {
        $rowsCount = $table.Rows.Count + 1
        $colsCount = $table.Header.Count
        if ($colsCount -gt 0) {
          $tblRange = $doc.Range($insertPoint.Start, $insertPoint.Start)
          $tbl = $doc.Tables.Add($tblRange, $rowsCount, $colsCount)
          $tbl.Style = "Table Grid"

          for ($c = 0; $c -lt $colsCount; $c += 1) {
            $tbl.Cell(1, $c + 1).Range.Text = $table.Header[$c]
            $tbl.Cell(1, $c + 1).Range.Bold = 1
          }

          for ($r = 0; $r -lt $table.Rows.Count; $r += 1) {
            $rowCells = $table.Rows[$r]
            for ($c = 0; $c -lt $colsCount; $c += 1) {
              $val = ""
              if ($c -lt $rowCells.Count) { $val = $rowCells[$c] }
              $tbl.Cell($r + 2, $c + 1).Range.Text = $val
            }
          }

          $insertPoint.SetRange($tbl.Range.End, $tbl.Range.End)
          $insertPoint.InsertParagraphAfter()
          $insertPoint.SetRange($insertPoint.End, $insertPoint.End)
          $i = $idxRef.Value
          continue
        }
      }
    }

    $insertPoint.Text = $trimmed
    $para = $insertPoint.Paragraphs.Item(1)

    if ($h1Exact -contains $trimmed) {
      $para.Range.Style = "Heading 1"
    } elseif ($h2Exact -contains $trimmed) {
      $para.Range.Style = "Heading 2"
    } elseif ($trimmed -match '^[0-9]+\)|:$') {
      $para.Range.Style = "Heading 3"
    } else {
      $para.Range.Style = "Normal"
    }

    $insertPoint.SetRange($para.Range.End, $para.Range.End)
    $insertPoint.InsertParagraphAfter()
    $insertPoint.SetRange($insertPoint.End, $insertPoint.End)
    $i += 1
  }

  $outDir = Split-Path -Path $OutputDocx -Parent
  if (![string]::IsNullOrWhiteSpace($outDir) -and !(Test-Path -LiteralPath $outDir)) {
    New-Item -Path $outDir -ItemType Directory -Force | Out-Null
  }

  $doc.SaveAs([ref]$OutputDocx)

  if ($ExportPdf) {
    $pdfPath = [System.IO.Path]::ChangeExtension($OutputDocx, ".pdf")
    $wdExportFormatPDF = 17
    $doc.ExportAsFixedFormat($pdfPath, $wdExportFormatPDF)
  }

  Write-Output "Updated document saved: $OutputDocx"
  if ($ExportPdf) {
    Write-Output "PDF exported: $([System.IO.Path]::ChangeExtension($OutputDocx, '.pdf'))"
  }
}
finally {
  if ($doc -ne $null) {
    try { $doc.Close() } catch {}
  }
  if ($word -ne $null) {
    try { $word.Quit() } catch {}
  }
  Release-ComObject -ComObject $paras
  Release-ComObject -ComObject $doc
  Release-ComObject -ComObject $word
  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
}
