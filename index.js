/**
 * Pichangueros Bot — Semana 4 (Yape + IA) · motor: Baileys
 *
 * Qué hace ahora:
 *   1. Conexión a WhatsApp por QR, sesión persistida, reconexión automática (Semana 1).
 *   2. Cerebro IA (src/brain.js): responde con el tono de Clarck, contesta FAQs
 *      con datos reales (editables en /admin/leads?vista=config) y guía el
 *      filtro de jugadores nuevos.
 *   3. Captura de leads (src/db.js): todo contacto queda en SQLite con nombre,
 *      edad, distrito y zona — incluso si el bot no le responde (MODO SEGURO).
 *   4. Handoff: quejas y casos especiales → el bot se calla para ese contacto
 *      y avisa por WhatsApp al número de control (NOTIFY_NUMBER).
 *   5. Pagos por Yape (src/pagos.js): si el mensaje trae una imagen, se intenta
 *      leer como voucher (monto/titular/n° de operación) antes de pasar al
 *      cerebro conversacional. Anti-reenvío + valida el monto contra el precio
 *      de la zona del contacto; lo que no calza queda "por revisar" en el CRM.
 *
 * MODO SEGURO (SAFE_MODE=true): el bot solo RESPONDE a los números de
 * ALLOWED_TESTERS. Al resto los registra Y el cerebro les EXTRAE los datos
 * (nombre/edad/zona) para enriquecer el CRM, pero sin enviarles nada ni avisar
 * a Clarck. Cuando Clarck apruebe el guion → SAFE_MODE=false y atiende a todos.
 *
 * Comandos del número de control (NOTIFY_NUMBER), por DM al bot:
 *   kipi estado               → resumen: conexión, leads, handoffs
 *   kipi reactivar <numero>   → saca a un contacto del handoff (el bot vuelve a atenderlo)
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
  downloadMediaMessage,
} = require('@whiskeysockets/baileys');

const db = require('./src/db');
const brain = require('./src/brain');
const pagos = require('./src/pagos');
const sheet = require('./src/sheetsync');

const PORT = process.env.PORT || 10000;
const AUTH_PATH = process.env.WWEBJS_AUTH_PATH || '.wwebjs_auth';
const SESSION_DIR = path.join(AUTH_PATH, 'baileys');
const SAFE_MODE = (process.env.SAFE_MODE || 'true') !== 'false';
const TEST_TRIGGER = (process.env.TEST_TRIGGER || 'ping kipi').toLowerCase();
// Números (solo dígitos, con código de país, ej. 51999888777) que el cerebro
// SÍ atiende aunque esté en MODO SEGURO. Separados por coma.
const ALLOWED_TESTERS = (process.env.ALLOWED_TESTERS || '')
  .split(',').map((n) => n.replace(/\D/g, '')).filter(Boolean);
// Número de control: recibe avisos de leads/handoffs y puede usar comandos kipi.
const NOTIFY_NUMBER = (process.env.NOTIFY_NUMBER || '').replace(/\D/g, '');
// Fallback de vinculación SIN QR: si está seteado (solo dígitos, con código de
// país) y la sesión aún no está registrada, se pide un código de 8 dígitos para
// vincular desde WhatsApp > Dispositivos vinculados > "Vincular con número".
const PAIR_NUMBER = (process.env.PAIR_NUMBER || '').replace(/\D/g, '');

let lastQrDataUrl = null;
let connectionState = 'starting'; // starting | qr | ready | disconnected
let linkedNumber = null; // número de WhatsApp al que está enlazado (se llena al conectar)
let currentSock = null;  // socket activo de Baileys (para poder desconectar desde el panel)
let arrancando = false;  // candado: evita que se creen varios sockets en paralelo (corrompe la sesión → "Bad MAC")

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

// Reset SOLO de las sesiones de cifrado por-contacto (RESET_SESSIONS_ONLY=true):
// borra session-*/sender-key-* pero CONSERVA creds.json y app-state → el bot
// sigue enlazado (SIN QR) y reconstruye sesiones limpias con cada contacto en
// el próximo mensaje. Arregla corrupción tipo "Bad MAC" / "Key used already or
// never filled" sin re-vincular. Quitar el flag tras el primer arranque OK.
if ((process.env.RESET_SESSIONS_ONLY || 'false') === 'true') {
  try {
    if (fs.existsSync(SESSION_DIR)) {
      let n = 0;
      for (const f of fs.readdirSync(SESSION_DIR)) {
        if (/^(session-|sender-key-)/.test(f)) {
          fs.rmSync(path.join(SESSION_DIR, f), { force: true });
          n++;
        }
      }
      console.log(`[RESET] ${n} archivos de sesión borrados (RESET_SESSIONS_ONLY) — se mantiene el enlace; sesiones se reconstruyen solas.`);
    }
  } catch (e) { console.error('[RESET] Error borrando sesiones:', e.message); }
}

