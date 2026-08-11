/**
 * Transporte OFICIAL: WhatsApp Cloud API (Meta) en modo coexistencia.
 *
 * Reemplaza a Baileys como "cable" de entrada/salida — el cerebro (brain.js),
 * los pagos (pagos.js), la BD y el panel no cambian. Se activa con
 * TRANSPORTE=meta y estas variables:
 *
 *   META_TOKEN            token de acceso (con Dualhook: la key dh_live_…)
 *   META_PHONE_NUMBER_ID  id del número en la plataforma (no es el número)
 *   META_VERIFY_TOKEN     string secreto para la verificación del webhook
 *   META_API_BASE         opcional, default https://graph.facebook.com
 *                         (con Dualhook: https://api.dualhook.com)
 *   META_GRAPH_VERSION    opcional, default v23.0 (con Dualhook: v25.0)
 *
 * Cómo encaja con index.js:
 *   - Los mensajes entrantes se convierten a la MISMA forma que produce
 *     Baileys (msg.key.remoteJid, msg.message.conversation, etc.) para que
 *     manejarMensaje() funcione sin tocarse.
 *   - Las imágenes traen msg._descargar() (Graph API media) — index.js lo usa
 *     en lugar de downloadMediaMessage cuando existe.
 *   - Se entrega un "sock" adaptador con sendMessage()/sendPresenceUpdate()
 *     sobre la API oficial.
 *   - Los ECHOES (message_echoes: lo que Clarck responde a mano desde su app
 *     en coexistencia) llegan como fromMe=true → index.js los guarda como
 *     respuesta manual, igual que hacía con Baileys.
 */

const crypto = require('crypto');

// .trim() en todas: pegar un valor correcto desde el panel de Meta arrastrando
// un espacio o un newline es trivial, y sin recortar el phone_number_id no pasa
// /^\d{6,}$/ → el bot queda mudo con un log que dice "no es numérico" sobre un
// valor que en el dashboard se ve perfecto. Un mes de diagnóstico por un espacio.
const TOKEN = (process.env.META_TOKEN || '').trim();
const PHONE_ID = (process.env.META_PHONE_NUMBER_ID || '').trim();
const VERIFY_TOKEN = (process.env.META_VERIFY_TOKEN || '').trim();
const APP_SECRET = (process.env.META_APP_SECRET || '').trim();
// Modelo de seguridad SIN App Secret (respuesta de Dualhook, ticket 2026-08-11):
// su secret es compartido entre clientes y no se entrega. Lo soportado es
// (1) una ruta de webhook con token de alta entropía — un secreto en la URL —
// y (2) validar la IDENTIDAD del payload: object correcto, entry.id = nuestra
// WABA y metadata.phone_number_id = nuestro número. Un POST forjado tendría
// que adivinar la ruta Y conocer ambos IDs.
const WABA_ID = (process.env.META_WABA_ID || '').trim();
const PATH_TOKEN = (process.env.META_WEBHOOK_PATH_TOKEN || '').trim();
const RUTA_WEBHOOK = PATH_TOKEN ? `/webhook/meta/${PATH_TOKEN}` : '/webhook/meta';
// Base de la API saliente. Con Dualhook los envíos NO van a graph.facebook.com:
// van a su proxy (META_API_BASE=https://api.dualhook.com) con una key dh_live_…
// como META_TOKEN — las credenciales reales de Meta nunca salen de Dualhook.
// Los webhooks entrantes no cambian: Meta pega directo a nuestro endpoint.
const API_BASE = (process.env.META_API_BASE || 'https://graph.facebook.com').trim().replace(/\/+$/, '');
const GRAPH = `${API_BASE}/${(process.env.META_GRAPH_VERSION || 'v23.0').trim()}`;

