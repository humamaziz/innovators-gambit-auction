// server.js
const express = require('express');
const http = require('http');
const socketio = require('socket.io');
const path = require('path');
const fs = require('fs');
const session = require('express-session');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);

const DATA_FILE = path.join(__dirname, 'game_data.json'); 
const SECRET_KEY = process.env.SESSION_SECRET || 'a_very_long_secret_key_for_gambit_auction_2025';

// --- CRITICAL PROXY & TRUST SETTING ---
// This tells Express to trust the proxy (Render) for secure cookies.
app.set('trust proxy', 1); 

// --- Configure Middleware (ORDER IS CRUCIAL) ---

// 1. Configure Session Middleware
app.use(session({
    secret: SECRET_KEY,
    resave: false,
    saveUninitialized: false, 
    cookie: { 
        secure: true,       // Must be true for HTTPS (Render)
        sameSite: 'none',   // Must be 'none' for proxy environments
        path: '/'           // Ensures cookie is valid across all routes
    }
}));

// 2. Configure JSON and URL Encoding Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 3. Configure Static File Serving
app.use(express.static(path.join(__dirname, 'public')));


// --- Global State & Persistence Functions ---
let STATE = loadState(); 
let AUCTION_TIMER_INTERVAL = null;
let LIVE_BID_LOG = []; // Stores real-time bid history for Admin view

const io = socketio(server);
io.use((socket, next) => {
    session({
        secret: SECRET_KEY,
        resave: false,
        saveUninitialized: true,
        cookie: { secure: process.env.NODE_ENV === 'production' }
    })(socket.request, socket.request.res || {}, next);
});

const participantNsp = io.of("/");
const adminNsp = io.of("/admin");

const PORT = process.env.PORT || 3000;


function loadState() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const data = fs.readFileSync(DATA_FILE, 'utf8');
            return JSON.parse(data);
        }
    } catch (e) {
        console.error("Error loading state:", e);
    }
    return {
        ASSET_CATALOG: {}, 
        TEAMS: {}, 
        AUCTION_ACTIVE: false,
        AUCTION_END_TIME: null,
        AUCTION_DURATION_SECONDS: 30 * 60,
        LIVE_GAME_ID: 1,
        GAME_HISTORY: [], 
        ADMIN_USERNAME: 'mohdhumama@gmail.com',
        ADMIN_PASSWORD: 'Humam@2004' 
    };
}

function saveState() {
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify(STATE, null, 2), 'utf8');
    } catch (e) {
        console.error("Error saving state:", e);
    }
}

// --- Game Logic ---

function getRemainingTime() {
    if (!STATE.AUCTION_ACTIVE || !STATE.AUCTION_END_TIME) return STATE.AUCTION_DURATION_SECONDS;
    const timeLeft = Math.max(0, Math.floor((STATE.AUCTION_END_TIME - Date.now()) / 1000));
    return timeLeft;
}

function startTimer() {
    if (AUCTION_TIMER_INTERVAL) return;
    
    STATE.AUCTION_END_TIME = Date.now() + STATE.AUCTION_DURATION_SECONDS * 1000;
    STATE.AUCTION_ACTIVE = true;
    saveState();
    
    const initialTimeLeft = getRemainingTime();
    participantNsp.emit('auction_start', { active: STATE.AUCTION_ACTIVE, endTime: STATE.AUCTION_END_TIME });
    adminNsp.emit('auction_start', { active: STATE.AUCTION_ACTIVE, timeLeft: initialTimeLeft });
    
    AUCTION_TIMER_INTERVAL = setInterval(() => {
        const timeLeft = getRemainingTime();
        
        participantNsp.emit('timer_update', { timeLeft: timeLeft });
        adminNsp.emit('timer_update', { timeLeft: timeLeft });
        
        if (timeLeft <= 0) {
            clearInterval(AUCTION_TIMER_INTERVAL);
            AUCTION_TIMER_INTERVAL = null;
            STATE.AUCTION_ACTIVE = false;
            resolveAuction();
        }
    }, 1000);
}

