/**
 * Backup automático de la BD por correo.
 *
 * Toda la data del negocio (leads, conversaciones, pagos) vive en UN solo
 * archivo SQLite en el disco de Render. Si ese disco se pierde, se pierde el
 * CRM entero — y es justamente lo que hace recuperable a la comunidad si
 * WhatsApp vuelve a banear el número. Esto se manda una copia a un correo cada
 * N horas, así el respaldo vive fuera de Render.
 *
 * Por qué correo y no el espejo a Google Sheet (src/sheetsync.js): ese espejo
 * solo copia la tabla `leads` — no lleva mensajes ni pagos. Sirve para que
 * Clarck mire, no como respaldo.
 *
 * Snapshot consistente: se usa `VACUUM INTO`, que escribe un .db íntegro aunque
 * el bot esté escribiendo en ese momento. Copiar el archivo a mano puede salir
 * cortado por el WAL.
 *
 * Queda INACTIVO (no-op con log) si faltan las credenciales de correo, así que
 * desplegarlo no rompe nada.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const nodemailer = require('nodemailer');

const EMAIL_USER = process.env.KIPI_EMAIL_USER || '';
const EMAIL_PASS = process.env.KIPI_EMAIL_APP_PASSWORD || '';
// A dónde llega el respaldo. Por defecto a la misma casilla que lo envía:
// queda guardado en Gmail sin depender de otra cuenta.
const EMAIL_TO = process.env.BACKUP_EMAIL_TO || EMAIL_USER;

const activo = () => Boolean(EMAIL_USER && EMAIL_PASS);

function hoyLima() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Lima' }); // YYYY-MM-DD
}

/**
 * Arma el .db.gz en un temporal y devuelve {archivo, nombre, bytes, stats}.
 * El que llama es responsable de borrar `archivo`.
 */
function armarSnapshot(db) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pichangueros-backup-'));
  const crudo = path.join(dir, 'snapshot.db');
  db.snapshot(crudo);

  const gz = zlib.gzipSync(fs.readFileSync(crudo));
  const archivo = path.join(dir, 'backup.db.gz');
  fs.writeFileSync(archivo, gz);
  fs.unlinkSync(crudo);

  return {
    archivo,
    dir,
    nombre: `pichangueros-${hoyLima()}.db.gz`,
    bytes: gz.length,
  };
}

function limpiar(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); }
  catch (e) { console.error('[backup] No se pudo limpiar el temporal:', e.message); }
}

/** Hace el snapshot y lo manda por correo. Devuelve {ok, ...} — nunca tira. */
async function enviarBackup(db, { motivo = 'programado' } = {}) {
  if (!activo()) {
    return { ok: false, motivo: 'no configurado (faltan KIPI_EMAIL_USER / KIPI_EMAIL_APP_PASSWORD)' };
  }

  let snap = null;
  try {
    snap = armarSnapshot(db);
    const s = db.stats();
    const pagos = db.resumenPagos ? db.resumenPagos() : null;

    const detalle = [
      `Leads: ${s.leads}`,
      `Con datos: ${s.completos}`,
      `En handoff: ${s.enHandoff}`,
      pagos ? `Pagos confirmados: ${pagos.confirmados} (S/ ${pagos.monto})` : null,
      `Tamaño: ${(snap.bytes / 1024).toFixed(0)} KB comprimido`,
      `Motivo: ${motivo}`,
    ].filter(Boolean).join('\n');

    const transporte = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: EMAIL_USER, pass: EMAIL_PASS },
    });

    await transporte.sendMail({
      from: `Pichangueros Bot <${EMAIL_USER}>`,
      to: EMAIL_TO,
      subject: `Backup Pichangueros ${hoyLima()}`,
      text: `Respaldo automático de la base de datos del bot.\n\n${detalle}\n\n`
        + 'Para restaurar: descomprimir el .gz y dejar el .db en el disco de Render '
        + 'como pichangueros.db (ruta en DATA_DIR).\n',
      attachments: [{ filename: snap.nombre, path: snap.archivo }],
    });

    console.log(`[backup] Enviado a ${EMAIL_TO} (${(snap.bytes / 1024).toFixed(0)} KB, ${motivo}).`);
    return { ok: true, bytes: snap.bytes, para: EMAIL_TO };
  } catch (e) {
    console.error('[backup] FALLÓ el respaldo:', e.message);
    return { ok: false, motivo: e.message };
  } finally {
    if (snap) limpiar(snap.dir);
  }
}