/**
 * ¿Hay credenciales USABLES? No alcanza con que las variables existan.
 *
 * Este servicio estuvo un mes reportando `state:"ready"` y mudo porque Render
 * tenía `META_PHONE_NUMBER_ID=PENDIENTE-reemplazar-con-phone-number-id`: un
 * string no vacío, que el `Boolean(...)` original daba por bueno. Con eso
 * index.js apagaba Baileys, registraba el webhook (sin App Secret, o sea
 * abierto) y anunciaba que estaba listo, sobre un canal que no existía.
 *
 * Por eso ahora se valida la FORMA, no la presencia: el phone_number_id de Meta
 * es numérico, y cualquier valor con pinta de recordatorio se rechaza.
 */
// \b a propósito: un token real puede contener estas letras como subcadena
// (`EAAxxxToken` traía "xxx"). Solo se rechaza la palabra suelta, que es lo que
// escribe un humano dejándose un recordatorio.
const PLACEHOLDER = /\b(pendiente|reemplazar|placeholder|cambiar|todo|xxxx+|tu[-_ ]?(token|id))\b/i;
const usable = (v) => Boolean(v) && !PLACEHOLDER.test(v);

const activo = () => usable(TOKEN) && usable(VERIFY_TOKEN) && /^\d{6,}$/.test(PHONE_ID || '');

/** Explica por qué el transporte no está activo, para que el log sea accionable. */
function motivoInactivo() {
  const faltan = [];
  if (!usable(TOKEN)) faltan.push(TOKEN ? 'META_TOKEN parece un placeholder' : 'META_TOKEN vacía');
  if (!/^\d{6,}$/.test(PHONE_ID || '')) {
    faltan.push(PHONE_ID ? 'META_PHONE_NUMBER_ID no es numérico (¿placeholder?)' : 'META_PHONE_NUMBER_ID vacía');
  }
  if (!usable(VERIFY_TOKEN)) faltan.push(VERIFY_TOKEN ? 'META_VERIFY_TOKEN parece un placeholder' : 'META_VERIFY_TOKEN vacía');
  return faltan.join(' · ');
}

/**
 * Valida la firma X-Hub-Signature-256 del webhook.
 *
 * El endpoint es público: sin esto, cualquiera que sepa la URL puede inventar
 * mensajes, hacer que el bot responda a números arbitrarios y quemar créditos
 * de OpenAI. Meta firma el cuerpo crudo con el App Secret de la app dueña de la
 * suscripción (con Webhook Override, la del Tech Provider — pedírselo).
 *
 * Si META_APP_SECRET no está seteado, se deja pasar con warning en vez de
 * romper el canal: preferimos un bot que funcione sin verificar a uno mudo.
 */
/** ¿El webhook está validando firma? Se expone en `GET /` para que un endpoint
 *  abierto sea visible sin leer los logs de Render. */
const firmaActiva = () => Boolean(APP_SECRET);

/** Estado de las 3 capas de seguridad del webhook, para `GET /`. */
const seguridadWebhook = () => ({
  firma: Boolean(APP_SECRET),          // HMAC de Meta (no disponible vía Dualhook)
  rutaSecreta: Boolean(PATH_TOKEN),    // token de alta entropía en la URL
  validaIds: Boolean(WABA_ID),         // entry.id (WABA) + phone_number_id del payload
});

