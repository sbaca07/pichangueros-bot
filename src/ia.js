/**
 * La cadena de modelos — que nunca nos quedemos sin cerebro.
 *
 * El 2026-09-08, primer día del bot encendido, el cerebro acumuló 27 fallas
 * seguidas y desde las 06:47 el bot contestaba "se me cruzaron los cables" a
 * todo el mundo. La causa no fue que la IA estuviera caída: el modelo principal
 * respondía bien. Fue que el ÚNICO respaldo configurado (`gemini-flash-latest`)
 * se colgaba —25 s sin devolver nada, ni error— y el código:
 *
 *   1. tenía un solo respaldo, así que si ése fallaba no había tercero;
 *   2. lo intentaba UNA vez y se rendía;
 *   3. solo cambiaba de modelo ante 429/503 — un modelo colgado, un 404 o un
 *      JSON cortado no daban derecho a probar otro;
 *   4. llamaba SIN timeout, así que "colgado" significaba colgado de verdad.
 *
 * Y esa lógica estaba copiada en tres lugares (brain.js y dos veces en
 * pagos.js), así que arreglarla en uno dejaba los otros dos rotos. Acá está una
 * sola vez.
 *
 * La regla: se recorre la cadena hasta que uno conteste. Solo se corta antes de
 * tiempo si el error va a repetirse igual en todos (key inválida, prompt mal
 * armado) o si ya se gastó el presupuesto de espera — hacer esperar dos minutos
 * a alguien que escribió por WhatsApp es otra forma de no contestarle.
 */
// El SDK se pide dentro de pedirA(), no acá: ver el comentario ahí abajo.

// Cadena por defecto en Gemini. Están PROBADAS contra la key del proyecto el
// 2026-09-08: las tres responden. Ojo que la API lista modelos que después dan
// 404 al usarlos (gemini-2.5-flash y gemini-2.5-flash-lite, ese día), así que
// figurar en /models no alcanza para ponerlo acá.
//
// Son tres modelos DISTINTOS a propósito: en Gemini la cuota por minuto es por
// modelo, así que el respaldo es un tanque lleno, no la misma fila de espera.
const CADENA_GOOGLE = ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite', 'gemini-flash-lite-latest'];

// Cuánto se espera a UN modelo antes de darlo por colgado y pasar al siguiente.
// 25 s es de sobra: el mismo modelo tarda 1-2 s cuando está sano, y el log ya
// marcaba "LENTO" a los 15 s.
const TIMEOUT_MS = () => Number(process.env.OPENAI_TIMEOUT_MS || 25000);
// Techo de toda la cadena. Sin esto, 3 modelos colgados = 75 s de espera para
// terminar igual en la disculpa: peor que fallar rápido.
const PRESUPUESTO_MS = () => Number(process.env.OPENAI_PRESUPUESTO_MS || 60000);

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

/* ─────────────────────────────────────────────────────────────────────────
 * LA COLA: de a pocos, no todos juntos.
 *
 * Medido el 2026-09-08 con 30 conversaciones REALES entrando a la vez y el
 * cerebro de verdad: los TRES modelos devolvieron 429 al mismo tiempo y 10 de
 * las 30 personas recibieron la disculpa. La cadena hizo su parte —20 se
 * salvaron con el respaldo— pero cuando el pico es simultáneo no hay a dónde
 * ir: la cuota del tier gratis de Gemini es POR MINUTO, y treinta llamadas en
 * el mismo segundo la revientan.
 *
 * Más modelos no lo arreglan. Lo que lo arregla es no disparar todo junto: cada
 * respuesta tarda 1-3 s, así que de a 4 las treinta entran igual en ~15 s y
 * ninguna da 429. Al jugador le llega la respuesta unos segundos después; la
 * alternativa era que a uno de cada tres no le llegara nada.
 *
 * Es un lunes 8am de Pichangueros, que es cuando sale la convocatoria y
 * escriben todos a la vez.
 * ───────────────────────────────────────────────────────────────────────── */
