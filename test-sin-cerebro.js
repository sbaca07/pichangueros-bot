/**
 * Con el cerebro caído, lo que se puede hacer sin él se hace.
 *
 *   node test-sin-cerebro.js        (~15 s, sin red)
 *
 * El 2026-09-08, primer día del bot encendido, el cerebro estuvo caído desde
 * las 06:47. El bot mandó 14 mensajes en toda la mañana: 11 disculpas ("se me
 * cruzaron los cables") y 3 "no pude leer esa imagen". Cero útiles. A las
 * 09:25 Clarck lo apagó — duró 9 h 55 min encendido.
 *
 * Lo que la gente pedía en esos mismos minutos, textual:
 *
 *     09:04  "Para anotarme para las 21 hoy"
 *     09:11  [foto del Yape] "Para hoy martes a las 9"
 *     09:20  "Quiero escribirme pára la pichanga de hoy"
 *
 * Anotarse no necesita un modelo cuando no hay nada que interpretar. Y a los
 * tres de la foto se les pidió "mándame la captura completa donde se vean el
 * monto, la fecha y el número de operación": las capturas estaban perfectas,
 * el caído era el lector. La gente reenvió y volvió a fallar.
 *
 * Mismo molde que test-aprende.js: index.js real, red y cerebro simulados.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pich-sc-'));
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
process.env.PORT = '34599';
const PIDE = '51900333001';   // tiene zona: se le puede resolver el cupo
const SINZONA = '51900333002';
const CONFUSO = '51900333003';
const FOTO = '51900333004';
process.env.ALLOWED_TESTERS = [PIDE, SINZONA, CONFUSO, FOTO, process.env.NOTIFY_NUMBER].join(',');
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

// EL CEREBRO CAÍDO: `pensar` devuelve null, que es exactamente lo que devolvía
// el 8-sep cuando ningún modelo contestaba.
const brain = require('./src/brain');
brain.cerebroActivo = () => true;
brain.pensar = async () => null;

// El lector de vouchers, también caído (null = no se pudo llamar al modelo).
const pagos = require('./src/pagos');
pagos.cerebroActivo = () => true;
pagos.leerVoucher = async () => null;

const db = require('./src/db');
require('./index.js');

const BASE = 'http://127.0.0.1:34599';
const http = require('http');
const postJson = (ruta, obj) => new Promise((resolve, reject) => {
  const data = JSON.stringify(obj);
  const req = http.request(BASE + ruta, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
    let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b }));
  });
  req.on('error', reject); req.write(data); req.end();
});
let msgSeq = 0;
const escribe = (de, msg) => postJson('/webhook/meta', {
  object: 'whatsapp_business_account',
  entry: [{ id: 'WABA-SIM', changes: [{ field: 'messages', value: {
    messages: [{ id: `wamid.sim-${++msgSeq}`, from: de, ...(typeof msg === 'string' ? { type: 'text', text: { body: msg } } : msg) }],
  } }] }],
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = 0, fallos = 0;
const check = (nombre, cond, extra) => {
  if (cond) { ok++; console.log(`  ✓ ${nombre}`); }
  else { fallos++; console.error(`  ✗ ${nombre}${extra ? ` — ${extra}` : ''}`); }
};
const dichoA = (n) => enviados.filter((e) => e.a === n).map((e) => e.texto);
const seDisculpo = (n) => dichoA(n).some((t) => /cruzaron los cables/.test(t));

(async () => {
  await sleep(700);
  const hoy = db.hoyLima();

  // Una sola pichanga hoy en Comas, 9-10pm. Es el caso sin ambigüedad.
  const sede = { zona: 'comas', fecha: hoy, hora: '9-10pm', sede: 'Politécnico', cupo: 12, precio: 10 };
  const unico = db.crearPartido(sede);

  console.log('== 1 · "Para anotarme para las 21 hoy" con el cerebro caído ==');
  db.getOrCreateLead(PIDE);
  db.updateLead(PIDE, { nombre: 'Jorge Prueba', zona: 'comas' });
  await escribe(PIDE, 'Para anotarme para las 21 hoy');
  await sleep(1600);
  check('quedó ANOTADO de verdad, no solo bien contestado', Boolean(db.inscripcionActiva(unico, PIDE)));
  check('no le salió la disculpa', !seDisculpo(PIDE), dichoA(PIDE).join(' | ').slice(0, 160));
  const respuesta = dichoA(PIDE).join('\n');
  check('le dice el precio de su zona', /S\/ 10/.test(respuesta));
  // Regla 1: guardar el cupo NO es haber pagado. Si el mensaje no nombra el
  // Yape, el jugador se queda creyendo que ya está adentro.
  check('le pide el Yape: el cupo guardado no es un cupo pagado', /yape/i.test(respuesta));
  check('y NO le dice que está confirmado', !/(ya estas confirmado|quedaste confirmado)/i.test(respuesta.toLowerCase()));
  check('la inscripción NO nace pagada', db.inscripcionActiva(unico, PIDE)?.estado !== 'pagado');

  console.log('== 2 · Con dos pichangas posibles no se elige ninguna ==');
  // El error que costó plata el 15/08 fue justamente elegir el único candidato
  // "obvio". Con dos, la respuesta correcta es no adivinar.
  const segundo = db.crearPartido({ ...sede, hora: '8-9pm' });
  db.getOrCreateLead(CONFUSO);
  db.updateLead(CONFUSO, { nombre: 'Duda Prueba', zona: 'comas' });
  await escribe(CONFUSO, 'me apunto para hoy');
  await sleep(1600);
  check('no lo metió en ninguna', !db.inscripcionActiva(unico, CONFUSO) && !db.inscripcionActiva(segundo, CONFUSO));
  check('sale la disculpa, que es lo que ya pasaba', seDisculpo(CONFUSO));

  console.log('== 3 · Sin zona no se resuelve nada ==');
  // Sin zona no se sabe en qué cancha juega NI cuánto le sale (regla 9).
  db.getOrCreateLead(SINZONA);
  db.updateLead(SINZONA, { nombre: 'Nuevo Prueba' });
  await escribe(SINZONA, 'anotame para hoy a las 9');
  await sleep(1600);
  check('no se lo anota a ciegas', !db.inscripcionActiva(unico, SINZONA));
  check('sale la disculpa', seDisculpo(SINZONA));

  console.log('== 4 · "anótame con un amigo" tampoco: cuántos cupos lo dice la plata ==');
  const libres = () => db.partidosAbiertos('comas', { vigentes: true }).find((p) => p.id === unico)?.restante;
  const antesDe = libres();
  await escribe(PIDE, 'anotame con un amigo para hoy');
  await sleep(1600);
  check('no inventó el cupo del acompañante', libres() === antesDe, `${antesDe} → ${libres()}`);

  console.log('== 5 · La foto que no se pudo MIRAR ==');
  db.getOrCreateLead(FOTO);
  db.updateLead(FOTO, { nombre: 'Foto Prueba', zona: 'comas' });
  await escribe(FOTO, { type: 'image', image: { id: 'media-sim-caido' } });
  await sleep(1800);
  const alJugador = dichoA(FOTO).join('\n');
  check('se le contesta algo', alJugador.length > 0);
  // Pedirle al cliente que arregle nuestra caída lo hace reenviar, fallar de
  // nuevo, y encima queda como que él hizo algo mal.
  const plano = alJugador.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  check('NO se le pide otra captura', !/(mandame|enviame|vuelve a mandar|reenviala|manda(la)? de nuevo)/.test(plano), alJugador.slice(0, 160));
  check('se le dice de frente que no hace falta reenviarla', /no hace falta que la reenvies/.test(plano), alJugador.slice(0, 160));
  check('NO se le echa la culpa a su foto', !/no pude leer esa imagen/i.test(alJugador), alJugador.slice(0, 160));
  check('se le dice que lo mira Clarck', /clarck/i.test(alJugador));
  // La plata que no se vio es lo primero que tiene que saber alguien.
  const aClarck = dichoA(process.env.NOTIFY_NUMBER).join('\n');
  check('a Clarck le avisa que hay un Yape sin registrar', /NO quedó registrado/i.test(aClarck), aClarck.slice(-200));
  check('y que el caído es el lector, no la imagen', /lector/i.test(aClarck), aClarck.slice(-200));

  console.log(`\n${fallos === 0 ? '✅' : '❌'} ${ok} checks OK · ${fallos} fallos`);
  process.exit(fallos === 0 ? 0 : 1);
})();
