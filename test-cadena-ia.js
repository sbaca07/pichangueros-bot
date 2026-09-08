/**
 * Nunca nos quedamos sin cerebro.
 *
 *   node test-cadena-ia.js        (~5 s, sin red)
 *
 * El 2026-09-08, primer día del bot encendido, el cerebro acumuló 27 fallas
 * seguidas: desde las 06:47 el bot contestaba "se me cruzaron los cables" a
 * todos y no se leyó NI UN voucher en todo el día (0 pagos). La IA no estaba
 * caída — el modelo principal respondía en 2 s. Lo que pasó fue que el único
 * respaldo configurado (`gemini-flash-latest`) se colgaba: 25 s sin devolver
 * nada, ni siquiera un error. Y el código de entonces:
 *
 *   - tenía UN solo respaldo, así que no había tercero al que ir;
 *   - lo intentaba una vez y se rendía;
 *   - solo cambiaba de modelo ante 429/503: un cuelgue, un 404 o un JSON
 *     cortado no daban derecho a probar otro;
 *   - llamaba sin timeout, así que un modelo colgado colgaba el mensaje.
 *
 * Estos checks son esa lista, al revés.
 */
const ia = require('./src/ia');

let ok = 0, fallos = 0;
const check = (nombre, cond) => { if (cond) { ok++; console.log(`  ✓ ${nombre}`); } else { fallos++; console.error(`  ✗ ${nombre}`); } };

process.env.OPENAI_API_KEY = 'sk-no-se-usa';
process.env.OPENAI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/';
process.env.OPENAI_MODEL = 'modelo-a';
process.env.OPENAI_MODEL_FALLBACK = 'modelo-b,modelo-c';
process.env.OPENAI_TIMEOUT_MS = '300';
process.env.OPENAI_PRESUPUESTO_MS = '5000';

// El banco de pruebas: se guiona qué hace CADA modelo y se anota a quién se
// llamó, en qué orden.
const llamados = [];
let guion = {};
const respuestaOk = (texto) => ({ choices: [{ message: { content: texto } }], usage: { total_tokens: 10 } });
const errorCon = (status) => Object.assign(new Error(`simulado ${status}`), { status });

ia.pedirA = async (modelo, params, timeoutMs) => {
  llamados.push({ modelo, timeoutMs });
  const g = guion[modelo];
  if (typeof g === 'function') return g();
  throw errorCon(500);
};

const conParams = { messages: [{ role: 'user', content: 'hola' }] };