/** Backup periódico: uno al arrancar (con demora) y luego cada N horas. */
function programarBackup(db, horas = Number(process.env.BACKUP_HORAS || 24)) {
  if (!activo()) {
    console.log('[backup] Respaldo por correo INACTIVO (sin KIPI_EMAIL_USER/KIPI_EMAIL_APP_PASSWORD).');
    return;
  }
  // 2 min después de arrancar: no compite con el arranque ni se dispara en
  // cada reinicio rápido de un deploy.
  setTimeout(() => enviarBackup(db, { motivo: 'arranque' }), 120_000);
  setInterval(() => enviarBackup(db, { motivo: 'programado' }), horas * 3600e3);
  console.log(`[backup] Respaldo por correo activo → ${EMAIL_TO} (cada ${horas} h).`);
}

// Horas de Lima en que sale el resumen de derivados. Tres al día: a la mañana
// para arrancar, a media tarde antes de las pichangas, y de noche al cerrar.
const HORAS_RESUMEN = (process.env.RESUMEN_HORAS || '8,14,21')
  .split(',').map((h) => Number(h.trim())).filter((h) => h >= 0 && h <= 23);

const ahoraLima = () => new Date(Date.now() - 5 * 3600e3).toISOString().slice(0, 19).replace('T', ' ');

/**
 * Resumen de contactos derivados a Clarck, agrupado, 3 veces al día.
 *
 * Cada handoff manda su WhatsApp al toque —ahí no molesta, es el canal donde
 * él ya vive— pero por correo van juntos: se marcan ~41 por día y 41 correos
 * diarios no se leen, se ignoran. Juntos además se ve el patrón; sueltos, no.
 *
 * Lo urgente (pagos por revisar, pagos sin asignar, partidos vendidos y no
 * cargados) NO pasa por acá: eso sigue saliendo al instante, porque tiene
 * plata adentro y son pocos.
 */
async function enviarResumenHandoffs(db, { motivo = 'programado' } = {}) {
  // Sin marca previa (primer arranque) NO se usa "ahora": eso se saltearía todo
  // lo que ya estaba esperando. El piso lo pone el punto de arranque, que
  // handoffsDesde aplica por su cuenta — así el primer resumen trae justo lo
  // que entró después del corte y nada de la historia vieja.
  const desde = db.getMarca('resumen_handoffs') || '0000-00-00';
  const pendientes = db.handoffsDesde(desde);
  if (!pendientes.length) return { ok: true, enviados: 0 };
  // La marca queda en el timestamp del ÚLTIMO leído, no en "ahora": entre la
  // lectura y el guardado puede entrar un handoff, y con "ahora" se perdería.
  db.setMarca('resumen_handoffs', pendientes[pendientes.length - 1].actualizado_en);

  const lineas = pendientes.map((l) => {
    const hora = String(l.actualizado_en || '').slice(11, 16);
    return `· ${hora}  ${l.nombre || `+${l.numero}`} — ${l.handoff_motivo || 'caso especial'}\n  wa.me/${l.numero}`;
  }).join('\n');

  // Vía module.exports (no la referencia interna) para que los tests puedan
  // interceptar el envío sin tocar SMTP — mismo idioma que pagos.leerVoucher.
  const r = await module.exports.avisar(
    `${pendientes.length} contacto${pendientes.length === 1 ? '' : 's'} esperando a Clarck`,
    `Estos quedaron derivados desde el último resumen. El bot ya no les responde:\n\n${lineas}\n\n`
    + `Para que el bot retome a alguno: "kipi reactivar <número>" por WhatsApp, o desde su ficha en el panel.`
  );
  console.log(`[resumen] ${pendientes.length} derivados enviados por correo (${motivo}).`);
  return { ok: r.ok, enviados: pendientes.length };
}

/**
 * EL PARTE SEMANAL — domingo 19 h de Lima, por correo.
 *
 * Clarck no abre el panel: la semana tiene que ser legible en el CUERPO del
 * mail, no detrás de un link. Y señala lo que FALTA, no solo lo que hay — el
 * 15/08 prometió por WhatsApp un domingo 6pm que nunca se cargó, cobró S/20 por
 * dos cupos y no había dónde ponerlos. Un parte que solo listara los partidos
 * cargados habría mostrado esa semana como perfecta.
 *
 * ESCALA POR ANOMALÍA, NO POR CALENDARIO: si la semana salió como siempre
 * —todo cargado, nada por liquidar— no se manda nada. Un correo dominical que
 * nunca dice nada nuevo se deja de leer en tres semanas, y entonces tampoco se
 * lee el que sí importa.
 */
