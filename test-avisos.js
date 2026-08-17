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
// `partidoParaInscribir` lo setean los bloques que prueban el pedido de cupo.
let partidoParaInscribir = null;
brain.pensar = async (lead, hist, texto) => {
  if (/efectivo/i.test(texto)) return D({ reply: 'Clarck te escribe en un momento 🤝', handoff: true, handoff_motivo: 'quiere pagar en efectivo' });
  if (/an[oó]tame|quiero jugar/i.test(texto)) return D({ reply: 'Te reservo el cupo ⚽', inscribir_partido: partidoParaInscribir });
  return D({ reply: 'Anotado, crack ⚽' });
};
const atajos = require('./src/atajos');
atajos.responder = () => null;

// Lectura de comprobantes guionada: interesa qué hace el bot con lo que sale,
// no la visión.
const pagosMod = require('./src/pagos');
let lecturaVoucher = null;
pagosMod.cerebroActivo = () => true;
pagosMod.leerVoucher = async () => lecturaVoucher;
pagosMod.interpretarPago = async () => null;

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
/** El jugador manda una foto (su comprobante). */
const mandaFoto = (de) => postJson('/webhook/meta', {
  object: 'whatsapp_business_account',
  entry: [{ id: 'WABA-SIM', changes: [{ field: 'messages', value: {
    messages: [{ id: `wamid.sim-${++msgSeq}`, from: de, type: 'image', image: { id: 'media-sim', mime_type: 'image/jpeg' } }],
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

  /**
   * CON EL BOT APAGADO, LO DE CLARCK SIGUE SALIENDO.
   *
   * El modo seguro dice "todavía no le hablamos a la gente", no "no nos
   * enteramos de nada". Tres caminos morían en silencio: el pago por revisar,
   * el derivado que insiste y el que pide cupo (que además no podía reservar,
   * así que después su Yape llegaba huérfano y había que adivinar el partido).
   *
   * B es un número REAL (no tester): con el modo seguro encendido, el bot no le
   * responde a él pero sí le avisa a Clarck.
   */
  const db = require('./src/db');
  const B = '51900444555';   // manda su comprobante y queda derivado
  const C = '51900444666';   // pide cupo con el bot apagado (contacto limpio)

  console.log('== 3 · Bot apagado: un pago por revisar SÍ le llega a Clarck ==');
  {
    const antes = aControl().length;
    const enviadosAntes = enviados.length;
    lecturaVoucher = {
      es_comprobante_pago: true, medio: 'yape', monto: 3, confianza: 'alta',
      nombre_remitente: 'Silenciado', numero_operacion: 'AV-REV-1', destinatario: null, destino_ultimos_digitos: null,
    };
    db.getOrCreateLead(B);
    db.updateLead(B, { zona: 'brena', nombre: 'Silenciado' });
    await mandaFoto(B);
    await sleep(1500);
    check('el pago quedó por revisar', db.listPagos(B).some((p) => p.numero_operacion === 'AV-REV-1' && p.estado === 'revisar'));
    check('le avisó a Clarck igual (el bot estaba apagado para el jugador)',
      aControl().slice(antes).some((e) => /Revisar pago/.test(e.texto)), JSON.stringify(aControl().slice(antes)));
    check('…y también por correo, que es el canal que llega', correos.some((c) => /Pago por revisar/.test(c.asunto)));
    check('al jugador NO se le respondió nada', !enviados.slice(enviadosAntes).some((e) => e.a === B));
  }

  console.log('== 4 · Bot apagado: un pedido de cupo no muere en silencio ==');
  {
    // Reservar con el bot mudo sería un cupo fantasma (el jugador nunca se
    // entera), pero el pedido tiene que llegarle a Clarck para que lo anote.
    partidoParaInscribir = db.crearPartido({ zona: 'brena', fecha: db.fechaLima(1), hora: '8-9pm', cupo: 10, precio: 15 });
    const antes = aControl().length;
    const enviadosAntes = enviados.length;
    await escribe(C, 'anotame para mañana');
    await sleep(1800);
    const aviso = aControl().slice(antes).find((e) => /pidió cupo/.test(e.texto));
    check('le avisa a Clarck que alguien pidió cupo', Boolean(aviso), JSON.stringify(aControl().slice(antes)));
    check('…diciendo para qué partido y cuántos lugares quedan', aviso && /8-9pm/.test(aviso.texto) && /libre/.test(aviso.texto), aviso && aviso.texto);
    check('…y que el bot NO lo anotó (lo tiene que hacer él)', aviso && /no lo anotó/i.test(aviso.texto), aviso && aviso.texto);
    check('el cupo NO se reservó (sería un cupo que el jugador no sabe que tiene)',
      db.inscripcionesDe(partidoParaInscribir).length === 0, String(db.inscripcionesDe(partidoParaInscribir).length));
    check('y al jugador se le sigue sin responder', !enviados.slice(enviadosAntes).some((e) => e.a === C));

    const antes2 = aControl().length;
    await escribe(C, 'anotame para mañana porfa');
    await sleep(1800);
    check('no se repite el aviso por el mismo contacto (máx. 1 por hora)',
      !aControl().slice(antes2).some((e) => /pidió cupo/.test(e.texto)));
    partidoParaInscribir = null;
  }

  console.log('== 5 · Bot apagado: el derivado que insiste también avisa ==');
  {
    // El re-aviso vivía dentro del !modoSilencio: con el bot apagado —que es
    // justo cuando Clarck atiende todo a mano— nadie se enteraba.
    db.setHandoff(B, 'quiere pagar en efectivo');
    const antes = aControl().length;
    await escribe(B, 'hola? sigues ahi?');
    await sleep(1500);
    check('re-avisa aunque el bot esté apagado',
      aControl().slice(antes).some((e) => /sigue escribiendo/.test(e.texto)), JSON.stringify(aControl().slice(antes)));
  }

  console.log('== 6 · Encendido desde el panel, sin reiniciar el proceso ==');
  {
    // index.js leía SAFE_MODE una sola vez al arrancar. Acá el proceso ya está
    // corriendo desde el principio de esta prueba: si el cambio se ve, es
    // porque se lee por mensaje.
    db.setBotEncendido(true, 'prueba');
    const enviadosAntes = enviados.length;
    await escribe(C, 'hola');
    await sleep(1800);
    check('ahora SÍ le responde al jugador, sin redeploy',
      enviados.slice(enviadosAntes).some((e) => e.a === C), JSON.stringify(enviados.slice(enviadosAntes)));
    db.setBotEncendido(false, 'prueba');
    const enviadosAntes2 = enviados.length;
    await escribe(C, 'hola de nuevo');
    await sleep(1800);
    check('y apagándolo vuelve a callarse en el acto', !enviados.slice(enviadosAntes2).some((e) => e.a === C));
  }

  console.log(`\n${fallos ? '❌' : '✅'} ${ok} checks OK, ${fallos} fallos`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  process.exit(fallos ? 1 : 0);
})();
