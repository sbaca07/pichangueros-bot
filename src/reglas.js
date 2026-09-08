/**
 * La IA, de última instancia — responder por ESTADO (2026-09-08).
 *
 * Se leyeron los 12.719 mensajes que entraron en 30 días (906 personas) y la
 * conclusión fue incómoda: casi todo iba a la IA, y casi nada lo necesitaba.
 *
 *     38.7%  conversación libre            ← esto sí es IA
 *     12.9%  corto suelto (necesita contexto)
 *     12.5%  "gracias" / "ok" / "listo"
 *     11.6%  una foto (voucher)            ← esto sí es IA de visión
 *      7.8%  saludo pelado
 *      4.4%  audio / sticker / video
 *      3.9%  "anótame"
 *      2.3%  "ahí te yapeo"
 *
 * Lo revelador fue mirar QUÉ CONTESTA CLARCK a esos mensajes. Al mismo "ok" le
 * responde tres cosas distintas:
 *
 *     "Me pasas foto del yape porfa"   → al que tiene el cupo sin pagar
 *     "Anotado. Gracias!"              → al que ya está en la lista
 *     "Si se baja alguien te aviso"    → al que quedó en espera
 *
 * O sea que la respuesta no depende del TEXTO —"ok" no dice nada— sino del
 * ESTADO del jugador, que está en la base. Eso es una regla, no un modelo. Y
 * una regla no se cae, no cuesta tokens, contesta en milisegundos y sigue
 * viva el día que la IA se caiga (como el 8-sep a la mañana).
 *
 * Los textos de acá son los de Clarck, no inventados: se sacaron de sus
 * respuestas reales de esos 30 días.
 *
 * REGLA DE ORO, la misma que `atajos.js`: ante la menor duda, null. Un mensaje
 * que no calza exacto va a la IA. Este archivo no adivina nunca.
 */
const db = require('./db');

