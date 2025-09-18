#!/usr/bin/env node

const WebSocket = require('ws');
const readline = require('readline');
const crypto = require('crypto');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const dgram = require('dgram'); // NEW: Add dgram for UDP broadcast
const DISCOVERY_PORT = 41234; // A dedicated port for UDP discovery

class VotingNodeWithAutoGUI {
    constructor(nodeId, port, knownPeers = [], options = {}) {
        this.nodeId = nodeId;
        this.port = port;
        this.knownPeers = knownPeers; // Array of {host, port}
        this.peers = new Map(); // nodeId -> WebSocket
        this.activePeers = new Set();
		this.peerAddresses = new Map(); // nodeId -> {host, port} - Track peer addresses
        this.server = null;
        this.currentRound = null;
        this.votes = new Map(); // roundId -> Map(nodeId -> vote)
        this.encryptedVotes = new Map(); // roundId -> Map(nodeId -> encryptedVote)
        this.voteKeys = new Map(); // roundId -> Map(nodeId -> decryptionKey)
        this.results = new Map();
        this.heartbeatInterval = null;
        this.myVoteTracking = new Map(); // roundId -> {anonymousVoteId, choice, timestamp, verified}
        this.hasVotedInRound = new Map(); // roundId -> boolean (track if we've voted)
        this.discoverySocket = null;
        this.discoveryInterval = null;
        // GUI options
        this.guiEnabled = options.gui !== false; // GUI enabled by default
        this.guiAutoLaunch = false; // Auto-launch disabled - use manager.js instead
        this.guiPort = options.guiPort || port; // Use same port for GUI connection
        this.guiClients = new Map(); // Track connected GUI clients
        this.nodeRegistry = new Map(); // peerId -> {nodeId, host, port, lastSeen}
		this.startupValidationComplete = false;
		this.duplicateNodeDetected = false;
        this.setupReadline();
    }

    async start() {
        console.log(`Starting node ${this.nodeId} on port ${this.port}...`);
		
		// First, validate our node ID isn't already in use
		if (this.knownPeers.length > 0) {
			console.log('🔍 Validating node ID uniqueness...');
			const isDuplicate = await this.validateNodeIdUniqueness();
			
			if (isDuplicate) {
				console.log('❌ CRITICAL ERROR: Node ID already exists on network!');
				console.log(`   The node ID '${this.nodeId}' is already in use.`);
				console.log('   Please choose a different node ID and restart.');
				console.log('\n🔧 Suggested alternatives:');
				console.log(`   - ${this.nodeId}_${Date.now().toString().slice(-4)}`);
				console.log(`   - ${this.nodeId}_${Math.random().toString(36).substr(2, 4)}`);
				console.log(`   - ${this.nodeId}_backup`);
				
				process.exit(1);
			}
		}

		// Original start method continues...
		this.server = new WebSocket.Server({ port: this.port });
		this.server.on('connection', (ws, req) => {
			this.handleIncomingConnection(ws, req);
		});
		
		console.log(`Node ${this.nodeId} listening on port ${this.port}`);
		this.startDiscovery();
		
		// Connect to known peers
		await this.connectToKnownPeers();
		
		// Final validation after connecting to network
		await this.performFinalDuplicateCheck();
		
		// Start heartbeat
		this.startHeartbeat();
		
		if (this.guiEnabled) {
			this.startGUIUpdates();
			console.log('🖥️ GUI support enabled');
			// 已移除自動打開GUI網頁功能，因為有 manager.js 提供跳轉功能
			console.log('💡 Use manager.js to launch and manage GUI interfaces');
		}
		
		this.showHelp();
    }

	async validateNodeIdUniqueness() {
		const timeout = 10000; // 10 second timeout
		const promises = this.knownPeers.map(peer => 
			this.checkPeerForDuplicateNodeId(peer.host, peer.port, timeout)
		);
		
		try {
			const results = await Promise.allSettled(promises);
			const duplicates = results
				.filter(result => result.status === 'fulfilled' && result.value.isDuplicate)
				.map(result => result.value);
			
			if (duplicates.length > 0) {
				console.log('🚨 Duplicate node ID detected on the following peers:');
				duplicates.forEach(dup => {
					console.log(`   - ${dup.address} (last seen: ${new Date(dup.lastSeen).toLocaleString()})`);
				});
				return true;
			}
			
			console.log('✅ Node ID validation passed - no duplicates found');
			return false;
			
		} catch (error) {
			console.log(`⚠️ Node ID validation failed due to error: ${error.message}`);
			console.log('Proceeding with startup but duplicate detection may be incomplete');
			return false;
		}
	}

	async checkPeerForDuplicateNodeId(host, port, timeout = 5000) {
		return new Promise((resolve) => {
			const ws = new WebSocket(`ws://${host}:${port}`);
			const timeoutId = setTimeout(() => {
				ws.close();
				resolve({ isDuplicate: false, address: `${host}:${port}`, reason: 'timeout' });
			}, timeout);
			
			let nodeListReceived = false;
			
			ws.on('open', () => {
				// Send a peer exchange request to get the network node list
				ws.send(JSON.stringify({
					type: 'PEER_EXCHANGE_REQUEST',
					from: `validator_${Date.now()}`, // Temporary ID for validation
					isValidation: true
				}));
			});
			
			ws.on('message', (data) => {
				try {
					const message = JSON.parse(data.toString());
					
					if (message.type === 'PEER_EXCHANGE_RESPONSE' && !nodeListReceived) {
						nodeListReceived = true;
						clearTimeout(timeoutId);
						ws.close();
						
						// Check if any peer has our node ID
						const duplicate = message.peers.find(peer => 
							peer.nodeId === this.nodeId
						);
						
						if (duplicate) {
							resolve({
								isDuplicate: true,
								address: `${host}:${port}`,
								duplicateNode: duplicate,
								lastSeen: Date.now()
							});
						} else {
							resolve({
								isDuplicate: false,
								address: `${host}:${port}`,
								reason: 'no_duplicate_found'
							});
						}
					}
					
					// Also check handshake responses
					if ((message.type === 'HANDSHAKE' || message.type === 'HANDSHAKE_ACK') && message.from === this.nodeId) {
						clearTimeout(timeoutId);
						ws.close();
						resolve({
							isDuplicate: true,
							address: `${host}:${port}`,
							duplicateNode: { nodeId: message.from },
							lastSeen: Date.now()
						});
					}
					
				} catch (error) {
					// Ignore parsing errors
				}
			});
			
			ws.on('error', () => {
				clearTimeout(timeoutId);
				resolve({ isDuplicate: false, address: `${host}:${port}`, reason: 'connection_error' });
			});
			
			ws.on('close', () => {
				clearTimeout(timeoutId);
				if (!nodeListReceived) {
					resolve({ isDuplicate: false, address: `${host}:${port}`, reason: 'no_response' });
				}
			});
		});
	}
	
// Enhanced handleMessage to detect duplicate nodes during runtime
	handleMessage(message, ws) {
		// Detect duplicate node IDs during handshake
		if ((message.type === 'HANDSHAKE' || message.type === 'HANDSHAKE_ACK') && message.from === this.nodeId) {
			console.log('🚨 DUPLICATE NODE ID DETECTED!');
			console.log(`   Another node with ID '${this.nodeId}' is trying to connect`);
			console.log('   This can cause serious network issues. Rejecting connection.');
			
			// Send rejection message
			ws.send(JSON.stringify({
				type: 'DUPLICATE_NODE_REJECTION',
				reason: 'Node ID already exists on network',
				existingNodeId: this.nodeId,
				message: 'Please choose a different node ID and restart'
			}));
			
			// Close the connection
			ws.close();
			return;
		}
		
		// Track all known nodes in the network
		if (message.from && message.from !== this.nodeId) {
			this.nodeRegistry.set(message.from, {
				nodeId: message.from,
				lastSeen: Date.now(),
				connection: ws
			});
		}
		
		// Handle duplicate rejection (if we're the duplicate)
		if (message.type === 'DUPLICATE_NODE_REJECTION') {
			console.log('❌ FATAL ERROR: This node ID is already in use on the network!');
			console.log(`   Message from network: ${message.message}`);
			console.log(`   Existing node: ${message.existingNodeId}`);
			console.log('\n🔧 To fix this issue:');
			console.log('   1. Stop this node (Ctrl+C)');
			console.log('   2. Choose a different node ID');
			console.log('   3. Restart with the new ID');
			
			this.duplicateNodeDetected = true;
			
			// Prevent further operations
			setTimeout(() => {
				console.log('\nShutting down due to duplicate node ID...');
				process.exit(1);
			}, 3000);
			
			return;
		}
		
		// Continue with original message handling
		this.originalHandleMessage(message, ws);
	}

	async performFinalDuplicateCheck() {
		console.log('🔍 Performing final duplicate node check...');
		
		// Wait a moment for network to stabilize
		await new Promise(resolve => setTimeout(resolve, 2000));
		
		// Check all connected peers for duplicates
		const connectedNodeIds = new Set();
		
		for (const [peerId, ws] of this.peers) {
			if (this.activePeers.has(peerId)) {
				if (connectedNodeIds.has(peerId)) {
					console.log(`🚨 Multiple connections detected for node ID: ${peerId}`);
					console.log('   This indicates a duplicate node problem');
				} else {
					connectedNodeIds.add(peerId);
				}
			}
		}
		
		console.log(`✅ Final validation complete. Connected to ${connectedNodeIds.size} unique nodes`);
		this.startupValidationComplete = true;
	}