let avisoFirmaDado = false;
function firmaValida(req) {
  if (!APP_SECRET) {
    if (!avisoFirmaDado) {
      avisoFirmaDado = true;
      console.warn('[meta] ⚠ META_APP_SECRET sin setear: el webhook NO valida firma (endpoint abierto).');
    }
    return true;
  }
  const recibida = req.get('x-hub-signature-256') || '';
  if (!recibida.startsWith('sha256=') || !req.rawBody) return false;
  const esperada = 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(req.rawBody).digest('hex');
  const a = Buffer.from(recibida);
  const b = Buffer.from(esperada);
  // timingSafeEqual exige mismo largo — comparar largos primero evita que tire.
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// --- Salida -------------------------------------------------------------------

/** Envía texto por la API oficial. Devuelve shape compatible con Baileys ({key:{id}}). */
async function enviarTexto(numero, texto) {
  const res = await fetch(`${GRAPH}/${PHONE_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: numero,
      type: 'text',
      text: { body: texto },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Meta ${res.status}: ${data?.error?.message || 'error enviando'}`);
  return { key: { id: data?.messages?.[0]?.id || null } };
}

/** Descarga una imagen/documento por media_id (dos pasos: url firmada → binario). */
async function descargarMedia(mediaId) {
  const meta = await (await fetch(`${GRAPH}/${mediaId}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  })).json();
  if (!meta.url) throw new Error('Meta: media sin url (¿token vencido?)');
  const bin = await fetch(meta.url, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!bin.ok) throw new Error(`Meta: descarga de media falló (${bin.status})`);
  return Buffer.from(await bin.arrayBuffer());
}

/** Adaptador con la interfaz mínima de Baileys que usa manejarMensaje/el panel. */
const sockAdapter = {
  sendMessage: async (jid, contenido) => enviarTexto(String(jid).split('@')[0], contenido.text),
  // La API oficial tiene indicador de "escribiendo" solo al marcar leído un
  // mensaje entrante; para no complicar, el "composing" es un no-op acá.
  sendPresenceUpdate: async () => {},
  updateMediaMessage: async () => {},
};

// --- Entrada ------------------------------------------------------------------

/** Convierte un mensaje del webhook de Meta a la forma Baileys que espera index.js. */
function aMensajeBaileys(m, fromMe = false) {
  const numero = (fromMe ? m.to || '' : m.from || '').replace(/\D/g, '');
  const msg = {
    key: { remoteJid: `${numero}@s.whatsapp.net`, fromMe, id: m.id },
    message: {},
  };
  if (m.type === 'text') {
    msg.message.conversation = m.text?.body || '';
  } else if (m.type === 'image') {
    msg.message.imageMessage = { caption: m.image?.caption || undefined };
    msg._descargar = () => descargarMedia(m.image.id);
  } else if (m.type === 'audio') {
    msg.message.audioMessage = {};
  } else if (m.type === 'video') {
    msg.message.videoMessage = { caption: m.video?.caption || undefined };
  } else if (m.type === 'sticker') {
    msg.message.stickerMessage = {};
  } else if (m.type === 'document') {
    msg.message.documentMessage = { caption: m.document?.caption || undefined };
    msg._descargar = () => descargarMedia(m.document.id);
  } else if (m.type === 'location') {
    msg.message.locationMessage = {};
  } else if (m.type === 'contacts') {
    msg.message.contactMessage = {};
  } else {
    return null; // reacciones, sistema, unsupported: se ignoran igual que antes
  }
  return msg;
}

/**
 * Eventos de salud de la cuenta. Meta NO los manda dentro de `messages`: cada
 * uno llega como un `field` propio del change. Con el historial de sanciones del
 * número, que Meta le baje la calidad o la ponga en revisión es la señal más
 * temprana que vamos a tener — por eso se avisa al número de control, no solo al
 * log.
 *
 * ⚠️ Hay que suscribir estos campos en el panel del Tech Provider además de
 * `messages` y `message_echoes`, o el webhook no los recibe nunca.
 */
/** Eventos de `account_update` que dejan el bot MUDO. Se gritan, no se aplanan. */
const CORTES = {
  PARTNER_REMOVED: 'el partner fue removido — LA COEXISTENCIA SE DESCONECTÓ',
  ACCOUNT_OFFBOARDED: 'la cuenta fue dada de baja',
  ACCOUNT_DELETED: 'la cuenta fue ELIMINADA',
  DISABLED_UPDATE: 'la cuenta fue DESHABILITADA',
  ACCOUNT_RESTRICTION: 'la cuenta quedó RESTRINGIDA',
  ACCOUNT_VIOLATION: 'Meta marcó una VIOLACIÓN de políticas',
};

// Object.create(null): `change.field` viene del payload, o sea de afuera. Con un
// objeto literal, `ALERTAS['toString']` hereda de Object.prototype y da truthy —
// un POST con field:"toString" mandaba "[object Object]" al número de control, y
// field:"__proto__" tiraba un TypeError que abortaba el loop entero y se comía
// los mensajes legítimos del mismo POST (con el 200 ya enviado, Meta no reintenta).
const ALERTAS = Object.assign(Object.create(null), {
  // Ojo: este campo YA NO reporta calidad. Sus eventos documentados son
  // ONBOARDING y THROUGHPUT_UPGRADE, y `current_limit` se eliminó en feb-2026 en
  // favor de `max_daily_conversations_per_business`. Se informa lo que llega en
  // vez de inventar "bajó la calidad".
  phone_number_quality_update: (v) => {
    const limite = v?.max_daily_conversations_per_business ?? v?.current_limit;
    return `ℹ️ Meta actualizó el número: ${v?.event || '?'}`
      + (limite ? ` · límite diario: ${limite}` : '');
  },
  account_update: (v) => {
    const corte = CORTES[v?.event];
    return `${corte ? '🚨' : 'ℹ️'} Cuenta: ${corte || v?.event || '?'}`
      + (v?.ban_info?.waba_ban_state ? ` · ban_state: ${v.ban_info.waba_ban_state}` : '')
      + (v?.disconnection_info ? ` · ${JSON.stringify(v.disconnection_info).slice(0, 200)}` : '');
  },
  account_review_update: (v) =>
    `⚠️ Meta REVISÓ la cuenta de WhatsApp Business. Decisión: ${v?.decision || '?'}`,
  // El campo que hoy entrega cambios de límite y advertencias de capacidad — el
  // que de verdad hace de alerta temprana desde que quality_update dejó de serlo.
  account_alerts: (v) => {
    const a = v?.alert_info || {};
    return `⚠️ Alerta de Meta (${a.alert_severity || '?'}/${a.alert_status || '?'}): `
      + `${a.alert_type || '?'} — ${a.alert_description || 'sin descripción'}`;
  },
});

/**
 * Registra las rutas del webhook. `onMensaje(sock, msg)` es manejarMensaje;
 * `onEcho(msg)` registra las respuestas manuales de Clarck (coexistencia);
 * `onAlerta(aviso)` avisa al número de control de la salud de la cuenta.
 */
/**
 * Registra SOLO el handshake de verificación (el GET con hub.challenge).
 *
 * Va separado de la ingesta a propósito. Para dar de alta el webhook en el panel
 * del Tech Provider, Meta pega un GET y espera el challenge — pero ese paso es
 * anterior a tener `META_TOKEN` y `META_PHONE_NUMBER_ID`, que salen justamente
 * de la conexión que todavía no existe. Sin esta separación el orden era
 * imposible: la ruta no existía hasta tener credenciales, y no había
 * credenciales hasta configurar la ruta.
 *
 * Verificar no requiere credenciales: solo comparar el verify token. Y como el
 * POST queda sin registrar, no se puede ingerir ni un mensaje.
 */
function registrarVerificacion(app) {
  if (!usable(VERIFY_TOKEN)) {
    console.warn('[meta] META_VERIFY_TOKEN sin setear: no se registra el handshake del webhook.');
    return false;
  }
  app.get(RUTA_WEBHOOK, (req, res) => {
    if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN) {
      // text/plain + String(): el challenge es input del que llama y se refleja
      // tal cual. Como text/html sería un XSS reflejado (menor, hace falta el
      // verify token) y Meta espera texto plano igual.
      return res.type('text/plain').send(String(req.query['hub.challenge'] ?? ''));
    }
    res.sendStatus(403);
  });
  return true;
}

/**
 * Meta reintenta la entrega de un webhook si no ve el 200 a tiempo, y puede
 * mandar el mismo mensaje más de una vez. Sin deduplicar, un reintento hace que
 * el bot le conteste dos veces al mismo cliente. Se recuerdan los últimos ids;
 * el Set conserva orden de inserción, así que descartar el primero saca el más
 * viejo.
 */
const VISTOS_MAX = 2000;
const vistos = new Set();
function yaVisto(id) {
  if (!id) return false;
  if (vistos.has(id)) return true;
  vistos.add(id);
  if (vistos.size > VISTOS_MAX) vistos.delete(vistos.values().next().value);
  return false;
}

function registrarWebhook(app, { onMensaje, onEcho, onAlerta = null }) {
  registrarVerificacion(app);

  app.post(RUTA_WEBHOOK, (req, res) => {
    if (!firmaValida(req)) {
      console.error('[meta] Webhook RECHAZADO: firma X-Hub-Signature-256 inválida.');
      return res.sendStatus(403);
    }
    // Validación por identidad (lo que Dualhook soporta sin App Secret): el
    // payload tiene que hablar de una cuenta de WhatsApp Business…
    if (req.body?.object !== 'whatsapp_business_account') {
      console.error(`[meta] Webhook RECHAZADO: object "${String(req.body?.object).slice(0, 40)}" no es whatsapp_business_account.`);
      return res.sendStatus(403);
    }
    res.sendStatus(200); // responder YA — Meta reintenta si demoras
    try {
      for (const entry of req.body?.entry || []) {
        // …y de NUESTRA cuenta: entry.id es el WABA id en todos los eventos.
        if (WABA_ID && String(entry.id) !== WABA_ID) {
          console.error(`[meta] Entry DESCARTADO: WABA "${String(entry.id).slice(0, 30)}" no es la nuestra.`);
          continue;
        }
        for (const change of entry.changes || []) {
          const v = change.value || {};
          // Los eventos de mensajes traen metadata.phone_number_id — si viene
          // y no es el nuestro, se descarta (los de salud son WABA-level y no
          // lo traen: ya pasaron el filtro del entry).
          const pnid = v.metadata && v.metadata.phone_number_id;
          if (PHONE_ID && pnid && String(pnid).trim() !== PHONE_ID) {
            console.error(`[meta] Change DESCARTADO: phone_number_id "${String(pnid).slice(0, 30)}" no es el nuestro.`);
            continue;
          }

          // Salud de la cuenta: viene como un `field` propio, nunca junto a los
          // mensajes. Se atiende primero y se corta — no trae messages/echoes.
          // typeof además de Object.create(null): `change.field` es input externo.
          if (typeof ALERTAS[change.field] === 'function') {
            const aviso = ALERTAS[change.field](v);
            console.error(`[meta] ${aviso}`);
            if (onAlerta) { try { onAlerta(aviso); } catch (e) { console.error('[meta] Error avisando:', e.message); } }
            continue;
          }

          // Mensajes entrantes de clientes.
          for (const m of v.messages || []) {
            if (yaVisto(m.id)) { console.log(`[meta] Mensaje repetido ${m.id} — ignorado (reintento de Meta).`); continue; }
            const msg = aMensajeBaileys(m, false);
            if (msg) Promise.resolve(onMensaje(sockAdapter, msg)).catch((e) => console.error('[meta] Error manejando mensaje:', e.message));
          }

          // Echoes: lo que el negocio (Clarck desde su app) envió a mano.
          for (const m of v.message_echoes || []) {
            if (yaVisto(m.id)) continue;
            const msg = aMensajeBaileys(m, true);
            if (msg) { try { onEcho(msg); } catch (e) { console.error('[meta] Error registrando echo:', e.message); } }
          }

          for (const s of v.statuses || []) {
            if (s.status === 'failed') console.error(`[meta] Envío FALLÓ → ${s.recipient_id}:`, JSON.stringify(s.errors || []));
          }
        }
      }
    } catch (e) { console.error('[meta] Error procesando webhook:', e.message); }
  });

  const seg = seguridadWebhook();
  console.log(`[meta] Webhook oficial registrado en ${PATH_TOKEN ? '/webhook/meta/<token-secreto>' : RUTA_WEBHOOK} (ruta secreta: ${seg.rutaSecreta ? 'sí' : 'NO'} · valida IDs: ${seg.validaIds ? 'sí' : 'NO'} · firma HMAC: ${seg.firma ? 'sí' : 'no disponible vía Dualhook'}).`);
}

module.exports = { activo, motivoInactivo, firmaActiva, seguridadWebhook, registrarVerificacion, registrarWebhook, enviarTexto, sockAdapter, aMensajeBaileys, firmaValida };
