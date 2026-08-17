/**
 * La fase del partido y los turnos fijos (2026-08-17) — `node test-turnos.js`.
 *
 * Lo que se fija acá:
 *   1. La FASE se calcula (no se guarda): el mismo partido cambia de fase solo
 *      con que pase la hora, sin que nadie apriete nada.
 *   2. La GRACIA de 24 h: después del pitazo final el partido sigue aceptando
 *      el Yape tardío y la lista a mano. Es el requisito que antes se cumplía
 *      "no cerrando nunca" — y por eso quedaron 16 partidos jugados figurando
 *      como abiertos.
 *   3. La HORA con minutos: un turno de 8:30-9:30pm ya no se deja de ofrecer a
 *      las 8:00 en punto (se comparaba por horas enteras).
 *   4. Los TURNOS: generación idempotente, tope de horizonte, excepciones.
 *   5. El ANTI-DUPLICADO: nunca dos listas para el mismo partido, y ninguna
 *      fusión automática cuando las dos tienen gente adentro.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pich-turnos-'));
process.env.WWEBJS_AUTH_PATH = TMP;
const db = require('./src/db');

let ok = 0, fallos = 0;
const check = (nombre, cond, extra = '') => {
  if (cond) { ok++; console.log(`  ✓ ${nombre}`); }
  else { fallos++; console.error(`  ✗ ${nombre} ${extra}`); }
};
const enDias = (n) => db.fechaLima(n);
/** Un instante concreto, para no depender de a qué hora se corren los tests. */
const alas = (fecha, hhmm) => ({ fecha, min: Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5)) });

// ==============================================================================
console.log('== 1 · La hora es un número, con sus minutos ==');
// ==============================================================================
check('8:30pm son 1230 minutos', db.parseHora('8:30-9:30pm').inicio === 1230);
check('y dura 60', db.parseHora('8:30-9:30pm').duracion === 60);
check('"20:00-22:00" dura dos horas', db.parseHora('20:00-22:00').duracion === 120);
check('un texto que no es hora no inventa nada', db.parseHora('a la noche') === null || db.parseHora('a la noche').inicio >= 0);
check('sin hora, null', db.parseHora('') === null && db.parseHora(null) === null);
check('1230 vuelve a ser "8:30-9:30pm"', db.textoHora(1230, 60) === '8:30-9:30pm');
check('el turno que cruza medianoche se escribe bien', db.textoHora(1380, 60) === '11pm-12am', db.textoHora(1380, 60));

{
  // EL BUG: el filtro de vigentes comparaba HORAS ENTERAS, así que a las 20:00
  // en punto un turno de 20:30 ya contaba como empezado y el bot dejaba de
  // ofrecerlo con media hora todavía por delante.
  const hoy = enDias(0);
  const p = db.crearPartido({ zona: 'brena', fecha: hoy, hora: '20:30', sede: 'Melgar', cupo: 14, precio: 15 });
  const partido = db.getPartido(p);
  check('el partido guarda 1230 en inicio_min', partido.inicio_min === 1230, String(partido.inicio_min));
  check('y "8:30-9:30pm" como texto para el jugador', partido.hora === '8:30-9:30pm', partido.hora);
  check('a las 20:00 TODAVÍA se ofrece (media hora antes de empezar)', db.ofrecible(partido, alas(hoy, '20:00')));
  check('a las 20:29 sigue ofreciéndose', db.ofrecible(partido, alas(hoy, '20:29')));
  check('a las 20:31 ya empezó: no se ofrece', !db.ofrecible(partido, alas(hoy, '20:31')));
  check('…pero todavía admite un pago', db.admiteInscripcion(partido, alas(hoy, '20:31')));
}

