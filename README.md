# Cosmic CAH Discord Bot

A Cards Against Humanity–style Discord bot with:
- Slash commands
- Custom deck via deck.json
- Solo mode with NPCs
- Private (ephemeral) hands

This bot is self-hosted: you run your own copy under your own Discord bot account.

---

## Requirements
- Node.js 18+
- A Discord account
- A Discord server where you can add bots

---

## Setup

### 1) Clone or download this repo

Clone with git:

    git clone https://github.com/possum-kingdom/cosmic-cah.git
    cd cosmic-cah

Or download the ZIP from GitHub and unzip it, then open a terminal in the folder.

---

### 2) Install dependencies

    npm install

---

### 3) Create a Discord bot

1. Go to https://discord.com/developers/applications
2. Click New Application
3. Name it whatever you want
4. Go to Bot
5. Click Add Bot
6. Click Reset Token and copy the token

---

### 4) Invite the bot to your server

In the Developer Portal:

1. Go to OAuth2 → URL Generator
2. Under Scopes, check:
   - bot
   - applications.commands
3. Under Bot Permissions, check:
   - Send Messages
   - Use Slash Commands
4. Copy the generated URL and open it in your browser
5. Select your server and authorize

---

### 5) Create a .env file

In the project folder, create a file named .env with:

    DISCORD_TOKEN=PASTE_YOUR_BOT_TOKEN
    DISCORD_CLIENT_ID=PASTE_YOUR_APPLICATION_ID

(No server ID required — commands are global.)

---

### 6) Run the bot

    node index.js

If you see something like:

    Logged in as <bot name>
    Registered GLOBAL /cah commands

the bot is running.

---

## Commands

In Discord:

    /cah start
    /cah join
    /cah solo on
    /cah round
    /cah play

---

## Notes
- Stop the bot with Ctrl + C
- Restart after changing deck.json
- Global slash commands may take a few minutes to appear the first time

---

## License
Do whatever you want with it. - Possum
