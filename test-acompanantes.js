/**
 * "Vengo con un amigo" — de uno a tres acompañantes, y el que separa cupos
 * en dos tandas (sin red, BD temporal).
 *
 *   node test-acompanantes.js
 *
 * test-casuisticas.js ya cubre el caso Patrick (un cupo + UN invitado en un
 * segundo Yape). Lo que faltaba probar es lo que pasa cuando son varios: la
 * pichanga se llena de a grupos, y contar mal un acompañante no es un dato
 * mal puesto, es una persona parada afuera de la cancha o una cancha
 * sobrevendida.
 *
 * Dos formas de venir acompañado, y las dos tienen que terminar igual:
 *   a) un solo Yape por todos (S/45 = yo + 2)
 *   b) yapeé lo mío, y después separo los de mis amigos (Patrick, pero de a N)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pich-test-'));
process.env.WWEBJS_AUTH_PATH = TMP;

const db = require('./src/db');

let ok = 0, fallos = 0;
function check(nombre, cond) {
  if (cond) { ok++; console.log(`  ✓ ${nombre}`); }
  else { fallos++; console.error(`  ✗ ${nombre}`); }
}
const enDias = (n) => new Date(Date.now() - 5 * 3600e3 + n * 86400e3).toISOString().slice(0, 10);
const ocupados = (id) => db.inscripcionesDe(id).filter((i) => ['reservado', 'pagado'].includes(i.estado)).length;
const enEspera = (id) => db.inscripcionesDe(id).filter((i) => i.estado === 'espera').length;

// ───────────────────────────────────────────────────────────────────────────
console.log('== Un solo Yape por todo el grupo ==');
// Acá la aritmética sola alcanza: el monto dice cuántos son.
const grupos = [
  { n: 1, monto: 15, dice: 'vengo solo' },
  { n: 2, monto: 30, dice: 'vengo con un amigo' },
  { n: 3, monto: 45, dice: 'vengo con dos amigos' },
  { n: 4, monto: 60, dice: 'vengo con tres amigos' },
];
for (const g of grupos) {
  const numero = `5190000${1000 + g.n}`;
  db.getOrCreateLead(numero);
  // Un partido propio por grupo: mismo día y hora sería el MISMO partido
  // (crearPartido no duplica una cancha ya alquilada) y las cuentas se pisarían.
  const p = db.crearPartido({ zona: 'brena', fecha: enDias(10 + g.n), hora: '9-10pm', cupo: 16, precio: 15 });
  check(`"${g.dice}": S/${g.monto} a S/15 son ${g.n} cupos`, db.cuposPorMonto(g.monto, 15) === g.n);
  const pago = db.registrarPago({ numero, monto: g.monto, numero_operacion: `OP-G${g.n}`, estado: 'confirmado' });
  const v = db.vincularPago(numero, pago, g.n, 'brena', g.monto, { partidoId: p });
  check(`  se anotan los ${g.n} en la lista`, v?.inscripciones.length === g.n);
  check('  el titular va con su número y los acompañantes sin número', v.inscripciones[0].numero === numero && v.inscripciones.slice(1).every((i) => i.numero === null));
  check(`  ocupan ${g.n} lugares de la cancha`, ocupados(p) === g.n);
  check('  todos cuelgan del MISMO Yape', v.inscripciones.every((i) => i.pago_id === pago));
  check(`  la caja del partido cobró S/${g.monto} una sola vez`, db.cajaPartido(p).cobradoVerificado === g.monto);
  check(`  quedan ${g.n - 1} acompañantes esperando nombre`, db.invitadosSinNombre(numero).length === g.n - 1);
}

console.log('== Reservé mi cupo y después pago por los tres ==');
// El camino más común en el chat: primero "anótame", después llega el Yape del
// grupo entero. El cupo reservado NO se duplica: se paga y los amigos se
// agregan al lado.
const RES = '51900002001';
db.getOrCreateLead(RES);
const pRes = db.crearPartido({ zona: 'brena', fecha: enDias(3), hora: '8-9pm', cupo: 16, precio: 15 });
const r = db.inscribir(pRes, RES);
check('primero queda reservado, sin plata', r.resultado === 'reservado');
const pagoRes = db.registrarPago({ numero: RES, monto: 45, numero_operacion: 'OP-RES', estado: 'confirmado' });
const vRes = db.vincularPago(RES, pagoRes, 3, 'brena', 45);
check('el Yape de S/45 cae sobre la reserva que ya tenía', vRes?.partido.id === pRes && vRes.inscripciones[0].id === r.inscripcion.id);
check('su cupo pasa a pagado y no se crea uno nuevo', db.inscripcionesDe(pRes).filter((i) => i.numero === RES).length === 1);
check('y su reserva deja de caducar (ya hay plata atrás)', db.inscripcionActiva(pRes, RES).reserva_vence_en === null);
check('los dos amigos entran con el mismo pago', vRes.inscripciones.length === 3);
check('son 3 en la cancha', ocupados(pRes) === 3);

console.log('== Pago un cupo hoy y separo dos más después ==');
const DOS = '51900003001';
db.getOrCreateLead(DOS);
const pDos = db.crearPartido({ zona: 'brena', fecha: enDias(4), hora: '9-10pm', cupo: 16, precio: 15 });
const y1 = db.registrarPago({ numero: DOS, monto: 15, numero_operacion: 'OP-DOS-1', estado: 'confirmado' });
db.vincularPago(DOS, y1, 1, 'brena', 15, { partidoId: pDos });
check('el primer Yape lo deja adentro solo', ocupados(pDos) === 1);
const y2 = db.registrarPago({ numero: DOS, monto: 30, numero_operacion: 'OP-DOS-2', estado: 'confirmado' });
check('un segundo Yape de S/30 sin decir para quién NO inventa dos jugadores', db.vincularPago(DOS, y2, 2, 'brena', 30, { partidoId: pDos }) === null);
check('siguen siendo 1 en la cancha', ocupados(pDos) === 1);
const vDos = db.vincularPago(DOS, y2, 2, 'brena', 30, { partidoId: pDos, invitados: true });
check('leyendo que son para dos amigos, se crean los DOS cupos', vDos?.invitados === true && vDos.inscripciones.length === 2);
check('ninguno de los dos tiene número propio', vDos.inscripciones.every((i) => i.numero === null));
check('ahora son 3 en la cancha', ocupados(pDos) === 3);
check('la caja suma los dos Yapes: S/45', db.cajaPartido(pDos).cobradoVerificado === 45);
check('reenviar la MISMA captura no agrega un cuarto', (() => {
  db.vincularPago(DOS, y2, 2, 'brena', 30, { partidoId: pDos, invitados: true });
  return ocupados(pDos) === 3;
})());

console.log('== Tres tandas: uno, otro, y otro más ==');
// El que va sumando amigos de a uno a lo largo del día. Cada Yape es un cupo
// nuevo, y ninguno pisa al anterior.
const TRES = '51900004001';
db.getOrCreateLead(TRES);
const pTres = db.crearPartido({ zona: 'brena', fecha: enDias(5), hora: '8-9pm', cupo: 16, precio: 15 });
const t1 = db.registrarPago({ numero: TRES, monto: 15, numero_operacion: 'OP-T1', estado: 'confirmado' });
db.vincularPago(TRES, t1, 1, 'brena', 15, { partidoId: pTres });
const t2 = db.registrarPago({ numero: TRES, monto: 15, numero_operacion: 'OP-T2', estado: 'confirmado' });
db.vincularPago(TRES, t2, 1, 'brena', 15, { partidoId: pTres, invitados: true });
const t3 = db.registrarPago({ numero: TRES, monto: 15, numero_operacion: 'OP-T3', estado: 'confirmado' });
db.vincularPago(TRES, t3, 1, 'brena', 15, { partidoId: pTres, invitados: true });
check('tres Yapes sueltos son tres cupos', ocupados(pTres) === 3);
check('cada cupo cuelga de su propio Yape', new Set(db.inscripcionesDe(pTres).map((i) => i.pago_id)).size === 3);
check('la caja cobró los tres: S/45', db.cajaPartido(pTres).cobradoVerificado === 45);
check('quedan 2 acompañantes sin nombre', db.invitadosSinNombre(TRES).length === 2);

console.log('== Ponerles nombre a varios acompañantes ==');
const nom = db.nombrarInvitados(TRES, ['Luis Ramos', 'Beto Quispe']);
check('manda los dos nombres juntos y se escriben los dos', nom.length === 2);
check('quedan en la lista del partido', ['Luis Ramos', 'Beto Quispe'].every((n) => db.inscripcionesDe(pTres).some((i) => i.nombre === n)));
check('no queda ninguno sin nombre', db.invitadosSinNombre(TRES).length === 0);
check('los nombres van en el orden en que se pagaron los cupos', (() => {
  const invs = db.inscripcionesDe(pTres).filter((i) => i.numero === null).sort((a, b) => a.id - b.id);
  return invs[0].nombre === 'Luis Ramos' && invs[1].nombre === 'Beto Quispe';
})());
check('un tercer nombre sin cupo pagado atrás no anota a nadie', db.nombrarInvitados(TRES, ['Fantasma Perez']).length === 0);
check('mandar MÁS nombres que cupos solo usa los que hay', (() => {
  const otro = '51900004002';
  db.getOrCreateLead(otro);
  const po = db.crearPartido({ zona: 'brena', fecha: enDias(5), hora: '7-8pm', cupo: 16, precio: 15 });
  const pg = db.registrarPago({ numero: otro, monto: 30, numero_operacion: 'OP-SOBRA', estado: 'confirmado' });
  db.vincularPago(otro, pg, 2, 'brena', 30, { partidoId: po });
  const hechos = db.nombrarInvitados(otro, ['Uno Real', 'Dos Fantasma', 'Tres Fantasma']);
  return hechos.length === 1 && !db.inscripcionesDe(po).some((i) => i.nombre === 'Dos Fantasma');
})());

console.log('== El grupo que no entra entero ==');
// Quedan 2 lugares y llega un Yape por 3. Los que caben entran; el que sobra
// va a la espera. Lo que NUNCA puede pasar es que entren los 3: atrás hay una
// cancha alquilada con un número fijo de lugares.
const pApreta = db.crearPartido({ zona: 'brena', fecha: enDias(6), hora: '8-9pm', cupo: 3, precio: 15 });
const YA = '51900005001', GRUPO = '51900005002';
[YA, GRUPO].forEach((n) => db.getOrCreateLead(n));
db.inscribir(pApreta, YA);
check('la cancha de 3 ya tiene 1 adentro: quedan 2', ocupados(pApreta) === 1);
const pagoG = db.registrarPago({ numero: GRUPO, monto: 45, numero_operacion: 'OP-APRETA', estado: 'confirmado' });
const vG = db.vincularPago(GRUPO, pagoG, 3, 'brena', 45, { partidoId: pApreta });
check('el grupo de 3 se registra completo (nadie se pierde)', vG?.inscripciones.length === 3);
check('pero la cancha NO se sobrevende: sigue en su cupo de 3', ocupados(pApreta) === 3);
check('el tercero del grupo queda en la espera', enEspera(pApreta) === 1);
check('y su plata igual está contada: el Yape entró entero a la caja', db.cajaPartido(pApreta).cobradoVerificado === 45);
check('el que quedó en espera es un acompañante, no el que pagó', (() => {
  const esp = db.inscripcionesDe(pApreta).find((i) => i.estado === 'espera');
  return esp && esp.numero === null;
})());
check('si se cae uno de los que estaban, sube el acompañante que esperaba', (() => {
  const activa = db.inscripcionActiva(pApreta, YA);
  db.darDeBaja(activa.id);
  return enEspera(pApreta) === 0 && ocupados(pApreta) === 3;
})());

console.log('== Un acompañante no es un contacto ==');
// Los cupos de invitado no tienen número: no se les escribe, no cuentan como
// conversación nueva, y no se les cobra por separado.
const invs = db.inscripcionesDe(pDos).filter((i) => i.numero === null);
check('los acompañantes no crean fichas de jugador', invs.every((i) => i.numero === null));
check('se sabe de quién vino cada uno', invs.every((i) => i.nombre === `Invitado de +${DOS}`));
check('un acompañante nunca queda "reservado sin pagar": nace con su Yape', invs.every((i) => i.estado === 'pagado' && i.pago_id));

console.log('== Lo cree el bot o lo cree Clarck, el acompañante se llama igual ==');
// El nombre "Invitado de +51999…" no es una etiqueta: es la ÚNICA junta entre
// "pagó un cupo de invitado" y "ponerle nombre después" — se busca con un `=`
// exacto. Lo arman TRES caminos distintos (el bot al leer un Yape, el bot al
// enganchar un pago suelto, y el panel cuando Clarck asigna un pago a mano).
// Si uno solo deriva, esos cupos se vuelven invisibles y el bot vuelve a decir
// "ya lo registré" sin registrar nada. Por eso hay un solo lugar donde se
// escribe, y esto lo verifica.
const PANEL = '51900006001';
db.getOrCreateLead(PANEL);
const pPanel = db.crearPartido({ zona: 'brena', fecha: enDias(8), hora: '8-9pm', cupo: 16, precio: 15 });
const pagoPanel = db.registrarPago({ numero: PANEL, monto: 30, numero_operacion: 'OP-PANEL', estado: 'confirmado' });
// Lo mismo que hace el panel cuando Clarck asigna un pago suelto a un partido.
db.inscribir(pPanel, PANEL, { estado: 'pagado', pagoId: pagoPanel });
db.inscribir(pPanel, null, { nombre: db.nombreInvitado(PANEL), estado: 'pagado', pagoId: pagoPanel });
check('un invitado que anotó Clarck desde el panel, el bot lo ve pendiente de nombre', db.invitadosSinNombre(PANEL).length === 1);
check('y cuando el jugador manda el nombre por WhatsApp, se escribe', db.nombrarInvitados(PANEL, ['Cruce Panel'])[0]?.nombre === 'Cruce Panel');
check('queda en la misma lista que ve el panel', db.inscripcionesDe(pPanel).some((i) => i.nombre === 'Cruce Panel'));
check('nadie arma el nombre del invitado a mano: hay un solo lugar', (() => {
  const armados = ['index.js', 'src/db.js', 'src/panel.js', 'src/pagos.js', 'src/listas.js']
    .flatMap((f) => fs.readFileSync(path.join(__dirname, f), 'utf8').split('\n')
      .map((linea, n) => ({ f, n: n + 1, linea }))
      // Solo código que CONSTRUYE el texto; los comentarios que lo mencionan
      // para explicar el porqué no molestan a nadie.
      .filter(({ linea }) => /['"`]Invitado de \+/.test(linea) && !/^\s*(\/\/|\*)/.test(linea)));
  if (armados.length > 1) console.error(`    ↳ lo arman ${armados.length}: ${armados.map((a) => `${a.f}:${a.n}`).join(', ')} — todos tienen que usar db.nombreInvitado()`);
  return armados.length === 1;
})());

console.log(fallos ? `\n❌ ${ok} OK, ${fallos} FALLOS` : `\n✅ ${ok} checks OK, 0 fallos`);
process.exit(fallos ? 1 : 0);
