# ============================================================================
# Berserker v0.4.0 - Windows Automated Setup & Diagnostic Script
# Verifies system environment, checks architecture, and tests UCI engine handshake.
# ============================================================================

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "   Berserker v0.4.0 - Windows Environment Setup" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$EnginePath = Join-Path $ScriptDir "berserker-v0.4.0-cli.js"

# 1. Check Architecture
$Arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture
Write-Host "[1/4] Detecting CPU Architecture: $Arch" -ForegroundColor Yellow

# 2. Check Runtime (Bun or Node)
$Runtime = $null
if (Get-Command "bun" -ErrorAction SilentlyContinue) {
    $Runtime = "bun"
    Write-Host "[2/4] Found Bun runtime (ultra-fast): $(bun --version)" -ForegroundColor Green
} elseif (Get-Command "node" -ErrorAction SilentlyContinue) {
    $Runtime = "node"
    Write-Host "[2/4] Found Node.js runtime: $(node --version)" -ForegroundColor Green
} else {
    Write-Host "[2/4] ERROR: Neither Node.js nor Bun was found in PATH!" -ForegroundColor Red
    Write-Host "Please install Node.js from https://nodejs.org (LTS recommended)." -ForegroundColor Red
    Exit 1
}

# 3. Check Engine File
if (-not (Test-Path $EnginePath)) {
    Write-Host "[3/4] ERROR: Engine file not found at $EnginePath" -ForegroundColor Red
    Exit 1
}
Write-Host "[3/4] Engine file verified: berserker-v0.4.0-cli.js" -ForegroundColor Green

# 4. Perform UCI Handshake Test
Write-Host "[4/4] Testing UCI protocol handshake..." -ForegroundColor Yellow
$PInfo = New-Object System.Diagnostics.ProcessStartInfo
$PInfo.FileName = $Runtime
$PInfo.Arguments = "`"$EnginePath`""
$PInfo.RedirectStandardInput = $true
$PInfo.RedirectStandardOutput = $true
$PInfo.UseShellExecute = $false
$PInfo.CreateNoWindow = $true

$Process = [System.Diagnostics.Process]::Start($PInfo)
$Writer = $Process.StandardInput
$Reader = $Process.StandardOutput

$Writer.WriteLine("uci")
$Writer.Flush()

$UciOk = $false
$StartTime = Get-Date

while (-not $Process.HasExited -and ((Get-Date) - $StartTime).TotalSeconds -lt 4) {
    $Line = $Reader.ReadLine()
    if ($Line) {
        Write-Host "  < $Line" -ForegroundColor DarkGray
        if ($Line -match "uciok") {
            $UciOk = $true
            break
        }
    }
}

$Writer.WriteLine("quit")
$Writer.Flush()
$Process.WaitForExit(1000)

if ($UciOk) {
    Write-Host "`nSUCCESS! Berserker v0.4.0 is ready for use." -ForegroundColor Green
    Write-Host "You can now add $EnginePath as an engine in CuteChess, Arena, or Banksia." -ForegroundColor Cyan
} else {
    Write-Host "`nWarning: UCI Handshake timed out." -ForegroundColor Yellow
}
