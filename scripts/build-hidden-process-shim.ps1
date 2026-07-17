[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$OutputPath,
    [Parameter(Mandatory)][string]$SourcePath
)

$ErrorActionPreference = 'Stop'
$directory = Split-Path -Parent $OutputPath
if (-not (Test-Path -LiteralPath $directory)) { New-Item -ItemType Directory -Path $directory -Force | Out-Null }
$temporary = Join-Path $directory ('.hidden-process-' + [Guid]::NewGuid().ToString('N') + '.exe')
try {
    Add-Type -Path $SourcePath -OutputAssembly $temporary -OutputType WindowsApplication
    Move-Item -LiteralPath $temporary -Destination $OutputPath -Force
}
finally {
    Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
}
