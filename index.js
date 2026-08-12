console.log('=== APP VERSION 2.6.0 (Poll support + chatbot reliability) ===');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Client, LocalAuth, Poll } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || __dirname;
const SCHEDULE_FILE = path.join(DATA_DIR, 'schedule.json');
const CHATBOT_FILE = path.join(DATA_DIR, 'chatbot_rules.json');
const REPLIES_FILE = path.join(DATA_DIR, 'replies.json');
const TARGETED_CONTACTS_FILE = path.join(DATA_DIR, 'targeted_contacts.json');
const REPORT_SETTINGS_FILE = path.join(DATA_DIR, 'report_settings.json');

// === NEW: Session isolation strategy ===
// Persistent disk stores a BACKUP of the session (no Chromium lock files)
// Chromium runs from /tmp which is container-local (never shared between containers)
const PERSISTENT_SESSION_DIR = path.join(DATA_DIR, 'session-backup');
const LOCAL_AUTH_DIR = '/tmp/wwebjs_auth';
const LOCAL_SESSION_DIR = path.join(LOCAL_AUTH_DIR, 'session');

app.use(express.json());

// === AUTHENTICATION MIDDLEWARE ===
const AUTH_USER = process.env.AUTH_USER || 'admin';
const AUTH_PASS = process.env.AUTH_PASS || 'admin123';
const SESSION_TOKEN = Buffer.from(`${AUTH_USER}:${AUTH_PASS}`).toString('base64');

function getSessionCookie(req) {
    if (!req.headers.cookie) return null;
    const cookies = {};
    req.headers.cookie.split(';').forEach(c => {
        const idx = c.indexOf('=');
        if (idx !== -1) {
            const key = c.substring(0, idx).trim();
            const val = c.substring(idx + 1).trim();
            cookies[key] = val;
        }
    });
    return cookies['auth_session'];
}