const MAX_EN_VUELO = () => Math.max(1, Number(process.env.OPENAI_CONCURRENCIA || 4));
// Techo de la espera en la cola. Si la fila es tan larga que no llegamos nunca,
// vale más fallar y que salga la disculpa que dejar a alguien esperando dos
// minutos por un mensaje de WhatsApp.
const ESPERA_MAX_MS = () => Number(process.env.OPENAI_ESPERA_MAX_MS || 90000);

let enVuelo = 0;
const cola = [];

/**
 * Cuánto se usa la IA, contado por el que la usa.
 *
 * Sin esto, "cuánto gasta el bot" se respondía a ojo. Vive en memoria y se
 * reinicia con el deploy: es una foto del turno, no la contabilidad —para eso
 * está la BD. Lo que importa acá es ver, mientras el bot corre, si la cadena
 * está trabajando de más.
 */
const metricas = { desde: Date.now(), llamadas: 0, ok: 0, fallos: 0, tokens: 0, ms: 0, porModelo: {}, errores: {} };
function anotarUso(modelo, ok, ms, tokens) {
  const m = (metricas.porModelo[modelo] ||= { ok: 0, fallos: 0, tokens: 0, ms: 0 });
  if (ok) { m.ok++; metricas.ok++; m.tokens += tokens || 0; metricas.tokens += tokens || 0; }
  else m.fallos++;
  m.ms += ms || 0;
  metricas.ms += ms || 0;
}

function tomarTurno() {
  if (enVuelo < MAX_EN_VUELO()) { enVuelo++; return Promise.resolve(0); }
  return new Promise((resolve, reject) => {
    const item = { t0: Date.now() };
    item.resolve = () => resolve(Date.now() - item.t0);
    item.reject = reject;
    item.timer = setTimeout(() => {
      const i = cola.indexOf(item);
      if (i >= 0) cola.splice(i, 1);
      reject(new Error(`esperó ${ESPERA_MAX_MS()} ms en la cola de la IA sin llegar a su turno`));
    }, ESPERA_MAX_MS());
    cola.push(item);
  });
}

function soltarTurno() {
  const siguiente = cola.shift();
  // El turno se PASA, no se devuelve: si se hiciera enVuelo-- y el que sigue
  // volviera a pedir, entrarían dos por el mismo lugar.
  if (siguiente) { clearTimeout(siguiente.timer); siguiente.resolve(); }
  else enVuelo = Math.max(0, enVuelo - 1);
}

function esGoogle() {
  return (process.env.OPENAI_BASE_URL || '').includes('googleapis');
}

/**
 * Los modelos a intentar, en orden. El primero es OPENAI_MODEL; los que siguen
 * salen de OPENAI_MODEL_FALLBACK, que acepta VARIOS separados por coma (antes
 * era uno solo — de ahí que un respaldo colgado dejara al bot sin salida).
 */
