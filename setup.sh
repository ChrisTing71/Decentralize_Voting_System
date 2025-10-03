#!/bin/bash

# P2P Voting System - Docker Setup Script (macOS/Linux)
# Run with: chmod +x setup.sh && ./setup.sh

echo "======================================"
echo "P2P Voting System - Docker Setup"
echo "======================================"
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
GRAY='\033[0;37m'
NC='\033[0m' # No Color

# Function to check command availability
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Function to display errors
show_error() {
    echo -e "${RED} $1${NC}"
}

# Function to display success
show_success() {
    echo -e "${GREEN} $1${NC}"
}

# Function to display info
show_info() {
    echo -e "${YELLOW} $1${NC}"
}

# Function to display warning
show_warning() {
    echo -e "${YELLOW} $1${NC}"
}

# Check if Docker is installed
if ! command_exists docker; then
    show_error "Docker is not installed or not in PATH."
    echo -e "${YELLOW}Please install Docker Desktop for macOS from:${NC}"
    echo -e "${CYAN}https://docs.docker.com/desktop/install/mac-install/${NC}"
    echo ""
    echo "Press any key to exit..."
    read -n 1 -s
    exit 1
fi

# Check if Docker is running
if ! docker info >/dev/null 2>&1; then
    show_error "Docker is installed but not running."
    echo ""
    echo -e "${YELLOW}Please start Docker Desktop and wait for it to fully initialize.${NC}"
    echo -e "${GRAY}Docker Desktop usually takes 30-60 seconds to start.${NC}"
    echo ""
    echo -e "${YELLOW}If Docker Desktop is running but still showing this error:${NC}"
    echo -e "${GRAY}1. Open Docker Desktop from Applications${NC}"
    echo -e "${GRAY}2. Wait for the whale icon to become active in the menu bar${NC}"
    echo -e "${GRAY}3. Run this script again${NC}"
    echo ""
    echo "Press any key to exit..."
    read -n 1 -s
    exit 1
fi

show_success "Docker is installed and running"

# Display Docker version
docker_version=$(docker version --format "{{.Server.Version}}" 2>/dev/null)
if [ ! -z "$docker_version" ]; then
    echo -e "${GRAY}   Docker version: $docker_version${NC}"
fi

echo ""

# Check if Node.js is installed
if ! command_exists node; then
    show_error "Node.js is not installed."
    echo -e "${YELLOW}Please install Node.js from: https://nodejs.org/${NC}"
    echo -e "${YELLOW}Or use Homebrew: brew install node${NC}"
    echo ""
    echo "Press any key to exit..."
    read -n 1 -s
    exit 1
fi

# Check if npm is installed
if ! command_exists npm; then
    show_error "npm is not installed."
    echo -e "${YELLOW}npm should come with Node.js. Please reinstall Node.js.${NC}"
    echo ""
    echo "Press any key to exit..."
    read -n 1 -s
    exit 1
fi

# Display versions
node_version=$(node --version)
npm_version=$(npm --version)
docker_version=$(docker --version)

echo -e "${CYAN}System Information:${NC}"
echo -e "${GRAY}  Node.js: $node_version${NC}"
echo -e "${GRAY}  npm: $npm_version${NC}"
echo -e "${GRAY}  Docker: $docker_version${NC}"
echo ""

# Check if dockerode is installed
show_info "Checking for dockerode module..."
has_dockerode=false

if [ -f "package.json" ]; then
    if grep -q '"dockerode"' package.json; then
        # Check if actually installed
        if [ -d "node_modules/dockerode" ]; then
            show_success "dockerode module is installed"
            has_dockerode=true
        else
            show_warning "dockerode is in package.json but not installed"
        fi
    fi
fi

# Install Node dependencies
show_info "Installing Node.js dependencies..."
if npm install; then
    # Ensure dockerode is installed
    if [ "$has_dockerode" = false ]; then
        show_info "Installing dockerode for Docker container management..."
        if npm install dockerode; then
            show_success "dockerode installed successfully"
        else
            show_warning "Failed to install dockerode. Container management may not work."
        fi
    fi
    
    show_success "Dependencies installed successfully"
else
    show_error "Failed to install dependencies."
    echo ""
    echo -e "${YELLOW}Try running: npm install --force${NC}"
    echo ""
    echo "Press any key to exit..."
    read -n 1 -s
    exit 1
fi

echo ""

# Build Docker image
show_info "Building Docker image for voting nodes..."

# Check if Dockerfile exists
if [ ! -f "Dockerfile.node" ]; then
    show_error "Dockerfile.node not found in current directory"
    exit 1
fi

# Build the image
if docker build -t voting-node:latest -f Dockerfile.node .; then
    show_success "Docker image built successfully"
    
    # Verify image was created
    if docker images voting-node --format "{{.Repository}}:{{.Tag}}" | grep -q "voting-node:latest"; then
        show_success "Image 'voting-node:latest' verified"
    else
        show_warning "Image built but not found in docker images list"
    fi
else
    show_error "Failed to build Docker image."
    echo ""
    echo -e "${YELLOW}Make sure Dockerfile.node exists and is valid.${NC}"
    echo ""
    echo "Press any key to exit..."
    read -n 1 -s
    exit 1
fi

echo ""

# Create Docker network
show_info "Creating Docker network..."

