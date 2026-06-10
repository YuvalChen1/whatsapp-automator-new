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

// Initialize WhatsApp client
console.log('Initializing WhatsApp Client...');
const client = new Client({
    authStrategy: new LocalAuth({
        dataPath: DATA_DIR
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
            '--no-zygote',
            '--single-process',
            '--disable-gpu'
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

                // Phone was already extracted above
                
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

client.initialize();

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
        let phone = contact.phone.toString().trim();
        const name = contact.name || 'Recipient';
        const message = contact.message || messageBody || 'Hello!';

        phone = phone.replace(/[^0-9]/g, '');
        const whatsappId = phone.endsWith('@c.us') ? phone : `${phone}@c.us`;

        io.emit('automation_log', { message: `[${i + 1}/${contacts.length}] Sending to ${name} (${phone})...`, type: 'info' });
        activeAutomation.current++;

        try {
            const isRegistered = await client.isRegisteredUser(whatsappId);
            if (!isRegistered) {
                activeAutomation.failed++;
                io.emit('automation_log', { message: `Skipped: ${phone} is not on WhatsApp.`, type: 'warning' });
            } else {
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
    console.log(`Scheduling daily cron job: ${cronExpression} (at ${scheduleConfig.time})`);

    currentCronJob = cron.schedule(cronExpression, () => {
        console.log('Daily scheduled automation triggered!');
        io.emit('automation_log', { message: '⏰ Daily scheduled automation triggered!', type: 'system' });
        
        if (scheduleConfig.contacts && scheduleConfig.contacts.length > 0) {
            runAutomation(scheduleConfig.contacts, scheduleConfig.message, 6, 12, true);
        } else {
            io.emit('automation_log', { message: 'Schedule triggered, but contacts list is empty!', type: 'error' });
        }
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
            message: config.message || ''
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
