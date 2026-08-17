/**
 * Pruebas del respaldo por correo (src/backup.js) — `node test-backup.js`.
 *
 * No manda correos: se intercepta nodemailer.createTransport antes de cargar el
 * módulo. Usa una BD SQLite temporal de verdad (no un mock) para probar que el
 * snapshot con VACUUM INTO sale íntegro y descomprimible.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { DatabaseSync } = require('node:sqlite');

process.env.KIPI_EMAIL_USER = 'kipienterprise@gmail.com';
process.env.KIPI_EMAIL_APP_PASSWORD = 'clave-falsa';
process.env.BACKUP_EMAIL_TO = 'destino@ejemplo.com';
// backup.js lee los DOS destinos (avisos / respaldo) de la BD, con estas env
// vars como valor inicial: hay que apuntarlo a una BD temporal para no leer la
// de desarrollo (ni escribirla) desde una prueba.
process.env.WWEBJS_AUTH_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'test-backup-db-'));

// --- Doble de nodemailer (antes de requerir backup.js) -------------------------
const enviados = [];
let fallarEnvio = false;
const nodemailer = require('nodemailer');
nodemailer.createTransport = () => ({
  sendMail: async (opciones) => {
    if (fallarEnvio) throw new Error('SMTP caído');
    // Leemos el adjunto ACÁ: backup.js borra el temporal apenas termina.
    const adj = opciones.attachments[0];
    enviados.push({ opciones, contenido: fs.readFileSync(adj.path) });
    return { messageId: 'fake' };
  },
});

const backup = require('./src/backup');

let ok = 0;
let fallos = 0;
function check(nombre, condicion, detalle = '') {
  if (condicion) { ok++; console.log(`  ✓ ${nombre}`); }
  else { fallos++; console.error(`  ✗ ${nombre}${detalle ? ` — ${detalle}` : ''}`); }
}

// --- BD de prueba --------------------------------------------------------------

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-backup-'));
const dbPath = path.join(dir, 'prueba.db');
const sqlite = new DatabaseSync(dbPath);
sqlite.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE leads (numero TEXT PRIMARY KEY, nombre TEXT, estado TEXT, handoff INTEGER DEFAULT 0);
  CREATE TABLE pagos (id INTEGER PRIMARY KEY, monto REAL, estado TEXT);
  CREATE TABLE mensajes (id INTEGER PRIMARY KEY, numero TEXT, texto TEXT);
`);
for (let i = 0; i < 50; i++) {
  sqlite.prepare('INSERT INTO leads VALUES (?,?,?,?)').run(`5194379${1000 + i}`, `Jugador ${i}`, i % 3 ? 'activo' : 'nuevo', i % 10 ? 0 : 1);
  sqlite.prepare('INSERT INTO mensajes VALUES (?,?,?)').run(i, `5194379${1000 + i}`, `mensaje ${i}`);
}
for (let i = 0; i < 20; i++) {
  sqlite.prepare('INSERT INTO pagos VALUES (?,?,?)').run(i, 10, i < 15 ? 'confirmado' : 'revisar');
}

// Fachada mínima con la forma que backup.js espera de src/db.js.
const db = {
  snapshot: (destino) => { sqlite.exec(`VACUUM INTO '${destino.replace(/'/g, "''")}'`); return destino; },
  stats: () => ({
    leads: sqlite.prepare('SELECT COUNT(*) c FROM leads').get().c,
    completos: sqlite.prepare("SELECT COUNT(*) c FROM leads WHERE estado != 'nuevo'").get().c,
    enHandoff: sqlite.prepare('SELECT COUNT(*) c FROM leads WHERE handoff = 1').get().c,
  }),
  resumenPagos: () => {
    const r = sqlite.prepare("SELECT COUNT(*) n, COALESCE(SUM(monto),0) s FROM pagos WHERE estado='confirmado'").get();
    return { confirmados: r.n, monto: r.s };
  },
};

// --- Pruebas -------------------------------------------------------------------

async function main() {
  console.log('\n== Envío del respaldo ==');
  {
    const r = await backup.enviarBackup(db, { motivo: 'prueba' });
    check('devuelve ok', r.ok === true, JSON.stringify(r));
    check('manda exactamente un correo', enviados.length === 1, `enviados=${enviados.length}`);

    const { opciones } = enviados[0];
    check('va al destinatario de BACKUP_EMAIL_TO', opciones.to === 'destino@ejemplo.com', opciones.to);
    check('sale de la cuenta de KIPI', opciones.from.includes('kipienterprise@gmail.com'), opciones.from);
    check('asunto con la fecha', /^Backup Pichangueros \d{4}-\d{2}-\d{2}$/.test(opciones.subject), opciones.subject);
    check('adjunto .db.gz con fecha', /^pichangueros-\d{4}-\d{2}-\d{2}\.db\.gz$/.test(opciones.attachments[0].filename), opciones.attachments[0].filename);
  }

  console.log('\n== El adjunto es una BD íntegra ==');
  {
    const { contenido } = enviados[0];
    check('es un gzip válido', contenido[0] === 0x1f && contenido[1] === 0x8b);

    const crudo = zlib.gunzipSync(contenido);
    const restaurada = path.join(dir, 'restaurada.db');
    fs.writeFileSync(restaurada, crudo);

    const dbr = new DatabaseSync(restaurada, { readOnly: true });
    check('conserva los 50 leads', dbr.prepare('SELECT COUNT(*) c FROM leads').get().c === 50);
    check('conserva los 50 mensajes', dbr.prepare('SELECT COUNT(*) c FROM mensajes').get().c === 50);
    check('conserva los 20 pagos', dbr.prepare('SELECT COUNT(*) c FROM pagos').get().c === 20);
    check('la data se lee bien', dbr.prepare('SELECT nombre FROM leads WHERE numero = ?').get('51943791007')?.nombre === 'Jugador 7');
    check('comprime de verdad', contenido.length < crudo.length, `${contenido.length} vs ${crudo.length}`);
  }

  console.log('\n== Snapshot consistente con escrituras en curso ==');
  {
    // Escribimos ANTES del snapshot sin checkpoint: la data nueva vive en el WAL.
    // Copiar el archivo a mano se la perdería; VACUUM INTO no.
    sqlite.prepare('INSERT INTO leads VALUES (?,?,?,?)').run('51999999999', 'Recién llegado', 'nuevo', 0);
    enviados.length = 0;
    await backup.enviarBackup(db, { motivo: 'prueba wal' });

    const crudo = zlib.gunzipSync(enviados[0].contenido);
    const p = path.join(dir, 'wal.db');
    fs.writeFileSync(p, crudo);
    const dbr = new DatabaseSync(p, { readOnly: true });
    check('incluye lo que estaba en el WAL', dbr.prepare('SELECT nombre FROM leads WHERE numero = ?').get('51999999999')?.nombre === 'Recién llegado');
    check('ahora son 51 leads', dbr.prepare('SELECT COUNT(*) c FROM leads').get().c === 51);
  }

  console.log('\n== Resumen dentro del correo ==');
  {
    const { opciones } = enviados[0];
    check('reporta el total de leads', opciones.text.includes('Leads: 51'), opciones.text.split('\n')[2]);
    check('reporta pagos confirmados y monto', /Pagos confirmados: 15 \(S\/ 150\)/.test(opciones.text));
    check('reporta el motivo', opciones.text.includes('Motivo: prueba wal'));
    check('explica cómo restaurar', opciones.text.includes('descomprimir'));
  }

  console.log('\n== Fallas y limpieza ==');
  {
    fallarEnvio = true;
    const r = await backup.enviarBackup(db, { motivo: 'prueba error' });
    check('un SMTP caído NO tira excepción', r.ok === false, JSON.stringify(r));
    check('el motivo del error se propaga', /SMTP caído/.test(r.motivo || ''), r.motivo);
    fallarEnvio = false;

    const temporales = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('pichangueros-backup-'));
    check('no deja temporales tirados (ni al fallar)', temporales.length === 0, `quedaron ${temporales.length}: ${temporales.slice(0, 3)}`);
  }

  console.log('\n== Sin credenciales queda inactivo ==');
  {
    // Recargamos el módulo sin las vars: no debe intentar mandar nada.
    delete require.cache[require.resolve('./src/backup')];
    const userAntes = process.env.KIPI_EMAIL_USER;
    delete process.env.KIPI_EMAIL_USER;
    const sinCreds = require('./src/backup');
    check('activo() = false', sinCreds.activo() === false);
    const r = await sinCreds.enviarBackup(db, {});
    check('enviarBackup avisa que no está configurado', r.ok === false && /no configurado/.test(r.motivo), JSON.stringify(r));
    process.env.KIPI_EMAIL_USER = userAntes;
  }

  // En Windows no se puede borrar un .db con el handle abierto (EPERM), y si la
  // limpieza tira, el resultado de las pruebas se pierde. Cerrar y no fallar.
  try { sqlite.close(); } catch { /* ya cerrada */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); }
  catch (e) { console.warn(`  (aviso) no se pudo borrar el temporal: ${e.code}`); }

  console.log(`\n${fallos === 0 ? '✅' : '❌'} ${ok} checks OK, ${fallos} fallos\n`);
  process.exit(fallos === 0 ? 0 : 1);
}

main().catch((e) => { console.error('Error corriendo las pruebas:', e); process.exit(1); });