function requireAuth(req, res, next) {
    // Exclude login routes
    if (req.path === '/login' || req.path === '/api/login') {
        return next();
    }

    const session = getSessionCookie(req);
    if (session === SESSION_TOKEN) {
        return next();
    }

    // Protect REST endpoints with 401 response
    if (req.path.startsWith('/api/') || req.path === '/download-report') {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    // Redirect webpage requests to login page
    res.redirect('/login');
}

app.use(requireAuth);

// Serve static UI assets
app.use(express.static(path.join(__dirname, 'public')));

// Serve login page
app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Login POST endpoint
app.post('/api/login', (req, res) => {
    const { username, password } = req.body || {};
    if (username === AUTH_USER && password === AUTH_PASS) {
        // Set HTTP-only session cookie valid for 30 days
        res.setHeader('Set-Cookie', `auth_session=${SESSION_TOKEN}; Path=/; HttpOnly; Max-Age=${30 * 24 * 60 * 60}; SameSite=Lax`);
        return res.json({ success: true });
    }
    return res.status(401).json({ error: 'Invalid username or password' });
});

// Logout POST endpoint
app.post('/api/logout', (req, res) => {
    res.setHeader('Set-Cookie', 'auth_session=; Path=/; HttpOnly; Max-Age=0; SameSite=Lax');
    return res.json({ success: true });
});

// Global state variables
let whatsappClientReady = false;
let lastQrCodeData = null;
let activeAutomation = null; // Stores running automation state
let shouldStopAutomation = false;
let activeCronJobs = new Map();

// === POLL TRACKING ===
// Maps serialized poll message ID -> { scheduleId, scheduleName, chatbotMode, chatbotId, chatbotRules, contacts, sentAt }
const sentPollMap = new Map();
const POLL_MAP_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours

function cleanExpiredPolls() {
    const now = Date.now();
    for (const [key, val] of sentPollMap) {
        if (now - val.sentAt > POLL_MAP_EXPIRY_MS) {
            sentPollMap.delete(key);
        }
    }
}
// Clean expired polls every hour
setInterval(cleanExpiredPolls, 60 * 60 * 1000);

// === IN-MEMORY DEBUG LOG (viewable from browser via /api/debug-log) ===
const debugLogEntries = [];
const MAX_DEBUG_ENTRIES = 200;
function debugLog(tag, message) {
    const entry = `[${new Date().toISOString()}] [${tag}] ${message}`;
    console.log(entry);
    debugLogEntries.push(entry);
    if (debugLogEntries.length > MAX_DEBUG_ENTRIES) debugLogEntries.shift();
    io.emit('debug_log', entry);
}

// Track processed message IDs to avoid duplicate processing from dual event listeners
const processedMessageIds = new Set();
const MAX_PROCESSED_IDS = 1000;
function markProcessed(id) {
    processedMessageIds.add(id);
    if (processedMessageIds.size > MAX_PROCESSED_IDS) {
        const first = processedMessageIds.values().next().value;
        processedMessageIds.delete(first);
    }
}

// === LID-TO-PHONE MAPPING ===
const LID_MAP_FILE = path.join(DATA_DIR, 'lid_map.json');
let lidToPhone = {};  // { "73933600633038@lid": "972506798676@c.us", ... }
let phoneToLid = {};  // reverse map

if (fs.existsSync(LID_MAP_FILE)) {
    try {
        lidToPhone = JSON.parse(fs.readFileSync(LID_MAP_FILE, 'utf8'));
        for (const [lid, phone] of Object.entries(lidToPhone)) {
            phoneToLid[phone] = lid;
        }
        console.log(`Loaded LID map with ${Object.keys(lidToPhone).length} entries.`);
    } catch (e) {
        console.error('Error reading lid_map.json:', e.message);
    }
}

function saveLidMap() {
    try {
        fs.writeFileSync(LID_MAP_FILE, JSON.stringify(lidToPhone, null, 2));
    } catch (err) {
        console.error('Failed to save lid_map.json:', err.message);
    }
}

function registerLidMapping(lid, phoneJid) {
    if (!lid || !phoneJid) return;
    if (lidToPhone[lid] === phoneJid) return;
    lidToPhone[lid] = phoneJid;
    phoneToLid[phoneJid] = lid;
    saveLidMap();
    debugLog('LID_MAP', `Mapped ${lid} <-> ${phoneJid}`);
}

function resolveToPhone(jid) {
    if (!jid) return jid;
    if (jid.endsWith('@c.us') || jid.endsWith('@g.us')) return jid;
    if (jid.endsWith('@lid') && lidToPhone[jid]) {
        return lidToPhone[jid];
    }
    return jid;
}

// Schedule Configuration state
let scheduleConfig = {
    enabled: true,
    schedules: []
};

// Chatbot Configuration state
let chatbotConfig = {
    chatbots: []
};

// Replies tracking data: { "YYYY-MM": { "DD": [ { phone, message, time } ] } }
let repliesData = {};

// Load existing configs
if (DATA_DIR !== __dirname) {
    if (!fs.existsSync(DATA_DIR)) {
        try {
            fs.mkdirSync(DATA_DIR, { recursive: true });
        } catch (err) {
            console.error('Failed to create DATA_DIR:', err.message);
        }
    }
    const filesToCopy = ['schedule.json', 'chatbot_rules.json'];
    filesToCopy.forEach(file => {
        const targetPath = path.join(DATA_DIR, file);
        const sourcePath = path.join(__dirname, file);
        if (!fs.existsSync(targetPath) && fs.existsSync(sourcePath)) {
            try {
                fs.copyFileSync(sourcePath, targetPath);
                console.log(`Initialized persistent volume file: ${file}`);
            } catch (err) {
                console.error(`Failed to copy ${file} to persistent disk:`, err.message);
            }
        }
    });
}

if (fs.existsSync(SCHEDULE_FILE)) {
    try {
        const raw = fs.readFileSync(SCHEDULE_FILE, 'utf8');
        scheduleConfig = JSON.parse(raw);
        if (!scheduleConfig.schedules) {
            scheduleConfig.schedules = [];
            if (scheduleConfig.time || scheduleConfig.contacts) {
                scheduleConfig.schedules.push({
                    id: 'default-' + Date.now(),
                    name: 'Default Schedule',
                    enabled: scheduleConfig.enabled !== undefined ? scheduleConfig.enabled : true,
                    time: scheduleConfig.time || '07:00',
                    timezone: scheduleConfig.timezone || 'UTC',
                    contacts: scheduleConfig.contacts || [],
                    message: scheduleConfig.message || ''
                });
            }
            scheduleConfig.enabled = true;
        }
        console.log(`Loaded schedule configuration: ${scheduleConfig.schedules.length} schedules registered.`);
    } catch (e) {
        console.error('Error reading schedule.json:', e.message);
    }
}

if (fs.existsSync(CHATBOT_FILE)) {
    try {
        const raw = fs.readFileSync(CHATBOT_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed.chatbots && Array.isArray(parsed.chatbots)) {
            chatbotConfig = parsed;
        } else {
            chatbotConfig = {
                chatbots: [
                    {
                        id: 'bot-default',
                        name: 'Default Chatbot',
                        enabled: parsed.enabled !== undefined ? parsed.enabled : true,
                        isDefault: true,
                        rules: parsed.rules || []
                    }
                ]
            };
        }
        console.log(`Loaded chatbot configuration: ${chatbotConfig.chatbots.length} chatbots registered.`);
    } catch (e) {
        console.error('Error reading chatbot_rules.json:', e.message);
    }
}

if (fs.existsSync(REPLIES_FILE)) {
    try {
        const raw = fs.readFileSync(REPLIES_FILE, 'utf8');
        repliesData = JSON.parse(raw);
        console.log('Loaded replies tracking data.');
    } catch (e) {
        console.error('Error reading replies.json:', e.message);
    }
}

let reportSettings = {
    limitGathering: false,
    startTime: '07:00',
    endTime: '12:00',
    reportSources: []
};

if (fs.existsSync(REPORT_SETTINGS_FILE)) {
    try {
        const raw = fs.readFileSync(REPORT_SETTINGS_FILE, 'utf8');
        reportSettings = JSON.parse(raw);
        console.log('Loaded report settings:', reportSettings);
    } catch (e) {
        console.error('Error reading report_settings.json:', e.message);
    }
}

// === TARGETED CONTACTS TRACKING ===
let targetedContacts = new Set();

if (fs.existsSync(TARGETED_CONTACTS_FILE)) {
    try {
        const raw = fs.readFileSync(TARGETED_CONTACTS_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        targetedContacts = new Set(parsed);
        console.log(`Loaded ${targetedContacts.size} targeted contacts.`);
    } catch (e) {
        console.error('Error reading targeted_contacts.json:', e.message);
    }
}

function recordTargetedContact(id) {
    console.log(`[recordTargetedContact] Called with id: ${id}, already tracked: ${targetedContacts.has(id)}, current set size: ${targetedContacts.size}`);
    if (!targetedContacts.has(id)) {
        targetedContacts.add(id);
        try {
            fs.writeFileSync(TARGETED_CONTACTS_FILE, JSON.stringify(Array.from(targetedContacts), null, 2));
            console.log(`[recordTargetedContact] SUCCESS - Recorded new targeted contact: ${id}. Total tracked: ${targetedContacts.size}`);
        } catch (err) {
            console.error('[recordTargetedContact] FAILED to write targeted_contacts.json:', err.message);
        }
        io.emit('targeted_update', { count: targetedContacts.size, contacts: Array.from(targetedContacts) });
    }
}

function updateTargetedFromSchedule() {
    if (scheduleConfig && scheduleConfig.schedules) {
        scheduleConfig.schedules.forEach(schedule => {
            if (!schedule.enabled) return;
            if (schedule.contacts) {
                schedule.contacts.forEach(c => {
                    const rawPhone = c.phone.toString().trim();
                    let whatsappId;
                    if (rawPhone.endsWith('@g.us')) {
                        whatsappId = rawPhone;
                    } else if (rawPhone.endsWith('@c.us') || rawPhone.endsWith('@lid')) {
                        whatsappId = rawPhone;
                    } else {
                        const cleanPhone = rawPhone.replace(/[^0-9]/g, '');
                        whatsappId = `${cleanPhone}@c.us`;
                    }
                    recordTargetedContact(whatsappId);
                });
            }
        });
    }
}

function isTargeted(jid) {
    if (!jid) return false;
    if (targetedContacts.has(jid)) return true;
    if (jid.endsWith('@c.us')) {
        const cleanIncoming = jid.split('@')[0].replace(/[^0-9]/g, '');
        if (cleanIncoming.length >= 7) {
            for (const target of targetedContacts) {
                if (target.endsWith('@c.us')) {
                    const cleanTarget = target.split('@')[0].replace(/[^0-9]/g, '');
                    if (cleanTarget.length >= 7) {
                        const tailIncoming = cleanIncoming.slice(-7);
                        const tailTarget = cleanTarget.slice(-7);
                        if (tailIncoming === tailTarget) {
                            return true;
                        }
                    }
                }
            }
        }
    }
    return false;
}

function cleanDigits(str) {
    return (str || '').replace(/[^0-9]/g, '');
}

function sameContactNumber(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    const digitsA = cleanDigits(a);
    const digitsB = cleanDigits(b);
    if (!digitsA || !digitsB) return false;
    if (digitsA === digitsB) return true;
    if (digitsA.length >= 7 && digitsB.length >= 7) {
        return digitsA.slice(-7) === digitsB.slice(-7);
    }
    return false;
}

function isTriggerMatch(triggerConfig, incomingBody) {
    if (!triggerConfig || !incomingBody) return false;
    const incomingClean = incomingBody.trim().toLowerCase();
    const incomingWords = incomingClean.replace(/[^\w\s\u0590-\u05FF]/gi, '').trim();
    const triggers = triggerConfig.split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
    
    return triggers.some(t => {
        const cleanT = t.replace(/[^\w\s\u0590-\u05FF]/gi, '').trim();
        if (incomingClean === t || incomingWords === cleanT) return true;
        if (cleanT.length >= 2 && (incomingClean.includes(t) || incomingWords.includes(cleanT))) return true;
        return false;
    });
}

function parseWorkerChoice(msgText) {
    if (!msgText) return { choice: 'Other', label: 'Other / Uncategorized' };
    let str = msgText.trim().toLowerCase();
    
    // Strip prefixes like [Poll Vote], [Group Chat], etc.
    str = str.replace(/^\[(poll vote|group chat)\]\s*/i, '').trim();

    // Check exact match or leading number/option: "1", "1 - fine", "(1) fine", "option 1", "choice 1"
    if (/^(\(1\)|1|option\s*1|choice\s*1)(\s*[\-.,:]\s*|\s+|$)/i.test(str)) {
        return { choice: '1', label: 'Option 1 ("1")' };
    }
    if (/^(\(2\)|2|option\s*2|choice\s*2)(\s*[\-.,:]\s*|\s+|$)/i.test(str)) {
        return { choice: '2', label: 'Option 2 ("2")' };
    }
    if (/^(\(3\)|3|option\s*3|choice\s*3)(\s*[\-.,:]\s*|\s+|$)/i.test(str)) {
        return { choice: '3', label: 'Option 3 ("3")' };
    }

    // Check if single digits 1, 2, or 3 appear as a standalone word anywhere in message
    const tokens = str.split(/[\s,.\-()]+/);
    if (tokens.includes('1')) return { choice: '1', label: 'Option 1 ("1")' };
    if (tokens.includes('2')) return { choice: '2', label: 'Option 2 ("2")' };
    if (tokens.includes('3')) return { choice: '3', label: 'Option 3 ("3")' };

    return { choice: 'Other', label: 'Other / Uncategorized' };
}

function logReply(phone, name, messageText) {
    const now = new Date();
    let yearStr, monthStr, dayKey, timeStr;
    try {
        const formatter = new Intl.DateTimeFormat('en-GB', {
            timeZone: 'Asia/Jerusalem',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
        });
        const parts = formatter.formatToParts(now);
        const dateObj = {};
        parts.forEach(p => { dateObj[p.type] = p.value; });
        yearStr = dateObj.year;
        monthStr = dateObj.month;
        dayKey = dateObj.day;
        timeStr = `${dateObj.hour}:${dateObj.minute}`;
    } catch (err) {
        console.error('Failed to format date in Israel timezone:', err.message);
        yearStr = String(now.getUTCFullYear());
        monthStr = String(now.getUTCMonth() + 1).padStart(2, '0');
        dayKey = String(now.getUTCDate()).padStart(2, '0');
        timeStr = now.toLocaleTimeString('en-GB', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit' });
    }
    const monthKey = `${yearStr}-${monthStr}`;
    if (!repliesData[monthKey]) repliesData[monthKey] = {};
    if (!repliesData[monthKey][dayKey]) repliesData[monthKey][dayKey] = [];
    repliesData[monthKey][dayKey].push({
        phone,
        name,
        message: messageText,
        time: timeStr
    });
    try {
        fs.writeFileSync(REPLIES_FILE, JSON.stringify(repliesData, null, 2));
    } catch (err) {
        console.error('Failed to save replies.json:', err.message);
    }
    io.emit('new_reply', { phone, name, message: messageText, time: timeStr, day: dayKey, month: monthKey });
}

function copyDirSync(src, dest) {
    fs.mkdirSync(dest, { recursive: true });
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        if (['SingletonLock', 'SingletonCookie', 'SingletonSocket'].includes(entry.name)) {
            continue;
        }
        try {
            if (entry.isDirectory()) {
                copyDirSync(srcPath, destPath);
            } else {
                fs.copyFileSync(srcPath, destPath);
            }
        } catch (err) {
            if (err.code !== 'ENOENT') {
                console.warn(`  Skipping ${srcPath}: ${err.message}`);
            }
        }
    }
}

function restoreSessionFromBackup() {
    if (fs.existsSync(PERSISTENT_SESSION_DIR)) {
        console.log(`Restoring session from persistent backup: ${PERSISTENT_SESSION_DIR}`);
        try {
            copyDirSync(PERSISTENT_SESSION_DIR, LOCAL_SESSION_DIR);
            console.log(`Session restored to: ${LOCAL_SESSION_DIR}`);
        } catch (err) {
            console.error('Failed to restore session backup:', err.message);
        }
    } else {
        console.log('No session backup found on persistent disk. Will need QR scan.');
    }
}

function backupSessionToPersistent() {
    if (fs.existsSync(LOCAL_SESSION_DIR)) {
        console.log(`Backing up session to persistent disk: ${PERSISTENT_SESSION_DIR}`);
        try {
            if (fs.existsSync(PERSISTENT_SESSION_DIR)) {
                fs.rmSync(PERSISTENT_SESSION_DIR, { recursive: true, force: true });
            }
            copyDirSync(LOCAL_SESSION_DIR, PERSISTENT_SESSION_DIR);
            console.log('Session backup complete.');
        } catch (err) {
            console.error('Failed to backup session:', err.message);
        }
    }
}

console.log('--- Session Setup ---');
fs.mkdirSync(LOCAL_AUTH_DIR, { recursive: true });
restoreSessionFromBackup();

let client = null;

async function gracefulShutdown(signal) {
    console.log(`Received ${signal}. Shutting down gracefully...`);
    backupSessionToPersistent();
    try {
        if (client) {
            console.log('Destroying WhatsApp client...');
            await client.destroy();
            console.log('WhatsApp client destroyed.');
        }
    } catch (err) {
        console.error('Error destroying client during shutdown:', err.message);
    }
    process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('uncaughtException', (err) => {
    console.error('UNCAUGHT EXCEPTION:', err);
});
process.on('unhandledRejection', (reason) => {
    console.error('UNHANDLED REJECTION:', reason);
});

// === WhatsApp Client State Machine ===
let clientState = 'DISCONNECTED'; // DISCONNECTED | INITIALIZING | QR_READY | AUTHENTICATED | READY | ERROR
let clientStateMessage = 'Client disconnected';
let clientInitStartTime = null;
let initWatchdogTimer = null;
let isInitializingMutex = false;

function setClientStatus(status, message = '') {
    clientState = status;
    clientStateMessage = message;
    
    if (status === 'READY') {
        whatsappClientReady = true;
    } else {
        whatsappClientReady = false;
    }

    if (status !== 'QR_READY') {
        lastQrCodeData = null;
    }

    console.log(`[CLIENT STATUS CHANGE] ${status}: ${message}`);
    broadcastClientStatus();
}

function broadcastClientStatus(targetSocket = null) {
    const elapsedSeconds = clientInitStartTime ? Math.round((Date.now() - clientInitStartTime) / 1000) : 0;
    const payload = {
        status: clientState,
        message: clientStateMessage,
        ready: whatsappClientReady,
        hasQr: lastQrCodeData !== null,
        qrCodeUrl: lastQrCodeData,
        elapsedSeconds: elapsedSeconds
    };

    if (targetSocket) {
        targetSocket.emit('client_status', payload);
    } else {
        io.emit('client_status', payload);
    }
}

// Clean Chromium locks left behind by crashes or process kills
function cleanSessionLocks(dirPath) {
    if (!fs.existsSync(dirPath)) return;
    try {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dirPath, entry.name);
            if (['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'DevToolsActivePort', 'LOCK'].includes(entry.name)) {
                try {
                    fs.unlinkSync(fullPath);
                    console.log(`Removed stale lock file: ${entry.name}`);
                } catch (e) {}
            } else if (entry.isDirectory()) {
                cleanSessionLocks(fullPath);
            }
        }
    } catch (e) {
        console.warn('Error while cleaning session locks:', e.message);
    }
}

// Safely destroy existing client instance & clean lock files
async function safeCleanupClient(cleanAuthCache = false) {
    if (initWatchdogTimer) {
        clearTimeout(initWatchdogTimer);
        initWatchdogTimer = null;
    }

    if (client) {
        console.log('Closing existing WhatsApp client instance...');
        try {
            await Promise.race([
                client.destroy(),
                new Promise(resolve => setTimeout(resolve, 4000))
            ]);
        } catch (err) {
            console.warn('Warning during client.destroy:', err.message);
        }
        client = null;
    }

    whatsappClientReady = false;
    lastQrCodeData = null;

    if (cleanAuthCache) {
        console.log('Clearing entire WhatsApp auth session cache...');
        try {
            if (fs.existsSync(LOCAL_AUTH_DIR)) fs.rmSync(LOCAL_AUTH_DIR, { recursive: true, force: true });
            if (fs.existsSync(PERSISTENT_SESSION_DIR)) fs.rmSync(PERSISTENT_SESSION_DIR, { recursive: true, force: true });
            fs.mkdirSync(LOCAL_AUTH_DIR, { recursive: true });
        } catch (err) {
            console.error('Error clearing auth session directories:', err.message);
        }
    } else {
        // Just clean profile locks
        cleanSessionLocks(LOCAL_AUTH_DIR);
    }
}

// Create the WhatsApp client - Chromium runs from LOCAL /tmp directory
async function initializeWhatsAppClient(cleanAuthCache = false) {
    if (isInitializingMutex) {
        console.log('Initialization already in progress. Skipping duplicate call...');
        return;
    }

    isInitializingMutex = true;
    clientInitStartTime = Date.now();
    setClientStatus('INITIALIZING', cleanAuthCache ? 'Clearing cache & preparing QR code...' : 'Starting WhatsApp Web engine & restoring session...');
    io.emit('disconnected'); // Legacy UI compatibility

    try {
        await safeCleanupClient(cleanAuthCache);

        console.log('Spawning new WhatsApp Client instance...');
        client = new Client({
            authStrategy: new LocalAuth({
                dataPath: LOCAL_AUTH_DIR  // /tmp/wwebjs_auth - container-local
            }),
            puppeteer: {
                headless: true,
                executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--no-first-run',
                    '--disable-gpu',
                    '--no-zygote',
                    '--renderer-process-limit=1',
                    '--disable-features=site-per-process',
                    '--disable-extensions',
                    '--disable-background-networking',
                    '--disable-default-apps',
                    '--disable-translate',
                    '--disable-sync',
                    '--disable-notifications',
                    '--disable-component-update',
                    '--disable-domain-reliability',
                    '--disable-print-preview',
                    '--disable-speech-api',
                    '--metrics-recording-only',
                    '--no-default-browser-check',
                    '--disk-cache-size=0',
                    '--media-cache-size=0',
                    '--js-flags=--max-old-space-size=128'
                ]
            }
        });

        // 75-second Initialization Watchdog
        if (initWatchdogTimer) clearTimeout(initWatchdogTimer);
        initWatchdogTimer = setTimeout(() => {
            if (clientState === 'INITIALIZING') {
                console.error('WATCHDOG TRIGGERED: WhatsApp client initialization timed out after 75s!');
                setClientStatus('ERROR', 'Initialization timed out after 75 seconds. Please click restart.');
                io.emit('init_error', { message: 'Initialization timed out after 75s. Click restart to retry.' });
                io.emit('automation_log', { message: '❌ Initialization timed out (75s). Click restart to retry.', type: 'error' });
            }
        }, 75000);

        // WhatsApp Event Listeners
        client.on('qr', async (qr) => {
            console.log('QR Code received, converting for Web UI...');
            if (initWatchdogTimer) clearTimeout(initWatchdogTimer);
            qrcodeTerminal.generate(qr, { small: true });
            
            try {
                const qrUrl = await qrcode.toDataURL(qr);
                lastQrCodeData = qrUrl;
                setClientStatus('QR_READY', 'QR Code generated. Scan with WhatsApp app.');
                io.emit('qr', qrUrl);
            } catch (err) {
                console.error('Failed to generate QR data URL:', err.message);
            }
        });

        client.on('authenticated', () => {
            console.log('WhatsApp Authenticated!');
            lastQrCodeData = null;
            setClientStatus('AUTHENTICATED', 'Authenticated! Syncing WhatsApp web...');
            io.emit('authenticated');
            backupSessionToPersistent();
        });

        client.on('auth_failure', (msg) => {
            console.error('WhatsApp Authentication Failure:', msg);
            if (initWatchdogTimer) clearTimeout(initWatchdogTimer);
            setClientStatus('ERROR', `Authentication failure: ${msg}`);
            io.emit('automation_log', { message: `Auth Failure: ${msg}`, type: 'error' });
        });

        client.on('ready', () => {
            console.log('WhatsApp Client Ready!');
            if (initWatchdogTimer) clearTimeout(initWatchdogTimer);
            setClientStatus('READY', 'WhatsApp client connected & ready.');
            io.emit('ready');
            backupSessionToPersistent();
        });

        client.on('disconnected', (reason) => {
            console.log('WhatsApp Client Disconnected:', reason);
            if (initWatchdogTimer) clearTimeout(initWatchdogTimer);
            setClientStatus('DISCONNECTED', `Disconnected: ${reason || 'Session ended'}`);
            io.emit('disconnected');
        });

        // === SHARED MESSAGE HANDLER (attached to both 'message' and 'message_create') ===
        async function handleIncomingMessage(msg, eventSource) {
            if (msg.fromMe) return;
            const msgId = msg.id && msg.id._serialized ? msg.id._serialized : msg.id;
            if (processedMessageIds.has(msgId)) {
                debugLog(eventSource, `DEDUP - already processed ${msgId}, skipping.`);
                return;
            }
            markProcessed(msgId);

        // === RESOLVE @lid TO PHONE NUMBER ===
        let resolvedFrom = msg.from;
        if (msg.from.endsWith('@lid')) {
            // Try our cached map first
            const mapped = resolveToPhone(msg.from);
            if (mapped !== msg.from) {
                resolvedFrom = mapped;
                debugLog(eventSource, `Resolved ${msg.from} -> ${resolvedFrom} via LID map.`);
            } else {
                // Map miss: try to resolve via getContact()
                debugLog(eventSource, `LID map miss for ${msg.from}. Trying getContact()...`);
                try {
                    const contact = await msg.getContact();
                    if (contact && contact.number) {
                        const phoneJid = contact.number.replace(/[^0-9]/g, '') + '@c.us';
                        resolvedFrom = phoneJid;
                        registerLidMapping(msg.from, phoneJid);
                        debugLog(eventSource, `Resolved ${msg.from} -> ${resolvedFrom} via getContact(). Name: ${contact.name || 'N/A'}`);
                    } else {
                        debugLog(eventSource, `getContact() returned no number for ${msg.from}.`);
                    }
                } catch (err) {
                    debugLog(eventSource, `Failed to resolve @lid via getContact: ${err.message}`);
                }
            }
        }

        const isGroup = resolvedFrom.endsWith('@g.us');
        const sender = isGroup ? (msg.author || msg.from) : resolvedFrom;
        const targeted = isTargeted(resolvedFrom) || (msg.from !== resolvedFrom && isTargeted(msg.from));
        
        debugLog(eventSource, `from: ${msg.from}, resolved: ${resolvedFrom}, sender: ${sender}, targeted: ${targeted}, body: "${msg.body}"`);
        debugLog(eventSource, `Targeted contacts (${targetedContacts.size}): ${JSON.stringify(Array.from(targetedContacts))}`);

        if (!targeted) {
            debugLog(eventSource, `SKIPPED - ${resolvedFrom} (original: ${msg.from}) is NOT in targeted contacts.`);
            return;
        }

        // === GATHERING WINDOW CHECK (for report logging only, NOT chatbot) ===
        let isInsideGatheringWindow = true;
        if (reportSettings && reportSettings.limitGathering) {
            try {
                const formatter = new Intl.DateTimeFormat('en-GB', {
                    timeZone: 'Asia/Jerusalem',
                    hour: '2-digit',
                    minute: '2-digit',
                    hour12: false
                });
                const parts = formatter.formatToParts(new Date());
                const dateObj = {};
                parts.forEach(p => { dateObj[p.type] = p.value; });
                const currentStr = `${dateObj.hour}:${dateObj.minute}`;

                const start = reportSettings.startTime || '00:00';
                const end = reportSettings.endTime || '23:59';

                if (start <= end) {
                    isInsideGatheringWindow = (currentStr >= start && currentStr <= end);
                } else {
                    isInsideGatheringWindow = (currentStr >= start || currentStr <= end);
                }

                if (!isInsideGatheringWindow) {
                    debugLog(eventSource, `Message received at ${currentStr} is outside the gathering window (${start} - ${end}). Reply logging skipped, but chatbot will still evaluate.`);
                }
            } catch (err) {
                console.error('Failed to validate gathering window:', err.message);
            }
        }

        debugLog(eventSource, `MATCH FOUND - Processing message from ${resolvedFrom} (original: ${msg.from})`);

        const phone = sender.split('@')[0];
        const incomingText = msg.body.trim().toLowerCase();

        let displayName = phone;
        try {
            const contact = await msg.getContact();
            if (contact && contact.name) {
                displayName = contact.name;
            }
        } catch (err) {
            debugLog(eventSource, `Failed to get contact details: ${err.message}`);
        }

        debugLog(eventSource, `Received from ${isGroup ? 'group ' + resolvedFrom + ' (author: ' + displayName + ')' : displayName}: "${msg.body}"`);

        let messageText = msg.body ? msg.body.trim() : '';
        if (msg.hasMedia) {
            const typeStr = (msg.type || 'image').toLowerCase();
            let label = 'Media';
            if (typeStr === 'image') label = 'Image';
            else if (typeStr === 'video') label = 'Video';
            else if (typeStr === 'sticker') label = 'Sticker';
            else if (typeStr === 'document') label = 'Document';
            else if (typeStr === 'audio' || typeStr === 'ptt') label = 'Audio';

            messageText = messageText ? `[${label}] ${messageText}` : `[${label}]`;
        }

        // --- Log every incoming reply for the Excel report (only inside gathering window) ---
        if (isInsideGatheringWindow) {
            logReply(phone, displayName, isGroup ? `[Group Chat] ${messageText}` : messageText);
            debugLog(eventSource, `Reply logged. repliesData keys: ${JSON.stringify(Object.keys(repliesData))}`);
        } else {
            debugLog(eventSource, `Reply NOT logged (outside gathering window). Chatbot still active.`);
        }

        // === CHATBOT HANDLING (always runs, regardless of gathering window) ===
        if (msg.hasMedia) {
            debugLog(eventSource, `Chatbot skipping media message (type: ${msg.type}).`);
            return;
        }

        const bodyForTrigger = msg.body ? msg.body.trim() : '';
        if (!bodyForTrigger) {
            debugLog(eventSource, `Chatbot skipping empty message body.`);
            return;
        }

        let scheduleAutoReplied = false;

        // 1. Check schedule-specific chatbots first (sorted by specificity, custom bot priority, and recency)
        if (scheduleConfig && Array.isArray(scheduleConfig.schedules)) {
            const activeSchedules = scheduleConfig.schedules.filter(sch => {
                return sch.enabled !== false && sch.chatbotEnabled !== false && sch.chatbotMode && sch.chatbotMode !== 'off';
            });

            debugLog(eventSource, `Evaluating ${activeSchedules.length} active schedules with chatbots enabled out of ${scheduleConfig.schedules.length} total. bodyForTrigger="${bodyForTrigger}"`);

            const scoredSchedules = [];

            for (let i = 0; i < activeSchedules.length; i++) {
                const sch = activeSchedules[i];

                // Determine active rules for this schedule
                let rulesToEvaluate = [];
                if (sch.chatbotMode === 'custom') {
                    rulesToEvaluate = sch.chatbotRules || [];
                } else if (sch.chatbotMode === 'existing' || !sch.chatbotMode) {
                    if (sch.chatbotId) {
                        const targetBot = (chatbotConfig.chatbots || []).find(b => b.id === sch.chatbotId);
                        if (targetBot && targetBot.enabled !== false && Array.isArray(targetBot.rules)) {
                            rulesToEvaluate = targetBot.rules;
                        }
                    }
                    if (rulesToEvaluate.length === 0 && sch.chatbotRules && Array.isArray(sch.chatbotRules) && sch.chatbotRules.length > 0) {
                        rulesToEvaluate = sch.chatbotRules;
                    }
                }

                if (rulesToEvaluate.length === 0) continue;

                const schContacts = sch.contacts || [];
                let explicitContactMatch = false;
                const isContactInSchedule = schContacts.length === 0 || schContacts.some(c => {
                    if (c.paused) return false;
                    const cRaw = (c.phone || '').split('|')[0].trim();
                    const match = sameContactNumber(cRaw, resolvedFrom) ||
                           sameContactNumber(cRaw, msg.from) ||
                           sameContactNumber(cRaw, sender);
                    if (match) explicitContactMatch = true;
                    return match;
                });

                if (!isContactInSchedule) continue;

                // Score schedule for priority:
                // +100 for explicit contact match
                // +50 for custom rules or specific linked chatbot
                // +i for recency (newer schedules have higher index)
                const isCustomOrSpecific = sch.chatbotMode === 'custom' || (sch.chatbotId && sch.chatbotId !== 'bot-default');
                const score = (explicitContactMatch ? 100 : 0) + (isCustomOrSpecific ? 50 : 0) + i;

                scoredSchedules.push({ sch, rulesToEvaluate, score, explicitContactMatch });
            }

            // Sort descending by priority score so highest priority schedule evaluates first
            scoredSchedules.sort((a, b) => b.score - a.score);

            for (const item of scoredSchedules) {
                const { sch, rulesToEvaluate } = item;
                debugLog(eventSource, `Evaluating schedule "${sch.name}" (score=${item.score}, rulesCount=${rulesToEvaluate.length}) against body="${bodyForTrigger}"`);

                for (const rule of rulesToEvaluate) {
                    if (!rule.trigger || !rule.reply) continue;
                    const matched = isTriggerMatch(rule.trigger, bodyForTrigger);
                    debugLog(eventSource, ` -> Rule trigger="${rule.trigger}" vs body="${bodyForTrigger}" => matched=${matched}`);
                    if (matched) {
                        debugLog(eventSource, `SCHEDULE CHATBOT MATCHED "${bodyForTrigger}" (trigger: "${rule.trigger}") in schedule "${sch.name}". Replying: "${rule.reply}"`);
                        try {
                            await msg.reply(rule.reply);
                            debugLog(eventSource, `Schedule auto-reply sent successfully!`);
                            io.emit('automation_log', {
                                message: `🤖 [Schedule: ${sch.name || 'Schedule'}] Auto-replied to ${displayName} (Matched: "${bodyForTrigger}") -> "${rule.reply}"`,
                                type: 'success'
                            });
                        } catch (err) {
                            debugLog(eventSource, `FAILED to send schedule auto-reply: ${err.message}`);
                            io.emit('automation_log', {
                                message: `⚠️ Failed to send schedule auto-reply to ${displayName}: ${err.message}`,
                                type: 'error'
                            });
                        }
                        scheduleAutoReplied = true;
                        break;
                    }
                }
                if (scheduleAutoReplied) break;
            }
        }

        // 2. Global Chatbot fallback if no schedule rule matched
        if (!scheduleAutoReplied && chatbotConfig && Array.isArray(chatbotConfig.chatbots)) {
            const defaultBot = chatbotConfig.chatbots.find(b => b.isDefault && b.enabled !== false) ||
                               chatbotConfig.chatbots.find(b => b.enabled !== false);

            if (defaultBot && Array.isArray(defaultBot.rules) && defaultBot.rules.length > 0) {
                debugLog(eventSource, `Global chatbot "${defaultBot.name}" ENABLED. Checking ${defaultBot.rules.length} rules against: "${bodyForTrigger}"`);

                for (const rule of defaultBot.rules) {
                    if (!rule.trigger || !rule.reply) continue;

                    if (isTriggerMatch(rule.trigger, bodyForTrigger)) {
                        debugLog(eventSource, `GLOBAL TRIGGER MATCHED "${bodyForTrigger}" (trigger: "${rule.trigger}"). Replying: "${rule.reply}"`);

                        try {
                            await msg.reply(rule.reply);
                            debugLog(eventSource, `Auto-reply sent successfully!`);

                            io.emit('automation_log', { 
                                message: `🤖 [Chatbot: ${defaultBot.name}] Auto-replied to ${displayName} (Matched: "${bodyForTrigger}") -> "${rule.reply}"`, 
                                type: 'success' 
                            });
                        } catch (err) {
                            debugLog(eventSource, `FAILED to send auto-reply: ${err.message}`);
                            io.emit('automation_log', { 
                                message: `⚠️ Failed to send auto-reply to ${displayName}: ${err.message}`, 
                                type: 'error' 
                            });
                        }
                        break;
                    }
                }
            }
        }
    }

    // Listen to BOTH events for maximum reliability across environments
    client.on('message', (msg) => {
        debugLog('MSG', `Event 'message' fired. from=${msg.from}, body="${msg.body}", fromMe=${msg.fromMe}`);
        handleIncomingMessage(msg, 'MSG');
    });
    client.on('message_create', (msg) => {
        debugLog('MSG_CREATE', `Event 'message_create' fired. from=${msg.from}, body="${msg.body}", fromMe=${msg.fromMe}`);
        handleIncomingMessage(msg, 'MSG_CREATE');
    });

    // === POLL VOTE EVENT LISTENER ===
    client.on('vote_update', async (vote) => {
        try {
            // Safe debug log (vote object may contain complex nested objects)
            try {
                debugLog('POLL_VOTE', `Poll vote received! Keys: ${Object.keys(vote || {}).join(', ')}`);
                if (vote.voter) debugLog('POLL_VOTE', `voter type=${typeof vote.voter}, value=${typeof vote.voter === 'string' ? vote.voter : (vote.voter._serialized || vote.voter.user || JSON.stringify(vote.voter))}`);
                if (vote.selectedOptions) debugLog('POLL_VOTE', `selectedOptions=${JSON.stringify(vote.selectedOptions)}`);
            } catch (logErr) {
                debugLog('POLL_VOTE', `(debug log error: ${logErr.message})`);
            }

            // 1. Safely extract the selected option name
            let selectedOptionName = '';
            if (vote.selectedOptions && Array.isArray(vote.selectedOptions) && vote.selectedOptions.length > 0) {
                const firstOpt = vote.selectedOptions[0];
                selectedOptionName = typeof firstOpt === 'string' ? firstOpt : (firstOpt.name || firstOpt.label || String(firstOpt));
            } else if (vote.selectedOption) {
                selectedOptionName = typeof vote.selectedOption === 'string' ? vote.selectedOption : (vote.selectedOption.name || String(vote.selectedOption));
            }

            if (!selectedOptionName) {
                debugLog('POLL_VOTE', 'No selected option name could be extracted from vote, skipping.');
                return;
            }
            debugLog('POLL_VOTE', `Selected option name: "${selectedOptionName}"`);

            // 2. Resolve voter JID (vote.voter is a WID object with ._serialized, NOT a plain string)
            let voterJid = '';
            if (vote.voter) {
                if (typeof vote.voter === 'string') {
                    voterJid = vote.voter;
                } else if (vote.voter._serialized) {
                    voterJid = vote.voter._serialized;
                } else if (vote.voter.user) {
                    voterJid = vote.voter.user + '@c.us';
                }
            }
            const voterPhone = voterJid ? voterJid.split('@')[0] : 'Unknown';
            let voterName = voterPhone;

            if (voterJid) {
                try {
                    const contact = await client.getContactById(voterJid);
                    if (contact && contact.name) {
                        voterName = contact.name;
                    } else if (contact && contact.pushname) {
                        voterName = contact.pushname;
                    }
                } catch (err) {
                    debugLog('POLL_VOTE', `Failed to get voter contact info: ${err.message}`);
                }
            }
            debugLog('POLL_VOTE', `Voter resolved: ${voterName} (${voterPhone})`);

            // 3. Look up parent poll in sentPollMap
            const parentKeys = [];
            if (vote.parentMessage && vote.parentMessage.id) {
                if (vote.parentMessage.id._serialized) parentKeys.push(vote.parentMessage.id._serialized);
                if (vote.parentMessage.id.id) parentKeys.push(vote.parentMessage.id.id);
            }
            if (vote.parentMsgKey) {
                if (typeof vote.parentMsgKey === 'string') parentKeys.push(vote.parentMsgKey);
                else {
                    if (vote.parentMsgKey._serialized) parentKeys.push(vote.parentMsgKey._serialized);
                    if (vote.parentMsgKey.id) parentKeys.push(vote.parentMsgKey.id);
                }
            }

            debugLog('POLL_VOTE', `Parent keys to search: [${parentKeys.join(', ')}], sentPollMap size: ${sentPollMap.size}`);

            let pollInfo = null;
            for (const key of parentKeys) {
                if (sentPollMap.has(key)) {
                    pollInfo = sentPollMap.get(key);
                    debugLog('POLL_VOTE', `Found pollInfo via key: ${key}`);
                    break;
                }
                // Try swapping true_/false_ prefix
                const swapped = key.startsWith('true_') ? key.replace('true_', 'false_') : (key.startsWith('false_') ? key.replace('false_', 'true_') : null);
                if (swapped && sentPollMap.has(swapped)) {
                    pollInfo = sentPollMap.get(swapped);
                    debugLog('POLL_VOTE', `Found pollInfo via swapped key: ${swapped}`);
                    break;
                }
            }

            // Resolve triggerValue from pollInfo options
            let triggerValue = selectedOptionName;
            if (pollInfo && pollInfo.pollOptions && Array.isArray(pollInfo.pollOptions)) {
                const matchedOption = pollInfo.pollOptions.find(o => o.label === selectedOptionName);
                if (matchedOption && matchedOption.triggerValue) {
                    triggerValue = matchedOption.triggerValue;
                }
            }

            // 4. Format log message and ALWAYS LOG TO REPORT
            let logMsgText = `[Poll Vote] ${selectedOptionName}`;
            if (triggerValue && (triggerValue === '1' || triggerValue === '2' || triggerValue === '3')) {
                const cleanOpt = selectedOptionName.trim();
                if (!cleanOpt.startsWith(triggerValue)) {
                    logMsgText = `[Poll Vote] ${triggerValue} - ${selectedOptionName}`;
                }
            }

            // UNCONDITIONAL REPORT LOGGING
            logReply(voterPhone, voterName, logMsgText);
            debugLog('POLL_VOTE', `✅ Logged poll vote to report: ${voterName} (${voterPhone}): "${logMsgText}"`);

            // Emit live log to UI
            io.emit('automation_log', {
                message: `📊 Poll vote from ${voterName}: "${selectedOptionName}"${pollInfo ? ' (Schedule: ' + pollInfo.scheduleName + ')' : ''}`,
                type: 'info'
            });

            // 5. Evaluate chatbot rules (schedule-specific or global)
            let rulesToEvaluate = [];
            if (pollInfo) {
                if (pollInfo.chatbotMode === 'custom' && pollInfo.chatbotRules) {
                    rulesToEvaluate = pollInfo.chatbotRules;
                } else if (pollInfo.chatbotMode === 'existing' && pollInfo.chatbotId) {
                    const targetBot = (chatbotConfig.chatbots || []).find(b => b.id === pollInfo.chatbotId);
                    if (targetBot && targetBot.enabled !== false && Array.isArray(targetBot.rules)) {
                        rulesToEvaluate = targetBot.rules;
                    }
                }
            }

            // Global chatbot fallback if no schedule rules found
            if (rulesToEvaluate.length === 0 && chatbotConfig && Array.isArray(chatbotConfig.chatbots)) {
                const defaultBot = chatbotConfig.chatbots.find(b => b.isDefault && b.enabled !== false) ||
                                   chatbotConfig.chatbots.find(b => b.enabled !== false);
                if (defaultBot && Array.isArray(defaultBot.rules)) {
                    rulesToEvaluate = defaultBot.rules;
                }
            }

            if (rulesToEvaluate.length > 0) {
                debugLog('POLL_VOTE', `Checking ${rulesToEvaluate.length} chatbot rules against triggerValue="${triggerValue}" / option="${selectedOptionName}"`);

                for (const rule of rulesToEvaluate) {
                    if (!rule.trigger || !rule.reply) continue;
                    const matched = isTriggerMatch(rule.trigger, triggerValue) || isTriggerMatch(rule.trigger, selectedOptionName);
                    if (matched) {
                        debugLog('POLL_VOTE', `POLL CHATBOT MATCHED! Sending reply to ${voterJid}: "${rule.reply}"`);
                        try {
                            await client.sendMessage(voterJid, rule.reply);
                            debugLog('POLL_VOTE', `Poll auto-reply sent successfully!`);
                            io.emit('automation_log', {
                                message: `🤖 [Poll Chatbot${pollInfo ? ': ' + pollInfo.scheduleName : ''}] Auto-replied to ${voterName} (Voted: "${selectedOptionName}") -> "${rule.reply}"`,
                                type: 'success'
                            });
                        } catch (err) {
                            debugLog('POLL_VOTE', `FAILED to send poll auto-reply: ${err.message}`);
                            io.emit('automation_log', {
                                message: `⚠️ Failed to send poll auto-reply to ${voterName}: ${err.message}`,
                                type: 'error'
                            });
                        }
                        break;
                    }
                }
            } else {
                debugLog('POLL_VOTE', `No chatbot rules to evaluate for poll vote from ${voterName}.`);
            }

        } catch (err) {
            console.error('Error processing poll_vote:', err.message);
            debugLog('POLL_VOTE', `Error: ${err.message}`);
        }
    });

    await client.initialize().catch(err => {
        console.error('Failed to initialize client:', err.message);
        setClientStatus('ERROR', `Initialization error: ${err.message}`);
        io.emit('automation_log', { message: `❌ Initialization failed: ${err.message}`, type: 'error' });
    });
    } catch (err) {
        console.error('Unexpected error during initializeWhatsAppClient:', err.message);
        setClientStatus('ERROR', `Initialization error: ${err.message}`);
    } finally {
        isInitializingMutex = false;
    }
}

// Initial client startup
initializeWhatsAppClient();

// ============================================================
//  Express route: Download monthly Excel report
// ============================================================
app.get('/download-report', async (req, res) => {
    try {
        // Determine which month to export (default: current)
        const now = new Date();
        const requestedMonth = req.query.month; // format "YYYY-MM"
        const monthKey = requestedMonth || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

        const [yearStr, monStr] = monthKey.split('-');
        const year = parseInt(yearStr, 10);
        const month = parseInt(monStr, 10);
        const daysInMonth = new Date(year, month, 0).getDate();

        const monthData = repliesData[monthKey] || {};

        // Parse and consolidate contacts from all entries in the month
        // An entry looks like: { phone: string, name?: string, message: string, time: string }
        // We will build a contact Map keyed by phone number (if valid) or by the display name.
        const contactsMap = new Map(); // key -> { name, phone, days: { [day]: [ { time, message } ] } }

        for (const dayKey in monthData) {
            for (const entry of monthData[dayKey]) {
                let rawPhone = entry.phone || '';
                let rawName = entry.name || '';

                let cleanPhone = '';
                let cleanName = '';

                if (rawName) {
                    cleanName = rawName;
                    cleanPhone = rawPhone.replace(/[^0-9]/g, '');
                } else {
                    // Old format backward-compatibility: check if phone field contains characters
                    const hasLetters = /[a-zA-Zא-ת]/.test(rawPhone);
                    if (hasLetters || !rawPhone.replace(/[^0-9]/g, '')) {
                        cleanName = rawPhone;
                        cleanPhone = '';
                    } else {
                        cleanName = '';
                        cleanPhone = rawPhone.replace(/[^0-9]/g, '');
                    }
                }

                // Prefer phone, fallback to name
                const key = cleanPhone || cleanName || 'Unknown';

                if (!contactsMap.has(key)) {
                    contactsMap.set(key, {
                        name: cleanName,
                        phone: cleanPhone,
                        days: {}
                    });
                }

                const contactRecord = contactsMap.get(key);
                if (!contactRecord.days[dayKey]) {
                    contactRecord.days[dayKey] = [];
                }
                contactRecord.days[dayKey].push({
                    time: entry.time,
                    message: entry.message
                });
            }
        }

        // Sort contacts alphabetically by Name (or phone if name is missing)
        const sortedContacts = Array.from(contactsMap.values()).sort((a, b) => {
            const nameA = a.name || a.phone || '';
            const nameB = b.name || b.phone || '';
            return nameA.localeCompare(nameB, 'he', { sensitivity: 'base' });
        });

        // Build the Excel workbook
        const workbook = new ExcelJS.Workbook();
        workbook.creator = 'WhatsApp Automator';

        const monthNames = ['January','February','March','April','May','June',
                            'July','August','September','October','November','December'];
        const sheetName = `${monthNames[month - 1]} ${year}`;
        
        // ============================================================
        //  SHEET 1: Replies Calendar Grid
        // ============================================================
        const worksheet = workbook.addWorksheet('Replies Grid');
        worksheet.views = [{ showGridLines: true }];

        // Title Block
        worksheet.mergeCells(1, 1, 1, daysInMonth + 2);
        const titleCell = worksheet.getCell(1, 1);
        titleCell.value = `WhatsApp Automator - Monthly Replies Report`;
        titleCell.font = { name: 'Segoe UI', size: 16, bold: true, color: { argb: 'FF128C7E' } };
        titleCell.alignment = { vertical: 'middle', horizontal: 'left' };
        worksheet.getRow(1).height = 30;

        // Subtitle Block
        worksheet.mergeCells(2, 1, 2, daysInMonth + 2);
        const subtitleCell = worksheet.getCell(2, 1);
        const reportGenTime = now.toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' });
        subtitleCell.value = `Month: ${sheetName} | Generated on: ${reportGenTime}`;
        subtitleCell.font = { name: 'Segoe UI', size: 10, italic: true, color: { argb: 'FF6B7280' } };
        subtitleCell.alignment = { vertical: 'middle', horizontal: 'left' };
        worksheet.getRow(2).height = 20;

        // Blank spacer
        worksheet.addRow([]);

        // Header row
        const headerRow = ['Contact Name', 'Phone Number'];
        for (let d = 1; d <= daysInMonth; d++) {
            headerRow.push(`${d}/${month}`);
        }
        worksheet.addRow(headerRow);

        // Style the header row (Row 4)
        const hRow = worksheet.getRow(4);
        hRow.font = { name: 'Segoe UI', bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
        hRow.alignment = { horizontal: 'center', vertical: 'middle' };
        hRow.height = 28;
        hRow.eachCell((cell, colNumber) => {
            cell.fill = {
                type: 'pattern', pattern: 'solid',
                fgColor: { argb: 'FF128C7E' }  // WhatsApp teal
            };
            cell.border = {
                top: { style: 'thin', color: { argb: 'FF075E54' } },
                bottom: { style: 'medium', color: { argb: 'FF075E54' } },
                left: { style: 'thin', color: { argb: 'FF075E54' } },
                right: { style: 'thin', color: { argb: 'FF075E54' } }
            };
        });
        hRow.getCell(1).alignment = { horizontal: 'left', vertical: 'middle' };
        hRow.getCell(2).alignment = { horizontal: 'left', vertical: 'middle' };

        // Set column widths
        worksheet.getColumn(1).width = 24; // Contact Name
        worksheet.getColumn(2).width = 20; // Phone Number
        for (let d = 1; d <= daysInMonth; d++) {
            worksheet.getColumn(d + 2).width = 16; // Day columns
        }

        const borderStyle = {
            top: { style: 'thin', color: { argb: 'FFE5E7EB' } },
            bottom: { style: 'thin', color: { argb: 'FFE5E7EB' } },
            left: { style: 'thin', color: { argb: 'FFE5E7EB' } },
            right: { style: 'thin', color: { argb: 'FFE5E7EB' } }
        };

        // Data rows: one per contact
        sortedContacts.forEach((contact, idx) => {
            const rowData = [
                contact.name || 'Unnamed Contact',
                contact.phone ? '+' + contact.phone : ''
            ];
            for (let d = 1; d <= daysInMonth; d++) {
                const dayKey = String(d).padStart(2, '0');
                const dayEntries = contact.days[dayKey] || [];

                if (dayEntries.length > 0) {
                    const text = dayEntries.map(e => `[${e.time}] ${e.message}`).join('\n');
                    rowData.push(text);
                } else {
                    rowData.push('');
                }
            }

            const row = worksheet.addRow(rowData);
            row.alignment = { vertical: 'top', wrapText: true };

            // Alternate row background colors (zebra striping) for first 2 cells
            const zebraColor = idx % 2 === 0 ? 'FFF9FAFB' : 'FFFFFFFF';
            row.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: zebraColor } };
            row.getCell(2).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: zebraColor } };

            // Bold the Name and Phone cells
            row.getCell(1).font = { name: 'Segoe UI', bold: true, color: { argb: 'FF374151' }, size: 10 };
            row.getCell(2).font = { name: 'Segoe UI', color: { argb: 'FF6B7280' }, size: 10 };

            row.getCell(1).border = borderStyle;
            row.getCell(2).border = borderStyle;

            // Style day cells
            for (let d = 1; d <= daysInMonth; d++) {
                const colIndex = d + 2;
                const cell = row.getCell(colIndex);
                cell.border = borderStyle;
                cell.font = { name: 'Segoe UI', size: 9 };
                if (cell.value) {
                    cell.fill = {
                        type: 'pattern', pattern: 'solid',
                        fgColor: { argb: 'FFDCFCE7' }  // Light green
                    };
                    cell.font = { name: 'Segoe UI', size: 9, color: { argb: 'FF14532D' } }; // Dark green text
                }
            }
        });

        // Summary row
        worksheet.addRow([]); // spacer
        const summaryData = ['Total Replies', ''];
        for (let d = 1; d <= daysInMonth; d++) {
            const dayKey = String(d).padStart(2, '0');
            const count = (monthData[dayKey] || []).length;
            summaryData.push(count > 0 ? count : '');
        }
        const summaryRow = worksheet.addRow(summaryData);
        summaryRow.height = 22;
        summaryRow.font = { name: 'Segoe UI', bold: true, color: { argb: 'FF128C7E' }, size: 10 };
        summaryRow.eachCell((cell) => {
            cell.alignment = { horizontal: 'center', vertical: 'middle' };
            cell.fill = {
                type: 'pattern', pattern: 'solid',
                fgColor: { argb: 'FFE8F5E9' }
            };
            cell.border = {
                top: { style: 'medium', color: { argb: 'FF128C7E' } },
                bottom: { style: 'medium', color: { argb: 'FF128C7E' } },
                left: { style: 'thin', color: { argb: 'FFE5E7EB' } },
                right: { style: 'thin', color: { argb: 'FFE5E7EB' } }
            };
        });
        summaryRow.getCell(1).alignment = { horizontal: 'left', vertical: 'middle' };
        summaryRow.getCell(2).alignment = { horizontal: 'left', vertical: 'middle' };

        // ============================================================
        //  SHEET 2: Detailed Messages Log
        // ============================================================
        const worksheet2 = workbook.addWorksheet('Detailed Log');
        worksheet2.views = [{ showGridLines: true }];

        // Title Block for Sheet 2
        worksheet2.mergeCells(1, 1, 1, 4);
        const titleCell2 = worksheet2.getCell(1, 1);
        titleCell2.value = `WhatsApp Automator - Detailed Log`;
        titleCell2.font = { name: 'Segoe UI', size: 16, bold: true, color: { argb: 'FF128C7E' } };
        titleCell2.alignment = { vertical: 'middle', horizontal: 'left' };
        worksheet2.getRow(1).height = 30;

        worksheet2.mergeCells(2, 1, 2, 4);
        const subtitleCell2 = worksheet2.getCell(2, 1);
        const totalMessagesCount = Object.values(monthData).flat().length;
        subtitleCell2.value = `Month: ${sheetName} | Total Messages: ${totalMessagesCount}`;
        subtitleCell2.font = { name: 'Segoe UI', size: 10, italic: true, color: { argb: 'FF6B7280' } };
        subtitleCell2.alignment = { vertical: 'middle', horizontal: 'left' };
        worksheet2.getRow(2).height = 20;

        worksheet2.addRow([]); // Blank spacer

        // Header Row for Sheet 2 (Row 4)
        const headerRow2 = ['Date & Time', 'Contact Name', 'Phone Number', 'Message'];
        worksheet2.addRow(headerRow2);

        const hRow2 = worksheet2.getRow(4);
        hRow2.font = { name: 'Segoe UI', bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
        hRow2.alignment = { horizontal: 'left', vertical: 'middle' };
        hRow2.height = 28;
        hRow2.eachCell((cell) => {
            cell.fill = {
                type: 'pattern', pattern: 'solid',
                fgColor: { argb: 'FF128C7E' }
            };
            cell.border = {
                top: { style: 'thin', color: { argb: 'FF075E54' } },
                bottom: { style: 'medium', color: { argb: 'FF075E54' } },
                left: { style: 'thin', color: { argb: 'FF075E54' } },
                right: { style: 'thin', color: { argb: 'FF075E54' } }
            };
        });
        hRow2.getCell(1).alignment = { horizontal: 'center', vertical: 'middle' };
        hRow2.getCell(3).alignment = { horizontal: 'center', vertical: 'middle' };

        worksheet2.getColumn(1).width = 20; // Date & Time
        worksheet2.getColumn(2).width = 24; // Contact Name
        worksheet2.getColumn(3).width = 20; // Phone Number
        worksheet2.getColumn(4).width = 65; // Message

        // Collect all replies in this month chronologically
        const allReplies = [];
        for (const dayKey in monthData) {
            for (const entry of monthData[dayKey]) {
                allReplies.push({
                    day: dayKey,
                    time: entry.time,
                    phone: entry.phone,
                    name: entry.name,
                    message: entry.message
                });
            }
        }

        // Sort chronologically: by dayKey ascending, then by time ascending
        allReplies.sort((a, b) => {
            if (a.day !== b.day) {
                return a.day.localeCompare(b.day);
            }
            return a.time.localeCompare(b.time);
        });

        // Add data rows to Sheet 2
        allReplies.forEach((reply, idx) => {
            let rawPhone = reply.phone || '';
            let rawName = reply.name || '';
            let cleanPhone = '';
            let cleanName = '';

            if (rawName) {
                cleanName = rawName;
                cleanPhone = rawPhone.replace(/[^0-9]/g, '');
            } else {
                const hasLetters = /[a-zA-Zא-ת]/.test(rawPhone);
                if (hasLetters || !rawPhone.replace(/[^0-9]/g, '')) {
                    cleanName = rawPhone;
                    cleanPhone = '';
                } else {
                    cleanName = '';
                    cleanPhone = rawPhone.replace(/[^0-9]/g, '');
                }
            }

            const formattedDateTime = `${reply.day}/${monStr}/${year} ${reply.time}`;
            const rowData = [
                formattedDateTime,
                cleanName || 'Unnamed Contact',
                cleanPhone ? '+' + cleanPhone : '',
                reply.message
            ];

            const row = worksheet2.addRow(rowData);
            row.alignment = { vertical: 'top', wrapText: true };
            row.getCell(1).alignment = { horizontal: 'center', vertical: 'top' };
            row.getCell(3).alignment = { horizontal: 'center', vertical: 'top' };

            // Zebra color for the rows
            const zebraColor = idx % 2 === 0 ? 'FFF9FAFB' : 'FFFFFFFF';
            row.eachCell((cell) => {
                cell.fill = {
                    type: 'pattern', pattern: 'solid',
                    fgColor: { argb: zebraColor }
                };
                cell.border = borderStyle;
                cell.font = { name: 'Segoe UI', size: 10 };
            });
        });

        // Set response headers for download
        const filename = `WhatsApp_Replies_${sheetName.replace(' ', '_')}.xlsx`;
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

        await workbook.xlsx.write(res);
        res.end();

        console.log(`Excel report downloaded: ${filename}`);
    } catch (err) {
        console.error('Error generating Excel report:', err.message);
        res.status(500).json({ error: 'Failed to generate report: ' + err.message });
    }
});

