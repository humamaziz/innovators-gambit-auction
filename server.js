// server.js
const express = require('express');
const http = require('http');
const socketio = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);

// Use two namespaces for security and clarity
const io = socketio(server);
const participantNsp = io.of("/");
const adminNsp = io.of("/admin");

const PORT = process.env.PORT || 3000;

// --- Global State ---
const AUCTION_DURATION_SECONDS = 30 * 60; // 30 minutes
let AUCTION_END_TIME = null;
let AUCTION_ACTIVE = false;
let AUCTION_TIMER_INTERVAL = null;

// Initial Data
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
    if (AUCTION_TIMER_INTERVAL) return;
    
    AUCTION_END_TIME = Date.now() + AUCTION_DURATION_SECONDS * 1000;
    AUCTION_ACTIVE = true;
    
    // Broadcast start event and initial time
    const initialTimeLeft = getRemainingTime();
    participantNsp.emit('auction_start', { active: AUCTION_ACTIVE, endTime: AUCTION_END_TIME });
    adminNsp.emit('auction_start', { active: AUCTION_ACTIVE, timeLeft: initialTimeLeft });
    
    AUCTION_TIMER_INTERVAL = setInterval(() => {
        const timeLeft = getRemainingTime();
        
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
    // 1. Clear any running timer (should already be cleared by calling function, but safety check)
    if (AUCTION_TIMER_INTERVAL) {
        clearInterval(AUCTION_TIMER_INTERVAL);
        AUCTION_TIMER_INTERVAL = null;
    }

    const winningBids = {};

    // 2. Determine winners for each item
    for (const assetId in ASSET_CATALOG) {
        const asset = ASSET_CATALOG[assetId];
        let validBids = {};
        
        for (const teamId in asset.current_bids) {
            const bid = asset.current_bids[teamId];
            if (bid >= asset.min_bid && bid <= TEAMS[teamId].vc) {
                validBids[teamId] = bid;
            }
        }
        
        if (Object.keys(validBids).length > 0) {
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
            asset.final_price = 0;
        }
    }

    // 3. Process winning bids and deduct VC (Budget Constraint Check)
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
            // Team cannot afford total cost: ALL wins are voided
            console.log(`Team ${teamId} failed budget check: VC ${team.vc} < Cost ${totalCost}. Voiding all wins.`);
            for (const win of winningBids[teamId]) {
                ASSET_CATALOG[win.assetId].winner = "VOID (Budget Fail)";
                ASSET_CATALOG[win.assetId].final_price = 0;
            }
        }
    }

    // 4. Broadcast final results and team updates
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
    
    // Hard reset state
    for (const id in ASSET_CATALOG) {
        ASSET_CATALOG[id].current_bids = {};
        ASSET_CATALOG[id].winner = null;
        ASSET_CATALOG[id].final_price = 0;
    }
    for (const id in TEAMS) {
        TEAMS[id].vc = 500000;
        TEAMS[id].assets_won = [];
    }

    // Notify all clients to reset
    participantNsp.emit('auction_reset');
    adminNsp.emit('auction_reset');
}


// --- Express Routing ---
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));

// Participant View (Index)
app.get('/', (req, res) => {
    // Basic "authentication" for teams via query parameter
    const teamId = req.query.team || 'T1'; 
    if (!TEAMS[teamId]) {
        // Send a custom HTML error page or redirect
        return res.status(404).sendFile(path.join(__dirname, 'public', '404.html')); 
    }
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Admin View
app.get('/admin_panel', (req, res) => {
    if (req.query.pass !== 'admin123') { // MOCK AUTH
        return res.status(403).send("Unauthorized Access. Passcode Required.");
    }
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Admin Post Requests (for Start/Reset)
app.post('/admin_action', (req, res) => {
    if (req.body.pass !== 'admin123') { // MOCK AUTH
        return res.status(403).send("Unauthorized Action.");
    }
    
    const action = req.body.action;
    
    if (action === 'start_auction' && !AUCTION_ACTIVE) {
        startTimer();
    } else if (action === 'reset_auction') {
        resetAuction();
    }
    
    res.redirect('/admin_panel?pass=admin123');
});


// --- Socket.IO Handlers ---

// Participant Namespace
participantNsp.on('connection', (socket) => {
    console.log(`Participant connected: ${socket.id}`);
    
    // Send initial state
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
        
        // Notify the Admin
        adminNsp.emit('admin_update_bids', { [assetId]: asset });
    });
});

// Admin Namespace
adminNsp.on('connection', (socket) => {
    console.log(`Admin connected: ${socket.id}`);
    
    // Send full, current state to the admin upon connection
    socket.emit('initial_admin_state', {
        teams: TEAMS, 
        assets: ASSET_CATALOG, 
        active: AUCTION_ACTIVE, 
        timeLeft: getRemainingTime() 
    });

    // --- NEW HANDLER FOR ADMIN FORCE STOP ---
    socket.on('force_stop_auction', () => {
        if (!AUCTION_ACTIVE) {
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