// ==============================================================================
console.log('== 2 · La fase se calcula: nadie la guarda ==');
// ==============================================================================
{
  const hoy = enDias(0);
  const id = db.crearPartido({ zona: 'brena', fecha: hoy, hora: '18:00', sede: 'Fase FC', cupo: 10, precio: 15 });
  const p = db.getPartido(id);
  check('antes de empezar: próximo', db.fasePartido(p, alas(hoy, '17:00')) === 'proximo');
  check('durante: en curso', db.fasePartido(p, alas(hoy, '18:30')) === 'en_curso');
  check('recién terminado: en gracia (todavía entra un Yape)', db.fasePartido(p, alas(hoy, '19:30')) === 'gracia');
  check('al día siguiente a la misma hora: sigue en gracia', db.fasePartido(p, alas(enDias(1), '18:30')) === 'gracia');
  check('pasadas las 24 h: por liquidar', db.fasePartido(p, alas(enDias(1), '19:30')) === 'por_liquidar');
  check('y ya no admite a nadie', !db.admiteInscripcion(p, alas(enDias(1), '19:30')));
  check('el motivo es "muy_viejo", no un estado inventado', db.motivoCierre(p, alas(enDias(1), '19:30')) === 'muy_viejo');
  check('yaPaso() es independiente de las decisiones humanas', db.yaPaso(p, alas(hoy, '19:30')) && !db.yaPaso(p, alas(hoy, '17:00')));

  // Las TRES decisiones humanas, y solo esas, se guardan.
  db.cerrarInscripcion(id);
  check('cerrar a mano corta la inscripción al toque', db.motivoCierre(db.getPartido(id), alas(hoy, '17:00')) === 'cerrado');
  check('…y se escribe en paralelo el estado viejo (rollback del deploy)', db.getPartido(id).estado === 'cerrado');
  db.reabrirPartido(id);
  check('reabrir la devuelve', db.admiteInscripcion(db.getPartido(id), alas(hoy, '17:00')));
  db.cancelarPartido(id);
  check('cancelado gana sobre todo', db.fasePartido(db.getPartido(id), alas(hoy, '17:00')) === 'cancelado');
  check('…con su fecha, no un enum', Boolean(db.getPartido(id).cancelado_en));
  db.reabrirPartido(id);
  const liq = db.liquidarPartido(id);
  check('liquidar deja la fecha y el estado viejo "jugado"', liq.ok && db.getPartido(id).liquidado_en && db.getPartido(id).estado === 'jugado');
  check('un liquidado no acepta nada más', db.inscribir(id, '51900000777').motivo === 'liquidado');
  check('liquidar dos veces no rompe', db.liquidarPartido(id).ok === false);
}

// ==============================================================================
console.log('== 3 · La gracia de 24 h: el Yape tardío tiene dónde caer ==');
// ==============================================================================
{
  // El partido de anoche: terminó hace horas pero el Yape entra igual. Ese es
  // el motivo por el que antes NO se podía cerrar ningún partido.
  const anoche = db.crearPartido({ zona: 'brena', fecha: enDias(-1), hora: '23:30', sede: 'Melgar', cupo: 14, precio: 15 });
  db.getOrCreateLead('51900000701');
  const r = db.inscribir(anoche, '51900000701', { nombre: 'Yape Tardío' });
  check('el partido de anoche todavía deja anotar y cobrar', r.resultado === 'reservado', JSON.stringify(r));

  // Y el de la semana pasada NO: eso ya es historia, no una tarea de hoy.
  const semanaPasada = db.crearPartido({ zona: 'brena', fecha: enDias(-7), hora: '20:00', sede: 'Melgar', cupo: 14, precio: 15 });
  check('el de la semana pasada ya no', db.inscribir(semanaPasada, '51900000702').motivo === 'muy_viejo');
  db.reabrirPartido(semanaPasada);
  check('…salvo que Clarck lo reabra a mano', db.inscribir(semanaPasada, '51900000702').resultado === 'reservado');

  // El plazo lo pone él, no el código.
  db.setConfig({ gracia_horas: '2' });
  check('la gracia se configura', db.graciaHoras() === 2);
  const p = db.getPartido(anoche);
  check('con 2 h de gracia, el de anoche ya venció', db.motivoCierre(p) === 'muy_viejo');
  db.setConfig({ gracia_horas: '' });
  check('vacío vuelve al default de 24 h', db.graciaHoras() === 24);
}

