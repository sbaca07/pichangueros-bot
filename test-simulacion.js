/**
 * SIMULACIÓN de punta a punta — el bot entero en memoria, sin red ni APIs.
 *
 *   node test-simulacion.js        (~30 s: respeta las pausas de "escribiendo…")
 *
 * Qué es real: index.js completo (webhook Meta, colas por contacto, SAFE_MODE,
 * comandos kipi), db.js, la evaluación de vouchers y el panel (HTTP real).
 * Qué se simula: la DECISIÓN del LLM (guionada por escenario), la lectura OCR
 * del voucher, y la red saliente (fetch global interceptado — se captura lo
 * que el bot "envía" por WhatsApp en vez de mandarlo).
 *
 * Cubre los escenarios de casuisticas-partidos.md que involucran conversación:
 * alta de lead, datos, inscripción, pago→partido, voucher repetido + handoff,
 * kipi reactivar, espera y promoción con aviso, SAFE_MODE sin cupos fantasma,
 * reintento de Meta (dedup) y echo manual de Clarck.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

// --- Entorno ANTES de cargar nada ---------------------------------------------
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pich-sim-'));
process.env.WWEBJS_AUTH_PATH = TMP;
process.env.TRANSPORTE = 'meta';
process.env.META_TOKEN = 'dh_sim_key_valida_1234567890';
process.env.META_PHONE_NUMBER_ID = '123456789012345';
process.env.META_VERIFY_TOKEN = 'simtoken-abc-123';
process.env.META_NUMERO = '51967870413';
process.env.SAFE_MODE = 'true';
process.env.ADMIN_KEY = 'simadmin';
process.env.NOTIFY_NUMBER = '51999000111';
const A = '51900111222', B = '51900333444', B2 = '51900555666', SILENTE = '51908888777';
process.env.ALLOWED_TESTERS = [A, B, B2, process.env.NOTIFY_NUMBER].join(',');
process.env.PORT = '34567';
delete process.env.OPENAI_API_KEY;

// --- Red saliente interceptada: capturamos lo que el bot "envía" ---------------
const enviados = []; // {a, texto}
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes('/messages') && opts.method === 'POST') {
    const body = JSON.parse(opts.body);
    enviados.push({ a: body.to, texto: body.text?.body || '' });
    return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.sim' + enviados.length }] }) };
  }
  // Cualquier otro GET es el flujo de media (metadata → binario): la metadata
  // devuelve una url fake y el binario, bytes — el OCR igual está simulado.
  return { ok: true, status: 200, json: async () => ({ url: 'http://sim-media/bin' }), arrayBuffer: async () => new ArrayBuffer(4) };
};

// --- Cerebro y OCR guionados (misma interfaz, cero OpenAI) ---------------------
const brain = require('./src/brain');
const D = (extra) => ({ reply: '', nombre: null, edad: null, distrito: null, zona: null, handoff: false, handoff_motivo: null, inscribir_partido: null, ...extra });
let partidoParaInscribir = null;
brain.cerebroActivo = () => true;
brain.pensar = async (lead, hist, texto) => {
  const t = texto.toLowerCase();
  if (t === 'hola') return D({ reply: '¡Habla, pichanguero! 👋 Para anotarte pásame tu nombre, edad y distrito.' });
  if (t.startsWith('soy diego')) return D({ reply: '¡Buenaza Diego! Quedaste registrado.', nombre: 'Diego Sim', edad: 27, distrito: 'Breña', zona: 'brena' });
  if (t.includes('quiero jugar')) return D({ reply: 'Te reservo tu cupo — confírmalo con tu Yape ⚽', inscribir_partido: partidoParaInscribir });
  if (t.includes('efectivo')) return D({ reply: 'Clarck te escribe en un momento 🙏', handoff: true, handoff_motivo: 'Quiere pagar en efectivo' });
  return D({ reply: 'Anotado 👍' });
};
const pagos = require('./src/pagos');
pagos.cerebroActivo = () => true;
const lecturas = []; // cola de lecturas simuladas del OCR
pagos.leerVoucher = async () => lecturas.shift() || null;

// --- Arrancar el bot real ------------------------------------------------------
const db = require('./src/db');
require('./index.js');

const BASE = 'http://127.0.0.1:34567';
const http = require('http');
const postJson = (ruta, obj, headers = {}) => new Promise((resolve, reject) => {
  const data = JSON.stringify(obj);
  const req = http.request(BASE + ruta, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers } }, (res) => {
    let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b }));
  });
  req.on('error', reject); req.write(data); req.end();
});
const postForm = (ruta, obj) => new Promise((resolve, reject) => {
  const data = new URLSearchParams(obj).toString();
  const req = http.request(BASE + ruta, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
    let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b }));
  });
  req.on('error', reject); req.write(data); req.end();
});

let msgSeq = 0;
const payloadMeta = (de, contenido, { id = null, echo = false } = {}) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: 'WABA-SIM', changes: [{ field: echo ? 'smb_message_echoes' : 'messages', value: {
    [echo ? 'message_echoes' : 'messages']: [{
      id: id || `wamid.sim-${++msgSeq}`,
      ...(echo ? { to: de } : { from: de }),
      ...(typeof contenido === 'string' ? { type: 'text', text: { body: contenido } } : contenido),
    }],
  } }] }],
});
const escribe = (de, texto, opts) => postJson('/webhook/meta', payloadMeta(de, texto, opts));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function esperar(cond, desc, timeout = 9000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { if (cond()) return true; await sleep(150); }
  console.error(`  ⏱ timeout esperando: ${desc}`);
  return false;
}

let ok = 0, fallos = 0;
const check = (nombre, cond) => { if (cond) { ok++; console.log(`  ✓ ${nombre}`); } else { fallos++; console.error(`  ✗ ${nombre}`); } };
const enviadosA = (numero) => enviados.filter((e) => e.a === numero);
const enDias = (n) => new Date(Date.now() - 5 * 3600e3 + n * 86400e3).toISOString().slice(0, 10);

(async () => {
  await sleep(700); // que el servidor abra el puerto

  console.log('== 1 · Lead nuevo: bienvenida y captura ==');
  await escribe(A, 'hola');
  await esperar(() => enviadosA(A).length >= 1, 'bienvenida');
  check('el bot responde la bienvenida', /pichanguero/i.test(enviadosA(A)[0]?.texto || ''));
  check('el lead quedó en la BD', Boolean(db.getLead(A)));

  console.log('== 2 · Datos + aviso de lead completo ==');
  await escribe(A, 'soy diego, 27, de Breña');
  await esperar(() => db.getLead(A)?.nombre, 'datos guardados');
  check('nombre/edad/zona guardados', db.getLead(A)?.nombre === 'Diego Sim' && db.getLead(A)?.zona === 'brena');
  await esperar(() => enviadosA(process.env.NOTIFY_NUMBER).some((e) => e.texto.includes('Lead completo')), 'aviso 🆕');
  check('aviso 🆕 Lead completo al número de control', enviadosA(process.env.NOTIFY_NUMBER).some((e) => e.texto.includes('Lead completo')));

  console.log('== 3 · Inscripción por chat ==');
  const p1 = db.crearPartido({ zona: 'brena', fecha: enDias(1), hora: '8-9pm', sede: 'Sim FC', cupo: 14 });
  partidoParaInscribir = p1;
  await escribe(A, 'quiero jugar mañana');
  await esperar(() => db.inscripcionActiva(p1, A), 'reserva');
  check('la reserva existe en la BD', db.inscripcionActiva(p1, A)?.estado === 'reservado');
  check('aviso 📝 de inscripción a control', await esperar(() => enviadosA(process.env.NOTIFY_NUMBER).some((e) => e.texto.includes('inscribió')), 'aviso 📝'));

  console.log('== 4 · Yape → cupo pagado ==');
  lecturas.push({ es_voucher_yape: true, medio: 'yape', monto: 15, nombre_remitente: 'Diego Sim', numero_operacion: 'SIM-001', confianza: 'alta' });
  await escribe(A, { type: 'image', image: { id: 'media-sim-1' } });
  await esperar(() => db.inscripcionActiva(p1, A)?.estado === 'pagado', 'pago vinculado');
  check('el cupo pasó a pagado y quedó vinculado', db.inscripcionActiva(p1, A)?.estado === 'pagado' && db.inscripcionActiva(p1, A)?.pago_id > 0);
  check('la respuesta confirma la lista', await esperar(() => enviadosA(A).some((e) => e.texto.includes('lista del')), 'respuesta con lista'));

  console.log('== 5 · Voucher repetido → revisar + handoff ==');
  lecturas.push({ es_voucher_yape: true, medio: 'yape', monto: 15, nombre_remitente: 'Diego Sim', numero_operacion: 'SIM-001', confianza: 'alta' });
  await escribe(A, { type: 'image', image: { id: 'media-sim-2' } });
  await esperar(() => db.getLead(A)?.handoff === 1, 'handoff por repetido');
  check('el lead quedó en handoff', db.getLead(A)?.handoff === 1);
  check('se le explica el repetido', enviadosA(A).some((e) => e.texto.includes('registrado')));

  console.log('== 6 · kipi reactivar desde el número de control ==');
  await escribe(process.env.NOTIFY_NUMBER, `kipi reactivar ${A}`);
  await esperar(() => db.getLead(A)?.handoff === 0, 'reactivado');
  check('el handoff se levantó por comando', db.getLead(A)?.handoff === 0);

  console.log('== 7 · Partido lleno → espera → baja promueve y avisa ==');
  const p2 = db.crearPartido({ zona: 'comas', fecha: enDias(2), cupo: 1 });
  partidoParaInscribir = p2;
  await escribe(B, 'quiero jugar');
  await esperar(() => db.inscripcionActiva(p2, B), 'B inscrito');
  await escribe(B2, 'quiero jugar');
  await esperar(() => db.inscripcionActiva(p2, B2), 'B2 en espera');
  check('el segundo cayó a lista de espera', db.inscripcionActiva(p2, B2)?.estado === 'espera');
  check('al primero se le avisó que quedó en espera... no aplica (él entró)', db.inscripcionActiva(p2, B)?.estado === 'reservado');
  const idB = db.inscripcionActiva(p2, B).id;
  const antes = enviadosA(process.env.NOTIFY_NUMBER).length;
  await postForm('/admin/inscripcion/estado', { key: 'simadmin', id: idB, partido_id: p2, estado: 'baja' });
  await esperar(() => db.inscripcionActiva(p2, B2)?.estado === 'reservado', 'promoción');
  check('la espera subió a reservado', db.inscripcionActiva(p2, B2)?.estado === 'reservado');
  check('aviso ⬆ de promoción a control', await esperar(() => enviadosA(process.env.NOTIFY_NUMBER).length > antes && enviadosA(process.env.NOTIFY_NUMBER).some((e) => e.texto.includes('subió de la lista de espera')), 'aviso ⬆'));

  console.log('== 8 · SAFE_MODE: el silenciado NO ocupa cupo ni recibe nada ==');
  partidoParaInscribir = p1;
  const cuposAntes = db.inscripcionesDe(p1).length;
  await escribe(SILENTE, 'quiero jugar mañana');
  await esperar(() => db.getLead(SILENTE), 'lead silente registrado');
  await sleep(1200); // margen: si fuera a inscribir/responder, ya habría pasado
  check('quedó registrado como lead (captura silenciosa)', Boolean(db.getLead(SILENTE)));
  check('NO se inscribió (sin cupos fantasma)', db.inscripcionesDe(p1).length === cuposAntes);
  check('NO se le envió ningún mensaje', enviadosA(SILENTE).length === 0);

  console.log('== 9 · Reintento de Meta (mismo id) no duplica ==');
  // Solo mensajes DEL usuario: las respuestas del bot también van al historial.
  const deUsuario = () => db.getHistory(A, 50).filter((m) => m.rol === 'user').length;
  const mensajesAntes = deUsuario();
  await escribe(A, 'hola de nuevo', { id: 'wamid.sim-repetido' });
  await esperar(() => deUsuario() === mensajesAntes + 1, 'primer procesamiento');
  await escribe(A, 'hola de nuevo', { id: 'wamid.sim-repetido' });
  await sleep(1000);
  check('el reintento con el mismo id se ignora', deUsuario() === mensajesAntes + 1);

  console.log('== 10 · Echo: respuesta manual de Clarck queda en el historial ==');
  await escribe(A, 'perfecto causa', { echo: true });
  check('el echo se guardó como respuesta del negocio', await esperar(() => db.getHistory(A, 50).some((m) => m.rol === 'assistant' && m.texto === 'perfecto causa'), 'echo guardado'));

  console.log(fallos ? `\n❌ ${ok} OK, ${fallos} FALLOS` : `\n✅ ${ok} checks OK, 0 fallos — simulación completa`);
  process.exit(fallos ? 1 : 0);
})().catch((e) => { console.error('SIM ERROR:', e); process.exit(1); });
