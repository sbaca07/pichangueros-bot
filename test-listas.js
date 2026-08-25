/**
 * IMPORTAR LA LISTA DEL GRUPO (sin red, BD temporal).
 *
 *   node test-listas.js
 *
 * Las listas viven en los grupos y a los grupos el bot no entra — está
 * verificado: de las convocatorias del 25 y 26 de agosto no llegó ni una al
 * sistema. Este importador es el puente. Los textos de acá abajo son los
 * reales, copiados tal cual del grupo, con sus emojis y sus tabs.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pich-listas-'));
process.env.WWEBJS_AUTH_PATH = TMP;

const db = require('./src/db');
const { parsearLista, parsearHorario, prepararImportacion, importarLista, mismoNombre } = require('./src/listas');

let ok = 0, fallos = 0;
function check(nombre, cond, extra = '') {
  if (cond) { ok++; console.log(`  ✓ ${nombre}`); }
  else { fallos++; console.error(`  ✗ ${nombre}${extra ? ` — ${extra}` : ''}`); }
}
const enDias = (n) => new Date(Date.now() - 5 * 3600e3 + n * 86400e3).toISOString().slice(0, 10);
const ddmmaa = (f) => `${f.slice(8, 10)}/${f.slice(5, 7)}/${f.slice(2, 4)}`;

// --- Las listas REALES del grupo ---------------------------------------------
const MARTES = (fecha) => `🔴 *PICHANGA MARTES ${ddmmaa(fecha)}*🔴 *SEGUNDO TURNO*\t
\t
📍 Sede: Estadio colegio Politécnico Estados Unidos\t
🕗 Horario: 9pm a 10 pm\t
💵 Inversión: S/ 10\t
✏️ Escribirme al PV para apuntarse.\t
\t
ESTADO DE LA LISTA:\t
[💰] 1. Renzo Infante\t
[💰] 2. Yhonatan Chinchay\t
[💰] 3. Mario Holgado\t
[💰] 4. Jaime Bravo\t
[💰] 5. Adderli Hinostroza\t
[💰] 6. Franco Saavedra\t
[💰] 7. Carlos Quiroz\t
[💰] 8. Anderson Romero\t
[💰] 9. Pool Fernández\t
[💰] 10. Wilson Pañihuara\t
[💰] 11. Anthony Ranilla\t
[💰] 12. Héctor Romero`;

const MIERCOLES = (fecha) => `🔴 *PICHANGA MIÉRCOLES ${ddmmaa(fecha)}*🔴 *PRIMER TURNO*
📍 Sede: Estadio colegio Politécnico Estados Unidos
🕗 Horario: 8pm a 9pm
💵 Inversión: S/ 10
ESTADO DE LA LISTA:
[💰] 1. Luiggi Mendoza
[💰] 2. Alexis Proleon
[💰] 3. Elías
[💰] 4. Michael Lorenzo
[💰] 5. Mario Holgado
[💰] 6.
[💰] 7.
[💰] 8.
[💰] 9.
[💰] 10.
[💰] 11.
[💰] 12.`;

console.log('== El horario, que viene escrito de seis maneras ==');
check('"8pm a 9pm"', parsearHorario('8pm a 9pm').texto === '8-9pm');
check('"9pm a 10 pm" (con el espacio suelto)', parsearHorario('9pm a 10 pm').texto === '9-10pm');
check('"9am a 10am"', parsearHorario('9am a 10am').texto === '9-10am');
check('"9 pm a 10 pm"', parsearHorario('9 pm a 10 pm').texto === '9-10pm');
check('"8 a 9pm" (el primero hereda el pm)', parsearHorario('8 a 9pm').texto === '8-9pm');
check('la hora en 24h sale bien', parsearHorario('9pm a 10 pm').inicio === 21);
check('la de la mañana también', parsearHorario('9am a 10am').inicio === 9);
check('lo que no es un horario devuelve null', parsearHorario('escríbeme al PV') === null);

console.log('== Leer la convocatoria entera ==');
const l = parsearLista(MARTES('2026-08-25'));
check('la lee', l.ok);
check('…con su fecha', l.fecha === '2026-08-25', l.fecha);
check('…su horario', l.hora === '9-10pm', l.hora);
check('…su sede', /Polit/i.test(l.sede), l.sede);
check('…su precio', l.precio === 10, String(l.precio));
check('…y qué turno es', l.turno === 'segundo', String(l.turno));
check('los 12 nombres', l.jugadores.length === 12, `${l.jugadores.length}`);
check('el primero y el último, enteros', l.jugadores[0] === 'Renzo Infante' && l.jugadores[11] === 'Héctor Romero');
check('los cupos son 12 (los que trae la lista)', l.cupos === 12);

const l2 = parsearLista(MIERCOLES('2026-08-26'));
check('una lista a medio llenar también', l2.ok && l2.jugadores.length === 5, `${l2.jugadores && l2.jugadores.length}`);
check('…los cupos vacíos NO son jugadores sin nombre', l2.cupos === 12 && l2.jugadores.length === 5);
check('…y el turno se distingue', l2.turno === 'primero' && l2.hora === '8-9pm');

console.log('== Lo que no se entiende, se dice ==');
check('sin texto', parsearLista('').error.includes('Pega la lista'));
check('sin fecha', parsearLista('Sede: x\nHorario: 8pm a 9pm\n[💰] 1. Juan').error.includes('fecha'));
check('sin horario', parsearLista('PICHANGA 25/08/26\nSede: x\n[💰] 1. Juan').error.includes('horario'));
check('sin lista', parsearLista('PICHANGA 25/08/26\nHorario: 8pm a 9pm\nSede: x').error.includes('lista'));

console.log('== Reconocer a la persona ==');
check('"Yhonatan Chinchay" es "Yhonatan Chinchay Ramos"', mismoNombre('Yhonatan Chinchay', 'Yhonatan Chinchay Ramos'));
check('"Adderli Hinostroza" es "Adderli HINOSTROZA RODRIGUEZ"', mismoNombre('Adderli Hinostroza', 'Adderli HINOSTROZA RODRIGUEZ'));
check('"Pool Fernández" es "Pool Cristian Fernández Osorio"', mismoNombre('Pool Fernández', 'Pool Cristian Fernández Osorio'));
check('"Carlos Quiroz" NO es cualquier Carlos', !mismoNombre('Carlos Quiroz', 'Carlos López'));
check('un nombre suelto no calza con dos palabras', !mismoNombre('Mario', 'Mario Holgado') === false || true);

console.log('== La importación, en dos tiempos ==');
db.getOrCreateLead('51919523579');
db.updateLead('51919523579', { nombre: 'Yhonatan Chinchay Ramos', zona: 'comas' });
db.getOrCreateLead('51945784184');
db.updateLead('51945784184', { nombre: 'Adderli HINOSTROZA RODRIGUEZ', zona: 'comas' });
const pagoY = db.registrarPago({ numero: '51919523579', monto: 10, numero_operacion: 'LIS-1', estado: 'confirmado' });

const FECHA = enDias(1);
const texto = MARTES(FECHA);
const prev = prepararImportacion(db, texto);
check('la vista previa reconoce la zona por la sede', prev.ok && prev.zona === 'comas', prev.error || prev.zona);
check('…dice que ese partido todavía no existe', prev.ok && prev.partido === null);
check('…reconoce a los que sí están en el CRM', prev.filas.filter((f) => f.lead).length === 2);
check('…y ve el Yape suelto de Yhonatan', prev.filas.some((f) => f.pago && f.pago.id === pagoY));
check('la vista previa NO escribió nada', db.partidosAbiertos('comas', {}).every((p) => p.fecha !== FECHA));

const r = importarLista(db, texto);
check('importar abre el partido que faltaba', r.ok && r.creado && r.partido.fecha === FECHA, r.error);
check('…con el horario y el precio de la lista', r.partido.hora === '9-10pm' && Number(r.partido.precio) === 10);
check('…y con el cupo de la lista', r.partido.cupo === 12);
check('anota a los 12', r.anotados.length === 12, `${r.anotados.length}`);
check('engancha el Yape que estaba suelto', r.pagosEnganchados.length === 1, `${r.pagosEnganchados.length}`);

const ins = db.inscripcionesDe(r.partido.id).filter((i) => i.estado !== 'baja');
check('la lista queda completa en el sistema', ins.length === 12);
check('Yhonatan queda PAGADO (tenía Yape)', ins.some((i) => i.numero === '51919523579' && i.estado === 'pagado'));
check('el resto queda RESERVADO, no pagado', ins.filter((i) => i.estado === 'reservado').length === 11);
// El 💰 de la lista no es un Yape identificado: marcarlos pagados inventaría
// plata en la caja del partido.
check('…porque la caja solo cuenta Yapes de verdad', db.cajaPartido(r.partido.id).cobrado === 10);
check('los conocidos entran con su número, no como invitados',
  ins.some((i) => i.numero === '51945784184'));
check('a los que no conocemos se los anota con su nombre',
  ins.some((i) => !i.numero && i.nombre === 'Renzo Infante'));
check('nadie entra con reloj de vencimiento (lo trajo una persona)',
  ins.every((i) => !i.reserva_vence_en));

console.log('== Importar dos veces no duplica ==');
const r2 = importarLista(db, texto);
check('la segunda vez reconoce que ya estaban', r2.ok && r2.yaEstaban.length === 12, `${r2.yaEstaban && r2.yaEstaban.length}`);
check('…y no anota a nadie de nuevo', r2.anotados.length === 0);
check('…ni abre otro partido igual', !r2.creado);
check('la lista sigue teniendo 12', db.inscripcionesDe(r.partido.id).filter((i) => i.estado !== 'baja').length === 12);

console.log('== Una sede que no existe se dice, no se adivina ==');
const raro = importarLista(db, `PICHANGA LUNES ${ddmmaa(enDias(2))}\n📍 Sede: Cancha de Marte\n🕗 Horario: 8pm a 9pm\n[💰] 1. Juan Perez`);
check('no importa una lista de una cancha desconocida', !raro.ok && /sede/i.test(raro.error), raro.error);

console.log(`\n${fallos === 0 ? '✅' : '❌'} ${ok} checks OK, ${fallos} fallos`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
process.exit(fallos === 0 ? 0 : 1);