// ==============================================================================
console.log('== 4 · inscribir() dice POR QUÉ, no solo que no ==');
// ==============================================================================
{
  const id = db.crearPartido({ zona: 'brena', fecha: enDias(3), hora: '19:00', sede: 'Motivos FC', cupo: 1, precio: 15 });
  db.getOrCreateLead('51900000710'); db.getOrCreateLead('51900000711');
  db.inscribir(id, '51900000710');
  const lleno = db.inscribir(id, '51900000711');
  check('con la cancha llena entra a espera Y dice que está llena', lleno.resultado === 'espera' && lleno.motivo === 'lleno');
  db.cancelarPartido(id);
  check('cancelado → motivo "cancelado"', db.inscribir(id, '51900000712').motivo === 'cancelado');
  check('un partido que no existe → "no_existe"', db.inscribir(999999, '51900000712').motivo === 'no_existe');
}

// ==============================================================================
console.log('== 5 · Colas de cierre: liquidar lo que movió plata, archivar lo vacío ==');
// ==============================================================================
{
  const antes = db.partidosPorLiquidar().length;
  // Uno viejo CON gente (se abre a futuro y se le mueve la fecha: no se puede
  // anotar a nadie en un partido que ya venció, que es justo la regla nueva).
  const conPlata = db.crearPartido({ zona: 'comas', fecha: enDias(20), hora: '21:00', sede: 'Cola FC', cupo: 10, precio: 10 });
  db.getOrCreateLead('51900000720');
  db.inscribir(conPlata, '51900000720', { nombre: 'Deudor' });
  db.actualizarPartido(conPlata, { fecha: enDias(-4) });
  // Y uno viejo VACÍO.
  const vacio = db.crearPartido({ zona: 'comas', fecha: enDias(-5), hora: '21:00', sede: 'Cola FC', cupo: 10, precio: 10 });

  const cola = db.partidosPorLiquidar();
  check('el que movió plata entra a la cola de liquidación', cola.some((p) => p.id === conPlata));
  check('…con su caja calculada', (cola.find((p) => p.id === conPlata).caja || {}).porCobrar === 10);
  check('el vacío NO entra a esa cola', !cola.some((p) => p.id === vacio));
  check('el vacío entra a la de archivo', db.partidosVacios().some((p) => p.id === vacio));

  // Un partido ANTERIOR al punto de arranque tiene que poder archivarse aunque
  // tenga gente: la cola de liquidación respeta el corte, así que si no entrara
  // acá quedaría fuera de las DOS listas. Pasó al migrar la BD real: 6 partidos
  // del 12 al 15 de agosto, uno con 10 inscritos y 9 pagados, invisibles.
  {
    const viejo = db.crearPartido({ zona: 'brena', fecha: db.fechaLima(20), hora: '8-9pm', cupo: 10, precio: 15 });
    db.getOrCreateLead('51900009001');
    db.inscribir(viejo, '51900009001', { nombre: 'Con plata vieja' });
    db.actualizarPartido(viejo, { fecha: db.fechaLima(-9) });
    db.setCorte(db.fechaLima(-2));
    check('no entra en la cola de liquidación (es anterior al corte)',
      !db.partidosPorLiquidar().some((p) => p.id === viejo));
    check('pero SÍ es archivable, aunque tenga gente',
      db.partidosArchivables().some((p) => p.id === viejo));
    check('y no queda ninguno atascado fuera de las dos listas',
      !db.listPartidos().some((p) => db.fasePartido(p) === 'por_liquidar'
        && !db.partidosArchivables().some((x) => x.id === p.id)
        && !db.partidosPorLiquidar().some((x) => x.id === p.id)));
    db.setCorte('2000-01-01');
  }

  const n = db.archivarPartidosVacios();
  check(`se archivan en lote (${n})`, n >= 1 && !db.partidosVacios().some((p) => p.id === vacio));
  check('archivar = liquidar sin plata, con su fecha', Boolean(db.getPartido(vacio).liquidado_en));
  check('el que tiene plata sigue esperando a que Clarck cuente', db.partidosPorLiquidar().some((p) => p.id === conPlata));
  check('nada se autoliquidó de paso', db.partidosPorLiquidar().length >= antes + 1);

  const r = db.liquidarPartido(conPlata);
  check('liquidado a mano, sale de la cola', r.ok && !db.partidosPorLiquidar().some((p) => p.id === conPlata));
}

