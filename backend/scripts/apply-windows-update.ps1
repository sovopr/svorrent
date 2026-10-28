param(
    [Parameter(Mandatory=$true)][string]$Installer,
    [Parameter(Mandatory=$true)][string]$Digest,
    [Parameter(Mandatory=$true)][int]$ParentPid,
    [Parameter(Mandatory=$true)][string]$AppDir
)

$ErrorActionPreference = 'Stop'

function Assert-Installer {
    if ($Digest -cnotmatch '^sha256:([0-9a-f]{64})$') { throw 'Invalid expected SHA-256 digest' }
    $expectedHash = $Matches[1]
    $actualHash = (Get-FileHash -LiteralPath $Installer -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -cne $expectedHash) { throw 'Installer SHA-256 verification failed' }
}

$expectedDir = Join-Path $env:LOCALAPPDATA 'Programs\Svorrent'
if (-not [string]::Equals([IO.Path]::GetFullPath($AppDir).TrimEnd('\'),
                         [IO.Path]::GetFullPath($expectedDir).TrimEnd('\'),
                         [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Update target is not the standard Svorrent installation'
}

Assert-Installer
$deadline = [DateTime]::UtcNow.AddSeconds(60)
while ([DateTime]::UtcNow -lt $deadline) {
    $parent = Get-Process -Id $ParentPid -ErrorAction SilentlyContinue
    if ($null -eq $parent) { break }
    Start-Sleep -Milliseconds 500
}
if ($null -ne (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) {
    throw 'Svorrent did not exit before installation'
}

Assert-Installer
$process = Start-Process -FilePath $Installer -ArgumentList '/S' -Wait -PassThru
if ($process.ExitCode -ne 0) { throw "Windows installer failed with exit code $($process.ExitCode)" }
Start-Process -FilePath (Join-Path $AppDir 'Svorrent.exe')
