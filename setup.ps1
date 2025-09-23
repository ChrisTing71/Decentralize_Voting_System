# P2P Voting System - Docker Setup Script (PowerShell)
# Run with: powershell -ExecutionPolicy Bypass -File setup.ps1

Write-Host "======================================" -ForegroundColor Cyan
Write-Host "P2P Voting System - Docker Setup" -ForegroundColor Cyan
Write-Host "======================================" -ForegroundColor Cyan
Write-Host ""

# Function to check command availability
function Test-Command {
    param($Command)
    try {
        Get-Command $Command -ErrorAction Stop | Out-Null
        return $true
    } catch {
        return $false
    }
}

# Function to display errors
function Show-Error {
    param($Message)
    Write-Host "❌ $Message" -ForegroundColor Red
}

# Function to display success
function Show-Success {
    param($Message)
    Write-Host "✅ $Message" -ForegroundColor Green
}

# Function to display info
function Show-Info {
    param($Message)
    Write-Host "📦 $Message" -ForegroundColor Yellow
}

# Function to display warning
function Show-Warning {
    param($Message)
    Write-Host "⚠️ $Message" -ForegroundColor Yellow
}

# Check if Docker is installed
if (-not (Test-Command "docker")) {
    Show-Error "Docker is not installed or not in PATH."
    Write-Host "Please install Docker Desktop for Windows from:" -ForegroundColor Yellow
    Write-Host "https://docs.docker.com/desktop/install/windows-install/" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "Press any key to exit..."
    $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
    exit 1
}

# Check if Docker is running
try {
    $dockerInfo = docker info 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "Docker daemon not responding"
    }
    Show-Success "Docker is installed and running"
    
    # Display Docker version
    $dockerVersion = docker version --format "{{.Server.Version}}" 2>$null
    if ($dockerVersion) {
        Write-Host "   Docker version: $dockerVersion" -ForegroundColor Gray
    }
} catch {
    Show-Error "Docker is installed but not running."
    Write-Host ""
    Write-Host "Please start Docker Desktop and wait for it to fully initialize." -ForegroundColor Yellow
    Write-Host "Docker Desktop usually takes 30-60 seconds to start." -ForegroundColor Gray
    Write-Host ""
    Write-Host "If Docker Desktop is running but still showing this error:" -ForegroundColor Yellow
    Write-Host "1. Right-click Docker Desktop icon in system tray" -ForegroundColor Gray
    Write-Host "2. Select 'Restart'" -ForegroundColor Gray
    Write-Host "3. Wait for it to fully start" -ForegroundColor Gray
    Write-Host "4. Run this script again" -ForegroundColor Gray
    Write-Host ""
    Write-Host "Press any key to exit..."
    $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
    exit 1
}

Write-Host ""

# Check if Node.js is installed
if (-not (Test-Command "node")) {
    Show-Error "Node.js is not installed."
    Write-Host "Please install Node.js from: https://nodejs.org/" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Press any key to exit..."
    $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
    exit 1
}

# Check if npm is installed
if (-not (Test-Command "npm")) {
    Show-Error "npm is not installed."
    Write-Host "npm should come with Node.js. Please reinstall Node.js." -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Press any key to exit..."
    $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
    exit 1
}

# Display versions
$nodeVersion = node --version
$npmVersion = npm --version
$dockerVersion = docker --version

Write-Host "System Information:" -ForegroundColor Cyan
Write-Host "  Node.js: $nodeVersion" -ForegroundColor Gray
Write-Host "  npm: $npmVersion" -ForegroundColor Gray
Write-Host "  Docker: $dockerVersion" -ForegroundColor Gray
Write-Host ""

# Check if dockerode is installed
Show-Info "Checking for dockerode module..."
$packageJson = Get-Content -Path "package.json" -Raw | ConvertFrom-Json
$hasDockerade = $false

if ($packageJson.dependencies -and $packageJson.dependencies.dockerode) {
    # Check if actually installed
    if (Test-Path "node_modules\dockerode") {
        Show-Success "dockerode module is installed"
        $hasDockerade = $true
    } else {
        Show-Warning "dockerode is in package.json but not installed"
    }
}

