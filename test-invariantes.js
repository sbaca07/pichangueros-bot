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

/**
 * Un partido que YA se jugó, con su gente adentro.
 *
 * Desde el 17/08 no se puede anotar a nadie en un partido que terminó hace más
 * de 24 h (la GRACIA): la historia vieja se construye, no se declara — se abre
 * a futuro, se anota a los jugadores y se le mueve la fecha al pasado. El slot
 * futuro se reutiliza porque al mover la fecha queda libre de nuevo.
 */
let slotLibre = 60;
const partidoJugado = (fecha, jugadores, zona = 'brena') => {
  const id = db.crearPartido({ zona, fecha: enDias(slotLibre++), hora: '10-11pm', cupo: 20, precio: 15 });
  for (const j of jugadores) db.inscribir(id, j, { nombre: j });
  // Si la fecha destino ya tiene un partido igual, que reviente acá: en
  // silencio quedaría un partido en el futuro que nadie está probando.
  const r = db.actualizarPartido(id, { fecha });
  if (!r.ok) throw new Error(`partidoJugado(${fecha}) no pudo mover la fecha: ${r.motivo}`);
  return id;
};

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

console.log('== 7 · Quien paga cuenta como cliente, sin que nadie lo declare ==');
// Luiggi llevaba 3 pagos y S/30 y figuraba "Nuevo": la etapa solo avanzaba con
// nombre+edad+distrito y con el link del grupo, así que el que paga sin
// registrarse —el que deja plata— se caía del modelo. Ahora no hay etapa: la
// relación se DERIVA de los pagos y los partidos en cada lectura.
db.getOrCreateLead('51900000107');
check('sin nada, la relación es "nuevo"', db.relacionDe(db.metricasDe('51900000107').visitas) === 'nuevo');
db.registrarPago({ numero: '51900000107', monto: 15, numero_operacion: 'OP-INV-9', estado: 'confirmado' });
const mLuiggi = db.metricasDe('51900000107');
check('con un pago confirmado ya cuenta una visita', mLuiggi.visitas === 1);
check('…y la relación pasa a "probó" sola', db.relacionDe(mLuiggi.visitas) === 'probo');
check('sin haber dado un solo dato', !db.getLead('51900000107').nombre);
check('la plata también se suma', mLuiggi.soles === 15 && mLuiggi.pagos === 1);

db.getOrCreateLead('51900000108');
db.registrarPago({ numero: '51900000108', monto: 15, numero_operacion: 'OP-INV-10', estado: 'revisar' });
check('un pago POR REVISAR no cuenta como visita', db.metricasDe('51900000108').visitas === 0);

// La columna vieja quedó CONGELADA: si algo la volviera a escribir, en un mes
// vuelve a haber dos verdades peleando por el mismo contacto.
const crudo = () => new (require('node:sqlite').DatabaseSync)(db.dbPath);
const estadoCrudo = (n) => { const c = crudo(); const r = c.prepare('SELECT estado FROM leads WHERE numero = ?').get(n); c.close(); return r.estado; };
check('registrarPago ya NO toca la columna estado', estadoCrudo('51900000107') === 'nuevo');
db.updateLead('51900000107', { estado: 'inactivo', nombre: 'Luiggi' });
check('updateLead tampoco la deja escribir', estadoCrudo('51900000107') === 'nuevo');
check('…pero sí guarda los campos de verdad', db.getLead('51900000107').nombre === 'Luiggi');

console.log('== 7b · Una visita es un DÍA, no un cupo ni un voucher ==');
// Un Yape de S/30 por dos cupos es una persona que vino con un amigo: una
// visita. Y el pago que se engancha a un partido del mismo día no puede
// contarse dos veces (por eso la unión es UNION y no UNION ALL).
const dosCupos = '51900000109';
db.getOrCreateLead(dosCupos);
db.updateLead(dosCupos, { zona: 'brena' });
db.registrarPago({ numero: dosCupos, monto: 30, cupos: 2, numero_operacion: 'OP-INV-12', estado: 'confirmado' });
check('un pago de 2 cupos es UNA visita', db.metricasDe(dosCupos).visitas === 1);
db.registrarPago({ numero: dosCupos, monto: 15, numero_operacion: 'OP-INV-13', estado: 'confirmado' });
check('dos pagos el MISMO día siguen siendo una visita', db.metricasDe(dosCupos).visitas === 1);
check('pero los vouchers se cuentan aparte', db.metricasDe(dosCupos).pagos === 2 && db.metricasDe(dosCupos).soles === 45);

