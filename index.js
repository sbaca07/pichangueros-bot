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
 *      y avisa por WhatsApp al número de control (Ajustes → Avisos).
 *   5. Pagos por Yape (src/pagos.js): si el mensaje trae una imagen, se intenta
 *      leer como voucher (monto/titular/n° de operación) antes de pasar al
 *      cerebro conversacional. Anti-reenvío + valida el monto contra el precio
 *      de la zona del contacto; lo que no calza queda "por revisar" en el CRM.
 *
 * MODO SEGURO: el bot solo RESPONDE a los números de prueba. Al resto los
 * registra Y el cerebro les EXTRAE los datos (nombre/edad/zona) para enriquecer
 * el CRM, pero sin enviarles nada. Se enciende y se apaga desde el panel
 * (Ajustes → "Encender el bot"); SAFE_MODE en el entorno es solo el valor
 * inicial, hasta que alguien toque el interruptor.
 *
 * REGLA DEL SILENCIO: lo que es para el JUGADOR se calla; lo que es para
 * CLARCK sale siempre. Un handoff, un pago por revisar o alguien pidiendo cupo
 * son cosas que él tiene que saber aunque el bot esté mudo — si no, el modo
 * seguro deja de ser "no hablamos todavía" y pasa a ser "no nos enteramos".
 *
 * Comandos del número de control, por DM al bot:
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
const atajos = require('./src/atajos');
const pagos = require('./src/pagos');
const sheet = require('./src/sheetsync');
const backup = require('./src/backup');
const meta = require('./src/meta');
const ycloud = require('./src/ycloud');

const PORT = process.env.PORT || 10000;
// Transporte de mensajes: 'baileys' (dispositivo vinculado, ruta no oficial) o
// 'meta' (Cloud API oficial en coexistencia — decisión 2026-07-15 tras los
// bloqueos; ver investigacion/plan-canal-oficial.md). Mismo cerebro/CRM/panel.
const TRANSPORTE = (process.env.TRANSPORTE || 'baileys').toLowerCase();
// Los dos transportes oficiales exponen la misma interfaz (activo /
// registrarWebhook / sockAdapter), así que el resto del archivo no necesita
// saber cuál está puesto: pregunta por `oficial`.
const oficial = TRANSPORTE === 'meta' ? meta : TRANSPORTE === 'ycloud' ? ycloud : null;
/** Número del negocio cuando corre por canal oficial (ahí no hay "sesión" que lo diga). */
const numeroOficial = () =>
  (process.env[TRANSPORTE === 'ycloud' ? 'YCLOUD_NUMERO' : 'META_NUMERO'] || '').replace(/\D/g, '') || null;
const AUTH_PATH = process.env.WWEBJS_AUTH_PATH || '.wwebjs_auth';
const SESSION_DIR = path.join(AUTH_PATH, 'baileys');
/**
 * LOS TRES INTERRUPTORES SE LEEN POR MENSAJE, NO AL ARRANCAR (17/08).
 *
 * Eran constantes de módulo alimentadas por env vars: cambiar cualquiera de las
 * tres exigía entrar NOSOTROS a Render y redesplegar, o sea que el dueño del
 * negocio no podía encender ni apagar su propio bot. Ahora viven en la BD
 * (db.modoSeguro / db.numerosDePrueba / db.numeroAvisos) y la env var es solo
 * el valor inicial: mientras nadie toque el panel, se comportan EXACTAMENTE
 * como antes — este deploy no cambia nada por su cuenta.
 */
const enModoSeguro = () => db.modoSeguro();
const esTester = (numero) => db.numerosDePrueba().includes(numero);
const numeroControl = () => db.numeroAvisos();
const TEST_TRIGGER = (process.env.TEST_TRIGGER || 'ping kipi').toLowerCase();
// Pausa antes de responder. Nació como "naturalidad anti-spam" de Baileys, pero
// por el canal oficial de Meta no hay heurística de baneo que esquivar: lo único
// que hacía era regalarle 1.5–3.5 s a CADA respuesta (13/08, latencias medidas
// con Clarck: 7 a 12 s). Queda en 0; sigue configurable por si se vuelve a Baileys.
const RESPUESTA_DELAY_MS = Number(process.env.RESPUESTA_DELAY_MS || 0);
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
// never filled" sin re-vincular. Es de UN SOLO disparo aunque el flag quede
// puesto en Render: tras un borrado completo se escribe un marcador y los
// siguientes arranques lo saltan (al quitar el flag se limpia el marcador,
// así un futuro RESET_SESSIONS_ONLY=true vuelve a correr).
const RESET_MARKER = path.join(SESSION_DIR, '.reset-sessions-done');
if ((process.env.RESET_SESSIONS_ONLY || 'false') === 'true') {
  try {
    if (!fs.existsSync(SESSION_DIR)) {
      console.warn(`[RESET] RESET_SESSIONS_ONLY=true pero ${SESSION_DIR} no existe — nada que borrar (¿WWEBJS_AUTH_PATH mal seteado o disco sin montar?).`);
    } else if (fs.existsSync(RESET_MARKER)) {
      console.log('[RESET] RESET_SESSIONS_ONLY sigue en true pero el borrado ya corrió (marcador presente) — no se repite. Quitar el flag en Render.');
    } else {
      let n = 0, fallas = 0;
      for (const f of fs.readdirSync(SESSION_DIR)) {
        if (/^(session-|sender-key-)/.test(f)) {
          try {
            fs.rmSync(path.join(SESSION_DIR, f), { recursive: true, force: true });
            n++;
          } catch (e) {
            fallas++;
            console.error(`[RESET] No se pudo borrar ${f}:`, e.message);
          }
        }
      }
      if (fallas === 0) {
        fs.writeFileSync(RESET_MARKER, new Date().toISOString());
        console.log(`[RESET] ${n} archivos de sesión borrados (RESET_SESSIONS_ONLY) — se mantiene el enlace; sesiones se reconstruyen solas.`);
      } else {
        console.error(`[RESET] Borrado INCOMPLETO: ${n} borrados, ${fallas} fallaron — NO se marca como hecho; se reintenta en el próximo arranque.`);
      }
    }
  } catch (e) { console.error('[RESET] Error borrando sesiones:', e.message); }
} else {
  try { fs.rmSync(RESET_MARKER, { force: true }); } catch (_) {}
}