const limpiar = (t) => (t || '')
  .toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[¿?¡!.,;:()"'*_~]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const primerNombre = (n) => (n || '').trim().split(/\s+/)[0] || '';

/** Los nombres de zona lindos, con la misma regla que usa el resto. */
const nombreZona = (z) => db.nombreDeZona(z) || z;

/** "el jueves 11 a las 9-10pm en Comas" — como lo diría Clarck. */
function cuandoYDonde(insc) {
  const cuando = db.fechaBonita(insc.fecha);
  return `${cuando}${insc.hora ? ` ${insc.hora}` : ''} en ${nombreZona(insc.zona)}`;
}

/**
 * Cómo está el jugador AHORA: su próxima pichanga y en qué situación.
 * Es lo único que hace falta para contestar la mayoría de los mensajes.
 */
function situacion(numero) {
  const vigentes = db.inscripcionesVigentesDe(numero);
  const pagada = vigentes.find((i) => i.estado === 'pagado');
  const reservada = vigentes.find((i) => i.estado === 'reservado');
  const espera = vigentes.find((i) => i.estado === 'espera');
  if (pagada) return { que: 'pagado', insc: pagada };
  if (reservada) return { que: 'reservado', insc: reservada };
  if (espera) return { que: 'espera', insc: espera };
  return { que: 'nada', insc: null };
}

// ── Los intents, todos ANCLADOS de punta a punta ──────────────────────────
// Sin ^$ , "ya pagué mi cupo hay algún problema" dispararía el acuse y la IA
// nunca vería la pregunta real. Es el mismo error que costó el code review
// del 11-ago en atajos.js.

const ACUSE = /^(gracias|muchas gracias|ok|oka|okey|okay|listo|dale|ya|si|sip|claro|perfecto|esta bien|de acuerdo|bacan|excelente|ahi esta|ya esta|entendido|correcto|vale|va|chevere|genial|buenisimo)( (gracias|amigo|profe|bro|hermano|causa|manito|mano|crack|master|maestro|pues|papa|jefe))*$/;

const SALUDO = /^(hola+|holaa+|buenas+|buenos dias|buenas tardes|buenas noches|buen dia|hey+|alo+h?|ola+|que tal|hi|hello|saludos)( (amigo|amigos|bro|causa|profe|maestro|crack|mano|manito|hermano|pichangueros?|que tal|buenas|clarck))*$/;

const AVISA_QUE_PAGO = /^(ya |ahi |ahora |en un toque |ya te |ahi te |ahora te )?(te )?(yapeo|yapee|yapie|yapeare|mando el yape|paso el yape|transfiero|deposito)( (amigo|profe|bro|hermano|en un momento|en unos minutos|ahorita|ya|pues|manito))*$/;

/**
 * ¿Se puede contestar esto sin IA?
 *
 * @param {object} lead      la ficha del contacto
 * @param {string} texto     lo que escribió (vacío si mandó un adjunto)
 * @param {string} [adjunto] 'audio' | 'sticker' | 'video' | 'documento' | 'contacto'
 * @returns {null | {respuesta: string|null, regla: string}}
 *          null → que lo resuelva la IA.
 *          respuesta null → se entendió, y lo correcto es NO contestar.
 */
function responder(lead, texto, adjunto) {
  // Los adjuntos que no se pueden leer tienen respuesta fija: la IA no los ve
  // igual, así que preguntarle es gastar una llamada para que improvise.
  // La FOTO no está acá a propósito: puede ser un Yape y eso sí necesita ojos.
  if (adjunto === 'audio') {
    return { respuesta: 'Uy, todavía no puedo escuchar audios 🙈 ¿Me lo escribes porfa?', regla: 'audio' };
  }
  if (adjunto === 'video' || adjunto === 'documento') {
    return { respuesta: 'No puedo abrir eso por acá 🙈 ¿Me cuentas de qué se trata?', regla: 'adjunto' };
  }
  // Un sticker es un sticker: contestarlo con un texto es más raro que dejarlo
  // pasar. Clarck tampoco los contesta la mitad de las veces.
  if (adjunto === 'sticker') return { respuesta: null, regla: 'sticker' };

  const t = limpiar(texto);
  if (!t || t.length > 45) return null;   // largo = contexto = IA

  const yo = situacion(lead?.numero);

  // "gracias" / "ok" / "listo". El texto no dice nada; el estado sí.
  if (ACUSE.test(t)) {
    if (yo.que === 'reservado') {
      const precio = db.precioDePartido({ zona: yo.insc.zona, precio: yo.insc.precio_partido });
      return {
        respuesta: `Me pasas la foto del Yape porfa 🙏${precio != null ? ` Son S/${precio}` : ''} al ${db.getNegocio().yape.numero} (${db.getNegocio().yape.titular}) — así te dejo confirmado en la lista del ${cuandoYDonde(yo.insc)} ⚽`,
        regla: 'acuse/falta-pagar',
      };
    }
    if (yo.que === 'pagado') {
      return { respuesta: `Ya estás en la lista del ${cuandoYDonde(yo.insc)} ⚽ Nos vemos allá 💪`, regla: 'acuse/ya-esta' };
    }
    if (yo.que === 'espera') {
      return { respuesta: `Estás en la lista de espera del ${cuandoYDonde(yo.insc)} 🙏 Si se baja alguien te aviso al toque.`, regla: 'acuse/espera' };
    }
    // Sin nada pendiente, un "gracias" no pide respuesta. Contestar por
    // contestar es lo que hacía que Clarck dijera "el bot habla mucho".
    return { respuesta: null, regla: 'acuse/nada' };
  }

  // Saludo pelado. Al que no conocemos le va la bienvenida de Config (eso ya lo
  // hace atajos.js); acá se atiende al CONOCIDO, que hasta ahora iba a la IA
  // para que dijera "hola" — 7.8% de los mensajes del mes.
  if (SALUDO.test(t) && lead?.nombre) {
    const hola = `¡Hola ${primerNombre(lead.nombre)}!`;
    if (yo.que === 'reservado') {
      return { respuesta: `${hola} Te tengo el cupo del ${cuandoYDonde(yo.insc)} — mándame la foto del Yape y quedas confirmado 🙏`, regla: 'saludo/falta-pagar' };
    }
    if (yo.que === 'pagado') {
      return { respuesta: `${hola} Ya estás confirmado para el ${cuandoYDonde(yo.insc)} ⚽`, regla: 'saludo/ya-esta' };
    }
    if (yo.que === 'espera') {
      return { respuesta: `${hola} Estás en la lista de espera del ${cuandoYDonde(yo.insc)} — si se libera un lugar te aviso 🙏`, regla: 'saludo/espera' };
    }
    return { respuesta: `${hola} ¿Te anoto para alguna pichanga? Dime el día y la zona y te digo los cupos ⚽`, regla: 'saludo/conocido' };
  }

  // "ahí te yapeo". No es un pago: es una promesa. Lo único correcto es pedir
  // la captura — sin decir en ningún caso que ya quedó, porque no quedó.
  if (AVISA_QUE_PAGO.test(t)) {
    if (yo.que === 'pagado') {
      return { respuesta: `Ojo que ya te tengo pagado el ${cuandoYDonde(yo.insc)} ⚽ Si es por otra fecha, dime cuál 🙌`, regla: 'yapeo/ya-pago' };
    }
    return {
      respuesta: `Dale 🙏 Mándame la captura cuando lo hagas y te dejo confirmado en la lista${yo.que === 'reservado' ? ` del ${cuandoYDonde(yo.insc)}` : ''} ⚽`,
      regla: 'yapeo/pendiente',
    };
  }

  return null;   // que decida la IA
}

module.exports = { responder, situacion };