// Un partido pasado con inscripción viva también es una visita, aunque no haya
// voucher (el efectivo en la cancha, el invitado que pagó otro).
partidoJugado(enDias(-3), [dosCupos]);
check('un partido jugado suma otra visita', db.metricasDe(dosCupos).visitas === 2);
check('…y la relación sube sola a "vuelve"', db.relacionDe(db.metricasDe(dosCupos).visitas) === 'vuelve');

// El mismo día contado por las dos fuentes: pago + partido de esa fecha.
const dupli = '51900000110';
db.getOrCreateLead(dupli);
db.updateLead(dupli, { zona: 'brena' });
partidoJugado(enDias(-1), [dupli]);
const conn2 = new (require('node:sqlite').DatabaseSync)(db.dbPath);
const pagoDup = db.registrarPago({ numero: dupli, monto: 15, numero_operacion: 'OP-INV-14', estado: 'confirmado' });
conn2.prepare("UPDATE pagos SET creado_en = datetime(? || ' 20:00:00') WHERE id = ?").run(enDias(-1), pagoDup);
conn2.close();
check('pago y partido del MISMO día = una sola visita', db.metricasDe(dupli).visitas === 1, String(db.metricasDe(dupli).visitas));

console.log('== 7c · Frescura: los cortes los pone Clarck, no el código ==');
check('por defecto, 3 semanas / mes y medio', db.umbralesFrescura().frio === 21 && db.umbralesFrescura().perdido === 45);
check('el que vino ayer está al día', db.frescuraDe(1) === 'al_dia');
check('a los 30 días se está enfriando', db.frescuraDe(30) === 'enfriando');
check('a los 60 está perdido', db.frescuraDe(60) === 'perdido');
db.setConfig({ dias_frio: '7', dias_perdido: '14' });
check('cambiados los cortes en Config, la lectura cambia', db.frescuraDe(10) === 'enfriando' && db.frescuraDe(20) === 'perdido');
db.setConfig({ dias_frio: '30', dias_perdido: '10' });
check('cortes invertidos no dejan "enfriándose" vacío', db.umbralesFrescura().perdido > db.umbralesFrescura().frio);
db.setConfig({ dias_frio: '21', dias_perdido: '45' });
check('sin fecha no se inventa una frescura', db.frescuraDe(null) === null);

console.log('== 7d · El link del grupo se anota una vez y no retrocede ==');
const conGrupo = '51900000111';
db.getOrCreateLead(conGrupo);
check('arranca sin grupo', !db.getLead(conGrupo).grupo_enviado_en);
check('la primera vez se marca', db.marcarGrupoEnviado(conGrupo, '2026-08-01') === true);
check('la segunda no pisa la fecha original', db.marcarGrupoEnviado(conGrupo, '2026-08-16') === false
  && db.getLead(conGrupo).grupo_enviado_en === '2026-08-01');

check('"con datos" se mide por los DATOS, no por la etapa',
  db.stats().completos === db.listLeads().filter((l) => l.nombre && l.edad && l.distrito).length);

console.log('== 7e · A quién convocar para llenar un partido ==');
const pConv = db.crearPartido({ zona: 'brena', fecha: enDias(6), hora: '8-9pm', cupo: 14, precio: 15 });
const candidatos = db.candidatosConvocatoria(pConv);
check('los que ya vinieron a Breña son candidatos', candidatos.some((c) => c.numero === dosCupos));
check('el que nunca vino NO lo es', !candidatos.some((c) => c.numero === '51900000108'));
db.inscribir(pConv, dosCupos, { nombre: 'Dos Cupos' });
check('inscrito en ESE partido, sale de la lista', !db.candidatosConvocatoria(pConv).some((c) => c.numero === dosCupos));
db.setEtiquetas(dupli, 'dado-de-baja');
check('un "dado-de-baja" nunca se convoca', !db.candidatosConvocatoria(pConv).some((c) => c.numero === dupli));
check('ordena por frescura: el más reciente primero',
  db.candidatosConvocatoria(pConv).every((c, i, a) => i === 0 || (a[i - 1].ultima || '') >= (c.ultima || '')));

console.log('== 8 · La caja no devuelve NaN cuando falta el precio ==');
// p.precio ?? Number(cfg[...]) ?? 0 → el ?? no atrapa NaN y la caja salía NaN.
const p3 = db.crearPartido({ zona: 'comas', fecha: enDias(3), hora: '8-9pm', cupo: 10 });
db.setConfig('precio_comas', '');
const caja = db.cajaPartido(p3);
check('cobrado es un número', Number.isFinite(caja.cobrado));
check('por pagar es un número', Number.isFinite(caja.porPagar));

