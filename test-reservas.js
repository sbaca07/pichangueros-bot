/**
 * Tests del CUPO GUARDADO SIN PAGAR (sin red, BD temporal).
 *
 *   node test-reservas.js
 *
 * La regla del negocio la escribió Clarck: "la inscripción es previa reserva
 * por Yape". El bot, en cambio, reservaba y guardaba el lugar para siempre:
 * un "ya te yapeo" que nunca llegaba dejaba la cancha llena para el sistema y
 * vacía en la realidad, y al que sí iba a pagar le decía "no hay cupo".
 *
 * Acá se prueba el plazo: quién lo tiene, quién no, qué lo cancela y qué pasa
 * cuando se cumple.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pich-reservas-'));
process.env.WWEBJS_AUTH_PATH = TMP;

const db = require('./src/db');

let ok = 0, fallos = 0;
function check(nombre, cond) {
  if (cond) { ok++; console.log(`  ✓ ${nombre}`); }
  else { fallos++; console.error(`  ✗ ${nombre}`); }
}
const enUnosDias = (n) => new Date(Date.now() - 5 * 3600e3 + n * 86400e3).toISOString().slice(0, 10);
const insc = (id) => db.inscripcionesDe(id);
const filaDe = (partidoId, numero) => insc(partidoId).find((i) => i.numero === numero);
/** Empuja el vencimiento de una inscripción al pasado (simula que pasó el rato). */
const { DatabaseSync } = require('node:sqlite');
const yaVenció = (id) => {
  const ayer = new Date(Date.now() - 5 * 3600e3 - 86400e3).toISOString();
  const raw = new DatabaseSync(db.dbPath);
  raw.prepare('UPDATE inscripciones SET reserva_vence_en = ? WHERE id = ?')
    .run(`${ayer.slice(0, 10)} ${ayer.slice(11, 19)}`, id);
  raw.close();
};

console.log('== El plazo se pone solo, y solo donde corresponde ==');
check('por defecto el cupo se guarda 60 min', db.reservaMinutos() === 60);

const p1 = db.crearPartido({ zona: 'brena', fecha: enUnosDias(2), hora: '8-9pm', sede: 'Cancha Test', cupo: 2 });
db.getOrCreateLead('51911100001');
const rBot = db.inscribir(p1, '51911100001');
check('la reserva del bot nace con fecha de vencimiento', !!rBot.inscripcion.reserva_vence_en);

const rPanel = db.inscribir(p1, '51911100002', { vence: false });
check('lo que anota Clarck a mano NO vence', rPanel.inscripcion.reserva_vence_en === null);

const p2 = db.crearPartido({ zona: 'brena', fecha: enUnosDias(3), hora: '8-9pm', sede: 'Cancha Test', cupo: 2 });
const pagoPrevio = db.registrarPago({ numero: '51911100003', monto: 15, numero_operacion: 'OP-R1', estado: 'confirmado' });
const rPagada = db.inscribir(p2, '51911100003', { estado: 'pagado', pagoId: pagoPrevio });
check('la inscripción que nace pagada no tiene plazo', rPagada.inscripcion.reserva_vence_en === null);

console.log('== El Yape cancela el plazo ==');
const p3 = db.crearPartido({ zona: 'brena', fecha: enUnosDias(2), hora: '9-10pm', sede: 'Cancha Test', cupo: 2 });
const rPaga = db.inscribir(p3, '51911100004');
check('nace con plazo', !!rPaga.inscripcion.reserva_vence_en);
const pago3 = db.registrarPago({ numero: '51911100004', monto: 15, numero_operacion: 'OP-R2', estado: 'confirmado' });
db.pagarInscripcion(rPaga.inscripcion.id, pago3);
check('al pagar, el cupo deja de caducar', filaDe(p3, '51911100004').reserva_vence_en === null);

const p4 = db.crearPartido({ zona: 'brena', fecha: enUnosDias(2), hora: '10-11pm', sede: 'Cancha Test', cupo: 2 });
const rVinc = db.inscribir(p4, '51911100005');
check('nace con plazo (camino vincularPago)', !!rVinc.inscripcion.reserva_vence_en);
const pago4 = db.registrarPago({ numero: '51911100005', monto: 15, numero_operacion: 'OP-R3', estado: 'confirmado' });
db.vincularPago('51911100005', pago4, 1, 'brena');
check('vincularPago también limpia el plazo', filaDe(p4, '51911100005').reserva_vence_en === null);

