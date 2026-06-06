/**
 * Pichangueros Bot — Semana 1 (cimientos + conexión) · motor: Baileys
 *
 * Baileys habla el protocolo de WhatsApp directamente (sin navegador/Chromium),
 * así que es liviano y estable en servidores chicos.
 *
 * Etapa actual:
 *   1. Conectarse a WhatsApp por QR (escaneado UNA vez; sesión persistida en disco).
 *   2. Mantenerse vivo 24/7 con reconexión automática.
 *   3. Página /qr para escanear fácil desde el navegador.
 *   4. MODO SEGURO: NO le escribe a nadie. Solo responde al comando de prueba
 *      "ping kipi". El cerebro real (IA, distritos, leads) entra en la Semana 2.
 */
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const express = require('express');
const qrcode = require('qrcode');
const pino = require('pino');
const { Boom } = require('@hapi/boom');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');

const PORT = process.env.PORT || 10000;
const AUTH_PATH = process.env.WWEBJS_AUTH_PATH || '.wwebjs_auth';
const SESSION_DIR = path.join(AUTH_PATH, 'baileys');
const SAFE_MODE = (process.env.SAFE_MODE || 'true') !== 'false';
const TEST_TRIGGER = (process.env.TEST_TRIGGER || 'ping kipi').toLowerCase();

let lastQrDataUrl = null;
let connectionState = 'starting'; // starting | qr | ready | disconnected

process.on('unhandledRejection', (r) => console.error('[unhandledRejection]', r));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e && e.message ? e.message : e));

// Reset opcional de la sesión (RESET_SESSION=true): borra el contenido y fuerza QR nuevo.
if ((process.env.RESET_SESSION || 'false') === 'true') {
  try {
    if (fs.existsSync(AUTH_PATH)) {
      for (const entry of fs.readdirSync(AUTH_PATH)) {
        fs.rmSync(path.join(AUTH_PATH, entry), { recursive: true, force: true });
      }
    }
    console.log('[RESET] Sesión borrada (RESET_SESSION=true) → generará QR nuevo.');
  } catch (e) { console.error('[RESET] Error borrando sesión:', e.message); }
}

async function startBot() {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);

  let version;
  try { ({ version } = await fetchLatestBaileysVersion()); } catch (_) { /* usa default */ }

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    browser: ['Pichangueros', 'Chrome', '1.0.0'],
    syncFullHistory: false, // no descargar todo el historial (más liviano)
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      connectionState = 'qr';
      try {
        lastQrDataUrl = await qrcode.toDataURL(qr);
        console.log('[QR] Código listo. Escanéalo en  <URL del servicio>/qr');
      } catch (e) { console.error('[QR] No se pudo generar imagen:', e.message); }
    }

    if (connection === 'open') {
      connectionState = 'ready';
      lastQrDataUrl = null;
      console.log('[READY] ✅ Pichangueros Bot conectado a WhatsApp.');
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error instanceof Boom
        ? lastDisconnect.error.output?.statusCode
        : undefined;
      const loggedOut = code === DisconnectReason.loggedOut;
      console.warn(`[CLOSE] Conexión cerrada (code=${code}, loggedOut=${loggedOut}).`);

      if (loggedOut) {
        // Sesión cerrada desde el celular: limpiar y pedir QR nuevo.
        connectionState = 'disconnected';
        try { fs.rmSync(SESSION_DIR, { recursive: true, force: true }); } catch (_) {}
      } else {
        connectionState = 'starting';
      }
      setTimeout(startBot, 2000); // reconectar
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      try {
        if (!msg.message || msg.key.fromMe) continue;
        const from = msg.key.remoteJid;
        if (!from || from.endsWith('@g.us') || from === 'status@broadcast') continue; // ignorar grupos por ahora

        const body = (
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          ''
        ).trim().toLowerCase();

        // Comando de prueba (checkpoint Semana 1)
        if (body === TEST_TRIGGER) {
          await sock.sendMessage(from, { text: '✅ Pichangueros Bot conectado y funcionando. (modo prueba)' });
          continue;
        }

        // MODO SEGURO: no responder a nadie más todavía.
        if (SAFE_MODE) {
          console.log(`[SAFE_MODE] DM de ${from} (sin responder): "${body}"`);
          continue;
        }

        // (Semana 2+) Aquí entra el cerebro de IA / clasificación / captura de leads.
      } catch (e) { console.error('[message] Error:', e.message); }
    }
  });
}

startBot();

// --- Servidor HTTP (health + página de QR) -----------------------------------
const app = express();

app.get('/', (_req, res) => {
  res.json({ service: 'pichangueros-bot', engine: 'baileys', state: connectionState, safeMode: SAFE_MODE });
});

app.get('/qr', (_req, res) => {
  if (connectionState === 'ready') {
    return res.send('<h2>✅ Ya está conectado. No hace falta escanear nada.</h2>');
  }
  if (!lastQrDataUrl) {
    return res.send('<h2>Generando código QR… recarga en unos segundos.</h2><meta http-equiv="refresh" content="3">');
  }
  res.send(`
    <html><body style="font-family:sans-serif;text-align:center;padding:32px">
      <h2>Escanea este código desde WhatsApp</h2>
      <p>WhatsApp → Ajustes → Dispositivos vinculados → Vincular dispositivo</p>
      <img src="${lastQrDataUrl}" style="width:320px;height:320px" />
      <meta http-equiv="refresh" content="20">
    </body></html>`);
});

app.listen(PORT, () => console.log(`[HTTP] Escuchando en puerto ${PORT}. QR en /qr`));