// ============================================================
//  Express route: Download daily Excel report
// ============================================================
app.get('/download-daily-report', async (req, res) => {
    try {
        const requestedDate = req.query.date; // format "YYYY-MM-DD"
        if (!requestedDate) {
            return res.status(400).json({ error: 'Date query parameter is required (format: YYYY-MM-DD).' });
        }

        const [yearStr, monStr, dayStr] = requestedDate.split('-');
        if (!yearStr || !monStr || !dayStr) {
            return res.status(400).json({ error: 'Invalid date format. Expected YYYY-MM-DD.' });
        }

        const monthKey = `${yearStr}-${monStr}`;
        const dayKey = dayStr;

        const monthData = repliesData[monthKey] || {};
        const dayEntries = monthData[dayKey] || [];

        // Sort chronologically by time ascending
        dayEntries.sort((a, b) => a.time.localeCompare(b.time));

        // Group entries by choice (1, 2, 3, Other)
        const groups = {
            '1': [],
            '2': [],
            '3': [],
            'Other': []
        };

        dayEntries.forEach(entry => {
            const parsed = parseWorkerChoice(entry.message);
            entry.detectedChoice = parsed.choice;
            entry.detectedLabel = parsed.label;
            if (groups[parsed.choice]) {
                groups[parsed.choice].push(entry);
            } else {
                groups['Other'].push(entry);
            }
        });

        // Build Excel Workbook
        const workbook = new ExcelJS.Workbook();
        workbook.creator = 'WhatsApp Automator';

        const displayDate = `${dayStr}/${monStr}/${yearStr}`;

        // ============================================================
        // SHEET 1: Response Breakdown & Worker Lists
        // ============================================================
        const summarySheet = workbook.addWorksheet(`Response Breakdown`);
        summarySheet.views = [{ showGridLines: true }];

        const borderStyle = {
            top: { style: 'thin', color: { argb: 'FFE5E7EB' } },
            bottom: { style: 'thin', color: { argb: 'FFE5E7EB' } },
            left: { style: 'thin', color: { argb: 'FFE5E7EB' } },
            right: { style: 'thin', color: { argb: 'FFE5E7EB' } }
        };

        // Title Block
        summarySheet.mergeCells(1, 1, 1, 4);
        const titleCell = summarySheet.getCell(1, 1);
        titleCell.value = `WhatsApp Automator - Daily Response Summary & Worker Choices`;
        titleCell.font = { name: 'Segoe UI', size: 16, bold: true, color: { argb: 'FF128C7E' } };
        titleCell.alignment = { vertical: 'middle', horizontal: 'left' };
        summarySheet.getRow(1).height = 30;

        // Subtitle Block
        summarySheet.mergeCells(2, 1, 2, 4);
        const subtitleCell = summarySheet.getCell(2, 1);
        subtitleCell.value = `Date: ${displayDate} | Total Workers Replied: ${dayEntries.length}`;
        subtitleCell.font = { name: 'Segoe UI', size: 10, italic: true, color: { argb: 'FF6B7280' } };
        subtitleCell.alignment = { vertical: 'middle', horizontal: 'left' };
        summarySheet.getRow(2).height = 20;

        summarySheet.addRow([]); // Spacer

        // --- Table 1: Response Summary Count Table ---
        const summaryHeader = ['Response Choice', 'Option Trigger', 'Worker Count', 'Percentage'];
        summarySheet.addRow(summaryHeader);
        const sumHRow = summarySheet.getRow(4);
        sumHRow.font = { name: 'Segoe UI', bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
        sumHRow.height = 26;
        sumHRow.eachCell((cell) => {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF128C7E' } };
            cell.border = {
                top: { style: 'thin', color: { argb: 'FF075E54' } },
                bottom: { style: 'medium', color: { argb: 'FF075E54' } },
                left: { style: 'thin', color: { argb: 'FF075E54' } },
                right: { style: 'thin', color: { argb: 'FF075E54' } }
            };
        });

        const totalReplies = dayEntries.length || 1; // avoid division by 0

        const summaryRowsData = [
            ['Option 1', '1', groups['1'].length, `${Math.round((groups['1'].length / totalReplies) * 100)}%`],
            ['Option 2', '2', groups['2'].length, `${Math.round((groups['2'].length / totalReplies) * 100)}%`],
            ['Option 3', '3', groups['3'].length, `${Math.round((groups['3'].length / totalReplies) * 100)}%`],
            ['Other Replies', 'Text / Unrecognized', groups['Other'].length, `${Math.round((groups['Other'].length / totalReplies) * 100)}%`],
            ['TOTAL WORKERS REPLIED', 'All Options', dayEntries.length, '100%']
        ];

        summaryRowsData.forEach((rData, idx) => {
            const row = summarySheet.addRow(rData);
            const isTotal = idx === summaryRowsData.length - 1;
            row.height = 22;
            row.eachCell((cell, colNum) => {
                cell.font = { name: 'Segoe UI', size: 10, bold: isTotal };
                cell.border = borderStyle;
                if (isTotal) {
                    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE5E7EB' } };
                } else {
                    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: idx % 2 === 0 ? 'FFF9FAFB' : 'FFFFFFFF' } };
                }
                if (colNum === 3 || colNum === 4) cell.alignment = { horizontal: 'center' };
            });
        });

        summarySheet.addRow([]); // Spacer
        summarySheet.addRow([]); // Spacer

        // --- Categorized Lists: Who Replied What ---
        const sectionsConfig = [
            { key: '1', title: 'Workers Who Replied "1"', color: 'FF059669' }, // Emerald Green
            { key: '2', title: 'Workers Who Replied "2"', color: 'FFD97706' }, // Amber Orange
            { key: '3', title: 'Workers Who Replied "3"', color: 'FF2563EB' }, // Royal Blue
            { key: 'Other', title: 'Other / Uncategorized Replies', color: 'FF4B5563' } // Dark Gray
        ];

        sectionsConfig.forEach(sec => {
            const list = groups[sec.key] || [];
            
            // Section Header Banner
            const bannerRow = summarySheet.addRow([`${sec.title} (${list.length} workers)`]);
            const bannerCell = bannerRow.getCell(1);
            summarySheet.mergeCells(bannerRow.number, 1, bannerRow.number, 4);
            bannerCell.font = { name: 'Segoe UI', size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
            bannerCell.alignment = { vertical: 'middle', horizontal: 'left' };
            bannerRow.height = 24;
            bannerCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: sec.color } };

            // Section Column Headers
            const secHeaders = ['Time', 'Worker / Contact Name', 'Phone Number', 'Message Received'];
            const secHRow = summarySheet.addRow(secHeaders);
            secHRow.font = { name: 'Segoe UI', size: 10, bold: true, color: { argb: 'FF374151' } };
            secHRow.height = 20;
            secHRow.eachCell((cell) => {
                cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE5E7EB' } };
                cell.border = borderStyle;
            });
            secHRow.getCell(1).alignment = { horizontal: 'center' };

            if (list.length === 0) {
                const emptyRow = summarySheet.addRow(['-', 'No workers replied with this option today', '-', '-']);
                emptyRow.height = 20;
                emptyRow.eachCell(c => {
                    c.font = { name: 'Segoe UI', size: 10, italic: true, color: { argb: 'FF9CA3AF' } };
                    c.border = borderStyle;
                });
            } else {
                list.forEach((item, lIdx) => {
                    let rawName = item.name || '';
                    let rawPhone = item.phone || '';
                    let cleanName = rawName || rawPhone || 'Unnamed Contact';
                    let phoneStr = rawPhone.replace(/[^0-9]/g, '');

                    const itemRow = summarySheet.addRow([
                        item.time,
                        cleanName,
                        phoneStr ? `+${phoneStr}` : 'N/A',
                        item.message
                    ]);
                    itemRow.height = 20;
                    itemRow.eachCell((cell, colNum) => {
                        cell.font = { name: 'Segoe UI', size: 10 };
                        cell.border = borderStyle;
                        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: lIdx % 2 === 0 ? 'FFF9FAFB' : 'FFFFFFFF' } };
                        if (colNum === 1 || colNum === 3) cell.alignment = { horizontal: 'center' };
                    });
                });
            }

            summarySheet.addRow([]); // Spacer
        });

        // Column Widths for Sheet 1
        summarySheet.getColumn(1).width = 16;
        summarySheet.getColumn(2).width = 32;
        summarySheet.getColumn(3).width = 24;
        summarySheet.getColumn(4).width = 55;

        // ============================================================
        // SHEET 2: Full Chronological Daily Log
        // ============================================================
        const logSheet = workbook.addWorksheet(`Chronological Log`);
        logSheet.views = [{ showGridLines: true }];

        logSheet.mergeCells(1, 1, 1, 4);
        const logTitle = logSheet.getCell(1, 1);
        logTitle.value = `WhatsApp Automator - Full Daily Log (${displayDate})`;
        logTitle.font = { name: 'Segoe UI', size: 16, bold: true, color: { argb: 'FF128C7E' } };
        logSheet.getRow(1).height = 30;

        logSheet.addRow([]); // Spacer

        const logHeaderRow = ['Time', 'Worker / Contact Name', 'Choice', 'Message Received'];
        logSheet.addRow(logHeaderRow);
        const lHRow = logSheet.getRow(3);
        lHRow.font = { name: 'Segoe UI', bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
        lHRow.height = 26;
        lHRow.eachCell((cell) => {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF128C7E' } };
            cell.border = borderStyle;
        });

        logSheet.getColumn(1).width = 12;
        logSheet.getColumn(2).width = 30;
        logSheet.getColumn(3).width = 22;
        logSheet.getColumn(4).width = 60;

        if (dayEntries.length === 0) {
            logSheet.mergeCells(4, 1, 4, 4);
            const emptyC = logSheet.getCell(4, 1);
            emptyC.value = 'No replies recorded for this day.';
            emptyC.font = { name: 'Segoe UI', italic: true, color: { argb: 'FF9CA3AF' } };
        } else {
            dayEntries.forEach((entry, idx) => {
                const row = logSheet.addRow([
                    entry.time,
                    entry.name || entry.phone || 'Unnamed Contact',
                    entry.detectedLabel || 'Other',
                    entry.message
                ]);
                row.height = 20;
                row.eachCell((cell, colNum) => {
                    cell.font = { name: 'Segoe UI', size: 10 };
                    cell.border = borderStyle;
                    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: idx % 2 === 0 ? 'FFF9FAFB' : 'FFFFFFFF' } };
                    if (colNum === 1 || colNum === 3) cell.alignment = { horizontal: 'center' };
                });
            });
        }

        // Set response headers for download
        const filename = `WhatsApp_Daily_Replies_${requestedDate.replace(/-/g, '_')}.xlsx`;
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

        await workbook.xlsx.write(res);
        res.end();

        console.log(`Excel daily report downloaded with response breakdown: ${filename}`);
    } catch (err) {
        console.error('Error generating Excel daily report:', err.message);
        res.status(500).json({ error: 'Failed to generate report: ' + err.message });
    }
});

