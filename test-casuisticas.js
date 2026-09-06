/**
 * Casuísticas de cancha: las situaciones que de verdad pasan en el chat
 * (sin red, BD temporal).
 *
 *   node test-casuisticas.js
 *
 * Nació del caso de Patrick (2026-09-02): pagó S/15, dijo que venía con un
 * amigo, pagó OTROS S/15 por separado y el bot le contestó "ya registré a Juan
 * Carlos Torres, ambos están confirmados". No había ningún Juan Carlos, el
 * amigo nunca ocupó cupo y el segundo Yape no entró a la caja del partido.
 *
 * De ahí en adelante se fue llenando con el resto de lo que puede pasar cuando
 * mil personas escriben a la vez: dobles pagos, invitados, canchas que se
 * llenan entre el "sí" y el Yape, montos que no calzan, gente que paga por dos
 * turnos, partidos que se cancelan con plata adentro.
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
const ocupados = (id) => {
  const p = db.listPartidos().find((x) => x.id === id);
  return db.inscripcionesDe(id).filter((i) => ['reservado', 'pagado'].includes(i.estado)).length;
};

// ───────────────────────────────────────────────────────────────────────────
console.log('== El caso Patrick: dos Yapes separados por un invitado ==');
// Patrick paga su cupo, después dice que viene con un amigo y manda OTRO Yape.
const PAT = '51979377488';
db.getOrCreateLead(PAT);
const pPat = db.crearPartido({ zona: 'brena', fecha: enDias(2), hora: '9-10pm', sede: 'Mariano Melgar', cupo: 16 });

const yape1 = db.registrarPago({ numero: PAT, monto: 15, numero_operacion: 'OP-PAT-1', estado: 'confirmado' });
const v1 = db.vincularPago(PAT, yape1, 1, 'brena', 15);
check('el primer Yape lo deja pagado en la lista', v1?.partido.id === pPat && v1.inscripciones[0].estado === 'pagado');
check('ocupa un cupo', ocupados(pPat) === 1);

const yape2 = db.registrarPago({ numero: PAT, monto: 15, numero_operacion: 'OP-PAT-2', estado: 'confirmado' });
const v2sin = db.vincularPago(PAT, yape2, 1, 'brena', 15);
check('un segundo Yape SIN saber si es por un invitado no se adivina: queda suelto', v2sin === null);
check('y no inventa un jugador que nadie confirmó', ocupados(pPat) === 1);

const v2con = db.vincularPago(PAT, yape2, 1, 'brena', 15, { invitados: true });
check('leyendo la conversación, el segundo Yape SÍ crea el cupo del invitado', v2con?.invitados === true && v2con.inscripciones.length === 1);
check('el cupo del invitado no tiene número propio (no es un contacto)', v2con.inscripciones[0].numero === null);
check('queda marcado como invitado de quien pagó', v2con.inscripciones[0].nombre === `Invitado de +${PAT}`);
check('ahora sí son DOS los que ocupan cancha', ocupados(pPat) === 2);
check('la caja del partido cuenta los DOS Yapes (era el que se perdía)', db.cajaPartido(pPat).cobrado === 30);

// El mismo comprobante reenviado no puede volver a cobrar cupo.
const v2otra = db.vincularPago(PAT, yape2, 1, 'brena', 15, { invitados: true });
check('reenviar el MISMO pago no agrega un invitado más', ocupados(pPat) === 2 || v2otra === null);

console.log('== Ponerle nombre al invitado ==');
check('antes de que mande el nombre, hay 1 invitado sin nombrar', db.invitadosSinNombre(PAT).length === 1);
const nombrados = db.nombrarInvitados(PAT, ['Juan Carlos Torres']);
check('cuando manda el nombre, se escribe en el cupo que ya pagó', nombrados.length === 1 && nombrados[0].nombre === 'Juan Carlos Torres');
check('y aparece en la lista del partido', db.inscripcionesDe(pPat).some((i) => i.nombre === 'Juan Carlos Torres'));
check('ya no queda ningún invitado sin nombre', db.invitadosSinNombre(PAT).length === 0);
check('mandar otro nombre sin haber pagado otro cupo NO anota a nadie', db.nombrarInvitados(PAT, ['Pedro Fantasma']).length === 0);
check('y ese nombre no se filtró a la lista', !db.inscripcionesDe(pPat).some((i) => i.nombre === 'Pedro Fantasma'));
check('un nombre vacío o de una letra se ignora', db.nombrarInvitados(PAT, ['', 'x']).length === 0);
check('nombrar no le pisa el nombre al invitado que ya lo tenía', db.inscripcionesDe(pPat).filter((i) => i.nombre === 'Juan Carlos Torres').length === 1);

console.log('== Un solo Yape que cubre a varios (lo que ya funcionaba) ==');
const DUO = '51900000101';
db.getOrCreateLead(DUO);
const yapeDuo = db.registrarPago({ numero: DUO, monto: 30, numero_operacion: 'OP-DUO', estado: 'confirmado' });
const vDuo = db.vincularPago(DUO, yapeDuo, 2, 'brena', 30);
check('S/30 en un solo Yape entra como jugador + invitado', vDuo?.inscripciones.length === 2);
check('el titular queda con su número y el invitado sin número', vDuo.inscripciones[0].numero === DUO && vDuo.inscripciones[1].numero === null);
check('los dos cupos apuntan al MISMO pago', vDuo.inscripciones.every((i) => i.pago_id === yapeDuo));
check('la caja no cuenta ese Yape dos veces', db.cajaPartido(pPat).cobrado === 60);
check('cuposPorMonto: S/30 a S/15 son 2 cupos', db.cuposPorMonto(30, 15) === 2);
check('cuposPorMonto: S/32 a S/15 no calza con nada', db.cuposPorMonto(32, 15) === null);
check('cuposPorMonto: sin precio no inventa cupos', db.cuposPorMonto(30, null) === null);

console.log('== La cancha llena no se sobrevende ==');
const pChico = db.crearPartido({ zona: 'comas', fecha: enDias(2), hora: '8-9pm', cupo: 1 });
const A = '51900000201', B = '51900000202';
db.getOrCreateLead(A); db.getOrCreateLead(B);
const pagoA = db.registrarPago({ numero: A, monto: 10, numero_operacion: 'OP-A', estado: 'confirmado' });
db.vincularPago(A, pagoA, 1, 'comas', 10);
check('el primero entra', ocupados(pChico) === 1);
const pagoB = db.registrarPago({ numero: B, monto: 10, numero_operacion: 'OP-B', estado: 'confirmado' });
const vB = db.vincularPago(B, pagoB, 1, 'comas', 10);
check('el segundo paga con la cancha llena y cae a espera, no adentro', vB?.inscripciones[0].estado === 'espera');
check('pagar NO sobrevende: siguen siendo 1 en cancha', ocupados(pChico) === 1);
const pagoA2 = db.registrarPago({ numero: A, monto: 10, numero_operacion: 'OP-A2', estado: 'confirmado' });
const vA2 = db.vincularPago(A, pagoA2, 1, 'comas', 10, { invitados: true });
check('un invitado pagado con la cancha llena tampoco entra a la fuerza', ocupados(pChico) === 1);
check('pero su pago queda registrado en la espera, no se pierde', vA2?.inscripciones[0].estado === 'espera');

console.log('== Reservar, vencer y ceder el lugar ==');
const pRes = db.crearPartido({ zona: 'brena', fecha: enDias(3), hora: '8-9pm', cupo: 2 });
const C = '51900000301', D = '51900000302', E = '51900000303';
[C, D, E].forEach((n) => db.getOrCreateLead(n));
const rC = db.inscribir(pRes, C);
check('quien pide cupo queda RESERVADO, no pagado', rC.resultado === 'reservado');
check('una reserva sin plata tiene fecha de vencimiento', !!rC.inscripcion.reserva_vence_en === (db.reservaMinutos() > 0));
db.inscribir(pRes, D);
const rE = db.inscribir(pRes, E);
check('con el cupo lleno, el tercero va a la espera', rE.resultado === 'espera');
check('anotarse dos veces no duplica el cupo', db.inscribir(pRes, C).resultado === 'ya_inscrito');
const promovido = db.darDeBaja(rC.inscripcion.id);
check('al bajarse uno, sube el primero de la espera', promovido?.numero === E);
check('dar de baja a alguien de la espera no promueve a nadie', db.darDeBaja(db.inscribir(pRes, '51900000304').inscripcion.id) === null);

console.log('== El precio manda (y sin precio no se cotiza) ==');
check('precioDeZona de una zona cargada devuelve número', typeof db.precioDeZona('brena') === 'number');
check('precioDeZona de una zona que no existe devuelve null, NUNCA 0', db.precioDeZona('narnia') === null);
const pCustom = db.crearPartido({ zona: 'comas', fecha: enDias(4), hora: '9-10pm', cupo: 10, precio: 25 });
check('el precio propio del partido le gana al de la zona', db.precioDePartido(db.getPartido(pCustom)) === 25);
check('un pago de S/50 en ese partido son 2 cupos, no 5', db.cuposPorMonto(50, db.precioDePartido(db.getPartido(pCustom))) === 2);

console.log('== Dónde vive no es dónde juega ==');
const VIAJERO = '51900000401';
db.updateLead(db.getOrCreateLead(VIAJERO).numero, { distrito: 'Surquillo', zona: 'otra' });
const calzan = db.partidosQueCalzan(15, 'otra');
check('alguien de otra zona igual puede calzar en un partido de S/15', calzan.some((c) => c.partido.zona === 'brena'));
check('partidosQueCalzan no devuelve partidos cuyo precio no da cupos exactos', calzan.every((c) => c.cupos > 0));

console.log('== Partidos que ya no admiten gente ==');
const pCancel = db.crearPartido({ zona: 'comas', fecha: enDias(2), hora: '9-10pm', cupo: 10 });
db.cancelarPartido(pCancel);
check('un partido cancelado no acepta inscripciones', db.inscribir(pCancel, '51900000501').motivo === 'cancelado');
const pagoZ = db.registrarPago({ numero: '51900000501', monto: 16, numero_operacion: 'OP-Z', estado: 'confirmado' });
db.vincularPago('51900000501', pagoZ, 1, 'comas', 16);
check('y un Yape suyo NUNCA mete a nadie en el partido cancelado', db.inscripcionesDe(pCancel).length === 0);
const pCerrado = db.crearPartido({ zona: 'brena', fecha: enDias(2), hora: '7-8pm', cupo: 10 });
db.cerrarInscripcion(pCerrado);
check('un partido con la inscripción cerrada a mano tampoco recibe gente', db.inscribir(pCerrado, '51900000502').motivo === 'cerrado');

console.log('== La caja no miente ==');
const pCaja = db.crearPartido({ zona: 'brena', fecha: enDias(5), hora: '8-9pm', cupo: 10, precio: 15 });
const F = '51900000601', G = '51900000602';
[F, G].forEach((n) => db.getOrCreateLead(n));
const pagoF = db.registrarPago({ numero: F, monto: 15, numero_operacion: 'OP-F', estado: 'confirmado' });
db.vincularPago(F, pagoF, 1, 'brena', 15, { partidoId: pCaja });
db.inscribir(pCaja, G); // reservado, sin pagar
const caja = db.cajaPartido(pCaja);
check('lo cobrado sale de un Yape verificado', caja.cobradoVerificado === 15);
check('lo que falta cobrar cuenta al que reservó y no pagó', caja.porCobrar === 15);
check('marcar pagado a mano no desaparece de la caja', (() => {
  const activa = db.inscripcionActiva(pCaja, G);
  db.setEstadoInscripcion(activa.id, 'pagado');
  const c = db.cajaPartido(pCaja);
  return c.cobradoAMano === 15 && c.cobrado === 30;
})());
check('un pago "por revisar" NO entra a la caja hasta confirmarse', (() => {
  const antes = db.cajaPartido(pCaja).cobrado;
  db.registrarPago({ numero: '51900000603', monto: 15, numero_operacion: 'OP-DUDA', estado: 'revisar' });
  return db.cajaPartido(pCaja).cobrado === antes;
})());

console.log('== Un segundo pago no puede borrar al primero ==');
const pDoble = db.crearPartido({ zona: 'brena', fecha: enDias(7), hora: '9-10pm', cupo: 10, precio: 15 });
const I = '51900000801';
db.getOrCreateLead(I);
const pagoI1 = db.registrarPago({ numero: I, monto: 15, numero_operacion: 'OP-I1', estado: 'confirmado' });
db.vincularPago(I, pagoI1, 1, 'brena', 15, { partidoId: pDoble });
const inscI = db.inscripcionActiva(pDoble, I);
check('queda pagado con su primer Yape', inscI.pago_id === pagoI1);
const pagoI2 = db.registrarPago({ numero: I, monto: 15, numero_operacion: 'OP-I2', estado: 'confirmado' });
const rDoble = db.pagarInscripcion(inscI.id, pagoI2);
check('asignarle un segundo Yape NO pisa el primero', rDoble.motivo === 'ya_tenia_pago');
check('y dice cuál era el pago que ya tenía', rDoble.pagoPrevio === pagoI1);
check('la inscripción sigue apuntando al primer Yape', db.inscripcionActiva(pDoble, I).pago_id === pagoI1);
check('así el primer Yape NO se cae de la caja del partido', db.cajaPartido(pDoble).cobradoVerificado === 15);
check('marcar pagado con el MISMO pago sigue funcionando (no es un pago nuevo)', db.pagarInscripcion(inscI.id, pagoI1).ok === true);

console.log('== El pago que llega antes que la inscripción ==');
const H = '51900000701';
db.getOrCreateLead(H);
const pagoH = db.registrarPago({ numero: H, monto: 99, numero_operacion: 'OP-H', estado: 'confirmado' });
check('un monto que no calza con ningún partido queda suelto', db.vincularPago(H, pagoH, 1, 'brena', 99) === null);
check('y pagoSueltoDe lo encuentra para engancharlo después', db.pagoSueltoDe(H)?.id === pagoH);
const pH = db.crearPartido({ zona: 'brena', fecha: enDias(6), hora: '8-9pm', cupo: 10 });
const rH = db.inscribir(pH, H);
db.pagarInscripcion(rH.inscripcion.id, pagoH);
check('cuando por fin se inscribe, el Yape viejo le cubre el cupo', db.inscripcionActiva(pH, H).estado === 'pagado');
check('y deja de figurar como pago suelto', db.pagoSueltoDe(H) === null);

console.log('== Identidades sin teléfono (BSUID) ==');
const BS = 'PE.1639270134234203';
db.getOrCreateLead(BS);
const pagoBS = db.registrarPago({ numero: BS, monto: 30, numero_operacion: 'OP-BS', estado: 'confirmado' });
const vBS = db.vincularPago(BS, pagoBS, 2, 'brena', 30, { partidoId: pH });
check('un jugador sin número de teléfono también puede pagar por dos', vBS?.inscripciones.length === 2);
check('su invitado queda marcado con el identificador completo, con letras', vBS.inscripciones[1].nombre === `Invitado de +${BS}`);
check('el identificador se guarda tal cual, sin recortar las letras', db.getLead(BS).numero === BS);

console.log('== La fase se calcula, no se guarda ==');
const pFase = db.crearPartido({ zona: 'comas', fecha: enDias(3), hora: '8-9pm', cupo: 10 });
check('un partido futuro admite inscripción', db.admiteInscripcion(db.getPartido(pFase)));
check('y todavía no pasó', !db.yaPaso(db.getPartido(pFase)));
db.liquidarPartido(pFase);
check('liquidado deja de admitir gente', !db.admiteInscripcion(db.getPartido(pFase)));
check('liquidar es una afirmación de una persona, y queda registrada', !!db.getPartido(pFase).liquidado_en);

console.log(fallos ? `\n❌ ${ok} OK, ${fallos} FALLOS` : `\n✅ ${ok} checks OK, 0 fallos`);
process.exit(fallos ? 1 : 0);