function cadena() {
  const principal = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const respaldos = (process.env.OPENAI_MODEL_FALLBACK || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  // Los configurados van PRIMERO, pero no reemplazan a los probados: se suman
  // adelante. Si lo que hay en Render es exactamente el modelo que se cuelga
  // —que fue el caso el 8-sep— la cadena igual tiene a dónde seguir, sin que
  // nadie tenga que acordarse de corregir una variable de entorno a las 7 am.
  const resto = [...respaldos, ...(esGoogle() ? CADENA_GOOGLE : [])];
  // Set: si OPENAI_MODEL ya está en la cadena de respaldo no se prueba dos veces.
  return [...new Set([principal, ...resto])];
}

// PENITENCIA. Un modelo que acaba de fallar no se prueba de nuevo por un rato:
// sin esto, el modelo colgado del 8-sep se hubiera comido su timeout en CADA
// mensaje del día. No es un apagado — es "andá al final de la fila".
const penitencia = new Map();
// El 429 es la cuota del minuto: se perdona rápido, que para eso están los
// tanques separados. Lo demás (colgado, 404, 5xx, JSON cortado) es un problema
// del modelo y merece más banco.
const PENITENCIA_CUOTA_MS = 60 * 1000;
const PENITENCIA_MS = 5 * 60 * 1000;

function penar(modelo, e) {
  const ms = e?.status === 429 ? PENITENCIA_CUOTA_MS : PENITENCIA_MS;
  penitencia.set(modelo, Date.now() + ms);
}

function enPenitencia(modelo) {
  const hasta = penitencia.get(modelo) || 0;
  if (hasta <= Date.now()) { penitencia.delete(modelo); return false; }
  return true;
}

/**
 * ¿Este error se va a repetir igual en todos los modelos? Si la key está mal o
 * el prompt no compila, recorrer la cadena son tres llamadas para el mismo
 * error. El 404 NO entra acá: significa "ese modelo no existe para esta key",
 * que es exactamente cuando el siguiente sirve.
 */
function esDefinitivo(e) {
  return [400, 401, 403].includes(e?.status);
}

/**
 * Una llamada a UN modelo. Existe separada para que los tests puedan guionar
 * qué contesta cada uno sin tocar la red (se reemplaza `ia.pedirA`).
 */
async function pedirA(modelo, params, timeoutMs) {
  // El cliente se arma en cada llamada, no una vez: construirlo es armar un
  // objeto de config (el HTTP lo hace igual por request), y guardarlo hacía que
  // un cambio de key, de base URL o —en los tests— del SDK entero no se notara
  // nunca. Barato, y una clase menos de "quedó pegado el de antes".
  const OpenAI = require('openai');
  const cliente = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: process.env.OPENAI_BASE_URL || undefined,
  });
  // maxRetries 0: los reintentos los maneja la cadena. Los del SDK son al MISMO
  // modelo y con espera propia, así que multiplicaban el tiempo para insistirle
  // justo al que no anda.
  return cliente.chat.completions.create({ model: modelo, ...params }, { timeout: timeoutMs, maxRetries: 0 });
}

/**
 * Recorre la cadena hasta que un modelo conteste con JSON válido.
 *
 * @param {object} params      cuerpo de la llamada (sin `model`)
 * @param {object} [opciones]  { etiqueta } para el log ('brain', 'pagos', …) y
 *                             { extra } lo que se agrega al final de la línea.
 * @returns {Promise<{json: object, modelo: string, ms: number, tokens: number|undefined, intentos: number}>}
 * @throws  el último error, si NINGÚN modelo pudo contestar
 */
async function llamar(params, { etiqueta = 'ia', extra = '' } = {}) {
  if (!process.env.OPENAI_API_KEY) throw new Error('No hay OPENAI_API_KEY');

  // Se hace fila ANTES de mirar el reloj: lo que se mide es la llamada, y el
  // presupuesto de la cadena no se puede gastar esperando turno.
  const esperoEnCola = await tomarTurno();
  if (esperoEnCola > 1500) console.log(`[${etiqueta}] esperó ${esperoEnCola} ms en la cola (${cola.length} atrás).`);
  try {
    return await recorrerCadena(params, etiqueta, extra);
  } finally {
    soltarTurno();
  }
}