// API route: get system diagnostics status
app.get('/api/status', (req, res) => {
    const memory = process.memoryUsage();
    const elapsedSeconds = clientInitStartTime ? Math.round((Date.now() - clientInitStartTime) / 1000) : 0;
    res.json({
        ready: whatsappClientReady,
        hasQr: lastQrCodeData !== null,
        clientState: clientState,
        clientStateMessage: clientStateMessage,
        elapsedSeconds: elapsedSeconds,
        uptime: Math.round(process.uptime()),
        memory: {
            heapUsed: Math.round(memory.heapUsed / 1024 / 1024) + ' MB',
            rss: Math.round(memory.rss / 1024 / 1024) + ' MB'
        },
        targetedCount: targetedContacts.size,
        targetedContacts: Array.from(targetedContacts)
    });
});

// API route: view debug log from the browser (no Render console needed!)
app.get('/api/debug-log', (req, res) => {
    res.json({
        version: '2.5.0',
        totalEntries: debugLogEntries.length,
        entries: debugLogEntries,
        targetedContacts: Array.from(targetedContacts),
        lidMap: lidToPhone,
        chatbotEnabled: chatbotConfig.chatbots ? true : false,
        chatbotRulesCount: chatbotConfig.chatbots ? chatbotConfig.chatbots.reduce((acc, bot) => acc + (bot.rules ? bot.rules.length : 0), 0) : 0,
        chatbotRules: chatbotConfig.chatbots,
        repliesDataKeys: Object.keys(repliesData),
        repliesData: repliesData,
        whatsappReady: whatsappClientReady,
        clientState: clientState
    });
});

