/**
 * Un lunes entero, de golpe: ¿aguanta la compuerta?
 *
 *   node test-carga.js        (~30 s, sin red)
 *
 * Los martes y lunes escriben ~97 personas por día, con picos de 151 (medido
 * el 2026-09-06 sobre 14 días). El tope de 20 es LA compuerta de la marcha
 * blanca: es lo único que decide a cuánta gente le llega un bug. Hasta ahora
 * se probaba con mensajes de a uno, que es justo el caso en que no puede
 * fallar.
 *
 * Lo que se mide acá es lo otro: mucha gente escribiendo A LA VEZ. Importa
 * porque `atendidosHoy()` cuenta las respuestas YA ESCRITAS, y la respuesta se
 * escribe recién cuando el cerebro terminó de pensar — unos 5 segundos. En esos
 * 5 segundos de un lunes a la mañana entran fácil 15 personas más, y todas ven
 * el mismo contador viejo.
 *
 * Mismo molde que test-rafagas.js: index.js real, red y cerebro simulados.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pich-carga-'));
process.env.WWEBJS_AUTH_PATH = TMP;
process.env.TRANSPORTE = 'meta';
process.env.META_TOKEN = 'dh_sim_key_valida_1234567890';
process.env.META_PHONE_NUMBER_ID = '123456789012345';
process.env.META_VERIFY_TOKEN = 'simtoken-abc-123';
process.env.META_NUMERO = '51967870413';
process.env.SAFE_MODE = 'false';
process.env.ADMIN_KEY = 'simadmin';
process.env.NOTIFY_NUMBER = '51999000111';
process.env.DEBOUNCE_MS = '300';
process.env.PORT = '34601';

const TOPE = 20;
const GENTE = 60;                 // más del triple del tope, como un lunes real
const NUMEROS = Array.from({ length: GENTE }, (_, i) => `5190044${String(i).padStart(4, '0')}`);
process.env.ALLOWED_TESTERS = '';  // con el bot encendido no hace falta lista
delete process.env.OPENAI_API_KEY;

const enviados = [];
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes('/messages') && opts.method === 'POST') {
    const body = JSON.parse(opts.body);
    if (body.text?.body) enviados.push({ a: body.to, texto: body.text.body });
    return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.sim' + enviados.length }] }) };
  }
  return { ok: true, status: 200, json: async () => ({ url: 'http://sim-media/bin' }), arrayBuffer: async () => new ArrayBuffer(4) };
};

// El cerebro, con la demora REAL medida en producción (~2 a 5 s). La demora es
// el punto: es la ventana en la que el contador de atendidos queda viejo.
let DEMORA = Number(process.env.DEMORA || 1200);
const brain = require('./src/brain');
let partidoDeTodos = null;
brain.cerebroActivo = () => true;
brain.pensar = async () => {
  await new Promise((r) => setTimeout(r, DEMORA));
  return {
    reply: 'Te guardo el cupo, mándame tu Yape 🙏',
    nombre: null, edad: null, distrito: null, zona: null,
    handoff: false, handoff_motivo: null,
    inscribir_partido: partidoDeTodos,
    nombres_invitados: null,
  };
};

const db = require('./src/db');
require('./index.js');

const BASE = 'http://127.0.0.1:34601';
const http = require('http');
const postJson = (ruta, obj) => new Promise((resolve, reject) => {
  const data = JSON.stringify(obj);
  const req = http.request(BASE + ruta, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
    let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b }));
  });
  req.on('error', reject); req.write(data); req.end();
});
let msgSeq = 0;
const escribe = (de, texto) => postJson('/webhook/meta', {
  object: 'whatsapp_business_account',
  entry: [{ id: 'WABA-SIM', changes: [{ field: 'messages', value: {
    messages: [{ id: `wamid.sim-${++msgSeq}`, from: de, type: 'text', text: { body: texto } }],
  } }] }],
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = 0, fallos = 0;
const check = (nombre, cond, extra) => {
  if (cond) { ok++; console.log(`  ✓ ${nombre}`); }
  else { fallos++; console.error(`  ✗ ${nombre}${extra ? ` — ${extra}` : ''}`); }
};
const atendidos = () => new Set(enviados.filter((e) => NUMEROS.includes(e.a)).map((e) => e.a));

(async () => {
  await sleep(800);
  db.setTopeNuevosDia(TOPE);
  const hoy = db.hoyLima();
  partidoDeTodos = db.crearPartido({ zona: 'comas', fecha: hoy, hora: '9-10pm', sede: 'Politécnico', cupo: 12, precio: 10 });
  check(`el tope quedó en ${TOPE}`, db.topeNuevosDia() === TOPE);

  console.log(`\n== 1 · ${GENTE} personas escriben A LA VEZ (tope ${TOPE}) ==`);
  const t0 = Date.now();
  // Todas de una: es lo que pasa un lunes 8am cuando sale la convocatoria.
  await Promise.all(NUMEROS.map((n) => escribe(n, 'Hola, quiero anotarme para hoy')));
  // Se espera a que la última pueda haber terminado de pensar y responder.
  await sleep(DEMORA + 6000);
  const cuantos = atendidos().size;
  console.log(`  → el bot le contestó a ${cuantos} personas de ${GENTE} · ${Date.now() - t0} ms`);
  check(`no le contestó a más de ${TOPE}`, cuantos <= TOPE, `contestó a ${cuantos}`);
  check('no se murió: siguió aceptando webhooks', msgSeq === GENTE);

  console.log('\n== 2 · Los que pasaron el tope no quedan como ficha vacía ==');
  const conFicha = NUMEROS.filter((n) => db.getLead(n)).length;
  check('a todos se les creó su ficha, contestados o no', conFicha === GENTE, `${conFicha}/${GENTE}`);

  console.log('\n== 3 · El cupo del partido no se pasa de 12 ==');
  // Que 30 personas pidan el mismo cupo a la vez es exactamente lo que pasa
  // cuando sale la convocatoria: el que sobra va a espera, no adentro.
  const filas = db.inscripcionesDe(partidoDeTodos);
  const dentro = filas.filter((i) => ['pagado', 'reservado'].includes(i.estado));
  const espera = filas.filter((i) => i.estado === 'espera');
  console.log(`  → cupo 12 · adentro ${dentro.length} · en espera ${espera.length}`);
  check('nunca entran más que el cupo', dentro.length <= 12, `entraron ${dentro.length}`);

  console.log('\n== 4 · Nadie quedó anotado dos veces ==');
  const porNumero = new Map();
  for (const i of filas.filter((f) => f.numero)) porNumero.set(i.numero, (porNumero.get(i.numero) || 0) + 1);
  const dobles = [...porNumero].filter(([, n]) => n > 1);
  check('ninguna inscripción duplicada', dobles.length === 0, dobles.map(([n, c]) => `${n}×${c}`).join(' '));

  console.log('\n== 5 · Al que ya entró se le sigue contestando, aunque el cupo esté lleno ==');
  // La otra mitad de la regla: gastó su cupo con el primer mensaje, y cortarle
  // la conversación a la mitad sería peor que no habérsela abierto.
  const yaEntro = [...atendidos()][0];
  const antesDe = enviados.filter((e) => e.a === yaEntro).length;
  await escribe(yaEntro, '¿y a qué hora tengo que llegar?');
  await sleep(DEMORA + 2500);
  check('le contestó de nuevo', enviados.filter((e) => e.a === yaEntro).length > antesDe);

  const quedoAfuera = NUMEROS.find((n) => !atendidos().has(n));
  const afueraAntes = enviados.filter((e) => e.a === quedoAfuera).length;
  await escribe(quedoAfuera, 'holaaa sigo esperando');
  await sleep(DEMORA + 2500);
  check('y al que quedó afuera sigue sin contestarle (lo atiende Clarck)', enviados.filter((e) => e.a === quedoAfuera).length === afueraAntes);
  check('el cupo sigue clavado en 20', atendidos().size === TOPE, `${atendidos().size}`);

  console.log('\n== 6 · La IA lenta, y Meta reintentando encima ==');
  // Cuando el cerebro tarda, el webhook queda sin contestar y Cloud API REENVÍA
  // el mismo mensaje. O sea que el peor momento para la IA es exactamente
  // cuando llega el doble de tráfico. Se deduplica por id de mensaje
  // (src/meta.js), pero eso nunca se había probado con todo entrando junto:
  // dos copias del mismo id procesándose a la vez es otra cosa que dos copias
  // seguidas.
  DEMORA = 3000;
  db.setTopeNuevosDia(0); // acá se mide el duplicado, no la compuerta
  const OTROS = Array.from({ length: 25 }, (_, i) => `5190055${String(i).padStart(4, '0')}`);
  const idsPorNumero = new Map();
  const conId = (de, texto, id) => postJson('/webhook/meta', {
    object: 'whatsapp_business_account',
    entry: [{ id: 'WABA-SIM', changes: [{ field: 'messages', value: {
      messages: [{ id, from: de, type: 'text', text: { body: texto } }],
    } }] }],
  });
  const antesDeTodo = enviados.length;
  await Promise.all(OTROS.flatMap((n, i) => {
    const id = `wamid.reintento-${i}`;
    idsPorNumero.set(n, id);
    // La copia y el original, a la vez: es lo que hace el reintento de Meta.
    return [conId(n, 'quiero jugar hoy', id), conId(n, 'quiero jugar hoy', id)];
  }));
  await sleep(DEMORA + 6000);
  const dobleRespuesta = OTROS.filter((n) => enviados.filter((e) => e.a === n).length > 1);
  console.log(`  → ${OTROS.length} personas × 2 webhooks · el bot mandó ${enviados.length - antesDeTodo} mensajes`);
  check('a nadie se le contestó dos veces', dobleRespuesta.length === 0, dobleRespuesta.slice(0, 5).join(','));
  const filas2 = db.inscripcionesDe(partidoDeTodos);
  const dobles2 = OTROS.filter((n) => filas2.filter((f) => f.numero === n).length > 1);
  check('nadie quedó anotado dos veces por el reintento', dobles2.length === 0, dobles2.slice(0, 5).join(','));
  check('el proceso sigue vivo', db.topeNuevosDia() === 0);

  console.log(`\n${fallos === 0 ? '✅' : '❌'} ${ok} checks OK · ${fallos} fallos`);
  process.exit(fallos === 0 ? 0 : 1);
})();
