/**
 * Pagos por app (comprobante + IA) — Semana 4.
 *
 * El jugador manda la captura de su pago — Yape, Plin, o el app de su banco:
 * los tres valen igual — y una sola llamada a la visión lee monto, nombre del
 * remitente y número de operación. Con eso:
 *   1. Anti-reenvío: si ese número de operación ya fue confirmado antes, se
 *      marca "revisar" (posible reenvío del mismo comprobante).
 *   2. Si el monto no coincide con el precio de la zona del contacto (config
 *      del panel admin), también queda "revisar".
 *   3. Si todo calza, queda "confirmado" y se le avisa al jugador.
 *
 * Todavía NO existe un concepto de "partido/fecha" (eso es Semana 5, listas
 * automáticas) — el pago se registra contra el CONTACTO, no contra una
 * convocatoria puntual.
 */
const OpenAI = require('openai');
const db = require('./db');

const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
// Mismo respaldo anti-429 que brain.js: en Gemini cada modelo tiene su cuota.
const ES_GOOGLE = (process.env.OPENAI_BASE_URL || '').includes('googleapis');
const MODEL_RESPALDO = process.env.OPENAI_MODEL_FALLBACK || (ES_GOOGLE ? 'gemini-3.1-flash-lite' : null);
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

let client = null;
function getClient() {
  if (!process.env.OPENAI_API_KEY) return null;
  // Mismo soporte multi-proveedor que brain.js (OPENAI_BASE_URL → Gemini, etc.).
  if (!client) client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, baseURL: process.env.OPENAI_BASE_URL || undefined });
  return client;
}

const RESPONSE_SCHEMA = {
  name: 'lectura_comprobante_pago',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      // Se llamaba `es_voucher_yape` y el nombre sesgaba al modelo: un
      // comprobante de PLIN legítimo volvía con false/otro/monto null y
      // confianza alta — "no es un voucher de Yape", literal. La pichanga se
      // paga por cualquier app peruana, así que el campo pregunta por el pago,
      // no por la marca.
      es_comprobante_pago: { type: 'boolean', description: 'true si la imagen es un comprobante de un pago ya realizado, de CUALQUIER app o banco peruano (Yape, Plin, BCP, Interbank, BBVA, Scotiabank, etc.).' },
      medio: {
        type: 'string',
        enum: ['yape', 'plin', 'bcp', 'interbank', 'bbva', 'scotiabank', 'otro'],
        description: 'De qué app o banco es el comprobante (por logo/colores/diseño). Solo "otro" si no se distingue la marca.',
      },
      monto: { type: ['number', 'null'], description: 'Monto pagado en soles, ej. 15.00' },
      nombre_remitente: { type: ['string', 'null'], description: 'Nombre de quien envió el pago, tal como aparece en el voucher.' },
      numero_operacion: { type: ['string', 'null'], description: 'Número o código de operación/transacción del voucher.' },
      destinatario: { type: ['string', 'null'], description: 'A QUIÉN se le pagó: nombre del beneficiario, empresa o banco de destino tal como aparece (ej. "Clarck V.", "Amaretti Import Sac", "BBVA Perú"). null si no se ve.' },
      destino_ultimos_digitos: { type: ['string', 'null'], description: 'Los últimos dígitos visibles del número/cuenta de DESTINO (ej. de "*** *** 172" devuelve "172"). null si no se ve.' },
      confianza: { type: 'string', enum: ['alta', 'media', 'baja'], description: 'Qué tan seguro estás de la lectura (borrosa, cortada, etc. → baja).' },
    },
    required: ['es_comprobante_pago', 'medio', 'monto', 'nombre_remitente', 'numero_operacion', 'destinatario', 'destino_ultimos_digitos', 'confianza'],
  },
};

/**
 * Tipo real de la imagen, leído de los bytes. Antes se mandaba TODO como
 * `data:image/jpeg`: una captura PNG (compartida directo desde la app de pagos,
 * sin pasar por la cámara) viajaba mal etiquetada y el modelo respondía como si
 * no hubiera visto nada. Se sniffea el buffer en vez de confiar en lo que
 * declara el transporte, que no siempre lo trae.
 */