function resolveAuction() {
    if (AUCTION_TIMER_INTERVAL) {
        clearInterval(AUCTION_TIMER_INTERVAL);
        AUCTION_TIMER_INTERVAL = null;
    }
    STATE.AUCTION_ACTIVE = false;
    
    const winningBids = {};

    // 2. Determine winners for each item (Multi-Unit Logic)
    for (const assetId in STATE.ASSET_CATALOG) {
        const asset = STATE.ASSET_CATALOG[assetId];
        
        // Collect all valid bids
        let validBids = [];
        for (const teamId in asset.current_bids) {
            const bid = asset.current_bids[teamId];
            const team = STATE.TEAMS[teamId];
            
            if (bid >= asset.min_bid && team && bid <= team.vc) {
                validBids.push({ teamId, bid, name: team.name });
            }
        }

        const availableQuantity = asset.quantity;
        
        // Sort bids from highest to lowest
        validBids.sort((a, b) => b.bid - a.bid);
        
        // Determine the winning pool (Top N bidders)
        const winningBidders = validBids.slice(0, availableQuantity);

        if (winningBidders.length > 0) {
            // The winning price is the lowest bid among the winners (Uniform Price)
            const winningPricePerUnit = winningBidders[winningBidders.length - 1].bid; 
            
            asset.winner = "MULTIPLE"; 
            asset.final_price = winningPricePerUnit;
            asset.winning_pool = winningBidders.map(w => w.teamId); 
            
            // Group winning bids by team for deduction later
            winningBidders.forEach(winner => {
                if (!winningBids[winner.teamId]) {
                    winningBids[winner.teamId] = [];
                }
                winningBids[winner.teamId].push({ 
                    assetId: assetId, 
                    price: winningPricePerUnit,
                    quantity_won: 1 
                });
            });
        } else {
            asset.winner = "NO_WINNER";
            asset.final_price = 0;
            asset.winning_pool = [];
        }
    }

    // 3. Process winning bids and deduct VC
    for (const teamId in winningBids) {
        const team = STATE.TEAMS[teamId];
        const totalCost = winningBids[teamId].reduce((sum, win) => sum + (win.price * win.quantity_won), 0);
        
        if (totalCost <= team.vc) {
            team.vc -= totalCost;
            winningBids[teamId].forEach(win => {
                team.assets_won.push({
                    name: STATE.ASSET_CATALOG[win.assetId].name,
                    cost: win.price, // Store price per unit
                    quantity: win.quantity_won
                });
            });
        } else {
            // VOID Logic
            for (const win of winningBids[teamId]) {
                STATE.ASSET_CATALOG[win.assetId].winner = "VOID (Budget Fail)";
                STATE.ASSET_CATALOG[win.assetId].final_price = 0;
                STATE.ASSET_CATALOG[win.assetId].winning_pool = []; 
            }
        }
    }
    
    // Clear log when resolving
    LIVE_BID_LOG = []; 

    saveState();
    participantNsp.emit('auction_finished', STATE.ASSET_CATALOG);
    adminNsp.emit('auction_finished', STATE.ASSET_CATALOG);
    adminNsp.emit('admin_update_teams', STATE.TEAMS);
}

function resetLiveGameState() {
    if (AUCTION_TIMER_INTERVAL) {
        clearInterval(AUCTION_TIMER_INTERVAL);
        AUCTION_TIMER_INTERVAL = null;
    }
    STATE.AUCTION_ACTIVE = false;
    STATE.AUCTION_END_TIME = null;
    
    LIVE_BID_LOG = []; 

    for (const id in STATE.ASSET_CATALOG) {
        STATE.ASSET_CATALOG[id].current_bids = {};
        STATE.ASSET_CATALOG[id].winner = null;
        STATE.ASSET_CATALOG[id].final_price = 0;
        STATE.ASSET_CATALOG[id].winning_pool = []; 
    }
    
    for (const id in STATE.TEAMS) {
        // Reset VC to starting VC
        STATE.TEAMS[id].vc = STATE.TEAMS[id].starting_vc || 500000;
        STATE.TEAMS[id].assets_won = [];
    }

    saveState();
    participantNsp.emit('auction_reset');
    adminNsp.emit('auction_reset');
}


// --- Express Routing (Auth and API) ---

app.get('/', (req, res) => {
    if (req.session.isAdmin) {
        return res.redirect('/admin_panel');
    }
    if (req.session.teamId && STATE.TEAMS[req.session.teamId]) {
        return res.sendFile(path.join(__dirname, 'public', 'bidding.html'));
    }
    return res.redirect('/login_page');
});

