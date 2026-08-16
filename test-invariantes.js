/**
 * Las reglas que la BD tiene que sostener pase lo que pase (etapa 0).
 *
 *   node test-invariantes.js        (~5 s, sin red)
 *
 * Cuatro agujeros que salieron de la auditoría del 16/08. Los tres primeros
 * muerden plata; el cuarto deja basura que después miente en la caja.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pich-inv-'));
process.env.WWEBJS_AUTH_PATH = TMP;
const db = require('./src/db');

let ok = 0, fallos = 0;
const check = (nombre, cond) => { if (cond) { ok++; console.log(`  ✓ ${nombre}`); } else { fallos++; console.error(`  ✗ ${nombre}`); } };
const enDias = (n) => new Date(Date.now() - 5 * 3600e3 + n * 86400e3).toISOString().slice(0, 10);
const ocupados = (id) => db.inscripcionesDe(id).filter((i) => ['reservado', 'pagado'].includes(i.estado)).length;

console.log('== 1 · La cancha no se sobrevende desde el panel ==');
// Cupo 2: dos en cancha y uno en espera. Subir al de espera metía 3 en 2.
const p = db.crearPartido({ zona: 'brena', fecha: enDias(1), hora: '8-9pm', cupo: 2, precio: 15 });
const a = db.inscribir(p, '51900000101', { nombre: 'A' });
const b = db.inscribir(p, '51900000102', { nombre: 'B' });
const c = db.inscribir(p, '51900000103', { nombre: 'C' });
check('los dos primeros entran a la cancha', a.resultado === 'reservado' && b.resultado === 'reservado');
check('el tercero cae en espera', c.resultado === 'espera');

const subida = db.setEstadoInscripcion(c.inscripcion.id, 'reservado');
check('subirlo con la cancha llena se rechaza', subida.motivo === 'lleno');
check('y sigue en espera', db.inscripcionActiva(p, '51900000103').estado === 'espera');
check('la cancha sigue con 2 de 2', ocupados(p) === 2);

const pagoC = db.registrarPago({ numero: '51900000103', monto: 15, numero_operacion: 'OP-INV-1', estado: 'confirmado' });
const rPago = db.pagarInscripcion(c.inscripcion.id, pagoC);
check('pagar tampoco lo cuela', rPago.motivo === 'lleno_queda_en_espera');
check('la cancha sigue con 2 de 2 después de pagar', ocupados(p) === 2);
check('pero el pago SÍ queda registrado en su fila', db.inscripcionesDe(p).find((i) => i.id === c.inscripcion.id).pago_id === pagoC);

db.setEstadoInscripcion(a.inscripcion.id, 'baja');
const subida2 = db.setEstadoInscripcion(c.inscripcion.id, 'reservado');
check('liberado un lugar, ahora sí sube', subida2.motivo === null && ocupados(p) === 2);

console.log('== 2 · Un pago sin partido no caduca ==');
// Antes pagosSinPartido filtraba por 48 h: pasado ese plazo el Yape cobrado y
// sin cupo desaparecía de la cola para siempre.
const viejo = db.registrarPago({ numero: '51900000104', monto: 15, numero_operacion: 'OP-INV-2', estado: 'confirmado' });
db.getOrCreateLead('51900000104');
// Se envejece el pago tocando la BD directo: no hay API para viajar en el tiempo.
const conn = new (require('node:sqlite').DatabaseSync)(db.dbPath);
conn.prepare("UPDATE pagos SET creado_en = datetime('now','-5 hours','-10 days') WHERE id = ?").run(viejo);
conn.close();
check('un pago de hace 10 días sigue en la cola', db.pagosSinPartido().some((x) => x.id === viejo));

db.setCorte(enDias(-1));
check('el punto de arranque sí lo saca (es el "empezar en limpio")', !db.pagosSinPartido().some((x) => x.id === viejo));
db.setCorte('2000-01-01');

console.log('== 3 · No se crean partidos en zonas que no existen ==');
check('zona inventada → no se crea', db.crearPartido({ zona: 'narnia', fecha: enDias(1), cupo: 10 }) === null);
check('zona operativa → sí', Number.isInteger(db.crearPartido({ zona: 'comas', fecha: enDias(1), cupo: 10 })));

console.log('== 4 · Borrar un contacto no deja su cupo ocupado ==');
const p2 = db.crearPartido({ zona: 'brena', fecha: enDias(2), hora: '8-9pm', cupo: 10, precio: 15 });
db.getOrCreateLead('51900000105');
db.inscribir(p2, '51900000105', { nombre: 'Fantasma' });
const pagoF = db.registrarPago({ numero: '51900000105', monto: 15, numero_operacion: 'OP-INV-3', estado: 'confirmado' });
db.pagarInscripcion(db.inscripcionActiva(p2, '51900000105').id, pagoF);
check('antes de borrar ocupa un lugar', ocupados(p2) === 1);
db.deleteLead('51900000105');
check('borrado el contacto, el cupo se libera', ocupados(p2) === 0);
check('y no queda una inscripción apuntando a un pago borrado',
  !db.inscripcionesDe(p2).some((i) => i.pago_id === pagoF));

console.log('== 5 · La caja ve la plata cobrada a mano ==');
// "💰 Pagó" marca la inscripción pagada sin enganchar un pago: esa plata no
// entraba en cobrado (suma vouchers) ni en porCobrar (cuenta reservados).
const pc = db.crearPartido({ zona: 'brena', fecha: enDias(4), hora: '8-9pm', cupo: 14, precio: 15 });
db.getOrCreateLead('51900000106');
const rc = db.inscribir(pc, '51900000106', { nombre: 'Cobrado a mano' });
check('reservado: la plata está en porCobrar', db.cajaPartido(pc).porCobrar === 15);
db.setEstadoInscripcion(rc.inscripcion.id, 'pagado');
const caja1 = db.cajaPartido(pc);
check('marcado pagado a mano: la plata pasa a cobrado', caja1.cobrado === 15);
check('y ya no figura como por cobrar', caja1.porCobrar === 0);
check('se distingue de lo verificado por voucher', caja1.cobradoAMano === 15 && caja1.cobradoVerificado === 0);

console.log('== 6 · El costo de cancha no depende de que el nombre calce exacto ==');
db.addSede({ zona: 'comas', nombre: 'Politécnico Estados Unidos', cupo: 12, costo: 150 });
const pn = db.crearPartido({ zona: 'comas', fecha: enDias(5), hora: '8-9pm', sede: 'Politecnico', cupo: 12, precio: 10 });
check('con el nombre tipeado distinto, igual encuentra el costo de la zona',
  db.cajaPartido(pn).costoCancha === 150);

console.log('== 7 · Quien paga deja de ser "Nuevo" ==');
// Luiggi llevaba 3 pagos y S/30 y seguía en "Nuevo": el embudo solo avanzaba
// con nombre+edad+distrito y con el link del grupo, así que el que paga sin
// registrarse —el que deja plata— se caía del modelo.
db.getOrCreateLead('51900000107');
check('arranca en nuevo', db.getLead('51900000107').estado === 'nuevo');
db.registrarPago({ numero: '51900000107', monto: 15, numero_operacion: 'OP-INV-9', estado: 'confirmado' });
check('con un pago confirmado pasa a Jugador', db.getLead('51900000107').estado === 'activo');
check('sin haber dado un solo dato', !db.getLead('51900000107').nombre);

db.getOrCreateLead('51900000108');
db.registrarPago({ numero: '51900000108', monto: 15, numero_operacion: 'OP-INV-10', estado: 'revisar' });
check('un pago POR REVISAR no lo mueve', db.getLead('51900000108').estado === 'nuevo');

db.updateLead('51900000107', { estado: 'inactivo' });
db.registrarPago({ numero: '51900000107', monto: 15, numero_operacion: 'OP-INV-11', estado: 'confirmado' });
check('un inactivo que vuelve a pagar, revive', db.getLead('51900000107').estado === 'activo');

console.log('== 8 · La caja no devuelve NaN cuando falta el precio ==');
// p.precio ?? Number(cfg[...]) ?? 0 → el ?? no atrapa NaN y la caja salía NaN.
const p3 = db.crearPartido({ zona: 'comas', fecha: enDias(3), hora: '8-9pm', cupo: 10 });
db.setConfig('precio_comas', '');
const caja = db.cajaPartido(p3);
check('cobrado es un número', Number.isFinite(caja.cobrado));
check('por pagar es un número', Number.isFinite(caja.porPagar));

console.log(`\n${fallos ? '❌' : '✅'} ${ok} checks OK, ${fallos} fallos`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
process.exit(fallos ? 1 : 0);
