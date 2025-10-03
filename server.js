// server.js
const express = require('express');
const http = require('http');
const socketio = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);

// Use two namespaces: one for participants, one for the secure admin panel
const io = socketio(server);
const participantNsp = io.of("/");
const adminNsp = io.of("/admin");

const PORT = process.env.PORT || 3000;

// --- Global State ---
const AUCTION_DURATION_SECONDS = 30 * 60; // 30 minutes
let AUCTION_END_TIME = null;
let AUCTION_ACTIVE = false;
let AUCTION_TIMER_INTERVAL = null;

// Initial Data (Admin can modify/add)
const ASSET_CATALOG = {
    "A1": { id: "A1", name: "Enterprise Cloud Server", category: "Tech", min_bid: 100000, current_bids: {}, winner: null, final_price: 0},
    "A2": { id: "A2", name: "Social Media Influencer Pack", category: "Marketing", min_bid: 50000, current_bids: {}, winner: null, final_price: 0},
    "A3": { id: "A3", name: "UI/UX Design Consultation", category: "Operations", min_bid: 30000, current_bids: {}, winner: null, final_price: 0},
    "A4": { id: "A4", name: "Patent Lawyer Consultation", category: "Legal", min_bid: 75000, current_bids: {}, winner: null, final_price: 0},
};

const TEAMS = {
    "T1": { id: "T1", name: "Team Phoenix", vc: 500000, assets_won: []},
    "T2": { id: "T2", name: "Team Apex", vc: 500000, assets_won: []},
    "T3": { id: "T3", name: "Team Zenith", vc: 500000, assets_won: []},
};

// --- Helper Functions ---

function getRemainingTime() {
    if (!AUCTION_ACTIVE || !AUCTION_END_TIME) return AUCTION_DURATION_SECONDS;
    const timeLeft = Math.max(0, Math.floor((AUCTION_END_TIME - Date.now()) / 1000));
    return timeLeft;
}

function startTimer() {
    if (AUCTION_TIMER_INTERVAL) return; // Prevent multiple timers
    
    AUCTION_END_TIME = Date.now() + AUCTION_DURATION_SECONDS * 1000;
    AUCTION_ACTIVE = true;
    
    AUCTION_TIMER_INTERVAL = setInterval(() => {
        const timeLeft = getRemainingTime();
        
        // Broadcast time to all clients
        participantNsp.emit('timer_update', { timeLeft: timeLeft });
        adminNsp.emit('timer_update', { timeLeft: timeLeft });
        
        if (timeLeft <= 0) {
            clearInterval(AUCTION_TIMER_INTERVAL);
            AUCTION_TIMER_INTERVAL = null;
            AUCTION_ACTIVE = false;
            resolveAuction();
        }
    }, 1000);
}

function resolveAuction() {
    const winningBids = {};

    // 1. Determine winners for each item
    for (const assetId in ASSET_CATALOG) {
        const asset = ASSET_CATALOG[assetId];
        let validBids = {};
        
        // Filter out invalid bids and prepare for winner selection
        for (const teamId in asset.current_bids) {
            const bid = asset.current_bids[teamId];
            if (bid >= asset.min_bid && bid <= TEAMS[teamId].vc) {
                validBids[teamId] = bid;
            }
        }
        
        if (Object.keys(validBids).length > 0) {
            // Find the highest bid (simple max function)
            const winnerId = Object.keys(validBids).reduce((a, b) => validBids[a] > validBids[b] ? a : b);
            const finalPrice = validBids[winnerId];

            asset.winner = winnerId;
            asset.final_price = finalPrice;

            if (!winningBids[winnerId]) {
                winningBids[winnerId] = [];
            }
            winningBids[winnerId].push({ assetId: assetId, price: finalPrice });
        } else {
            asset.winner = "NO_WINNER";
        }
    }

    // 2. Process all winning bids and deduct VC (Budget Constraint Check)
    for (const teamId in winningBids) {
        const team = TEAMS[teamId];
        const totalCost = winningBids[teamId].reduce((sum, win) => sum + win.price, 0);

        if (totalCost <= team.vc) {
            // Team can afford total cost: deduct VC and award assets
            team.vc -= totalCost;
            for (const win of winningBids[teamId]) {
                team.assets_won.push({
                    name: ASSET_CATALOG[win.assetId].name,
                    cost: win.price
                });
            }
        } else {
            // Team cannot afford total cost: ALL wins are voided (enforces budget discipline)
            console.log(`Team ${teamId} failed budget check: VC ${team.vc} < Cost ${totalCost}. Voiding all wins.`);
            for (const win of winningBids[teamId]) {
                ASSET_CATALOG[win.assetId].winner = "VOID (Budget Fail)";
                ASSET_CATALOG[win.assetId].final_price = 0;
            }
        }
    }

    // 3. Broadcast final results and update admin panel
    participantNsp.emit('auction_finished', ASSET_CATALOG);
    adminNsp.emit('auction_finished', ASSET_CATALOG);
    adminNsp.emit('admin_update_teams', TEAMS);
}