// ==============================================================================
console.log('== 6 · Turnos: la plantilla semanal ==');
// ==============================================================================
{
  const hoy = enDias(0);
  const diaHoy = db.diaSemanaDe(hoy);
  const t = db.crearTurno({ zona: 'comas', dia_semana: diaHoy, hora: '18:00', cupo: 12, precio: 10 });
  check('el turno se crea', Number.isInteger(t) && t > 0);
  check('y NACE APAGADO (ninguna plantilla se enciende sola)', db.getTurno(t).activo === 0);
  check('sin día de semana válido no se crea', db.crearTurno({ zona: 'comas', dia_semana: 9, hora: '18:00' }) === null);
  check('en una zona que no existe tampoco', db.crearTurno({ zona: 'narnia', dia_semana: 1, hora: '18:00' }) === null);

  check('apagado no genera nada', db.generarPartidosDeTurnos().creados === 0);
  db.setTurnoActivo(t, 1);
  const g1 = db.generarPartidosDeTurnos();
  check(`encendido materializa las fechas de 14 días (${g1.creados})`, g1.creados >= 2, JSON.stringify(g1.detalle));
  const g2 = db.generarPartidosDeTurnos();
  check('correrlo dos veces NO crea nada de más (idempotente)', g2.creados === 0);
  const generados = db.listPartidos().filter((p) => p.turno_id === t);
  check('los partidos quedan enganchados a su turno', generados.length === g1.creados);
  check('copian el cupo y el precio del turno (snapshot)', generados.every((p) => p.cupo === 12 && Number(p.precio) === 10));
  check('todos caen en el día de la semana del turno', generados.every((p) => db.diaSemanaDe(p.fecha) === diaHoy));

  // El precio no puede moverse debajo de alguien que ya se anotó.
  db.actualizarTurno(t, { precio: '99' });
  db.generarPartidosDeTurnos();
  check('subir el precio del turno NO toca los partidos ya cargados',
    db.listPartidos().filter((p) => p.turno_id === t).every((p) => Number(p.precio) === 10));
  db.actualizarTurno(t, { precio: '10' });

  // Tope duro: un turno mal configurado no puede llenar el calendario.
  const g3 = db.generarPartidosDeTurnos({ dias: 365 });
  const masLejano = db.listPartidos().filter((p) => p.turno_id === t).map((p) => p.fecha).sort().pop();
  check('el horizonte tiene tope duro de 21 días', masLejano <= db.sumarDias(hoy, 21), `${masLejano} (creó ${g3.creados})`);

  // Excepción: esta semana no se juega.
  const proxima = db.sumarDias(hoy, 7);
  const instancia = db.listPartidos().find((p) => p.turno_id === t && p.fecha === proxima);
  check('la fecha de la semana que viene está cargada', Boolean(instancia));
  db.cancelarPartido(instancia.id);
  db.agregarExcepcion(t, proxima, 'viaje');
  const g4 = db.generarPartidosDeTurnos();
  check('cancelada una semana, el generador NO la resucita', g4.creados === 0);
  check('…la instancia queda cancelada', Boolean(db.getPartido(instancia.id).cancelado_en));
  check('…y el turno sigue vivo para las demás semanas', db.getTurno(t).activo === 1);
  check('la excepción queda anotada con su fecha', db.excepcionesDe(t).some((e) => e.fecha === proxima));
  db.quitarExcepcion(t, proxima);
  check('quitada la excepción, esa fecha vuelve a estar disponible', !db.excepcionesDe(t).some((e) => e.fecha === proxima));

  // Vigencia.
  db.actualizarTurno(t, { vigente_hasta: enDias(1) });
  const antesVig = db.listPartidos().filter((p) => p.turno_id === t).length;
  db.generarPartidosDeTurnos();
  check('fuera de vigencia no genera nada nuevo', db.listPartidos().filter((p) => p.turno_id === t).length === antesVig);
  db.actualizarTurno(t, { vigente_hasta: '' });

  db.setTurnoActivo(t, 0);
  check('pausado deja de generar', db.generarPartidosDeTurnos().creados === 0);
}