	launchGUI() {
		// 已移除自動打開GUI網頁功能，因為有 manager.js 提供跳轉功能
		const guiFile = 'voting-gui.html';
		const guiPath = path.join(__dirname, guiFile);
		
		if (fs.existsSync(guiPath)) {
			const peers = this.knownPeers.map(p => `${p.host}:${p.port}`).join(',');
			const timestamp = Date.now();
			const randomId = Math.random().toString(36).substring(7);
			const url = `file:///${guiPath.replace(/\\/g, '/')}?nodeId=${this.nodeId}&host=localhost&port=${this.port}&peers=${peers}&t=${timestamp}&r=${randomId}&node=${this.nodeId}`;
			
			console.log('🌐 GUI URL for node', this.nodeId);
			console.log('📡 Connection: localhost:' + this.port);
			console.log('� URL:', url);
			console.log('💡 Use manager.js to launch this GUI automatically');
		} else {
			console.log('⚠️ GUI file not found:', guiPath);
			console.log('   Make sure voting-gui.html is in the same directory');
		}
	}
	
	startDiscovery() {
        this.discoverySocket = dgram.createSocket('udp4');

        this.discoverySocket.on('listening', () => {
            const address = this.discoverySocket.address();
            console.log(`📡 LAN discovery service listening on ${address.address}:${address.port}`);
            this.discoverySocket.setBroadcast(true);

            // Start broadcasting our presence periodically
            this.discoveryInterval = setInterval(() => this.broadcastPresence(), 5000);
            this.broadcastPresence(); // Broadcast immediately on start
        });

        this.discoverySocket.on('message', (message, rinfo) => {
            try {
                const peerInfo = JSON.parse(message.toString());

                // Ignore messages from ourselves
                if (peerInfo.nodeId === this.nodeId) {
                    return;
                }

                // Check if we are already connected or trying to connect
                const isConnected = this.peers.has(peerInfo.nodeId);
                const isKnown = Array.from(this.peerAddresses.values()).some(addr => addr.host === rinfo.address && addr.port === peerInfo.port);

                if (!isConnected && !isKnown) {
                    console.log(`👋 Discovered peer ${peerInfo.nodeId} at ${rinfo.address}:${peerInfo.port}`);
                    // Attempt to connect to the discovered peer
                    this.connectToPeer(rinfo.address, peerInfo.port).catch(err => {
                        console.log(`❌ Failed to connect to discovered peer ${peerInfo.nodeId}: ${err.message}`);
                    });
                }
            } catch (error) {
                console.error('Error processing discovery message:', error);
            }
        });

        this.discoverySocket.on('error', (err) => {
            console.error(`Discovery service error:\n${err.stack}`);
            this.discoverySocket.close();
        });

        this.discoverySocket.bind(DISCOVERY_PORT);
    }
	
	broadcastPresence() {
        const message = JSON.stringify({
            nodeId: this.nodeId,
            port: this.port // This is our WebSocket port
        });
        const messageBuffer = Buffer.from(message);

        // Broadcast to the entire LAN
        this.discoverySocket.send(messageBuffer, 0, messageBuffer.length, DISCOVERY_PORT, '255.255.255.255', (err) => {
            if (err) {
                console.error('Failed to broadcast presence:', err);
            }
        });
    }
    
    async connectToKnownPeers() {
        console.log(`🌐 Connecting to ${this.knownPeers.length} known peers...`);
        
        for (const peer of this.knownPeers) {
            try {
                await this.connectToPeer(peer.host, peer.port);
                // Small delay between connections to avoid overwhelming
                await new Promise(resolve => setTimeout(resolve, 500));
            } catch (error) {
                console.log(`Failed to connect to ${peer.host}:${peer.port} - ${error.message}`);
            }
        }
        
        console.log(`✅ Connection phase complete. Connected to ${this.peers.size} peers.`);
    }
	
	async processPeerExchange(receivedPeers, fromNode) {
		console.log(`🔍 Received ${receivedPeers.length} peers from ${fromNode}:`);
		
		// Log all received peers for debugging
		for (const peer of receivedPeers) {
			console.log(`  - ${peer.nodeId || 'unknown'}@${peer.host}:${peer.port}`);
		}
		
		let newConnectionAttempts = 0;
		
		for (const peerInfo of receivedPeers) {
			console.log(`\n🔎 Evaluating peer: ${peerInfo.nodeId || 'unknown'}@${peerInfo.host}:${peerInfo.port}`);
			
			// Skip if this is ourselves
			if (peerInfo.nodeId === this.nodeId) {
				console.log(`  ⏭️ Skipping self (${this.nodeId})`);
				continue;
			}
			
			// Skip if we're already connected to this peer
			if (peerInfo.nodeId && this.peers.has(peerInfo.nodeId)) {
				console.log(`  ⏭️ Already connected to ${peerInfo.nodeId}`);
				continue;
			}
			
			// Skip if we don't have enough info to connect
			if (!peerInfo.host || !peerInfo.port) {
				console.log(`  ⏭️ Missing connection info (host: ${peerInfo.host}, port: ${peerInfo.port})`);
				continue;
			}
			
			// Skip if this peer is already in our known peers list
			const alreadyKnown = this.knownPeers.some(known => 
				known.host === peerInfo.host && known.port === peerInfo.port
			);
			
			if (alreadyKnown) {
				console.log(`  ⏭️ Already in known peers list`);
				continue;
			}
			
			// Skip if this is the same as our own address
			if (peerInfo.host === 'localhost' && peerInfo.port === this.port) {
				console.log(`  ⏭️ Skipping our own address (localhost:${this.port})`);
				continue;
			}
			
			// Attempt to connect to this new peer
			console.log(`  🌐 Will attempt connection to: ${peerInfo.nodeId || 'unknown'}@${peerInfo.host}:${peerInfo.port}`);
			
			try {
				// Add to our known peers list for future reference
				this.knownPeers.push({
					host: peerInfo.host,
					port: peerInfo.port
				});
				
				// Attempt connection with a small delay to avoid overwhelming
				setTimeout(async () => {
					console.log(`🔗 Starting connection attempt to ${peerInfo.host}:${peerInfo.port}...`);
					try {
						await this.connectToPeer(peerInfo.host, peerInfo.port);
						console.log(`✅ Successfully connected to discovered peer ${peerInfo.host}:${peerInfo.port}`);
					} catch (error) {
						console.log(`❌ Failed to connect to discovered peer ${peerInfo.host}:${peerInfo.port}: ${error.message}`);
						// Remove from known peers if connection failed
						this.knownPeers = this.knownPeers.filter(known => 
							!(known.host === peerInfo.host && known.port === peerInfo.port)
						);
					}
				}, newConnectionAttempts * 2000); // Increased delay to 2 seconds between attempts
				
				newConnectionAttempts++;
				
				// Limit the number of simultaneous connection attempts
				if (newConnectionAttempts >= 3) {
					console.log(`⚠️ Limiting peer discovery to 3 simultaneous connections`);
					break;
				}
				
			} catch (error) {
				console.log(`❌ Error processing peer ${peerInfo.host}:${peerInfo.port}: ${error.message}`);
			}
		}
		
		if (newConnectionAttempts > 0) {
			console.log(`🚀 Attempting to connect to ${newConnectionAttempts} newly discovered peers`);
		} else {
			console.log(`📋 No new peers to connect to from ${fromNode}`);
		}
	}
	
	sendPeerList(ws) {
		const peerList = this.getKnownPeersList();
		
		ws.send(JSON.stringify({
			type: 'PEER_EXCHANGE_RESPONSE',
			from: this.nodeId,
			peers: peerList
		}));
		
		console.log(`📋 Sent peer list (${peerList.length} peers) to requesting node`);
	}
	
	getKnownPeersList() {
		const peersList = [];
		
		// Add our originally known peers
		for (const peer of this.knownPeers) {
			peersList.push({
				nodeId: null, // We might not know their nodeId yet
				host: peer.host,
				port: peer.port
			});
		}
		
		// Add currently connected peers with their tracked addresses
		for (const [peerId, ws] of this.peers) {
			if (this.activePeers.has(peerId)) {
				const address = this.peerAddresses.get(peerId);
				if (address) {
					peersList.push({
						nodeId: peerId,
						host: address.host,
						port: address.port
					});
				}
			}
		}
		
		console.log(`📋 Sharing ${peersList.length} known peers:`, peersList.map(p => `${p.nodeId || 'unknown'}@${p.host}:${p.port}`));
		return peersList;
	}

    async connectToPeer(host, port) {
		const peerAddress = `${host}:${port}`;
		console.log(`🔗 Attempting to connect to ${peerAddress}`);
		
		return new Promise((resolve, reject) => {
			const ws = new WebSocket(`ws://${host}:${port}`);
			let handshakeReceived = false;
			
			ws.on('open', () => {
				console.log(`✅ Connected to ${peerAddress}`);
				// Send handshake with duplicate detection info
				ws.send(JSON.stringify({
					type: 'HANDSHAKE',
					from: this.nodeId,
					port: this.port,
					knownPeers: this.getKnownPeersList(),
					startupTime: Date.now() // Help resolve conflicts
				}));
				resolve();
			});
			
			ws.on('message', (data) => {
				try {
					const message = JSON.parse(data.toString());
					
					// Check for duplicate rejection before processing other messages
					if (message.type === 'DUPLICATE_NODE_REJECTION') {
						console.log(`❌ Connection rejected by ${peerAddress}: ${message.reason}`);
						ws.close();
						reject(new Error('Duplicate node ID detected'));
						return;
					}
					
					this.handleMessage(message, ws);
				} catch (error) {
					console.error('Error handling message:', error);
				}
			});
			
			ws.on('close', () => {
				console.log(`❌ Connection to ${peerAddress} closed`);
				// Find and remove this peer
				for (const [peerId, peerWs] of this.peers.entries()) {
					if (peerWs === ws) {
						this.peers.delete(peerId);
						this.activePeers.delete(peerId);
						this.nodeRegistry.delete(peerId);
						console.log(`Disconnected from ${peerId}`);
						break;
					}
				}
			});
			
			ws.on('error', (error) => {
				console.log(`❌ Failed to connect to ${peerAddress}: ${error.message}`);
				reject(error);
			});
		});
	}
	
