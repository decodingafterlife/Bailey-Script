const nodeCrypto = require('crypto');
if (!global.crypto) {
    global.crypto = nodeCrypto.webcrypto;
}

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const axios = require('axios');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID;
const WHATSAPP_CHANNEL_JID = process.env.WHATSAPP_CHANNEL_JID;

async function connectToWhatsApp() {
    console.log("Starting WhatsApp Bridge...");
    const { state, saveCreds } = await useMultiFileAuthState('./data/auth_info_baileys');

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
        logger: pino({ level: 'silent' }), 
        // Spoofing a standard Ubuntu Chrome browser to prevent instant WebSocket rejections
        browser: ["Ubuntu", "Chrome", "20.0.04"],
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log('\n--- SCAN THIS QR CODE WITH WHATSAPP ---');
        }
        
        if (connection === 'close') {
            const error = lastDisconnect?.error;
            const statusCode = (error instanceof Boom) ? error.output?.statusCode : 500;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            
            // PRINT THE EXACT ERROR CAUSING THE DISCONNECT
            console.log('\n❌ Connection closed due to error:');
            console.log(error?.message || error || "Unknown Error");
            console.log(`Status Code: ${statusCode}`);
            
            if (shouldReconnect) {
                console.log('⏳ Reconnecting in 3 seconds...');
                setTimeout(connectToWhatsApp, 3000);
            } else {
                console.log('🚨 Logged out. You need to delete the ./data/auth_info_baileys folder and rescan.');
            }
        } else if (connection === 'open') {
            console.log('✅ Connected to WhatsApp successfully!');
            console.log(`🎧 Listening strictly for Channel: ${WHATSAPP_CHANNEL_JID}`);
        }
    });

    sock.ev.on('messages.upsert', async m => {
        if (m.type !== 'notify') return;
        const msg = m.messages[0];
        if (!msg.message) return;

        const remoteJid = msg.key.remoteJid;
        
        if (remoteJid === WHATSAPP_CHANNEL_JID) {
            if (msg.key.fromMe) return;

            console.log('\n--- NEW CHANNEL MESSAGE DETECTED ---');
            
            const messageType = Object.keys(msg.message)[0];
            let text = '';

            if (messageType === 'conversation') {
                text = msg.message.conversation;
            } else if (messageType === 'extendedTextMessage') {
                text = msg.message.extendedTextMessage.text;
            } else if (messageType === 'newsletterAdminInviteMessage') {
                text = msg.message.newsletterAdminInviteMessage.caption;
            } else if (messageType === 'imageMessage' && msg.message.imageMessage.caption) {
                text = msg.message.imageMessage.caption;
            } else if (messageType === 'videoMessage' && msg.message.videoMessage.caption) {
                text = msg.message.videoMessage.caption;
            }

            if (text) {
                console.log(`Extracted text: ${text.substring(0, 30)}...`);
                sendToTelegram(text);
            } else {
                console.log(`Message received, but unsupported media type: ${messageType}`);
            }
        }
    });
}

async function sendToTelegram(text) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHANNEL_ID) {
        console.log("❌ Missing Telegram credentials!");
        return;
    }
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    try {
        const response = await axios.post(url, {
            chat_id: TELEGRAM_CHANNEL_ID,
            text: text
        });
        if (response.status === 200) {
            console.log("✅ Successfully forwarded to Telegram!");
        }
    } catch (error) {
        console.error("❌ Failed to send to Telegram:", error.response ? error.response.data : error.message);
    }
}

connectToWhatsApp();