function mimeDeImagen(buf) {
  if (!buf || buf.length < 12) return 'image/jpeg';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG') return 'image/png';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  // HEIC/HEIF de iPhone: caja `ftyp` en el offset 4, marca en el 8.
  if (buf.toString('ascii', 4, 8) === 'ftyp' && /^(heic|heix|heim|heis|hevc|mif1|msf1)/.test(buf.toString('ascii', 8, 12))) return 'image/heic';
  return 'image/jpeg'; // lo más probable en WhatsApp; mejor intentar que abortar
}

/** @returns {Promise<null|object>} null si el cerebro está apagado o la llamada falló. */
async function leerVoucher(imageBuffer) {
  const openai = getClient();
  if (!openai) return null;
  const params = {
    messages: [
      { role: 'system', content: 'Lees comprobantes de pago móvil peruanos. Cuenta como comprobante el de CUALQUIER app o banco — Yape, Plin, BCP, Interbank, BBVA, Scotiabank, Banco de la Nación — no solo Yape: para el negocio valen todos igual. Extrae los datos exactos, sin inventar nada. Sé GENEROSO al reconocer: una captura de pantalla de la app con un monto y un destinatario ES un comprobante, aunque esté recortada, con brillo raro o le falte algún dato. Solo marca es_comprobante_pago=false si claramente NO es un pago (una foto de una cancha, un meme, una persona).' },
      {
        role: 'user',
        content: [
          { type: 'text', text: '¿Es un comprobante de pago? Si lo es, extrae monto, nombre del remitente y número de operación.' },
          { type: 'image_url', image_url: { url: `data:${mimeDeImagen(imageBuffer)};base64,${imageBuffer.toString('base64')}` } },
        ],
      },
    ],
    response_format: { type: 'json_schema', json_schema: RESPONSE_SCHEMA },
    temperature: 0.2,
    // Margen para modelos pensantes (ver el comentario gemelo en brain.js).
    max_tokens: 1500,
    ...(ES_GOOGLE ? { reasoning_effort: 'low' } : {}),
  };
  try {
    let completion;
    try {
      completion = await openai.chat.completions.create({ model: MODEL, ...params });
    } catch (e) {
      if (![429, 503].includes(e.status) || !MODEL_RESPALDO) throw e;
      console.warn(`[pagos] ${e.status} con ${MODEL} — reintento con ${MODEL_RESPALDO}.`);
      await espera(1500);
      completion = await openai.chat.completions.create({ model: MODEL_RESPALDO, ...params });
    }
    return JSON.parse(completion.choices[0].message.content);
  } catch (e) {
    console.error('[pagos] Error leyendo voucher:', e.message);
    return null;
  }
}

/**
 * Decide qué hacer con una lectura ya hecha (sin llamadas a red — testeable).
 * @param {string} numero
 * @param {string|null} zona
 * @param {object} lectura   lo que devuelve leerVoucher()
 * @returns {{estado: string, motivo: string|null, respuesta: string, handoff: boolean, monto: number|null, titular: string|null, numeroOperacion: string|null}}
 */
