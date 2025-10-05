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

// 1. Configure Session Middleware (CRITICAL FIX: Added cookie path)
app.use(session({
    secret: SECRET_KEY,
    resave: false,
    saveUninitialized: false,
    cookie: { 
        secure: true,       // Must be true for HTTPS (Render)
        sameSite: 'none',   // Must be 'none' for cross-domain/proxy
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
        // Updated Admin Credentials
        ADMIN_USERNAME: 'mohdhumama5@gmail.com',
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
    
    // NOTE: Full resolution logic is omitted here for brevity, but remains in the actual file.
    // It determines winners, deducts VC, and updates STATE.ASSET_CATALOG and STATE.TEAMS.
    
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
    // Final routing fix ensures non-authenticated users land on login page
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
        res.redirect('/login_page'); // Redirect to login page after logout
    });
});

// Login POST Handler (Async save is critical for Render)
app.post('/login', (req, res) => {
    const { username, password } = req.body;

    // 1. Check Admin login
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

    // 2. Check Team login
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

    // 3. Invalid credentials
    // The previous failed login error text will be removed by the redirect to /login_page
    return res.send('Invalid credentials. <a href="/login_page">Try again</a>.');
});

// Admin Panel Routes (Protected) and CRUD APIs...
// (These routes remain the same as the final versions)

// --- Start Server ---
server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});