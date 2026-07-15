/**
 * Pagos por Yape (voucher + IA) — Semana 4.
 *
 * El jugador manda la captura de su Yape; una sola llamada a OpenAI (visión)
 * lee monto, nombre del remitente y número de operación. Con eso:
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

let client = null;
function getClient() {
  if (!process.env.OPENAI_API_KEY) return null;
  if (!client) client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return client;
}

const RESPONSE_SCHEMA = {
  name: 'lectura_voucher_yape',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      es_voucher_yape: { type: 'boolean', description: 'true si la imagen es un comprobante de pago de Yape (u otra app de pagos peruana similar).' },
      medio: {
        type: 'string',
        enum: ['yape', 'plin', 'bcp', 'interbank', 'otro'],
        description: 'De qué app o banco es el comprobante (por logo/colores/diseño). Si no es un voucher o no se distingue: otro.',
      },
      monto: { type: ['number', 'null'], description: 'Monto pagado en soles, ej. 15.00' },
      nombre_remitente: { type: ['string', 'null'], description: 'Nombre de quien envió el pago, tal como aparece en el voucher.' },
      numero_operacion: { type: ['string', 'null'], description: 'Número o código de operación/transacción del voucher.' },
      confianza: { type: 'string', enum: ['alta', 'media', 'baja'], description: 'Qué tan seguro estás de la lectura (borrosa, cortada, etc. → baja).' },
    },
    required: ['es_voucher_yape', 'medio', 'monto', 'nombre_remitente', 'numero_operacion', 'confianza'],
  },
};

/** @returns {Promise<null|object>} null si el cerebro está apagado o la llamada falló. */
async function leerVoucher(imageBuffer) {
  const openai = getClient();
  if (!openai) return null;
  try {
    const completion = await openai.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: 'Lees comprobantes de pago de Yape (app de pagos móviles de Perú). Extrae los datos exactos del voucher, sin inventar nada.' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Lee este comprobante de Yape y extrae monto, nombre del remitente y número de operación.' },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBuffer.toString('base64')}` } },
          ],
        },
      ],
      response_format: { type: 'json_schema', json_schema: RESPONSE_SCHEMA },
      temperature: 0.2,
      max_tokens: 300,
    });
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

  if (db.buscarPagoConfirmado(numeroOperacion)) {
    return {
      estado: 'revisar', motivo: 'Número de operación repetido (posible reenvío)', monto, titular, numeroOperacion,
      respuesta: 'Este comprobante ya lo teníamos registrado 🤔 Si es un error, Clarck te escribe para revisarlo.',
      handoff: true, motivoHandoff: 'Voucher con número de operación repetido',
    };
  }

  // El monto puede ser un MÚLTIPLO del precio: la gente paga por sus amigos
  // ("me anota con 2 más" → 3 × precio) o por ambos turnos (2 × precio).
  // Se acepta de 1 a 10 cupos exactos; cualquier otro monto queda "revisar".
  const precioEsperado = zona ? db.getNegocio().zonas[zona]?.precio : null;
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
  const lectura = await leerVoucher(imageBuffer);
  if (!lectura || !lectura.es_voucher_yape) return null;

  const r = evaluarVoucher(numero, zona, lectura);
  db.registrarPago({ numero, monto: r.monto, titular: r.titular, numero_operacion: r.numeroOperacion, estado: r.estado, motivo: r.motivo, medio: lectura.medio || 'yape', cupos: r.cupos });
  return { respuesta: r.respuesta, handoff: r.handoff, motivoHandoff: r.motivoHandoff };
}

module.exports = { leerVoucher, evaluarVoucher, procesarVoucher, cerebroActivo: () => Boolean(process.env.OPENAI_API_KEY) };
