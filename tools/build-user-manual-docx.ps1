param(
  [string]$Source = (Join-Path $PSScriptRoot '..\Documentation\Radar Validation Fixture User Manual.md'),
  [string]$Output = (Join-Path $PSScriptRoot '..\Documentation\Whisker Radar Validation Fixture User Manual.docx')
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

function XmlEscape([string]$text) {
  return [System.Security.SecurityElement]::Escape($text)
}

function RunXml([string]$text, [string]$style = '', [bool]$bold = $false, [string]$color = '') {
  $props = ''
  if ($style) { $props += "<w:rStyle w:val=`"$style`"/>" }
  if ($bold) { $props += '<w:b/>' }
  if ($color) { $props += "<w:color w:val=`"$color`"/>" }
  $space = if ($text.StartsWith(' ') -or $text.EndsWith(' ')) { ' xml:space="preserve"' } else { '' }
  return "<w:r><w:rPr>$props</w:rPr><w:t$space>$(XmlEscape $text)</w:t></w:r>"
}

function InlineXml([string]$text) {
  $result = ''
  $position = 0
  $matches = [regex]::Matches($text, '(\*\*[^*]+\*\*|`[^`]+`)')
  foreach ($match in $matches) {
    if ($match.Index -gt $position) { $result += RunXml $text.Substring($position, $match.Index - $position) }
    if ($match.Value.StartsWith('**')) {
      $result += RunXml $match.Value.Substring(2, $match.Value.Length - 4) '' $true
    } else {
      $result += RunXml $match.Value.Substring(1, $match.Value.Length - 2) 'CodeChar' $false '1F4E63'
    }
    $position = $match.Index + $match.Length
  }
  if ($position -lt $text.Length) { $result += RunXml $text.Substring($position) }
  return $result
}

function ParagraphXml([string]$text, [string]$style = 'BodyText', [string]$before = '', [string]$after = '') {
  $spacing = if ($before -or $after) { "<w:spacing w:before=`"$before`" w:after=`"$after`"/>" } else { '' }
  return "<w:p><w:pPr><w:pStyle w:val=`"$style`"/>$spacing</w:pPr>$(InlineXml $text)</w:p>"
}

function BulletXml([string]$text, [int]$level = 0, [bool]$checkbox = $false) {
  $mark = if ($checkbox) { ([char]0x2610).ToString() + '  ' } else { '' }
  return "<w:p><w:pPr><w:pStyle w:val=`"ListParagraph`"/><w:numPr><w:ilvl w:val=`"$level`"/><w:numId w:val=`"1`"/></w:numPr></w:pPr>$(InlineXml ($mark + $text))</w:p>"
}

function NumberXml([string]$text, [int]$level = 0) {
  return "<w:p><w:pPr><w:pStyle w:val=`"ListParagraph`"/><w:numPr><w:ilvl w:val=`"$level`"/><w:numId w:val=`"2`"/></w:numPr></w:pPr>$(InlineXml $text)</w:p>"
}

function CodeXml([string]$text) {
  return "<w:p><w:pPr><w:pStyle w:val=`"CodeBlock`"/><w:shd w:val=`"clear`" w:fill=`"EEF3F7`"/><w:ind w:left=`"240`" w:right=`"240`"/><w:spacing w:before=`"40`" w:after=`"40`"/></w:pPr>$(RunXml $text 'CodeChar')</w:p>"
}

function TableXml($rows, [bool]$metadata = $false) {
  if ($rows.Count -eq 0) { return '' }
  $columnCount = $rows[0].Count
  $widths = if ($columnCount -eq 2) { @(2500, 6800) } elseif ($columnCount -eq 3) { @(1700, 3300, 4300) } else { @(1200, 2600, 5500, 1800) }
  $table = '<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblLayout w:type="fixed"/>'
  $table += '<w:tblBorders><w:top w:val="single" w:sz="4" w:color="B8C6D1"/><w:left w:val="single" w:sz="4" w:color="B8C6D1"/><w:bottom w:val="single" w:sz="4" w:color="B8C6D1"/><w:right w:val="single" w:sz="4" w:color="B8C6D1"/><w:insideH w:val="single" w:sz="3" w:color="D7E0E7"/><w:insideV w:val="single" w:sz="3" w:color="D7E0E7"/></w:tblBorders>'
  $table += '<w:tblCellMar><w:top w:w="90" w:type="dxa"/><w:left w:w="110" w:type="dxa"/><w:bottom w:w="90" w:type="dxa"/><w:right w:w="110" w:type="dxa"/></w:tblCellMar></w:tblPr>'
  for ($r = 0; $r -lt $rows.Count; $r++) {
    $table += '<w:tr>'
    for ($c = 0; $c -lt $rows[$r].Count; $c++) {
      $fill = if ($r -eq 0 -and -not $metadata) { '1F4E63' } elseif ($metadata -and $c -eq 0) { 'E8F0F4' } elseif ($r % 2 -eq 0) { 'F4F7F9' } else { 'FFFFFF' }
      $textColor = if ($r -eq 0 -and -not $metadata) { 'FFFFFF' } else { '172B36' }
      $bold = ($r -eq 0 -and -not $metadata) -or ($metadata -and $c -eq 0)
      $width = $widths[[Math]::Min($c, $widths.Count - 1)]
      $table += "<w:tc><w:tcPr><w:tcW w:w=`"$width`" w:type=`"dxa`"/><w:shd w:val=`"clear`" w:fill=`"$fill`"/><w:vAlign w:val=`"center`"/></w:tcPr>"
      $table += "<w:p><w:pPr><w:spacing w:after=`"0`"/></w:pPr>$(RunXml $rows[$r][$c] '' $bold $textColor)</w:p></w:tc>"
    }
    $table += '</w:tr>'
  }
  return $table + '</w:tbl><w:p><w:pPr><w:spacing w:after="40"/></w:pPr></w:p>'
}

$lines = Get-Content -LiteralPath $Source -Encoding UTF8
$body = New-Object System.Text.StringBuilder
$tableRows = @()
$inCode = $false
$firstTitle = $true
$metadataTable = $true

function FlushTable {
  if ($script:tableRows.Count -gt 0) {
    [void]$script:body.Append((TableXml $script:tableRows $script:metadataTable))
    $script:tableRows = @()
    $script:metadataTable = $false
  }
}

foreach ($rawLine in $lines) {
  $line = $rawLine.TrimEnd()
  if ($line -eq '```text' -or $line -eq '```') {
    FlushTable
    $inCode = -not $inCode
    continue
  }
  if ($inCode) {
    [void]$body.Append((CodeXml $line))
    continue
  }
  if ($line -match '^\|(.+)\|$') {
    $cells = @($Matches[1].Split('|') | ForEach-Object { $_.Trim() })
    if (($cells | Where-Object { $_ -notmatch '^:?-+:?$' }).Count -eq 0) { continue }
    $tableRows += ,$cells
    continue
  }
  FlushTable
  if ([string]::IsNullOrWhiteSpace($line)) { continue }

  if ($line -match '^# (.+)$') {
    if ($firstTitle) {
      [void]$body.Append("<w:p><w:pPr><w:pStyle w:val=`"Title`"/><w:spacing w:before=`"900`" w:after=`"160`"/></w:pPr>$(RunXml $Matches[1])</w:p>")
      [void]$body.Append("<w:p><w:pPr><w:pStyle w:val=`"Subtitle`"/><w:spacing w:after=`"380`"/></w:pPr>$(RunXml 'ENGINEERING OPERATOR GUIDE')</w:p>")
      [void]$body.Append('<w:p><w:pPr><w:shd w:val="clear" w:fill="2E809B"/><w:spacing w:after="320"/></w:pPr><w:r><w:t> </w:t></w:r></w:p>')
      $firstTitle = $false
    }
  } elseif ($line -match '^## (.+)$') {
    [void]$body.Append((ParagraphXml $Matches[1] 'Heading1'))
  } elseif ($line -match '^### (.+)$') {
    [void]$body.Append((ParagraphXml $Matches[1] 'Heading2'))
  } elseif ($line -match '^\d+\.\s+(.+)$') {
    [void]$body.Append((NumberXml $Matches[1]))
  } elseif ($line -match '^-\s+\[ \]\s+(.+)$') {
    [void]$body.Append((BulletXml $Matches[1] 0 $true))
  } elseif ($line -match '^-\s+(.+)$') {
    [void]$body.Append((BulletXml $Matches[1]))
  } else {
    [void]$body.Append((ParagraphXml $line))
  }
}
FlushTable

$documentXml = @"
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>
    $($body.ToString())
    <w:sectPr>
      <w:pgSz w:w="12240" w:h="15840"/>
      <w:pgMar w:top="900" w:right="900" w:bottom="900" w:left="900" w:header="450" w:footer="450" w:gutter="0"/>
      <w:cols w:space="720"/>
      <w:docGrid w:linePitch="360"/>
    </w:sectPr>
  </w:body>
</w:document>
"@

$stylesXml = @'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:sz w:val="20"/><w:color w:val="172B36"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
  <w:style w:type="paragraph" w:styleId="BodyText"><w:name w:val="Body Text"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:style>
  <w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:jc w:val="left"/></w:pPr><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:b/><w:color w:val="173E50"/><w:sz w:val="42"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:b/><w:color w:val="2E809B"/><w:sz w:val="18"/><w:spacing w:val="24"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="BodyText"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="300" w:after="100"/><w:outlineLvl w:val="0"/><w:pBdr><w:bottom w:val="single" w:sz="10" w:space="4" w:color="2E809B"/></w:pBdr></w:pPr><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:b/><w:color w:val="173E50"/><w:sz w:val="28"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="BodyText"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="220" w:after="70"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:b/><w:color w:val="2E6476"/><w:sz w:val="23"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="BodyText"/><w:pPr><w:ind w:left="360" w:hanging="180"/><w:spacing w:after="70"/></w:pPr></w:style>
  <w:style w:type="paragraph" w:styleId="CodeBlock"><w:name w:val="Code Block"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="0"/></w:pPr></w:style>
  <w:style w:type="character" w:styleId="CodeChar"><w:name w:val="Code Char"/><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="18"/></w:rPr></w:style>
</w:styles>
'@

$numberingXml = @'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="&#x2022;"/><w:lvlJc w:val="left"/><w:pPr><w:tabs><w:tab w:val="num" w:pos="360"/></w:tabs><w:ind w:left="360" w:hanging="180"/></w:pPr><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/></w:rPr></w:lvl></w:abstractNum>
  <w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:lvlJc w:val="right"/><w:pPr><w:tabs><w:tab w:val="num" w:pos="420"/></w:tabs><w:ind w:left="420" w:hanging="240"/></w:pPr></w:lvl></w:abstractNum>
  <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
  <w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
</w:numbering>
'@

$contentTypes = @'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>
'@

$rootRels = @'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>
'@

$documentRels = @'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>
</Relationships>
'@

$coreXml = @'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>Whisker Radar Validation Fixture User Manual</dc:title>
  <dc:subject>Engineering operator guide</dc:subject>
  <dc:creator>Whisker Engineering</dc:creator>
  <cp:keywords>radar validation fixture operator manual</cp:keywords>
  <dcterms:created xsi:type="dcterms:W3CDTF">2026-07-24T00:00:00Z</dcterms:created>
</cp:coreProperties>
'@

$appXml = @'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>Microsoft Office Word</Application>
  <Company>Whisker</Company>
</Properties>
'@

$staging = Join-Path ([System.IO.Path]::GetTempPath()) ('radar-manual-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $staging, (Join-Path $staging '_rels'), (Join-Path $staging 'word'), (Join-Path $staging 'word\_rels'), (Join-Path $staging 'docProps') | Out-Null

$utf8 = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText((Join-Path $staging '[Content_Types].xml'), $contentTypes, $utf8)
[System.IO.File]::WriteAllText((Join-Path $staging '_rels\.rels'), $rootRels, $utf8)
[System.IO.File]::WriteAllText((Join-Path $staging 'word\document.xml'), $documentXml, $utf8)
[System.IO.File]::WriteAllText((Join-Path $staging 'word\styles.xml'), $stylesXml, $utf8)
[System.IO.File]::WriteAllText((Join-Path $staging 'word\numbering.xml'), $numberingXml, $utf8)
[System.IO.File]::WriteAllText((Join-Path $staging 'word\_rels\document.xml.rels'), $documentRels, $utf8)
[System.IO.File]::WriteAllText((Join-Path $staging 'docProps\core.xml'), $coreXml, $utf8)
[System.IO.File]::WriteAllText((Join-Path $staging 'docProps\app.xml'), $appXml, $utf8)

if (Test-Path -LiteralPath $Output) { Remove-Item -LiteralPath $Output }
$outputStream = [System.IO.File]::Open($Output, [System.IO.FileMode]::CreateNew)
$archive = New-Object System.IO.Compression.ZipArchive(
  $outputStream,
  [System.IO.Compression.ZipArchiveMode]::Create,
  $false
)
Get-ChildItem -LiteralPath $staging -Recurse -File | ForEach-Object {
  $relative = $_.FullName.Substring($staging.Length + 1).Replace('\', '/')
  $entry = $archive.CreateEntry($relative, [System.IO.Compression.CompressionLevel]::Optimal)
  $entryStream = $entry.Open()
  $sourceStream = [System.IO.File]::OpenRead($_.FullName)
  $sourceStream.CopyTo($entryStream)
  $sourceStream.Dispose()
  $entryStream.Dispose()
}
$archive.Dispose()
$outputStream.Dispose()
Remove-Item -LiteralPath $staging -Recurse

Write-Output $Output
