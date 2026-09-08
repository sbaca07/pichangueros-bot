/**
 * Un día real, todo mezclado: la caja tiene que cerrar igual.
 *
 *   node test-dia-mezclado.js        (~25 s, sin red)
 *
 * Los otros tests prueban una cosa por vez: una reserva, un voucher, un cupo
 * lleno. Un martes de Pichangueros no es así — al mismo tiempo hay gente
 * pidiendo cupo, mandando su Yape, mandando el Yape ANTES de pedir el cupo,
 * reenviando la misma captura, y pagando un monto que no es. Todo sobre el
 * mismo partido y en los mismos segundos.
 *
 * Lo que se vigila acá no son las respuestas: son las INVARIANTES de la plata,
 * que son las que no se pueden romper ni una vez.
 *
 *   1. No hay "pagado" sin un Yape detrás (la regla 1 de la casa). Marcar
 *      pagado sin voucher inventa plata en la caja del partido.
 *   2. Un mismo Yape no cubre más cupos de los que compró. Si una captura de
 *      S/10 termina cubriendo a dos personas, el partido pierde S/10 y nadie
 *      se entera hasta el día de la cancha.
 *   3. La misma captura reenviada no confirma dos veces.
 *   4. No entran más jugadores que el cupo.
 *
 * Mismo molde que test-simulacion.js: index.js real, red y cerebro simulados.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pich-mezcla-'));
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
process.env.PORT = '34603';
process.env.ALLOWED_TESTERS = '';
process.env.OPENAI_API_KEY = 'sk-no-se-usa';   // para que el lector de vouchers "exista"

const CUPO = 12;
const PRECIO = 10;
const GENTE = 24;
const N = (i) => `5190066${String(i).padStart(4, '0')}`;

const enviados = [];
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes('/messages') && opts.method === 'POST') {
    const body = JSON.parse(opts.body);
    if (body.text?.body) enviados.push({ a: body.to, texto: body.text.body });
    return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.sim' + enviados.length }] }) };
  }
  // La descarga de un media son DOS fetch (metadata → binario). Se hace que el
  // binario lleve el id adentro, así `leerVoucher` sabe de quién es la foto:
  // sin esto todas las capturas llegaban iguales y ningún pago se registraba.
  // El binario PRIMERO: su URL también termina en el id, así que si se mira la
  // de metadata antes, el binario vuelve a caer ahí y nunca llega la foto.
  const bin = u.match(/sim-media\/(media-\d+)/);
  if (bin) {
    const buf = Buffer.from(bin[1], 'utf8');
    return { ok: true, status: 200, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
  }
  const meta = u.match(/\/(media-\d+)(\?|$)/);
  if (meta) return { ok: true, status: 200, json: async () => ({ url: `http://sim-media/${meta[1]}` }) };
  return { ok: true, status: 200, json: async () => ({ url: 'http://sim-media/bin' }), arrayBuffer: async () => new ArrayBuffer(4) };
};

let partido = null;
const brain = require('./src/brain');
brain.cerebroActivo = () => true;
brain.pensar = async () => {
  await new Promise((r) => setTimeout(r, 400));
  return {
    reply: 'Te guardo el cupo, mándame tu Yape 🙏',
    nombre: null, edad: null, distrito: null, zona: null,
    handoff: false, handoff_motivo: null,
    inscribir_partido: partido, nombres_invitados: null,
  };
};

// El lector de vouchers, guionado por número: cada uno manda lo suyo.
const pagos = require('./src/pagos');
const loQueMandaCadaUno = new Map();
pagos.cerebroActivo = () => true;
pagos.leerVoucher = async (buf) => {
  await new Promise((r) => setTimeout(r, 250));
  const clave = buf.toString('utf8');
  return loQueMandaCadaUno.get(clave) || null;
};

const db = require('./src/db');
require('./index.js');

const BASE = 'http://127.0.0.1:34603';
const http = require('http');
const postJson = (ruta, obj) => new Promise((resolve, reject) => {
  const data = JSON.stringify(obj);
  const req = http.request(BASE + ruta, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
    let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b }));
  });
  req.on('error', reject); req.write(data); req.end();
});
let seq = 0;
const enviar = (de, msg) => postJson('/webhook/meta', {
  object: 'whatsapp_business_account',
  entry: [{ id: 'WABA-SIM', changes: [{ field: 'messages', value: {
    messages: [{ id: `wamid.mz-${++seq}`, from: de, ...msg }],
  } }] }],
});
const texto = (de, t) => enviar(de, { type: 'text', text: { body: t } });
// El id del media viaja como "buffer" hasta leerVoucher: así cada foto es la de esa persona.
const foto = (de, mediaId) => enviar(de, { type: 'image', image: { id: mediaId } });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = 0, fallos = 0;
const check = (nombre, cond, extra) => {
  if (cond) { ok++; console.log(`  ✓ ${nombre}`); }
  else { fallos++; console.error(`  ✗ ${nombre}${extra ? ` — ${extra}` : ''}`); }
};

(async () => {
  await sleep(800);
  db.setTopeNuevosDia(0);      // acá no se mide la compuerta
  const hoy = db.hoyLima();
  partido = db.crearPartido({ zona: 'comas', fecha: hoy, hora: '9-10pm', sede: 'Politécnico', cupo: CUPO, precio: PRECIO });

  // Cada persona con su zona puesta, si no el voucher no se puede validar.
  for (let i = 0; i < GENTE; i++) { db.getOrCreateLead(N(i)); db.updateLead(N(i), { nombre: `Jugador ${i}`, zona: 'comas' }); }

  console.log(`\n== Un martes: ${GENTE} personas, cupo ${CUPO}, todo al mismo tiempo ==`);
  const acciones = [];
  for (let i = 0; i < GENTE; i++) {
    const numero = N(i);
    const media = `media-${i}`;
    if (i % 4 === 3) {
      // El que paga el monto que NO es: no se le puede dar el cupo por pagado.
      loQueMandaCadaUno.set(media, { es_comprobante_pago: true, medio: 'yape', monto: 25, nombre_remitente: `Jugador ${i}`, numero_operacion: `OP-${i}`, confianza: 'alta' });
    } else {
      loQueMandaCadaUno.set(media, { es_comprobante_pago: true, medio: 'yape', monto: PRECIO, nombre_remitente: `Jugador ${i}`, numero_operacion: `OP-${i}`, confianza: 'alta' });
    }
    if (i % 3 === 0) {
      // Pide cupo y después paga.
      acciones.push((async () => { await texto(numero, 'me anoto para hoy'); await sleep(600); await foto(numero, media); })());
    } else if (i % 3 === 1) {
      // Paga PRIMERO y pide después: el Yape llega sin reserva previa.
      acciones.push((async () => { await foto(numero, media); await sleep(600); await texto(numero, 'ya te yapeé, anótame'); })());
    } else {
      // Manda la MISMA captura dos veces (el clásico "no me llegó, lo reenvío").
      acciones.push((async () => { await texto(numero, 'quiero jugar hoy'); await sleep(400); await foto(numero, media); await sleep(400); await foto(numero, media); })());
    }
  }
  await Promise.all(acciones);
  await sleep(7000);

  const filas = db.inscripcionesDe(partido);
  const dentro = filas.filter((i) => ['pagado', 'reservado'].includes(i.estado));
  const pagadas = filas.filter((i) => i.estado === 'pagado');
  const todosLosPagos = db.listPagosTodos();
  const pagoPorId = new Map(todosLosPagos.map((p) => [p.id, p]));
  console.log(`  → adentro ${dentro.length}/${CUPO} · pagadas ${pagadas.length} · en espera ${filas.filter((i) => i.estado === 'espera').length}`);

  console.log('\n== 1 · No hay "pagado" sin un Yape detrás ==');
  const sinYape = pagadas.filter((i) => !i.pago_id);
  check('toda inscripción pagada tiene su pago enganchado', sinYape.length === 0,
    sinYape.map((i) => i.numero || i.nombre).join(','));

  console.log('\n== 2 · Un Yape no cubre más cupos de los que compró ==');
  // Si una captura de S/10 termina cubriendo dos cupos, el partido pierde S/10
  // y no se nota hasta el día de la cancha.
  const porPago = new Map();
  for (const i of pagadas) porPago.set(i.pago_id, (porPago.get(i.pago_id) || 0) + 1);
  const excedidos = [];
  for (const [pagoId, usos] of porPago) {
    const pago = pagoPorId.get(pagoId) || null;
    const compro = pago ? Math.max(1, Math.round((pago.monto || 0) / PRECIO)) : 1;
    if (usos > compro) excedidos.push(`pago ${pagoId}: ${usos} cupos con S/${pago?.monto}`);
  }
  check('ningún pago cubre más cupos de los que pagó', excedidos.length === 0, excedidos.join(' · '));

  console.log('\n== 3 · La misma captura reenviada no confirma dos veces ==');
  const confirmadosPorOperacion = new Map();
  for (const p of todosLosPagos.filter((p) => p.estado === 'confirmado')) {
    confirmadosPorOperacion.set(p.numero_operacion, (confirmadosPorOperacion.get(p.numero_operacion) || 0) + 1);
  }
  const dobles = [...confirmadosPorOperacion].filter(([, n]) => n > 1);
  check('ninguna operación quedó confirmada dos veces', dobles.length === 0, dobles.map(([o, n]) => `${o}×${n}`).join(' '));

  console.log('\n== 4 · El monto que no calza no compra un cupo ==');
  // Sin precio correcto no hay pago válido: esos quedan "revisar" y el cupo,
  // si lo tiene, sigue siendo una reserva — no un cupo pagado.
  const mal = [];
  for (let i = 3; i < GENTE; i += 4) {
    const insc = filas.find((f) => f.numero === N(i));
    if (insc && insc.estado === 'pagado') mal.push(N(i));
  }
  check('el que pagó S/25 no quedó como pagado', mal.length === 0, mal.join(','));

  console.log('\n== 5 · No entra nadie de más ==');
  check(`nunca más de ${CUPO} adentro`, dentro.length <= CUPO, `${dentro.length}`);

  const desglose = {};
  for (const i of filas) {
    const k = `${i.estado} ${i.pago_id ? 'CON pago' : 'sin pago'}`;
    desglose[k] = (desglose[k] || 0) + 1;
  }
  console.log('  → inscripciones:', JSON.stringify(desglose));

  console.log('\n== 6 · La caja ==');
  const caja = db.cajaPartido(partido);
  console.log(`  → caja: cobrado S/${caja.cobrado} · verificado S/${caja.cobradoVerificado} · a mano S/${caja.cobradoAMano} · por cobrar S/${caja.porCobrar}`);
  check('nada cobrado "a mano": todo lo pagado vino de un Yape', caja.cobradoAMano === 0, `S/${caja.cobradoAMano}`);

  // HALLAZGO ABIERTO (2026-09-08), medido acá y todavía sin decidir qué hacer:
  // `cajaPartido` suma TODO pago enganchado a una inscripción del partido, sin
  // mirar si esa inscripción está adentro o en la lista de espera. En esta
  // corrida son 7 personas en espera que ya pagaron: la caja dice S/180 en un
  // partido de 12 lugares a S/10, que como mucho puede cobrar S/120.
  //
  // Esa plata existe y está bien registrada — lo discutible es contarla como
  // ingreso DE ESTE PARTIDO: son cupos que nadie va a jugar, así que es plata
  // por devolver o por mover a otra fecha, no caja. Cambiarlo mueve la caja, la
  // liquidación y el parte semanal, y eso lo decide Clarck, no un test.
  //
  // Mientras tanto se deja MEDIDO, que es lo que faltaba: hasta hoy nadie sabía
  // que podía pasar.
  const enEsperaPagados = filas.filter((i) => i.estado === 'espera' && i.pago_id).length;
  console.log(`  → OJO: ${enEsperaPagados} de la lista de espera ya pagaron, y su plata está dentro de "cobrado".`);
  check('la caja distingue lo cobrado a mano de lo verificado', caja.cobrado === caja.cobradoVerificado + caja.cobradoAMano);

  console.log(`\n${fallos === 0 ? '✅' : '❌'} ${ok} checks OK · ${fallos} fallos`);
  process.exit(fallos === 0 ? 0 : 1);
})();
