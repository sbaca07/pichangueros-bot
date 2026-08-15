/**
 * El cerebro sabe qué día es y qué tan viejo es cada mensaje del historial.
 *
 *   node test-tiempo.js        (~5 s, sin red ni OpenAI)
 *
 * El 15/08 el bot le habló a Sebastian del "partido de mañana en Comas" y del
 * Yape pendiente — de una conversación del 12. Leía las últimas 12 líneas como
 * si fueran de recién. Este test fija las dos mitades del arreglo: el historial
 * viejo va fechado y el prompt dice en qué fecha estamos.
 *
 * También verifica que la llamada al modelo se mida (la pregunta recurrente de
 * Clarck, "¿por qué se demora?", que hasta ahora respondíamos a ojo).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pich-tmp-'));
process.env.WWEBJS_AUTH_PATH = TMP;
process.env.OPENAI_API_KEY = 'sk-test-no-se-usa';
process.env.OPENAI_BASE_URL = 'https://fake.local/v1/';
process.env.OPENAI_MODEL = 'modelo-de-prueba';

// El SDK de OpenAI trae su propio cliente HTTP (no pasa por globalThis.fetch),
// así que se reemplaza el módulo entero antes de que brain.js lo cargue.
let pedido = null;
const RESPUESTA = { reply: 'ok', nombre: null, edad: null, distrito: null, zona: null, handoff: false, handoff_motivo: null, inscribir_partido: null };
class FakeOpenAI {
  constructor(opts) {
    this.opts = opts;
    this.chat = { completions: { create: async (params) => {
      pedido = params;
      await new Promise((r) => setTimeout(r, 60)); // que el cronómetro tenga algo que medir
      return { choices: [{ message: { content: JSON.stringify(RESPUESTA) } }], usage: { total_tokens: 1234 } };
    } } };
  }
}
const rutaOpenAI = require.resolve('openai');
require.cache[rutaOpenAI] = { id: rutaOpenAI, filename: rutaOpenAI, loaded: true, exports: FakeOpenAI };

const brain = require('./src/brain');
const db = require('./src/db');

let ok = 0, fallos = 0;
const check = (nombre, cond) => { if (cond) { ok++; console.log(`  ✓ ${nombre}`); } else { fallos++; console.error(`  ✗ ${nombre}`); } };

// Fecha en hora de Lima, N minutos atrás, con el formato que guarda la BD.
const haceMin = (min) => new Date(Date.now() - 5 * 3600e3 - min * 60000).toISOString().slice(0, 19).replace('T', ' ');

(async () => {
  console.log('== 1 · antiguedad(): sólo marca lo que ya no es de la misma charla ==');
  check('un mensaje de recién no se marca', brain.antiguedad(haceMin(5)) === null);
  check('uno de hace una hora tampoco', brain.antiguedad(haceMin(60)) === null);
  check('a las 3 h dice las horas', brain.antiguedad(haceMin(180)) === 'hace 3 h');
  check('a las 26 h dice "ayer"', brain.antiguedad(haceMin(26 * 60)) === 'ayer');
  check('a los 3 días dice los días', brain.antiguedad(haceMin(3 * 24 * 60)) === 'hace 3 días');
  check('sin fecha no revienta', brain.antiguedad(null) === null && brain.antiguedad('cualquier cosa') === null);

  console.log('== 2 · El historial viejo llega fechado al modelo ==');
  const lead = { nombre: 'Sebastian', edad: 25, distrito: 'Comas', zona: 'comas', estado: 'datos_completos' };
  const historial = [
    { rol: 'user', texto: 'Estoy interesado en el de 8 a 9 de comas', creado_en: haceMin(3 * 24 * 60) },
    { rol: 'assistant', texto: 'Te reservo el cupo para mañana jueves 13', creado_en: haceMin(3 * 24 * 60) },
    { rol: 'user', texto: 'ya te mando el yape', creado_en: haceMin(20) },
  ];
  await brain.pensar(lead, historial, 'Hola');

  const msgs = pedido.messages;
  const viejo = msgs.find((m) => /Estoy interesado/.test(m.content));
  const reciente = msgs.find((m) => /ya te mando el yape/.test(m.content));
  check('el mensaje de hace 3 días va marcado', /^\[hace 3 días\]/.test(viejo.content));
  check('la respuesta vieja del bot también', msgs.some((m) => /^\[hace 3 días\] Te reservo/.test(m.content)));
  check('el de hace 20 min va limpio', reciente.content === 'ya te mando el yape');
  check('el mensaje nuevo va limpio', msgs[msgs.length - 1].content === 'Hola');

  console.log('== 3 · El prompt dice en qué fecha estamos ==');
  const system = msgs[0].content;
  const hoy = db.fechaBonita(db.hoyLima(), { relativa: false });
  check(`el system prompt trae la fecha de hoy (${hoy})`, system.includes(hoy));
  check('y la regla de no revivir partidos viejos', /NO es mañana|ya se jugó/.test(system));

  console.log('== 4 · La llamada al modelo se mide ==');
  const logs = [];
  const orig = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  await brain.pensar(lead, historial, 'Hola de nuevo');
  console.log = orig;
  const medicion = logs.find((l) => l.startsWith('[brain]'));
  check('se loguea la duración', /^\[brain\] \d+ ms/.test(medicion || ''));
  check('con el modelo que respondió', /modelo-de-prueba/.test(medicion || ''));
  check('y los tokens gastados', /1234 tokens/.test(medicion || ''));

  console.log(`\n${fallos ? '❌' : '✅'} ${ok} checks OK, ${fallos} fallos`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  process.exit(fallos ? 1 : 0);
})();