// ==============================================================================
console.log('== 7 · Siembra por inferencia y días huérfanos ==');
// ==============================================================================
{
  // Tres martes seguidos en la misma cancha y hora = una costumbre, aunque
  // nunca se haya escrito como turno.
  const martes = [];
  for (let i = 1; i <= 40 && martes.length < 3; i++) {
    const f = enDias(-i);
    if (db.diaSemanaDe(f) === 2) martes.push(f);
  }
  db.addSede({ zona: 'comas', nombre: 'Cancha Costumbre', cupo: 12, costo: 100 });
  for (const f of martes) {
    const id = db.crearPartido({ zona: 'comas', fecha: enDias(25), hora: '19:00', sede: 'Cancha Costumbre', cupo: 12, precio: 10 });
    db.actualizarPartido(id, { fecha: f });
  }
  const sug = db.turnosSugeridos();
  check('la costumbre se propone como turno', sug.some((s) => s.zona === 'comas' && s.inicio_min === 1140 && s.dia_semana === 2), JSON.stringify(sug.map((s) => `${s.dia_nombre} ${s.hora} x${s.veces}`)));
  const cuantos = db.sembrarTurnosPorInferencia();
  check(`se siembran ${cuantos} plantillas`, cuantos >= 1);
  check('TODAS apagadas: el que se compromete a pagar la cancha es Clarck',
    db.listTurnos().filter((x) => x.nota && /Inferido/.test(x.nota)).every((x) => x.activo === 0));
  check('sembrar dos veces no duplica', db.sembrarTurnosPorInferencia() === 0);

  // Y el aviso del hueco: el martes que viene no hay nada cargado.
  const huecos = db.diasSinCargar();
  check('el próximo martes aparece como día sin cargar',
    huecos.some((h) => db.diaSemanaDe(h.fecha) === 2 && h.zona === 'comas' && h.hora === '7-8pm'), JSON.stringify(huecos.slice(0, 3)));
  const hueco = huecos.find((h) => db.diaSemanaDe(h.fecha) === 2 && h.zona === 'comas');
  check('…diciendo cuántas veces se jugó a esa hora', hueco.veces >= 3);
  db.crearPartido({ zona: 'comas', fecha: hueco.fecha, hora: '19:00', sede: 'Cancha Costumbre', cupo: 12, precio: 10 });
  check('cargado el partido, el hueco desaparece',
    !db.diasSinCargar().some((h) => h.fecha === hueco.fecha && h.zona === 'comas' && h.hora === '7-8pm'));
}

// ==============================================================================
console.log('== 8 · Anti-duplicado: nunca dos listas para el mismo partido ==');
// ==============================================================================
{
  const f = enDias(9);
  const a = db.abrirPartido({ zona: 'brena', fecha: f, hora: '20:00', sede: 'Estadio Mariano Melgar', cupo: 14, precio: 15 });
  const b = db.abrirPartido({ zona: 'brena', fecha: f, hora: '20:00', sede: 'Estadio Mariano Melgar', cupo: 14, precio: 15 });
  check('el primero se crea', a.creado === true);
  check('el segundo NO: devuelve el que ya existe', b.creado === false && b.id === a.id);
  check('…y lo dice con un motivo, no en silencio', b.motivo === 'ya_existe');
  check('crearPartido sigue devolviendo un entero (firma intacta)', Number.isInteger(db.crearPartido({ zona: 'brena', fecha: f, hora: '20:00', sede: 'Estadio Mariano Melgar' })));
  const otraHora = db.abrirPartido({ zona: 'brena', fecha: f, hora: '21:00', sede: 'Estadio Mariano Melgar', cupo: 14 });
  check('otra hora sí es otro partido', otraHora.creado === true);
  const otraCancha = db.abrirPartido({ zona: 'comas', fecha: f, hora: '20:00', sede: 'Cancha Costumbre', cupo: 14 });
  check('otra cancha también', otraCancha.creado === true);

  // Editar tampoco puede pisar a otro.
  const choque = db.actualizarPartido(otraHora.id, { hora: '20:00' });
  check('mover la hora encima de otro partido se RECHAZA', choque.ok === false, JSON.stringify(choque));
  check('…y explica cuál es el que ya está', /Ya hay otro partido/.test(choque.motivo || ''), choque.motivo);

  const idx = new DatabaseSync(db.dbPath).prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_partidos_unico'").get();
  check('el índice único existe en la BD', Boolean(idx));
}

