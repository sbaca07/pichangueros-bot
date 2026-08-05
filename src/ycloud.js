/**
 * Transporte OFICIAL vía YCloud (BSP autorizado por Meta) en coexistencia.
 *
 * Hermano de src/meta.js: expone la MISMA interfaz para que index.js pueda
 * elegir uno u otro sin cambiar el cerebro, el CRM ni el panel.
 *
 *   TRANSPORTE=ycloud + estas variables:
 *     YCLOUD_API_KEY          key de Developers → API Keys
 *     YCLOUD_WEBHOOK_SECRET   el `secret` que YCloud muestra al crear el endpoint
 *     YCLOUD_NUMERO           número del negocio en formato E.164 (+51915395067)
 *
 * Diferencia clave con Meta directo: YCloud NO reenvía el payload crudo de la
 * Cloud API, manda su propio esquema (`whatsappInboundMessage`). Este módulo lo
 * traduce a la forma de Baileys que espera manejarMensaje(), igual que meta.js.
 *
 * Dos cosas salen más simples que con Meta:
 *   - Los adjuntos vienen con `link` directo, así que bajar un voucher es un
 *     solo GET (Meta obliga a pedir primero una url firmada por media_id).
 *   - YCloud firma cada webhook con HMAC-SHA256 y nos da el secreto, así que la
 *     validación de firma no depende de que un tercero nos comparta su App Secret.
 */

const crypto = require('crypto');

const API_KEY = process.env.YCLOUD_API_KEY || '';
const SECRET = process.env.YCLOUD_WEBHOOK_SECRET || '';
const NUMERO = process.env.YCLOUD_NUMERO || '';
const BASE = process.env.YCLOUD_API_BASE || 'https://api.ycloud.com/v2';

const activo = () => Boolean(API_KEY && NUMERO);

/** E.164 con "+" — YCloud exige el prefijo internacional al enviar. */
const aE164 = (n) => `+${String(n).replace(/\D/g, '')}`;

// --- Firma del webhook ---------------------------------------------------------

/**
 * Valida el header `YCloud-Signature: t={timestamp},s={firma}`.
 * La firma es HMAC-SHA256 de "{timestamp}.{cuerpo crudo}" con el secreto del
 * endpoint. Sin secreto configurado se deja pasar con warning (mismo criterio
 * que meta.js: preferimos un bot que funcione a uno mudo, pero que se vea).
 */
