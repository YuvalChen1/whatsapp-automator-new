# 🚀 WhatsApp Automation Hub

A private, local Web Dashboard that allows you to send bulk WhatsApp messages, schedule daily broadcasts, and set up automatic chatbot replies. **No hosting costs, runs completely on your own computer.**

---

## 🛠️ Step 1: Install Prerequisites

Before running the program, you need to install **Node.js** on your computer.

1. Go to the official download page: [https://nodejs.org/](https://nodejs.org/)
2. Download the recommended version (marked **LTS** - Long Term Support) for Windows or Mac.
3. Open the downloaded installer and click **Next** through the installation prompt (leave default settings checked).

---

## 📥 Step 2: Download & Open the Project

1. **Download the files**:
   - On GitHub, click the green **Code** button at the top right.
   - Click **Download ZIP**.
   - Extract the ZIP file anywhere on your computer (e.g., your Desktop).
2. **Open the project folder**:
   - **Windows**: Open the folder, type `cmd` in the address bar at the top, and press **Enter** (this opens Command Prompt inside the folder).
   - **Mac**: Open your **Terminal** app, type `cd ` (with a space), drag the folder from Finder into the terminal window, and press **Enter**.

---

## 🚀 Step 3: Run the Program

In the command prompt/terminal window, run the following two commands:

1. **Install dependencies** (you only need to do this the very first time):
   ```bash
   npm install
   ```
2. **Start the server**:
   ```bash
   npm start
   ```

You will see this message:
`WhatsApp Automator Web Server listening on port 3000`

---

## 💻 Step 4: Access the Dashboard

1. Open your web browser and go to:  
   👉 **[http://localhost:3000](http://localhost:3000)**
2. **Scan the QR Code** with your phone (WhatsApp App ➡️ Settings/Menu ➡️ Linked Devices ➡️ Link a Device).
3. Use the tabs to:
   - **Paste Contacts**: Paste numbers and send bulk messages instantly with safe delays.
   - **CSV Upload**: Import a CSV file with your contact lists.
   - **Daily Scheduler**: Configure messages to send automatically at a specific time (e.g. 07:00 AM) every day.
   - **Chatbot Rules**: Create auto-replies for when people reply to your messages (e.g., replying "1" triggers a success message).

---

### ⚠️ Important Notes:
- **Keep your computer on**: If you shut down your PC, put it to sleep, or close the terminal, the daily scheduled messages will not send.
- **Data storage**: Your settings, daily schedule, and chatbot rules are saved inside your folder (`schedule.json` and `chatbot_rules.json`). They won't be lost when you stop the server.