	handleIncomingConnection(ws, req) {
		console.log(`📞 Incoming connection from ${req.socket.remoteAddress}`);
		
		ws.on('message', (data) => {
			try {
				const message = JSON.parse(data.toString());
				
				// Check if this is a GUI client
				if (message.type === 'HANDSHAKE' && message.isGUI) {
					this.handleGUIConnection(ws, message);
				} else if (message.type === 'COMMAND') {
					this.handleGUICommand(message, ws);
				} else {
					this.handleMessage(message, ws);
				}
			} catch (error) {
				console.error('Error handling message:', error);
			}
		});
		
		ws.on('close', () => {
			// Remove GUI client if it was one
			for (const [clientId, clientWs] of this.guiClients.entries()) {
				if (clientWs === ws) {
					this.guiClients.delete(clientId);
					console.log(`GUI client ${clientId} disconnected`);
					return;
				}
			}
			
			// Otherwise handle as regular peer
			for (const [peerId, peerWs] of this.peers.entries()) {
				if (peerWs === ws) {
					this.peers.delete(peerId);
					this.activePeers.delete(peerId);
					// Keep the address info for potential reconnection
					// this.peerAddresses.delete(peerId); // Don't delete immediately
					console.log(`Peer ${peerId} disconnected`);
					break;
				}
			}
		});
		
		ws.on('error', (error) => {
			console.log(`Connection error: ${error.message}`);
		});
	}

    handleGUIConnection(ws, message) {
        const clientId = message.from;
        this.guiClients.set(clientId, ws);
        console.log(`🖥️ GUI client connected: ${clientId}`);
        
        // Send initial status to GUI
        this.sendStatusToGUI(ws);
        
        // Send current round info if available
        if (this.currentRound) {
            ws.send(JSON.stringify({
                type: 'ROUND_START',
                roundId: this.currentRound.id,
                topic: this.currentRound.topic,
                allowedChoices: this.currentRound.allowedChoices,
                votingTimeSeconds: this.currentRound.votingTimeSeconds || 100,
                phase: this.currentRound.phase
            }));
        }
    }

    handleGUICommand(message, ws) {
        const { command, args } = message;
        console.log(`🖥️ GUI command: ${command} ${args ? args.join(' ') : ''}`);
        
        let response = '';
        
        switch (command.toLowerCase()) {
            case 'status':
                this.sendStatusToGUI(ws);
                break;
                
            case 'start':
                if (args.length === 0) {
                    response = 'Usage: start <topic> [choice1,choice2,choice3] [time_in_seconds]';
                } else {
                    let topic, allowedChoices = null, votingTime = 100;
                    let parsedArgs = [...args]; // Create a copy of args that we can modify
                    
                    // Parse arguments similar to CLI
                    const lastArg = parsedArgs[parsedArgs.length - 1];
                    
                    // Check if last argument is a number (voting time)
                    if (/^\d+$/.test(lastArg)) {
                        votingTime = parseInt(lastArg);
                        parsedArgs = parsedArgs.slice(0, -1); // Remove time from args
                    }
                    
                    // Check if remaining last argument contains commas (choices)
                    if (parsedArgs.length > 1 && parsedArgs[parsedArgs.length - 1].includes(',')) {
                        allowedChoices = parsedArgs[parsedArgs.length - 1].split(',').map(choice => choice.trim());
                        topic = parsedArgs.slice(0, -1).join(' ');
                    } else {
                        topic = parsedArgs.join(' ');
                    }
                    
                    this.startVotingRound(topic, allowedChoices, votingTime);
                    response = `Started voting round: ${topic} (${votingTime}s)`;
                }
                break;
                
            case 'vote':
                const choice = args.join(' ');
                if (!choice) {
                    response = 'Usage: vote <choice>';
                } else {
                    this.castVote(choice);
                    response = `Vote cast: ${choice}`;
                }
                break;
                
            case 'peers':
                response = `Active peers: ${Array.from(this.activePeers).join(', ')}`;
                break;
                
            case 'results':
                if (this.results.size === 0) {
                    response = 'No completed rounds yet';
                } else {
                    const latestResult = Array.from(this.results.values()).pop();
                    ws.send(JSON.stringify({
                        type: 'RESULTS',
                        results: latestResult
                    }));
                    return;
                }
                break;
                
            default:
                response = `Unknown command: ${command}`;
        }
        
        if (response) {
            ws.send(JSON.stringify({
                type: 'COMMAND_RESPONSE',
                response: response
            }));
        }
    }
    
    sendStatusToGUI(ws) {
        const status = this.getCurrentRoundStatus();
        
        ws.send(JSON.stringify({
            type: 'STATUS_UPDATE',
            data: {
                nodeId: this.nodeId,
                peers: this.activePeers.size,
                peersList: Array.from(this.activePeers),
                roundTopic: typeof status === 'object' ? status.topic : null,
                phase: typeof status === 'object' ? status.phase : 'WAITING',
                timeRemaining: typeof status === 'object' ? status.timeRemaining : 0,
                encryptedVotes: typeof status === 'object' ? status.encryptedVoteCount : 0,
                decryptedVotes: typeof status === 'object' ? status.decryptedVoteCount : 0
            }
        }));
    }
    
    // Add periodic status updates for GUI clients
    startGUIUpdates() {
        setInterval(() => {
            for (const [clientId, ws] of this.guiClients) {
                if (ws.readyState === WebSocket.OPEN) {
                    this.sendStatusToGUI(ws);
                }
            }
        }, 2000); // Update every 2 seconds
    }

	// Enhanced handleMessage to forward voting events to GUI clients
	originalHandleMessage(message, ws) {
		// Don't log heartbeats to reduce spam
		if (message.type !== 'HEARTBEAT') {
			console.log(`📨 Received ${message.type} from ${message.from}`);
		}
		
		switch (message.type) {
			case 'HANDSHAKE':
				console.log(`🤝 Handshake from ${message.from}`);
				this.peers.set(message.from, ws);
				this.activePeers.add(message.from);
				
				// Store the peer's address information
				if (message.port) {
					// Extract host from WebSocket connection
					const remoteAddress = ws._socket ? ws._socket.remoteAddress : 'localhost';
					const host = remoteAddress === '::1' || remoteAddress === '127.0.0.1' ? 'localhost' : remoteAddress;
					
					this.peerAddresses.set(message.from, {
						host: host,
						port: message.port
					});
					console.log(`📍 Stored address for ${message.from}: ${host}:${message.port}`);
				}
				
				console.log(`Connected to peer ${message.from}`);
				
				// Send handshake response with our peer list
				const handshakeResponse = {
					type: 'HANDSHAKE_ACK',
					from: this.nodeId,
					port: this.port,
					knownPeers: this.getKnownPeersList() // Include our known peers
				};
				ws.send(JSON.stringify(handshakeResponse));
				
				// Request their peer list
				ws.send(JSON.stringify({
					type: 'PEER_EXCHANGE_REQUEST',
					from: this.nodeId
				}));
				break;
				
			case 'HANDSHAKE_ACK':
				console.log(`🤝 Handshake ACK from ${message.from}`);
				if (!this.peers.has(message.from)) {
					this.peers.set(message.from, ws);
				}
				this.activePeers.add(message.from);
				
				// Store the peer's address information
				if (message.port) {
					const remoteAddress = ws._socket ? ws._socket.remoteAddress : 'localhost';
					const host = remoteAddress === '::1' || remoteAddress === '127.0.0.1' ? 'localhost' : remoteAddress;
					
					this.peerAddresses.set(message.from, {
						host: host,
						port: message.port
					});
					console.log(`📍 Stored address for ${message.from}: ${host}:${message.port}`);
				}
				
				// Process any peers they shared in the handshake
				if (message.knownPeers && message.knownPeers.length > 0) {
					console.log(`🔍 Processing ${message.knownPeers.length} peers from handshake`);
					this.processPeerExchange(message.knownPeers, message.from);
				}
				break;
			
			case 'PEER_EXCHANGE_REQUEST':
				// Send our peer list to the requesting node
				this.sendPeerList(ws);
				break;
				
			case 'PEER_EXCHANGE_RESPONSE':
				// Process the received peer list
				if (message.peers && message.peers.length > 0) {
					this.processPeerExchange(message.peers, message.from);
				}
				break;
				
			case 'HEARTBEAT':
				this.activePeers.add(message.from);
				break;
				
			case 'ENCRYPTED_VOTE':
				this.handleEncryptedVote(message);
				// ENHANCED: Notify GUI clients about new encrypted vote
				this.notifyGUIClients('VOTE_RECEIVED', {
					roundId: message.roundId,
					anonymousVoteId: message.anonymousVoteId,
					encryptedVoteCount: this.encryptedVotes.get(message.roundId)?.size || 0
				});
				break;
				
			case 'BATCH_VOTE_KEYS':
				this.handleBatchVoteKeys(message);
				break;
				
			case 'VOTE_KEY':
				this.handleVoteKey(message);
				break;
				
			case 'RESULT_PROPOSAL':
				this.handleResultProposal(message);
				break;
				
			case 'ROUND_START':
				console.log(`📢 Processing ROUND_START: ${message.topic}`);
				this.handleRoundStart(message);
				
				// ENHANCED: Immediately notify GUI clients about the new round
				this.notifyGUIClients('ROUND_START', {
					roundId: message.roundId,
					topic: message.topic,
					allowedChoices: message.allowedChoices,
					votingTimeSeconds: message.votingTimeSeconds || 100,
					phase: 'VOTING',
					startTime: message.startTime,
					from: message.from
				});
				break;
		}
	}
	
