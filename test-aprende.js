/**
 * El bot escucha aunque no conteste.
 *
 *   node test-aprende.js        (~10 s, sin red)
 *
 * Del diagnóstico del 2026-09-07: 488 de 1,435 fichas sin zona (34%). No era
 * la normalización de distritos (`src/distritos.js` fallaba en 1 de 488) — era
 * que la extracción de datos vivía DESPUÉS de `brain.pensar`, y tres caminos
 * se le adelantaban con un `return`: el derivado a Clarck, el que pasa el tope
 * del día, y el que se resuelve con un atajo.
 *
 * Lo caro era el ciclo que armaba: sin zona no hay precio → el Yape no se
 * puede validar → se deriva a Clarck → derivado, el bot ya no le habla →
 * nunca le pregunta el distrito → sigue sin zona. 93 personas vivían ahí, con
 * 152 pagos y S/2,222 encima.
 *
 * Mismo molde que test-rafagas.js: index.js real, red y cerebro simulados.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pich-apr-'));
process.env.WWEBJS_AUTH_PATH = TMP;
process.env.TRANSPORTE = 'meta';
process.env.META_TOKEN = 'dh_sim_key_valida_1234567890';
process.env.META_PHONE_NUMBER_ID = '123456789012345';
process.env.META_VERIFY_TOKEN = 'simtoken-abc-123';
process.env.META_NUMERO = '51967870413';
process.env.SAFE_MODE = 'false';
process.env.ADMIN_KEY = 'simadmin';
process.env.NOTIFY_NUMBER = '51999000111';
process.env.DEBOUNCE_MS = '400';
process.env.PORT = '34588';
const DERIVADO = '51900222001';
const TOPE = '51900222002';
const ATAJO = '51900222003';
const COMPLETO = '51900222004';
process.env.ALLOWED_TESTERS = [DERIVADO, TOPE, ATAJO, COMPLETO, process.env.NOTIFY_NUMBER].join(',');
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

// Cerebro guionado: extrae el distrito del texto, como haría el de verdad.
const brain = require('./src/brain');
const llamadas = [];
brain.cerebroActivo = () => true;
brain.pensar = async (lead, hist, texto) => {
  llamadas.push({ numero: lead.numero, texto });
  const m = /soy de (\w+)/i.exec(texto || '');
  const distrito = m ? m[1] : null;
  return {
    reply: 'ESTA RESPUESTA NO DEBE SALIR',
    nombre: /me llamo (\w+)/i.exec(texto || '')?.[1] || null,
    edad: /(\d{2}) años/.exec(texto || '')?.[1] || null,
    distrito,
    zona: distrito ? distrito.toLowerCase() : null,
    handoff: false, handoff_motivo: null, inscribir_partido: null, nombres_invitados: [],
  };
};
const atajos = require('./src/atajos');
let atajoActivo = false;
atajos.responder = (lead, body) => (atajoActivo ? { atajo: 'precios', respuesta: 'La pichanga sale S/15 ⚽' } : null);

const db = require('./src/db');
require('./index.js');

const BASE = 'http://127.0.0.1:34588';
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
const check = (nombre, cond) => { if (cond) { ok++; console.log(`  ✓ ${nombre}`); } else { fallos++; console.error(`  ✗ ${nombre}`); } };
const leDijoAlgo = (n) => enviados.some((e) => e.a === n);

(async () => {
  await sleep(700);

  console.log('== El derivado a Clarck sigue completando su ficha ==');
  // Exactamente el ciclo de las 93 personas: derivado porque no se pudo
  // validar su Yape, y sin zona no se puede validar ninguno de los próximos.
  db.getOrCreateLead(DERIVADO);
  db.setHandoff(DERIVADO, 'Falta cargar el precio de la zona del contacto');
  const antes = db.getLead(DERIVADO);
  check('arranca derivado y sin zona', antes.handoff === 1 && !antes.zona);
  await escribe(DERIVADO, 'me llamo Adriel, 29 años, soy de Comas');
  await sleep(1600);
  const dsp = db.getLead(DERIVADO);
  check('ahora sí le quedó la zona (antes se perdía)', dsp.zona === 'comas');
  check('y el distrito', dsp.distrito === 'Comas');
  check('y el nombre', dsp.nombre === 'Adriel');
  check('pero el bot NO le contestó: derivado sigue siendo derivado', !leDijoAlgo(DERIVADO));
  check('y sigue derivado a Clarck', db.getLead(DERIVADO).handoff === 1);

  console.log('== El que pasa el tope del día tampoco entra como ficha vacía ==');
  // El cupo se llena con gente que YA recibió su primera respuesta hoy: es
  // así como lo cuenta `nuevosDeHoy` (conversaciones tenidas, no fichas).
  db.setTopeNuevosDia(2);
  for (let i = 0; db.nuevosDeHoy() < 2 && i < 10; i++) {
    const relleno = `5190099${1000 + i}`;
    db.getOrCreateLead(relleno);
    db.saveMessage(relleno, 'assistant', 'hola');
  }
  check('el cupo de conversaciones nuevas del día está lleno', db.nuevosDeHoy() >= db.topeNuevosDia());
  await escribe(TOPE, 'hola, me llamo Leo, 23 años, soy de Brena');
  await sleep(1600);
  const t = db.getLead(TOPE);
  check('el que pasa el tope queda derivado a Clarck', t.handoff === 1);
  check('el bot no le contesta (para eso está el tope)', !leDijoAlgo(TOPE));
  check('pero su ficha NO queda vacía: le quedó la zona', t.zona === 'brena');
  check('y el nombre', t.nombre === 'Leo');

  console.log('== El atajo contesta sin IA, pero el dato no se tira ==');
  db.setTopeNuevosDia(0); // sin tope: acá se mide el atajo, no el cupo del día
  atajoActivo = true;
  await escribe(ATAJO, 'hola, soy de Rimac, cuanto sale?');
  await sleep(1600);
  const a = db.getLead(ATAJO);
  check('el atajo respondió (plantilla, sin IA)', enviados.some((e) => e.a === ATAJO && e.texto.includes('S/15')));
  check('y aun así le quedó la zona', a.zona === 'rimac');
  check('la respuesta del cerebro NO se envió (solo se usó para aprender)', !enviados.some((e) => e.texto.includes('NO DEBE SALIR')));
  atajoActivo = false;

  console.log('== Aprender no se paga dos veces ==');
  // El freno de costo: con la ficha completa no se gasta una llamada de IA.
  db.getOrCreateLead(COMPLETO);
  db.updateLead(COMPLETO, { nombre: 'Marco', edad: 30, distrito: 'Comas', zona: 'comas' });
  db.setHandoff(COMPLETO, 'Pago en efectivo.');
  const llamadasAntes = llamadas.filter((l) => l.numero === COMPLETO).length;
  await escribe(COMPLETO, 'hola de nuevo, alguna pichanga hoy?');
  await sleep(1600);
  check('con la ficha completa no se llama a la IA de gusto', llamadas.filter((l) => l.numero === COMPLETO).length === llamadasAntes);
  check('al derivado incompleto sí se lo lee', llamadas.some((l) => l.numero === DERIVADO));

  console.log(fallos ? `\n❌ ${ok} OK, ${fallos} FALLOS` : `\n✅ ${ok} checks OK, 0 fallos`);
  process.exit(fallos ? 1 : 0);
})();