const { desenvolver, extraerTexto, jidToNumero, numeroDe } = require('./src/mensajes');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Ids de mensajes que ENVIÓ este bot: sirven para distinguir sus mensajes de
// los que Clarck escribe a mano desde el celular (ambos llegan como fromMe).
const idsEnviadosPorBot = new Set();
function marcarEnviado(id) {
  if (!id) return;
  idsEnviadosPorBot.add(id);
  if (idsEnviadosPorBot.size > 800) {
    for (const viejo of idsEnviadosPorBot) { idsEnviadosPorBot.delete(viejo); if (idsEnviadosPorBot.size <= 400) break; }
  }
}

/** Único punto de salida de texto: envía y marca el id como "del bot". */
async function enviarTexto(sock, jid, texto) {
  const sent = await sock.sendMessage(jid, { text: texto });
  marcarEnviado(sent?.key?.id);
  return sent;
}

/**
 * Aviso al número de control (Clarck). Si se pasa `asunto`, además sale por correo.
 *
 * Por qué el correo: Cloud API solo deja mandar mensajes libres dentro de las
 * 24 h desde que el destinatario escribió al número. Pasado ese plazo Meta lo
 * rechaza con 131047 — y el rechazo NO llega como excepción acá: la API
 * responde 200 con su wamid y el fallo aparece después, por webhook
 * (`meta.js`, statuses[].status='failed'). Es decir: desde este código un aviso
 * perdido es indistinguible de uno entregado, así que no hay forma de
 * reintentar a tiempo. Pasó el 13/08 con un handoff. Por eso lo CRÍTICO
 * (handoffs y pagos por revisar) sale por los dos canales, igual que la alerta
 * de salud de la cuenta: WhatsApp es best-effort, el correo es el que llega.
 */
async function notificarControl(sock, texto, asunto = null) {
  // Primero el correo: no depende del número de avisos ni de la ventana de 24 h.
  if (asunto) Promise.resolve(backup.avisar(asunto, texto)).catch(() => {});
  const control = numeroControl();
  if (!control) return;
  try {
    await enviarTexto(sock, `${control}@s.whatsapp.net`, texto);
  } catch (e) { console.error('[notify] No se pudo avisar al número de control:', e.message); }
}

/** Comandos administrativos del número de control. Devuelve true si el mensaje era un comando. */
async function comandoControl(sock, from, body) {
  const texto = body.toLowerCase();
  if (texto === 'kipi estado') {
    const s = db.stats();
    const zonas = s.porZona.map((z) => `${z.zona}: ${z.n}`).join(', ') || 'sin clasificar aún';
    await enviarTexto(sock, from,
      `📊 Pichangueros Bot\nConexión: ${connectionState} · Modo seguro: ${enModoSeguro() ? 'ON' : 'OFF'} · Cerebro: ${brain.cerebroActivo() ? 'ON' : 'OFF (falta OPENAI_API_KEY)'}\nLeads: ${s.leads} (${s.completos} con datos) · Por zona: ${zonas}\nEn handoff: ${s.enHandoff}`);
    return true;
  }
  const reactivar = texto.match(/^kipi reactivar (\+?[\d\s-]+)$/);
  if (reactivar) {
    const numero = reactivar[1].replace(/\D/g, '');
    db.clearHandoff(numero);
    await enviarTexto(sock, from, `✅ Listo: el bot vuelve a atender al ${numero}.`);
    return true;
  }
  return false;
}

const avisosHandoff = new Map();   // numero → cuándo se re-avisó a control por última vez
const disculpasBrain = new Map();  // numero → cuándo se le mandó la disculpa por falla de IA
const avisosCupo = new Map();      // numero → cuándo se avisó "pidió cupo con el bot apagado"

// Cola por contacto: los mensajes de un mismo número se atienden EN ORDEN.
// Sin esto, dos mensajes rápidos del mismo jugador se procesan en paralelo y
// el bot puede mandar respuestas cruzadas (p.ej. doble bienvenida).
const colasPorNumero = new Map();
function encolarPorNumero(numero, tarea) {
  const anterior = colasPorNumero.get(numero) || Promise.resolve();
  const siguiente = anterior
    .then(tarea)
    .catch((e) => console.error('[message] Error:', e.message))
    .finally(() => { if (colasPorNumero.get(numero) === siguiente) colasPorNumero.delete(numero); });
  colasPorNumero.set(numero, siguiente);
  return siguiente;
}

// Ráfagas: la gente no escribe un párrafo, escribe "hola" / "quiero jugar" /
// "soy de Breña" en mensajes sueltos. El bot contestaba UNO POR UNO, así que
// devolvía tres bloques de texto seguidos — exactamente lo que Clarck reportó
// como "habla mucho" (13/08: 3 respuestas, 848 caracteres, en 20 segundos).
// Ahora se espera a que termine de escribir y se responde UNA sola vez con
// todo junto. De paso son 3 llamadas al modelo que pasan a ser 1.
const DEBOUNCE_MS = Number(process.env.DEBOUNCE_MS || 2500);
const rafagas = new Map(); // numero → { textos, ultimo, sock, timer }

