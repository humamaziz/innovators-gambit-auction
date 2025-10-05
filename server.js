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

// --- Configure Middleware (ORDER IS CRUCIAL) ---
// Configure Session Middleware
app.use(session({
    secret: SECRET_KEY,
    resave: false,
    saveUninitialized: false, // Changed to false to minimize session creation
    cookie: { 
        secure: true, // IMPORTANT: Render forces HTTPS, so this must be true
        sameSite: 'none' // IMPORTANT: Necessary for cross-site cookie settings on HTTPS
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

// Use two namespaces
const io = socketio(server);
// Attach session middleware to socket.io for authentication within the namespaces
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

// Default initial state
return {
    ASSET_CATALOG: {}, 
    TEAMS: {}, 
    AUCTION_ACTIVE: false,
    AUCTION_END_TIME: null,
    AUCTION_DURATION_SECONDS: 30 * 60, 
    LIVE_GAME_ID: 1,
    GAME_HISTORY: [], 
    
    // --- UPDATED ADMIN CREDENTIALS ---
    ADMIN_USERNAME: 'mohdhumama@gmail.com', // NEW USERNAME
    ADMIN_PASSWORD: 'Humam@2004'          // NEW PASSWORD
};
}

function saveState() {
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify(STATE, null, 2), 'utf8');
    } catch (e) {
        console.error("Error saving state:", e);
    }
}

// --- Game Logic Updates (Uses STATE object) ---

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

    for (const assetId in STATE.ASSET_CATALOG) {
        const asset = STATE.ASSET_CATALOG[assetId];
        let validBids = {};
        
        for (const teamId in asset.current_bids) {
            const bid = asset.current_bids[teamId];
            const team = STATE.TEAMS[teamId];
            if (bid >= asset.min_bid && team && bid <= team.vc) {
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

    for (const teamId in winningBids) {
        const team = STATE.TEAMS[teamId];
        const totalCost = winningBids[teamId].reduce((sum, win) => sum + win.price, 0);

        if (totalCost <= team.vc) {
            team.vc -= totalCost;
            for (const win of winningBids[teamId]) {
                team.assets_won.push({
                    name: STATE.ASSET_CATALOG[win.assetId].name,
                    cost: win.price
                });
            }
        } else {
            for (const win of winningBids[teamId]) {
                STATE.ASSET_CATALOG[win.assetId].winner = "VOID (Budget Fail)";
                STATE.ASSET_CATALOG[win.assetId].final_price = 0;
            }
        }
    }
    
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
    
    for (const id in STATE.ASSET_CATALOG) {
        STATE.ASSET_CATALOG[id].current_bids = {};
        STATE.ASSET_CATALOG[id].winner = null;
        STATE.ASSET_CATALOG[id].final_price = 0;
    }
    
    for (const id in STATE.TEAMS) {
        STATE.TEAMS[id].vc = 500000;
        STATE.TEAMS[id].assets_won = [];
    }

    saveState();
    participantNsp.emit('auction_reset');
    adminNsp.emit('auction_reset');
}

// server.js (Around line 200)

// Root Route: Handles authentication and redirection
// server.js (Around line 200, only showing the relevant change)

app.get('/', (req, res) => {
    // 1. Admin authenticated
    if (req.session.isAdmin) {
        return res.redirect('/admin_panel');
    }
    // 2. Team authenticated
    if (req.session.teamId && STATE.TEAMS[req.session.teamId]) {
        // *** UPDATED FILENAME HERE ***
        return res.sendFile(path.join(__dirname, 'public', 'bidding.html'));
    }
    // 3. Not authenticated -> Redirect to the specific login route
    return res.redirect('/login_page');
});

// NEW: Dedicated Login Page Route
app.get('/login_page', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Logout Route
app.get('/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) {
            console.error('Error destroying session:', err);
            return res.redirect('/');
        }
        res.clearCookie('connect.sid'); 
        res.redirect('/');
    });
});

// Login POST Handler
app.post('/login', (req, res) => {
    const { username, password } = req.body;

    // 1. Check Admin login
    if (username === STATE.ADMIN_USERNAME && password === STATE.ADMIN_PASSWORD) {
        req.session.isAdmin = true;
        // Save session and redirect ONLY after save is complete
        return req.session.save(err => {
            if (err) {
                console.error("Session save error (Admin):", err);
                return res.send('Login Error. Please try clearing browser cache.');
            }
            res.redirect('/admin_panel');
        });
    }

    // 2. Check Team login
    for (const teamId in STATE.TEAMS) {
        const team = STATE.TEAMS[teamId];
        if (team.username === username && team.password === password) {
            req.session.teamId = team.id;
            
            // Save session and redirect ONLY after save is complete
            return req.session.save(err => {
                if (err) {
                    console.error("Session save error (Team):", err);
                    return res.send('Login Error. Please try clearing browser cache.');
                }
                res.redirect('/');
            });
        }
    }

    // 3. Invalid credentials
    return res.send('Invalid credentials. <a href="/login_page">Try again</a>.');
});

// Admin Panel Routes (Protected)
app.get('/admin_panel', (req, res) => {
    if (!req.session.isAdmin) {
        return res.redirect('/');
    }
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

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

app.post('/api/admin/asset', (req, res) => {
    if (!req.session.isAdmin) return res.status(403).json({ error: "Forbidden" });
    const { id, name, category, min_bid, action } = req.body;
    const bid = parseInt(min_bid);
    
    if (action === 'add') {
        const newId = uuidv4();
        STATE.ASSET_CATALOG[newId] = { id: newId, name, category, min_bid: bid, current_bids: {}, winner: null, final_price: 0 };
    } else if (action === 'update' && STATE.ASSET_CATALOG[id]) {
        STATE.ASSET_CATALOG[id].name = name;
        STATE.ASSET_CATALOG[id].category = category;
        STATE.ASSET_CATALOG[id].min_bid = bid;
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
    const { id, name, username, password, action } = req.body;
    
    if (action === 'add') {
        const newId = uuidv4();
        STATE.TEAMS[newId] = { id: newId, name, username, password, vc: 500000, assets_won: [] };
    } else if (action === 'update' && STATE.TEAMS[id]) {
        STATE.TEAMS[id].name = name;
        STATE.TEAMS[id].username = username;
        STATE.TEAMS[id].password = password;
    } else if (action === 'delete' && STATE.TEAMS[id]) {
        delete STATE.TEAMS[id];
    } else {
        return res.status(400).json({ error: "Invalid action or ID." });
    }
    
    saveState();
    res.json({ success: true, teams: STATE.TEAMS });
});


// --- Socket.IO Handlers (Real-time) ---

// Participant Namespace
participantNsp.on('connection', (socket) => {
    const teamId = socket.request.session.teamId;
    if (!teamId || !STATE.TEAMS[teamId]) {
        socket.disconnect(true);
        return;
    }

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
            socket.emit('bid_response', { success: false, message: `Bid must be at least $${asset.min_bid.toLocaleString()} VC.` });
            return;
        }
        
        if (bid > team.vc) {
             socket.emit('bid_response', { success: false, message: `Bid of $${bid.toLocaleString()} VC exceeds your current VC balance.` });
             return;
        }

        asset.current_bids[teamId] = bid;
        saveState();

        socket.emit('bid_response', { 
            success: true, 
            message: `Bid of $${bid.toLocaleString()} VC recorded for ${asset.name}.`,
            assetId: assetId, 
            newBid: bid 
        });
        
        adminNsp.emit('admin_update_bids', { [assetId]: asset });
    });
});

// Admin Namespace
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