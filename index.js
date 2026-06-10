console.log('=== APP VERSION 2.0.0 (LOCAL SESSION - NO LOCK CONFLICTS) ===');
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

// === NEW: Session isolation strategy ===
// Persistent disk stores a BACKUP of the session (no Chromium lock files)
// Chromium runs from /tmp which is container-local (never shared between containers)
const PERSISTENT_SESSION_DIR = path.join(DATA_DIR, 'session-backup');
const LOCAL_AUTH_DIR = '/tmp/wwebjs_auth';
const LOCAL_SESSION_DIR = path.join(LOCAL_AUTH_DIR, 'session');

// Serve static UI assets
app.use(express.static(path.join(__dirname, 'public')));

// Global state variables
let whatsappClientReady = false;
let lastQrCodeData = null;
let activeAutomation = null; // Stores running automation state
let shouldStopAutomation = false;
let currentCronJob = null;

// Schedule Configuration state
let scheduleConfig = {
    enabled: false,
    time: '07:00',
    contacts: [],
    message: ''
};

// Chatbot Configuration state
let chatbotConfig = {
    enabled: true,
    rules: []
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
        console.log('Loaded schedule configuration:', scheduleConfig.enabled ? `Active at ${scheduleConfig.time}` : 'Disabled');
    } catch (e) {
        console.error('Error reading schedule.json:', e.message);
    }
}