// API route: manually restart/refresh the WhatsApp client
app.post('/api/restart-client', async (req, res) => {
    console.log('Manual request received via REST API to restart WhatsApp client...');
    const cleanSession = req.body && req.body.cleanSession === true;
    try {
        // Run restart asynchronously
        initializeWhatsAppClient(cleanSession).catch(err => {
            console.error('Async initialization error:', err.message);
        });
        res.json({
            success: true,
            message: cleanSession
                ? 'WhatsApp client session cleared. Fresh QR code generation initiated.'
                : 'WhatsApp client restart initiated.'
        });
    } catch (err) {
        console.error('Failed to trigger manual restart:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// API route: clear all reports (replies.json and targeted_contacts.json)
app.post('/api/clear-reports', (req, res) => {
    console.log('Manual request received to clear all reports history...');
    try {
        repliesData = {};
        targetedContacts = new Set();
        
        // Write empty files to disk
        fs.writeFileSync(REPLIES_FILE, JSON.stringify(repliesData, null, 2));
        fs.writeFileSync(TARGETED_CONTACTS_FILE, JSON.stringify([], null, 2));
        
        console.log('Reports and targeted contacts cleared successfully.');
        res.json({ success: true, message: 'All reports history cleared.' });
    } catch (err) {
        console.error('Failed to clear reports history:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// API route: debug targeted contacts (see which numbers are currently tracked)
app.get('/api/debug-contacts', (req, res) => {
    res.json({
        count: targetedContacts.size,
        contacts: Array.from(targetedContacts)
    });
});

// API route: get available months for the dropdown
app.get('/api/reply-months', (req, res) => {
    const months = Object.keys(repliesData).sort().reverse();
    res.json({ months });
});

// API route: get reply stats for dashboard
app.get('/api/reply-stats', (req, res) => {
    // Use Israel timezone for stats
    const now = new Date();
    let monthKey, todayKey;
    try {
        const formatter = new Intl.DateTimeFormat('en-GB', {
            timeZone: 'Asia/Jerusalem',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit'
        });
        const parts = formatter.formatToParts(now);
        const dateObj = {};
        parts.forEach(p => { dateObj[p.type] = p.value; });
        monthKey = `${dateObj.year}-${dateObj.month}`;
        todayKey = dateObj.day;
    } catch (e) {
        monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
        todayKey = String(now.getDate()).padStart(2, '0');
    }

    const monthData = repliesData[monthKey] || {};

    let totalReplies = 0;
    const uniquePhones = new Set();
    let todayReplies = 0;

    for (const dayKey in monthData) {
        for (const entry of monthData[dayKey]) {
            totalReplies++;
            uniquePhones.add(entry.phone);
        }
    }

    if (monthData[todayKey]) {
        todayReplies = monthData[todayKey].length;
    }

    res.json({
        month: monthKey,
        totalReplies,
        uniqueContacts: uniquePhones.size,
        todayReplies
    });
});

// API route: get report settings
app.get('/api/report-settings', (req, res) => {
    res.json(reportSettings);
});

// API route: save report settings
app.post('/api/report-settings', (req, res) => {
    try {
        const { limitGathering, startTime, endTime } = req.body;
        reportSettings = {
            limitGathering: !!limitGathering,
            startTime: startTime || '07:00',
            endTime: endTime || '12:00',
            reportSources: []
        };
        fs.writeFileSync(REPORT_SETTINGS_FILE, JSON.stringify(reportSettings, null, 2));
        console.log('Report settings saved:', reportSettings);
        res.json({ success: true, settings: reportSettings });
    } catch (err) {
        console.error('Failed to save report settings:', err.message);
        res.status(500).json({ error: 'Failed to save settings: ' + err.message });
    }
});

// API route: fetch all WhatsApp groups for the picker (optimized)
app.get('/api/groups', async (req, res) => {
    if (!whatsappClientReady) {
        return res.status(503).json({ error: 'WhatsApp client is not connected. Please scan the QR code first.' });
    }
    try {
        // Evaluate custom browser script to fetch minimal group metadata directly from Store
        // This is 100x faster than client.getChats() because it avoids full serialization
        const groups = await client.pupPage.evaluate(() => {
            try {
                const collections = window.require('WAWebCollections');
                if (!collections || !collections.Chat) return [];
                const chats = collections.Chat.getModelsArray();
                return chats
                    .filter(chat => chat.isGroup || (chat.id && chat.id._serialized && chat.id._serialized.endsWith('@g.us')))
                    .map(chat => ({
                        id: chat.id._serialized,
                        name: chat.name || chat.formattedTitle || 'Unnamed Group',
                        timestamp: chat.t || 0 // Last activity timestamp
                    }));
            } catch (err) {
                return [];
            }
        });

        // Sort by last active timestamp descending (most recent first)
        groups.sort((a, b) => b.timestamp - a.timestamp);

        res.json({ groups });
    } catch (err) {
        console.error('Error fetching groups:', err.message);
        res.status(500).json({ error: 'Failed to fetch groups: ' + err.message });
    }
});

// API route: fetch all WhatsApp contacts for the picker (optimized)
app.get('/api/contacts', async (req, res) => {
    if (!whatsappClientReady) {
        return res.status(503).json({ error: 'WhatsApp client is not connected. Please scan the QR code first.' });
    }
    try {
        const contacts = await client.pupPage.evaluate(() => {
            try {
                const collections = window.require('WAWebCollections');
                if (!collections || !collections.Contact) return [];
                
                const ContactMethods = window.require('WAWebContactGetters');
                let getIsMyContact = null;
                try {
                    getIsMyContact = window.require('WAWebFrontendContactGetters').getIsMyContact;
                } catch (e) {}

                const contactsArray = collections.Contact.getModelsArray();
                return contactsArray
                    .filter(c => {
                        // Filter: only user chats, not groups, not broadcast lists, and not "me"
                        const isUser = ContactMethods ? ContactMethods.getIsUser(c) : (c.isUser || (c.id && c.id._serialized && c.id._serialized.endsWith('@c.us')));
                        const isMe = ContactMethods ? ContactMethods.getIsMe(c) : c.isMe;
                        return isUser && !isMe;
                    })
                    .map(c => {
                        let name = '';
                        if (ContactMethods) {
                            name = ContactMethods.getName(c) || ContactMethods.getPushname(c) || c.formattedName || c.name || '';
                        } else {
                            name = c.name || c.pushname || c.formattedName || '';
                        }
                        
                        let isMyContact = false;
                        if (getIsMyContact) {
                            isMyContact = getIsMyContact(c);
                        } else if (c.isMyContact !== undefined) {
                            isMyContact = c.isMyContact;
                        }

                        // Try to resolve phone JID if it is an LID contact
                        let id = c.id._serialized;
                        if (c.phoneNumber && c.phoneNumber._serialized) {
                            id = c.phoneNumber._serialized;
                        } else if (c.phoneNumber && typeof c.phoneNumber === 'string') {
                            id = c.phoneNumber;
                        }

                        return {
                            id: id,
                            name: name || 'Unnamed Contact',
                            isMyContact: !!isMyContact
                        };
                    });
            } catch (err) {
                return [];
            }
        });

        // Deduplicate and filter contacts in Node.js
        const uniqueContactsMap = new Map();
        for (const contact of contacts) {
            // Only keep standard phone number formats (@c.us)
            if (!contact.id || !contact.id.endsWith('@c.us')) continue;

            const nameTrim = contact.name.trim();
            const nameLower = nameTrim.toLowerCase();

            // Filter out unnamed contacts
            if (!nameTrim || nameLower === 'unnamed contact') continue;

            // Filter out ME app spam contacts (e.g. Me - Name, Me: Name, Me Name)
            if (nameLower.startsWith('me -') || nameLower.startsWith('me-') || nameLower.startsWith('me :') || nameLower.startsWith('me:') || nameLower.startsWith('me ')) {
                continue;
            }

            // Filter out contacts with "spam" in their name
            if (nameLower.includes('spam')) continue;

            // Deduplicate: if duplicate, prefer the saved (isMyContact) one
            if (uniqueContactsMap.has(contact.id)) {
                const existing = uniqueContactsMap.get(contact.id);
                if (contact.isMyContact && !existing.isMyContact) {
                    uniqueContactsMap.set(contact.id, contact);
                }
            } else {
                uniqueContactsMap.set(contact.id, contact);
            }
        }

        const filteredContacts = Array.from(uniqueContactsMap.values());

        // Sort contacts: saved contacts first, then alphabetically by name
        filteredContacts.sort((a, b) => {
            if (a.isMyContact && !b.isMyContact) return -1;
            if (!a.isMyContact && b.isMyContact) return 1;
            return a.name.localeCompare(b.name);
        });

        res.json({ contacts: filteredContacts });
    } catch (err) {
        console.error('Error fetching contacts:', err.message);
        res.status(500).json({ error: 'Failed to fetch contacts: ' + err.message });
    }
});

const automationQueue = [];
let isAutomationRunning = false;

// Function to run the automation loop
async function runAutomation(contacts, messageBody = null, minDelay = 6, maxDelay = 12, isScheduled = false, scheduleName = '', pollConfig = null) {
    if (!whatsappClientReady) {
        const errMsg = 'Automation failed to trigger: WhatsApp client is offline.';
        console.error(errMsg);
        io.emit('automation_log', { message: errMsg, type: 'error' });
        return;
    }

    if (isAutomationRunning) {
        const queueMsg = `⏰ Schedule ${scheduleName ? '"' + scheduleName + '" ' : ''}queued. Will start automatically after current process finishes.`;
        console.log(queueMsg);
        io.emit('automation_log', { message: queueMsg, type: 'info' });
        automationQueue.push({ contacts, messageBody, minDelay, maxDelay, isScheduled, scheduleName, pollConfig });
        return;
    }

    isAutomationRunning = true;
    try {
        const isPoll = pollConfig && pollConfig.question && pollConfig.options && pollConfig.options.length >= 2;
        console.log(`Starting ${isScheduled ? 'scheduled' : 'manual'} automation for ${contacts.length} contacts (${scheduleName || 'Manual'})${isPoll ? ' [POLL MODE]' : ''}...`);
        io.emit('automation_start', contacts.length);
        
        activeAutomation = {
            total: contacts.length,
            current: 0,
            sent: 0,
            failed: 0
        };
        shouldStopAutomation = false;

        const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

        // If poll mode, create the Poll object
        let pollObject = null;
        if (isPoll) {
            const optionLabels = pollConfig.options.map(o => o.label || o);
            pollObject = new Poll(pollConfig.question, optionLabels, { allowMultipleAnswers: false });
            debugLog('AUTOMATION', `Created Poll: "${pollConfig.question}" with options: [${optionLabels.join(', ')}]`);
        }

        for (let i = 0; i < contacts.length; i++) {
            if (shouldStopAutomation) {
                io.emit('automation_log', { message: 'Automation stopped.', type: 'warning' });
                automationQueue.length = 0;
                break;
            }

            const contact = contacts[i];
            const rawPhone = contact.phone.toString().trim();
            const name = contact.name || 'Recipient';
            const message = contact.message || messageBody || 'Hello!';

            let whatsappId;
            let logPhone = rawPhone;
            
            if (rawPhone.endsWith('@g.us')) {
                whatsappId = rawPhone;
                logPhone = `Group: ${name}`;
            } else if (rawPhone.endsWith('@c.us') || rawPhone.endsWith('@lid')) {
                whatsappId = rawPhone;
                logPhone = rawPhone.split('@')[0];
            } else {
                const cleanPhone = rawPhone.replace(/[^0-9]/g, '');
                whatsappId = `${cleanPhone}@c.us`;
                logPhone = cleanPhone;
            }

            io.emit('automation_log', { message: `[${i + 1}/${contacts.length}] ${isPoll ? '📊 Sending poll' : 'Sending'} to ${name} (${logPhone})...`, type: 'info' });
            activeAutomation.current++;

            try {
                let canSend = true;
                if (!whatsappId.endsWith('@g.us') && !whatsappId.endsWith('@lid')) {
                    const isRegistered = await client.isRegisteredUser(whatsappId);
                    if (!isRegistered) {
                        canSend = false;
                        activeAutomation.failed++;
                        io.emit('automation_log', { message: `Skipped: ${logPhone} is not on WhatsApp.`, type: 'warning' });
                    }
                }

                if (canSend) {
                    let sentMsg;
                    if (isPoll && pollObject) {
                        // Send poll
                        sentMsg = await client.sendMessage(whatsappId, pollObject);
                        activeAutomation.sent++;
                        io.emit('automation_log', { message: `Success: Poll sent to ${name}.`, type: 'success' });

                        // Track this poll message for vote detection
                        if (sentMsg && sentMsg.id) {
                            const pollRecord = {
                                scheduleId: pollConfig.scheduleId || null,
                                scheduleName: scheduleName,
                                chatbotMode: pollConfig.chatbotMode || null,
                                chatbotId: pollConfig.chatbotId || null,
                                chatbotRules: pollConfig.chatbotRules || null,
                                pollOptions: pollConfig.options || [],
                                sentAt: Date.now()
                            };
                            if (sentMsg.id._serialized) {
                                sentPollMap.set(sentMsg.id._serialized, pollRecord);
                                if (sentMsg.id._serialized.startsWith('true_')) {
                                    sentPollMap.set(sentMsg.id._serialized.replace('true_', 'false_'), pollRecord);
                                }
                            }
                            if (sentMsg.id.id) {
                                sentPollMap.set(sentMsg.id.id, pollRecord);
                            }
                            debugLog('AUTOMATION', `Tracked poll message ${sentMsg.id._serialized || sentMsg.id.id} for schedule "${scheduleName}"`);
                        }
                    } else {
                        // Send regular text message
                        sentMsg = await client.sendMessage(whatsappId, message);
                        activeAutomation.sent++;
                        io.emit('automation_log', { message: `Success: Message sent to ${name}.`, type: 'success' });
                    }

                    recordTargetedContact(whatsappId);
                    
                    if (sentMsg && sentMsg.to) {
                        debugLog('AUTOMATION', `Sent ${isPoll ? 'poll' : 'message'} to ${whatsappId}, recipient LID: ${sentMsg.to}`);
                        recordTargetedContact(sentMsg.to);
                    }
                }
            } catch (err) {
                activeAutomation.failed++;
                io.emit('automation_log', { message: `Failed to send to ${name}: ${err.message}`, type: 'error' });
            }

            // Update client stats
            io.emit('automation_progress', activeAutomation);

            // Wait with a random delay if not the last item
            if (i < contacts.length - 1 && !shouldStopAutomation) {
                const minMs = minDelay * 1000;
                const maxMs = maxDelay * 1000;
                const delayTime = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
                io.emit('automation_log', { message: `Waiting ${delayTime / 1000}s...`, type: 'system' });
                await delay(delayTime);
            }
        }

        io.emit('automation_end', {
            sent: activeAutomation.sent,
            failed: activeAutomation.failed
        });
    } finally {
        activeAutomation = null;
        isAutomationRunning = false;

        // Process next item in queue if available
        if (automationQueue.length > 0 && !shouldStopAutomation) {
            const nextJob = automationQueue.shift();
            console.log(`Processing queued automation schedule: "${nextJob.scheduleName}" (${automationQueue.length} remaining in queue)...`);
            io.emit('automation_log', { message: `⏰ Starting queued schedule "${nextJob.scheduleName}" (${automationQueue.length} remaining in queue)...`, type: 'system' });
            setTimeout(() => {
                runAutomation(nextJob.contacts, nextJob.messageBody, nextJob.minDelay, nextJob.maxDelay, nextJob.isScheduled, nextJob.scheduleName, nextJob.pollConfig);
            }, 1000);
        }
    }
}

// Manage Cron Jobs based on scheduleConfig
function applySchedule() {
    // Stop and clear all existing cron jobs
    activeCronJobs.forEach((job) => {
        if (job) job.stop();
    });
    activeCronJobs.clear();

    // Load schedule contacts into the targeted list so their replies are tracked
    updateTargetedFromSchedule();

    if (!scheduleConfig || !scheduleConfig.schedules) {
        console.log('No schedules configured.');
        return;
    }

    scheduleConfig.schedules.forEach(schedule => {
        if (!schedule.enabled || !schedule.time) {
            console.log(`Schedule "${schedule.name || 'Unnamed'}" is disabled.`);
            return;
        }

        const [hourStr, minuteStr] = schedule.time.split(':');
        const hour = parseInt(hourStr, 10);
        const minute = parseInt(minuteStr, 10);

        if (isNaN(hour) || isNaN(minute)) {
            console.error(`Invalid schedule time format in schedule "${schedule.name || 'Unnamed'}": ${schedule.time}`);
            return;
        }

        const cronExpression = `${minute} ${hour} * * *`;
        let tz = schedule.timezone || 'Asia/Jerusalem';
        if (tz === 'Local') tz = undefined; // 'Local' is invalid IANA string for node-cron

        console.log(`Scheduling daily cron job for "${schedule.name || 'Unnamed'}": ${cronExpression} (at ${schedule.time} in timezone ${tz || 'Server Local'})`);

        try {
            const cronOptions = { scheduled: true };
            if (tz) cronOptions.timezone = tz;

            const job = cron.schedule(cronExpression, () => {
                console.log(`Scheduled automation "${schedule.name || 'Unnamed'}" triggered!`);
                io.emit('automation_log', { message: `⏰ Scheduled automation "${schedule.name || 'Unnamed'}" triggered!`, type: 'system' });
                
                if (schedule.contacts && schedule.contacts.length > 0) {
                    const activeContacts = schedule.contacts.filter(c => !c.paused);
                    if (activeContacts.length > 0) {
                        // Build pollConfig if schedule is in poll mode
                        let pollConfig = null;
                        if (schedule.messageType === 'poll' && schedule.pollQuestion && schedule.pollOptions && schedule.pollOptions.length >= 2) {
                            pollConfig = {
                                question: schedule.pollQuestion,
                                options: schedule.pollOptions, // Array of { label, triggerValue }
                                scheduleId: schedule.id,
                                chatbotMode: schedule.chatbotMode || null,
                                chatbotId: schedule.chatbotId || null,
                                chatbotRules: schedule.chatbotRules || null
                            };
                            debugLog('SCHEDULE', `Poll mode for "${schedule.name}": Q="${schedule.pollQuestion}", Options=${JSON.stringify(schedule.pollOptions)}`);
                        }

                        runAutomation(activeContacts, schedule.message, 6, 12, true, schedule.name || 'Unnamed', pollConfig);
                    } else {
                        io.emit('automation_log', { message: `⏰ Schedule "${schedule.name || 'Unnamed'}" triggered, but all contacts are currently paused!`, type: 'system' });
                    }
                } else {
                    io.emit('automation_log', { message: `Schedule "${schedule.name || 'Unnamed'}" triggered, but contacts list is empty!`, type: 'error' });
                }
            }, cronOptions);

            activeCronJobs.set(schedule.id, job);
        } catch (err) {
            console.error(`Failed to register cron job for schedule "${schedule.name || 'Unnamed'}":`, err.message);
        }
    });
}

// Initial schedule setup
applySchedule();

// Socket.io Middleware to authenticate connection
io.use((socket, next) => {
    const cookieHeader = socket.handshake.headers.cookie;
    if (!cookieHeader) {
        return next(new Error('Authentication error: No cookies found'));
    }
    const cookies = {};
    cookieHeader.split(';').forEach(c => {
        const idx = c.indexOf('=');
        if (idx !== -1) {
            const key = c.substring(0, idx).trim();
            const val = c.substring(idx + 1).trim();
            cookies[key] = val;
        }
    });
    const session = cookies['auth_session'];
    if (session === SESSION_TOKEN) {
        return next();
    }
    next(new Error('Authentication error: Invalid session'));
});

// Socket.io Connection Logic
io.on('connection', (socket) => {
    console.log(`Socket connected: ${socket.id}`);

    // Broadcast complete state payload to newly connected socket
    broadcastClientStatus(socket);

    // Legacy individual socket events for backward compatibility
    if (whatsappClientReady) {
        socket.emit('ready');
    } else if (lastQrCodeData) {
        socket.emit('qr', lastQrCodeData);
    }

    socket.emit('schedule_update', scheduleConfig);
    socket.emit('chatbot_update', chatbotConfig);

    // Save schedule configuration
    socket.on('save_schedule', (config) => {
        scheduleConfig = {
            enabled: config.enabled !== undefined ? config.enabled : true,
            schedules: config.schedules || []
        };

        try {
            fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(scheduleConfig, null, 2));
            console.log('Saved multi-schedule configuration.');
            applySchedule();
            io.emit('schedule_update', scheduleConfig);
            socket.emit('automation_log', { message: 'Schedules saved successfully!', type: 'success' });
        } catch (err) {
            console.error('Failed to write schedule.json:', err.message);
            socket.emit('automation_log', { message: `Failed to save schedules: ${err.message}`, type: 'error' });
        }
    });

    // Save chatbot rules configuration
    socket.on('save_chatbot_rules', (config) => {
        if (config && Array.isArray(config.chatbots)) {
            chatbotConfig = { chatbots: config.chatbots };
        } else if (config && config.rules) {
            chatbotConfig = {
                chatbots: [
                    {
                        id: 'bot-default',
                        name: 'Default Chatbot',
                        enabled: config.enabled !== undefined ? config.enabled : true,
                        isDefault: true,
                        rules: config.rules || []
                    }
                ]
            };
        }

        try {
            fs.writeFileSync(CHATBOT_FILE, JSON.stringify(chatbotConfig, null, 2));
            console.log('Saved chatbot configuration.');
            io.emit('chatbot_update', chatbotConfig);
            socket.emit('automation_log', { message: 'Chatbot configuration saved successfully!', type: 'success' });
        } catch (err) {
            console.error('Failed to write chatbot_rules.json:', err.message);
            socket.emit('automation_log', { message: `Failed to save chatbot configuration: ${err.message}`, type: 'error' });
        }
    });

    // Start manual automation
    socket.on('start_automation', async (data) => {
        const { contacts, minDelay, maxDelay } = data;
        runAutomation(contacts, null, minDelay, maxDelay, false);
    });

    // Stop automation
    socket.on('stop_automation', () => {
        if (activeAutomation) {
            shouldStopAutomation = true;
            console.log('Stop automation signal received.');
        }
    });

    // Disconnect session
    socket.on('logout', async () => {
        console.log('Logging out WhatsApp client...');
        try {
            await client.logout();
            io.emit('automation_log', { message: 'WhatsApp session logged out.', type: 'warning' });
        } catch (err) {
            console.error('Error during logout:', err.message);
            try {
                await client.destroy();
                whatsappClientReady = false;
                lastQrCodeData = null;
                io.emit('disconnected');
                client.initialize();
            } catch (e) {
                console.error('Failed to force restart client:', e.message);
            }
        }
    });

});

// Run HTTP server
server.listen(PORT, () => {
    console.log(`\n==================================================`);
    console.log(`WhatsApp Automator Web Server listening on port ${PORT}`);
    console.log(`Access local UI at: http://localhost:${PORT}`);
    console.log(`==================================================\n`);
});