async function enviarParteSemanal(db, { motivo = 'programado', forzar = false } = {}) {
  const hoy = db.hoyLima();
  const dias = Array.from({ length: 7 }, (_, i) => db.sumarDias(hoy, i + 1));
  const desde = dias[0], hasta = dias[6];

  const partidos = db.listPartidos().filter((p) => p.fecha >= desde && p.fecha <= hasta && p.fase !== 'cancelado');
  const huecos = db.diasSinCargar({ dias: 8 }).filter((h) => h.fecha >= desde && h.fecha <= hasta);
  const porLiquidar = db.partidosPorLiquidar();
  const conflictos = db.conflictosDePartidos();
  // Un turno encendido que no puso ni una fecha en la semana está roto (día de
  // semana mal, vigencia vencida, excepción que quedó pegada).
  const turnosMudos = db.listTurnos({ soloActivos: true })
    .filter((t) => !partidos.some((p) => p.turno_id === t.id));

  const anomalias = huecos.length + porLiquidar.length + conflictos.length + turnosMudos.length + (partidos.length ? 0 : 1);
  if (!anomalias && !forzar) {
    console.log('[parte] La semana salió como siempre: no se manda correo (se escala por anomalía, no por calendario).');
    return { ok: true, enviado: false, anomalias: 0 };
  }

  const soles = (n) => `S/ ${Number(n || 0).toLocaleString('es-PE', { maximumFractionDigits: 0 })}`;
  const bloqueDia = (f) => {
    const delDia = partidos.filter((p) => p.fecha === f);
    const huecosDia = huecos.filter((h) => h.fecha === f);
    if (!delDia.length && !huecosDia.length) return null;
    const lineas = [
      ...delDia.map((p) => `   · ${p.hora || 'sin hora'} — ${db.nombreDeZona(p.zona)}${p.sede ? ` (${p.sede})` : ''} · ${p.ocupados}/${p.cupo} cupos${p.en_espera ? ` · ${p.en_espera} en espera` : ''}`),
      ...huecosDia.map((h) => `   ⚠ ${h.hora} en ${db.nombreDeZona(h.zona)}: NADA CARGADO (los últimos ${h.veces} ${db.diaPlural(h.dia_nombre)} jugaste a esa hora)`),
    ];
    return `${db.fechaBonita(f, { relativa: false }).toUpperCase()}\n${lineas.join('\n')}`;
  };

  // Los bloques se arman aparte y se pegan con una línea en blanco: un correo
  // que se lee en el celular necesita el aire, y filtrar los vacíos junto con
  // los separadores dejaba todo pegado en un solo párrafo.
  const bloques = [
    `Semana del ${db.fechaBonita(desde, { relativa: false })} al ${db.fechaBonita(hasta, { relativa: false })}.`,
    dias.map(bloqueDia).filter(Boolean).join('\n\n') || 'No hay NINGÚN partido cargado para toda la semana.',
    huecos.length && `LO QUE FALTA (${huecos.length}):\n${huecos.map((h) => `   · ${db.fechaBonita(h.fecha, { relativa: false })} ${h.hora} en ${db.nombreDeZona(h.zona)}${h.sede ? ` (${h.sede})` : ''}`).join('\n')}`,
    turnosMudos.length && `TURNOS ENCENDIDOS QUE NO CARGARON NADA (${turnosMudos.length}):\n${turnosMudos.map((t) => `   · ${db.diaPlural(t.dia_nombre)} ${t.hora} en ${db.nombreDeZona(t.zona)} — revisá el día de la semana y la vigencia`).join('\n')}`,
    porLiquidar.length && `PARTIDOS JUGADOS SIN LIQUIDAR (${porLiquidar.length}):\n${porLiquidar.map((p) => `   · ${db.fechaBonita(p.fecha, { relativa: false })} ${p.hora || ''} ${db.nombreDeZona(p.zona)} — cobrado ${soles(p.caja ? p.caja.cobrado : 0)}${p.caja && p.caja.porCobrar > 0 ? `, falta cobrar ${soles(p.caja.porCobrar)}` : ''}`).join('\n')}`,
    conflictos.length && `PARTIDOS DUPLICADOS CON GENTE EN LOS DOS (${conflictos.length}):\n   ${conflictos.join('\n   ')}`,
    'El panel tiene la semana completa y los botones para cargar lo que falta.',
  ];
  const cuerpo = bloques.filter(Boolean).join('\n\n');

  const r = await module.exports.avisar(
    huecos.length
      ? `Parte semanal: faltan ${huecos.length} pichanga${huecos.length === 1 ? '' : 's'} por cargar`
      : `Parte semanal: ${partidos.length} pichanga${partidos.length === 1 ? '' : 's'} cargadas`,
    cuerpo,
  );
  console.log(`[parte] Parte semanal enviado (${motivo}) — ${anomalias} cosas que revisar.`);
  return { ok: r.ok, enviado: true, anomalias, cuerpo };
}