function evaluarVoucher(numero, zona, lectura) {
  const monto = lectura.monto;
  const titular = lectura.nombre_remitente;
  const numeroOperacion = lectura.numero_operacion;

  if (!numeroOperacion || lectura.confianza === 'baja') {
    return {
      estado: 'revisar', motivo: 'No se pudo leer con confianza', monto, titular, numeroOperacion,
      respuesta: 'No pude leer bien tu comprobante 🧐 ¿me lo mandas de nuevo, bien enfocado y completo?',
      handoff: false,
    };
  }

  // ¿EL PAGO ES PARA NOSOTROS? Un comprobante puede ser real y aun así no
  // tener nada que ver con la pichanga (Mauricio mandó uno de S/210 de
  // "Amaretti Import Sac" a "BBVA Perú"). Se compara contra el Yape del
  // negocio por los últimos dígitos del destino — la señal más confiable.
  // Solo se rechaza con evidencia clara: si el voucher no muestra destino,
  // se sigue como antes (mejor pasar uno dudoso que frenar uno legítimo).
  const yapeNegocio = (db.getNegocio().yape.numero || '').replace(/\D/g, '');
  const digitosDestino = String(lectura.destino_ultimos_digitos || '').replace(/\D/g, '');
  if (yapeNegocio.length >= 3 && digitosDestino.length >= 3 && !yapeNegocio.endsWith(digitosDestino.slice(-3))) {
    return {
      estado: 'revisar',
      motivo: `Pago a OTRO destinatario: ${lectura.destinatario || '¿?'} (…${digitosDestino}), no al Yape del negocio (…${yapeNegocio.slice(-3)})`,
      monto, titular, numeroOperacion, cupos: 1,
      respuesta: `Ese comprobante es de otro pago 🧐 (aparece a nombre de ${lectura.destinatario || 'otro destinatario'}). Para tu cupo, el Yape va al ${db.getNegocio().yape.numero} (${db.getNegocio().yape.titular}) — mándame esa captura y te confirmo al toque ⚽`,
      handoff: false, // no molesta a Clarck: el jugador puede corregirlo solo
    };
  }

  // Reenvío: no es "posible", es un hecho — se registra CONTRA QUÉ pago choca
  // (quién, cuándo, cuánto) para que Clarck lo vea con evidencia.
  const previo = db.buscarPagoConfirmado(numeroOperacion);
  if (previo) {
    const cuando = (previo.creado_en || '').slice(0, 16);
    return {
      estado: 'revisar',
      motivo: `Nº de operación ${numeroOperacion} YA confirmado antes: S/${previo.monto} de +${previo.numero} el ${cuando}`,
      monto, titular, numeroOperacion,
      respuesta: 'Ese comprobante ya lo tenemos registrado (mismo número de operación) 🧐 Si crees que es un error, Clarck lo revisa contigo en un momento.',
      handoff: true,
      motivoHandoff: `Voucher repetido: op. ${numeroOperacion} ya confirmado (S/${previo.monto} de wa.me/${previo.numero} el ${cuando})`,
    };
  }

  // El monto puede ser un MÚLTIPLO del precio: la gente paga por sus amigos
  // ("me anota con 2 más" → 3 × precio) o por ambos turnos (2 × precio).
  // Se acepta de 1 a 10 cupos exactos; cualquier otro monto queda "revisar".
  //
  // El precio a validar es EL DEL PARTIDO RESERVADO cuando existe (puede tener
  // precio custom, o ser de otra zona — jugador multi-distrito). Solo si no hay
  // reserva se usa el precio de la zona del contacto.
  const reservaP = db.partidoReservadoDe(numero, monto);
  const negocioP = db.getNegocio();
  const precioEsperado = reservaP
    ? (reservaP.precio ?? negocioP.zonas[reservaP.zona]?.precio ?? null)
    : (zona ? negocioP.zonas[zona]?.precio : null);
  let cupos = 1;
  if (precioEsperado != null && precioEsperado > 0 && monto != null) {
    const n = Math.round(monto / precioEsperado);
    const esMultiplo = n >= 1 && n <= 10 && Math.abs(monto - n * precioEsperado) <= 0.5;
    if (!esMultiplo) {
      return {
        estado: 'revisar', motivo: `Monto S/${monto} no es múltiplo del precio de la zona (S/${precioEsperado})`, monto, titular, numeroOperacion, cupos: 1,
        respuesta: 'Recibí tu comprobante, pero el monto no calza con el precio de tu zona — Clarck lo revisa en un momento 🙏',
        handoff: true, motivoHandoff: `Monto Yape no calza (S/${monto} vs S/${precioEsperado})`,
      };
    }
    cupos = n;
  }

  return {
    estado: 'confirmado', motivo: null, monto, titular, numeroOperacion, cupos,
    respuesta: cupos > 1
      ? `¡Listo! Registramos tu pago de S/${monto} por ${cupos} cupos ✅⚽ Pásame los nombres de los otros ${cupos - 1} jugador${cupos - 1 === 1 ? '' : 'es'} porfa 📝`
      : `¡Listo! Registramos tu pago de S/${monto} ✅⚽`,
    handoff: false,
  };
}

