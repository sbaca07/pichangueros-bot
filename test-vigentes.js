/**
 * Dos agujeros que aparecieron probando el 15/08:
 *
 *   node test-vigentes.js        (~10 s)
 *
 * 1. A las 10:40 el bot ofrecía "Breña 9am y 10am, Comas 9am". Los tres ya
 *    habían empezado: partidosAbiertos() filtraba por FECHA y nunca por hora.
 * 2. Prometía "te paso el link del grupo en un momento" sin que ninguna zona
 *    tuviera link cargado. 230 leads llegaron a ese punto; 1 solo terminó
 *    invitado. Ahora eso queda como pendiente de Clarck en el panel.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pich-vig-'));
process.env.WWEBJS_AUTH_PATH = TMP;
process.env.TRANSPORTE = 'meta';
process.env.META_TOKEN = 'dh_sim_key_valida_1234567890';
process.env.META_PHONE_NUMBER_ID = '123456789012345';
process.env.META_VERIFY_TOKEN = 'simtoken-abc-123';
process.env.META_NUMERO = '51967870413';
process.env.SAFE_MODE = 'true';
process.env.ADMIN_KEY = 'simadmin';
process.env.DEBOUNCE_MS = '400';
const A = '51900444555';
process.env.NOTIFY_NUMBER = '51999000111';
process.env.ALLOWED_TESTERS = A;
process.env.PORT = '34574';
delete process.env.OPENAI_API_KEY;

const enviados = [];
globalThis.fetch = async (url, opts = {}) => {
  if (String(url).includes('/messages') && opts.method === 'POST') {
    const body = JSON.parse(opts.body);
    if (body.text?.body) enviados.push({ a: body.to, texto: body.text.body });
    return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.sim' + enviados.length }] }) };
  }
  return { ok: true, status: 200, json: async () => ({ url: 'x' }), arrayBuffer: async () => new ArrayBuffer(4) };
};

const brain = require('./src/brain');
brain.cerebroActivo = () => true;
brain.pensar = async () => ({
  reply: 'Clarck te suma al grupo y te escribe por acá ⚽',
  nombre: 'Tester Grupo', edad: 30, distrito: 'Breña', zona: 'brena',
  handoff: false, handoff_motivo: null, inscribir_partido: null,
});
const atajos = require('./src/atajos');
atajos.responder = () => null;

const db = require('./src/db');
require('./index.js');

const http = require('http');
let msgSeq = 0;
const escribe = (de, texto) => new Promise((resolve, reject) => {
  const data = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ id: 'WABA-SIM', changes: [{ field: 'messages', value: {
      messages: [{ id: `wamid.sim-${++msgSeq}`, from: de, type: 'text', text: { body: texto } }],
    } }] }],
  });
  const req = http.request('http://127.0.0.1:34574/webhook/meta', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
    let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve(b));
  });
  req.on('error', reject); req.write(data); req.end();
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = 0, fallos = 0;
const check = (nombre, cond) => { if (cond) { ok++; console.log(`  ✓ ${nombre}`); } else { fallos++; console.error(`  ✗ ${nombre}`); } };

const hoy = db.hoyLima();
const manana = new Date(Date.now() - 5 * 3600e3 + 86400e3).toISOString().slice(0, 10);
const horaAhora = Number(new Date(Date.now() - 5 * 3600e3).toISOString().slice(11, 13));
const comoTexto = (h) => `${h % 12 || 12}${h < 12 ? 'am' : 'pm'}`;

(async () => {
  await sleep(700);

  console.log('== 1 · Un partido de hoy que ya empezó no se ofrece ==');
  if (horaAhora >= 2 && horaAhora <= 21) {
    const yaEmpezo = db.crearPartido({ zona: 'brena', fecha: hoy, hora: comoTexto(horaAhora - 1), sede: 'Melgar', cupo: 14, precio: 15 });
    const porVenir = db.crearPartido({ zona: 'brena', fecha: hoy, hora: comoTexto(horaAhora + 2), sede: 'Melgar', cupo: 14, precio: 15 });
    const deManana = db.crearPartido({ zona: 'comas', fecha: manana, hora: '8-9pm', sede: 'Politécnico', cupo: 14, precio: 10 });
    const ids = (opts) => db.partidosAbiertos(null, opts).map((p) => p.id);

    check('sin filtro sigue apareciendo (panel y pagos lo necesitan)', ids().includes(yaEmpezo.id ?? yaEmpezo));
    check('con vigentes:true el que ya empezó desaparece', !ids({ vigentes: true }).includes(yaEmpezo.id ?? yaEmpezo));
    check('el de más tarde de hoy sí se ofrece', ids({ vigentes: true }).includes(porVenir.id ?? porVenir));
    check('el de mañana también', ids({ vigentes: true }).includes(deManana.id ?? deManana));

    const sinHora = db.crearPartido({ zona: 'brena', fecha: hoy, hora: null, sede: 'Melgar', cupo: 14, precio: 15 });
    check('sin hora cargada, ante la duda se sigue ofreciendo', ids({ vigentes: true }).includes(sinHora.id ?? sinHora));
  } else {
    console.log(`  ⏭ salteado: son las ${horaAhora}h en Lima y el test necesita margen antes/después`);
  }

  console.log('== 2 · Sin link de grupo, queda como pendiente de Clarck ==');
  const zonas = db.getNegocio().zonas;
  check('la zona de prueba no tiene link cargado', !zonas.brena?.groupLink);
  await escribe(A, 'hola, soy de Breña');
  // 3 s, no 1.8: el primer arranque siembra la config y corre migraciones, y
  // con 1.8 el check llegaba antes que el flujo (flaky solo en frío).
  await sleep(3000);
  const lead = db.getLead(A);
  check('el lead quedó con su zona', lead?.zona === 'brena');
  check('y con una tarea pendiente para hoy', lead?.proxima_accion === hoy);
  check('que dice sumarlo al grupo', /Sumarlo al grupo/i.test(lead?.proxima_nota || ''));

  console.log('== 3 · La hora entra por reloj (24 h) y sale legible para el jugador ==');
  check('20:00 se guarda como "8-9pm"', db.normalizarHora('20:00') === '8-9pm');
  check('09:00 → "9-10am"', db.normalizarHora('09:00') === '9-10am');
  check('20:30 conserva los minutos', db.normalizarHora('20:30') === '8:30-9:30pm');
  check('un turno que cruza el mediodía lleva los dos sufijos', db.normalizarHora('11:00') === '11am-12pm');
  check('con hora de fin explícita respeta la duración', db.normalizarHora('20:00-22:00') === '8-10pm');
  check('lo ya guardado a mano no se toca', db.normalizarHora('8-9pm') === '8-9pm');
  check('el viejo "9pm" sigue funcionando', db.normalizarHora('9pm') === '9-10pm');

  // El bug que hacía invisible un partido: ordenHora leía "20:00" como las 8am,
  // así que el filtro de vigentes lo descartaba a media mañana.
  check('ordenHora lee 20:00 como las 20, no como las 8', db.ordenHora('20:00') === 20);
  check('y sigue leyendo bien "8-9pm"', db.ordenHora('8-9pm') === 20);
  check('"12am" es medianoche', db.ordenHora('12am') === 0);
  check('sin hora devuelve 99 (nunca se descarta)', db.ordenHora(null) === 99);

  check('horaInput precarga el reloj desde lo guardado', db.horaInput('8-9pm') === '20:00');
  check('con minutos también', db.horaInput('8:30-9:30pm') === '20:30');
  check('sin hora, el reloj queda vacío', db.horaInput('') === '');

  // De punta a punta: lo que manda el <input type="time"> tiene que quedar
  // guardado legible Y seguir siendo ofrecido si el turno todavía no empezó.
  if (horaAhora <= 20) {
    const p = db.crearPartido({ zona: 'brena', fecha: manana, hora: '20:00', sede: 'Melgar', cupo: 14, precio: 15 });
    const guardado = db.getPartido(p.id ?? p);
    check('el partido cargado con el reloj se guarda como "8-9pm"', guardado.hora === '8-9pm');
    check('y el bot sí lo ofrece', db.partidosAbiertos(null, { vigentes: true }).some((x) => x.id === (p.id ?? p)));
  }

  console.log('== 4 · Un pago puede entrar al partido EN CURSO, no al ya terminado ==');
  // 15/08: Anthony yapeó S/20 a las 11:07 por dos cupos del domingo. El único
  // candidato de Comas era el de ese mismo día 9-10am, terminado hacía una
  // hora — y ahí quedaron él y su invitado.
  if (horaAhora >= 3 && horaAhora <= 20) {
    // Una BD nueva solo trae brena y comas; chorrillos necesita su sede para
    // ser zona operativa (desde el 16/08 crearPartido valida la zona).
    db.addSede({ zona: 'chorrillos', nombre: 'La 13 Test', cupo: 14 });
    const termino = db.crearPartido({ zona: 'chorrillos', fecha: hoy, hora: comoTexto(horaAhora - 2), sede: 'La 13', cupo: 14, precio: 15 });
    const enCurso = db.crearPartido({ zona: 'chorrillos', fecha: hoy, hora: comoTexto(horaAhora), sede: 'La 13', cupo: 14, precio: 15 });
    const idsDe = (opts) => db.partidosAbiertos('chorrillos', opts).map((p) => p.id);

    check('para OFRECER, el que está en curso ya no se ofrece',
      !idsDe({ vigentes: true }).includes(enCurso.id ?? enCurso));
    check('para COBRAR, el que está en curso sí acepta el Yape',
      idsDe({ vigentes: true, incluirEnCurso: true }).includes(enCurso.id ?? enCurso));
    check('pero el que ya terminó no acepta nada',
      !idsDe({ vigentes: true, incluirEnCurso: true }).includes(termino.id ?? termino));
    check('y el panel los sigue viendo a los dos',
      idsDe().includes(termino.id ?? termino) && idsDe().includes(enCurso.id ?? enCurso));
  } else {
    console.log(`  ⏭ salteado: son las ${horaAhora}h en Lima y el test necesita margen`);
  }

  console.log(`\n${fallos ? '❌' : '✅'} ${ok} checks OK, ${fallos} fallos`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  process.exit(fallos ? 1 : 0);
})();