// Domingo (0) a las 19 h de Lima: la hora en que Clarck cierra la semana y
// puede hacer algo con lo que falta antes del lunes.
const PARTE_DIA = Number(process.env.PARTE_DIA ?? 0);
const PARTE_HORA = Number(process.env.PARTE_HORA ?? 19);

/**
 * EL TICK. Uno solo, cada 10 min, para todo lo que pasa "cuando corresponde":
 * genera los partidos de los turnos, manda el resumen de derivados en su franja
 * y saca el parte semanal el domingo.
 *
 * Chequear cada 10 min en vez de agendar un timer exacto es lo que lo hace
 * sobrevivir a reinicios y deploys: la marca en la BD dice si esa franja ya
 * salió, así que no se manda dos veces ni se saltea una.
 *
 * La generación de turnos NO depende del correo: si faltan las credenciales de
 * Gmail el resumen no sale, pero los partidos se tienen que cargar igual.
 */
function programarResumen(db) {
  const revisar = async () => {
    // 1. Materializar los turnos activos. Idempotente: si ya están, no hace
    //    nada. Va acá y no en partidosAbiertos() —el camino caliente del bot—
    //    porque una lectura tiene que seguir siendo una lectura.
    try { db.generarPartidosDeTurnos(); } catch (e) { console.error('[turnos] Generación fallida:', e.message); }
    if (!activo()) return;
    try {
      const ahora = new Date(Date.now() - 5 * 3600e3);
      const hoy = ahora.toISOString().slice(0, 10);
      const hora = ahora.getUTCHours();

      // 2. Parte semanal (domingo 19 h). Misma mecánica de marca: una por fecha.
      if (ahora.getUTCDay() === PARTE_DIA && hora >= PARTE_HORA && db.getMarca('parte_semanal') !== hoy) {
        db.setMarca('parte_semanal', hoy);
        await enviarParteSemanal(db);
      }

      // 3. Resumen de derivados, tres veces al día.
      const franja = HORAS_RESUMEN.filter((h) => h <= hora).pop();
      if (franja === undefined) return;
      const marca = `${hoy}-${franja}`;
      if (db.getMarca('resumen_franja') === marca) return;
      db.setMarca('resumen_franja', marca);
      await enviarResumenHandoffs(db);
    } catch (e) { console.error('[resumen] Falló:', e.message); }
  };
  setTimeout(revisar, 90_000);           // no compite con el arranque
  setInterval(revisar, 10 * 60_000);
  console.log(`[tick] Turnos + resumen (${HORAS_RESUMEN.join('h, ')}h) + parte semanal (domingos ${PARTE_HORA}h) cada 10 min.`);
}

/**
 * Aviso urgente por correo. Es el único canal CONFIABLE para las alertas de
 * salud de la cuenta.
 *
 * Mandarlas por WhatsApp saliente no sirve: Cloud API rechaza el texto libre
 * fuera de la ventana de 24 h (error 131047), y el número de control casi nunca
 * escribió al bot en ese lapso. Peor todavía en el caso que más importa —la
 * cuenta deshabilitada o la coexistencia desconectada— donde el canal que
 * avisaría es exactamente el que se cayó.
 *
 * Nunca tira: si el correo no está configurado, deja el aviso en el log.
 */
async function avisar(asunto, cuerpo = '') {
  if (!activo()) {
    console.error(`[aviso] SIN CANAL DE CORREO — el aviso queda solo en el log: ${asunto}`);
    return { ok: false, motivo: 'no configurado' };
  }
  try {
    const transporte = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: EMAIL_USER, pass: EMAIL_PASS },
    });
    await transporte.sendMail({
      from: `Pichangueros Bot <${EMAIL_USER}>`,
      to: EMAIL_TO,
      subject: `[Pichangueros] ${asunto}`,
      text: `${cuerpo || asunto}\n\nEnviado por el bot de Pichangueros (${hoyLima()}).\n`,
    });
    console.log(`[aviso] Enviado por correo a ${EMAIL_TO}: ${asunto}`);
    return { ok: true };
  } catch (e) {
    console.error('[aviso] No se pudo mandar el correo:', e.message);
    return { ok: false, motivo: e.message };
  }
}

module.exports = {
  enviarBackup, programarBackup, activo, armarSnapshot, avisar,
  programarResumen, enviarResumenHandoffs, enviarParteSemanal,
};
