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

module.exports = { enviarBackup, programarBackup, activo, armarSnapshot, avisar };