# Install Node dependencies
Show-Info "Installing Node.js dependencies..."
try {
    # Install with dockerode specifically mentioned
    npm install
    if ($LASTEXITCODE -ne 0) {
        throw "npm install failed"
    }
    
    # Ensure dockerode is installed
    if (-not $hasDockerade) {
        Show-Info "Installing dockerode for Docker container management..."
        npm install dockerode
        if ($LASTEXITCODE -ne 0) {
            Show-Warning "Failed to install dockerode. Container management may not work."
        } else {
            Show-Success "dockerode installed successfully"
        }
    }
    
    Show-Success "Dependencies installed successfully"
} catch {
    Show-Error "Failed to install dependencies."
    Write-Host "Error: $_" -ForegroundColor Red
    Write-Host ""
    Write-Host "Try running: npm install --force" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Press any key to exit..."
    $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
    exit 1
}

Write-Host ""

# Build Docker image
Show-Info "Building Docker image for voting nodes..."
try {
    # Check if Dockerfile exists
    if (-not (Test-Path "Dockerfile.node")) {
        Show-Error "Dockerfile.node not found in current directory"
        exit 1
    }
    
    # Build the image
    $buildOutput = & docker build -t voting-node:latest -f Dockerfile.node . 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Build output:" -ForegroundColor Gray
        Write-Host $buildOutput -ForegroundColor Gray
        throw "Docker build failed with exit code $LASTEXITCODE"
    }
    Show-Success "Docker image built successfully"
    
    # Verify image was created
    $images = docker images voting-node --format "{{.Repository}}:{{.Tag}}"
    if ($images -contains "voting-node:latest") {
        Show-Success "Image 'voting-node:latest' verified"
    } else {
        Show-Warning "Image built but not found in docker images list"
    }
} catch {
    Show-Error "Failed to build Docker image."
    Write-Host "Error details: $_" -ForegroundColor Red
    Write-Host ""
    Write-Host "Make sure Dockerfile.node exists and is valid." -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Press any key to exit..."
    $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
    exit 1
}

Write-Host ""

# Create Docker network
Show-Info "Creating Docker network..."
try {
    # Check if network already exists
    $networks = docker network ls --format "{{.Name}}"
    if ($networks -contains "voting-network") {
        Write-Host "Network 'voting-network' already exists" -ForegroundColor Gray
        
        # Inspect network to verify it's configured correctly
        $networkInfo = docker network inspect voting-network 2>&1
        if ($LASTEXITCODE -eq 0) {
            Show-Success "Network configuration verified"
        }
    } else {
        $createOutput = docker network create voting-network --subnet=172.20.0.0/16 2>&1
        if ($LASTEXITCODE -eq 0) {
            Show-Success "Network 'voting-network' created successfully"
        } else {
            throw "Failed to create network: $createOutput"
        }
    }
} catch {
    Show-Warning "Could not create/verify network: $_"
    Write-Host "Container networking may not work optimally" -ForegroundColor Gray
}

Write-Host ""
Write-Host "======================================" -ForegroundColor Green
Write-Host "Setup complete!" -ForegroundColor Green
Write-Host "======================================" -ForegroundColor Green
Write-Host ""

# Check if manager files exist
$requiredFiles = @(
    "manager-docker.js",
    "voting-node.js",
    "voting-gui.html",
    "register-docker.html"
)

$missingFiles = @()
foreach ($file in $requiredFiles) {
    if (-not (Test-Path $file)) {
        $missingFiles += $file
    }
}

if ($missingFiles.Count -gt 0) {
    Show-Error "Missing required files:"
    foreach ($file in $missingFiles) {
        Write-Host "  - $file" -ForegroundColor Red
    }
    Write-Host ""
    Write-Host "Please ensure all files are in the current directory." -ForegroundColor Yellow
    Write-Host "Press any key to exit..."
    $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
    exit 1
}

# Option to clean up existing containers
Write-Host "Checking for existing voting node containers..." -ForegroundColor Cyan
$existingContainers = docker ps -a --filter "name=voting-node" --format "{{.Names}}"
if ($existingContainers) {
    Write-Host "Found existing containers:" -ForegroundColor Yellow
    $existingContainers | ForEach-Object { Write-Host "  - $_" -ForegroundColor Gray }
    
    $response = Read-Host "Do you want to remove existing containers? (y/n)"
    if ($response -eq 'y' -or $response -eq 'Y') {
        Show-Info "Removing existing containers..."
        docker stop $existingContainers 2>&1 | Out-Null
        docker rm $existingContainers 2>&1 | Out-Null
        Show-Success "Existing containers removed"
    }
}