function resetAuction() {
    AUCTION_ACTIVE = false;
    AUCTION_END_TIME = null;
    if (AUCTION_TIMER_INTERVAL) {
        clearInterval(AUCTION_TIMER_INTERVAL);
        AUCTION_TIMER_INTERVAL = null;
    }
    
    // Hard reset state (revert to initial state)
    for (const id in ASSET_CATALOG) {
        ASSET_CATALOG[id].current_bids = {};
        ASSET_CATALOG[id].winner = null;
        ASSET_CATALOG[id].final_price = 0;
    }
    for (const id in TEAMS) {
        TEAMS[id].vc = 500000; // Reset VC
        TEAMS[id].assets_won = [];
    }

    // Notify all clients
    participantNsp.emit('auction_reset');
    adminNsp.emit('auction_reset');
}


// --- Express Routing (Serving Static Files and Basic Auth) ---
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));

// Participant View
app.get('/', (req, res) => {
    // Basic "authentication" for teams via query parameter
    const teamId = req.query.team || 'T1'; 
    if (!TEAMS[teamId]) {
        return res.status(404).send("Invalid Team ID.");
    }
    
    // Pass initial state to the client side
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Admin View
app.get('/admin_panel', (req, res) => {
    // --- SIMPLE MOCK ADMIN AUTHENTICATION ---
    if (req.query.pass !== 'admin123') { // Replace 'admin123' with a real, secure password check
        return res.status(403).send("Unauthorized Access. Passcode Required.");
    }
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Admin Post Requests (for Start/Reset)
app.post('/admin_action', (req, res) => {
    if (req.body.pass !== 'admin123') { // Re-check password
        return res.status(403).send("Unauthorized Action.");
    }
    
    const action = req.body.action;
    
    if (action === 'start_auction' && !AUCTION_ACTIVE) {
        startTimer();
    } else if (action === 'reset_auction') {
        resetAuction();
    }
    
    res.redirect('/admin_panel?pass=admin123'); // Redirect back to the admin panel
});


// --- Socket.IO Handlers (Real-time Communication) ---

// Participant Namespace
participantNsp.on('connection', (socket) => {
    console.log(`Participant connected: ${socket.id}`);
    
    // Send initial state to the newly connected participant
    socket.emit('initial_state', {
        teams: TEAMS, 
        assets: ASSET_CATALOG, 
        active: AUCTION_ACTIVE, 
        endTime: AUCTION_END_TIME
    });
    
    socket.on('place_bid', (data) => {
        if (!AUCTION_ACTIVE) {
            socket.emit('bid_response', { success: false, message: 'Auction is not active.' });
            return;
        }

        const { teamId, assetId, bidAmount } = data;
        const bid = parseInt(bidAmount);
        const asset = ASSET_CATALOG[assetId];
        const team = TEAMS[teamId];

        if (!asset || !team) {
            socket.emit('bid_response', { success: false, message: 'Invalid Asset or Team.' });
            return;
        }

        if (bid < asset.min_bid) {
            socket.emit('bid_response', { success: false, message: `Bid must be at least $${asset.min_bid.toLocaleString()} VC.` });
            return;
        }
        
        // Note: We only check if the bid is <= current VC. 
        // The total affordability check happens only at auction resolution.
        if (bid > team.vc) {
             socket.emit('bid_response', { success: false, message: `Bid of $${bid.toLocaleString()} VC exceeds your current VC balance.` });
             return;
        }

        // Store the sealed bid
        asset.current_bids[teamId] = bid;

        // Send confirmation to the bidding team
        socket.emit('bid_response', { 
            success: true, 
            message: `Bid of $${bid.toLocaleString()} VC recorded for ${asset.name}.`,
            assetId: assetId, 
            newBid: bid 
        });
        
        // Notify the Admin that bids have changed
        adminNsp.emit('admin_update_bids', { [assetId]: asset });
    });
});

// Admin Namespace
adminNsp.on('connection', (socket) => {
    // server.js (New code to add inside the adminNsp.on('connection', (socket) => { ... }) block)

    socket.on('force_stop_auction', () => {
        if (!AUCTION_ACTIVE) {
            console.log("Admin attempted to stop inactive auction.");
            socket.emit('admin_action_response', { success: false, message: 'Auction is already stopped or finished.' });
            return;
        }

        // 1. Immediately clear the timer
        if (AUCTION_TIMER_INTERVAL) {
            clearInterval(AUCTION_TIMER_INTERVAL);
            AUCTION_TIMER_INTERVAL = null;
        }
        
        // 2. Set the end time to now (or just slightly in the past)
        AUCTION_END_TIME = Date.now() - 1000; 
        AUCTION_ACTIVE = false;

        console.log("Admin forced auction stop. Resolving results now.");
        
        // 3. Resolve the auction and broadcast results
        resolveAuction(); 

        socket.emit('admin_action_response', { success: true, message: 'Auction forcefully stopped and results resolved.' });
    });
});


// --- Start Server ---
server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Admin Panel: http://localhost:${PORT}/admin_panel?pass=admin123`);
    console.log(`Team T1: http://localhost:${PORT}/?team=T1`);
});

// public/admin.html: Inside the <script> block

        // --- DOM Elements (Add the new button) ---
        const STOP_BTN = document.getElementById('stop-btn');
        // ... (other DOM elements)

        // --- Core Functions (Update renderAssetMonitor) ---
        function renderAssetMonitor() {
            // ... (existing code)
            
            // Re-check button state after rendering to account for initial load/reset
            AUCTION_STATUS_EL.textContent === 'LIVE' ? START_BTN.disabled = true : START_BTN.disabled = false;
            AUCTION_STATUS_EL.textContent === 'LIVE' ? STOP_BTN.disabled = false : STOP_BTN.disabled = true;

            // ... (rest of the function)
        }
        
        // --- NEW FUNCTION TO STOP THE AUCTION ---
        window.forceStopAuction = () => {
            if (confirm("Are you sure you want to STOP the auction immediately and resolve the winners based on current bids?")) {
                // Emit the new event to the server
                socket.emit('force_stop_auction');
                STOP_BTN.disabled = true; // Disable while waiting for server response
            }
        };


        // --- Socket.IO Event Handlers (Update existing handlers) ---
        
        socket.on('initial_admin_state', (state) => {
            // ... (existing code)
            
            // Set initial state for the new button
            STOP_BTN.disabled = !state.active; 
        });

        socket.on('auction_start', (data) => {
            // ... (existing code for auction_start)
            START_BTN.disabled = true;
            STOP_BTN.disabled = false; // Enable stop button when auction starts
        });
        
        socket.on('auction_finished', (assetResults) => {
            // ... (existing code for auction_finished)
            START_BTN.disabled = false; // Allow restart
            STOP_BTN.disabled = true; // Disable stop button when finished
            // ...
        });

        socket.on('admin_action_response', (data) => {
             console.log(data.message);
             // You can add a visual alert here if needed: alert(data.message);
        });

        socket.on('auction_reset', () => {
             // ...
             START_BTN.disabled = false; 
             STOP_BTN.disabled = true;
             // ...
        });