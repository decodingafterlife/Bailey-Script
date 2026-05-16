import nodeCrypto from 'node:crypto';
if (!globalThis.crypto) {
    globalThis.crypto = nodeCrypto.webcrypto;
}

import makeWASocket, { 
    useMultiFileAuthState, 
    DisconnectReason,
    downloadMediaMessage 
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import axios from 'axios';
import qrcode from 'qrcode-terminal';
import FormData from 'form-data';

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID;
const WHATSAPP_CHANNEL_JID = process.env.WHATSAPP_CHANNEL_JID;

async function connectToWhatsApp() {
    console.log("🚀 Starting WhatsApp Bridge (ESM Mode)...");
    
    const { state, saveCreds } = await useMultiFileAuthState('./data/auth_info_baileys');

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }), 
        version: [2, 3000, 1033893291], 
        browser: ['Mac OS', 'Chrome', '121.0.6167.160'],
        keepAliveIntervalMs: 25000,
        syncFullHistory: false,
        markOnlineOnConnect: false,
        getMessage: async (key) => {
            return { conversation: 'Dummy message to prevent crash' };
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log('\n--- SCAN THIS QR CODE WITH WHATSAPP ---');
            qrcode.generate(qr, { small: true });
        }
        
        if (connection === 'close') {
            const error = lastDisconnect?.error;
            const statusCode = (error instanceof Boom) ? error.output?.statusCode : 500;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            
            console.log('\n❌ Connection closed:', error?.message || "Unknown Error");
            console.log(`Status Code: ${statusCode}`);
            
            if (shouldReconnect) {
                console.log('⏳ Reconnecting in 3 seconds...');
                setTimeout(connectToWhatsApp, 3000);
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

            try {
                if (messageType === 'conversation') {
                    text = msg.message.conversation;
                    console.log(`Forwarding Text: ${text.substring(0, 30)}...`);
                    await sendTextToTelegram(text);
                    
                } else if (messageType === 'extendedTextMessage') {
                    text = msg.message.extendedTextMessage.text;
                    console.log(`Forwarding Text: ${text.substring(0, 30)}...`);
                    await sendTextToTelegram(text);
                    
                } else if (messageType === 'imageMessage') {
                    text = msg.message.imageMessage.caption || '';
                    console.log(`Downloading Image with caption: ${text.substring(0, 30)}...`);
                    
                    const buffer = await downloadMediaMessage(msg, 'buffer', {}, { 
                        logger: pino({ level: 'silent' }),
                        reuploadRequest: sock.updateMediaMessage
                    });
                    
                    await sendMediaToTelegram(buffer, 'image', text);
                    
                } else if (messageType === 'videoMessage') {
                    text = msg.message.videoMessage.caption || '';
                    console.log(`Downloading Video with caption: ${text.substring(0, 30)}...`);
                    
                    const buffer = await downloadMediaMessage(msg, 'buffer', {}, { 
                        logger: pino({ level: 'silent' }),
                        reuploadRequest: sock.updateMediaMessage
                    });
                    
                    await sendMediaToTelegram(buffer, 'video', text);
                } else {
                    console.log(`Message received, but unsupported media type: ${messageType}`);
                }
            } catch (err) {
                console.error("❌ Failed to process message:", err.message);
            }
        }
    });
}

async function sendTextToTelegram(text) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHANNEL_ID) return;
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    try {
        await axios.post(url, {
            chat_id: TELEGRAM_CHANNEL_ID,
            text: text
        });
        console.log("✅ Sent Text to Telegram");
    } catch (error) {
        console.error("❌ Telegram Error:", error.response?.data || error.message);
    }
}

async function sendMediaToTelegram(buffer, type, caption) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHANNEL_ID) return;

    const endpoint = type === 'image' ? 'sendPhoto' : 'sendVideo';
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${endpoint}`;
    
    const formData = new FormData();
    formData.append('chat_id', TELEGRAM_CHANNEL_ID);
    
    if (caption) {
        formData.append('caption', caption);
    }

    const filename = type === 'image' ? 'image.jpg' : 'video.mp4';
    const fileField = type === 'image' ? 'photo' : 'video';

    formData.append(fileField, buffer, { filename: filename });

    try {
        await axios.post(url, formData, {
            headers: formData.getHeaders() 
        });
        console.log(`✅ Sent ${type.toUpperCase()} to Telegram`);
    } catch (error) {
        console.error(`❌ Telegram Error (${type}):`, error.response?.data || error.message);
    }
}

connectToWhatsApp();