if (fs.existsSync(CHATBOT_FILE)) {
    try {
        const raw = fs.readFileSync(CHATBOT_FILE, 'utf8');
        chatbotConfig = JSON.parse(raw);
        console.log('Loaded chatbot rules configuration:', chatbotConfig.enabled ? 'Enabled' : 'Disabled');
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

// Helper: log every incoming reply to repliesData and persist
function logReply(phone, messageText) {
    const now = new Date();
    const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const dayKey = String(now.getDate()).padStart(2, '0');
    const timeStr = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

    if (!repliesData[monthKey]) repliesData[monthKey] = {};
    if (!repliesData[monthKey][dayKey]) repliesData[monthKey][dayKey] = [];

    repliesData[monthKey][dayKey].push({
        phone,
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
    io.emit('new_reply', { phone, message: messageText, time: timeStr, day: dayKey, month: monthKey });
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

    // Incoming message listener (for Chatbot Auto-Replies & Reply Tracking)
    client.on('message', async (msg) => {
        // Ignore group chats
        if (msg.from.endsWith('@g.us')) return;

        const phone = msg.from.split('@')[0];
        const incomingText = msg.body.trim().toLowerCase();
        console.log(`Received message from ${msg.from}: "${msg.body}"`);

        // --- Log every incoming reply for the Excel report ---
        logReply(phone, msg.body.trim());

        // Check if chatbot is enabled before processing rules
        if (!chatbotConfig.enabled) return;

        // Scan through our triggers
        for (const rule of chatbotConfig.rules) {
            if (!rule.trigger || !rule.reply) continue;

            // Split triggers by comma (e.g. "1,fine,good" -> ["1", "fine", "good"])
            const triggers = rule.trigger.split(',').map(t => t.trim().toLowerCase());
            
            if (triggers.includes(incomingText)) {
                console.log(`Matched trigger "${incomingText}". Replying with: "${rule.reply}"`);
                
                try {
                    // Reply directly (quotes their message)
                    await msg.reply(rule.reply);

                    // Stream log to Dashboard
                    io.emit('automation_log', { 
                        message: `🤖 Auto-replied to +${phone} (Matched: "${incomingText}") -> "${rule.reply}"`, 
                        type: 'success' 
                    });
                } catch (err) {
                    console.error('Failed to send auto-reply:', err.message);
                    io.emit('automation_log', { 
                        message: `⚠️ Failed to send auto-reply to +${phone}: ${err.message}`, 
                        type: 'error' 
                    });
                }
                break; // Stop evaluating rules after first match
            }
        }
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

        // Collect unique phone numbers for this month
        const phoneSet = new Set();
        for (const dayKey in monthData) {
            for (const entry of monthData[dayKey]) {
                phoneSet.add(entry.phone);
            }
        }
        const phones = Array.from(phoneSet).sort();

        // Build the Excel workbook
        const workbook = new ExcelJS.Workbook();
        workbook.creator = 'WhatsApp Automator';

        const monthNames = ['January','February','March','April','May','June',
                            'July','August','September','October','November','December'];
        const sheetName = `${monthNames[month - 1]} ${year}`;
        const worksheet = workbook.addWorksheet(sheetName);

        // ---- Header row: Day 1 .. Day N ----
        const headerRow = ['Phone Number'];
        for (let d = 1; d <= daysInMonth; d++) {
            headerRow.push(`${d}/${month}`);
        }
        worksheet.addRow(headerRow);

        // Style the header row
        const hRow = worksheet.getRow(1);
        hRow.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
        hRow.alignment = { horizontal: 'center', vertical: 'middle' };
        hRow.height = 28;
        hRow.eachCell((cell, colNumber) => {
            cell.fill = {
                type: 'pattern', pattern: 'solid',
                fgColor: { argb: 'FF128C7E' }  // WhatsApp teal
            };
            cell.border = {
                top: { style: 'thin' }, bottom: { style: 'thin' },
                left: { style: 'thin' }, right: { style: 'thin' }
            };
        });

        // Set column widths
        worksheet.getColumn(1).width = 20;
        for (let d = 1; d <= daysInMonth; d++) {
            worksheet.getColumn(d + 1).width = 18;
        }

        // ---- Data rows: one per phone ----
        phones.forEach((phone, idx) => {
            const rowData = ['+' + phone];
            for (let d = 1; d <= daysInMonth; d++) {
                const dayKey = String(d).padStart(2, '0');
                const dayEntries = (monthData[dayKey] || []).filter(e => e.phone === phone);

                if (dayEntries.length > 0) {
                    // Show replies with time stamps
                    const text = dayEntries.map(e => `[${e.time}] ${e.message}`).join('\n');
                    rowData.push(text);
                } else {
                    rowData.push('');
                }
            }

            const row = worksheet.addRow(rowData);
            row.alignment = { vertical: 'top', wrapText: true };

            // Alternate row background color
            const bgColor = idx % 2 === 0 ? 'FFF0FFF0' : 'FFFFFFFF';
            row.eachCell((cell) => {
                cell.fill = {
                    type: 'pattern', pattern: 'solid',
                    fgColor: { argb: bgColor }
                };
                cell.border = {
                    top: { style: 'thin', color: { argb: 'FFD0D0D0' } },
                    bottom: { style: 'thin', color: { argb: 'FFD0D0D0' } },
                    left: { style: 'thin', color: { argb: 'FFD0D0D0' } },
                    right: { style: 'thin', color: { argb: 'FFD0D0D0' } }
                };
            });

            // Bold the phone number cell
            row.getCell(1).font = { bold: true };

            // Color cells that have replies
            for (let d = 1; d <= daysInMonth; d++) {
                const cell = row.getCell(d + 1);
                if (cell.value) {
                    cell.fill = {
                        type: 'pattern', pattern: 'solid',
                        fgColor: { argb: 'FFDCFCE7' }  // Light green
                    };
                }
            }
        });

        // Summary row
        worksheet.addRow([]);
        const summaryData = ['Total Replies'];
        for (let d = 1; d <= daysInMonth; d++) {
            const dayKey = String(d).padStart(2, '0');
            const count = (monthData[dayKey] || []).length;
            summaryData.push(count > 0 ? count : '');
        }
        const summaryRow = worksheet.addRow(summaryData);
        summaryRow.font = { bold: true, color: { argb: 'FF128C7E' } };
        summaryRow.eachCell((cell) => {
            cell.alignment = { horizontal: 'center' };
            cell.fill = {
                type: 'pattern', pattern: 'solid',
                fgColor: { argb: 'FFE8F5E9' }
            };
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
        clientState: client ? 'Initialized' : 'Not Initialized'
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

// API route: get available months for the dropdown
app.get('/api/reply-months', (req, res) => {
    const months = Object.keys(repliesData).sort().reverse();
    res.json({ months });
});

// API route: get reply stats for dashboard
app.get('/api/reply-stats', (req, res) => {
    const now = new Date();
    const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const monthData = repliesData[monthKey] || {};

    let totalReplies = 0;
    const uniquePhones = new Set();
    const todayKey = String(now.getDate()).padStart(2, '0');
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
        } else if (rawPhone.endsWith('@c.us')) {
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
            if (!whatsappId.endsWith('@g.us')) {
                const isRegistered = await client.isRegisteredUser(whatsappId);
                if (!isRegistered) {
                    canSend = false;
                    activeAutomation.failed++;
                    io.emit('automation_log', { message: `Skipped: ${logPhone} is not on WhatsApp.`, type: 'warning' });
                }
            }

            if (canSend) {
                await client.sendMessage(whatsappId, message);
                activeAutomation.sent++;
                io.emit('automation_log', { message: `Success: Message sent to ${name}.`, type: 'success' });
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
    if (currentCronJob) {
        currentCronJob.stop();
        currentCronJob = null;
    }

    if (!scheduleConfig.enabled || !scheduleConfig.time) {
        console.log('Daily schedule is disabled.');
        return;
    }

    const [hourStr, minuteStr] = scheduleConfig.time.split(':');
    const hour = parseInt(hourStr, 10);
    const minute = parseInt(minuteStr, 10);

    if (isNaN(hour) || isNaN(minute)) {
        console.error('Invalid schedule time formatted in configuration.');
        return;
    }

    const cronExpression = `${minute} ${hour} * * *`;
    const tz = scheduleConfig.timezone || 'UTC';
    console.log(`Scheduling daily cron job: ${cronExpression} (at ${scheduleConfig.time} in timezone ${tz})`);

    currentCronJob = cron.schedule(cronExpression, () => {
        console.log('Daily scheduled automation triggered!');
        io.emit('automation_log', { message: '⏰ Daily scheduled automation triggered!', type: 'system' });
        
        if (scheduleConfig.contacts && scheduleConfig.contacts.length > 0) {
            runAutomation(scheduleConfig.contacts, scheduleConfig.message, 6, 12, true);
        } else {
            io.emit('automation_log', { message: 'Schedule triggered, but contacts list is empty!', type: 'error' });
        }
    }, {
        scheduled: true,
        timezone: tz
    });
}

// Initial schedule setup
applySchedule();

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
            enabled: config.enabled,
            time: config.time || '07:00',
            contacts: config.contacts || [],
            message: config.message || '',
            timezone: config.timezone || 'UTC'
        };

        try {
            fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(scheduleConfig, null, 2));
            console.log('Saved schedule configuration.');
            applySchedule();
            io.emit('schedule_update', scheduleConfig);
            socket.emit('automation_log', { message: 'Schedule config saved successfully!', type: 'success' });
        } catch (err) {
            console.error('Failed to write schedule.json:', err.message);
            socket.emit('automation_log', { message: `Failed to save schedule: ${err.message}`, type: 'error' });
        }
    });

    // Save chatbot rules configuration
    socket.on('save_chatbot_rules', (config) => {
        chatbotConfig = {
            enabled: config.enabled,
            rules: config.rules || []
        };

        try {
            fs.writeFileSync(CHATBOT_FILE, JSON.stringify(chatbotConfig, null, 2));
            console.log('Saved chatbot rules configuration.');
            io.emit('chatbot_update', chatbotConfig);
            socket.emit('automation_log', { message: 'Chatbot auto-reply rules saved successfully!', type: 'success' });
        } catch (err) {
            console.error('Failed to write chatbot_rules.json:', err.message);
            socket.emit('automation_log', { message: `Failed to save chatbot rules: ${err.message}`, type: 'error' });
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
