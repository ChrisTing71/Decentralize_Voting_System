// manager-docker.js - Enhanced manager for Docker container deployment
const express = require('express');
const cors = require('cors');
const { exec, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// Check if dockerode is installed
let Docker;
try {
    Docker = require('dockerode');
} catch (error) {
    console.error('⚠️ dockerode module not found. Please run: npm install dockerode');
    console.error('Continuing without Docker support...');
}

const app = express();
const PORT = 8080;

// Initialize Docker with proper Windows support
let docker = null;
let dockerAvailable = false;

if (Docker) {
    try {
        // For Windows, try to connect to Docker Desktop
        if (process.platform === 'win32') {
            // Try Windows named pipe first
            docker = new Docker({ socketPath: '//./pipe/docker_engine' });
        } else {
            // For Linux/Mac
            docker = new Docker();
        }
        
        // Test Docker connection
        docker.ping((err, data) => {
            if (err) {
                console.error('⚠️ Cannot connect to Docker:', err.message);
                console.log('Make sure Docker Desktop is running');
                dockerAvailable = false;
            } else {
                console.log('✅ Connected to Docker successfully');
                dockerAvailable = true;
                ensureNetwork();
            }
        });
    } catch (error) {
        console.error('⚠️ Failed to initialize Docker:', error.message);
    }
}

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const runningNodes = {};
const containerNodes = {}; // Track Docker containers

// Test Docker availability
app.get('/api/docker-status', (req, res) => {
    res.json({
        available: dockerAvailable,
        platform: process.platform,
        message: dockerAvailable ? 'Docker is connected' : 'Docker is not available'
    });
});

// Get container network info
async function getContainerIP(containerName) {
    try {
        if (!docker || !dockerAvailable) return null;
        
        const container = docker.getContainer(containerName);
        const info = await container.inspect();
        return info.NetworkSettings.Networks['voting-network']?.IPAddress || 
               info.NetworkSettings.Networks['bridge']?.IPAddress || 
               'localhost';
    } catch (error) {
        console.error(`Error getting IP for ${containerName}:`, error.message);
        return null;
    }
}

// API Endpoints
app.get('/api/nodes', async (req, res) => {
    const nodesInfo = [];
    
    if (!dockerAvailable) {
        return res.json(nodesInfo);
    }
    
    // Get container nodes
    for (const [nodeName, containerInfo] of Object.entries(containerNodes)) {
        try {
            const container = docker.getContainer(containerInfo.containerId);
            const info = await container.inspect();
            const ip = info.NetworkSettings.Networks['voting-network']?.IPAddress || 
                      info.NetworkSettings.Networks['bridge']?.IPAddress || 
                      'unknown';
            
            nodesInfo.push({
                name: nodeName,
                port: containerInfo.port,
                status: info.State.Running ? 'running' : 'stopped',
                type: 'container',
                containerId: containerInfo.containerId,
                ip: ip,
                accessUrl: `http://localhost:${containerInfo.port}`
            });
        } catch (error) {
            console.error(`Error inspecting container ${nodeName}:`, error.message);
        }
    }
    
    res.json(nodesInfo);
});

// Launch node in Docker container
app.post('/api/launch-node', async (req, res) => {
    const { nodeName, port, peers } = req.body;

    if (!nodeName || !port) {
        return res.status(400).json({ 
            success: false, 
            message: 'Node name and port are required.' 
        });
    }

    if (!dockerAvailable) {
        return res.status(500).json({ 
            success: false, 
            message: 'Docker is not available. Make sure Docker Desktop is running.' 
        });
    }

    if (containerNodes[nodeName]) {
        return res.status(400).json({ 
            success: false, 
            message: `Node '${nodeName}' is already running.` 
        });
    }

    try {
        // First check if the image exists
        const images = await docker.listImages();
        const imageExists = images.some(img => 
            img.RepoTags && img.RepoTags.includes('voting-node:latest')
        );
        
        if (!imageExists) {
            console.log('⚠️ Docker image not found, building it now...');
            await buildDockerImage();
        }

        // Build peer connection strings
        const peerConnections = [];
        if (peers && peers.length > 0) {
            for (const peer of peers) {
                const [host, peerPort] = peer.includes(':') ? 
                    peer.split(':') : ['localhost', peer];
                
                // Find if this peer is a container
                const peerNode = Object.entries(containerNodes)
                    .find(([_, info]) => info.port === parseInt(peerPort || peer));
                
                if (peerNode) {
                    // Get the container's IP within the Docker network
                    const peerContainerName = `voting-node-${peerNode[0]}`;
                    const peerIP = await getContainerIP(peerContainerName);
                    if (peerIP && peerIP !== 'localhost') {
                        // Use the container's internal IP and its internal port (port)
                        peerConnections.push(`${peerIP}:${peerNode[1].port}`);
                        console.log(`Peer ${peerNode[0]} will be accessed at ${peerIP}:${peerNode[1].port}`);
                    } else {
                        // Fallback to container name (Docker DNS)
                        peerConnections.push(`${peerContainerName}:${peerNode[1].port}`);
                    }
                } else {
                    // For non-container peers, don't try to connect (they're outside the network)
                    console.log(`Warning: Peer on port ${peerPort || peer} is not a container, skipping`);
                }
            }
        }

        // Create container with proper configuration
        const containerName = `voting-node-${nodeName}`;
        
        console.log(`Creating container for ${nodeName}...`);
        
        // Check if voting-network exists, if not use bridge
        const networks = await docker.listNetworks();
        const votingNetworkExists = networks.some(n => n.Name === 'voting-network');
        const networkMode = votingNetworkExists ? 'voting-network' : 'bridge';
        
        const container = await docker.createContainer({
            Image: 'voting-node:latest',
            name: containerName,
            Hostname: nodeName,
            Tty: true,           // Allocate a pseudo-TTY
            OpenStdin: true,     // Keep stdin open
            AttachStdin: false,  // Don't attach stdin
            AttachStdout: false, // Don't attach stdout  
            AttachStderr: false, // Don't attach stderr
            ExposedPorts: {
                [`${port}/tcp`]: {},
                '41234/udp': {}  // UDP discovery port - same for all containers
            },
            HostConfig: {
                PortBindings: {
                    [`${port}/tcp`]: [{ HostPort: port.toString() }]
                    // Don't map UDP port to host - let containers communicate internally
                },
                NetworkMode: networkMode,
                RestartPolicy: { Name: 'no' },
                AutoRemove: false
            },
            Env: [
                `NODE_NAME=${nodeName}`,
                `NODE_PORT=${port}`,
                `PEERS=${peerConnections.join(' ')}`,
                `BROADCAST_ADDRESS=172.20.255.255`  // Broadcast address for voting-network
            ],
            Cmd: [nodeName, port.toString(), ...peerConnections]
        });

        await container.start();
        
        // Get container info
        const containerInfo = await container.inspect();
        const containerIp = containerInfo.NetworkSettings.Networks[networkMode]?.IPAddress || 'bridge';
        
        containerNodes[nodeName] = {
            containerId: container.id,
            port: port,
            ip: containerIp,
            peers: peerConnections
        };

        console.log(`✅ Container ${containerName} started`);
        console.log(`   - Container IP: ${containerIp}`);
        console.log(`   - Host Port: ${port}`);
        console.log(`   - Peers: ${peerConnections.join(', ') || 'none'}`);

        res.status(200).json({ 
            success: true, 
            message: `Node ${nodeName} launched in Docker container!`,
            containerIp: containerIp,
            port: port,
            accessUrl: `http://localhost:${port}`
        });

    } catch (error) {
        console.error(`Error launching container for ${nodeName}:`, error);
        res.status(500).json({ 
            success: false, 
            message: `Failed to launch container: ${error.message}` 
        });
    }
});

// Stop Docker container node
app.post('/api/stop-node', async (req, res) => {
    const { nodeName } = req.body;
    const nodeInfo = containerNodes[nodeName];

    if (!nodeInfo) {
        return res.status(404).json({ 
            success: false, 
            message: 'Node not found.' 
        });
    }

    if (!dockerAvailable) {
        return res.status(500).json({ 
            success: false, 
            message: 'Docker is not available.' 
        });
    }

    try {
        const container = docker.getContainer(nodeInfo.containerId);
        await container.stop();
        await container.remove();
        
        delete containerNodes[nodeName];
        
        console.log(`Node ${nodeName} container stopped and removed.`);
        res.status(200).json({ 
            success: true, 
            message: `Node ${nodeName} stopped successfully.` 
        });
    } catch (error) {
        console.error(`Error stopping container ${nodeName}:`, error);
        res.status(500).json({ 
            success: false, 
            message: `Failed to stop container: ${error.message}` 
        });
    }
});

// Build Docker image
async function buildDockerImage() {
    console.log('🐳 Building Docker image for voting nodes...');
    
    // Check if Dockerfile exists
    const dockerfilePath = path.join(__dirname, 'Dockerfile.node');
    if (!fs.existsSync(dockerfilePath)) {
        console.error('❌ Dockerfile.node not found!');
        throw new Error('Dockerfile.node not found');
    }
    
    return new Promise((resolve, reject) => {
        const buildProcess = exec(
            'docker build -t voting-node:latest -f Dockerfile.node .', 
            { cwd: __dirname },
            (error, stdout, stderr) => {
                if (error) {
                    console.error('Failed to build Docker image:', error.message);
                    if (stderr) console.error('Build errors:', stderr);
                    reject(error);
                } else {
                    console.log('✅ Docker image built successfully');
                    if (stdout) console.log('Build output:', stdout);
                    resolve();
                }
            }
        );
        
        // Stream build output
        buildProcess.stdout?.on('data', (data) => {
            console.log('Build:', data.toString().trim());
        });
        
        buildProcess.stderr?.on('data', (data) => {
            console.error('Build error:', data.toString().trim());
        });
    });
}

// Ensure network exists
async function ensureNetwork() {
    if (!docker || !dockerAvailable) return;
    
    try {
        const networks = await docker.listNetworks();
        const votingNetwork = networks.find(n => n.Name === 'voting-network');
        
        if (!votingNetwork) {
            console.log('Creating voting-network...');
            await docker.createNetwork({
                Name: 'voting-network',
                Driver: 'bridge',
                EnableIPv6: false,
                IPAM: {
                    Driver: 'default',
                    Config: [{
                        Subnet: '172.20.0.0/16',
                        Gateway: '172.20.0.1'
                    }]
                },
                Options: {
                    'com.docker.network.bridge.enable_icc': 'true',  // Enable inter-container communication
                    'com.docker.network.bridge.enable_ip_masquerade': 'true'
                }
            });
            console.log('✅ Network created with subnet 172.20.0.0/16');
        } else {
            console.log('✅ Network already exists');
            // Log network details for debugging
            const networkDetails = await docker.getNetwork('voting-network').inspect();
            if (networkDetails.IPAM && networkDetails.IPAM.Config && networkDetails.IPAM.Config[0]) {
                console.log(`   Subnet: ${networkDetails.IPAM.Config[0].Subnet}`);
            }
        }
        
        // Also try to build the image if it doesn't exist
        const images = await docker.listImages();
        const imageExists = images.some(img => 
            img.RepoTags && img.RepoTags.includes('voting-node:latest')
        );
        
        if (!imageExists) {
            console.log('Docker image not found, building it...');
            await buildDockerImage();
        }
        
    } catch (error) {
        console.error('Error ensuring network/image:', error.message);
    }
}

// Cleanup function
async function cleanup() {
    if (!dockerAvailable) return;
    
    console.log('Cleaning up containers...');
    for (const [nodeName, nodeInfo] of Object.entries(containerNodes)) {
        try {
            const container = docker.getContainer(nodeInfo.containerId);
            await container.stop();
            await container.remove();
            console.log(`Cleaned up ${nodeName}`);
        } catch (error) {
            console.error(`Error cleaning up ${nodeName}:`, error.message);
        }
    }
}

// Handle shutdown
process.on('SIGINT', async () => {
    console.log('\n🛑 Shutting down manager...');
    await cleanup();
    process.exit(0);
});

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({
        status: 'running',
        docker: dockerAvailable,
        platform: process.platform,
        nodes: Object.keys(containerNodes).length
    });
});

// Start manager server
app.listen(PORT, async () => {
    console.log(`=============================================`);
    console.log(`  🐳 Docker-based P2P Voting Manager`);
    console.log(`  Control Panel: http://localhost:${PORT}/register-docker.html`);
    console.log(`=============================================`);
    
    if (!Docker) {
        console.log('\n⚠️  WARNING: dockerode module not installed!');
        console.log('   Run: npm install dockerode');
        console.log('   Container management will not work without it.\n');
    } else if (!dockerAvailable) {
        console.log('\n⚠️  WARNING: Cannot connect to Docker!');
        console.log('   Make sure Docker Desktop is running.');
        console.log('   On Windows, Docker Desktop must be running.\n');
    } else {
        console.log(`\n✅ Docker connected successfully!`);
        console.log(`   Platform: ${process.platform}`);
        console.log(`   Ready to launch voting nodes in containers!\n`);
    }
});