// ==============================================================================
console.log('== 9 · La migración anti-duplicado NO fusiona listas con gente ==');
// ==============================================================================
{
  // Las migraciones corren al CARGAR db.js, así que esto va en un proceso
  // aparte: se prepara una BD con duplicados adentro y se arranca db.js encima,
  // que es exactamente lo que va a pasar en el deploy sobre la base real.
  const TMP2 = fs.mkdtempSync(path.join(os.tmpdir(), 'pich-dup-'));
  const arrancar = () => execFileSync(process.execPath, ['-e', "require('./src/db');"], {
    env: { ...process.env, WWEBJS_AUTH_PATH: TMP2 }, encoding: 'utf8', cwd: __dirname,
  });
  arrancar();

  const ruta = path.join(TMP2, 'data', 'pichangueros.db');
  const c = new DatabaseSync(ruta);
  c.exec('DROP INDEX IF EXISTS idx_partidos_unico');
  const nuevo = (fecha, hora, inicio) => {
    c.prepare("INSERT INTO partidos (zona, fecha, hora, inicio_min, duracion_min, sede, cupo, precio) VALUES ('brena', ?, ?, ?, 60, NULL, 14, 15)").run(fecha, hora, inicio);
    return Number(c.prepare('SELECT MAX(id) AS id FROM partidos').get().id);
  };
  const anotar = (pid, numero) => c.prepare("INSERT INTO inscripciones (partido_id, numero, estado) VALUES (?, ?, 'reservado')").run(pid, numero);

  // Par 1: uno con gente y otro vacío → se puede limpiar sin decidir nada.
  const conGente = nuevo('2026-09-01', '8-9pm', 1200);
  const gemeloVacio = nuevo('2026-09-01', '8-9pm', 1200);
  anotar(conGente, '51900000801');
  // Par 2: LOS DOS con gente → nadie los junta solo.
  const dosA = nuevo('2026-09-02', '8-9pm', 1200);
  const dosB = nuevo('2026-09-02', '8-9pm', 1200);
  anotar(dosA, '51900000802');
  anotar(dosB, '51900000803');
  c.close();

  arrancar();
  const c2 = new DatabaseSync(ruta);
  const existe = (id) => Boolean(c2.prepare('SELECT 1 FROM partidos WHERE id = ?').get(id));
  check('el duplicado VACÍO se borra', !existe(gemeloVacio));
  check('…y el que tenía gente se queda', existe(conGente));
  check('con gente en los DOS no se toca ninguno', existe(dosA) && existe(dosB));
  check('…y no se fusionó ninguna inscripción',
    c2.prepare('SELECT COUNT(*) AS n FROM inscripciones WHERE partido_id IN (?, ?)').get(dosA, dosB).n === 2);
  const marca = c2.prepare("SELECT valor FROM config WHERE clave = 'marca_partidos_en_conflicto'").get();
  check('el conflicto queda VISIBLE en vez de resolverse a escondidas', /2026-09-02/.test((marca || {}).valor || ''), JSON.stringify(marca));
  check('y el bot ARRANCÓ igual (el índice falla, el negocio no se cae)',
    !c2.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_partidos_unico'").get());

  // Resuelto el conflicto a mano, el índice entra solo en el próximo arranque.
  c2.prepare('DELETE FROM inscripciones WHERE partido_id = ?').run(dosB);
  c2.prepare('DELETE FROM partidos WHERE id = ?').run(dosB);
  c2.close();
  arrancar();
  const c3 = new DatabaseSync(ruta);
  check('resuelto el conflicto, el índice se crea solo',
    Boolean(c3.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_partidos_unico'").get()));
  c3.close();
  try { fs.rmSync(TMP2, { recursive: true, force: true }); } catch (_) { /* temporal */ }
}

console.log(`\n${fallos ? '❌' : '✅'} ${ok} checks OK, ${fallos} fallos`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* temporal */ }
process.exit(fallos ? 1 : 0);