let avisoFirmaDado = false;
function firmaValida(req) {
  if (!SECRET) {
    if (!avisoFirmaDado) {
      avisoFirmaDado = true;
      console.warn('[ycloud] ⚠ YCLOUD_WEBHOOK_SECRET sin setear: el webhook NO valida firma (endpoint abierto).');
    }
    return true;
  }
  const header = req.get('ycloud-signature') || '';
  const t = /t=([^,]+)/.exec(header)?.[1];
  const s = /s=([^,\s]+)/.exec(header)?.[1];
  if (!t || !s || !req.rawBody) return false;

  const esperada = crypto.createHmac('sha256', SECRET)
    .update(`${t}.${req.rawBody.toString('utf8')}`)
    .digest('hex');
  const a = Buffer.from(s);
  const b = Buffer.from(esperada);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// --- Salida -------------------------------------------------------------------

/** Envía texto por la API de YCloud. Devuelve shape compatible con Baileys. */
async function enviarTexto(numero, texto) {
  const res = await fetch(`${BASE}/whatsapp/messages`, {
    method: 'POST',
    headers: { 'X-API-Key': API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: aE164(NUMERO),
      to: aE164(numero),
      type: 'text',
      text: { body: texto },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`YCloud ${res.status}: ${data?.message || data?.error || 'error enviando'}`);
  // Preferimos el wamid (id de WhatsApp) para que cuadre con los echoes.
  return { key: { id: data?.wamid || data?.id || null } };
}

/** Baja un adjunto desde el `link` que YCloud incluye en el mensaje entrante. */
async function descargarMedia(link) {
  const res = await fetch(link, { headers: { 'X-API-Key': API_KEY } });
  if (!res.ok) throw new Error(`YCloud: descarga de media falló (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

const sockAdapter = {
  sendMessage: async (jid, contenido) => enviarTexto(String(jid).split('@')[0], contenido.text),
  sendPresenceUpdate: async () => {},
  updateMediaMessage: async () => {},
};

// --- Entrada ------------------------------------------------------------------

/**
 * Traduce un mensaje de YCloud a la forma Baileys que espera index.js.
 * `fromMe` distingue un echo (lo mandó el negocio) de un entrante del jugador:
 * en un echo el interlocutor es `to`, en un entrante es `from`.
 */
function aMensajeBaileys(m, fromMe = false) {
  if (!m) return null;
  const numero = String((fromMe ? m.to : m.from) || '').replace(/\D/g, '');
  if (!numero) return null;

  const msg = {
    key: { remoteJid: `${numero}@s.whatsapp.net`, fromMe, id: m.wamid || m.id || null },
    message: {},
  };

  const conLink = (tipo, clave) => {
    msg.message[clave] = { caption: m[tipo]?.caption || undefined };
    if (m[tipo]?.link) msg._descargar = () => descargarMedia(m[tipo].link);
  };

  switch (m.type) {
    case 'text': msg.message.conversation = m.text?.body || ''; break;
    case 'image': conLink('image', 'imageMessage'); break;
    case 'document': conLink('document', 'documentMessage'); break;
    case 'video': msg.message.videoMessage = { caption: m.video?.caption || undefined }; break;
    case 'audio': msg.message.audioMessage = {}; break;
    case 'sticker': msg.message.stickerMessage = {}; break;
    case 'location': msg.message.locationMessage = {}; break;
    case 'contacts': msg.message.contactMessage = {}; break;
    default: return null; // reacciones, sistema, no soportados: se ignoran
  }
  return msg;
}

/**
 * Eventos de salud de la cuenta. Con el historial de sanciones del número, que
 * Meta le baje la calidad o la ponga en revisión es la señal más temprana que
 * vamos a tener — por eso se avisa al número de control, no solo al log.
 */
const ALERTAS = {
  'whatsapp.phone_number.quality_updated': (v) =>
    `⚠️ Meta cambió la CALIDAD del número: ${v?.qualityRating || v?.quality_rating || '?'}`,
  'whatsapp.business_account.reviewed': (v) =>
    `⚠️ Meta REVISÓ la cuenta de WhatsApp Business. Estado: ${v?.banState || v?.status || '?'}`,
  'whatsapp.phone_number.deleted': () => '🚨 El número fue ELIMINADO de la cuenta de WhatsApp Business.',
  'whatsapp.business_account.deleted': () => '🚨 La cuenta de WhatsApp Business fue ELIMINADA.',
};

/** Saca el objeto de datos del sobre, sin depender de una sola llave. */
function cuerpoDelEvento(e) {
  return e.whatsappInboundMessage || e.whatsappMessage || e.whatsappPhoneNumber
    || e.whatsappBusinessAccount || e.whatsappSmbMessageEcho || null;
}

function registrarWebhook(app, { onMensaje, onEcho, onAlerta = null }) {
  app.post('/webhook/ycloud', (req, res) => {
    if (!firmaValida(req)) {
      console.error('[ycloud] Webhook RECHAZADO: firma inválida.');
      return res.sendStatus(403);
    }
    res.sendStatus(200); // YCloud reintenta 7 veces si no ve un 2xx en 6 s

    try {
      const evento = req.body || {};
      const tipo = evento.type || '';
      const datos = cuerpoDelEvento(evento);

      if (tipo === 'whatsapp.inbound_message.received') {
        const msg = aMensajeBaileys(datos, false);
        if (msg) {
          Promise.resolve(onMensaje(sockAdapter, msg))
            .catch((e) => console.error('[ycloud] Error manejando mensaje:', e.message));
        }
        return;
      }

      if (tipo === 'whatsapp.smb.message.echoes') {
        // El esquema del echo no está documentado. Traducimos con lo que haya y
        // dejamos rastro si no calza, para ajustarlo cuando veamos uno real.
        const msg = aMensajeBaileys(datos, true);
        if (msg) { try { onEcho(msg); } catch (e) { console.error('[ycloud] Error registrando echo:', e.message); } }
        else console.warn('[ycloud] Echo con forma inesperada:', JSON.stringify(evento).slice(0, 400));
        return;
      }

      if (tipo === 'whatsapp.message.updated') {
        const estado = datos?.status || '';
        if (estado === 'failed' || estado === 'undelivered') {
          console.error(`[ycloud] Envío FALLÓ → ${datos?.to || '?'}:`, JSON.stringify(datos?.error || datos?.errors || {}));
        }
        return;
      }

      if (ALERTAS[tipo]) {
        const aviso = ALERTAS[tipo](datos || {});
        console.error(`[ycloud] ${aviso}`);
        if (onAlerta) { try { onAlerta(aviso); } catch (e) { console.error('[ycloud] Error avisando:', e.message); } }
      }
    } catch (e) {
      console.error('[ycloud] Error procesando webhook:', e.message);
    }
  });

  console.log('[ycloud] Webhook registrado en /webhook/ycloud (transporte YCloud / Cloud API).');
}

module.exports = { activo, registrarWebhook, enviarTexto, sockAdapter, aMensajeBaileys, firmaValida };
