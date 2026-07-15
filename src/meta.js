/**
 * Transporte OFICIAL: WhatsApp Cloud API (Meta) en modo coexistencia.
 *
 * Reemplaza a Baileys como "cable" de entrada/salida — el cerebro (brain.js),
 * los pagos (pagos.js), la BD y el panel no cambian. Se activa con
 * TRANSPORTE=meta y estas variables:
 *
 *   META_TOKEN            token de acceso (del Tech Provider / system user)
 *   META_PHONE_NUMBER_ID  id del número en la plataforma (no es el número)
 *   META_VERIFY_TOKEN     string secreto para la verificación del webhook
 *   META_GRAPH_VERSION    opcional, default v23.0
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

const TOKEN = process.env.META_TOKEN || '';
const PHONE_ID = process.env.META_PHONE_NUMBER_ID || '';
const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || '';
const GRAPH = `https://graph.facebook.com/${process.env.META_GRAPH_VERSION || 'v23.0'}`;

const activo = () => Boolean(TOKEN && PHONE_ID && VERIFY_TOKEN);

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
 * Registra las rutas del webhook. `onMensaje(sock, msg)` es manejarMensaje;
 * `onEcho(msg)` registra las respuestas manuales de Clarck (coexistencia).
 */
function registrarWebhook(app, { onMensaje, onEcho }) {
  // Verificación inicial (Meta manda un GET con el verify token).
  app.get('/webhook/meta', (req, res) => {
    if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN) {
      return res.send(req.query['hub.challenge']);
    }
    res.sendStatus(403);
  });

  app.post('/webhook/meta', (req, res) => {
    res.sendStatus(200); // responder YA — Meta reintenta si demoras
    try {
      for (const entry of req.body?.entry || []) {
        for (const change of entry.changes || []) {
          const v = change.value || {};

          // Mensajes entrantes de clientes.
          for (const m of v.messages || []) {
            const msg = aMensajeBaileys(m, false);
            if (msg) Promise.resolve(onMensaje(sockAdapter, msg)).catch((e) => console.error('[meta] Error manejando mensaje:', e.message));
          }

          // Echoes: lo que el negocio (Clarck desde su app) envió a mano.
          for (const m of v.message_echoes || []) {
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

  console.log('[meta] Webhook oficial registrado en /webhook/meta (transporte Cloud API).');
}

module.exports = { activo, registrarWebhook, enviarTexto, sockAdapter, aMensajeBaileys };