# Check if network already exists
if docker network ls --format "{{.Name}}" | grep -q "^voting-network$"; then
    echo -e "${GRAY}Network 'voting-network' already exists${NC}"
    
    # Inspect network to verify it's configured correctly
    if docker network inspect voting-network >/dev/null 2>&1; then
        show_success "Network configuration verified"
    fi
else
    if docker network create voting-network --subnet=172.20.0.0/16; then
        show_success "Network 'voting-network' created successfully"
    else
        show_warning "Could not create network. Container networking may not work optimally"
    fi
fi

echo ""
echo -e "${GREEN}======================================${NC}"
echo -e "${GREEN}Setup complete!${NC}"
echo -e "${GREEN}======================================${NC}"
echo ""

# Check if manager files exist
required_files=("manager-docker.js" "voting-node.js" "voting-gui.html" "register-docker.html")
missing_files=()

for file in "${required_files[@]}"; do
    if [ ! -f "$file" ]; then
        missing_files+=("$file")
    fi
done

if [ ${#missing_files[@]} -gt 0 ]; then
    show_error "Missing required files:"
    for file in "${missing_files[@]}"; do
        echo -e "${RED}  - $file${NC}"
    done
    echo ""
    echo -e "${YELLOW}Please ensure all files are in the current directory.${NC}"
    echo "Press any key to exit..."
    read -n 1 -s
    exit 1
fi

# Option to clean up existing containers
echo -e "${CYAN}Checking for existing voting node containers...${NC}"
existing_containers=$(docker ps -a --filter "name=voting-node" --format "{{.Names}}")
if [ ! -z "$existing_containers" ]; then
    echo -e "${YELLOW}Found existing containers:${NC}"
    echo "$existing_containers" | while read container; do
        echo -e "${GRAY}  - $container${NC}"
    done
    
    echo -n "Do you want to remove existing containers? (y/n): "
    read response
    if [[ "$response" =~ ^[Yy]$ ]]; then
        show_info "Removing existing containers..."
        echo "$existing_containers" | xargs docker stop >/dev/null 2>&1
        echo "$existing_containers" | xargs docker rm >/dev/null 2>&1
        show_success "Existing containers removed"
    fi
fi

echo ""
echo -e "${CYAN}Starting the manager service...${NC}"
echo ""
echo -e "${GREEN}======================================${NC}"
echo -e "${GREEN}Manager will be available at:${NC}"
echo -e "${CYAN}http://localhost:8080/register-docker.html${NC}"
echo -e "${GREEN}======================================${NC}"
echo ""
echo -e "${YELLOW} IMPORTANT: Docker Desktop must remain running!${NC}"
echo -e "${GRAY}The manager needs Docker to create containers.${NC}"
echo ""
echo -e "${YELLOW}Press Ctrl+C to stop the manager${NC}"
echo ""

# Function to open URL in default browser
open_browser() {
    local url=$1
    if command_exists open; then
        # macOS
        open "$url" 2>/dev/null && show_success "Browser opened with manager interface"
    elif command_exists xdg-open; then
        # Linux
        xdg-open "$url" 2>/dev/null && show_success "Browser opened with manager interface"
    else
        show_warning "Could not auto-open browser. Please navigate to: $url"
    fi
}

# Function to wait for manager to be ready
wait_for_manager() {
    local url=$1
    local max_attempts=30
    
    show_info "Waiting for manager service to be ready..."
    
    for ((i=1; i<=max_attempts; i++)); do
        if curl -s -f "$url/api/health" >/dev/null 2>&1; then
            show_success "Manager service is ready!"
            return 0
        fi
        
        if ((i % 5 == 0)); then
            echo -e "${GRAY}   Still waiting... ($i/$max_attempts)${NC}"
        fi
        sleep 1
    done
    
    show_warning "Manager service took longer than expected to start"
    return 1
}

# Function to cleanup on exit
cleanup() {
    echo ""
    echo -e "${YELLOW}Shutting down...${NC}"
    
    # Clean up ALL voting node containers directly
    echo -e "${YELLOW}Checking for running containers...${NC}"
    running_containers=$(docker ps --filter "name=voting-node" --format "{{.Names}}")
    
    if [ ! -z "$running_containers" ]; then
        echo -e "${YELLOW}Found running containers:${NC}"
        echo "$running_containers" | while read container; do
            echo -e "${GRAY}  - $container${NC}"
        done
        
        echo -n "Stop and remove all voting node containers? (y/n): "
        read response
        if [[ "$response" =~ ^[Yy]$ ]]; then
            show_info "Stopping containers..."
            echo "$running_containers" | xargs docker stop >/dev/null 2>&1
            show_info "Removing containers..."
            echo "$running_containers" | xargs docker rm >/dev/null 2>&1
            show_success "Containers cleaned up"
        fi
    else
        echo -e "${GRAY}No containers to clean up${NC}"
    fi
    
    exit 0
}

# Set trap for Ctrl+C
trap cleanup INT TERM

# Launch browser after a delay
show_info "Browser will open in 3 seconds..."
(sleep 3 && open_browser "http://localhost:8080/register-docker.html") &

echo -e "${YELLOW}Press Ctrl+C to stop the manager and clean up containers${NC}"
echo ""

# Run the manager
if node manager-docker.js; then
    echo ""
else
    echo ""
    show_error "Manager exited with error"
fi

cleanup