/**
 * Solo agrupamos texto plano. Una imagen puede ser un voucher (se procesa con
 * su propio mensaje y su descargador), y los adjuntos se vuelven marcadores
 * "[el jugador envió ...]" que no tiene sentido concatenar.
 */
function esSoloTexto(msg) {
  const m = desenvolver(msg.message || {});
  if (!(m.conversation || m.extendedTextMessage?.text)) return false;
  return !(m.imageMessage || m.audioMessage || m.videoMessage || m.documentMessage
    || m.stickerMessage || m.locationMessage || m.liveLocationMessage
    || m.contactMessage || m.contactsArrayMessage);
}

/** Cierra la ráfaga pendiente de un número y la manda a procesar como un solo mensaje. */
function soltarRafaga(numero) {
  const r = rafagas.get(numero);
  if (!r) return;
  clearTimeout(r.timer);
  rafagas.delete(numero);
  if (r.textos.length > 1) {
    // Se responde sobre el ÚLTIMO mensaje (su wamid es el que Meta acepta para
    // el visto azul y el "escribiendo…"), pero con el texto de toda la ráfaga.
    r.ultimo._textoAgrupado = r.textos.join('\n');
    console.log(`[rafaga] ${numero}: ${r.textos.length} mensajes agrupados en una sola respuesta.`);
  }
  encolarPorNumero(numero, () => manejarMensaje(r.sock, r.ultimo));
}

/**
 * Puerta de entrada de todo mensaje entrante: agrupa ráfagas de texto y deja
 * pasar de largo lo que debe atenderse ya (adjuntos, comandos de control, ping).
 */
function recibirMensaje(sock, msg) {
  const numero = numeroDe(msg);
  const texto = extraerTexto(msg);
  const instantaneo = !numero || !texto || !esSoloTexto(msg)
    || numero === numeroControl() || texto.toLowerCase() === TEST_TRIGGER;

  if (instantaneo) {
    soltarRafaga(numero); // lo que estaba pendiente va primero: la cola conserva el orden
    encolarPorNumero(numero, () => manejarMensaje(sock, msg));
    return;
  }

  const r = rafagas.get(numero) || { textos: [], ultimo: msg, sock, timer: null };
  clearTimeout(r.timer);
  r.textos.push(texto);
  r.ultimo = msg;
  r.sock = sock;
  r.timer = setTimeout(() => soltarRafaga(numero), DEBOUNCE_MS);
  rafagas.set(numero, r);
}

/**
 * Clarck contestó a mano desde su celular (fromMe que NO envió este bot):
 * se guarda como respuesta del negocio para que el CRM muestre la conversación
 * completa y el cerebro no repita lo que Clarck ya dijo. Solo si el contacto
 * ya existe como lead — los chats personales de Clarck no entran al CRM.
 */
// Contactos que Clarck acaba de atender a mano: el bot NO habla encima de él.
// Sin esto, cliente y bot reciben dos respuestas a la vez (pasó el 2026-08-11
// con la bienvenida: Clarck la pegó a mano y el bot la mandó también).
const MANUAL_MS = 5 * 60 * 1000;
const atendidoAMano = new Map(); // numero → timestamp de la última respuesta manual
const clarckAtendiendo = (numero) => Date.now() - (atendidoAMano.get(numero) || 0) < MANUAL_MS;

function registrarRespuestaManual(msg) {
  const from = msg.key.remoteJid || '';
  if (from.endsWith('@g.us') || from === 'status@broadcast') return;
  if (idsEnviadosPorBot.has(msg.key.id)) return; // lo mandó este bot, ya está guardado
  const texto = extraerTexto(msg);
  if (!texto || texto.startsWith('[')) return;   // solo texto real, no adjuntos
  const numero = numeroDe(msg);
  if (!numero || numero === numeroControl()) return;
  if (!db.getLead(numero)) return;
  db.saveMessage(numero, 'assistant', texto);
  atendidoAMano.set(numero, Date.now());
  if (atendidoAMano.size > 1000) atendidoAMano.delete(atendidoAMano.keys().next().value);
  console.log(`[manual] Clarck respondió a mano a ${numero} — el bot se calla ${MANUAL_MS / 60000} min con él.`);
}