(async () => {
  console.log('== 1 · La cadena sigue hasta que alguien conteste ==');
  ia._olvidarPenitencia(); llamados.length = 0;
  guion = {
    // Tal cual el 8-sep: el principal por cuota, el respaldo COLGADO (el error
    // que tira el SDK al vencer el timeout), y recién el tercero contesta.
    'modelo-a': () => { throw errorCon(429); },
    'modelo-b': () => { throw Object.assign(new Error('Request timed out.'), { name: 'APIConnectionTimeoutError' }); },
    'modelo-c': () => respuestaOk('{"reply":"listo"}'),
  };
  let r = await ia.llamar(conParams, { etiqueta: 'test' });
  check('contestó el tercer modelo (antes no existía un tercero)', r.json.reply === 'listo' && r.modelo === 'modelo-c');
  check('se probaron los tres, en orden', llamados.map((l) => l.modelo).join(',') === 'modelo-a,modelo-b,modelo-c');
  check('cada llamada lleva timeout (sin esto, un modelo colgado cuelga el mensaje)', llamados.every((l) => l.timeoutMs > 0));

  console.log('== 2 · Un modelo que acaba de fallar va al final de la fila ==');
  // Sin penitencia, el modelo colgado del 8-sep se comía su timeout en CADA
  // mensaje del día: 27 fallas seguidas son 27 esperas de 25 s.
  llamados.length = 0;
  guion['modelo-c'] = () => respuestaOk('{"reply":"de nuevo"}');
  r = await ia.llamar(conParams, { etiqueta: 'test' });
  check('el segundo mensaje va derecho al que anda', llamados.length === 1 && llamados[0].modelo === 'modelo-c');

  console.log('== 3 · Si TODOS están penados, igual se intenta ==');
  // La penitencia sirve para elegir mejor, no para quedarse callado.
  ia._olvidarPenitencia(); llamados.length = 0;
  guion = { 'modelo-a': () => { throw errorCon(500); }, 'modelo-b': () => { throw errorCon(500); }, 'modelo-c': () => { throw errorCon(500); } };
  let tiro = null;
  try { await ia.llamar(conParams, { etiqueta: 'test' }); } catch (e) { tiro = e; }
  check('con los tres caídos, avisa el error (el bot pide disculpas)', tiro !== null);
  llamados.length = 0;
  guion['modelo-b'] = () => respuestaOk('{"reply":"revivió"}');
  r = await ia.llamar(conParams, { etiqueta: 'test' });
  check('estando todos penados igual se recorre la cadena', r.json.reply === 'revivió');

  console.log('== 4 · Un JSON cortado es falla del modelo, no de la cadena ==');
  // Con max_tokens corto, Gemini devolvía el JSON a medias ("Unterminated
  // string") y el bot pedía disculpas teniendo dos modelos sin usar.
  ia._olvidarPenitencia(); llamados.length = 0;
  guion = {
    'modelo-a': () => respuestaOk('{"reply":"se cort'),
    'modelo-b': () => respuestaOk('{"reply":"entero"}'),
    'modelo-c': () => respuestaOk('{"reply":"no hizo falta"}'),
  };
  r = await ia.llamar(conParams, { etiqueta: 'test' });
  check('el JSON cortado manda al siguiente modelo', r.json.reply === 'entero');

  console.log('== 5 · Un 404 NO es motivo para rendirse ==');
  // La API de Google lista modelos que después dan 404 al usarlos (pasó con
  // gemini-2.5-flash el 8-sep). Ahí el siguiente de la cadena es justo lo que
  // hace falta. El viejo código solo miraba 429/503, así que se rendía.
  ia._olvidarPenitencia(); llamados.length = 0;
  guion = { 'modelo-a': () => { throw errorCon(404); }, 'modelo-b': () => respuestaOk('{"reply":"ese sí existe"}') };
  r = await ia.llamar(conParams, { etiqueta: 'test' });
  check('el 404 pasa al siguiente modelo', r.json.reply === 'ese sí existe');

  console.log('== 6 · La key mal puesta no se reintenta tres veces ==');
  // Un 401 va a dar 401 en los tres. Recorrer la cadena son dos llamadas más
  // para leer el mismo error, y dos esperas más para el jugador.
  ia._olvidarPenitencia(); llamados.length = 0;
  guion = { 'modelo-a': () => { throw errorCon(401); }, 'modelo-b': () => respuestaOk('{"reply":"no deberia llegar"}') };
  tiro = null;
  try { await ia.llamar(conParams, { etiqueta: 'test' }); } catch (e) { tiro = e; }
  check('con la key inválida se corta en el primero', tiro?.status === 401 && llamados.length === 1);

  console.log('== 7 · La cadena se arma del entorno ==');
  check('OPENAI_MODEL_FALLBACK acepta varios separados por coma',
    ia.cadena().slice(0, 3).join(',') === 'modelo-a,modelo-b,modelo-c');
  // Lo que hay en Render el 8-sep es un único respaldo, y es JUSTO el que se
  // cuelga. Si lo configurado reemplazara a la cadena probada, el arreglo
  // dependería de que alguien se acuerde de editar una variable de entorno.
  process.env.OPENAI_MODEL_FALLBACK = 'gemini-flash-latest';
  const conElColgado = ia.cadena();
  check('el respaldo configurado no borra a los probados', conElColgado.length > 2 && conElColgado[1] === 'gemini-flash-latest');
  process.env.OPENAI_MODEL_FALLBACK = '';
  check('sin respaldos configurados, en Gemini quedan los probados', ia.cadena().length === 4 && ia.cadena()[0] === 'modelo-a');
  process.env.OPENAI_MODEL = 'gemini-3.1-flash-lite';
  check('el principal no se prueba dos veces si ya está en la cadena', new Set(ia.cadena()).size === ia.cadena().length);
  process.env.OPENAI_MODEL_FALLBACK = 'modelo-b,modelo-c';

  console.log('== 8 · El presupuesto corta la espera ==');
  // Tres modelos colgados serían 75 s de espera para terminar igual en la
  // disculpa. A alguien que escribió por WhatsApp, eso es peor que fallar rápido.
  process.env.OPENAI_MODEL = 'modelo-a';
  process.env.OPENAI_PRESUPUESTO_MS = '150';
  process.env.OPENAI_TIMEOUT_MS = '100';
  ia._olvidarPenitencia(); llamados.length = 0;
  const lento = () => new Promise((_, rechazar) => setTimeout(() => rechazar(errorCon(500)), 120));
  guion = { 'modelo-a': lento, 'modelo-b': lento, 'modelo-c': lento };
  const t0 = Date.now();
  try { await ia.llamar(conParams, { etiqueta: 'test' }); } catch (_) {}
  const tardo = Date.now() - t0;
  check(`no recorrió los tres colgados (tardó ${tardo} ms, probó ${llamados.length})`, llamados.length < 3 && tardo < 400);

  console.log('== 9 · De a pocos, no todos juntos ==');
  // Medido el 8-sep con 30 conversaciones REALES entrando a la vez y el cerebro
  // de verdad: los tres modelos dieron 429 al mismo tiempo y 10 de las 30
  // personas recibieron la disculpa. La cuota del tier gratis es POR MINUTO, y
  // treinta llamadas en el mismo segundo la revientan. Con la fila, las treinta
  // entran igual y ninguna se pierde.
  process.env.OPENAI_CONCURRENCIA = '4';
  process.env.OPENAI_TIMEOUT_MS = '5000';
  process.env.OPENAI_PRESUPUESTO_MS = '10000';
  ia._olvidarPenitencia(); llamados.length = 0;
  let simultaneas = 0, pico = 0;
  ia.pedirA = async () => {
    simultaneas++; pico = Math.max(pico, simultaneas);
    await new Promise((r) => setTimeout(r, 80));
    simultaneas--;
    return respuestaOk('{"reply":"ok"}');
  };
  const t9 = Date.now();
  const treinta = await Promise.all(Array.from({ length: 30 }, () => ia.llamar(conParams, { etiqueta: 'test' })));
  check('las 30 llegaron a contestarse', treinta.every((r) => r.json.reply === 'ok'));
  check(`nunca hubo más de 4 llamadas a la vez (pico: ${pico})`, pico <= 4);
  check(`y no tardó una eternidad (${Date.now() - t9} ms)`, Date.now() - t9 < 4000);
  const estadoTrasCola = ia.estado();
  check('la fila quedó vacía al terminar', estadoTrasCola.enVuelo === 0 && estadoTrasCola.enCola === 0,
    `enVuelo=${estadoTrasCola.enVuelo} enCola=${estadoTrasCola.enCola}`);

  console.log('== 10 · Un error tampoco deja el lugar tomado ==');
  // Si el turno no se devolviera al fallar, cuatro errores dejarían la cola
  // trabada para siempre y el bot mudo sin que nadie sepa por qué.
  ia.pedirA = async () => { throw errorCon(500); };
  ia._olvidarPenitencia();
  await Promise.all(Array.from({ length: 6 }, () => ia.llamar(conParams, { etiqueta: 'test' }).catch(() => null)));
  const trasFallar = ia.estado();
  check('tras 6 fallas la fila sigue libre', trasFallar.enVuelo === 0 && trasFallar.enCola === 0,
    `enVuelo=${trasFallar.enVuelo} enCola=${trasFallar.enCola}`);
  ia.pedirA = async (modelo, params, timeoutMs) => {
    llamados.push({ modelo, timeoutMs });
    const g = guion[modelo];
    if (typeof g === 'function') return g();
    throw errorCon(500);
  };

  console.log('== 11 · El estado se puede mirar desde afuera ==');
  const estado = ia.estado();
  check('GET / muestra la cadena', Array.isArray(estado.cadena) && estado.cadena.length >= 2);
  check('GET / muestra quién está penado', Array.isArray(estado.penados) && estado.penados.length > 0);

  console.log(`\n${fallos === 0 ? '✅' : '❌'} ${ok} checks OK · ${fallos} fallos`);
  process.exit(fallos === 0 ? 0 : 1);
})();