const jidToNumero = (jid) => (jid || '').split('@')[0].split(':')[0].replace(/\D/g, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Número real del remitente. WhatsApp a veces manda el chat con un LID
 * (ID anónimo, ej. 201382560821305@lid) en vez del número: en ese caso el
 * número real viene en key.senderPn. Si no viene, usamos los dígitos del LID
 * (peor que nada: identifica al contacto de forma estable igual).
 */
function numeroDe(msg) {
  const jid = msg.key.remoteJid || '';
  if (jid.endsWith('@lid')) {
    const pn = msg.key.senderPn || msg.key.participantPn || '';
    if (pn) return jidToNumero(pn);
  }
  return jidToNumero(jid);
}

/** Saca el texto útil del mensaje; los adjuntos se vuelven un marcador para el cerebro. */
function extraerTexto(msg) {
  const m = msg.message;
  if (!m) return '';
  const texto = m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption || m.videoMessage?.caption;
  if (texto) return texto.trim();
  if (m.imageMessage) return '[el jugador envió una imagen]';
  if (m.audioMessage) return '[el jugador envió un audio]';
  if (m.stickerMessage) return '[el jugador envió un sticker]';
  if (m.documentMessage) return '[el jugador envió un documento]';
  return '';
}

async function notificarControl(sock, texto) {
  if (!NOTIFY_NUMBER) return;
  try {
    await sock.sendMessage(`${NOTIFY_NUMBER}@s.whatsapp.net`, { text: texto });
  } catch (e) { console.error('[notify] No se pudo avisar al número de control:', e.message); }
}

/** Comandos administrativos del número de control. Devuelve true si el mensaje era un comando. */
async function comandoControl(sock, from, body) {
  const texto = body.toLowerCase();
  if (texto === 'kipi estado') {
    const s = db.stats();
    const zonas = s.porZona.map((z) => `${z.zona}: ${z.n}`).join(', ') || 'sin clasificar aún';
    await sock.sendMessage(from, {
      text: `📊 Pichangueros Bot\nConexión: ${connectionState} · Modo seguro: ${SAFE_MODE ? 'ON' : 'OFF'} · Cerebro: ${brain.cerebroActivo() ? 'ON' : 'OFF (falta OPENAI_API_KEY)'}\nLeads: ${s.leads} (${s.completos} con datos) · Por zona: ${zonas}\nEn handoff: ${s.enHandoff}`,
    });
    return true;
  }
  const reactivar = texto.match(/^kipi reactivar (\+?[\d\s-]+)$/);
  if (reactivar) {
    const numero = reactivar[1].replace(/\D/g, '');
    db.clearHandoff(numero);
    await sock.sendMessage(from, { text: `✅ Listo: el bot vuelve a atender al ${numero}.` });
    return true;
  }
  return false;
}

async function manejarMensaje(sock, msg) {
  const from = msg.key.remoteJid;
  if (!from || from.endsWith('@g.us') || from === 'status@broadcast') return; // grupos: Semana 5

  const body = extraerTexto(msg);
  if (!body) return;
  const numero = numeroDe(msg); // resuelve LID → número real cuando se puede

  // A DÓNDE responder: SIEMPRE al mismo JID por el que llegó el mensaje (from),
  // sea un número normal o un LID anónimo (xxx@lid). Baileys >=6.7.10 mapea la
  // sesión de cifrado del LID internamente. Reescribir el destino a mano
  // (LID → número real vía senderPn) rompía la entrega: el mensaje se cifraba
  // sin error pero nunca le llegaba al contacto.
  const pnJid = msg.key.senderPn || msg.key.participantPn || null;
  const destino = from;
  if (ALLOWED_TESTERS.includes(numero)) {
    console.log(`[dbg tester] numero=${numero} remoteJid=${from} senderPn=${pnJid || '-'} → destino=${destino}`);
  }

  // Comando de prueba (sigue vivo como chequeo rápido de conexión)
  if (body.toLowerCase() === TEST_TRIGGER) {
    try {
      const sent = await sock.sendMessage(destino, { text: '✅ Pichangueros Bot conectado y funcionando. (modo prueba)' });
      console.log(`[test-send] OK → ${destino} id=${sent?.key?.id}`);
    } catch (e) { console.error(`[test-send] ERROR → ${destino}:`, e?.message); }
    return;
  }

  // Comandos del número de control
  if (numero === NOTIFY_NUMBER && (await comandoControl(sock, from, body))) return;

  // Todo contacto queda registrado, responda el bot o no (captura de leads).
  const lead = db.getOrCreateLead(numero);
  db.saveMessage(numero, 'user', body);

  // Contacto derivado a Clarck: el bot no se mete.
  if (lead.handoff) {
    console.log(`[handoff] DM de ${numero} (lo atiende Clarck): "${body}"`);
    return;
  }

  // MODO SEGURO (silencio): el cerebro SIGUE leyendo para extraer datos
  // (nombre/edad/distrito/zona) y enriquecer el CRM, pero el bot no envía
  // nada al contacto ni avisa a Clarck. Los ALLOWED_TESTERS sí reciben todo.
  const modoSilencio = SAFE_MODE && !ALLOWED_TESTERS.includes(numero);

  // Posible comprobante de Yape: se procesa aparte del cerebro conversacional
  // (Semana 4). Si la imagen no es un voucher reconocible, sigue el flujo normal.
  if (msg.message.imageMessage && pagos.cerebroActivo()) {
    try {
      const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
      const resultado = await pagos.procesarVoucher(numero, lead.zona, buffer);
      if (resultado) {
        if (resultado.handoff) db.setHandoff(numero, resultado.motivoHandoff || 'Revisar comprobante de pago');
        if (!modoSilencio) {
          try { await sock.sendPresenceUpdate('composing', destino); } catch (_) {}
          await sleep(1000 + Math.random() * 1500);
          await sock.sendMessage(destino, { text: resultado.respuesta });
          db.saveMessage(numero, 'assistant', resultado.respuesta);
          if (resultado.handoff) await notificarControl(sock, `💸 Revisar pago de wa.me/${numero}: ${resultado.motivoHandoff}`);
        } else {
          console.log(`[SAFE_MODE] ${numero}: voucher procesado sin responder.`);
        }
        return; // no pasa al cerebro conversacional — ya se atendió como pago
      }
    } catch (e) { console.error('[pagos] Error procesando imagen:', e.message); }
  }

  if (!brain.cerebroActivo()) {
    console.log(`[brain OFF] DM de ${numero} registrado (falta OPENAI_API_KEY): "${body}"`);
    return;
  }

  const decision = await brain.pensar(lead, db.getHistory(numero), body);
  if (!decision) return; // error de la IA: mejor silencio que una mala respuesta

  // Guardar lo que el cerebro extrajo (nunca pisa datos existentes con null).
  db.updateLead(numero, {
    nombre: decision.nombre,
    edad: decision.edad,
    distrito: decision.distrito,
    zona: decision.zona,
  });

  const actualizado = db.getOrCreateLead(numero);
  const datosCompletos = actualizado.nombre && actualizado.edad && actualizado.distrito;
  if (datosCompletos && lead.estado === 'nuevo') {
    const estado = actualizado.zona === 'otra' ? 'lista_espera' : 'datos_completos';
    db.updateLead(numero, { estado });
    if (!modoSilencio) await notificarControl(
      sock,
      `🆕 Lead completo: ${actualizado.nombre} (${actualizado.edad}) · ${actualizado.distrito} → zona ${actualizado.zona || '?'} · wa.me/${numero}`
    );
  }

  if (decision.handoff) {
    db.setHandoff(numero, decision.handoff_motivo);
    if (!modoSilencio) await notificarControl(
      sock,
      `🔔 Para Clarck — ${decision.handoff_motivo || 'caso especial'}\nContacto: ${actualizado.nombre || 'sin nombre'} · wa.me/${numero}\nÚltimo mensaje: "${body}"\n(El bot dejó de responderle. Para reactivarlo: kipi reactivar ${numero})`
    );
  }

  if (decision.reply && !modoSilencio) {
    // Naturalidad anti-spam: "escribiendo…" + pausa corta antes de responder.
    try { await sock.sendPresenceUpdate('composing', destino); } catch (_) {}
    await sleep(1500 + Math.random() * 2000);
    try {
      const sent = await sock.sendMessage(destino, { text: decision.reply });
      console.log(`[send] OK → ${destino} id=${sent?.key?.id} (${decision.reply.length} chars)`);
    } catch (e) { console.error(`[send] ERROR → ${destino}:`, e?.message); }
    db.saveMessage(numero, 'assistant', decision.reply);
  } else if (modoSilencio) {
    console.log(`[SAFE_MODE] ${numero}: datos extraídos sin responder.`);
  }
}

async function startBot() {
  // Candado anti-sockets-duplicados: si ya hay un arranque en curso, no crear otro.
  // Dos sockets compartiendo la misma sesión de disco corrompen el cifrado ("Bad MAC").
  if (arrancando) { console.log('[reconnect] ya hay un arranque en curso, se ignora este.'); return; }
  arrancando = true;

  // Cerrar el socket anterior (si quedó vivo) antes de crear uno nuevo.
  if (currentSock) {
    try { currentSock.ev.removeAllListeners(); } catch (_) {}
    try { currentSock.ws?.close(); } catch (_) {}
    currentSock = null;
  }

  // Si el arranque falla antes de registrar los handlers, liberar el candado y reintentar
  // (si no, 'arrancando' quedaría trabado en true y el bot no reconectaría nunca).
  let state, saveCreds;
  try {
    fs.mkdirSync(SESSION_DIR, { recursive: true });
    ({ state, saveCreds } = await useMultiFileAuthState(SESSION_DIR));
  } catch (e) {
    console.error('[startBot] Error inicializando sesión:', e.message);
    arrancando = false;
    setTimeout(startBot, 5000);
    return;
  }

  let version;
  try { ({ version } = await fetchLatestBaileysVersion()); } catch (_) { /* usa default */ }

  let sock;
  try {
    sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: process.env.BAILEYS_LOG_LEVEL || 'warn' }), // 'warn': ver errores de sesión/cifrado. Volver a 'silent' cuando esté estable.
      browser: ['Pichangueros', 'Chrome', '1.0.0'],
      syncFullHistory: false,       // no descargar todo el historial (más liviano)
      markOnlineOnConnect: false,   // NO marcar la cuenta "en línea" (el bot es dispositivo secundario:
                                    // así no le roba las notificaciones al celular ni genera tráfico extra)
      keepAliveIntervalMs: 20000,   // ping cada 20s para mantener/detectar la conexión (evita timeouts 408)
    });
  } catch (e) {
    console.error('[startBot] Error creando el socket:', e.message);
    arrancando = false;
    setTimeout(startBot, 5000);
    return;
  }
  currentSock = sock;

  sock.ev.on('creds.update', saveCreds);

  // Vinculación por CÓDIGO (sin QR). Solo si PAIR_NUMBER está seteado y la sesión
  // todavía no está registrada. Clarck escribe el código en su WhatsApp:
  // Dispositivos vinculados → "Vincular con número de teléfono".
  if (PAIR_NUMBER && !state.creds.registered) {
    try {
      await sleep(3000); // dar tiempo a que el socket abra el canal antes de pedirlo
      const code = await sock.requestPairingCode(PAIR_NUMBER);
      const bonito = code?.match(/.{1,4}/g)?.join('-') || code;
      console.log(`[PAIR] Código de vinculación: ${bonito}  → WhatsApp > Dispositivos vinculados > Vincular con número`);
    } catch (e) { console.error('[PAIR] No se pudo generar el código:', e.message); }
  }

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
      arrancando = false; // arranque terminó OK; futuras reconexiones permitidas
      // sock.user.id viene como "51915395067:XX@s.whatsapp.net" — nos quedamos con los dígitos del número.
      linkedNumber = jidToNumero(sock.user?.id) || null;
      console.log(`[READY] ✅ Pichangueros Bot conectado a WhatsApp${linkedNumber ? ` (número ${linkedNumber})` : ''}.`);
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error instanceof Boom
        ? lastDisconnect.error.output?.statusCode
        : undefined;
      const loggedOut = code === DisconnectReason.loggedOut;
      console.warn(`[CLOSE] Conexión cerrada (code=${code}, loggedOut=${loggedOut}).`);
      arrancando = false; // este arranque terminó; permitir que el reconnect de abajo cree el próximo

      if (loggedOut) {
        // Sesión cerrada (desde el celular o desde el panel): limpiar y pedir QR nuevo.
        connectionState = 'disconnected';
        linkedNumber = null;
        try { fs.rmSync(SESSION_DIR, { recursive: true, force: true }); } catch (_) {}
      } else {
        connectionState = 'starting';
      }
      setTimeout(startBot, 3000); // reconectar (el candado 'arrancando' evita duplicados)
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      try {
        if (!msg.message || msg.key.fromMe) continue;
        await manejarMensaje(sock, msg);
      } catch (e) { console.error('[message] Error:', e.message); }
    }
  });

  // Recibos de ENTREGA de lo que enviamos: sirve para confirmar que el mensaje
  // llegó de verdad (no basta con que sendMessage no tire error).
  // status: 2=servidor recibió · 3=entregado al celular · 4=leído.
  sock.ev.on('messages.update', (updates) => {
    for (const u of updates) {
      if (u.update?.status === undefined) continue;
      console.log(`[ack] ${u.key?.remoteJid} status=${u.update.status} (2=servidor 3=entregado 4=leído)`);
    }
  });
}