	// NEW: Helper function to notify GUI clients
	notifyGUIClients(eventType, data) {
		const notification = {
			type: eventType,
			...data,
			timestamp: Date.now()
		};
		
		for (const [clientId, ws] of this.guiClients) {
			if (ws.readyState === WebSocket.OPEN) {
				try {
					ws.send(JSON.stringify(notification));
					console.log(`📱 Notified GUI ${clientId} about ${eventType}`);
				} catch (error) {
					console.error(`Failed to notify GUI ${clientId}:`, error.message);
					this.guiClients.delete(clientId);
				}
			}
		}
	}


    // === ENCRYPTION UTILITIES ===
    
    encryptVote(choice, roundId) {
        // Generate a random key for this vote
        const key = crypto.randomBytes(32);
        const iv = crypto.randomBytes(16);
        
        // Generate a random anonymous ID for this vote (not tied to node identity)
        const anonymousVoteId = crypto.randomBytes(16).toString('hex');
        
        // Create cipher with IV
        const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
        
        // Encrypt the vote data WITHOUT voter identity
        const voteData = JSON.stringify({
            choice: choice,
            anonymousVoteId: anonymousVoteId,
            timestamp: Date.now(),
            roundId: roundId
            // Note: NO voter field to maintain anonymity
        });
        
        let encrypted = cipher.update(voteData, 'utf8', 'hex');
        encrypted += cipher.final('hex');
        
        return {
            encryptedData: encrypted,
            key: key.toString('hex'),
            iv: iv.toString('hex'),
            anonymousVoteId: anonymousVoteId
        };
    }
    
    decryptVote(encryptedData, keyHex, ivHex) {
        try {
            const key = Buffer.from(keyHex, 'hex');
            const iv = Buffer.from(ivHex, 'hex');
            const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
            
            let decrypted = decipher.update(encryptedData, 'hex', 'utf8');
            decrypted += decipher.final('utf8');
            
            return JSON.parse(decrypted);
        } catch (error) {
            console.error('Failed to decrypt vote:', error.message);
            return null;
        }
    }

    // === PRIVATE VOTING LOGIC ===

    castVote(choice) {
        if (!this.currentRound || this.currentRound.phase !== 'VOTING') {
            console.log('No active voting round or voting phase has ended');
            return;
        }

        // Check if we've already voted in this round
        if (this.hasVotedInRound.get(this.currentRound.id)) {
            console.log('❌ You have already voted in this round. Each node can only vote once.');
            return;
        }

        // Validate choice against allowed choices
        if (this.currentRound.allowedChoices) {
            const normalizedChoice = choice.toLowerCase();
            const allowedNormalized = this.currentRound.allowedChoices.map(c => c.toLowerCase());
            
            if (!allowedNormalized.includes(normalizedChoice)) {
                console.log(`❌ Invalid choice. Allowed choices: ${this.currentRound.allowedChoices.join(', ')}`);
                return;
            }
        }
        
        // Mark that we've voted in this round
        this.hasVotedInRound.set(this.currentRound.id, true);
        
        // Encrypt the vote
        const encryptedVote = this.encryptVote(choice, this.currentRound.id);
        
        // Store our own vote key locally with anonymous ID (we'll share it during consensus phase)
        if (!this.voteKeys.has(this.currentRound.id)) {
            this.voteKeys.set(this.currentRound.id, new Map());
        }
        // Store key by anonymous vote ID, not node ID
        this.voteKeys.get(this.currentRound.id).set(encryptedVote.anonymousVoteId, {
            key: encryptedVote.key,
            submittedBy: this.nodeId // Track who submitted which anonymous vote (local only)
        });
        
        // Store our vote tracking info (local only - never shared)
        if (!this.myVoteTracking) {
            this.myVoteTracking = new Map();
        }
        this.myVoteTracking.set(this.currentRound.id, {
            anonymousVoteId: encryptedVote.anonymousVoteId,
            choice: choice,
            timestamp: Date.now(),
            verified: false // Will be set to true when we see our vote in final results
        });
        
        // Broadcast encrypted vote (without the key and without node identity)
        const encryptedMessage = {
            type: 'ENCRYPTED_VOTE',
            roundId: this.currentRound.id,
            anonymousVoteId: encryptedVote.anonymousVoteId,
            encryptedData: encryptedVote.encryptedData,
            iv: encryptedVote.iv,
            timestamp: Date.now(),
            // Note: NO 'from' field to maintain anonymity of vote content
            signature: this.signMessage(`${this.currentRound.id}_${encryptedVote.encryptedData}`)
        };
        
        this.broadcast(encryptedMessage);
        
        // Store our encrypted vote locally by anonymous ID
        if (!this.encryptedVotes.has(this.currentRound.id)) {
            this.encryptedVotes.set(this.currentRound.id, new Map());
        }
        this.encryptedVotes.get(this.currentRound.id).set(encryptedVote.anonymousVoteId, encryptedMessage);
        
        console.log(`🔒 Encrypted vote cast and broadcasted`);
        console.log(`📊 Total encrypted votes received: ${this.encryptedVotes.get(this.currentRound.id).size}`);
    }

    handleEncryptedVote(message) {
        if (!this.currentRound || message.roundId !== this.currentRound.id) {
            return;
        }
        
        if (this.currentRound.phase !== 'VOTING') {
            return;
        }
        
        if (!this.verifySignature(message.signature, `${message.roundId}_${message.encryptedData}`, 'anonymous')) {
            // Skip signature verification for anonymous votes or implement a different verification method
        }
        
        // Store encrypted vote by anonymous ID
        if (!this.encryptedVotes.has(this.currentRound.id)) {
            this.encryptedVotes.set(this.currentRound.id, new Map());
        }
        this.encryptedVotes.get(this.currentRound.id).set(message.anonymousVoteId, message);
        
        console.log(`🔒 Received anonymous encrypted vote (ID: ${message.anonymousVoteId.substring(0, 8)}...)`);
        console.log(`📊 Total encrypted votes received: ${this.encryptedVotes.get(this.currentRound.id).size}`);
    }

    // Enhanced enterConsensusPhase to notify GUI clients
	enterConsensusPhase() {
		if (!this.currentRound || this.currentRound.phase !== 'VOTING') {
			return;
		}
		
		this.currentRound.phase = 'CONSENSUS';
		this.resultProposed = false;
		this.keysSharingComplete = false;
		
		console.log('\n=== CONSENSUS PHASE ===');
		console.log('🔓 Revealing anonymous votes and calculating results...');
		
		// Share ALL decryption keys in a batch to break correlation
		this.shareAllKeys();
		
		setTimeout(() => this.checkIfReadyToPropose(), 10000);
		
		// ENHANCED: Notify GUI clients of phase change
		this.notifyGUIClients('PHASE_CHANGE', {
			phase: 'CONSENSUS',
			roundId: this.currentRound.id,
			encryptedVoteCount: this.encryptedVotes.get(this.currentRound.id)?.size || 0
		});
	}


    shareAllKeys() {
        // Collect ALL decryption keys from all nodes (including our own)
        const allKeys = [];
        
        // Add our own keys
        const roundKeys = this.voteKeys.get(this.currentRound.id);
        if (roundKeys) {
            for (const [anonymousVoteId, keyData] of roundKeys) {
                allKeys.push({
                    anonymousVoteId: anonymousVoteId,
                    key: keyData.key
                });
            }
        }
        
        // Shuffle the keys to break any correlation with submission order
        this.shuffleArray(allKeys);
        
        // Broadcast all keys together with a shorter, more consistent delay
        setTimeout(() => {
            this.broadcast({
                type: 'BATCH_VOTE_KEYS',
                roundId: this.currentRound.id,
                keys: allKeys,
                from: this.nodeId
            });
        }, Math.random() * 1000 + 500); // Random delay 0.5-1.5 seconds (shorter and more consistent)
    }

    shuffleArray(array) {
        for (let i = array.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [array[i], array[j]] = [array[j], array[i]];
        }
    }

    handleBatchVoteKeys(message) {
        if (!this.currentRound || message.roundId !== this.currentRound.id) {
            return;
        }
        
        if (this.currentRound.phase !== 'CONSENSUS') {
            return;
        }
        
        // Store all the decryption keys from the batch
        if (!this.voteKeys.has(this.currentRound.id)) {
            this.voteKeys.set(this.currentRound.id, new Map());
        }
        
        let newKeysCount = 0;
        for (const keyInfo of message.keys) {
            if (!this.voteKeys.get(this.currentRound.id).has(keyInfo.anonymousVoteId)) {
                this.voteKeys.get(this.currentRound.id).set(keyInfo.anonymousVoteId, {
                    key: keyInfo.key,
                    keyProvider: message.from // We know who provided the batch, but not which specific key
                });
                newKeysCount++;
            }
        }
        
        if (newKeysCount > 0) {
            console.log(`🔑 Received batch of ${newKeysCount} decryption keys from ${message.from}`);
            console.log(`🔀 Keys shuffled to prevent correlation with vote submission order`);
            
            // Try to decrypt votes now that we have more keys
            this.decryptAndProcessVotes();
            
            // Check if we should propose results now that we have more keys
            if (!this.resultProposed) {
                this.checkIfReadyToPropose();
            }
        }
    }

    handleVoteKey(message) {
        if (!this.currentRound || message.roundId !== this.currentRound.id) {
            return;
        }
        
        if (this.currentRound.phase !== 'CONSENSUS') {
            return;
        }
        
        // Store the decryption key by anonymous vote ID
        if (!this.voteKeys.has(this.currentRound.id)) {
            this.voteKeys.set(this.currentRound.id, new Map());
        }
        
        // Check if we already have this key to avoid duplicates
        if (!this.voteKeys.get(this.currentRound.id).has(message.anonymousVoteId)) {
            this.voteKeys.get(this.currentRound.id).set(message.anonymousVoteId, {
                key: message.key,
                keyProvider: message.from
            });
            
            console.log(`🔑 Received decryption key for vote ${message.anonymousVoteId.substring(0, 8)}... from ${message.from}`);
            
            // Try to decrypt the vote now that we have the key
            this.decryptAndProcessVotes();
            
            // Check if we should propose results now that we have more keys
            if (!this.resultProposed) {
                this.checkIfReadyToPropose();
            }
        }
    }