console.log('== 9 · La migración que apaga las etapas (una sola pasada) ==');
{
  // Las migraciones corren al CARGAR el módulo, así que esto se prueba en un
  // proceso aparte: se prepara una BD con la escalera vieja adentro y se
  // arranca db.js encima, que es exactamente lo que va a pasar en el deploy.
  const TMP2 = fs.mkdtempSync(path.join(os.tmpdir(), 'pich-mig-'));
  const { execFileSync } = require('child_process');
  const arrancar = (script) => execFileSync(process.execPath, ['-e', script], {
    env: { ...process.env, WWEBJS_AUTH_PATH: TMP2 }, encoding: 'utf8', cwd: __dirname,
  });

  // 1ª pasada: crea el esquema (y marca la migración como hecha).
  arrancar("require('./src/db');");

  // Se rebobina: se borra el flag y se siembra la escalera vieja a mano, con
  // los dos casos que la migración tiene que rescatar y uno que NO debe tocar.
  const c = new (require('node:sqlite').DatabaseSync)(path.join(TMP2, 'data', 'pichangueros.db'));
  c.exec("DELETE FROM config WHERE clave = 'relacion_derivada_2026_08'");
  const alta = (n, estado, etiquetas) => c.prepare(
    "INSERT INTO leads (numero, estado, etiquetas, creado_en, actualizado_en) VALUES (?, ?, ?, '2026-07-01 10:00:00', '2026-07-20 18:30:00')"
  ).run(n, estado, etiquetas);
  alta('51900000901', 'invitado_grupo', null);
  alta('51900000902', 'inactivo', 'paga efectivo');
  alta('51900000903', 'inactivo', 'dado-de-baja');   // ya etiquetado: no duplicar
  alta('51900000904', 'activo', 'VIP');              // no se toca
  c.close();

  arrancar("require('./src/db');");

  const c2 = new (require('node:sqlite').DatabaseSync)(path.join(TMP2, 'data', 'pichangueros.db'));
  const lee = (n) => c2.prepare('SELECT estado, etiquetas, grupo_enviado_en FROM leads WHERE numero = ?').get(n);
  const a = lee('51900000901'), b = lee('51900000902'), d3 = lee('51900000903'), e = lee('51900000904');
  check('el "invitado_grupo" queda con la FECHA en que se le mandó el link', a.grupo_enviado_en === '2026-07-20', String(a.grupo_enviado_en));
  check('el "inactivo" queda etiquetado dado-de-baja', /dado-de-baja/.test(b.etiquetas || ''), String(b.etiquetas));
  check('…sin pisar las etiquetas que ya tenía', /paga efectivo/.test(b.etiquetas || ''), String(b.etiquetas));
  check('no se duplica la etiqueta si ya estaba', (d3.etiquetas.match(/dado-de-baja/g) || []).length === 1, String(d3.etiquetas));
  check('un "activo" no se toca', e.etiquetas === 'VIP' && !e.grupo_enviado_en);
  check('la columna estado se deja como estaba (congelada, no borrada)',
    a.estado === 'invitado_grupo' && b.estado === 'inactivo' && e.estado === 'activo');

  // Idempotencia: correrla de nuevo (deploy tras deploy) no puede sumar nada.
  c2.exec("DELETE FROM config WHERE clave = 'relacion_derivada_2026_08'");
  c2.close();
  arrancar("require('./src/db');");
  const c3 = new (require('node:sqlite').DatabaseSync)(path.join(TMP2, 'data', 'pichangueros.db'));
  const b2 = c3.prepare('SELECT etiquetas FROM leads WHERE numero = ?').get('51900000902');
  const a2 = c3.prepare('SELECT grupo_enviado_en FROM leads WHERE numero = ?').get('51900000901');
  c3.close();
  check('corriéndola dos veces, la etiqueta no se duplica', (b2.etiquetas.match(/dado-de-baja/g) || []).length === 1, String(b2.etiquetas));
  check('…y la fecha del grupo no se mueve', a2.grupo_enviado_en === '2026-07-20', String(a2.grupo_enviado_en));
  try { fs.rmSync(TMP2, { recursive: true, force: true }); } catch (_) {}
}

console.log(`\n${fallos ? '❌' : '✅'} ${ok} checks OK, ${fallos} fallos`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
process.exit(fallos ? 1 : 0);
