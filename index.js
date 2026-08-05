console.log('=== APP VERSION 2.5.0 (check both original + resolved JID) ===');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Client, LocalAuth } = require('whatsapp-web.js');
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

// === IN-MEMORY DEBUG LOG (viewable from browser via /api/debug-log) ===
const debugLogEntries = [];
const MAX_DEBUG_ENTRIES = 200;
function debugLog(tag, message) {
    const entry = `[${new Date().toISOString()}] [${tag}] ${message}`;
    console.log(entry);
    debugLogEntries.push(entry);
    if (debugLogEntries.length > MAX_DEBUG_ENTRIES) debugLogEntries.shift();
    // Also push to connected dashboard clients in real-time
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
// WhatsApp now uses @lid (Linked ID) format for message routing.
// We need to map LID <-> phone number so we can match incoming @lid messages
// against our targeted contacts stored as @c.us.
const LID_MAP_FILE = path.join(DATA_DIR, 'lid_map.json');
let lidToPhone = {};  // { "73933600633038@lid": "972506798676@c.us", ... }
let phoneToLid = {};  // reverse map

if (fs.existsSync(LID_MAP_FILE)) {
    try {
        lidToPhone = JSON.parse(fs.readFileSync(LID_MAP_FILE, 'utf8'));
        // Build reverse map
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
    if (lidToPhone[lid] === phoneJid) return; // already mapped
    lidToPhone[lid] = phoneJid;
    phoneToLid[phoneJid] = lid;
    saveLidMap();
    debugLog('LID_MAP', `Mapped ${lid} <-> ${phoneJid}`);
}

function resolveToPhone(jid) {
    // If it's already a @c.us or @g.us, return as-is
    if (!jid) return jid;
    if (jid.endsWith('@c.us') || jid.endsWith('@g.us')) return jid;
    // If it's a @lid, try to resolve
    if (jid.endsWith('@lid') && lidToPhone[jid]) {
        return lidToPhone[jid];
    }
    return jid; // unresolvable, return as-is
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
    // Ensure the persistent folder exists
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
        
        // Migrate old format to multi-schedule format
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
            // Ensure global enabled defaults to true now that schedules have individual enable flags
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
    reportSources: [] // array of { id, name, type } — empty = all targeted contacts
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
        // Notify UI in real-time
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
    
    // Direct check (works for groups and correct user JIDs)
    if (targetedContacts.has(jid)) return true;
    
    // Suffix check for user JIDs (resilient against country code differences)
    if (jid.endsWith('@c.us')) {
        const cleanIncoming = jid.split('@')[0].replace(/[^0-9]/g, '');
        // If the number is short, don't do suffix match to avoid collision
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

// Helper: log every incoming reply to repliesData and persist
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

    // Persist to disk
    try {
        fs.writeFileSync(REPLIES_FILE, JSON.stringify(repliesData, null, 2));
    } catch (err) {
        console.error('Failed to save replies.json:', err.message);
    }

    // Notify dashboard in real-time
    io.emit('new_reply', { phone, name, message: messageText, time: timeStr, day: dayKey, month: monthKey });
}

// ============================================================
//  Session Copy Helpers (persistent disk <-> local /tmp)
// ============================================================
function copyDirSync(src, dest) {
    fs.mkdirSync(dest, { recursive: true });
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        // Skip lock files - never copy them
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
            // Skip files that can't be copied (broken symlinks, etc.)
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
            // Remove old backup first
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

// ============================================================
//  Startup: Restore session from persistent disk to /tmp
// ============================================================
console.log('--- Session Setup ---');
fs.mkdirSync(LOCAL_AUTH_DIR, { recursive: true });
restoreSessionFromBackup();

// Client variable
let client = null;

// Graceful shutdown handler
async function gracefulShutdown(signal) {
    console.log(`Received ${signal}. Shutting down gracefully...`);
    // Backup session BEFORE destroying client
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

// Catch unhandled errors so they show in Render logs instead of silent crash
process.on('uncaughtException', (err) => {
    console.error('UNCAUGHT EXCEPTION:', err);
});
process.on('unhandledRejection', (reason) => {
    console.error('UNHANDLED REJECTION:', reason);
});

// Create the WhatsApp client - Chromium runs from LOCAL /tmp directory
function initializeWhatsAppClient() {
    whatsappClientReady = false;
    lastQrCodeData = null;
    io.emit('disconnected'); // Reset UI status

    if (client) {
        console.log('Client already exists. Destroying first...');
        try {
            client.destroy().catch(err => console.error('Error in client.destroy catch:', err.message));
        } catch (err) {
            console.error('Error destroying client:', err.message);
        }
    }

    console.log('Initializing WhatsApp Client...');
    client = new Client({
        authStrategy: new LocalAuth({
            dataPath: LOCAL_AUTH_DIR  // /tmp/wwebjs_auth - container-local, no lock conflicts!
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
                // Single-process mode saves ~150MB RAM (safe now that locks run from /tmp)
                '--single-process',
                '--no-zygote',
                // Aggressive memory reduction
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

    // WhatsApp Event Listeners
    client.on('qr', async (qr) => {
        console.log('QR Code received, converting for Web UI...');
        qrcodeTerminal.generate(qr, { small: true });
        
        try {
            const qrUrl = await qrcode.toDataURL(qr);
            lastQrCodeData = qrUrl;
            whatsappClientReady = false;
            io.emit('qr', qrUrl);
        } catch (err) {
            console.error('Failed to generate QR data URL:', err.message);
        }
    });

    client.on('authenticated', () => {
        console.log('WhatsApp Authenticated!');
        lastQrCodeData = null;
        io.emit('authenticated');
        // Backup session right after successful authentication
        backupSessionToPersistent();
    });

    client.on('auth_failure', (msg) => {
        console.error('WhatsApp Authentication Failure:', msg);
        io.emit('automation_log', { message: `Auth Failure: ${msg}`, type: 'error' });
    });

    client.on('ready', () => {
        console.log('WhatsApp Client Ready!');
        whatsappClientReady = true;
        lastQrCodeData = null;
        io.emit('ready');
        // Also backup when client is fully ready
        backupSessionToPersistent();
    });

    client.on('disconnected', (reason) => {
        console.log('WhatsApp Client Disconnected:', reason);
        whatsappClientReady = false;
        lastQrCodeData = null;
        io.emit('disconnected');
    });

    // === SHARED MESSAGE HANDLER (attached to both 'message' and 'message_create') ===
    async function handleIncomingMessage(msg, eventSource) {
        // Ignore our own outgoing messages
        if (msg.fromMe) {
            return;
        }

        // Deduplicate
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

        // === GATHERING WINDOW CHECK ===
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

                let isInWindow = false;
                if (start <= end) {
                    isInWindow = (currentStr >= start && currentStr <= end);
                } else {
                    isInWindow = (currentStr >= start || currentStr <= end);
                }

                if (!isInWindow) {
                    debugLog(eventSource, `SKIPPED - Message received at ${currentStr} is outside the active gathering window (${start} - ${end}).`);
                    return;
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

        // --- Log every incoming reply for the Excel report ---
        logReply(phone, displayName, isGroup ? `[Group Chat] ${messageText}` : messageText);
        debugLog(eventSource, `Reply logged. repliesData keys: ${JSON.stringify(Object.keys(repliesData))}`);

        // === CHATBOT HANDLING ===
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

        // 1. Check schedule-specific chatbots first
        if (scheduleConfig && Array.isArray(scheduleConfig.schedules)) {
            for (const sch of scheduleConfig.schedules) {
                if (sch.enabled === false || sch.chatbotEnabled === false || sch.chatbotMode === 'off') continue;

                // Determine active rules for this schedule
                let rulesToEvaluate = [];
                if (sch.chatbotMode === 'existing' && sch.chatbotId) {
                    const targetBot = (chatbotConfig.chatbots || []).find(b => b.id === sch.chatbotId);
                    if (targetBot && targetBot.enabled !== false && Array.isArray(targetBot.rules)) {
                        rulesToEvaluate = targetBot.rules;
                    }
                } else if (sch.chatbotRules && Array.isArray(sch.chatbotRules)) {
                    rulesToEvaluate = sch.chatbotRules;
                }

                if (rulesToEvaluate.length === 0) continue;

                const schContacts = sch.contacts || [];
                const isContactInSchedule = schContacts.some(c => {
                    if (c.paused) return false;
                    const cRaw = (c.phone || '').split('|')[0].trim();
                    const cPhone = cRaw.split('@')[0];
                    const rPhone = resolvedFrom.split('@')[0];
                    const sPhone = sender.split('@')[0];
                    const fPhone = msg.from.split('@')[0];
                    return cRaw === resolvedFrom || cRaw === msg.from || cRaw === sender ||
                           (cPhone && (cPhone === rPhone || cPhone === sPhone || cPhone === fPhone));
                });

                if (isContactInSchedule) {
                    for (const rule of rulesToEvaluate) {
                        if (!rule.trigger || !rule.reply) continue;
                        const triggers = rule.trigger.split(',').map(t => t.trim().toLowerCase());
                        if (triggers.includes(incomingText)) {
                            debugLog(eventSource, `SCHEDULE CHATBOT MATCHED "${incomingText}" in schedule "${sch.name}". Replying: "${rule.reply}"`);
                            try {
                                await msg.reply(rule.reply);
                                debugLog(eventSource, `Schedule auto-reply sent successfully!`);
                                io.emit('automation_log', {
                                    message: `🤖 [Schedule: ${sch.name || 'Schedule'}] Auto-replied to ${displayName} (Matched: "${incomingText}") -> "${rule.reply}"`,
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
                }
                if (scheduleAutoReplied) break;
            }
        }

        // 2. Global Chatbot fallback if no schedule rule matched
        if (!scheduleAutoReplied && chatbotConfig && Array.isArray(chatbotConfig.chatbots)) {
            // Find global default chatbot or first enabled chatbot
            const defaultBot = chatbotConfig.chatbots.find(b => b.isDefault && b.enabled !== false) ||
                               chatbotConfig.chatbots.find(b => b.enabled !== false);

            if (defaultBot && Array.isArray(defaultBot.rules) && defaultBot.rules.length > 0) {
                debugLog(eventSource, `Global chatbot "${defaultBot.name}" ENABLED. Checking ${defaultBot.rules.length} rules against: "${incomingText}"`);

                for (const rule of defaultBot.rules) {
                    if (!rule.trigger || !rule.reply) continue;

                    const triggers = rule.trigger.split(',').map(t => t.trim().toLowerCase());
                    if (triggers.includes(incomingText)) {
                        debugLog(eventSource, `GLOBAL TRIGGER MATCHED "${incomingText}". Replying: "${rule.reply}"`);

                        try {
                            await msg.reply(rule.reply);
                            debugLog(eventSource, `Auto-reply sent successfully!`);

                            io.emit('automation_log', { 
                                message: `🤖 [Chatbot: ${defaultBot.name}] Auto-replied to ${displayName} (Matched: "${incomingText}") -> "${rule.reply}"`, 
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

    client.initialize().catch(err => {
        console.error('Failed to initialize client:', err.message);
        io.emit('automation_log', { message: `❌ Initialization failed: ${err.message}`, type: 'error' });
    });
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

        // Build Excel Workbook
        const workbook = new ExcelJS.Workbook();
        workbook.creator = 'WhatsApp Automator';

        const displayDate = `${dayStr}/${monStr}/${yearStr}`;
        const worksheet = workbook.addWorksheet(`Daily Log ${dayStr}-${monStr}`);
        worksheet.views = [{ showGridLines: true }];

        // Title Block - now 3 columns
        worksheet.mergeCells(1, 1, 1, 3);
        const titleCell = worksheet.getCell(1, 1);
        titleCell.value = `WhatsApp Automator - Daily Replies Report`;
        titleCell.font = { name: 'Segoe UI', size: 16, bold: true, color: { argb: 'FF128C7E' } };
        titleCell.alignment = { vertical: 'middle', horizontal: 'left' };
        worksheet.getRow(1).height = 30;

        // Subtitle Block
        worksheet.mergeCells(2, 1, 2, 3);
        const subtitleCell = worksheet.getCell(2, 1);
        subtitleCell.value = `Date: ${displayDate} | Total Replies: ${dayEntries.length}`;
        subtitleCell.font = { name: 'Segoe UI', size: 10, italic: true, color: { argb: 'FF6B7280' } };
        subtitleCell.alignment = { vertical: 'middle', horizontal: 'left' };
        worksheet.getRow(2).height = 20;

        // Blank spacer
        worksheet.addRow([]);

        // Header row — 3 columns only: Time | Contact Name | Reply
        const headerRow = ['Time', 'Contact Name', 'Reply'];
        worksheet.addRow(headerRow);

        const hRow = worksheet.getRow(4);
        hRow.font = { name: 'Segoe UI', bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
        hRow.alignment = { horizontal: 'left', vertical: 'middle' };
        hRow.height = 28;
        hRow.eachCell((cell) => {
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
        hRow.getCell(1).alignment = { horizontal: 'center', vertical: 'middle' };

        // Fixed column widths
        worksheet.getColumn(1).width = 12; // Time
        worksheet.getColumn(2).width = 28; // Contact Name
        worksheet.getColumn(3).width = 65; // Reply (fixed!)

        const borderStyle = {
            top: { style: 'thin', color: { argb: 'FFE5E7EB' } },
            bottom: { style: 'thin', color: { argb: 'FFE5E7EB' } },
            left: { style: 'thin', color: { argb: 'FFE5E7EB' } },
            right: { style: 'thin', color: { argb: 'FFE5E7EB' } }
        };

        if (dayEntries.length === 0) {
            worksheet.mergeCells(5, 1, 5, 3);
            const emptyCell = worksheet.getCell(5, 1);
            emptyCell.value = 'No replies recorded for this day.';
            emptyCell.font = { name: 'Segoe UI', italic: true, color: { argb: 'FF9CA3AF' } };
            emptyCell.alignment = { horizontal: 'center', vertical: 'middle' };
            worksheet.getRow(5).height = 24;
            for (let c = 1; c <= 3; c++) {
                worksheet.getCell(5, c).border = borderStyle;
            }
        } else {
            dayEntries.forEach((entry, idx) => {
                let rawName = entry.name || '';
                let rawPhone = entry.phone || '';
                let cleanName = '';

                if (rawName) {
                    cleanName = rawName;
                } else {
                    // Fallback: old format where phone field may contain the display name
                    const hasLetters = /[a-zA-Zא-ת]/.test(rawPhone);
                    cleanName = (hasLetters || !rawPhone.replace(/[^0-9]/g, '')) ? rawPhone : '';
                }

                const rowData = [
                    entry.time,
                    cleanName || 'Unnamed Contact',
                    entry.message
                ];

                const row = worksheet.addRow(rowData);
                row.alignment = { vertical: 'top', wrapText: true };
                row.getCell(1).alignment = { horizontal: 'center', vertical: 'top' };

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
        }

        // Set response headers for download
        const filename = `WhatsApp_Daily_Replies_${requestedDate.replace(/-/g, '_')}.xlsx`;
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

        await workbook.xlsx.write(res);
        res.end();

        console.log(`Excel daily report downloaded: ${filename}`);
    } catch (err) {
        console.error('Error generating Excel daily report:', err.message);
        res.status(500).json({ error: 'Failed to generate report: ' + err.message });
    }
});

// API route: get system diagnostics status
app.get('/api/status', (req, res) => {
    const memory = process.memoryUsage();
    res.json({
        ready: whatsappClientReady,
        hasQr: lastQrCodeData !== null,
        uptime: Math.round(process.uptime()),
        memory: {
            heapUsed: Math.round(memory.heapUsed / 1024 / 1024) + ' MB',
            rss: Math.round(memory.rss / 1024 / 1024) + ' MB'
        },
        clientState: client ? 'Initialized' : 'Not Initialized',
        targetedCount: targetedContacts.size,
        targetedContacts: Array.from(targetedContacts)
    });
});

// API route: view debug log from the browser (no Render console needed!)
app.get('/api/debug-log', (req, res) => {
    res.json({
        version: '2.3.0',
        totalEntries: debugLogEntries.length,
        entries: debugLogEntries,
        targetedContacts: Array.from(targetedContacts),
        lidMap: lidToPhone,
        chatbotEnabled: chatbotConfig.enabled,
        chatbotRulesCount: chatbotConfig.rules.length,
        chatbotRules: chatbotConfig.rules,
        repliesDataKeys: Object.keys(repliesData),
        repliesData: repliesData,
        whatsappReady: whatsappClientReady
    });
});

// API route: manually restart/refresh the WhatsApp client
app.post('/api/restart-client', (req, res) => {
    console.log('Manual request received via REST API to restart WhatsApp client...');
    try {
        initializeWhatsAppClient();
        res.json({ success: true, message: 'WhatsApp client restart initiated.' });
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

// Function to run the automation loop
async function runAutomation(contacts, messageBody = null, minDelay = 6, maxDelay = 12, isScheduled = false) {
    if (!whatsappClientReady) {
        const errMsg = 'Automation failed to trigger: WhatsApp client is offline.';
        console.error(errMsg);
        io.emit('automation_log', { message: errMsg, type: 'error' });
        return;
    }

    if (activeAutomation) {
        const warnMsg = 'Automation trigger skipped: Another process is already running.';
        console.warn(warnMsg);
        io.emit('automation_log', { message: warnMsg, type: 'warning' });
        return;
    }

    console.log(`Starting ${isScheduled ? 'scheduled' : 'manual'} automation for ${contacts.length} contacts...`);
    io.emit('automation_start', contacts.length);
    
    activeAutomation = {
        total: contacts.length,
        current: 0,
        sent: 0,
        failed: 0
    };
    shouldStopAutomation = false;

    const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    for (let i = 0; i < contacts.length; i++) {
        if (shouldStopAutomation) {
            io.emit('automation_log', { message: 'Automation stopped.', type: 'warning' });
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

        io.emit('automation_log', { message: `[${i + 1}/${contacts.length}] Sending to ${name} (${logPhone})...`, type: 'info' });
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
                const sentMsg = await client.sendMessage(whatsappId, message);
                activeAutomation.sent++;
                io.emit('automation_log', { message: `Success: Message sent to ${name}.`, type: 'success' });
                recordTargetedContact(whatsappId);
                
                // Also record the recipient's LID (WhatsApp's new internal ID format)
                // so that incoming replies from their @lid address match directly
                if (sentMsg && sentMsg.to) {
                    debugLog('AUTOMATION', `Sent message to ${whatsappId}, recipient LID: ${sentMsg.to}`);
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
    activeAutomation = null;
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
            console.error(`Invalid schedule time formatted in schedule: ${schedule.name || 'Unnamed'}`);
            return;
        }

        const cronExpression = `${minute} ${hour} * * *`;
        const tz = schedule.timezone || 'UTC';
        console.log(`Scheduling daily cron job for "${schedule.name || 'Unnamed'}": ${cronExpression} (at ${schedule.time} in timezone ${tz})`);

        const job = cron.schedule(cronExpression, () => {
            console.log(`Scheduled automation "${schedule.name || 'Unnamed'}" triggered!`);
            io.emit('automation_log', { message: `⏰ Scheduled automation "${schedule.name || 'Unnamed'}" triggered!`, type: 'system' });
            
            if (schedule.contacts && schedule.contacts.length > 0) {
                const activeContacts = schedule.contacts.filter(c => !c.paused);
                if (activeContacts.length > 0) {
                    runAutomation(activeContacts, schedule.message, 6, 12, true);
                } else {
                    io.emit('automation_log', { message: `⏰ Schedule "${schedule.name || 'Unnamed'}" triggered, but all contacts are currently paused!`, type: 'system' });
                }
            } else {
                io.emit('automation_log', { message: `Schedule "${schedule.name || 'Unnamed'}" triggered, but contacts list is empty!`, type: 'error' });
            }
        }, {
            scheduled: true,
            timezone: tz
        });

        activeCronJobs.set(schedule.id, job);
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

    // Send current states
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

    socket.on('disconnect', () => {
        console.log(`Socket disconnected: ${socket.id}`);
    });
});

// Run HTTP server
server.listen(PORT, () => {
    console.log(`\n==================================================`);
    console.log(`WhatsApp Automator Web Server listening on port ${PORT}`);
    console.log(`Access local UI at: http://localhost:${PORT}`);
    console.log(`==================================================\n`);
});