/**
 * Flujo completo: lee la imagen + decide + guarda en BD.
 * @returns {Promise<null|{respuesta: string, handoff: boolean, motivoHandoff?: string}>}
 *          null si la imagen no es un voucher reconocible (deja que el cerebro conversacional normal responda).
 */
async function procesarVoucher(numero, zona, imageBuffer) {
  // Vía module.exports (no la referencia interna) para que los tests puedan
  // inyectar lecturas simuladas sin llamar a OpenAI.
  const lectura = await module.exports.leerVoucher(imageBuffer);
  if (!lectura || !lectura.es_comprobante_pago) {
    // Sin este log, una imagen que la visión no reconoce desaparecía sin
    // rastro: el jugador dice "ya te yapeé" y no había forma de saber si
    // falló la descarga, el modelo o si de verdad no era un comprobante.
    // El formato va en el log porque un PNG mal etiquetado ya nos costó cuatro
    // comprobantes el 12-ago: si vuelve a pasar, se ve en la misma línea.
    console.warn(`[pagos] ${numero}: la imagen NO se reconoció como comprobante`
      + (lectura ? ` (medio=${lectura.medio}, confianza=${lectura.confianza}, monto=${lectura.monto})` : ' (la lectura falló o volvió vacía)')
      + ` — ${imageBuffer?.length || 0} bytes, ${mimeDeImagen(imageBuffer)}.`);
    return null;
  }

  const r = evaluarVoucher(numero, zona, lectura);
  const pagoId = db.registrarPago({ numero, monto: r.monto, titular: r.titular, numero_operacion: r.numeroOperacion, estado: r.estado, motivo: r.motivo, medio: lectura.medio || 'yape', cupos: r.cupos });

  // Pago confirmado → cubrir el cupo del partido. Si el contacto tenía reserva
  // se marca pagada; si no, solo se le inscribe cuando hay UN único partido
  // abierto en su zona (sin adivinar). Si no se puede vincular, el pago queda
  // "sin partido" y Clarck lo asigna desde el panel — la respuesta no cambia.
  let respuesta = r.respuesta;
  if (r.estado === 'confirmado') {
    try {
      const v = db.vincularPago(numero, pagoId, r.cupos || 1, zona, r.monto);
      if (v) {
        const enCancha = v.inscripciones.filter((i) => i.estado === 'pagado').length;
        const p = v.partido;
        if (enCancha > 0) {
          respuesta += `\n📋 Ya estás en la lista del ${db.fechaBonita(p.fecha)}${p.hora ? ` de ${p.hora}` : ''}${p.sede ? ` en ${p.sede}` : ''}. ¡Nos vemos en la cancha!`;
        } else {
          respuesta += `\n⏳ El partido del ${db.fechaBonita(p.fecha)} está lleno: quedaste primero en la lista de espera y te avisamos si se libera un cupo.`;
        }
      } else if (db.partidosAbiertos().length) {
        // Sin reserva y con varios partidos posibles: en vez de dejar el pago
        // huérfano en el panel, se le pregunta al jugador — cuando responda y
        // se inscriba, index.js le pega este pago a su inscripción solo.
        respuesta += '\n📅 ¿Para qué pichanga es tu pago? Dime el día y la zona y te anoto en la lista ⚽';
      }
    } catch (e) { console.error('[pagos] Error vinculando pago a partido:', e.message); }
  }
  return { respuesta, handoff: r.handoff, motivoHandoff: r.motivoHandoff };
}

module.exports = { leerVoucher, evaluarVoucher, procesarVoucher, mimeDeImagen, cerebroActivo: () => Boolean(process.env.OPENAI_API_KEY) };