    decryptAndProcessVotes() {
        if (!this.currentRound) return;
        
        const roundId = this.currentRound.id;
        const encryptedVotes = this.encryptedVotes.get(roundId);
        const voteKeys = this.voteKeys.get(roundId);
        
        if (!encryptedVotes || !voteKeys) return;
        
        // Initialize decrypted votes storage
        if (!this.votes.has(roundId)) {
            this.votes.set(roundId, new Map());
        }
        const decryptedVotes = this.votes.get(roundId);
        
        let newlyDecrypted = 0;
        
        // Try to decrypt all votes for which we have keys
        for (const [anonymousVoteId, encryptedVote] of encryptedVotes) {
            if (voteKeys.has(anonymousVoteId) && !decryptedVotes.has(anonymousVoteId)) {
                const keyData = voteKeys.get(anonymousVoteId);
                const decryptedData = this.decryptVote(
                    encryptedVote.encryptedData, 
                    keyData.key, 
                    encryptedVote.iv
                );
                
                if (decryptedData) {
                    // Store vote by anonymous ID, not by node ID
                    decryptedVotes.set(anonymousVoteId, {
                        choice: decryptedData.choice,
                        anonymousVoteId: decryptedData.anonymousVoteId,
                        timestamp: decryptedData.timestamp,
                        roundId: decryptedData.roundId
                        // Note: No voter identity stored
                    });
                    newlyDecrypted++;
                }
            }
        }
        
        if (newlyDecrypted > 0) {
            console.log(`🔓 Successfully decrypted ${newlyDecrypted} more anonymous votes`);
            console.log(`📊 Total decrypted votes: ${decryptedVotes.size}/${encryptedVotes.size}`);
        }
    }
	  
	// Enhanced broadcast function to include GUI clients for voting events
	broadcast(message) {
		const messageStr = JSON.stringify(message);
		let sentCount = 0;
		
		// Send to peers
		for (const [peerId, ws] of this.peers) {
			if (this.activePeers.has(peerId) && ws.readyState === WebSocket.OPEN) {
				try {
					ws.send(messageStr);
					sentCount++;
				} catch (error) {
					console.error(`Failed to send to ${peerId}:`, error.message);
					this.activePeers.delete(peerId);
				}
			}
		}
		
		// ENHANCED: Send voting-related updates to ALL GUI clients
		const votingEvents = ['ROUND_START', 'PHASE_CHANGE', 'RESULTS', 'ENCRYPTED_VOTE', 'RESULT_PROPOSAL'];
		const shouldSendToGUI = votingEvents.includes(message.type) || message.type === 'STATUS_UPDATE';
		
		if (shouldSendToGUI) {
			for (const [clientId, ws] of this.guiClients) {
				if (ws.readyState === WebSocket.OPEN) {
					try {
						ws.send(messageStr);
						console.log(`📱 Sent ${message.type} to GUI client ${clientId}`);
					} catch (error) {
						console.error(`Failed to send to GUI ${clientId}:`, error.message);
						this.guiClients.delete(clientId);
					}
				}
			}
		}
		
		// Only log non-heartbeat broadcasts to reduce spam
		if (message.type !== 'HEARTBEAT') {
			console.log(`📤 Broadcast ${message.type} to ${sentCount} peers + ${this.guiClients.size} GUI clients`);
		}
	}

    startHeartbeat() {
        this.heartbeatInterval = setInterval(() => {
            this.broadcast({
                type: 'HEARTBEAT',
                from: this.nodeId,
                timestamp: Date.now()
            });
        }, 10000); // Every 10 seconds
    }

    // === VOTING ROUNDS ===

    startVotingRound(topic, allowedChoices = null, votingTimeSeconds = 100) {
        if (this.currentRound && this.currentRound.phase !== 'FINISHED') {
            console.log('A voting round is already active!');
            return;
        }

        // Validate voting time: min 30 seconds, max 600 seconds (10 minutes), default 100 seconds
        if (typeof votingTimeSeconds !== 'number' || votingTimeSeconds < 30 || votingTimeSeconds > 600) {
            console.log(`⚠️ Invalid voting time: ${votingTimeSeconds}s. Using default 100 seconds.`);
            console.log('   Valid range: 30-600 seconds (0.5-10 minutes)');
            votingTimeSeconds = 100;
        }

        const roundId = `round_${Date.now()}_${this.nodeId}`;
        const round = {
            id: roundId,
            topic: topic,
            allowedChoices: allowedChoices,
            startTime: Date.now(),
            duration: votingTimeSeconds * 1000, // Convert to milliseconds
            votingTimeSeconds: votingTimeSeconds, // Store original seconds for reference
            phase: 'VOTING',
            votes: new Map(),
            results: null,
            consensusAchieved: false,
            consensusNodes: new Set(),
            consensusTimeout: null,
            finishTimeout: null
        };
        
        this.currentRound = round;
        this.resultProposed = false; // Initialize result proposal flag
        this.keysSharingComplete = false; // Initialize keys sharing flag
        this.hasVotedInRound.set(roundId, false); // Initialize voting status for this round
        this.votes.set(roundId, new Map());
        this.encryptedVotes.set(roundId, new Map());
        this.voteKeys.set(roundId, new Map());
        
        // Broadcast round start
        this.broadcast({
            type: 'ROUND_START',
            roundId: roundId,
            topic: topic,
            allowedChoices: allowedChoices,
            votingTimeSeconds: votingTimeSeconds, // Include voting time in broadcast
            startTime: round.startTime,
            from: this.nodeId
        });
        
        console.log(`\n=== VOTING ROUND STARTED ===`);
        console.log(`Topic: ${topic}`);
        if (allowedChoices) {
            console.log(`Allowed choices: ${allowedChoices.join(', ')}`);
        }
        console.log(`🔒 Private voting enabled - votes are encrypted until consensus phase`);
        console.log(`⏰ Voting duration: ${votingTimeSeconds} seconds (${Math.round(votingTimeSeconds/60*10)/10} minutes)`);
        console.log(`Active nodes: ${this.getActiveNodeCount()}`);
        console.log(`Type 'vote <choice>' to cast your encrypted vote`);
        
        // Schedule phase transitions with custom timing
        // Consensus phase starts at 80% of voting time
        const consensusDelay = Math.round(votingTimeSeconds * 0.8 * 1000);
        this.currentRound.consensusTimeout = setTimeout(() => this.enterConsensusPhase(), consensusDelay);
        this.currentRound.finishTimeout = setTimeout(() => this.finishRound(), round.duration);
        
        return roundId;
    }
	
    handleRoundStart(message) {
        console.log(`🔄 Handling ROUND_START from ${message.from}`);
        console.log(`Current round: ${this.currentRound ? this.currentRound.id : 'none'}`);
        console.log(`Incoming round: ${message.roundId}`);
        
        if (!this.currentRound || this.currentRound.startTime < message.startTime) {
            console.log(`✅ Accepting new round from ${message.from}`);
            
            // Get voting time from message, with fallback to default
            const votingTimeSeconds = message.votingTimeSeconds || 100;
            
            this.currentRound = {
                id: message.roundId,
                topic: message.topic,
                allowedChoices: message.allowedChoices,
                startTime: message.startTime,
                duration: votingTimeSeconds * 1000, // Convert to milliseconds
                votingTimeSeconds: votingTimeSeconds,
                phase: 'VOTING',
                votes: new Map(),
                results: null,
                consensusAchieved: false,
                consensusNodes: new Set(),
                consensusTimeout: null,
                finishTimeout: null
            };
            
            this.votes.set(message.roundId, new Map());
            this.encryptedVotes.set(message.roundId, new Map());
            this.voteKeys.set(message.roundId, new Map());
            this.resultProposed = false; // Initialize result proposal flag
            this.keysSharingComplete = false; // Initialize keys sharing flag
            this.hasVotedInRound.set(message.roundId, false); // Initialize voting status for this round
            
            console.log(`\n=== JOINED VOTING ROUND ===`);
            console.log(`Topic: ${message.topic}`);
            if (message.allowedChoices) {
                console.log(`Allowed choices: ${message.allowedChoices.join(', ')}`);
            }
            console.log(`🔒 Private voting enabled - votes are encrypted until consensus phase`);
            console.log(`⏰ Voting duration: ${votingTimeSeconds} seconds (${Math.round(votingTimeSeconds/60*10)/10} minutes)`);
            console.log(`Started by: ${message.from}`);
            console.log(`Type 'vote <choice>' to cast your encrypted vote`);
            
            // Schedule phase transitions for this node too with custom timing
            const elapsed = Date.now() - message.startTime;
            const consensusDelay = Math.max(100, Math.round(votingTimeSeconds * 0.8 * 1000) - elapsed);
            const finishDelay = Math.max(100, (votingTimeSeconds * 1000) - elapsed);
            
            this.currentRound.consensusTimeout = setTimeout(() => this.enterConsensusPhase(), consensusDelay);
            this.currentRound.finishTimeout = setTimeout(() => this.finishRound(), finishDelay);
            
        } else {
            console.log(`❌ Ignoring round start (older or same timestamp)`);
        }
    }

