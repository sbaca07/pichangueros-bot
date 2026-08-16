/**
 * Avisos al número de control: lo crítico sale TAMBIÉN por correo.
 *
 *   node test-avisos.js        (~10 s)
 *
 * Cloud API rechaza los mensajes libres fuera de la ventana de 24 h (131047) y
 * el rechazo llega tarde, por webhook — desde el código un aviso perdido se ve
 * igual que uno entregado. El 13/08 se perdió así un handoff. Por eso handoffs
 * y pagos por revisar salen por WhatsApp Y por correo; los avisos blandos no,
 * para no llenarle la casilla a Clarck.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pich-avi-'));
process.env.WWEBJS_AUTH_PATH = TMP;
process.env.TRANSPORTE = 'meta';
process.env.META_TOKEN = 'dh_sim_key_valida_1234567890';
process.env.META_PHONE_NUMBER_ID = '123456789012345';
process.env.META_VERIFY_TOKEN = 'simtoken-abc-123';
process.env.META_NUMERO = '51967870413';
process.env.SAFE_MODE = 'true';
process.env.ADMIN_KEY = 'simadmin';
process.env.DEBOUNCE_MS = '400';
const A = '51900222333', CONTROL = '51999000111';
process.env.NOTIFY_NUMBER = CONTROL;
process.env.ALLOWED_TESTERS = [A, CONTROL].join(',');
process.env.PORT = '34573';
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

// Correo interceptado: nos interesa QUÉ se manda, no mandarlo.
const backup = require('./src/backup');
const correos = [];
backup.avisar = async (asunto, cuerpo) => { correos.push({ asunto, cuerpo }); return { ok: true }; };

const brain = require('./src/brain');
const D = (extra) => ({ reply: '', nombre: null, edad: null, distrito: null, zona: null, handoff: false, handoff_motivo: null, inscribir_partido: null, ...extra });
brain.cerebroActivo = () => true;
brain.pensar = async (lead, hist, texto) => (/efectivo/i.test(texto)
  ? D({ reply: 'Clarck te escribe en un momento 🤝', handoff: true, handoff_motivo: 'quiere pagar en efectivo' })
  : D({ reply: 'Anotado, crack ⚽' }));
const atajos = require('./src/atajos');
atajos.responder = () => null;

require('./index.js');

const http = require('http');
const postJson = (ruta, obj) => new Promise((resolve, reject) => {
  const data = JSON.stringify(obj);
  const req = http.request('http://127.0.0.1:34573' + ruta, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
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
const aControl = () => enviados.filter((e) => e.a === CONTROL);

(async () => {
  await sleep(700);

  console.log('== 1 · Handoff: WhatsApp Y correo ==');
  await escribe(A, 'puedo pagarte en efectivo?');
  await sleep(1800);
  check('le avisó a Clarck por WhatsApp', aControl().some((e) => /Para Clarck/.test(e.texto)));
  check('el WhatsApp trae el contacto y cómo reactivarlo',
    aControl().some((e) => /wa\.me\/51900222333/.test(e.texto) && /kipi reactivar/.test(e.texto)));
  check('el contacto quedó en handoff', Boolean(require('./src/db').getLead(A)?.handoff));
  // Por correo NO va uno por uno: se marcan ~41 handoffs por día y 41 correos
  // diarios se ignoran. Van juntos en el resumen de backup.js, 3 veces al día
  // (test-resumen.js). Acá solo se fija que no salga el correo inmediato.
  check('NO manda un correo por cada handoff', correos.length === 0);

  console.log('== 2 · El derivado que insiste: WhatsApp y nada más ==');
  const antes = aControl().length;
  await escribe(A, 'sigues ahi?'); // ya está en handoff → re-aviso a control
  await sleep(1500);
  check('re-avisó por WhatsApp', aControl().length > antes);
  check('sigue sin mandar correo', correos.length === 0);

  console.log(`\n${fallos ? '❌' : '✅'} ${ok} checks OK, ${fallos} fallos`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  process.exit(fallos ? 1 : 0);
})();