app.get('/login_page', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) {
            console.error('Error destroying session:', err);
            return res.redirect('/');
        }
        res.clearCookie('connect.sid'); 
        res.redirect('/login_page');
    });
});

// Login POST Handler (CRITICAL ASYNC SAVE)
app.post('/login', (req, res) => {
    const { username, password } = req.body;

    if (username === STATE.ADMIN_USERNAME && password === STATE.ADMIN_PASSWORD) {
        req.session.isAdmin = true;
        return req.session.save(err => {
            if (err) {
                console.error("Session save error (Admin):", err);
                return res.send('Login Error. Please try clearing browser cache.');
            }
            res.redirect('/admin_panel');
        });
    }

    for (const teamId in STATE.TEAMS) {
        const team = STATE.TEAMS[teamId];
        if (team.username === username && team.password === password) {
            req.session.teamId = team.id;
            
            return req.session.save(err => {
                if (err) {
                    console.error("Session save error (Team):", err);
                    return res.send('Login Error. Please try clearing browser cache.');
                }
                res.redirect('/');
            });
        }
    }

    return res.send('Invalid credentials. <a href="/login_page">Try again</a>.');
});

// Admin Panel Routes (Protected)
app.get('/admin_panel', (req, res) => {
    if (!req.session.isAdmin) {
        return res.redirect('/');
    }
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Admin Action POST Handler (Handles START/RESET)
app.post('/admin_action', (req, res) => {
    if (!req.session.isAdmin) return res.status(403).send("Unauthorized Action.");
    
    const action = req.body.action;
    
    if (action === 'set_duration') {
        const durationMinutes = parseInt(req.body.duration_minutes);
        if (durationMinutes > 0 && !STATE.AUCTION_ACTIVE) {
            STATE.AUCTION_DURATION_SECONDS = durationMinutes * 60;
            saveState();
        }
    } else if (action === 'start_auction' && !STATE.AUCTION_ACTIVE) {
        startTimer();
        adminNsp.emit('system_message', { type: 'success', text: 'Auction Started Successfully.' });

    } else if (action === 'reset_all') {
        if (Object.keys(STATE.ASSET_CATALOG).length > 0 && STATE.TEAMS) {
            STATE.GAME_HISTORY.push({
                gameId: STATE.LIVE_GAME_ID,
                date: new Date().toISOString(),
                duration: STATE.AUCTION_DURATION_SECONDS,
                assets: JSON.parse(JSON.stringify(STATE.ASSET_CATALOG)),
                teams: JSON.parse(JSON.stringify(STATE.TEAMS))
            });
            STATE.LIVE_GAME_ID++;
        }
        resetLiveGameState();
    }
    
    res.redirect('/admin_panel');
});

// --- REST API for Admin CRUD ---

app.get('/api/admin/state', (req, res) => {
    if (!req.session.isAdmin) return res.status(403).json({ error: "Forbidden" });
    res.json({
        assets: STATE.ASSET_CATALOG,
        teams: STATE.TEAMS,
        history: STATE.GAME_HISTORY,
        duration: STATE.AUCTION_DURATION_SECONDS / 60,
        active: STATE.AUCTION_ACTIVE
    });
});

app.get('/api/admin/logs', (req, res) => {
    if (!req.session.isAdmin) return res.status(403).json({ error: "Forbidden" });
    res.json(LIVE_BID_LOG.reverse()); // Send reversed log for newest first
});


app.post('/api/admin/asset', (req, res) => {
    if (!req.session.isAdmin) return res.status(403).json({ error: "Forbidden" });
    const { id, name, category, min_bid, quantity, action } = req.body;
    const bid = parseInt(min_bid);
    const qty = parseInt(quantity);
    
    if (action === 'add') {
        const newId = uuidv4();
        STATE.ASSET_CATALOG[newId] = { 
            id: newId, name, category, min_bid: bid, quantity: qty,
            current_bids: {}, winner: null, final_price: 0, winning_pool: []
        };
    } else if (action === 'update' && STATE.ASSET_CATALOG[id]) {
        STATE.ASSET_CATALOG[id].name = name;
        STATE.ASSET_CATALOG[id].category = category;
        STATE.ASSET_CATALOG[id].min_bid = bid;
        STATE.ASSET_CATALOG[id].quantity = qty;
    } else if (action === 'delete' && STATE.ASSET_CATALOG[id]) {
        delete STATE.ASSET_CATALOG[id];
    } else {
        return res.status(400).json({ error: "Invalid action or ID." });
    }
    
    saveState();
    res.json({ success: true, assets: STATE.ASSET_CATALOG });
});

app.post('/api/admin/team', (req, res) => {
    if (!req.session.isAdmin) return res.status(403).json({ error: "Forbidden" });
    const { id, name, username, password, starting_vc, action } = req.body;
    const initialVC = parseInt(starting_vc);

    if (action === 'add') {
        const newId = uuidv4();
        STATE.TEAMS[newId] = { id: newId, name, username, password, vc: initialVC, starting_vc: initialVC, assets_won: [] };
    } else if (action === 'update' && STATE.TEAMS[id]) {
        STATE.TEAMS[id].name = name;
        STATE.TEAMS[id].username = username;
        STATE.TEAMS[id].password = password;
        STATE.TEAMS[id].starting_vc = initialVC;
    } else if (action === 'delete' && STATE.TEAMS[id]) {
        delete STATE.TEAMS[id];
    } else {
        return res.status(400).json({ error: "Invalid action or ID." });
    }
    
    saveState();
    res.json({ success: true, teams: STATE.TEAMS });
});


// --- Socket.IO Handlers (Real-time) ---

participantNsp.on('connection', (socket) => {
    const teamId = socket.request.session.teamId;
    if (!teamId || !STATE.TEAMS[teamId]) {
        socket.disconnect(true);
        return;
    }

    // FIX: Send initial state immediately upon successful socket connection
    socket.emit('initial_state', {
        teamId: teamId,
        teamData: STATE.TEAMS[teamId],
        assets: STATE.ASSET_CATALOG, 
        active: STATE.AUCTION_ACTIVE, 
        endTime: STATE.AUCTION_END_TIME
    });
    
    socket.on('place_bid', (data) => {
        if (!STATE.AUCTION_ACTIVE) {
            socket.emit('bid_response', { success: false, message: 'Auction is not active.' });
            return;
        }

        const { assetId, bidAmount } = data;
        const bid = parseInt(bidAmount);
        const asset = STATE.ASSET_CATALOG[assetId];
        const team = STATE.TEAMS[teamId];

        if (!asset || !team) { return; }

        if (bid < asset.min_bid) {
            socket.emit('bid_response', { success: false, message: `Bid must be at least $${asset.min_bid.toLocaleString()} VC (per unit).` });
            return;
        }
        
        if (bid > team.vc) {
             socket.emit('bid_response', { success: false, message: `Bid of $${bid.toLocaleString()} VC exceeds your current VC balance.` });
             return;
        }

        asset.current_bids[teamId] = bid;
        saveState();

        // NEW: Add entry to log
        LIVE_BID_LOG.push({
            time: new Date().toLocaleTimeString(),
            teamName: team.name,
            assetName: asset.name,
            bidAmount: bid,
            type: 'bid'
        });

        socket.emit('bid_response', { 
            success: true, 
            message: `Bid of $${bid.toLocaleString()} recorded for ${asset.name} (per unit).`,
            assetId: assetId, 
            newBid: bid 
        });
        
        adminNsp.emit('admin_update_bids', { [assetId]: asset });
        adminNsp.emit('new_log_entry', LIVE_BID_LOG[LIVE_BID_LOG.length - 1]);
    });
});

adminNsp.on('connection', (socket) => {
    
    socket.on('force_stop_auction', () => {
        if (!STATE.AUCTION_ACTIVE) {
            socket.emit('admin_action_response', { success: false, message: 'Auction is already stopped or finished.' });
            return;
        }
        
        STATE.AUCTION_END_TIME = Date.now() - 1000; 
        STATE.AUCTION_ACTIVE = false;
        
        resolveAuction(); 
        socket.emit('admin_action_response', { success: true, message: 'Auction forcefully stopped and results resolved.' });
    });
});


// --- Start Server ---
server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});

// Helper function for display
function formatVC(amount) {
    return `$${amount.toLocaleString()}`;
}