    checkIfReadyToPropose() {
        if (!this.currentRound || this.currentRound.phase !== 'CONSENSUS' || this.resultProposed) {
            return;
        }
        
        const encryptedVotes = this.encryptedVotes.get(this.currentRound.id);
        const voteKeys = this.voteKeys.get(this.currentRound.id);
        
        if (!encryptedVotes || !voteKeys) {
            console.log('⏳ Waiting for vote keys...');
            setTimeout(() => this.checkIfReadyToPropose(), 3000);
            return;
        }
        
        const totalEncryptedVotes = encryptedVotes.size;
        const totalKeys = voteKeys.size;
        const activeNodes = this.getActiveNodeCount();
        
        console.log(`🔍 Ready check: Have ${totalKeys}/${totalEncryptedVotes} decryption keys`);
        
        // Wait to ensure we've received key batches from all active nodes
        const uniqueKeyProviders = new Set();
        for (const [_, keyData] of voteKeys) {
            if (keyData.keyProvider) {
                uniqueKeyProviders.add(keyData.keyProvider);
            }
        }
        
        // Add ourselves if we have keys
        if (this.voteKeys.get(this.currentRound.id) && this.voteKeys.get(this.currentRound.id).size > 0) {
            uniqueKeyProviders.add(this.nodeId);
        }
        
        console.log(`📋 Key providers: ${uniqueKeyProviders.size}/${activeNodes} nodes have shared keys`);
        
        // STRICT REQUIREMENT: We must have ALL keys from ALL nodes before proposing
        const hasAllKeys = totalKeys >= totalEncryptedVotes;
        const hasAllProviders = uniqueKeyProviders.size >= activeNodes;
        
        if (hasAllKeys && hasAllProviders) {
            // Additional safety: wait a bit more to ensure all nodes are in the same state
            if (!this.keysSharingComplete) {
                this.keysSharingComplete = true;
                console.log('✅ All keys received - waiting 3 more seconds for synchronization...');
                setTimeout(() => this.checkIfReadyToPropose(), 3000);
                return;
            }
            
            console.log('✅ All conditions met and synchronized - proposing results');
            this.proposeResults();
        } else {
            console.log(`⏳ Still waiting: need keys for ${totalEncryptedVotes - totalKeys} votes OR key batches from ${activeNodes - uniqueKeyProviders.size} more nodes`);
            // Check again in 3 seconds
            setTimeout(() => this.checkIfReadyToPropose(), 3000);
        }
    }

    proposeResults() {
        if (!this.currentRound || this.currentRound.phase !== 'CONSENSUS' || this.resultProposed) {
            return;
        }
        
        this.resultProposed = true; // Mark that we've proposed results
        
        // Make sure all votes are decrypted
        this.decryptAndProcessVotes();
        
        const results = this.calculateResults();
        const proposal = {
            type: 'RESULT_PROPOSAL',
            roundId: this.currentRound.id,
            results: results,
            voteCount: this.votes.get(this.currentRound.id).size,
            from: this.nodeId
        };
        
        this.broadcast(proposal);
        console.log('📊 Proposed results:', this.formatResults(results));
        
        // Add ourselves to consensus
        this.currentRound.consensusNodes.add(this.nodeId);
        this.checkForConsensus();
    }

    calculateResults() {
        const roundVotes = this.votes.get(this.currentRound.id);
        const tally = new Map();
        
        for (const vote of roundVotes.values()) {
            const choice = vote.choice.toLowerCase();
            tally.set(choice, (tally.get(choice) || 0) + 1);
        }
        
        // Convert to array and sort with stable ordering for ties
        return Array.from(tally.entries())
            .sort((a, b) => {
                // First sort by vote count (descending)
                if (b[1] !== a[1]) {
                    return b[1] - a[1];
                }
                // For ties, sort alphabetically by choice name for consistent ordering
                return a[0].localeCompare(b[0]);
            })
            .map(([choice, count]) => ({ choice, count }));
    }

    handleResultProposal(message) {
        if (!this.currentRound || message.roundId !== this.currentRound.id) {
            return;
        }
        
        const myResults = this.calculateResults();
        const resultsMatch = this.compareResults(myResults, message.results);
        
        if (resultsMatch) {
            console.log(`✅ Results consensus with ${message.from}`);
            this.currentRound.consensusNodes.add(message.from);
            
            if (!this.currentRound.consensusNodes.has(this.nodeId)) {
                this.currentRound.consensusNodes.add(this.nodeId);
            }
            
            this.checkForConsensus();
        } else {
            console.log(`⚠ Results disagreement with ${message.from}`);
            console.log(`Their results:`, this.formatResults(message.results));
            console.log(`My results:`, this.formatResults(myResults));
        }
    }

    checkForConsensus() {
        if (!this.currentRound || this.currentRound.phase !== 'CONSENSUS' || this.currentRound.consensusAchieved) {
            return;
        }

        const activeNodeCount = this.getActiveNodeCount();
        const consensusCount = this.currentRound.consensusNodes.size;
        
        console.log(`🔍 Consensus check: ${consensusCount}/${activeNodeCount} nodes agree`);
        console.log(`📋 Nodes in consensus: ${Array.from(this.currentRound.consensusNodes).join(', ')}`);
        
        if (consensusCount >= activeNodeCount) {
            this.currentRound.consensusAchieved = true;
            console.log(`🎯 Full consensus achieved! Finishing round...`);
            
            if (this.currentRound.finishTimeout) {
                clearTimeout(this.currentRound.finishTimeout);
            }
            
            setTimeout(() => this.finishRound(), 500);
        }
    }

	finishRound() {
		if (!this.currentRound || this.currentRound.phase === 'FINISHED') {
			return;
		}
		
		if (this.currentRound.consensusTimeout) {
			clearTimeout(this.currentRound.consensusTimeout);
		}
		if (this.currentRound.finishTimeout) {
			clearTimeout(this.currentRound.finishTimeout);
		}
		
		this.currentRound.phase = 'FINISHED';
		this.currentRound.results = this.calculateResults();
		
		console.log('\n=== ROUND FINISHED ===');
		console.log(`Topic: ${this.currentRound.topic}`);
		console.log(`Final Results:`);
		console.log(this.formatResults(this.currentRound.results));
		console.log(`🔓 Anonymous votes (identities protected):`);
		
		// Show individual votes without revealing who cast them and shuffle the display order
		const roundVotes = this.votes.get(this.currentRound.id);
		const voteEntries = Array.from(roundVotes.entries());
		
		// Shuffle the votes for display to prevent any timing correlation
		this.shuffleArray(voteEntries);
		
		let voteIndex = 1;
		for (const [anonymousVoteId, vote] of voteEntries) {
			console.log(`  Vote ${voteIndex}: ${vote.choice}`);
			voteIndex++;
		}
		
		console.log(`Total votes: ${roundVotes.size}`);
		console.log(`Active nodes: ${this.getActiveNodeCount()}`);
		console.log(`🔒 Voter identities remain anonymous`);
		
		// Verify our own vote was counted (if we voted)
		this.verifyMyVote();
		
		// Show final vote participation summary
		const participatedNodes = this.countParticipatingNodes();
		console.log(`📊 Participation: ${participatedNodes}/${this.getActiveNodeCount()} nodes voted`);
		
		console.log('=======================\n');
		
		this.results.set(this.currentRound.id, this.currentRound.results);
		
		// ENHANCED: Send comprehensive results to GUI clients
		this.notifyGUIClients('RESULTS', {
			results: this.currentRound.results,
			roundId: this.currentRound.id,
			topic: this.currentRound.topic,
			totalVotes: roundVotes.size,
			activeNodes: this.getActiveNodeCount(),
			participation: `${participatedNodes}/${this.getActiveNodeCount()}`
		});
		
		this.notifyGUIClients('PHASE_CHANGE', {
			phase: 'FINISHED',
			roundId: this.currentRound.id
		});
	}

    verifyMyVote() {
        if (!this.myVoteTracking || !this.myVoteTracking.has(this.currentRound.id)) {
            return; // We didn't vote in this round
        }
        
        const myVoteInfo = this.myVoteTracking.get(this.currentRound.id);
        const roundVotes = this.votes.get(this.currentRound.id);
        
        // Check if our anonymous vote ID exists in the final results
        if (roundVotes.has(myVoteInfo.anonymousVoteId)) {
            const recordedVote = roundVotes.get(myVoteInfo.anonymousVoteId);
            
            // Verify the choice matches what we intended to vote
            if (recordedVote.choice.toLowerCase() === myVoteInfo.choice.toLowerCase()) {
                myVoteInfo.verified = true;
                console.log(`✅ Vote verification: Your vote for "${myVoteInfo.choice}" was successfully counted`);
            } else {
                console.log(`❌ Vote verification FAILED: Expected "${myVoteInfo.choice}" but found "${recordedVote.choice}"`);
            }
        } else {
            console.log(`❌ Vote verification FAILED: Your vote was not found in the final results`);
        }
    }

    countParticipatingNodes() {
        // Count unique voters by checking encrypted votes received
        // Each node should contribute exactly one encrypted vote if they participated
        const encryptedVotes = this.encryptedVotes.get(this.currentRound.id);
        return encryptedVotes ? encryptedVotes.size : 0;
    }

    // === UTILITY METHODS ===

    signMessage(message) {
        return crypto.createHash('sha256').update(`${this.nodeId}_${message}`).digest('hex');
    }
    
    verifySignature(signature, message, fromNode) {
        const expectedSignature = crypto.createHash('sha256').update(`${fromNode}_${message}`).digest('hex');
        return signature === expectedSignature;
    }
    
    compareResults(results1, results2) {
        if (results1.length !== results2.length) return false;
        
        for (let i = 0; i < results1.length; i++) {
            if (results1[i].choice !== results2[i].choice || 
                results1[i].count !== results2[i].count) {
                return false;
            }
        }
        return true;
    }

    formatResults(results) {
        return results.map(r => `${r.choice}: ${r.count} votes`).join(', ');
    }
    
    getActiveNodeCount() {
        return this.activePeers.size + 1;
    }
    