console.log('== El botón del panel manda: decidió una persona ==');
const p5 = db.crearPartido({ zona: 'brena', fecha: enUnosDias(2), hora: '7-8pm', sede: 'Cancha Test', cupo: 2 });
const rBoton = db.inscribir(p5, '51911100006');
db.setEstadoInscripcion(rBoton.inscripcion.id, 'reservado');
check('tocar el estado desde el panel quita el vencimiento', filaDe(p5, '51911100006').reserva_vence_en === null);

console.log('== Se cumple el plazo: el cupo vuelve a estar libre ==');
const p6 = db.crearPartido({ zona: 'comas', fecha: enUnosDias(2), hora: '8-9pm', sede: 'Cancha Test', cupo: 1 });
const rVence = db.inscribir(p6, '51911100007');
const rEspera = db.inscribir(p6, '51911100008'); // cupo 1: este cae a espera
check('el segundo cae a espera', rEspera.resultado === 'espera');
check('mientras no venza, no pasa nada', db.vencerReservas().length === 0);
yaVenció(rVence.inscripcion.id);
const vencidas = db.vencerReservas();
check('la reserva sin pago se vence', vencidas.length === 1 && vencidas[0].inscripcion.numero === '51911100007');
check('el cupo queda dado de baja', filaDe(p6, '51911100007').estado === 'baja');
check('sube el de la lista de espera', vencidas[0].promovida && vencidas[0].promovida.numero === '51911100008');
check('el promovido sin pagar arranca su propio plazo', !!filaDe(p6, '51911100008').reserva_vence_en);
check('el partido vuelve a estar completo, no vacío', db.partidosAbiertos('comas').find((p) => p.id === p6).restante === 0);
check('barrer de nuevo no vence dos veces lo mismo', db.vencerReservas().length === 0);

console.log('== Lo que NO se toca ==');
const p7 = db.crearPartido({ zona: 'comas', fecha: enUnosDias(2), hora: '9-10pm', sede: 'Cancha Test', cupo: 3 });
const rPagado7 = db.inscribir(p7, '51911100009');
const pago7 = db.registrarPago({ numero: '51911100009', monto: 10, numero_operacion: 'OP-R4', estado: 'confirmado' });
db.pagarInscripcion(rPagado7.inscripcion.id, pago7);
yaVenció(rPagado7.inscripcion.id); // aunque quedara un plazo viejo colgado
check('al que ya pagó no se le vence el cupo', db.vencerReservas().every((v) => v.inscripcion.numero !== '51911100009'));

// Voucher esperando revisión: yapeó, lo que falta es que alguien lo mire.
const rRevisar = db.inscribir(p7, '51911100010');
db.registrarPago({ numero: '51911100010', monto: 10, numero_operacion: 'OP-R5', estado: 'revisar', motivo: 'monto no coincide' });
yaVenció(rRevisar.inscripcion.id);
check('con el Yape en revisión NO se le quita el cupo', db.vencerReservas().every((v) => v.inscripcion.numero !== '51911100010'));
check('y sigue ocupando su lugar', filaDe(p7, '51911100010').estado === 'reservado');

// Partido que ya empezó: a esa altura decide Clarck en la cancha, no el reloj.
const pAyer = db.crearPartido({ zona: 'comas', fecha: enUnosDias(-1), hora: '8-9pm', sede: 'Cancha Test', cupo: 3 });
const rViejo = db.inscribir(pAyer, '51911100011');
yaVenció(rViejo.inscripcion.id);
check('en un partido que ya pasó no se vence nada', db.vencerReservas().every((v) => v.inscripcion.numero !== '51911100011'));

console.log('== El plazo se puede apagar ==');
db.setConfig({ reserva_minutos: '0' });
check('con 0 minutos el plazo queda desactivado', db.reservaMinutos() === 0);
const p8 = db.crearPartido({ zona: 'brena', fecha: enUnosDias(2), hora: '6-7pm', sede: 'Cancha Test', cupo: 2 });
const rSinPlazo = db.inscribir(p8, '51911100012');
check('con el plazo apagado la reserva no caduca', rSinPlazo.inscripcion.reserva_vence_en === null);
db.setConfig({ reserva_minutos: '45' });
check('el plazo se edita desde Config', db.reservaMinutos() === 45);

console.log(`\n${fallos === 0 ? '✅' : '❌'} ${ok} checks OK, ${fallos} fallos`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
process.exit(fallos === 0 ? 0 : 1);
