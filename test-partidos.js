/**
 * Tests del modelo de partidos e inscripciones (sin red, BD temporal).
 *
 *   node test-partidos.js
 *
 * Cubre: crear partido, cupos, inscripción idempotente, lista de espera,
 * promoción al dar de baja, vínculo pago→partido (las 3 reglas), lista para
 * el grupo y asistencia.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

// La BD se abre al hacer require de src/db — apuntarla a un directorio temporal
// ANTES, para no tocar la BD real ni dejar basura.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pich-test-'));
process.env.WWEBJS_AUTH_PATH = TMP;

const db = require('./src/db');

let ok = 0, fallos = 0;
function check(nombre, cond) {
  if (cond) { ok++; console.log(`  ✓ ${nombre}`); }
  else { fallos++; console.error(`  ✗ ${nombre}`); }
}
const enUnosDias = (n) => new Date(Date.now() - 5 * 3600e3 + n * 86400e3).toISOString().slice(0, 10);

console.log('== Crear partido y cupos ==');
const p1 = db.crearPartido({ zona: 'brena', fecha: enUnosDias(2), hora: '8-9pm', sede: 'Cancha Test', cupo: 3 });
check('crearPartido devuelve un id', Number.isInteger(p1) && p1 > 0);
const partido = db.getPartido(p1);
check('el partido nace abierto', partido.estado === 'abierto');
check('partidosAbiertos lo lista con cupo restante', db.partidosAbiertos('brena').find((p) => p.id === p1)?.restante === 3);
check('partidosAbiertos de otra zona no lo trae', !db.partidosAbiertos('comas').find((p) => p.id === p1));

console.log('== Inscripción, idempotencia y lista de espera ==');
db.getOrCreateLead('51900000001');
const r1 = db.inscribir(p1, '51900000001');
check('primer jugador queda reservado', r1.resultado === 'reservado');
const r1b = db.inscribir(p1, '51900000001');
check('inscribirse dos veces no duplica (ya_inscrito)', r1b.resultado === 'ya_inscrito' && r1b.inscripcion.id === r1.inscripcion.id);
db.inscribir(p1, '51900000002');
db.inscribir(p1, '51900000003');
const r4 = db.inscribir(p1, '51900000004');
check('con el cupo lleno (3/3) el cuarto cae a espera', r4.resultado === 'espera');
check('la espera no ocupa cupo', db.partidosAbiertos('brena').find((p) => p.id === p1).restante === 0);

console.log('== Baja promueve al primero de la espera ==');
const promovido = db.darDeBaja(r1.inscripcion.id);
check('al dar de baja, el de la espera sube', promovido && promovido.numero === '51900000004' && promovido.estado === 'reservado');
check('bajar a alguien de la espera no promueve a nadie', (() => {
  const r5 = db.inscribir(p1, '51900000005'); // cae a espera (cupo lleno de nuevo)
  return r5.resultado === 'espera' && db.darDeBaja(r5.inscripcion.id) === null;
})());

console.log('== Vínculo pago → partido ==');
const pagoA = db.registrarPago({ numero: '51900000002', monto: 15, numero_operacion: 'OP-A', estado: 'confirmado' });
check('registrarPago devuelve id', Number.isInteger(pagoA) && pagoA > 0);
const vA = db.vincularPago('51900000002', pagoA, 1, 'brena');
check('regla 1: con reserva previa, el cupo pasa a pagado', vA && vA.inscripciones[0].estado === 'pagado' && vA.partido.id === p1);
db.getOrCreateLead('51900000010');
const pagoB = db.registrarPago({ numero: '51900000010', monto: 30, numero_operacion: 'OP-B', estado: 'confirmado' });
const vB = db.vincularPago('51900000010', pagoB, 2, 'brena');
check('regla 2: sin reserva y con UN partido abierto en la zona, inscribe directo', vB !== null);
check('los cupos extra entran como invitados', vB && vB.inscripciones.length === 2 && vB.inscripciones[1].nombre?.startsWith('Invitado'));
const p2 = db.crearPartido({ zona: 'brena', fecha: enUnosDias(4), cupo: 10 });
db.getOrCreateLead('51900000011');
const pagoC = db.registrarPago({ numero: '51900000011', monto: 15, numero_operacion: 'OP-C', estado: 'confirmado' });
check('regla 3: con DOS partidos abiertos en la zona no se adivina (null)', db.vincularPago('51900000011', pagoC, 1, 'brena') === null);
check('ese pago aparece en pagosSinPartido', db.pagosSinPartido().some((p) => p.id === pagoC));
check('los pagos vinculados NO aparecen ahí', !db.pagosSinPartido().some((p) => p.id === pagoA));

console.log('== Lista para el grupo ==');
const lista = db.textoLista(p1);
check('la lista tiene el encabezado de la zona', /PICHANGA/.test(lista) && /Test/.test(lista));
check('numera todos los cupos del partido', lista.includes('3.'));
check('marca a los pagados con check', /✅/.test(lista));
check('incluye la lista de espera', /espera/i.test(lista));

console.log('== Asistencia y estados ==');
const insc = db.inscripcionesDe(p1).find((i) => i.estado === 'pagado');
db.setAsistencia(insc.id, 'si');
check('asistencia queda marcada', db.inscripcionesDe(p1).find((i) => i.id === insc.id).asistencia === 'si');
db.setAsistencia(insc.id, 'invalido');
check('un valor inválido la limpia (null)', db.inscripcionesDe(p1).find((i) => i.id === insc.id).asistencia === null);
db.setEstadoPartido(p1, 'jugado');
check('cambiar estado del partido funciona', db.getPartido(p1).estado === 'jugado');
check('un partido jugado ya no acepta inscripciones', db.inscribir(p1, '51900000099').resultado === null);
check('asistenciasDe trae el historial del jugador', db.asistenciasDe('51900000002').length === 1);

console.log('== El precio del PARTIDO manda sobre el de la zona ==');
const pagos = require('./src/pagos');
const p3 = db.crearPartido({ zona: 'comas', fecha: enUnosDias(3), cupo: 10, precio: 20 });
db.getOrCreateLead('51900000020');
db.updateLead('51900000020', { zona: 'brena' });
db.inscribir(p3, '51900000020');
check('partidoReservadoDe encuentra la reserva activa', db.partidoReservadoDe('51900000020')?.id === p3);
const lecturaBase = { es_voucher_yape: true, medio: 'yape', monto: 20, nombre_remitente: 'Test', numero_operacion: 'OP-P3', confianza: 'alta' };
check('S/20 del partido custom pasa aunque su zona cueste distinto',
  pagos.evaluarVoucher('51900000020', 'brena', lecturaBase).estado === 'confirmado');
check('el precio de su zona ya NO calza — la reserva de S/20 manda',
  pagos.evaluarVoucher('51900000020', 'brena', { ...lecturaBase, monto: 15, numero_operacion: 'OP-P3B' }).estado === 'revisar');
check('sin reserva se sigue validando contra la zona del contacto', (() => {
  db.getOrCreateLead('51900000021');
  db.setEstadoPartido(p3, 'cerrado'); // sin partidos que capturen la reserva
  const precioBrena = db.getNegocio().zonas.brena.precio;
  const r = pagos.evaluarVoucher('51900000021', 'brena', { ...lecturaBase, monto: precioBrena, numero_operacion: 'OP-Z1' });
  return r.estado === 'confirmado';
})());

console.log(fallos ? `\n❌ ${ok} OK, ${fallos} FALLOS` : `\n✅ ${ok} checks OK, 0 fallos`);
process.exit(fallos ? 1 : 0);