	async checkForDuplicates() {
		console.log('\n=== DUPLICATE NODE CHECK ===');
		console.log(`This node: ${this.nodeId}`);
		console.log('Connected nodes:');
		
		const nodeIds = new Map();
		
		for (const [peerId, ws] of this.peers) {
			if (this.activePeers.has(peerId)) {
				if (nodeIds.has(peerId)) {
					nodeIds.get(peerId).count++;
					console.log(`  🚨 ${peerId} (DUPLICATE - ${nodeIds.get(peerId).count} connections)`);
				} else {
					nodeIds.set(peerId, { count: 1, connection: ws });
					console.log(`  ✅ ${peerId}`);
				}
			}
		}
		
		const duplicates = Array.from(nodeIds.entries()).filter(([id, data]) => data.count > 1);
		
		if (duplicates.length > 0) {
			console.log('\n⚠️ DUPLICATES DETECTED:');
			duplicates.forEach(([id, data]) => {
				console.log(`   - Node ID '${id}' has ${data.count} connections`);
			});
			console.log('\nThis can cause voting inconsistencies and network issues.');
		} else {
			console.log('\n✅ No duplicate node IDs detected');
		}
		
		console.log('============================\n');
	}
	
    getCurrentRoundStatus() {
        if (!this.currentRound) {
            return 'No active round';
        }
        
        const elapsed = Date.now() - this.currentRound.startTime;
        const remaining = Math.max(0, this.currentRound.duration - elapsed);
        
        const encryptedVotes = this.encryptedVotes.get(this.currentRound.id);
        const decryptedVotes = this.votes.get(this.currentRound.id);
        
        return {
            topic: this.currentRound.topic,
            phase: this.currentRound.phase,
            timeRemaining: Math.floor(remaining / 1000), // Use Math.floor for smooth countdown
            encryptedVoteCount: encryptedVotes ? encryptedVotes.size : 0,
            decryptedVoteCount: decryptedVotes ? decryptedVotes.size : 0,
            activeNodes: this.getActiveNodeCount()
        };
    }

    // === CLI INTERFACE ===

    setupReadline() {
        this.rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
            prompt: `${this.nodeId}> `
        });

        this.rl.on('line', (input) => {
            this.handleCommand(input.trim());
            this.rl.prompt();
        });

        this.rl.on('close', () => {
            console.log('\nShutting down...');
            this.shutdown();
            process.exit(0);
        });
    }

    handleCommand(input) {
        const [command, ...args] = input.split(' ');
        
        switch (command.toLowerCase()) {
			case 'check-duplicates':
			case 'validate':
				this.checkForDuplicates();
				break;
				
			case 'network-status':
				this.showNetworkStatus();
				break;
				
            case 'help':
                this.showHelp();
                break;
                
            case 'status':
                this.showStatus();
                break;
                
            case 'peers':
                this.showPeers();
                break;
                
            case 'start':
                if (args.length === 0) {
                    console.log('Usage: start <topic> [choice1,choice2,choice3] [time_in_seconds]');
                    console.log('');
                    console.log('Parameters:');
                    console.log('  topic              : The voting topic/question');
                    console.log('  choices (optional) : Comma-separated list of allowed choices');
                    console.log('  time (optional)    : Voting duration in seconds (30-600, default: 100)');
                    console.log('');
                    console.log('Examples:');
                    console.log('  start "Should we deploy?" yes,no                     # 100 seconds (default)');
                    console.log('  start "Should we deploy?" yes,no 60                 # 60 seconds');
                    console.log('  start "Pick a color" red,blue,green,yellow 180      # 3 minutes');
                    console.log('  start "Free text question" 120                      # 2 minutes, any answer');
                    console.log('  start "Quick poll" yes,no 30                        # 30 seconds (minimum)');
                    console.log('  start "Long discussion" agree,disagree,neutral 600  # 10 minutes (maximum)');
                    break;
                }
                
                let topic, allowedChoices = null, votingTime = 100;
                
                // Parse arguments: topic [choices] [time]
                // Look for numeric values that could be time
                const lastArg = args[args.length - 1];
                const secondLastArg = args.length > 1 ? args[args.length - 2] : null;
                
                // Check if last argument is a number (voting time)
                if (/^\d+$/.test(lastArg)) {
                    votingTime = parseInt(lastArg);
                    args = args.slice(0, -1); // Remove time from args
                }
                
                // Check if remaining last argument contains commas (choices)
                if (args.length > 1 && args[args.length - 1].includes(',')) {
                    allowedChoices = args.pop().split(',').map(choice => choice.trim());
                    topic = args.join(' ');
                } else {
                    topic = args.join(' ');
                }
                
                this.startVotingRound(topic, allowedChoices, votingTime);
                break;
                
            case 'vote':
                const choice = args.join(' ');
                if (!choice) {
                    console.log('Usage: vote <choice>');
                    if (this.currentRound && this.currentRound.allowedChoices) {
                        console.log(`Allowed choices: ${this.currentRound.allowedChoices.join(', ')}`);
                    }
                    
                    // Show voting status
                    if (this.currentRound && this.hasVotedInRound.get(this.currentRound.id)) {
                        console.log('🗳️ You have already voted in this round.');
                    } else if (this.currentRound && this.currentRound.phase === 'VOTING') {
                        console.log('📝 You have not voted yet in this round.');
                    }
                } else {
                    this.castVote(choice);
                }
                break;
                
            case 'results':
                this.showResults();
                break;
                
            case 'debug':
                this.showDebugInfo();
                break;
                
            case 'verify':
                this.showVoteVerification();
                break;
                
            case 'gui':
                console.log('💡 GUI launching has been disabled. Use manager.js to launch and manage GUI interfaces.');
                break;
			case 'whoami':
			case 'info':
				console.log(`\n=== NODE INFORMATION ===`);
				console.log(`Node ID: ${this.nodeId}`);
				console.log(`Port: ${this.port}`);
				console.log(`GUI Port: ${this.guiPort || this.port}`);
				console.log(`Known Peers: ${this.knownPeers.map(p => `${p.host}:${p.port}`).join(', ') || 'None'}`);
				console.log(`Active Peers: ${Array.from(this.activePeers).join(', ') || 'None'}`);
				console.log(`GUI Enabled: ${this.guiEnabled ? 'Yes' : 'No'}`);
				console.log(`GUI Auto-Launch: Disabled (use manager.js instead)`);
				console.log(`========================\n`);
				break;

			case 'gui-info':
				console.log(`\n=== GUI CONNECTION INFO ===`);
				console.log(`This node: ${this.nodeId}`);
				console.log(`Port: ${this.port}`);
				console.log(`Expected GUI URL should contain: port=${this.port}&nodeId=${this.nodeId}`);
				console.log(`Connected GUI clients: ${this.guiClients.size}`);
				for (const [clientId] of this.guiClients) {
					console.log(`  - ${clientId}`);
				}
				console.log(`============================\n`);
				break;
			case 'discover':
			case 'find-peers':
				this.requestPeerDiscovery();
				break;
				
			case 'network':
			case 'topology':
				this.showNetworkTopology();
				break;
				
            case 'quit':
            case 'exit':
                this.rl.close();
                break;
                
            default:
                if (input) {
                    console.log(`Unknown command: ${command}. Type 'help' for available commands.`);
                }
        }
    }
	
	// NEW: Request peer discovery from all connected peers
	requestPeerDiscovery() {
		console.log('🔍 Requesting peer discovery from all connected nodes...');
		
		let requestsSent = 0;
		for (const [peerId, ws] of this.peers) {
			if (this.activePeers.has(peerId) && ws.readyState === WebSocket.OPEN) {
				try {
					ws.send(JSON.stringify({
						type: 'PEER_EXCHANGE_REQUEST',
						from: this.nodeId
					}));
					requestsSent++;
				} catch (error) {
					console.error(`Failed to request peers from ${peerId}:`, error.message);
				}
			}
		}
		
		if (requestsSent > 0) {
			console.log(`📤 Sent peer discovery requests to ${requestsSent} nodes`);
		} else {
			console.log('❌ No active peers to request discovery from');
		}
	}
	
	showNetworkStatus() {
		console.log('\n=== ENHANCED NETWORK STATUS ===');
		console.log(`This node: ${this.nodeId} (${this.startupValidationComplete ? 'validated' : 'validating...'})`);
		console.log(`Duplicate detection: ${this.duplicateNodeDetected ? '❌ DETECTED' : '✅ Clear'}`);
		console.log(`Port: ${this.port}`);
		console.log(`Active connections: ${this.peers.size}`);
		console.log(`Node registry entries: ${this.nodeRegistry.size}`);
		
		console.log('\nActive peers:');
		for (const peerId of this.activePeers) {
			const registry = this.nodeRegistry.get(peerId);
			const lastSeen = registry ? new Date(registry.lastSeen).toLocaleTimeString() : 'unknown';
			console.log(`  ├── ${peerId} (last seen: ${lastSeen})`);
		}
		
		console.log('\nKnown addresses:');
		for (const [nodeId, address] of this.peerAddresses) {
			const status = this.activePeers.has(nodeId) ? '✅' : '❌';
			console.log(`  ├── ${nodeId}: ${address.host}:${address.port} ${status}`);
		}
		
		console.log('===============================\n');
	}
	
	showNetworkTopology() {
		console.log('\n=== NETWORK TOPOLOGY ===');
		console.log(`This node: ${this.nodeId} (port ${this.port})`);
		console.log(`\nDirect connections (${this.activePeers.size}):`);
		
		for (const peerId of this.activePeers) {
			const address = this.peerAddresses.get(peerId);
			if (address) {
				console.log(`  ├── ${peerId} (${address.host}:${address.port})`);
			} else {
				console.log(`  ├── ${peerId} (address unknown)`);
			}
		}
		
		console.log(`\nKnown peers (${this.knownPeers.length}):`);
		for (const peer of this.knownPeers) {
			// Check if we're currently connected to this peer
			let connectedNodeId = null;
			for (const [nodeId, address] of this.peerAddresses) {
				if (address.host === peer.host && address.port === peer.port) {
					connectedNodeId = nodeId;
					break;
				}
			}
			
			const status = connectedNodeId ? '✅' : '❌';
			const nodeInfo = connectedNodeId ? ` (${connectedNodeId})` : '';
			console.log(`  ├── ${peer.host}:${peer.port}${nodeInfo} ${status}`);
		}
		
		console.log(`\nPeer addresses tracked: ${this.peerAddresses.size}`);
		for (const [nodeId, address] of this.peerAddresses) {
			console.log(`  ├── ${nodeId}: ${address.host}:${address.port}`);
		}
		
		console.log(`\nTotal network reach: ${this.activePeers.size + 1} nodes`);
		console.log('========================\n');
	}

    showHelp() {
    console.log(`
Available commands:
  help              - Show this help message
  status            - Show current round status
  peers             - Show connected peers
  discover          - Request peer discovery from connected nodes
  network           - Show network topology
  debug             - Show detailed debugging information
  start <topic> [choices] - Start a new private voting round
                      Examples: 
                        start "Deploy today?" yes,no
                        start "Pick color" red,blue,green
                        start "Free form question"
  vote <choice>     - Cast your encrypted vote in the current round
  verify            - Check verification status of your votes
  results           - Show results of completed rounds
  gui               - Open the GUI for this node
  quit/exit         - Shutdown the node

🔒 Privacy Features:
  - Votes are encrypted during voting phase
  - Vote counts are hidden until consensus phase
  - Voter identities are completely anonymous - even after round completion
  - Only vote choices and anonymous IDs are revealed, never who voted for what

🌐 Network Features:
  - Automatic peer discovery when connecting to nodes
  - Dynamic network expansion as nodes share their peer lists
  - Manual peer discovery with 'discover' command
		`);
	}

    showStatus() {
        const status = this.getCurrentRoundStatus();
        if (typeof status === 'string') {
            console.log(`Status: ${status}`);
        } else {
            console.log(`Current Round: ${status.topic}`);
            console.log(`Phase: ${status.phase}`);
            console.log(`Time remaining: ${status.timeRemaining}s`);
            
            if (status.phase === 'VOTING') {
                console.log(`🔒 Encrypted votes received: ${status.encryptedVoteCount}`);
                console.log(`❓ Vote contents hidden until consensus phase`);
                
                // Show personal voting status
                if (this.hasVotedInRound.get(this.currentRound.id)) {
                    console.log(`🗳️ Your voting status: ✅ You have voted in this round`);
                } else {
                    console.log(`📝 Your voting status: ⏳ You have not voted yet`);
                }
            } else if (status.phase === 'CONSENSUS') {
                console.log(`🔓 Decrypted votes: ${status.decryptedVoteCount}/${status.encryptedVoteCount}`);
            }
            
            console.log(`Active nodes: ${status.activeNodes}`);
        }
    }

    showPeers() {
        console.log(`Active peers (${this.activePeers.size}):`);
        for (const peerId of this.activePeers) {
            console.log(`  - ${peerId}`);
        }
    }

    showVoteVerification() {
        if (!this.myVoteTracking || this.myVoteTracking.size === 0) {
            console.log('No vote verification data available.');
            return;
        }
        
        console.log('\n=== VOTE VERIFICATION STATUS ===');
        for (const [roundId, voteInfo] of this.myVoteTracking) {
            // Find the round topic if available
            let topic = 'Unknown';
            if (this.currentRound && this.currentRound.id === roundId) {
                topic = this.currentRound.topic;
            } else if (this.results.has(roundId)) {
                // Try to extract topic from round ID or results
                topic = roundId.split('_').slice(2).join('_') || 'Previous round';
            }
            
            console.log(`Round: ${topic}`);
            console.log(`  Your vote: ${voteInfo.choice}`);
            console.log(`  Vote ID: ${voteInfo.anonymousVoteId.substring(0, 12)}...`);
            console.log(`  Status: ${voteInfo.verified ? '✅ Verified - Your vote was counted' : '⏳ Pending verification'}`);
            console.log(`  Cast at: ${new Date(voteInfo.timestamp).toLocaleString()}`);
            console.log('');
        }
        console.log('================================\n');
    }

    showResults() {
        if (this.results.size === 0) {
            console.log('No completed rounds yet.');
            return;
        }
        
        console.log('Previous round results:');
        for (const [roundId, results] of this.results) {
            console.log(`  ${roundId}: ${this.formatResults(results)}`);
        }
    }

    showDebugInfo() {
        console.log('\n=== DEBUG INFO ===');
        console.log(`Node ID: ${this.nodeId}`);
        console.log(`Port: ${this.port}`);
        console.log(`Connected peers: ${this.peers.size}`);
        console.log(`Active peers: ${this.activePeers.size}`);
        
        console.log('\nPeer connections:');
        for (const [peerId, ws] of this.peers) {
            console.log(`  ${peerId}: ${ws.readyState === WebSocket.OPEN ? 'OPEN' : 'CLOSED'} (active: ${this.activePeers.has(peerId)})`);
        }
        
        console.log('\nCurrent round:');
        if (this.currentRound) {
            console.log(`  ID: ${this.currentRound.id}`);
            console.log(`  Topic: ${this.currentRound.topic}`);
            console.log(`  Phase: ${this.currentRound.phase}`);
            console.log(`  Start time: ${new Date(this.currentRound.startTime)}`);
            console.log(`  Allowed choices: ${this.currentRound.allowedChoices || 'any'}`);
            
            const encryptedVotes = this.encryptedVotes.get(this.currentRound.id);
            const decryptedVotes = this.votes.get(this.currentRound.id);
            const voteKeys = this.voteKeys.get(this.currentRound.id);
            
            if (encryptedVotes) {
                console.log(`  🔒 Encrypted votes: ${encryptedVotes.size}`);
                for (const [anonymousVoteId] of encryptedVotes) {
                    console.log(`    ${anonymousVoteId.substring(0, 8)}...: [encrypted]`);
                }
            }
            
            if (voteKeys && voteKeys.size > 0) {
                console.log(`  🔑 Vote keys received: ${voteKeys.size}`);
                const keyProviders = new Set();
                for (const [anonymousVoteId, keyData] of voteKeys) {
                    keyProviders.add(keyData.keyProvider || 'unknown');
                }
                console.log(`    From nodes: ${Array.from(keyProviders).join(', ')}`);
            }
            
            if (decryptedVotes && decryptedVotes.size > 0) {
                console.log(`  🔓 Decrypted anonymous votes: ${decryptedVotes.size}`);
                if (this.currentRound.phase === 'FINISHED') {
                    // Show votes without revealing voter identity or vote IDs
                    const voteEntries = Array.from(decryptedVotes.entries());
                    this.shuffleArray(voteEntries); // Shuffle display order
                    
                    let voteIndex = 1;
                    for (const [anonymousVoteId, vote] of voteEntries) {
                        console.log(`    Vote ${voteIndex}: ${vote.choice}`);
                        voteIndex++;
                    }
                } else {
                    // During consensus, just show that votes are decrypted
                    console.log(`    ${decryptedVotes.size} votes successfully decrypted`);
                }
            }
        } else {
            console.log('  No active round');
        }
        console.log('==================\n');
    }

    shutdown() {
		if (this.discoveryInterval) {
            clearInterval(this.discoveryInterval);
            console.log('⏹️ Stopped LAN discovery broadcast.');
        }
        if (this.discoverySocket) {
            this.discoverySocket.close();
            console.log('🔌 Closed discovery socket.');
        }
		
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
        }
        
        for (const ws of this.peers.values()) {
            ws.close();
        }
        
        if (this.server) {
            this.server.close();
        }
    }

    prompt() {
        this.rl.prompt();
    }
}

