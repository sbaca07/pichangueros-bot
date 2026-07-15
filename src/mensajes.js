/**
 * Lectura de mensajes de WhatsApp (puro, sin red — testeable).
 *
 * WhatsApp no siempre entrega el contenido "plano": los chats con mensajes
 * temporales activados, las fotos "ver una sola vez" y los documentos con
 * caption llegan ENVUELTOS en otro nodo. Sin desenvolverlos, el bot ve el
 * mensaje vacío y se queda mudo — por eso todo pasa por acá.
 */

/** Desenvuelve los "sobres" de WhatsApp hasta llegar al contenido real. */
function desenvolver(m) {
  let inner = m;
  for (let i = 0; inner && i < 5; i++) {
    const sobre = inner.ephemeralMessage || inner.viewOnceMessage || inner.viewOnceMessageV2
      || inner.viewOnceMessageV2Extension || inner.documentWithCaptionMessage;
    if (!sobre || !sobre.message) break;
    inner = sobre.message;
  }
  return inner || {};
}

/** Saca el texto útil del mensaje; los adjuntos se vuelven un marcador para el cerebro. */
function extraerTexto(msg) {
  if (!msg.message) return '';
  const m = desenvolver(msg.message);
  const texto = m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption
    || m.videoMessage?.caption || m.documentMessage?.caption;
  if (texto) return texto.trim();
  if (m.imageMessage) return '[el jugador envió una imagen]';
  if (m.audioMessage) return '[el jugador envió un audio]';
  if (m.videoMessage) return '[el jugador envió un video]';
  if (m.stickerMessage) return '[el jugador envió un sticker]';
  if (m.documentMessage) return '[el jugador envió un documento]';
  if (m.locationMessage || m.liveLocationMessage) return '[el jugador envió una ubicación]';
  if (m.contactMessage || m.contactsArrayMessage) return '[el jugador envió un contacto]';
  return ''; // reacciones, mensajes de protocolo, etc.: no ameritan respuesta
}

const jidToNumero = (jid) => (jid || '').split('@')[0].split(':')[0].replace(/\D/g, '');

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

module.exports = { desenvolver, extraerTexto, jidToNumero, numeroDe };
