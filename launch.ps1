# Voting Node Launcher Script
# PowerShell script to launch the private voting node with user input

param(
    [switch]$NoGUI,
    [switch]$GUIOnly,
    [switch]$Help
)

if ($Help) {
    Write-Host "Voting Node Launcher Script" -ForegroundColor Cyan
    Write-Host "=============================" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "Usage: .\launch-voting-node.ps1 [options]"
    Write-Host ""
    Write-Host "Options:"
    Write-Host "  -NoGUI     Disable GUI completely"
    Write-Host "  -GUIOnly   Enable GUI but don't auto-launch browser"
    Write-Host "  -Help      Show this help message"
    Write-Host ""
    Write-Host "This script will prompt for node configuration and launch the voting system."
    exit 0
}

# Function to validate port number
function Test-Port {
    param([string]$Port)
    
    $portNum = 0
    if ([int]::TryParse($Port, [ref]$portNum)) {
        if ($portNum -ge 1024 -and $portNum -le 65535) {
            return $true
        }
    }
    return $false
}

# Function to validate node name
function Test-NodeName {
    param([string]$Name)
    
    if ($Name -match '^[a-zA-Z0-9_-]+$' -and $Name.Length -ge 2 -and $Name.Length -le 20) {
        return $true
    }
    return $false
}

# Function to parse and validate peer addresses
function Test-PeerAddress {
    param([string]$Peer)
    
    if ($Peer -match '^([a-zA-Z0-9.-]+):(\d+)$') {
        $host = $Matches[1]
        $port = $Matches[2]
        
        if (Test-Port $port) {
            return $true
        }
    }
    return $false
}

# Check if Node.js is installed
try {
    $nodeVersion = node --version 2>$null
    if (-not $nodeVersion) {
        throw "Node.js not found"
    }
    Write-Host "Node.js version: $nodeVersion" -ForegroundColor Green
} catch {
    Write-Host "Error: Node.js is not installed or not in PATH" -ForegroundColor Red
    Write-Host "Please install Node.js from https://nodejs.org/" -ForegroundColor Yellow
    exit 1
}

# Check if the voting node script exists
$scriptPath = ".\voting-node.js"
if (-not (Test-Path $scriptPath)) {
    Write-Host "Error: voting-node.js not found in current directory" -ForegroundColor Red
    Write-Host "Please ensure you're running this script from the same directory as voting-node.js" -ForegroundColor Yellow
    exit 1
}

Write-Host ""
Write-Host "===================================" -ForegroundColor Cyan
Write-Host "    Private Voting Node Launcher" -ForegroundColor Cyan
Write-Host "===================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "This will start a secure voting node with:" -ForegroundColor Yellow
Write-Host "- Encrypted anonymous voting" -ForegroundColor Yellow
Write-Host "- Automatic peer discovery" -ForegroundColor Yellow
Write-Host "- Web-based GUI interface" -ForegroundColor Yellow
Write-Host ""

# Get node name
do {
    $nodeName = Read-Host "Enter node name (2-20 chars, letters/numbers/dash/underscore only)"
    if (-not (Test-NodeName $nodeName)) {
        Write-Host "Invalid node name. Use 2-20 characters, letters, numbers, dash, or underscore only." -ForegroundColor Red
    }
} while (-not (Test-NodeName $nodeName))

# Get port number
do {
    $defaultPort = 3000 + (Get-Random -Maximum 100)
    $portInput = Read-Host "Enter port number (1024-65535) [default: $defaultPort]"
    
    if ([string]::IsNullOrWhiteSpace($portInput)) {
        $port = $defaultPort
        break
    } elseif (Test-Port $portInput) {
        $port = [int]$portInput
        break
    } else {
        Write-Host "Invalid port number. Must be between 1024 and 65535." -ForegroundColor Red
    }
} while ($true)

# Get peer addresses (optional)
Write-Host ""
Write-Host "Peer Configuration (Optional)" -ForegroundColor Yellow
Write-Host "Enter known peer addresses to connect to existing nodes."
Write-Host "Format: hostname:port (e.g., localhost:3001, 192.168.1.100:3002)"
Write-Host "Press Enter with empty input to finish."
Write-Host ""

$peers = @()
$peerIndex = 1

do {
    $peerInput = Read-Host "Peer $peerIndex address (or press Enter to continue)"
    
    if ([string]::IsNullOrWhiteSpace($peerInput)) {
        break
    }
    
    if (Test-PeerAddress $peerInput) {
        $peers += $peerInput
        Write-Host "Added peer: $peerInput" -ForegroundColor Green
        $peerIndex++
    } else {
        Write-Host "Invalid peer address format. Use hostname:port (e.g., localhost:3001)" -ForegroundColor Red
    }
} while ($true)

# Display configuration summary
Write-Host ""
Write-Host "Configuration Summary:" -ForegroundColor Cyan
Write-Host "=====================" -ForegroundColor Cyan
Write-Host "Node Name: $nodeName"
Write-Host "Port: $port"
if ($peers.Count -gt 0) {
    Write-Host "Peers: $($peers -join ', ')"
} else {
    Write-Host "Peers: None (will use auto-discovery)"
}

# Determine GUI settings
$guiStatus = "Enabled with auto-launch"
if ($NoGUI) {
    $guiStatus = "Disabled"
} elseif ($GUIOnly) {
    $guiStatus = "Enabled (manual launch)"
}
Write-Host "GUI: $guiStatus"
Write-Host ""

# Confirm before launching
$confirm = Read-Host "Launch node with this configuration? (y/N)"
if ($confirm -notmatch '^[Yy]') {
    Write-Host "Launch cancelled." -ForegroundColor Yellow
    exit 0
}

# Build command arguments
$arguments = @($nodeName, $port)
$arguments += $peers

if ($NoGUI) {
    $arguments += "--no-gui"
} elseif ($GUIOnly) {
    $arguments += "--gui-only"
}

# Launch the node
Write-Host ""
Write-Host "Launching voting node..." -ForegroundColor Green
Write-Host "Command: node $scriptPath $($arguments -join ' ')" -ForegroundColor Gray
Write-Host ""
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "Node is starting... Press Ctrl+C to stop" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""

try {
    # Change to the script directory and launch
    $originalLocation = Get-Location
    Set-Location (Split-Path $scriptPath -Parent)
    
    # Use Start-Process to launch in a way that allows Ctrl+C handling
    & node $scriptPath @arguments
    
} catch {
    Write-Host ""
    Write-Host "Error launching node: $($_.Exception.Message)" -ForegroundColor Red
} finally {
    Set-Location $originalLocation
    Write-Host ""
    Write-Host "Node shutdown complete." -ForegroundColor Yellow
}

# Wait for user acknowledgment
Write-Host ""
Read-Host "Press Enter to exit"