async function recorrerCadena(params, etiqueta, extra) {
  const todos = cadena();
  const sanos = todos.filter((m) => !enPenitencia(m));
  // Si están TODOS penados igual se intentan: la penitencia sirve para elegir
  // mejor, no para quedarse callado. Nunca sin cerebro.
  const orden = sanos.length ? sanos : todos;

  const t0 = Date.now();
  const timeout = TIMEOUT_MS();
  const presupuesto = PRESUPUESTO_MS();
  let ultimoError = null;
  let intentos = 0;

  for (const modelo of orden) {
    // Antes de gastar otra llamada: ¿queda tiempo para que sirva de algo?
    const gastado = Date.now() - t0;
    if (intentos > 0 && gastado >= presupuesto) {
      console.warn(`[${etiqueta}] se acabó el presupuesto (${gastado} ms) tras ${intentos} modelo(s) — no se prueba ${modelo}.`);
      break;
    }
    intentos++;
    metricas.llamadas++;
    // t1 se declara ANTES del try: el catch también lo necesita para medir
    // cuánto tardó en fallar (un modelo colgado tarda su timeout entero).
    const t1 = Date.now();
    try {
      // Vía module.exports (no la referencia interna) para que los tests puedan
      // guionar qué contesta cada modelo, igual que con pagos.leerVoucher.
      const completion = await module.exports.pedirA(modelo, params, Math.min(timeout, Math.max(presupuesto - gastado, 1000)));
      // Un JSON cortado cuenta como falla del modelo, no de la cadena: antes
      // reventaba acá afuera y el bot pedía disculpas teniendo dos modelos sin
      // usar. (Pasaba de verdad: "Unterminated string" con max_tokens corto.)
      const json = JSON.parse(completion.choices?.[0]?.message?.content ?? '');
      const ms = Date.now() - t1;
      penitencia.delete(modelo);
      const tokens = completion.usage?.total_tokens;
      anotarUso(modelo, true, ms, tokens);
      // El formato lo cuida test-tiempo.js: cuánto tarda el cerebro es LA
      // pregunta recurrente de Clarck ("se demora") y hasta el 15/08 se
      // respondía a ojo porque no se medía en ninguna parte.
      const linea = `[${etiqueta}] ${ms} ms · ${modelo}${tokens ? ` · ${tokens} tokens` : ''}${extra ? ` · ${extra}` : ''}${intentos > 1 ? ` · respaldo #${intentos}` : ''}`;
      if (ms > 15000) console.warn(`${linea} ← LENTO`);
      else console.log(linea);
      return { json, modelo, ms, tokens, intentos };
    } catch (e) {
      ultimoError = e;
      anotarUso(modelo, false, Date.now() - t1, 0);
      const clave = String(e.status || e.name || 'error');
      metricas.errores[clave] = (metricas.errores[clave] || 0) + 1;
      if (esDefinitivo(e)) {
        // No es el modelo: es la key o el prompt. Probar otro es gastar dos
        // llamadas más para leer el mismo error.
        console.error(`[${etiqueta}] ${e.status} con ${modelo} — no es del modelo, no se prueba otro: ${e.message}`);
        throw e;
      }
      penar(modelo, e);
      console.warn(`[${etiqueta}] falló ${modelo} (${e.status || e.name || 'error'}: ${e.message}) — sigo con el próximo.`);
      // Un respiro solo ante cuota: el modelo siguiente tiene su propio tanque,
      // pero si el 429 vino de un pico compartido, 1.5 s ayudan. A un modelo
      // colgado no se le espera nada: ya esperamos su timeout entero.
      if (e?.status === 429) await espera(1500);
    }
  }

  const err = ultimoError || new Error('La cadena de modelos quedó vacía');
  console.error(`[${etiqueta}] NINGÚN modelo contestó tras ${intentos} intento(s) en ${Date.now() - t0} ms: ${err.message}`);
  throw err;
}

module.exports = {
  llamar,
  pedirA, // seam para los tests
  cadena,
  // Para GET /: qué modelos hay y cuáles están en el banco ahora mismo. La
  // lección de siempre — si se degrada en silencio, nadie se entera.
  estado: () => ({
    cadena: cadena(),
    // Cuántas llamadas hay en el aire y cuántas esperando turno. Un número que
    // crece y no baja es la señal de que la IA está lenta y la fila se acumula.
    enVuelo,
    enCola: cola.length,
    concurrencia: MAX_EN_VUELO(),
    // El uso desde que arrancó el proceso: para responder "¿cuánto está
    // gastando el bot?" con un número en vez de con una impresión.
    uso: {
      desdeMin: Math.round((Date.now() - metricas.desde) / 60000),
      llamadas: metricas.llamadas,
      ok: metricas.ok,
      fallos: metricas.llamadas - metricas.ok,
      tokens: metricas.tokens,
      msPromedio: metricas.ok ? Math.round(metricas.ms / metricas.llamadas) : 0,
      porModelo: metricas.porModelo,
      errores: metricas.errores,
    },
    penados: [...penitencia.entries()]
      .filter(([, hasta]) => hasta > Date.now())
      .map(([modelo, hasta]) => ({ modelo, segundos: Math.round((hasta - Date.now()) / 1000) })),
  }),
  _olvidarPenitencia: () => penitencia.clear(), // tests
};
