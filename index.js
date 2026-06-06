/**
 * Pichangueros Bot — Semana 1 (cimientos + conexión)
 *
 * Objetivo de esta etapa:
 *   1. Conectarse a WhatsApp como dispositivo vinculado (QR escaneado UNA vez).
 *   2. Mantener la sesión viva 24/7 (sesión persistida en disco).
 *   3. Exponer una página /qr para escanear el código fácil desde el navegador.
 *   4. MODO SEGURO: NO le escribe a nadie. Solo responde al comando de prueba
 *      "ping kipi" para confirmar que está vivo. La conversación real (IA,
 *      clasificación por distrito, etc.) se activa en la Semana 2.
 *
 * El cerebro (IA), captura de leads, OCR de vouchers y listas automáticas
 * se construyen en las semanas siguientes del plan de trabajo.
 */
require('dotenv').config();

const express = require('express');
const qrcode = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');
const { Client, LocalAuth } = require('whatsapp-web.js');

const PORT = process.env.PORT || 10000;
// MODO SEGURO encendido por defecto: el bot NO responde a usuarios reales todavía.
const SAFE_MODE = (process.env.SAFE_MODE || 'true') !== 'false';
const TEST_TRIGGER = (process.env.TEST_TRIGGER || 'ping kipi').toLowerCase();

let lastQrDataUrl = null;
let connectionState = 'starting'; // starting | qr | ready | disconnected

// --- Cliente de WhatsApp -----------------------------------------------------
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: process.env.WWEBJS_AUTH_PATH || '.wwebjs_auth' }),
  puppeteer: {
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-zygote',
    ],
  },
});

client.on('qr', async (qr) => {
  connectionState = 'qr';
  qrcodeTerminal.generate(qr, { small: true }); // QR en los logs (respaldo)
  try {
    lastQrDataUrl = await qrcode.toDataURL(qr); // QR como imagen para /qr
    console.log('[QR] Nuevo código listo. Escanéalo en:  <URL del servicio>/qr');
  } catch (e) {
    console.error('[QR] No se pudo generar la imagen del QR:', e.message);
  }
});

client.on('authenticated', () => console.log('[AUTH] Sesión autenticada.'));

client.on('ready', () => {
  connectionState = 'ready';
  lastQrDataUrl = null;
  console.log('[READY] ✅ Pichangueros Bot conectado a WhatsApp.');
});

client.on('disconnected', (reason) => {
  connectionState = 'disconnected';
  console.warn('[DISCONNECTED] Sesión cerrada:', reason);
});

client.on('message', async (msg) => {
  try {
    // Ignorar grupos por ahora (las listas automáticas son de la Semana 5).
    if (msg.from.endsWith('@g.us')) return;

    const body = (msg.body || '').trim().toLowerCase();

    // Comando de prueba: confirma que el bot está vivo (checkpoint Semana 1).
    if (body === TEST_TRIGGER) {
      await msg.reply('✅ Pichangueros Bot conectado y funcionando. (modo prueba)');
      return;
    }

    // MODO SEGURO: no responder a nadie más todavía.
    if (SAFE_MODE) {
      console.log(`[SAFE_MODE] Mensaje recibido de ${msg.from} (sin responder): "${msg.body}"`);
      return;
    }

    // (Semana 2+) Aquí entrará el cerebro de IA / clasificación / captura de leads.
  } catch (e) {
    console.error('[message] Error:', e.message);
  }
});

client.initialize();

// --- Servidor HTTP (health + página de QR) -----------------------------------
const app = express();

app.get('/', (_req, res) => {
  res.json({ service: 'pichangueros-bot', state: connectionState, safeMode: SAFE_MODE });
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