// === MAIN ===

function main() {
    const args = process.argv.slice(2);
    
    // Check for --no-gui flag
    const noGuiIndex = args.indexOf('--no-gui');
    const noGui = noGuiIndex !== -1;
    if (noGuiIndex !== -1) {
        args.splice(noGuiIndex, 1); // Remove the flag from args
    }
    
    // Check for --gui-only flag (doesn't auto-launch but enables GUI)
    const guiOnlyIndex = args.indexOf('--gui-only');
    const guiOnly = guiOnlyIndex !== -1;
    if (guiOnlyIndex !== -1) {
        args.splice(guiOnlyIndex, 1);
    }
    
    if (args.length < 2) {
        console.log('Usage: node voting-node.js <nodeId> <port> [peer1:port1] [peer2:port2] ... [options]');
        console.log('');
        console.log('Options:');
        console.log('  --no-gui      Disable GUI completely');
        console.log('  --gui-only    Enable GUI (same as default - use manager.js for launching)');
        console.log('');
        console.log('Examples:');
        console.log('  node voting-node.js alice 3001                    # Start with GUI support');
        console.log('  node voting-node.js alice 3001 --no-gui           # Start without GUI');
        console.log('  node voting-node.js alice 3001 localhost:3002     # Start with peer and GUI');
        console.log('\n🔒 This version implements private voting with encryption');
        console.log('💡 Use manager.js to launch and manage GUI interfaces');
        process.exit(1);
    }
    
    const nodeId = args[0];
    const port = parseInt(args[1]);
    const knownPeers = args.slice(2).map(peer => {
        const [host, peerPort] = peer.split(':');
        return { host: host || 'localhost', port: parseInt(peerPort) };
    });
    
    // Set options - GUI auto-launch always disabled, use manager.js instead
    const options = {
        gui: !noGui,
        autoLaunch: false // Always false - use manager.js for GUI launching
    };
    
    const node = new VotingNodeWithAutoGUI(nodeId, port, knownPeers, options);
    
    node.start().then(() => {
        console.log(`Node ${nodeId} started successfully!`);
        console.log('🔒 Private voting system ready');
        console.log('💡 Use manager.js to launch and manage GUI interfaces');
        
        node.prompt();
    }).catch(error => {
        console.error('Failed to start node:', error);
        process.exit(1);
    });
}

if (require.main === module) {
    main();
}

module.exports = VotingNodeWithAutoGUI;
