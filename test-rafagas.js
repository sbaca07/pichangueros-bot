/**
 * Ráfagas: varios mensajes seguidos → UNA sola respuesta.
 *
 *   node test-rafagas.js        (~15 s)
 *
 * Clarck reportó el 13/08 que "el bot habla mucho". La causa medida en los logs
 * no era el largo de cada mensaje sino que respondía uno por uno: 3 respuestas
 * (848 caracteres) en 20 segundos. Este test fija el arreglo — y también fija
 * lo que NO se debe agrupar (adjuntos, comandos de control, el ping de prueba).
 *
 * Mismo molde que test-simulacion.js: index.js real, red y cerebro simulados.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pich-raf-'));
process.env.WWEBJS_AUTH_PATH = TMP;
process.env.TRANSPORTE = 'meta';
process.env.META_TOKEN = 'dh_sim_key_valida_1234567890';
process.env.META_PHONE_NUMBER_ID = '123456789012345';
process.env.META_VERIFY_TOKEN = 'simtoken-abc-123';
process.env.META_NUMERO = '51967870413';
process.env.SAFE_MODE = 'true';
process.env.ADMIN_KEY = 'simadmin';
process.env.NOTIFY_NUMBER = '51999000111';
process.env.DEBOUNCE_MS = '600'; // el test no espera 2.5 s por ráfaga
const A = '51900111222';
process.env.ALLOWED_TESTERS = [A, process.env.NOTIFY_NUMBER].join(',');
process.env.PORT = '34572';
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

// Cerebro guionado: nos interesa QUÉ texto le llegó, no qué contesta.
const brain = require('./src/brain');
const vistos = []; // textos que recibió el cerebro
brain.cerebroActivo = () => true;
brain.pensar = async (lead, hist, texto) => {
  vistos.push(texto);
  return { reply: 'Anotado, crack ⚽', nombre: null, edad: null, distrito: null, zona: null, handoff: false, handoff_motivo: null, inscribir_partido: null };
};
// Los atajos responderían sin IA y saltearían el cerebro: acá queremos medir el cerebro.
const atajos = require('./src/atajos');
atajos.responder = () => null;

require('./index.js');

const BASE = 'http://127.0.0.1:34572';
const http = require('http');
const postJson = (ruta, obj) => new Promise((resolve, reject) => {
  const data = JSON.stringify(obj);
  const req = http.request(BASE + ruta, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
    let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b }));
  });
  req.on('error', reject); req.write(data); req.end();
});

let msgSeq = 0;
const payloadMeta = (de, contenido) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: 'WABA-SIM', changes: [{ field: 'messages', value: {
    messages: [{
      id: `wamid.sim-${++msgSeq}`,
      from: de,
      ...(typeof contenido === 'string' ? { type: 'text', text: { body: contenido } } : contenido),
    }],
  } }] }],
});
const escribe = (de, texto) => postJson('/webhook/meta', payloadMeta(de, texto));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = 0, fallos = 0;
const check = (nombre, cond) => { if (cond) { ok++; console.log(`  ✓ ${nombre}`); } else { fallos++; console.error(`  ✗ ${nombre}`); } };
const enviadosA = (n) => enviados.filter((e) => e.a === n);

(async () => {
  await sleep(700);

  console.log('== 1 · Tres mensajes en ráfaga → UNA respuesta ==');
  await escribe(A, 'hola');
  await escribe(A, 'quiero jugar');
  await escribe(A, 'soy de Breña');
  await sleep(2000);
  check('el cerebro se llamó UNA sola vez', vistos.length === 1);
  check('recibió los 3 textos juntos',
    vistos[0] === 'hola\nquiero jugar\nsoy de Breña');
  check('el bot mandó UNA sola respuesta', enviadosA(A).length === 1);

  console.log('== 2 · Mensaje suelto → responde igual ==');
  vistos.length = 0; enviados.length = 0;
  await escribe(A, 'a que hora es');
  await sleep(1800);
  check('una llamada al cerebro', vistos.length === 1);
  check('el texto llega tal cual', vistos[0] === 'a que hora es');
  check('una respuesta', enviadosA(A).length === 1);

  console.log('== 3 · Los adjuntos NO se agrupan (pueden ser un voucher) ==');
  vistos.length = 0; enviados.length = 0;
  await escribe(A, { type: 'audio', audio: { id: 'media-1' } });
  await sleep(1200);
  check('el audio se atiende sin esperar la ráfaga', vistos.length === 1);
  check('llega como marcador de adjunto', /audio/.test(vistos[0] || ''));

  console.log('== 4 · El ping de prueba sigue siendo instantáneo ==');
  vistos.length = 0; enviados.length = 0;
  await escribe(A, 'ping kipi');
  await sleep(400); // menos que DEBOUNCE_MS: si se agrupara, no habría llegado
  check('responde antes de que venza el debounce', enviadosA(A).length === 1);
  check('no pasó por el cerebro', vistos.length === 0);

  console.log('== 5 · Ráfaga + adjunto: se respeta el orden ==');
  vistos.length = 0; enviados.length = 0;
  await escribe(A, 'mira');
  await escribe(A, { type: 'image', image: { id: 'media-2' } });
  await sleep(2000);
  check('el texto pendiente se soltó al llegar el adjunto', vistos.length === 2);
  check('primero el texto, después la imagen',
    vistos[0] === 'mira' && /imagen/.test(vistos[1] || ''));

  console.log(`\n${fallos ? '❌' : '✅'} ${ok} checks OK, ${fallos} fallos`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  process.exit(fallos ? 1 : 0);
})();
