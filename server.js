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
// This tells Express to trust the proxy (Render) and allows secure cookies to work.
app.set('trust proxy', 1); 

// --- Configure Middleware (ORDER IS CRUCIAL) ---

// 1. Configure Session Middleware (with final stable config)
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

// --- Game Logic (Only showing core functions) ---

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

    // 1. Check Admin login
    if (username === STATE.ADMIN_USERNAME && password === STATE.ADMIN_PASSWORD) {
        req.session.isAdmin = true;
        return req.session.save(err => { // Wait for session save
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
            
            return req.session.save(err => { // Wait for session save
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

// ... (Rest of Admin CRUD and Socket.IO handlers omitted for brevity, but they are included in your full file)
// Note: Ensure the remaining portion of your server.js is intact from the previous step.


// --- Start Server ---
server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});