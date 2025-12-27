'use strict';

const fs = require('fs');
const path = require('path');
const pino = require('pino');

const qrcode = require('qrcode-terminal');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

const CONFIG = require('./src/config');
const { loadJSON, saveJSON } = require('./src/lib/store');
const { safeSendText, isGroup, pickText } = require('./src/lib/utils');
const { buildCommandMap, parseCommand } = require('./src/lib/commands');

const logger = pino({ level: 'silent' });

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const db = loadJSON(DB_FILE, {
  stats: { startedAt: Date.now(), messages: 0, commands: 0 },
  group: { welcome: true },
  cooldowns: {}
});

// أوامر
const commands = buildCommandMap(path.join(__dirname, 'src', 'commands'));

function isOwner(senderJid) {
  const n = (senderJid || '').split('@')[0];
  return CONFIG.OWNERS.includes(n);
}

function now() { return Date.now(); }

function isOnCooldown(senderJid, key, ms) {
  const id = `${senderJid}:${key}`;
  const last = db.cooldowns[id] || 0;
  if (now() - last < ms) return true;
  db.cooldowns[id] = now();
  saveJSON(DB_FILE, db);
  return false;
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger,
    auth: state,
    printQRInTerminal: false,
    mobile: false, // Ensure mobile is false for pairing code
    browser: ["Ubuntu", "Chrome", "20.0.04"] // Standard browser string often helps with pairing
  });

  if (!sock.authState.creds.registered) {
    if (CONFIG.AUTO_PAIR && CONFIG.PAIR_NUMBER) {
      setTimeout(async () => {
        try {
          const code = await sock.requestPairingCode(CONFIG.PAIR_NUMBER);
          console.log('🔗 Pairing Code:', code);
          console.log('واتساب > الإعدادات > الأجهزة المرتبطة > إدخال رمز');
        } catch (e) {
          console.log('⚠️ فشل طلب Pairing Code:', e?.message || e);
        }
      }, 5000);
    } else {
      console.log('⚠️ لم يتم تحديد PAIR_NUMBER في Secrets');
    }
  }

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (connection === 'close') {
      const reason = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = reason !== DisconnectReason.loggedOut;

      console.log('❌ الاتصال انغلق. السبب:', reason);
      if (shouldReconnect) {
        console.log('🔄 إعادة تشغيل البوت...');
        setTimeout(() => startBot().catch(console.error), 5000); // Add a small delay
      } else {
        console.log('⚠️ تم تسجيل الخروج. احذف مجلد auth_info وأعد الربط.');
      }
    }

    if (connection === 'open') {
      console.log('✅ تم تشغيل البوت بنجاح!');
    }

  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages?.[0];
    if (!msg?.message) return;
    if (msg.key.fromMe) return;

    db.stats.messages++;
    saveJSON(DB_FILE, db);

    const chatId = msg.key.remoteJid;
    const sender = msg.key.participant || chatId;

    const text = pickText(msg.message);
    if (!text) return;

    const parsed = parseCommand(text, CONFIG.PREFIX);
    if (!parsed.isCommand) return;

    if (isOnCooldown(sender, 'cmd_global', CONFIG.COOLDOWN_MS)) {
      return safeSendText(sock, chatId, '⏳ انتظر قليلًا قبل إرسال أمر جديد.', msg);
    }

    const { command, args } = parsed;
    const cmd = commands.get(command);

    if (!cmd) {
      return safeSendText(sock, chatId, `❓ أمر غير معروف. اكتب ${CONFIG.PREFIX}menu`, msg);
    }

    const group = isGroup(chatId);
    const owner = isOwner(sender);

    if (cmd.ownerOnly && !owner) {
      return safeSendText(sock, chatId, '⛔ هذا الأمر خاص بالمالك فقط.', msg);
    }
    if (cmd.groupOnly && !group) {
      return safeSendText(sock, chatId, '👥 هذا الأمر يعمل داخل المجموعات فقط.', msg);
    }

    db.stats.commands++;
    saveJSON(DB_FILE, db);

    try {
      await cmd.run({
        sock,
        msg,
        chatId,
        sender,
        text,
        args,
        prefix: CONFIG.PREFIX,
        config: CONFIG,
        db,
        save: () => saveJSON(DB_FILE, db),
        isOwner: owner
      });
    } catch (e) {
      console.log('❌ خطأ أثناء تنفيذ الأمر:', e?.message || e);
      await safeSendText(sock, chatId, '⚠️ حدث خطأ أثناء تنفيذ الأمر.', msg);
    }
  });

  // ترحيب/وداع
  sock.ev.on('group-participants.update', async (ev) => {
    try {
      if (!db.group.welcome) return;
      const jid = ev.id;
      const who = ev.participants?.[0];
      if (!jid || !who) return;

      if (ev.action === 'add') {
        await safeSendText(sock, jid, `👋 مرحبًا @${who.split('@')[0]}!`, null, [who]);
      } else if (ev.action === 'remove') {
        await safeSendText(sock, jid, `👋 وداعًا @${who.split('@')[0]}!`, null, [who]);
      }
    } catch {}
  });

  process.on('unhandledRejection', (err) => console.log('unhandledRejection:', err));
  process.on('uncaughtException', (err) => console.log('uncaughtException:', err));
}

startBot().catch(console.error);