Write-Host ""
Write-Host "Starting the manager service..." -ForegroundColor Cyan
Write-Host ""
Write-Host "======================================" -ForegroundColor Green
Write-Host "Manager will be available at:" -ForegroundColor Green
Write-Host "http://localhost:8080/register-docker.html" -ForegroundColor Cyan
Write-Host "======================================" -ForegroundColor Green
Write-Host ""
Write-Host "⚠️ IMPORTANT: Docker Desktop must remain running!" -ForegroundColor Yellow
Write-Host "The manager needs Docker to create containers." -ForegroundColor Gray
Write-Host ""
Write-Host "Press Ctrl+C to stop the manager" -ForegroundColor Yellow
Write-Host ""

# Function to open URL in default browser
function Open-Browser {
    param($Url)
    try {
        # Try different methods to open browser
        if ($IsWindows -or $PSVersionTable.Platform -eq 'Win32NT' -or (-not $PSVersionTable.Platform)) {
            # Windows
            Start-Process $Url
        } elseif ($IsMacOS -or $PSVersionTable.Platform -eq 'Unix' -and (uname) -eq 'Darwin') {
            # macOS
            & open $Url
        } else {
            # Linux
            & xdg-open $Url
        }
        Show-Success "Browser opened with manager interface"
    } catch {
        Show-Warning "Could not auto-open browser. Please navigate to: $Url"
    }
}

# Function to wait for manager to be ready
function Wait-ForManager {
    param($Url, $MaxAttempts = 30)
    
    Show-Info "Waiting for manager service to be ready..."
    
    for ($i = 1; $i -le $MaxAttempts; $i++) {
        try {
            $response = Invoke-WebRequest -Uri "$Url/api/health" -Method Get -UseBasicParsing -TimeoutSec 2 -ErrorAction SilentlyContinue
            if ($response.StatusCode -eq 200) {
                Show-Success "Manager service is ready!"
                return $true
            }
        } catch {
            # Service not ready yet
        }
        
        if ($i % 5 -eq 0) {
            Write-Host "   Still waiting... ($i/$MaxAttempts)" -ForegroundColor Gray
        }
        Start-Sleep -Seconds 1
    }
    
    Show-Warning "Manager service took longer than expected to start"
    return $false
}

# Function to cleanup on exit
function Cleanup {
    Write-Host ""
    Write-Host "Shutting down..." -ForegroundColor Yellow
    
    # First, clean up ALL voting node containers directly
    Write-Host "Checking for running containers..." -ForegroundColor Yellow
    $runningContainers = docker ps --filter "name=voting-node" --format "{{.Names}}"
    
    if ($runningContainers) {
        Write-Host "Found running containers:" -ForegroundColor Yellow
        $runningContainers | ForEach-Object { Write-Host "  - $_" -ForegroundColor Gray }
        
        $response = Read-Host "Stop and remove all voting node containers? (y/n)"
        if ($response -eq 'y' -or $response -eq 'Y') {
            Show-Info "Stopping containers..."
            docker stop $runningContainers 2>&1 | Out-Null
            Show-Info "Removing containers..."
            docker rm $runningContainers 2>&1 | Out-Null
            Show-Success "Containers cleaned up"
        }
    } else {
        Write-Host "No containers to clean up" -ForegroundColor Gray
    }
    
    exit 0
}

# Alternative: Run manager directly with trap for Ctrl+C
trap {
    Write-Host "`n`nCtrl+C detected - initiating shutdown..." -ForegroundColor Yellow
    
    # Kill all node processes (manager)
    Get-Process -Name "node" -ErrorAction SilentlyContinue | Where-Object {
        $_.CommandLine -like "*manager-docker.js*"
    } | Stop-Process -Force -ErrorAction SilentlyContinue
    
    Cleanup
}

# Launch browser after a delay
Show-Info "Browser will open in 3 seconds..."
Start-Job -ScriptBlock {
    Start-Sleep -Seconds 3
    Start-Process "http://localhost:8080/register-docker.html"
} | Out-Null

Write-Host "Press Ctrl+C to stop the manager and clean up containers" -ForegroundColor Yellow
Write-Host ""

# Run the manager directly (not in a background job)
try {
    node manager-docker.js
} catch {
    Write-Host ""
    Show-Error "Manager exited with error: $_"
} finally {
    Cleanup
}