startBot();

// --- Servidor HTTP (health + página de QR) -----------------------------------
const app = express();

app.get('/', (_req, res) => {
  res.json({
    service: 'pichangueros-bot',
    engine: 'baileys',
    state: connectionState,
    linkedNumber, // número de WhatsApp enlazado (null si aún no conecta)
    safeMode: SAFE_MODE,
    brain: brain.cerebroActivo(),
    leads: db.stats(),
  });
});

// Controlador de conexión que el panel usa para su vista "Conexión":
// leer estado/número/QR y poder desconectar (logout → limpia sesión → nuevo QR).
const conexion = {
  estado: () => connectionState,
  numero: () => linkedNumber,
  qr: () => lastQrDataUrl,
  async desconectar() {
    if (!currentSock) return false;
    // logout() dispara connection.close con loggedOut=true → el handler de arriba
    // borra la sesión y reconecta, generando un QR nuevo para (re)enlazar.
    try { await currentSock.logout(); } catch (e) { console.error('[conexion] logout:', e.message); }
    linkedNumber = null;
    return true;
  },
};

// Panel de control (src/panel.js): /admin/leads?key=ADMIN_KEY (+ CSV export)
require('./src/panel').registrarPanel(app, db, conexion);

// Espejo a Google Sheet (backup + visibilidad): al arrancar + cada 6 h.
sheet.programarSync(db);

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