async function manejarMensaje(sock, msg) {
  const from = msg.key.remoteJid;
  if (!from || from.endsWith('@g.us') || from === 'status@broadcast') return; // grupos: Semana 5

  // _textoAgrupado: varias líneas si el contacto escribió en ráfaga (ver recibirMensaje).
  const body = msg._textoAgrupado || extraerTexto(msg);
  if (!body) return;
  const numero = numeroDe(msg); // resuelve LID → número real cuando se puede

  // Sin número no hay contacto. Seguir de largo creaba un lead de clave vacía
  // donde se apilaban las conversaciones de TODOS los que llegaran así (pasó
  // con el transporte de Meta el 11 y 12 de agosto). Vale más perder el mensaje
  // que mezclar gente distinta en un mismo registro del CRM.
  if (!numero) {
    console.error(`[bot] Mensaje sin número identificable (jid=${from}) — ignorado para no mezclar contactos.`);
    return;
  }

  // A DÓNDE responder: SIEMPRE al mismo JID por el que llegó el mensaje (from),
  // sea un número normal o un LID anónimo (xxx@lid). Baileys >=6.7.10 mapea la
  // sesión de cifrado del LID internamente. Reescribir el destino a mano
  // (LID → número real vía senderPn) rompía la entrega: el mensaje se cifraba
  // sin error pero nunca le llegaba al contacto.
  const pnJid = msg.key.senderPn || msg.key.participantPn || null;
  const destino = from;
  if (esTester(numero)) {
    console.log(`[dbg tester] numero=${numero} remoteJid=${from} senderPn=${pnJid || '-'} → destino=${destino}`);
  }

  // Comando de prueba (sigue vivo como chequeo rápido de conexión)
  if (body.toLowerCase() === TEST_TRIGGER) {
    try {
      const sent = await enviarTexto(sock, destino, '✅ Pichangueros Bot conectado y funcionando. (modo prueba)');
      console.log(`[test-send] OK → ${destino} id=${sent?.key?.id}`);
    } catch (e) { console.error(`[test-send] ERROR → ${destino}:`, e?.message); }
    return;
  }

  // Comandos del número de control
  if (numero === numeroControl() && (await comandoControl(sock, from, body))) return;

  // Todo contacto queda registrado, responda el bot o no (captura de leads).
  const lead = db.getOrCreateLead(numero);
  db.saveMessage(numero, 'user', body);

  // MODO SEGURO (silencio): el cerebro SIGUE leyendo para extraer datos
  // (nombre/edad/distrito/zona) y enriquecer el CRM, pero el bot no envía
  // nada al contacto ni avisa a Clarck. Los números de prueba sí reciben todo.
  // También calla si Clarck acaba de responderle a mano a este contacto: dos
  // respuestas simultáneas confunden al jugador y hacen quedar mal al sistema.
  const enManual = clarckAtendiendo(numero);
  if (enManual) console.log(`[manual] ${numero}: Clarck lo está atendiendo — el bot registra pero no responde.`);
  const modoSilencio = (enModoSeguro() && !esTester(numero)) || enManual;

  // Contacto derivado a Clarck: el bot no se mete — pero si el contacto sigue
  // escribiendo, se le re-avisa al número de control (máx. 1 vez por hora por
  // contacto) para que nadie quede hablándole al vacío si Clarck se olvidó.
  if (lead.handoff) {
    console.log(`[handoff] DM de ${numero} (lo atiende Clarck): "${body}"`);
    const ultimo = avisosHandoff.get(numero) || 0;
    // El re-aviso sale TAMBIÉN en modo silencio: es para Clarck, no para el
    // jugador. Estaba dentro del `!modoSilencio`, así que con el bot apagado —
    // que es justo cuando Clarck atiende todo a mano— nadie se enteraba de que
    // un derivado seguía escribiendo. Sí se respeta el "atendiendo a mano": ahí
    // Clarck está leyendo el chat en ese momento, avisarle sería duplicado.
    if (!enManual && Date.now() - ultimo > 60 * 60 * 1000) {
      avisosHandoff.set(numero, Date.now());
      await notificarControl(sock, `✋ ${lead.nombre || 'Contacto'} (wa.me/${numero}) está derivado a Clarck y sigue escribiendo: "${body.slice(0, 120)}"\nPara que el bot lo retome: kipi reactivar ${numero}`);
    }
    return;
  }

  // Posible comprobante de Yape: se procesa aparte del cerebro conversacional
  // (Semana 4). Se desenvuelve el mensaje porque los vouchers suelen llegar
  // como foto "ver una sola vez". Si no es un voucher reconocible, sigue el
  // flujo normal.
  if (desenvolver(msg.message).imageMessage && pagos.cerebroActivo()) {
    try {
      // Transporte meta: la imagen trae su propio descargador (Graph API).
      const buffer = msg._descargar
        ? await msg._descargar()
        : await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
      const resultado = await pagos.procesarVoucher(numero, lead.zona, buffer);
      if (resultado) {
        if (resultado.handoff) db.setHandoff(numero, resultado.motivoHandoff || 'Revisar comprobante de pago');
        // Un pago confirmado que no se pudo asignar solo se avisa SIEMPRE, aun
        // en modo silencio: el aviso es para Clarck, no para el jugador, y la
        // plata ya entró. Justo el caso de Anthony el 15/08 — con SAFE_MODE
        // encendido nadie se enteró de que el pago se fue al partido de otro día.
        if (resultado.alerta) await notificarControl(sock, `${resultado.alerta}\nwa.me/${numero}`, 'Pago sin partido asignado');
        // Un pago POR REVISAR también sale siempre: hay plata adentro y el cupo
        // queda en el limbo hasta que Clarck mire. Vivía dentro del
        // `!modoSilencio` — el mismo agujero que el aviso de arriba, que ya se
        // había arreglado para el pago sin asignar y no para éste.
        if (resultado.handoff) {
          await notificarControl(sock, `💸 Revisar pago de wa.me/${numero}: ${resultado.motivoHandoff}`, 'Pago por revisar');
        }
        if (!modoSilencio) {
          try { await sock.sendPresenceUpdate('composing', destino); } catch (_) {}
          if (RESPUESTA_DELAY_MS) await sleep(RESPUESTA_DELAY_MS);
          await enviarTexto(sock, destino, resultado.respuesta);
          db.saveMessage(numero, 'assistant', resultado.respuesta);
        } else {
          console.log(`[SAFE_MODE] ${numero}: voucher procesado sin responder.`);
        }
        return; // no pasa al cerebro conversacional — ya se atendió como pago
      }
    } catch (e) { console.error('[pagos] Error procesando imagen:', e.message); }
  }

  // Capa rápida (el "embudo"): mensajes inconfundibles (saludo de un nuevo,
  // precios, horarios, parrilla) se responden con plantillas desde la BD —
  // sin IA, en milisegundos, y siguen vivos aunque OpenAI esté caído.
  const rapida = atajos.responder(lead, body);
  if (rapida) {
    console.log(`[atajo] ${numero} → ${rapida.atajo} (sin IA)`);
    if (!modoSilencio) {
      try { await sock.sendPresenceUpdate('composing', destino); } catch (_) {}
      if (RESPUESTA_DELAY_MS) await sleep(RESPUESTA_DELAY_MS);
      try {
        await enviarTexto(sock, destino, rapida.respuesta);
        db.saveMessage(numero, 'assistant', rapida.respuesta);
      } catch (e) { console.error(`[send] ERROR atajo → ${destino}:`, e?.message); }
    }
    return;
  }

  if (!brain.cerebroActivo()) {
    console.log(`[brain OFF] DM de ${numero} registrado (falta OPENAI_API_KEY): "${body}"`);
    return;
  }

  const decision = await brain.pensar(lead, db.getHistory(numero), body);
  if (!decision) {
    // La IA falló (caída/cuota/timeout). Antes: silencio total. Ahora: una
    // disculpa corta para no dejar la conversación en el vacío (máx. 1 cada
    // 10 min por contacto, para no repetirla si la falla dura).
    const ultima = disculpasBrain.get(numero) || 0;
    if (!modoSilencio && Date.now() - ultima > 10 * 60 * 1000) {
      disculpasBrain.set(numero, Date.now());
      const disculpa = 'Uy, se me cruzaron los cables un segundo 🙈 ¿Me lo repites porfa? Si es algo urgente, Clarck te escribe en un momento.';
      try {
        await enviarTexto(sock, destino, disculpa);
        db.saveMessage(numero, 'assistant', disculpa);
      } catch (e) { console.error(`[send] ERROR fallback → ${destino}:`, e?.message); }
    }
    return;
  }

  // Guardar lo que el cerebro extrajo (nunca pisa datos existentes con null).
  db.updateLead(numero, {
    nombre: decision.nombre,
    edad: decision.edad,
    distrito: decision.distrito,
    zona: decision.zona,
  });

  const actualizado = db.getOrCreateLead(numero);
  const datosCompletos = actualizado.nombre && actualizado.edad && actualizado.distrito;
  // Acá se escribía la etapa ('datos_completos' / 'lista_espera'), con dos
  // guardias encima para que completar los datos no degradara a un cliente.
  // Desde el 16/08 no se escribe nada: "tiene datos" se lee de las COLUMNAS
  // (nombre/edad/distrito), que es donde el dato vive de verdad, y "es de otra
  // zona" se lee de `zona`. Un estado derivado no necesita disparador ni
  // guardias — solo se queda el log, que es lo único que aportaba.
  if (datosCompletos && !(lead.nombre && lead.edad && lead.distrito)) {
    // Sin aviso a Clarck: un lead nuevo NO le pide hacer nada (el bot ya lo
    // atendió) y con 50-100 mensajes/día su WhatsApp se volvía spam. Vive en
    // el panel, que es donde se revisa. A WhatsApp solo va lo ACCIONABLE:
    // handoffs, pagos por revisar, listas de espera y salud de la cuenta.
    console.log(`[lead] Completo: ${actualizado.nombre} (${actualizado.edad}) · ${actualizado.distrito} → zona ${actualizado.zona || '?'}`);
  }

  if (decision.handoff) {
    db.setHandoff(numero, decision.handoff_motivo);
    // El WhatsApp sale SIEMPRE, también en modo silencio: el aviso es para
    // Clarck, no para el jugador, y antes vivía dentro del !modoSilencio — el
    // bot dejaba de atender a alguien y nadie se enteraba. Así se juntaron 105
    // contactos mudos.
    //
    // Por correo NO va uno por uno: se marcan ~41 handoffs por día y 41 correos
    // diarios no se leen. Van juntos en el resumen de backup.js, tres veces al
    // día. Lo que sí sale al correo al instante es lo que tiene plata adentro
    // (pagos por revisar, pagos sin asignar), que son pocos.
    await notificarControl(
      sock,
      `🔔 Para Clarck — ${decision.handoff_motivo || 'caso especial'}\nContacto: ${actualizado.nombre || 'sin nombre'} · wa.me/${numero}\nÚltimo mensaje: "${body}"\n(El bot dejó de responderle. Para reactivarlo: kipi reactivar ${numero})`
    );
  }

  /**
   * EL PEDIDO DE CUPO NO SE PIERDE, NI SIQUIERA EN SILENCIO.
   *
   * Reservar sigue sin correr con el bot mudo, y por una buena razón: el
   * jugador no recibe la respuesta, así que sería un cupo que ocupa lugar en la
   * lista y que nadie sabe que existe. Pero antes el pedido moría ahí, sin
   * dejar rastro: con el modo seguro encendido NADIE podía reservar y ningún
   * pago llegaba con reserva previa (por eso los Yapes caían sueltos y había
   * que adivinar a qué partido iban).
   *
   * Se aplica la regla de la casa: si el aviso es para Clarck, sale siempre. Él
   * lo anota desde el panel en dos toques y le contesta al jugador — que es
   * exactamente lo que el modo seguro dice que va a pasar.
   */
  if (decision.inscribir_partido && modoSilencio && !enManual) {
    const p = db.getPartido(decision.inscribir_partido);
    const ultimo = avisosCupo.get(numero) || 0;
    if (p && Date.now() - ultimo > 60 * 60 * 1000) {
      avisosCupo.set(numero, Date.now());
      const libres = Math.max(0, p.cupo - db.inscripcionesDe(p.id).filter((i) => ['reservado', 'pagado'].includes(i.estado)).length);
      await notificarControl(
        sock,
        `🙋 ${actualizado.nombre || `+${numero}`} pidió cupo para el ${db.fechaBonita(p.fecha)}${p.hora ? ` ${p.hora}` : ''} en ${db.nombreDeZona(p.zona)} (${libres} libre${libres === 1 ? '' : 's'}).\n`
        + `El bot está APAGADO, así que NO lo anotó ni le contestó: anótalo tú desde el panel y escríbele.\nwa.me/${numero}`,
        'Alguien pidió cupo con el bot apagado',
      );
    }
  }

  // El jugador pidió cupo en un partido abierto: se reserva de verdad (el
  // cerebro solo decide, la BD manda). Si entre que la IA leyó los cupos y
  // ahora el partido se llenó, la reserva cae a lista de espera y se le avisa.
  if (decision.inscribir_partido && !modoSilencio) {
    const { inscripcion, resultado } = db.inscribir(decision.inscribir_partido, numero, { nombre: actualizado.nombre });
    if (!inscripcion) {
      // El partido se cerró/canceló entre que la IA leyó los cupos y este
      // write (o el ID no existe): NUNCA mandar el reply que promete la
      // reserva — el jugador pagaría por un cupo que no está en ninguna lista.
      console.warn(`[partido] Inscripción rechazada: partido ${decision.inscribir_partido} no está abierto (${numero}).`);
      decision.reply = db.partidosAbiertos(null, { vigentes: true }).length
        ? 'Uy, esa pichanga ya no tiene inscripción abierta 🙈 Pregúntame "¿qué pichangas hay?" y te paso las que sí están disponibles ⚽'
        : 'Uy, esa pichanga ya no tiene inscripción abierta 🙈 Apenas se abra la próxima convocatoria te avisamos por acá ⚽';
    }
    if (inscripcion && resultado === 'espera' && decision.reply && !/lista de espera/i.test(decision.reply)) {
      decision.reply += '\n\n⚠️ Ojo: el cupo se acaba de llenar, así que te dejé en la lista de espera — si se libera un lugar te avisamos al toque 🙏';
    }
    // El cupo guardado tiene reloj (ver db.reservaMinutos) y eso el jugador
    // TIENE que saberlo antes, no cuando se lo sacaron. Se pega acá y no se
    // deja librado al modelo: si la respuesta no nombra el Yape, el jugador se
    // queda creyendo que ya está adentro y el lugar se le libera "sin razón".
    if (inscripcion && resultado === 'reservado' && decision.reply && !/yape/i.test(decision.reply)) {
      const min = db.reservaMinutos();
      decision.reply += min > 0
        ? `\n\n⏳ Te guardo el cupo ${min} min: mándame tu Yape para que quede confirmado en la lista 🙏`
        : '\n\n⏳ Mándame tu Yape para que el cupo quede confirmado en la lista 🙏';
    }
    if (inscripcion && resultado !== 'ya_inscrito') {
      const p = db.getPartido(inscripcion.partido_id);
      console.log(`[partido] ${numero} → partido ${inscripcion.partido_id} (${resultado}).`);
      // Si el jugador YA había mandado su Yape (pago suelto sin partido), la
      // inscripción nace pagada y el pago deja de estar huérfano — es la otra
      // mitad del "¿para qué pichanga es tu pago?" de pagos.js.
      const suelto = resultado === 'reservado' ? db.pagoSueltoDe(numero) : null;
      if (suelto) {
        db.pagarInscripcion(inscripcion.id, suelto.id);
        // Los cupos extra del Yape (amigos) entran al MISMO partido — igual que
        // vincularPago. Sin esto, un pago de 3 cupos absorbía solo 1 y los
        // invitados pagados desaparecían (hallazgo del code review 2026-08-11).
        const extras = Math.max(0, (suelto.cupos || 1) - 1);
        for (let i = 0; i < extras; i++) {
          db.inscribir(inscripcion.partido_id, null, { nombre: `Invitado de +${numero}`, estado: 'pagado', pagoId: suelto.id });
        }
        if (decision.reply) decision.reply += `\n✅ Y tu Yape de S/${suelto.monto}${extras ? ` (${suelto.cupos} cupos)` : ''} ya lo tenía registrado — quedaste CONFIRMADO${extras ? ` junto a tus ${extras} invitado${extras === 1 ? '' : 's'}` : ''} en la lista.`;
        console.log(`[partido] Pago suelto #${suelto.id} (${suelto.cupos || 1} cupos) vinculado a la inscripción de ${numero}.`);
      }
      // Una reserva tampoco pide acción de Clarck (la lista del panel se
      // actualiza sola). Solo si cae en ESPERA se le avisa, porque ahí sí
      // puede querer mover algo o abrir otro turno.
      if (resultado === 'espera') await notificarControl(
        sock,
        `⏳ ${actualizado.nombre || `+${numero}`} quedó en LISTA DE ESPERA del partido del ${p ? db.fechaBonita(p.fecha) : '?'}${p?.hora ? ` ${p.hora}` : ''} (${p?.zona}) — está lleno · wa.me/${numero}`
      );
    }
  }

  if (decision.reply && !modoSilencio) {
    // "Escribiendo…" real (visto azul + typing indicator de Cloud API).
    try { await sock.sendPresenceUpdate('composing', destino); } catch (_) {}
    if (RESPUESTA_DELAY_MS) await sleep(RESPUESTA_DELAY_MS);
    try {
      const sent = await enviarTexto(sock, destino, decision.reply);
      console.log(`[send] OK → ${destino} id=${sent?.key?.id} (${decision.reply.length} chars)`);
    } catch (e) { console.error(`[send] ERROR → ${destino}:`, e?.message); }
    db.saveMessage(numero, 'assistant', decision.reply);

    // Si la respuesta incluyó el link del grupo de su zona, se anota la FECHA
    // en que se le mandó.
    //
    // Antes esto lo movía de escalón ('invitado_grupo') y por eso necesitaba
    // tres guardias: recibir el link es un paso adelante para un desconocido y
    // uno ATRÁS para un cliente que ya paga, así que la misma línea que
    // registraba el hecho podía degradar a un Jugador. Guardar el hecho a
    // secas no tiene ese problema: no compite con nada.
    const linkZona = actualizado.zona && actualizado.zona !== 'otra'
      ? db.getNegocio().zonas[actualizado.zona]?.groupLink : null;
    if (linkZona && decision.reply.includes(linkZona)) {
      if (db.marcarGrupoEnviado(numero)) console.log(`[grupo] ${numero} recibió el link de ${actualizado.zona}.`);
    } else if (!linkZona && actualizado.zona && actualizado.zona !== 'otra') {
      // Sin link cargado para su zona, sumarlo al grupo es trabajo a mano. El
      // pendiente por contacto se retiró junto con "próxima acción": el bloque
      // "Para que el bot trabaje solo" del Resumen ya avisa que la zona no
      // tiene link, que es la causa — y una fila por zona se resuelve, doscientas
      // por contacto no.
      console.log(`[grupo] ${numero} espera el link de ${actualizado.zona} (la zona no lo tiene cargado).`);
    }
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
        if (!msg.message) continue;
        if (msg.key.fromMe) { registrarRespuestaManual(msg); continue; }
        recibirMensaje(sock, msg);
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

if (oficial) {
  if (oficial.activo()) {
    connectionState = 'ready'; // el canal oficial no tiene "sesión": si hay credenciales, está listo
    console.log(`[${TRANSPORTE}] Transporte OFICIAL activo (Cloud API, coexistencia) — Baileys apagado.`);
  } else {
    connectionState = 'disconnected';
    const motivo = typeof oficial.motivoInactivo === 'function' ? oficial.motivoInactivo() : '';
    console.error(
      `[${TRANSPORTE}] TRANSPORTE=${TRANSPORTE} pero las credenciales del proveedor no sirven`
      + `${motivo ? `: ${motivo}` : '.'}`
      + ' — el bot NO recibe mensajes y Baileys queda apagado.'
    );
  }
} else {
  startBot();
}

// --- Servidor HTTP (health + página de QR) -----------------------------------
const app = express();
// El webhook de Meta llega como JSON. Guardamos el cuerpo CRUDO porque la firma
// X-Hub-Signature-256 se calcula sobre los bytes exactos que mandó Meta: si se
// re-serializa el objeto ya parseado, el HMAC no coincide.
// limit 2mb: algunos webhooks de Meta (history sync, lotes de statuses) superan
// el default de 100kb de Express y se descartaban con PayloadTooLargeError.
app.use(express.json({ limit: '2mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));

// Sin credenciales todavía: se expone SOLO el handshake de verificación, para
// poder dar de alta el webhook en el panel del proveedor antes de tener el
// token. La ingesta (POST) no se registra, así que no entra nada.
if (oficial && !oficial.activo() && typeof oficial.registrarVerificacion === 'function') {
  if (oficial.registrarVerificacion(app)) {
    console.log(`[${TRANSPORTE}] Solo handshake de verificación activo (GET /webhook/${TRANSPORTE}). La ingesta llega con las credenciales.`);
  }
}

if (oficial && oficial.activo()) {
  oficial.registrarWebhook(app, {
    // Los mensajes entrantes pasan por la MISMA cola por contacto que Baileys.
    onMensaje: (sockLike, msg) => recibirMensaje(sockLike, msg),
    // Echoes de coexistencia = respuestas a mano de Clarck desde su app.
    onEcho: (msg) => registrarRespuestaManual(msg),
    // Salud de la cuenta: con el historial de sanciones, es la alerta más
    // temprana que tenemos. Sale por LOS DOS canales a propósito — el WhatsApp
    // es best-effort (Cloud API lo rechaza con 131047 fuera de la ventana de
    // 24 h, y si la cuenta quedó deshabilitada falla siempre), el correo es el
    // que de verdad llega.
    onAlerta: (aviso) => {
      notificarControl(oficial.sockAdapter, `[Pichangueros] ${aviso}`);
      backup.avisar('Salud de la cuenta de WhatsApp', aviso);
    },
  });
}

app.get('/', (_req, res) => {
  res.json({
    service: 'pichangueros-bot',
    engine: TRANSPORTE === 'meta' ? 'meta-cloud-api' : TRANSPORTE === 'ycloud' ? 'ycloud-cloud-api' : 'baileys',
    state: connectionState,
    // número de WhatsApp enlazado (null si aún no conecta); en meta viene de env
    linkedNumber: oficial ? numeroOficial() : linkedNumber,
    // Por QUÉ no está listo, no solo que no lo está. El incidente de agosto duró
    // un mes porque este endpoint decía "ready" y el motivo real solo existía en
    // los logs de Render, que nadie mira.
    motivo: oficial && !oficial.activo() && typeof oficial.motivoInactivo === 'function'
      ? oficial.motivoInactivo() : undefined,
    // Un webhook sin App Secret acepta cualquier POST. Que se vea acá evita que
    // vuelva a pasar inadvertido.
    firmaValidada: oficial && typeof oficial.firmaActiva === 'function' ? oficial.firmaActiva() : undefined,
    // Las 3 capas del modelo Dualhook: firma HMAC (no disponible), ruta con
    // token secreto y validación de WABA/phone_number_id del payload.
    webhookSeguridad: oficial && typeof oficial.seguridadWebhook === 'function' ? oficial.seguridadWebhook() : undefined,
    safeMode: enModoSeguro(),
    // De dónde salió el modo: 'panel' = lo decidió Clarck · 'entorno' = todavía
    // manda SAFE_MODE de Render. Sin esto no hay forma de saber, mirando el
    // servicio, si el interruptor ya está en manos del cliente.
    safeModeFuente: db.estadoBot().fuente,
    testers: db.numerosDePrueba().length,
    brain: brain.cerebroActivo(),
    // 0 = sano. >0 = la IA está fallando (créditos/cuota/caída) y el bot solo
    // pide disculpas — visible acá para no repetir la ceguera del mes mudo.
    brainFallosSeguidos: typeof brain.estadoCerebro === 'function' ? brain.estadoCerebro().fallosSeguidos : undefined,
    leads: db.stats(),
  });
});

// Controlador de conexión que el panel usa para su vista "Conexión":
// leer estado/número/QR y poder desconectar (logout → limpia sesión → nuevo QR).
const conexion = {
  estado: () => connectionState,
  numero: () => (oficial ? numeroOficial() : linkedNumber),
  /**
   * Contestar desde el panel es una respuesta A MANO: el bot se calla 5
   * minutos con ese contacto, igual que si Clarck hubiera escrito desde su
   * celular. Sin esto, el bot podía responder encima de lo que él acababa de
   * mandar. (Guardar el mensaje en la conversación lo hace el panel.)
   */
  marcarManual(numero) {
    atendidoAMano.set(numero, Date.now());
  },
  qr: () => (oficial ? null : lastQrDataUrl),
  async desconectar() {
    if (oficial) return false; // el canal oficial no se "desconecta" desde acá
    if (!currentSock) return false;
    // logout() dispara connection.close con loggedOut=true → el handler de arriba
    // borra la sesión y reconecta, generando un QR nuevo para (re)enlazar.
    try { await currentSock.logout(); } catch (e) { console.error('[conexion] logout:', e.message); }
    linkedNumber = null;
    return true;
  },
  // Envía un texto suelto (lo usa el panel: mensaje de prueba / aviso manual).
  enviar: async (numero, texto) => {
    if (connectionState !== 'ready' || (!oficial && !currentSock)) return { ok: false, error: 'bot no conectado' };
    try {
      const sent = await enviarTexto(oficial ? oficial.sockAdapter : currentSock, `${numero}@s.whatsapp.net`, texto);
      console.log(`[send] OK → ${numero} id=${sent?.key?.id || '?'} (panel)`);
      return { ok: true, id: sent?.key?.id || null };
    } catch (e) {
      console.error(`[send] ERROR → ${numero} (panel):`, e.message);
      return { ok: false, error: e.message };
    }
  },
};

// Panel de control (src/panel.js): /admin/leads?key=ADMIN_KEY (+ CSV export)
require('./src/panel').registrarPanel(app, db, conexion);

// Espejo a Google Sheet (visibilidad para Clarck): al arrancar + cada 6 h.
// OJO: solo copia la tabla `leads` — NO es un respaldo completo.
sheet.programarSync(db);

// Respaldo REAL de la BD (leads + mensajes + pagos) por correo, cada 24 h.
backup.programarBackup(db);
backup.programarResumen(db);

/**
 * EL RELOJ DE LOS CUPOS GUARDADOS (2026-08-24).
 *
 * Un "anótame" reserva el lugar, pero la regla de Clarck es que la inscripción
 * es previa reserva por Yape. Sin este reloj, el que decía "ya te yapeo" y no
 * yapeaba se quedaba con el cupo hasta el día del partido, y el bot le decía
 * "no hay lugar" al que sí iba a pagar.
 *
 * Liberar el cupo es un cambio en la BASE y pasa siempre — también con el bot
 * apagado, porque si no la lista miente igual. Lo que NO sale con el bot
 * apagado son los mensajes al jugador: esa es la regla de la casa (lo del
 * jugador se calla, lo de Clarck sale). El aviso a Clarck sale siempre.
 */
function programarVencimientoReservas() {
  const revisar = async () => {
    let vencidas = [];
    try { vencidas = db.vencerReservas(); } catch (e) { return console.error('[reservas] Falló el barrido:', e.message); }
    if (!vencidas.length) return;
    const sock = oficial ? oficial.sockAdapter : currentSock;
    const puedeHablarle = !enModoSeguro() && connectionState === 'ready';
    for (const { inscripcion, partido, promovida } of vencidas) {
      const cuando = `${db.fechaBonita(partido.fecha)}${partido.hora ? ` ${partido.hora}` : ''} en ${db.nombreDeZona(partido.zona)}`;
      if (puedeHablarle && inscripcion.numero) {
        await conexion.enviar(inscripcion.numero,
          `Pichanguero, solté tu cupo del ${cuando} porque no llegó el Yape 🙏 Si todavía quieres jugar, escríbeme y lo vemos ⚽`);
      }
      if (puedeHablarle && promovida && promovida.numero) {
        await conexion.enviar(promovida.numero,
          `¡Buenas noticias! Se liberó un lugar para el ${cuando} y te subí de la lista de espera ⚽ Confírmalo con tu Yape para quedar en la lista 🙌`);
      }
    }
    // Para Clarck: en una línea, qué lugares volvieron a estar libres. Es la
    // señal de "hay que convocar", y no depende de que abra el panel.
    const resumen = vencidas
      .map(({ inscripcion, partido, promovida }) => `· ${inscripcion.nombre || `+${inscripcion.numero}`} — ${db.fechaBonita(partido.fecha)}${partido.hora ? ` ${partido.hora}` : ''} ${db.nombreDeZona(partido.zona)}${promovida ? ` (entró ${promovida.nombre || `+${promovida.numero}`} de la espera)` : ''}`)
      .join('\n');
    await notificarControl(sock,
      `⏳ ${vencidas.length} cupo${vencidas.length === 1 ? '' : 's'} guardado${vencidas.length === 1 ? '' : 's'} sin Yape se liberó${vencidas.length === 1 ? '' : 'n'}:
${resumen}`,
      'Cupos liberados por falta de pago');
  };
  setTimeout(revisar, 120_000);        // no compite con el arranque
  setInterval(revisar, 5 * 60_000);
  console.log(`[tick] Reservas sin pagar: se revisan cada 5 min (plazo actual: ${db.reservaMinutos()} min).`);
}
programarVencimientoReservas();

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
