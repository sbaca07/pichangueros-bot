/**
 * Base de datos local (SQLite) — vive en el disco persistente de Render,
 * junto a la sesión de WhatsApp, así que sobrevive deploys y reinicios.
 *
 * Tablas:
 *   leads     — un registro por contacto: datos del filtro + estado + handoff
 *   mensajes  — historial de conversación (para darle memoria al cerebro)
 *   config    — datos del negocio (precios, textos, links) editables en
 *               /admin/leads?vista=config, sin tocar código ni redesplegar
 *   sedes     — canchas por zona (Breña/Comas), editables desde el mismo panel
 *
 * config/sedes se siembran UNA VEZ desde config/negocio.js si están vacías
 * (primer deploy con esta versión); de ahí en adelante viven solo en la BD.
 */
const fs = require('fs');
const path = require('path');
// SQLite nativo de Node (>=24): cero dependencias que compilar.
const { DatabaseSync } = require('node:sqlite');

const AUTH_PATH = process.env.WWEBJS_AUTH_PATH || '.wwebjs_auth';
const DATA_DIR = path.join(AUTH_PATH, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'pichangueros.db');
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');

db.exec(`
  CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    numero TEXT UNIQUE NOT NULL,          -- ej. 51999888777
    nombre TEXT,
    edad INTEGER,
    distrito TEXT,                        -- lo que pidió el jugador (texto libre)
    zona TEXT,                            -- 'brena' | 'comas' | 'otra' (clasificado)
    estado TEXT NOT NULL DEFAULT 'nuevo', -- nuevo | datos_completos | invitado_grupo | lista_espera
    handoff INTEGER NOT NULL DEFAULT 0,   -- 1 = lo atiende Clarck, bot en silencio
    handoff_motivo TEXT,
    creado_en TEXT NOT NULL DEFAULT (datetime('now', '-5 hours')),
    actualizado_en TEXT NOT NULL DEFAULT (datetime('now', '-5 hours'))
  );

  CREATE TABLE IF NOT EXISTS mensajes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    numero TEXT NOT NULL,
    rol TEXT NOT NULL,                    -- 'user' | 'assistant'
    texto TEXT NOT NULL,
    creado_en TEXT NOT NULL DEFAULT (datetime('now', '-5 hours'))
  );
  CREATE INDEX IF NOT EXISTS idx_mensajes_numero ON mensajes(numero, id);

  CREATE TABLE IF NOT EXISTS notas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    numero TEXT NOT NULL,
    texto TEXT NOT NULL,
    creado_en TEXT NOT NULL DEFAULT (datetime('now', '-5 hours'))
  );

  CREATE TABLE IF NOT EXISTS config (
    clave TEXT PRIMARY KEY,
    valor TEXT
  );

  CREATE TABLE IF NOT EXISTS sedes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    zona TEXT NOT NULL,              -- 'brena' | 'comas' (mismas zonas que clasifica el cerebro)
    nombre TEXT NOT NULL,
    cancha TEXT,
    cupo INTEGER,
    ubicacion TEXT,
    horario TEXT,
    estacionamiento TEXT,
    orden INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS pagos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    numero TEXT NOT NULL,
    monto REAL,
    titular TEXT,                    -- nombre del remitente que lee la IA del voucher
    numero_operacion TEXT,           -- para detectar reenvíos del mismo comprobante
    estado TEXT NOT NULL DEFAULT 'confirmado', -- confirmado | revisar
    motivo TEXT,                     -- por qué quedó en revisar (monto no coincide, repetido, ilegible)
    creado_en TEXT NOT NULL DEFAULT (datetime('now', '-5 hours'))
  );
  CREATE INDEX IF NOT EXISTS idx_pagos_numero ON pagos(numero);
  CREATE INDEX IF NOT EXISTS idx_pagos_operacion ON pagos(numero_operacion);
`);

// Semilla única: si config/sedes están vacías, las llenamos con los valores
// que hoy vive en config/negocio.js. Desde acá se editan en el panel admin
// (vista=config), no hace falta tocar código ni redesplegar para un precio,
// horario o sede nueva.
if (db.prepare('SELECT COUNT(*) AS n FROM config').get().n === 0) {
  const negocio = require('../config/negocio');
  const stmtSetConfig = db.prepare('INSERT INTO config (clave, valor) VALUES (?, ?)');
  const sembrar = (clave, valor) => stmtSetConfig.run(clave, valor ?? '');
  sembrar('marca', negocio.marca);
  sembrar('yape_numero', negocio.yape.numero);
  sembrar('yape_titular', negocio.yape.titular);
  sembrar('precio_brena', String(negocio.zonas.brena.precio));
  sembrar('precio_comas', String(negocio.zonas.comas.precio));
  sembrar('grouplink_brena', negocio.zonas.brena.groupLink || '');
  sembrar('grouplink_comas', negocio.zonas.comas.groupLink || '');
  sembrar('hora_llegada', negocio.reglas.horaLlegada);
  sembrar('pago', negocio.reglas.pago);
  sembrar('devoluciones', negocio.reglas.devoluciones);
  sembrar('convivencia', negocio.reglas.convivencia);
  sembrar('mecanica', negocio.mecanica);
  sembrar('bienvenida', negocio.bienvenida);
  sembrar('emojis', negocio.emojis.join(','));

  const stmtSede = db.prepare(
    'INSERT INTO sedes (zona, nombre, cancha, cupo, ubicacion, horario, estacionamiento, orden) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );
  for (const [zonaKey, zona] of Object.entries(negocio.zonas)) {
    zona.sedes.forEach((s, i) => {
      stmtSede.run(zonaKey, s.nombre, s.cancha || null, s.cupo ?? null, s.ubicacion || null, s.horario || null, s.estacionamiento || null, i);
    });
  }
  console.log('[config] Tabla config/sedes sembrada desde config/negocio.js — de acá en adelante se edita en /admin/leads?vista=config.');
}

// Migración de huso horario (2026-07-06): creado_en/actualizado_en se guardaban
// con datetime('now') de SQLite, que es UTC — pero el negocio opera en Lima
// (UTC-5, sin horario de verano) y el panel los muestra tal cual, sin convertir.
// Resultado: todo se veía 5 h adelantado (una conversación de las 9pm aparecía
// como si fuera 2am). Se corrige lo ya guardado UNA sola vez (resta 5 h) y de
// acá en adelante se guarda directo en hora de Lima (datetime('now','-5 hours')).
if (!db.prepare("SELECT valor FROM config WHERE clave = 'tz_migrado_2026_07'").get()) {
  db.exec(`
    UPDATE leads SET creado_en = datetime(creado_en, '-5 hours'), actualizado_en = datetime(actualizado_en, '-5 hours');
    UPDATE mensajes SET creado_en = datetime(creado_en, '-5 hours');
    UPDATE notas SET creado_en = datetime(creado_en, '-5 hours');
  `);
  db.prepare("INSERT INTO config (clave, valor) VALUES ('tz_migrado_2026_07', '1')").run();
  console.log('[tz] Timestamps existentes corregidos de UTC a hora de Lima (una sola vez).');
}

// Migración de huso horario v2 (2026-07-06, mismo día): el fix de arriba puso
// datetime('now','-5 hours') como DEFAULT de columna, pero CREATE TABLE IF NOT
// EXISTS no toca tablas que ya existían en producción — el DEFAULT viejo (UTC)
// se quedó pegado en el esquema real, así que todo insert nuevo entre el primer
// deploy de este fix y este segundo (INSERT sin especificar creado_en) se
// siguió guardando en UTC. Los INSERT de arriba ahora fijan la hora explícita
// en la query (no dependen del DEFAULT), pero hay que corregir lo que ya quedó
// mal: cualquier fila "en el futuro" respecto a la hora de Lima actual solo
// pudo guardarse así por este bug — se le resta 5 h una sola vez.
if (!db.prepare("SELECT valor FROM config WHERE clave = 'tz_migrado_v2_2026_07'").get()) {
  db.exec(`
    UPDATE leads SET creado_en = datetime(creado_en, '-5 hours') WHERE creado_en > datetime('now', '-5 hours');
    UPDATE leads SET actualizado_en = datetime(actualizado_en, '-5 hours') WHERE actualizado_en > datetime('now', '-5 hours');
    UPDATE mensajes SET creado_en = datetime(creado_en, '-5 hours') WHERE creado_en > datetime('now', '-5 hours');
    UPDATE notas SET creado_en = datetime(creado_en, '-5 hours') WHERE creado_en > datetime('now', '-5 hours');
    UPDATE pagos SET creado_en = datetime(creado_en, '-5 hours') WHERE creado_en > datetime('now', '-5 hours');
  `);
  db.prepare("INSERT INTO config (clave, valor) VALUES ('tz_migrado_v2_2026_07', '1')").run();
  console.log('[tz-v2] Timestamps guardados en UTC por el bug del DEFAULT (tras el primer fix) corregidos a hora de Lima.');
}

// Migración suave del CRM (2026-06-10): agrega columnas si la BD es anterior.
const colsLeads = db.prepare('PRAGMA table_info(leads)').all().map((c) => c.name);
if (!colsLeads.includes('etiquetas')) db.exec('ALTER TABLE leads ADD COLUMN etiquetas TEXT');
// Fecha en que se le mandó el link del grupo (2026-08-16). Es el ÚNICO hecho
// nuevo que se guarda al desarmar la escalera de etapas: todo lo demás
// (relación, frescura) se recomputa de los pagos y los partidos, pero "le
// mandamos el link" no deja rastro en ninguna otra tabla. Fecha, no booleano:
// "se lo mandamos hace tres meses y nunca entró" es una historia distinta a
// "se lo mandamos ayer".
if (!colsLeads.includes('grupo_enviado_en')) db.exec('ALTER TABLE leads ADD COLUMN grupo_enviado_en TEXT');
// proxima_accion / proxima_nota: en desuso desde el 16/08 (ver panel.js). Las
// columnas se quedan —borrarlas en SQLite obliga a rehacer la tabla— pero ya
// no las escribe ni las lee nadie.
if (!colsLeads.includes('proxima_accion')) db.exec('ALTER TABLE leads ADD COLUMN proxima_accion TEXT');
if (!colsLeads.includes('proxima_nota')) db.exec('ALTER TABLE leads ADD COLUMN proxima_nota TEXT');

// Costo de la cancha (2026-08-12): sin esto el panel muestra lo que ENTRA pero
// no lo que queda. El negocio de Clarck es S/15 por jugador menos S/150 de
// cancha; sin el costo, la pantalla del partido cuenta media historia.
const colsSedes = db.prepare('PRAGMA table_info(sedes)').all().map((c) => c.name);
if (!colsSedes.includes('costo')) db.exec('ALTER TABLE sedes ADD COLUMN costo REAL');

// Migración vista Pagos (2026-07-15): medio de pago (yape/plin/bcp/interbank/otro).
// Los pagos anteriores a esta columna eran todos leídos como Yape.
const colsPagos = db.prepare('PRAGMA table_info(pagos)').all().map((c) => c.name);
if (!colsPagos.includes('medio')) db.exec("ALTER TABLE pagos ADD COLUMN medio TEXT DEFAULT 'yape'");
// Cupos (2026-07-15): un solo Yape puede pagar varios cupos (amigos / ambos turnos).
if (!colsPagos.includes('cupos')) db.exec('ALTER TABLE pagos ADD COLUMN cupos INTEGER DEFAULT 1');

// Limpieza (2026-07-15): la IA a veces devolvía el TEXTO "null" y quedaba
// guardado como nombre/distrito real. Se limpia lo existente; updateLead ya
// no deja entrar esos valores.
db.exec(`
  UPDATE leads SET nombre = NULL WHERE lower(trim(nombre)) IN ('null', 'undefined', 'none', '');
  UPDATE leads SET distrito = NULL WHERE lower(trim(distrito)) IN ('null', 'undefined', 'none', '');
`);

// Migración (2026-08-16, una vez): el que ya pagó pasa a "Jugador ⭐". El
// embudo solo avanzaba con datos y con el link del grupo, así que los clientes
// de verdad —los que yapean sin registrarse— quedaban en "Nuevo" para siempre.
//
// QUEDA INERTE desde `relacion_derivada_2026_08` (más abajo): la columna
// `estado` ya no la escribe ni la lee nadie. No se revierte a propósito —
// revertirla sería tocar 265 filas para volver a un valor que igual se ignora,
// y el flag ya está puesto en las bases de producción.
if (!db.prepare("SELECT valor FROM config WHERE clave = 'etapa_por_pago_2026_08'").get()) {
  const r = db.prepare(`
    UPDATE leads SET estado = 'activo'
    WHERE estado != 'activo'
      AND numero IN (SELECT numero FROM pagos WHERE estado = 'confirmado')
  `).run();
  db.prepare("INSERT INTO config (clave, valor) VALUES ('etapa_por_pago_2026_08', '1')").run();
  if (r.changes) console.log(`[etapas] ${r.changes} contactos con pago confirmado pasaron a "Jugador".`);
}

/**
 * Migración (2026-08-16, una vez): se APAGA la escalera de etapas.
 *
 * `estado` metía dos ejes en una sola columna —cuánto sabemos de alguien y qué
 * tan cliente es— y por eso mentía: Luiggi tenía 3 pagos y S/30 y figuraba
 * "Nuevo", y 510 contactos con datos completos que nunca pagaron figuraban más
 * arriba que él. Desde acá la relación y la frescura se DERIVAN de los hechos
 * (pagos, partidos, mensajes) en cada carga, así que no hay nada que mantener a
 * mano y no pueden quedar desactualizadas.
 *
 * De la columna vieja solo se rescatan los dos valores que ningún hecho puede
 * reconstruir:
 *   - `invitado_grupo` → la FECHA en que se le mandó el link (columna nueva).
 *   - `inactivo` → etiqueta `dado-de-baja`: es lo único genuinamente manual de
 *     la escalera (ninguna línea de código lo escribió nunca; si está, lo puso
 *     Clarck a mano y esa decisión no se deduce de ningún pago).
 * El resto se recomputa. `estado` queda congelada en la tabla: nadie la
 * escribe, nadie la lee (borrar una columna en SQLite obliga a rehacer la
 * tabla, y eso sí es un riesgo real sobre la base de producción).
 */
if (!db.prepare("SELECT valor FROM config WHERE clave = 'relacion_derivada_2026_08'").get()) {
  const invitados = db.prepare(`
    UPDATE leads SET grupo_enviado_en = substr(actualizado_en, 1, 10)
    WHERE estado = 'invitado_grupo' AND grupo_enviado_en IS NULL
  `).run().changes;
  // La etiqueta se AGREGA a las que ya tenga (son texto separado por comas):
  // pisarlas borraría notas de Clarck que no están en ningún otro lado.
  const bajas = db.prepare(`
    UPDATE leads SET etiquetas = CASE
        WHEN etiquetas IS NULL OR trim(etiquetas) = '' THEN 'dado-de-baja'
        ELSE etiquetas || ',dado-de-baja' END
    WHERE estado = 'inactivo' AND (etiquetas IS NULL OR etiquetas NOT LIKE '%dado-de-baja%')
  `).run().changes;
  db.prepare("INSERT INTO config (clave, valor) VALUES ('relacion_derivada_2026_08', '1')").run();
  console.log(`[relacion] Etapas apagadas: ${invitados} con fecha de link de grupo · ${bajas} etiquetados "dado-de-baja". La relación ahora se calcula sola.`);
}

const stmtGetLead = db.prepare('SELECT * FROM leads WHERE numero = ?');
// OJO: los DEFAULT de las columnas creado_en/actualizado_en quedaron fijados en
// UTC en las tablas que ya existían en producción (CREATE TABLE IF NOT EXISTS
// no actualiza tablas existentes) — por eso estos INSERT fijan la hora de Lima
// explícita en la query en vez de depender del DEFAULT de la columna.
const stmtNewLead = db.prepare(
  "INSERT INTO leads (numero, creado_en, actualizado_en) VALUES (?, datetime('now', '-5 hours'), datetime('now', '-5 hours'))"
);
const stmtSaveMsg = db.prepare(
  "INSERT INTO mensajes (numero, rol, texto, creado_en) VALUES (?, ?, ?, datetime('now', '-5 hours'))"
);
const stmtHistory = db.prepare(
  'SELECT rol, texto, creado_en FROM mensajes WHERE numero = ? ORDER BY id DESC LIMIT ?'
);

/** Devuelve el lead si existe, sin crearlo (null si no existe). */
function getLead(numero) {
  return stmtGetLead.get(numero) || null;
}

function getOrCreateLead(numero) {
  let lead = stmtGetLead.get(numero);
  if (!lead) {
    stmtNewLead.run(numero);
    lead = stmtGetLead.get(numero);
  }
  return lead;
}

/** Actualiza solo los campos provistos (no pisa datos ya capturados con null).
 *  `estado` NO está en la lista a propósito: la columna quedó congelada el
 *  16/08 (ver migración `relacion_derivada_2026_08`). Cualquier escritura sería
 *  un dato que nadie lee y que volvería a desincronizarse de los hechos. */
function updateLead(numero, campos) {
  const permitidos = ['nombre', 'edad', 'distrito', 'zona', 'handoff', 'handoff_motivo'];
  const sets = [];
  const valores = [];
  for (const campo of permitidos) {
    const v = campos[campo];
    if (v === undefined || v === null) continue;
    // La IA a veces devuelve el TEXTO "null"/"none" — no es un dato real.
    if (typeof v === 'string' && ['null', 'undefined', 'none', ''].includes(v.trim().toLowerCase())) continue;
    sets.push(`${campo} = ?`);
    valores.push(v);
  }
  if (!sets.length) return;
  valores.push(numero);
  db.prepare(`UPDATE leads SET ${sets.join(', ')}, actualizado_en = datetime('now', '-5 hours') WHERE numero = ?`).run(...valores);
}

function saveMessage(numero, rol, texto) {
  stmtSaveMsg.run(numero, rol, texto);
}

/** Últimos N mensajes en orden cronológico (para el contexto del cerebro). */
function getHistory(numero, limite = 12) {
  return stmtHistory.all(numero, limite).reverse();
}

function setHandoff(numero, motivo) {
  updateLead(numero, { handoff: 1, handoff_motivo: motivo || 'sin motivo' });
}

function clearHandoff(numero) {
  db.prepare("UPDATE leads SET handoff = 0, handoff_motivo = NULL, actualizado_en = datetime('now', '-5 hours') WHERE numero = ?").run(numero);
}

/** Borra un contacto completo (leads, mensajes, notas, pagos) — ej. pruebas internas o spam. */
function deleteLead(numero) {
  // Las inscripciones se dan de BAJA antes de borrar al contacto. Si no, su
  // cupo quedaba ocupado por un jugador fantasma —sin nombre y sin ficha— con
  // el pago_id apuntando a un pago recién borrado.
  db.prepare("UPDATE inscripciones SET estado = 'baja' WHERE numero = ? AND estado != 'baja'").run(numero);
  db.prepare('UPDATE inscripciones SET pago_id = NULL WHERE pago_id IN (SELECT id FROM pagos WHERE numero = ?)').run(numero);
  db.prepare('DELETE FROM mensajes WHERE numero = ?').run(numero);
  db.prepare('DELETE FROM notas WHERE numero = ?').run(numero);
  db.prepare('DELETE FROM pagos WHERE numero = ?').run(numero);
  db.prepare('DELETE FROM leads WHERE numero = ?').run(numero);
}

/** Los contactos, con lo que HOY se lee de ellos.
 *  Fuera del SELECT: `estado` (congelada) y proxima_accion/proxima_nota (en
 *  desuso desde el 16/08). Si no se seleccionan, no hay forma de que una vista
 *  nueva las vuelva a mostrar por inercia. */
function listLeads() {
  return db
    .prepare('SELECT numero, nombre, edad, distrito, zona, handoff, handoff_motivo, etiquetas, grupo_enviado_en, creado_en, actualizado_en FROM leads ORDER BY actualizado_en DESC')
    .all();
}

// --- Pagos (Yape + IA) ---------------------------------------------------------
function registrarPago({ numero, monto, titular, numero_operacion, estado, motivo, medio, cupos }) {
  const r = db.prepare(
    "INSERT INTO pagos (numero, monto, titular, numero_operacion, estado, motivo, medio, cupos, creado_en) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '-5 hours'))"
  ).run(numero, monto ?? null, titular || null, numero_operacion || null, estado || 'confirmado', motivo || null, medio || 'yape', cupos || 1);
  // Acá vivía el parche del 16/08 que movía la etapa a 'activo' con cada pago
  // confirmado. Ya no hace falta: la relación se calcula desde esta misma tabla
  // (metricasPorNumero), así que el pago que se acaba de insertar YA cuenta
  // como visita. Un dato derivado no se guarda: se deriva.
  return Number(r.lastInsertRowid);
}

/** Busca un pago YA CONFIRMADO con el mismo número de operación (anti-reenvío). */
function buscarPagoConfirmado(numero_operacion) {
  if (!numero_operacion) return null;
  return db.prepare("SELECT * FROM pagos WHERE numero_operacion = ? AND estado = 'confirmado' LIMIT 1").get(numero_operacion);
}

function listPagos(numero) {
  return db.prepare('SELECT * FROM pagos WHERE numero = ? ORDER BY id DESC').all(numero);
}

/**
 * LA COLA de pagos por revisar — una sola definición para las tres superficies
 * (banner del Resumen, lista de Pagos, Sheet y avisos).
 *
 * Devuelve LA LISTA, no un número: mientras esto contaba y cada pantalla
 * armaba su propia lista, el banner decía 12 y la lista mostraba 3. Quien
 * necesite el número usa `.length`, y así el número y la lista no pueden
 * separarse nunca más.
 *
 * Respeta el punto de arranque: lo anterior al corte es historial, no trabajo
 * de hoy (sigue en la BD, en el CSV y en el Sheet).
 */
function pagosPorRevisar() {
  const corte = getCorte() || '0000-00-00';
  return db.prepare(`
    SELECT p.*, l.nombre, l.zona FROM pagos p LEFT JOIN leads l ON l.numero = p.numero
    WHERE p.estado = 'revisar' AND substr(p.creado_en, 1, 10) >= ?
    ORDER BY p.id DESC
  `).all(corte);
}

// `pagadores()` y `numerosPagadores()` se fueron el 16/08: contaban "cuántos
// pagaron" por su lado, en paralelo a metricasPorNumero. Dos formas de contar
// lo mismo terminan dando números distintos en dos pantallas — y ese fue
// exactamente el problema que se vino a arreglar. La cuenta vive en un solo
// lugar: metricasPorNumero (visitas / pagos / soles).

/** Todos los pagos con los datos del contacto (para la vista Pagos del panel). */
function listPagosTodos() {
  return db.prepare(`
    SELECT p.*, l.nombre, l.zona,
      (SELECT COUNT(*) FROM pagos p2 WHERE p2.numero = p.numero AND p2.estado = 'confirmado') AS pagos_contacto
    FROM pagos p LEFT JOIN leads l ON l.numero = p.numero
    ORDER BY p.id DESC
  `).all();
}

// --- CRM ----------------------------------------------------------------------
/**
 * Deja constancia de que a este contacto ya se le mandó el link del grupo.
 *
 * Reemplaza al viejo `setEstado(numero, 'invitado_grupo')`: aquello movía a la
 * persona de escalón (y por lo tanto BORRABA lo que dijera el escalón anterior
 * — un Jugador que recibía el link "retrocedía" a invitado). Esto solo agrega
 * un hecho, y solo la primera vez: reenviarle el link en septiembre no cambia
 * la fecha en que entró al grupo.
 * @returns {boolean} true si se marcó ahora (false = ya estaba marcado).
 */
function marcarGrupoEnviado(numero, fecha = null) {
  const f = /^\d{4}-\d{2}-\d{2}$/.test(fecha || '') ? fecha : hoyLimaDb();
  return db.prepare(
    "UPDATE leads SET grupo_enviado_en = ?, actualizado_en = datetime('now', '-5 hours') WHERE numero = ? AND grupo_enviado_en IS NULL"
  ).run(f, numero).changes > 0;
}

function setEtiquetas(numero, etiquetas) {
  db.prepare("UPDATE leads SET etiquetas = ?, actualizado_en = datetime('now', '-5 hours') WHERE numero = ?").run(etiquetas || null, numero);
}


function addNota(numero, texto) {
  db.prepare("INSERT INTO notas (numero, texto, creado_en) VALUES (?, ?, datetime('now', '-5 hours'))").run(numero, texto);
}

function getNotas(numero) {
  return db.prepare('SELECT texto, creado_en FROM notas WHERE numero = ? ORDER BY id DESC').all(numero);
}

/** Contactos que escribieron cada día (numero+día distintos) desde una fecha.
 *  Para el gráfico del Resumen: separa nuevos vs recurrentes por día. */
function actividadPorDia(desde) {
  return db.prepare(
    "SELECT DISTINCT substr(creado_en, 1, 10) AS d, numero FROM mensajes WHERE rol = 'user' AND substr(creado_en, 1, 10) >= ?"
  ).all(desde);
}

/** Mapa numero → {rol, en} del ÚLTIMO mensaje (para detectar chats sin responder). */
function ultimosRoles() {
  const rows = db.prepare(
    'SELECT m.numero, m.rol, m.creado_en FROM mensajes m WHERE m.id IN (SELECT MAX(id) FROM mensajes GROUP BY numero)'
  ).all();
  const mapa = {};
  for (const r of rows) mapa[r.numero] = { rol: r.rol, en: r.creado_en };
  return mapa;
}

function stats() {
  return {
    leads: db.prepare('SELECT COUNT(*) AS n FROM leads').get().n,
    // "Con datos" se mide por los DATOS, no por la etapa. Desde que un pago
    // mueve la etapa a 'activo', `estado != 'nuevo'` contaba como registrados a
    // los 265 pagadores que nunca dieron un dato — y eso salía en `kipi estado`
    // y en el correo de respaldo.
    completos: db.prepare("SELECT COUNT(*) AS n FROM leads WHERE nombre IS NOT NULL AND edad IS NOT NULL AND distrito IS NOT NULL").get().n,
    enHandoff: db.prepare('SELECT COUNT(*) AS n FROM leads WHERE handoff = 1').get().n,
    porZona: db.prepare('SELECT zona, COUNT(*) AS n FROM leads WHERE zona IS NOT NULL GROUP BY zona').all(),
  };
}

/** Vuelca el WAL al archivo principal antes de servirlo como backup descargable. */
function checkpoint() {
  db.exec('PRAGMA wal_checkpoint(FULL);');
}

/**
 * Escribe una copia ÍNTEGRA de la BD en `destino` (que no debe existir).
 *
 * VACUUM INTO produce un .db consistente aunque el bot esté escribiendo:
 * copiar el archivo a mano puede salir cortado porque parte de la data está en
 * el WAL. Lo usa el respaldo por correo (src/backup.js).
 */
function snapshot(destino) {
  // El destino lo arma el que llama con mkdtemp, pero escapamos igual: si
  // alguna vez la ruta llega desde afuera, una comilla rompería el SQL.
  db.exec(`VACUUM INTO '${String(destino).replace(/'/g, "''")}'`);
  return destino;
}

/** Totales de pagos confirmados — para el resumen del correo de respaldo. */
function resumenPagos() {
  const r = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(monto), 0) AS s FROM pagos WHERE estado = 'confirmado'").get();
  return { confirmados: r.n, monto: r.s };
}

// --- Configuración del negocio (editable en /admin/leads?vista=config) --------
const CAMPOS_CONFIG = [
  'marca', 'yape_numero', 'yape_titular', 'hora_llegada', 'pago', 'devoluciones',
  'convivencia', 'mecanica', 'bienvenida', 'emojis',
  // Umbrales de frescura: a los cuántos días sin venir un jugador se está
  // enfriando y a los cuántos se dio por perdido (ver umbralesFrescura).
  'dias_frio', 'dias_perdido',
  // Cuántas horas después del pitazo final un partido sigue aceptando un Yape
  // tardío o una inscripción a mano (ver graciaHoras).
  'gracia_horas',
];

// Nombres bonitos de las zonas conocidas; una zona nueva sin entrada acá sale
// capitalizada. LA FUENTE DE VERDAD de qué zonas existen son las SEDES: crear
// una sede en una zona la enciende en todo el sistema (guion del bot, precios,
// links de grupo, formularios) — nada más que enlazar a mano.
const ZONA_NOMBRES = { brena: 'Breña', comas: 'Comas', rimac: 'Rímac', chorrillos: 'Chorrillos' };
function nombreDeZona(z) {
  if (!z) return z;
  // El nombre para mostrar es editable desde Config (clave zonanombre_<slug>);
  // si no existe, el mapa de conocidas; si tampoco, capitalizado.
  const c = db.prepare('SELECT valor FROM config WHERE clave = ?').get(`zonanombre_${z}`);
  return (c && c.valor) || ZONA_NOMBRES[z] || z[0].toUpperCase() + z.slice(1);
}

/** Zonas con al menos una sede (brena/comas siempre, por compatibilidad). */
function zonasOperativas() {
  const deSedes = db.prepare('SELECT DISTINCT zona FROM sedes ORDER BY zona').all().map((r) => r.zona);
  return [...new Set(['brena', 'comas', ...deSedes])];
}

function getConfigMap() {
  const mapa = {};
  for (const r of db.prepare('SELECT clave, valor FROM config').all()) mapa[r.clave] = r.valor;
  return mapa;
}

/** Guarda solo las claves conocidas (evita inyectar claves arbitrarias desde el form). */
function setConfig(campos) {
  const stmt = db.prepare(
    'INSERT INTO config (clave, valor) VALUES (?, ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor'
  );
  // Además de los campos fijos, precio_<zona> y grouplink_<zona> de cualquier
  // zona operativa (dinámicas: siguen a las sedes).
  const permitidas = new Set(CAMPOS_CONFIG);
  for (const z of zonasOperativas()) { permitidas.add(`precio_${z}`); permitidas.add(`grouplink_${z}`); permitidas.add(`zonanombre_${z}`); }
  for (const clave of permitidas) {
    if (campos[clave] !== undefined) stmt.run(clave, campos[clave]);
  }
}

/**
 * Marcadores internos del sistema (última vez que corrió algo, etc.).
 * Van aparte de setConfig, que tiene lista blanca porque lo alimenta un
 * formulario del panel: esto no lo edita nadie a mano.
 */
const getMarca = (clave) => (db.prepare('SELECT valor FROM config WHERE clave = ?').get(`marca_${clave}`) || {}).valor || null;
const setMarca = (clave, valor) => db.prepare(
  'INSERT INTO config (clave, valor) VALUES (?, ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor'
).run(`marca_${clave}`, String(valor));

// ==============================================================================
//  AJUSTES OPERATIVOS — las decisiones de negocio que vivían en Render
// ==============================================================================
/**
 * Hasta el 17/08 cinco decisiones del NEGOCIO vivían en variables de entorno:
 * si el bot atiende a todos, a qué número van los avisos, qué números son de
 * prueba, a qué correo llega cada cosa y cuántas visitas hacen a un "Casero".
 * Todas se cambiaban entrando NOSOTROS a Render — o sea que el dueño del
 * negocio no podía tocar su propio negocio.
 *
 * Desde acá viven en `config` y se editan en el panel. La env var sigue siendo
 * el VALOR INICIAL: si en la BD no hay nada, manda el entorno. Por eso este
 * deploy no cambia absolutamente nada por su cuenta — el primer guardado desde
 * el panel es el que toma el control, y a partir de ahí la BD manda.
 *
 * Se leen POR MENSAJE (no una vez al arrancar, como hacía index.js): un
 * interruptor que necesita un redeploy para surtir efecto no es un interruptor.
 * Son lecturas de UNA fila por sentencia preparada, así que el costo es ruido
 * al lado de una llamada al modelo.
 */
const stmtConfigUno = db.prepare('SELECT valor FROM config WHERE clave = ?');
/** Una clave de config, o null si no está seteada (cadena vacía = no seteada). */
function leerConfig(clave) {
  const r = stmtConfigUno.get(clave);
  const v = r && r.valor != null ? String(r.valor).trim() : '';
  return v === '' ? null : v;
}
const stmtEscribirConfig = db.prepare(
  'INSERT INTO config (clave, valor) VALUES (?, ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor'
);
/** Escribe un ajuste operativo. No pasa por la lista blanca de setConfig (que
 *  alimenta un formulario abierto): acá cada clave tiene su setter con su
 *  validación. */
const escribirConfig = (clave, valor) => stmtEscribirConfig.run(clave, valor == null ? '' : String(valor));
const soloDigitos = (t) => String(t || '').replace(/\D/g, '');

/**
 * ¿El bot está en MODO SEGURO? (silencio para todos menos los números de
 * prueba). Es el interruptor más consecuente del producto: encendido, 934
 * contactos reciben respuestas automáticas.
 */
function modoSeguro() {
  const v = leerConfig('bot_encendido');
  if (v === '1') return false;
  if (v === '0') return true;
  return (process.env.SAFE_MODE || 'true') !== 'false';
}
/** Todo lo que el panel necesita mostrar del interruptor, en un solo objeto. */
function estadoBot() {
  return {
    encendido: !modoSeguro(),
    // 'panel' = lo decidió Clarck desde el panel · 'entorno' = todavía manda SAFE_MODE.
    fuente: leerConfig('bot_encendido') ? 'panel' : 'entorno',
    encendidoEn: leerConfig('bot_encendido_en'),
    apagadoEn: leerConfig('bot_apagado_en'),
    por: leerConfig('bot_cambiado_por'),
  };
}
/**
 * Enciende o apaga el bot. Queda registrado QUIÉN y CUÁNDO: encender es
 * irreversible en la práctica (los mensajes ya salieron), así que tiene que
 * poder auditarse después.
 */
function setBotEncendido(encendido, quien = 'panel') {
  escribirConfig('bot_encendido', encendido ? '1' : '0');
  escribirConfig(encendido ? 'bot_encendido_en' : 'bot_apagado_en', ahoraLima().ts);
  escribirConfig('bot_cambiado_por', quien);
  console.log(`[bot] ${encendido ? 'ENCENDIDO' : 'apagado'} desde ${quien} (${ahoraLima().ts}).`);
  return estadoBot();
}

/**
 * A qué número van los avisos de Clarck (handoffs, pagos, listas de espera).
 *
 * `notify_definido` distingue "todavía no lo tocó nadie" (manda el entorno) de
 * "lo dejó vacío a propósito" (no hay número, los avisos salen solo por
 * correo). Sin esa marca, borrar el campo hacía reaparecer el número viejo de
 * Render y los avisos se iban a un teléfono que Clarck creía haber sacado.
 */
const numeroAvisos = () => (leerConfig('notify_definido')
  ? (leerConfig('notify_numero') || '')
  : (leerConfig('notify_numero') || soloDigitos(process.env.NOTIFY_NUMBER) || ''));
function setNumeroAvisos(numero) {
  const n = soloDigitos(numero);
  escribirConfig('notify_numero', n);
  escribirConfig('notify_definido', '1');
  // Cambiar el número invalida la prueba anterior: el "probado ✔" de otro
  // teléfono no dice nada sobre éste.
  escribirConfig('notify_probado_en', '');
  return n;
}
/** Cuándo se probó por última vez que el número de avisos RECIBE de verdad. */
const avisosProbadoEn = () => leerConfig('notify_probado_en');
const marcarAvisosProbado = () => escribirConfig('notify_probado_en', ahoraLima().ts);

/**
 * Números que el bot SÍ atiende con el modo seguro encendido (el ensayo previo).
 * `testers_definido` distingue "todavía no lo tocó nadie" (manda el entorno) de
 * "lo dejó vacío a propósito" (no hay testers).
 */
function numerosDePrueba() {
  const fuente = leerConfig('testers_definido') ? (leerConfig('testers') || '') : (process.env.ALLOWED_TESTERS || '');
  return fuente.split(',').map(soloDigitos).filter(Boolean);
}
function setNumerosDePrueba(csv) {
  const lista = String(csv || '').split(',').map(soloDigitos).filter(Boolean).slice(0, 10);
  escribirConfig('testers', lista.join(','));
  escribirConfig('testers_definido', '1');
  return lista;
}

/**
 * DOS correos, no uno.
 *
 * Compartían la variable `BACKUP_EMAIL_TO`, y por ahí sale el respaldo COMPLETO
 * de la base: la conversación entera de 900+ personas. Un aviso de "pago por
 * revisar" puede ir a cualquier casilla; el .db no. Por decisión del cliente el
 * default de los dos sigue siendo la casilla de KIPI — lo que cambia es que
 * ahora se ve, y se puede separar sin tocar Render.
 */
const correoAvisos = () => leerConfig('aviso_email') || process.env.AVISO_EMAIL_TO || process.env.BACKUP_EMAIL_TO || process.env.KIPI_EMAIL_USER || '';
const correoRespaldo = () => leerConfig('backup_email') || process.env.BACKUP_EMAIL_TO || process.env.KIPI_EMAIL_USER || '';
const esCorreo = (t) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(t || '').trim());
/** @returns {{ok: boolean, valor: string|null}} valor vacío = "volver al default". */
function setCorreo(cual, valor) {
  const clave = cual === 'respaldo' ? 'backup_email' : 'aviso_email';
  const v = String(valor || '').trim();
  if (v && !esCorreo(v)) return { ok: false, valor: null };
  escribirConfig(clave, v);
  return { ok: true, valor: v || null };
}

/**
 * Contactos derivados a Clarck desde un momento dado — la materia prima del
 * resumen por correo. Se lee de la BD en vez de una cola en memoria: así un
 * reinicio de Render (o un deploy) no se lleva puestos los avisos pendientes.
 */
function handoffsDesde(ts) {
  const corte = getCorte() || '0000-00-00';
  return db.prepare(`
    SELECT numero, nombre, handoff_motivo, actualizado_en
    FROM leads
    WHERE handoff = 1 AND actualizado_en > ? AND substr(actualizado_en, 1, 10) >= ?
    ORDER BY actualizado_en
  `).all(ts || '0000-00-00', corte);
}

/**
 * LOS QUE ESPERAN A CLARCK AHORA — una sola definición, igual que la cola de
 * pagos.
 *
 * "Derivado" y "esperando ahora" son dos cosas distintas: el CRM listaba los
 * 105 handoffs de toda la historia y el Resumen mostraba ese mismo número como
 * si fuera trabajo de hoy. Un derivado de julio que Clarck ya atendió a mano no
 * es una tarea; uno que escribió hace dos horas sí.
 *
 * Activo = derivado + habló en las últimas `horas` + después del punto de
 * arranque. Es la misma condición que ya usaba la lista del CRM, ahora en un
 * solo lugar para que el contador no pueda decir otra cosa.
 */
function handoffsActivos({ horas = 72 } = {}) {
  const corte = getCorte() || '0000-00-00';
  const limite = new Date(Date.now() - 5 * 3600e3 - horas * 3600e3).toISOString().slice(0, 19).replace('T', ' ');
  return db.prepare(`
    SELECT l.numero, l.nombre, l.handoff_motivo, l.actualizado_en, u.en AS ultimo_en
    FROM leads l
    JOIN (SELECT numero, MAX(creado_en) AS en FROM mensajes GROUP BY numero) u ON u.numero = l.numero
    WHERE l.handoff = 1 AND u.en >= ? AND substr(u.en, 1, 10) >= ?
    ORDER BY u.en DESC
  `).all(limite, corte);
}

function listSedes(zona) {
  return zona
    ? db.prepare('SELECT * FROM sedes WHERE zona = ? ORDER BY orden, id').all(zona)
    : db.prepare('SELECT * FROM sedes ORDER BY zona, orden, id').all();
}

function addSede(campos) {
  db.prepare(
    'INSERT INTO sedes (zona, nombre, cancha, cupo, ubicacion, horario, estacionamiento, orden, costo) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(campos.zona, campos.nombre, campos.cancha || null, campos.cupo || null, campos.ubicacion || null, campos.horario || null, campos.estacionamiento || null, campos.orden || 0, campos.costo ?? null);
}

function updateSede(id, campos) {
  db.prepare('UPDATE sedes SET zona=?, nombre=?, cancha=?, cupo=?, ubicacion=?, horario=?, estacionamiento=?, costo=? WHERE id=?')
    .run(campos.zona, campos.nombre, campos.cancha || null, campos.cupo || null, campos.ubicacion || null, campos.horario || null, campos.estacionamiento || null, campos.costo ?? null, id);
}

function deleteSede(id) {
  db.prepare('DELETE FROM sedes WHERE id = ?').run(id);
}

/**
 * EL PRECIO, EN UN SOLO LUGAR.
 *
 * Tres reglas que estaban copiadas en seis archivos: el precio de una zona es
 * un número POSITIVO o no existe (null); el precio de un partido es el suyo
 * propio o, si no tiene, el de su zona; y "no hay precio" nunca se imprime como
 * "S/ 0" ni se usa para validar un monto.
 * @param {string} zona
 * @param {object} [cfg] mapa de config ya leído (para no releerlo por fila)
 * @returns {number|null}
 */
function precioDeZona(zona, cfg = null) {
  const v = Number((cfg || getConfigMap())[`precio_${zona}`]);
  return Number.isFinite(v) && v > 0 ? v : null;
}
/** Lo que se le cobra a un jugador por ESTE partido. null = todavía sin precio. */
function precioDePartido(p, cfg = null) {
  if (!p) return null;
  const propio = Number(p.precio);
  if (Number.isFinite(propio) && propio > 0) return propio;
  return precioDeZona(p.zona, cfg);
}
/** ¿`monto` son N cupos exactos a `precio`? N (1 a 10) o null. */
function cuposPorMonto(monto, precio) {
  if (!(Number(precio) > 0) || monto == null) return null;
  const n = Math.round(Number(monto) / Number(precio));
  return n >= 1 && n <= 10 && Math.abs(Number(monto) - n * Number(precio)) <= 0.5 ? n : null;
}

/** Arma el mismo shape que antes exportaba config/negocio.js, ahora desde la BD.
 *  Las ZONAS son dinámicas: una por cada zona con sedes (ver zonasOperativas). */
function getNegocio() {
  const c = getConfigMap();
  const sedesDe = (zona) => listSedes(zona).map((s) => ({
    nombre: s.nombre, cancha: s.cancha, cupo: s.cupo, ubicacion: s.ubicacion, horario: s.horario, estacionamiento: s.estacionamiento,
  }));
  return {
    marca: c.marca || 'Pichangueros',
    yape: { numero: c.yape_numero || '', titular: c.yape_titular || '', tipo: 'personal' },
    zonas: Object.fromEntries(zonasOperativas().map((z) => [z, {
      nombre: nombreDeZona(z),
      // SIN PRECIO ES null, NO CERO. Con `|| 0` una zona a la que se le guardó
      // el precio vacío hacía que el bot cotizara "S/ 0 por jugador" y que la
      // validación del voucher (`precioEsperado > 0`) se saltara entera: un
      // Yape de S/1 salía confirmado. Cero es un precio; "no hay precio" es
      // otra cosa, y ahora se distinguen.
      precio: precioDeZona(z, c),
      sedes: sedesDe(z),
      groupLink: c[`grouplink_${z}`] || null,
    }])),
    reglas: {
      horaLlegada: c.hora_llegada || '',
      pago: c.pago || '',
      devoluciones: c.devoluciones || '',
      convivencia: c.convivencia || '',
    },
    mecanica: c.mecanica || '',
    bienvenida: c.bienvenida || '',
    emojis: (c.emojis || '').split(',').map((e) => e.trim()).filter(Boolean),
  };
}

// Migración multi-cupo (2026-07-15, una sola vez): los pagos que quedaron
// "revisar" por "monto no coincide" pero que son MÚLTIPLO exacto del precio
// de su zona eran gente pagando varios cupos (amigos / ambos turnos), no un
// error. Se re-confirman con sus cupos y, si el contacto quedó en handoff
// SOLO por esa falsa alarma, se libera para que el bot vuelva a atenderlo.
if (!db.prepare("SELECT valor FROM config WHERE clave = 'multicupo_migrado_2026_07'").get()) {
  const neg = getNegocio();
  const precios = { brena: neg.zonas.brena.precio, comas: neg.zonas.comas.precio };
  const filas = db.prepare(
    "SELECT p.id, p.numero, p.monto, l.zona FROM pagos p JOIN leads l ON l.numero = p.numero WHERE p.estado = 'revisar' AND p.motivo LIKE 'Monto S/%'"
  ).all();
  let n = 0, liberados = 0;
  for (const f of filas) {
    const precio = precios[f.zona];
    if (!precio || !f.monto) continue;
    const c = Math.round(f.monto / precio);
    if (c >= 1 && c <= 10 && Math.abs(f.monto - c * precio) <= 0.5) {
      db.prepare("UPDATE pagos SET estado = 'confirmado', cupos = ?, motivo = NULL WHERE id = ?").run(c, f.id);
      n++;
      const lead = stmtGetLead.get(f.numero);
      if (lead && lead.handoff && /^Monto Yape no (coincide|calza)/.test(lead.handoff_motivo || '')) {
        db.prepare("UPDATE leads SET handoff = 0, handoff_motivo = NULL WHERE numero = ?").run(f.numero);
        liberados++;
      }
    }
  }
  db.prepare("INSERT INTO config (clave, valor) VALUES ('multicupo_migrado_2026_07', '1')").run();
  if (n) console.log(`[multicupo] ${n} pagos "no coincide" re-confirmados como multi-cupo · ${liberados} contactos liberados del handoff.`);
}

// --- Partidos e inscripciones (2026-08-11) -------------------------------------
// El concepto que faltaba: hasta acá el pago se registraba contra el CONTACTO.
// Con esto existe la convocatoria puntual (fecha+zona+cupo) y el pago puede
// cubrir un cupo de un partido concreto. Desbloquea: inscripción por chat,
// lista de espera y asistencia por jugador.
db.exec(`
  CREATE TABLE IF NOT EXISTS partidos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    zona TEXT NOT NULL,                    -- 'brena' | 'comas'
    fecha TEXT NOT NULL,                   -- YYYY-MM-DD (hora de Lima)
    hora TEXT,                             -- texto corto, ej. '8-9pm'
    sede TEXT,                             -- nombre de la sede (texto libre)
    cupo INTEGER NOT NULL DEFAULT 14,
    precio REAL,                           -- NULL → usa el precio de la zona
    estado TEXT NOT NULL DEFAULT 'abierto',-- abierto | cerrado | jugado | cancelado
    creado_en TEXT NOT NULL DEFAULT (datetime('now', '-5 hours'))
  );
  CREATE INDEX IF NOT EXISTS idx_partidos_estado ON partidos(estado, fecha);

  CREATE TABLE IF NOT EXISTS inscripciones (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    partido_id INTEGER NOT NULL,
    numero TEXT,                           -- NULL en cupos de invitados sin WhatsApp propio
    nombre TEXT,                           -- para la lista; si NULL se usa el nombre del lead
    estado TEXT NOT NULL DEFAULT 'reservado', -- reservado | pagado | espera | baja
    asistencia TEXT,                       -- NULL | 'si' | 'no' (se marca tras el partido)
    pago_id INTEGER,                       -- pago que cubrió este cupo
    creado_en TEXT NOT NULL DEFAULT (datetime('now', '-5 hours'))
  );
  CREATE INDEX IF NOT EXISTS idx_insc_partido ON inscripciones(partido_id, estado);
  CREATE INDEX IF NOT EXISTS idx_insc_numero ON inscripciones(numero);

  -- TURNOS (2026-08-17): la unidad real del negocio no es el partido, es
  -- "todos los domingos 6pm en el Politécnico". Hasta hoy eso vivía SOLO en la
  -- cabeza de Clarck, y por eso se vende lo que no está cargado: el 15/08
  -- prometió un domingo 6pm, un jugador pagó S/20 por dos cupos y ese partido
  -- nunca existió. Un turno es la plantilla; los partidos son sus instancias.
  CREATE TABLE IF NOT EXISTS turnos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    zona TEXT NOT NULL,
    sede_id INTEGER,                       -- la cancha (sedes.id); NULL = por definir
    dia_semana INTEGER NOT NULL,           -- 0 domingo … 6 sábado (como strftime('%w'))
    inicio_min INTEGER NOT NULL,           -- minutos desde medianoche (1080 = 6pm)
    duracion_min INTEGER NOT NULL DEFAULT 60,
    cupo INTEGER NOT NULL DEFAULT 14,
    precio REAL,
    activo INTEGER NOT NULL DEFAULT 0,     -- NACE APAGADO: ninguna plantilla se enciende sola
    vigente_desde TEXT,                    -- YYYY-MM-DD (NULL = desde siempre)
    vigente_hasta TEXT,                    -- YYYY-MM-DD (NULL = sin fin)
    nota TEXT,
    creado_en TEXT NOT NULL DEFAULT (datetime('now', '-5 hours'))
  );

  -- "Esta semana no se juega": la excepción es del TURNO en una fecha, así que
  -- saltear un domingo no toca la plantilla ni las demás semanas.
  CREATE TABLE IF NOT EXISTS turno_excepciones (
    turno_id INTEGER NOT NULL,
    fecha TEXT NOT NULL,
    motivo TEXT,
    creado_en TEXT NOT NULL DEFAULT (datetime('now', '-5 hours')),
    PRIMARY KEY (turno_id, fecha)
  );
`);

/**
 * LA FASE DEL PARTIDO SE CALCULA, NO SE GUARDA (2026-08-17).
 *
 * `partidos.estado` contestaba dos preguntas a la vez y por eso no se podía
 * automatizar nada:
 *   1. ¿el bot puede OFRECERLO? → termina cuando el partido EMPIEZA.
 *   2. ¿puede recibir todavía una inscripción o un pago? → termina mucho
 *      después: los Yapes tardíos y la lista a mano ocurren con el partido ya
 *      empezado.
 * "Cerrar" apagaba las dos cosas juntas, así que no se podía cerrar sin perder
 * los pagos que llegan tarde — y por eso había 16 partidos jugados que seguían
 * en 'abierto' con el panel pidiéndole a Clarck que los cerrara a mano.
 *
 * Desde acá `estado` registra SOLO decisiones humanas, y con fecha:
 *   · cancelado_en → "este partido no se juega" (lo dijo él)
 *   · liquidado_en → "ya cobré y pagué la cancha, cerrado" (lo dijo él)
 *   · cierra_en    → "no entra nadie más" (override manual del cierre automático)
 * Todo lo demás —si empezó, si terminó, si todavía admite un Yape— se DERIVA de
 * fecha + hora + ahora, así que no puede quedar desactualizado.
 *
 * La hora deja de ser texto: `inicio_min`/`duracion_min` son el dato, y `hora`
 * pasa a ser el caché de presentación (se sigue imprimiendo en la lista del
 * grupo, en la parrilla del bot, en el prompt, en el Sheet y en los avisos).
 */
const colsPartidos = db.prepare('PRAGMA table_info(partidos)').all().map((c) => c.name);
if (!colsPartidos.includes('cancelado_en')) db.exec('ALTER TABLE partidos ADD COLUMN cancelado_en TEXT');
if (!colsPartidos.includes('liquidado_en')) db.exec('ALTER TABLE partidos ADD COLUMN liquidado_en TEXT');
if (!colsPartidos.includes('cierra_en')) db.exec('ALTER TABLE partidos ADD COLUMN cierra_en TEXT');
if (!colsPartidos.includes('inicio_min')) db.exec('ALTER TABLE partidos ADD COLUMN inicio_min INTEGER');
if (!colsPartidos.includes('duracion_min')) db.exec('ALTER TABLE partidos ADD COLUMN duracion_min INTEGER DEFAULT 60');
// De qué turno salió esta fecha (NULL = lo abrió Clarck a mano).
if (!colsPartidos.includes('turno_id')) db.exec('ALTER TABLE partidos ADD COLUMN turno_id INTEGER');
// La sede por ID además del nombre: el índice anti-duplicado necesita comparar
// canchas, y el nombre en texto ya llegó tipeado de tres formas distintas.
if (!colsPartidos.includes('sede_id')) db.exec('ALTER TABLE partidos ADD COLUMN sede_id INTEGER');

/**
 * EL RELOJ DE LIMA, EN UN SOLO LUGAR.
 *
 * Había cuatro copias de `new Date(Date.now() - 5*3600e3)` repartidas (db.js,
 * panel.js, backup.js, el filtro de vigentes) y cada una se quedaba con un
 * pedazo distinto con `.slice()`: una la fecha, otra la hora ENTERA. Esa última
 * es la que hacía que un turno de 8:30-9:30pm se dejara de ofrecer a las 8:00
 * en punto — comparar por horas enteras pierde los minutos.
 *
 * Perú no mueve la hora en todo el año, así que UTC-5 fijo es exacto y no una
 * aproximación.
 *
 * @returns {{fecha: string, min: number, ts: string}} fecha 'YYYY-MM-DD',
 *   minutos desde medianoche (1080 = 6pm) y timestamp 'YYYY-MM-DD HH:MM:SS'.
 */
function ahoraLima() {
  const iso = new Date(Date.now() - 5 * 3600e3).toISOString();
  return {
    fecha: iso.slice(0, 10),
    min: Number(iso.slice(11, 13)) * 60 + Number(iso.slice(14, 16)),
    ts: `${iso.slice(0, 10)} ${iso.slice(11, 19)}`,
  };
}
const hoyLimaDb = () => ahoraLima().fecha;
/** La fecha de Lima corrida N días (negativo = hacia atrás). */
const fechaLimaDb = (dias = 0) => new Date(Date.now() - 5 * 3600e3 + dias * 86400e3).toISOString().slice(0, 10);

/** 20 → '8', 20 con 30' → '8:30' (sin el am/pm, que lo pone quien llama). */
const en12 = (h, min) => `${h % 12 || 12}${min ? `:${String(min).padStart(2, '0')}` : ''}`;
const meridiano = (h) => (h % 24 < 12 ? 'am' : 'pm');

/**
 * LA HORA COMO DATO: '8-9pm' → { inicio: 1200, duracion: 60 }.
 *
 * Hasta hoy la hora era TEXTO y se volvía a parsear con una regex distinta en
 * cada lugar que la necesitaba (ordenHora, horaInput, normalizarHora), con
 * DURACION_H = 1 asumiendo que todo dura una hora. Costó dos bugs: '20:00'
 * leído como las 8 de la mañana, y '11am-12pm' leído como las 23. Ahora hay UN
 * parser y todos los demás se construyen encima.
 *
 * El meridiano del PRIMER bloque manda; si ese bloque no trae ninguno se usa el
 * del final de la cadena ('8-9pm' → los dos son pm); si no hay ninguno es
 * formato de 24 h ('20:00') y va tal cual.
 *
 * @returns {{inicio: number, duracion: number}|null} minutos desde medianoche.
 */
function parseHora(hora) {
  const t = String(hora || '').trim();
  if (!t) return null;
  const sufFinal = ((/(am|pm)\s*$/i.exec(t) || [])[1] || '').toLowerCase() || null;
  const m1 = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(t);
  if (!m1) return null;
  const a24 = (h, suf) => (suf ? (h % 12) + (suf === 'pm' ? 12 : 0) : Math.min(h, 23));
  const suf1 = (m1[3] || sufFinal || '').toLowerCase() || null;
  const inicio = Math.max(0, Math.min(1439, a24(Number(m1[1]), suf1) * 60 + Number(m1[2] || 0)));

  // Segundo bloque (la hora de fin) si viene: '8-9pm', '20:00-22:00'.
  const m2 = /^\s*[-a–—]\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(t.slice(m1[0].length));
  let duracion = 60;
  if (m2) {
    const suf2 = (m2[3] || sufFinal || '').toLowerCase() || null;
    let d = (a24(Number(m2[1]), suf2) * 60 + Number(m2[2] || 0)) - inicio;
    if (d <= 0) d += 1440; // cruza la medianoche ('11pm-12am')
    // Una pichanga de más de 6 h no existe: es un formato ambiguo ('11-12pm',
    // que quiere decir 11pm a medianoche). Ante la duda, la hora de siempre.
    duracion = d > 0 && d <= 360 ? d : 60;
  }
  return { inicio, duracion };
}

/** 1200 + 60 → '8-9pm'. La cara legible del dato, para jugadores y para Clarck. */
function textoHora(inicio, duracion = 60) {
  if (inicio == null || !Number.isFinite(Number(inicio))) return null;
  const i = ((Math.round(Number(inicio)) % 1440) + 1440) % 1440;
  const f = i + (Number(duracion) > 0 ? Math.round(Number(duracion)) : 60);
  const hI = Math.floor(i / 60) % 24, mI = i % 60;
  const hF = Math.floor(f / 60) % 24, mF = f % 60;
  // Si el turno cruza el mediodía o la medianoche se escriben los dos sufijos
  // ('11am-12pm'); si no, uno solo al final ('8-9pm').
  return meridiano(hI) === meridiano(hF)
    ? `${en12(hI, mI)}-${en12(hF, mF)}${meridiano(hF)}`
    : `${en12(hI, mI)}${meridiano(hI)}-${en12(hF, mF)}${meridiano(hF)}`;
}

/**
 * Deja la hora en el formato que leen los jugadores ('8-9pm').
 *
 * Acepta lo que manda el reloj del navegador ('20:00', '20:00-21:00'), que es
 * como el panel la pide desde el 15/08. Lo que no se entiende se devuelve tal
 * cual: es texto que cargó un humano y borrarlo sería peor que mostrarlo raro.
 */
function normalizarHora(hora) {
  const t = String(hora || '').trim();
  if (!t) return t;
  const h = parseHora(t);
  return h ? textoHora(h.inicio, h.duracion) : t;
}

/** '8-9pm' → '20:00' — para precargar el <input type="time"> del panel. */
function horaInput(hora) {
  const h = parseHora(hora);
  if (!h) return '';
  return `${String(Math.floor(h.inicio / 60)).padStart(2, '0')}:${String(h.inicio % 60).padStart(2, '0')}`;
}

/** '8-9pm' → 20 · '9-10am' → 9. Sin hora, 99: ante la duda nunca se descarta. */
function ordenHora(hora) {
  const h = parseHora(hora);
  return h ? Math.floor(h.inicio / 60) : 99;
}

// Migración (2026-08-11, una vez): normalizar horas ya guardadas ('9pm' → '9-10pm').
if (!db.prepare("SELECT valor FROM config WHERE clave = 'horas_normalizadas_2026_08'").get()) {
  let n = 0;
  for (const p of db.prepare('SELECT id, hora FROM partidos WHERE hora IS NOT NULL').all()) {
    const norm = normalizarHora(p.hora);
    if (norm !== p.hora) { db.prepare('UPDATE partidos SET hora = ? WHERE id = ?').run(norm, p.id); n++; }
  }
  db.prepare("INSERT INTO config (clave, valor) VALUES ('horas_normalizadas_2026_08', '1')").run();
  if (n) console.log(`[horas] ${n} partidos con hora normalizada al formato N-Mpm.`);
}

// Migración (2026-08-11, una vez): partidos cargados por consola llegaron con
// tildes rotas (U+FFFD) en la sede. La tabla sedes está sana → se copia de ahí.
if (!db.prepare("SELECT valor FROM config WHERE clave = 'sedes_mojibake_2026_08'").get()) {
  const n = db.prepare(`
    UPDATE partidos SET sede = (SELECT s.nombre FROM sedes s WHERE s.zona = partidos.zona ORDER BY s.orden, s.id LIMIT 1)
    WHERE sede LIKE '%' || char(65533) || '%'
      AND EXISTS (SELECT 1 FROM sedes s WHERE s.zona = partidos.zona)
  `).run().changes;
  db.prepare("INSERT INTO config (clave, valor) VALUES ('sedes_mojibake_2026_08', '1')").run();
  if (n) console.log(`[mojibake] ${n} partidos con sede rota corregidos desde la tabla sedes.`);
}

// Migración (2026-08-17, una vez): la hora de texto a número. Se rellena
// inicio_min/duracion_min con el MISMO parseo que ya existía, así que nada
// cambia de significado. `hora` NULL → inicio_min NULL: sin hora cargada el
// comportamiento sigue siendo el de siempre (ante la duda, se ofrece).
if (!db.prepare("SELECT valor FROM config WHERE clave = 'hora_en_minutos_2026_08'").get()) {
  let n = 0;
  const set = db.prepare('UPDATE partidos SET inicio_min = ?, duracion_min = ? WHERE id = ?');
  for (const p of db.prepare('SELECT id, hora FROM partidos WHERE hora IS NOT NULL AND inicio_min IS NULL').all()) {
    const h = parseHora(p.hora);
    if (!h) continue;
    set.run(h.inicio, h.duracion, p.id);
    n++;
  }
  db.prepare("INSERT INTO config (clave, valor) VALUES ('hora_en_minutos_2026_08', '1')").run();
  if (n) console.log(`[hora] ${n} partidos con la hora guardada como número (inicio_min).`);
}

// Migración (2026-08-17, una vez): la sede por ID, copiada del nombre que ya
// estaba guardado. Sin esto el índice anti-duplicado no puede comparar canchas.
if (!db.prepare("SELECT valor FROM config WHERE clave = 'partidos_sede_id_2026_08'").get()) {
  const n = db.prepare(`
    UPDATE partidos SET sede_id = (SELECT s.id FROM sedes s WHERE s.zona = partidos.zona AND s.nombre = partidos.sede)
    WHERE sede_id IS NULL AND sede IS NOT NULL
  `).run().changes;
  db.prepare("INSERT INTO config (clave, valor) VALUES ('partidos_sede_id_2026_08', '1')").run();
  if (n) console.log(`[partidos] ${n} partidos enlazados a su cancha por ID.`);
}

/**
 * Migración (2026-08-17, una vez): de la columna `estado` a las tres fechas.
 *
 * Solo se rescata lo que es una DECISIÓN de Clarck; lo demás se recalcula:
 *   · 'cancelado' → cancelado_en   · 'jugado' → liquidado_en
 *   · 'cerrado'   → cierra_en      · 'abierto' → nada que guardar
 *
 * La fecha exacta en que se apretó cada botón no quedó registrada en ningún
 * lado, así que se usa creado_en: lo que importa es QUE se decidió, y que la
 * marca quede en el pasado para que el partido se lea igual que hoy.
 *
 * `estado` NO se limpia: se sigue escribiendo en paralelo (doble escritura) por
 * si hay que revertir el deploy — el código viejo tiene que poder seguir
 * leyendo estos partidos.
 */
if (!db.prepare("SELECT valor FROM config WHERE clave = 'fase_derivada_2026_08'").get()) {
  const cancel = db.prepare("UPDATE partidos SET cancelado_en = creado_en WHERE estado = 'cancelado' AND cancelado_en IS NULL").run().changes;
  const liq = db.prepare("UPDATE partidos SET liquidado_en = creado_en WHERE estado = 'jugado' AND liquidado_en IS NULL").run().changes;
  const cerr = db.prepare("UPDATE partidos SET cierra_en = creado_en WHERE estado = 'cerrado' AND cierra_en IS NULL").run().changes;
  db.prepare("INSERT INTO config (clave, valor) VALUES ('fase_derivada_2026_08', '1')").run();
  if (cancel + liq + cerr) console.log(`[fase] ${cancel} cancelados · ${liq} liquidados · ${cerr} cerrados a mano pasados a fecha. El resto se calcula solo.`);
}

// "2026-08-12" es formato de máquina. Todo lo que ve un humano (mensajes del
// bot, avisos a Clarck, la lista del grupo, el panel) usa esta versión.
const DIAS_SEMANA = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MESES_LARGOS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
/** "2026-08-12" → "miércoles 12 de agosto" (o "HOY miércoles…" / "MAÑANA…"). */
function fechaBonita(ymd, { relativa = true } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd || '')) return ymd || '';
  const dia = DIAS_SEMANA[new Date(`${ymd}T12:00:00-05:00`).getUTCDay()];
  const base = `${dia} ${Number(ymd.slice(8, 10))} de ${MESES_LARGOS[Number(ymd.slice(5, 7)) - 1]}`;
  if (!relativa) return base;
  const hoy = hoyLimaDb();
  if (ymd === hoy) return `HOY ${base}`;
  if (ymd === new Date(Date.now() - 5 * 3600e3 + 86400e3).toISOString().slice(0, 10)) return `MAÑANA ${base}`;
  return base;
}
// Cupos que ocupan lugar en cancha (la espera y las bajas no cuentan).
const OCUPAN = "('reservado','pagado')";

// ==============================================================================
//  LA FASE DEL PARTIDO — derivada de fecha + hora + ahora, nunca guardada
// ==============================================================================

/**
 * GRACIA: cuánto tiempo DESPUÉS del pitazo final un partido sigue aceptando
 * inscripciones y pagos.
 *
 * Es exactamente el requisito de "no autocerramos porque ahí se enganchan los
 * Yapes tardíos", pero escrito como un dato en vez de como una omisión: antes
 * la única forma de no perder esos pagos era no cerrar NUNCA, y eso dejaba 16
 * partidos jugados figurando como si todavía se pudiera entrar.
 *
 * Editable en Config (clave `gracia_horas`): el que sabe cuánto tardan los
 * Yapes de su gente es Clarck, no el código.
 */
const GRACIA_H_DEFAULT = 24;
// Lectura de UNA clave, no del mapa entero: esto se llama una vez por partido
// al calcular la fase, y la vista Partidos pinta la lista completa.
function graciaHoras() {
  const r = db.prepare("SELECT valor FROM config WHERE clave = 'gracia_horas'").get();
  const v = Number(r && r.valor);
  return v > 0 ? Math.min(v, 24 * 14) : GRACIA_H_DEFAULT;
}

/** Un instante como "minutos absolutos" — permite comparar fecha+hora de un tiro. */
const minutosAbs = (fecha, min = 0) => Math.round(Date.parse(`${fecha}T00:00:00Z`) / 60000) + min;
/** 'YYYY-MM-DD HH:MM:SS' → minutos absolutos (los timestamps ya vienen en hora de Lima). */
function tsAbs(ts) {
  const t = String(ts || '');
  if (!/^\d{4}-\d{2}-\d{2}/.test(t)) return null;
  return minutosAbs(t.slice(0, 10), Number(t.slice(11, 13) || 0) * 60 + Number(t.slice(14, 16) || 0));
}
/** Inicio del partido en minutos absolutos. null = sin hora cargada (ante la duda, no se descarta). */
function inicioAbs(p) {
  const ini = p.inicio_min != null ? Number(p.inicio_min) : (parseHora(p.hora) || {}).inicio;
  return ini == null ? null : minutosAbs(p.fecha, ini);
}
/** Fin del partido en minutos absolutos. null si no hay hora. */
function finAbs(p) {
  const ini = inicioAbs(p);
  if (ini == null) return null;
  const dur = Number(p.duracion_min) > 0 ? Number(p.duracion_min) : (parseHora(p.hora) || {}).duracion || 60;
  return ini + dur;
}

/**
 * Por qué este partido YA NO acepta a nadie más — o null si todavía acepta.
 *
 * Devolver el motivo y no un booleano es la mitad del arreglo: el panel decía
 * "no se pudo anotar a nadie", que para Clarck es indistinguible de "está roto".
 * @returns {'cancelado'|'liquidado'|'cerrado'|'muy_viejo'|null}
 */
function motivoCierre(p, ahora = ahoraLima()) {
  if (!p) return 'no_existe';
  if (p.cancelado_en) return 'cancelado';
  if (p.liquidado_en) return 'liquidado';
  const hoyAbs = minutosAbs(ahora.fecha, ahora.min);
  // `cierra_en` es override EN LOS DOS SENTIDOS: adelanta el cierre ("no entra
  // nadie más") y también lo estira. Sin lo segundo, "Reabrir" un partido de la
  // semana pasada no haría nada — volvería a estar vencido en el mismo
  // instante — y no habría forma de completar una lista vieja.
  const cierre = tsAbs(p.cierra_en);
  if (cierre != null) return hoyAbs >= cierre ? 'cerrado' : null;
  // Sin hora cargada, el "fin" es el final de ese día: es lo más tarde que
  // pudo haberse jugado, y de ahí corre la gracia igual.
  const fin = finAbs(p) ?? minutosAbs(p.fecha, 24 * 60);
  return hoyAbs >= fin + graciaHoras() * 60 ? 'muy_viejo' : null;
}

/** ¿Puede entrar todavía una inscripción o un pago? (fin + GRACIA). */
const admiteInscripcion = (p, ahora = ahoraLima()) => motivoCierre(p, ahora) === null;

/** ¿El bot puede OFRECERLO? Termina cuando el partido EMPIEZA, no cuando cierra. */
function ofrecible(p, ahora = ahoraLima()) {
  if (!admiteInscripcion(p, ahora)) return false;
  const ini = inicioAbs(p);
  // Sin hora, se ofrece todo el día: es lo que hacía el filtro viejo (ordenHora
  // devolvía 99 y ninguna hora del día lo superaba).
  if (ini == null) return p.fecha >= ahora.fecha;
  return ini > minutosAbs(ahora.fecha, ahora.min);
}

/** ¿Ya terminó de jugarse? (independiente de si alguien lo canceló o liquidó). */
function yaPaso(p, ahora = ahoraLima()) {
  const fin = finAbs(p);
  if (fin == null) return p.fecha < ahora.fecha;
  return minutosAbs(ahora.fecha, ahora.min) >= fin;
}

/** ¿Está la plata cobrada? (nadie reservado sin pagar). Un partido vacío está saldado. */
function saldado(p) {
  const k = cajaPartido(typeof p === 'object' ? p.id : p);
  return !k || k.porPagar === 0;
}

/**
 * FASES — lo que se muestra. Ninguna se guarda: todas salen de las tres fechas
 * humanas más el reloj.
 */
const FASES = {
  proximo: { label: 'Abierto', corto: 'Abierto', ok: true },
  en_curso: { label: 'En curso', corto: 'Jugándose', ok: true },
  gracia: { label: 'Terminó — todavía entra un Yape', corto: 'Terminó', ok: false },
  por_liquidar: { label: 'Por liquidar', corto: 'Por liquidar', ok: false },
  cerrado: { label: 'Cerrado a mano', corto: 'Cerrado', ok: false },
  liquidado: { label: 'Liquidado ✅', corto: 'Liquidado', ok: false },
  cancelado: { label: 'Cancelado', corto: 'Cancelado', ok: false },
};
function fasePartido(p, ahora = ahoraLima()) {
  const motivo = motivoCierre(p, ahora);
  if (motivo === 'cancelado' || motivo === 'liquidado' || motivo === 'cerrado') return motivo;
  if (motivo === 'muy_viejo') return 'por_liquidar';
  if (ofrecible(p, ahora)) return 'proximo';
  return yaPaso(p, ahora) ? 'gracia' : 'en_curso';
}

// ==============================================================================
//  Alta de partidos
// ==============================================================================

/** El id de la cancha por su nombre dentro de la zona (NULL si no calza ninguna). */
function sedeIdDe(zona, nombre) {
  if (!nombre) return null;
  const s = db.prepare('SELECT id FROM sedes WHERE zona = ? AND nombre = ?').get(zona, String(nombre).trim());
  return s ? s.id : null;
}

/**
 * El gemelo de un partido: misma fecha, misma zona, misma cancha, misma hora.
 * Es la definición de duplicado que sostiene el índice único.
 */
function partidoGemelo({ fecha, zona, sedeId = null, inicioMin = null }) {
  return db.prepare(`
    SELECT * FROM partidos
    WHERE fecha = ? AND zona = ? AND COALESCE(sede_id, -1) = ? AND COALESCE(inicio_min, -1) = ?
    ORDER BY id LIMIT 1
  `).get(fecha, zona, sedeId ?? -1, inicioMin ?? -1) || null;
}

/**
 * Abre un partido — o devuelve el que YA existe.
 *
 * No inserta un gemelo: cargar dos veces el mismo domingo 6pm en el Politécnico
 * partía la lista en dos y hacía que el bot ofreciera cupos de una lista y
 * cobrara en la otra. Cuando ya existe, se devuelve `creado: false` para que el
 * panel diga "ya existe, ábrela" en vez de fingir que abrió uno nuevo.
 *
 * La zona tiene que ser operativa: un partido con zona inválida nace invisible
 * para el bot (no entra en ninguna zona del prompt) y sin precio de referencia.
 *
 * @returns {{id: number|null, creado: boolean, partido: object|null, motivo: string|null}}
 */
function abrirPartido({ zona, fecha, hora, sede, sede_id, cupo, precio, turno_id = null }) {
  if (!zonasOperativas().includes(zona)) return { id: null, creado: false, partido: null, motivo: 'zona_invalida' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha || '')) return { id: null, creado: false, partido: null, motivo: 'fecha_invalida' };

  const h = parseHora(hora);
  const nombreSede = (sede || '').trim() || null;
  const sedeId = sede_id ?? sedeIdDe(zona, nombreSede);

  const previo = partidoGemelo({ fecha, zona, sedeId, inicioMin: h ? h.inicio : null });
  if (previo) return { id: previo.id, creado: false, partido: previo, motivo: 'ya_existe' };

  const r = db.prepare(`
    INSERT INTO partidos (zona, fecha, hora, inicio_min, duracion_min, sede, sede_id, cupo, precio, turno_id, creado_en)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '-5 hours'))
  `).run(
    zona, fecha,
    // `hora` sobrevive como CACHÉ de presentación: se escribe una vez acá y de
    // ahí se imprime en la lista del grupo, en la parrilla del bot, en el
    // prompt, en el Sheet y en los avisos. La fuente es inicio_min.
    h ? textoHora(h.inicio, h.duracion) : (String(hora || '').trim() || null),
    h ? h.inicio : null, h ? h.duracion : 60,
    nombreSede, sedeId, cupo || 14, precio ?? null, turno_id,
  );
  const id = Number(r.lastInsertRowid);
  return { id, creado: true, partido: getPartido(id), motivo: null };
}

/**
 * Crea un partido y devuelve su id (o el del gemelo que ya existía).
 * Sigue devolviendo un ENTERO: es la firma que usan los tests y el resto del
 * sistema. Quien necesite saber si de verdad lo creó usa `abrirPartido`.
 * @returns {number|null} el id, o null si la zona/fecha no son válidas.
 */
function crearPartido(campos) {
  return abrirPartido(campos).id;
}

function getPartido(id) {
  return db.prepare('SELECT * FROM partidos WHERE id = ?').get(id) || null;
}

/**
 * Corregir un partido ya creado: hora, sede, cupo, precio, fecha o zona.
 *
 * Hasta ahora un partido se podía abrir, cerrar, cancelar y borrar, pero no
 * ARREGLAR: si la hora salió mal o cambió la cancha, la única salida era
 * cancelar y rehacer — y eso deja a los inscritos afuera. De ahí venían los
 * "Cancelado" vacíos de Rímac y Chorrillos.
 *
 * El cupo no puede quedar por debajo de la gente que ya está adentro: sería
 * dejar a alguien fuera de la lista sin decírselo a nadie. Se rechaza con el
 * motivo para poder mostrarlo, en vez de recortar en silencio.
 *
 * @returns {{ok: true}|{ok: false, motivo: string}}
 */
function actualizarPartido(id, campos) {
  const p = getPartido(id);
  if (!p) return { ok: false, motivo: 'El partido ya no existe.' };

  const ocupados = db.prepare(
    `SELECT COUNT(*) AS n FROM inscripciones WHERE partido_id = ? AND estado IN ${OCUPAN}`
  ).get(id).n;

  const sets = [];
  const valores = [];
  const poner = (col, v) => { sets.push(`${col} = ?`); valores.push(v); };

  if (campos.zona && zonasOperativas().includes(campos.zona)) poner('zona', campos.zona);
  if (/^\d{4}-\d{2}-\d{2}$/.test(campos.fecha || '')) poner('fecha', campos.fecha);
  // Guardar el editor con la hora VACÍA dejaba hora=NULL, y un partido sin hora
  // se ofrece TODO EL DÍA (ofrecible() no tiene con qué compararse) y se sigue
  // ofreciendo a las 11 de la noche. Un campo que quedó en blanco no es una
  // orden de borrar la hora: se ignora y se avisa (`hora_vacia`).
  let horaIgnorada = false;
  if (campos.hora !== undefined) {
    const texto = String(campos.hora || '').trim();
    if (!texto) {
      horaIgnorada = Boolean(p.hora || p.inicio_min != null);
    } else {
      // La hora entra como texto (reloj del panel) y sale como TRES columnas: el
      // número que manda (inicio_min), cuánto dura, y el texto legible que se
      // imprime en la lista del grupo y en los mensajes del bot.
      const h = parseHora(texto);
      poner('hora', h ? textoHora(h.inicio, h.duracion) : texto);
      poner('inicio_min', h ? h.inicio : null);
      poner('duracion_min', h ? h.duracion : 60);
    }
  }
  if (campos.sede !== undefined) {
    const nombre = (campos.sede || '').trim() || null;
    poner('sede', nombre);
    poner('sede_id', sedeIdDe(campos.zona || p.zona, nombre));
  }
  if (campos.cupo != null && campos.cupo !== '') {
    const cupo = Math.max(2, Math.min(60, Number(campos.cupo) || p.cupo));
    if (cupo < ocupados) {
      return { ok: false, motivo: `No se puede bajar el cupo a ${cupo}: ya hay ${ocupados} jugadores adentro. Da de baja a alguien primero.` };
    }
    poner('cupo', cupo);
  }
  if (campos.precio !== undefined) poner('precio', campos.precio === '' || campos.precio == null ? null : Number(campos.precio));

  if (!sets.length) return { ok: false, motivo: 'No cambiaste nada.' };

  // Corregir la hora o la fecha puede dejar el partido encima de otro que ya
  // existe. Se avisa en vez de dejar que reviente el índice único: el mensaje
  // de SQLite ("UNIQUE constraint failed") no le dice nada a nadie.
  const nuevo = { ...p };
  sets.forEach((s, i) => { nuevo[s.split(' ')[0]] = valores[i]; });
  const choque = partidoGemelo({ fecha: nuevo.fecha, zona: nuevo.zona, sedeId: nuevo.sede_id, inicioMin: nuevo.inicio_min });
  if (choque && choque.id !== id) {
    return { ok: false, motivo: `Ya hay otro partido ese día a esa hora en la misma cancha (#${choque.id}). Ábrelo en vez de duplicarlo.` };
  }

  db.prepare(`UPDATE partidos SET ${sets.join(', ')} WHERE id = ?`).run(...valores, id);
  return { ok: true, horaIgnorada };
}

/** Borra un partido SIN inscripciones (errores de carga, duplicados).
 *  Si tiene gente adentro no se toca: para eso está "cancelar". */
function eliminarPartido(id) {
  const n = db.prepare('SELECT COUNT(*) AS n FROM inscripciones WHERE partido_id = ?').get(id).n;
  if (n > 0) return false;
  db.prepare('DELETE FROM partidos WHERE id = ?').run(id);
  return true;
}

/**
 * DECISIONES HUMANAS sobre un partido. Son las únicas cuatro cosas que se
 * GUARDAN: todo lo demás (si empezó, si terminó, si todavía entra un Yape) se
 * calcula.
 *
 * `estado` se sigue escribiendo EN PARALELO con el valor equivalente del enum
 * viejo. No es redundancia por gusto: si hay que revertir el deploy, el código
 * anterior tiene que poder seguir leyendo estos partidos sin quedarse con 200
 * filas que no sabe interpretar. Es requisito de la transición, no un adorno.
 */
const marcar = (id, columna, valor, estadoViejo) =>
  db.prepare(`UPDATE partidos SET ${columna} = ?, estado = ? WHERE id = ?`).run(valor, estadoViejo, id).changes > 0;

/** "Este partido no se juega". Nadie recibe aviso automático: eso lo hace él. */
const cancelarPartido = (id) => marcar(id, 'cancelado_en', ahoraLima().ts, 'cancelado');

/** "No entra nadie más" — override manual del cierre automático (fin + gracia). */
const cerrarInscripcion = (id) => marcar(id, 'cierra_en', ahoraLima().ts, 'cerrado');

/**
 * LIQUIDAR: "ya cobré, ya pagué la cancha, este partido está cerrado".
 *
 * Es lo que antes se llamaba "cerrar" y no compraba nada. Nunca es automático:
 * liquidar es una AFIRMACIÓN sobre plata que solo puede hacer un humano.
 */
function liquidarPartido(id) {
  const p = getPartido(id);
  if (!p) return { ok: false, motivo: 'no_existe' };
  if (p.liquidado_en) return { ok: false, motivo: 'ya_liquidado' };
  db.prepare("UPDATE partidos SET liquidado_en = ?, estado = 'jugado' WHERE id = ?").run(ahoraLima().ts, id);
  return { ok: true, caja: cajaPartido(id) };
}

/**
 * Deshace las tres marcas: el partido vuelve a la vida.
 *
 * Si YA se jugó, reabrir no lo devuelve al futuro: le da otra ventana de gracia
 * para terminar de cobrar o completar la lista. Sin eso el botón no haría nada
 * visible sobre un partido de la semana pasada — quedaría vencido en el mismo
 * instante en que se reabre.
 */
function reabrirPartido(id) {
  const p = getPartido(id);
  if (!p) return false;
  const extender = yaPaso(p)
    ? new Date(Date.now() - 5 * 3600e3 + graciaHoras() * 3600e3).toISOString().slice(0, 19).replace('T', ' ')
    : null;
  return db.prepare(
    "UPDATE partidos SET cancelado_en = NULL, liquidado_en = NULL, cierra_en = ?, estado = 'abierto' WHERE id = ?"
  ).run(extender, id).changes > 0;
}

/**
 * Compatibilidad con el enum viejo: index.js, los tests y cualquier código que
 * todavía piense en estados siguen funcionando, pero por debajo se escriben las
 * fechas. Se mantiene a propósito durante la transición.
 */
function setEstadoPartido(id, estado) {
  if (estado === 'abierto') return void reabrirPartido(id);
  if (estado === 'cerrado') return void cerrarInscripcion(id);
  if (estado === 'jugado') return void liquidarPartido(id);
  if (estado === 'cancelado') return void cancelarPartido(id);
}

/**
 * La caja de UN partido: lo cobrado, lo que falta cobrar y lo que cuesta la
 * cancha. Es la cuenta que Clarck hace de memoria antes de cada pichanga
 * (S/15 por jugador menos S/150 de cancha ≈ S/60 de ganancia) y que hasta ahora
 * el panel no mostraba: se veía cuánta gente hay, no si el partido deja algo.
 *
 * Los pagos se suman con DISTINCT: un solo Yape puede cubrir varios cupos y
 * queda enganchado a varias inscripciones — sin eso, pagar por dos amigos
 * inflaba la caja al doble.
 */
function cajaPartido(id) {
  const p = getPartido(id);
  if (!p) return null;
  // El precio sale de precioDePartido (el suyo, o el de su zona) — la misma
  // función que usan el bot, la lista del grupo y la validación del voucher.
  // Acá cae a 0 a propósito: una caja tiene que ser un número aunque falte el
  // precio (antes salía NaN entera y no se veía ni lo cobrado).
  const precio = precioDePartido(p) ?? 0;

  const verificado = db.prepare(`
    SELECT COALESCE(SUM(monto), 0) AS s FROM pagos WHERE estado = 'confirmado' AND id IN (
      SELECT DISTINCT pago_id FROM inscripciones WHERE partido_id = ? AND pago_id IS NOT NULL
    )`).get(id).s;

  // Cobrado A MANO: el botón "💰 Pagó" del panel marca la inscripción como
  // pagada pero no le engancha ningún pago, así que esa plata no entraba en
  // `cobrado` (que suma vouchers) NI en `porCobrar` (que cuenta reservados):
  // desaparecía de las dos columnas. La caja decía "faltan S/150" con el
  // partido cobrado entero — y es el recuadro que Clarck mira en la cancha.
  const aMano = db.prepare(
    "SELECT COUNT(*) AS n FROM inscripciones WHERE partido_id = ? AND estado = 'pagado' AND pago_id IS NULL"
  ).get(id).n;

  const porPagar = db.prepare(
    "SELECT COUNT(*) AS n FROM inscripciones WHERE partido_id = ? AND estado = 'reservado'"
  ).get(id).n;

  // El costo va por sede (una cancha de Comas no cuesta lo que una de Breña).
  // Si el nombre guardado en el partido no calza con ninguna sede —porque se
  // renombró la cancha, o se tipeó distinto— se cae al costo de la sede de esa
  // zona antes que quedarse sin dato: el Resumen decía "cancha sin costo" y en
  // Ajustes el costo estaba puesto, una tarea imposible de cerrar.
  const sede = (p.sede
    ? db.prepare('SELECT costo FROM sedes WHERE zona = ? AND nombre = ?').get(p.zona, p.sede)
    : null)
    || db.prepare('SELECT costo FROM sedes WHERE zona = ? AND costo IS NOT NULL ORDER BY orden, id LIMIT 1').get(p.zona);

  const precioNum = Number(precio) || 0;
  return {
    precio,
    cobrado: verificado + aMano * precioNum,
    cobradoVerificado: verificado,
    cobradoAMano: aMano * precioNum,
    porCobrar: porPagar * precioNum,
    porPagar,
    costoCancha: sede && sede.costo != null ? Number(sede.costo) : null,
  };
}

/**
 * VISITAS: la métrica única de "cuántas veces vino este jugador".
 *
 * Antes esto se contaba SOLO con inscripciones a partidos pasados. La tabla
 * `partidos` nació el 10/08 y tiene 17 filas; los ~400 pagos vienen de julio,
 * cuando no existía el concepto de partido. Resultado: el filtro "Recurrentes"
 * y el badge "N partidos" estaban estructuralmente VACÍOS para todos — no
 * porque nadie sea recurrente, sino porque su historia no estaba en esa tabla.
 *
 * Una VISITA es UN DÍA en que el jugador vino. Se arma uniendo dos fuentes:
 *   - días con pago confirmado (la historia larga: julio en adelante),
 *   - días de partidos pasados con inscripción viva (la historia nueva).
 * `UNION` y no `UNION ALL` a propósito: el mismo día contado por las dos
 * fuentes —el caso normal desde agosto, donde el Yape ya se engancha a un
 * partido— es UNA visita, no dos.
 *
 * Y se cuentan DÍAS, no cupos: un Yape de S/30 por dos cupos es una persona
 * que vino con un amigo, no dos visitas suyas. `pagos` y `soles` sí cuentan
 * los vouchers, que es otra pregunta ("cuánto ha dejado").
 *
 * Dos consultas para toda la lista (no una por contacto): la vista Jugadores
 * pinta cientos de filas.
 *
 * @returns {Object<string, {visitas:number, ultima:string|null, pagos:number, soles:number}>}
 */
/**
 * Cuántas visitas hacen a un "Casero". Era una constante en este archivo —o
 * sea, una regla del negocio de Clarck que solo podíamos cambiar nosotros.
 *
 * Con los datos reales el tope son 5 visitas y el umbral 6: el filtro "Caseros"
 * muestra CERO y siempre va a mostrar cero hasta que alguien venga una sexta
 * vez. Editable en Ajustes para que pueda bajarlo y ver a su gente.
 */
const RECURRENTE_DEFAULT = 6; // "más de 5" (definición de Clarck, 12-ago)
function recurrenteDesde() {
  const v = Number(leerConfig('recurrente_desde'));
  return Number.isFinite(v) && v >= 2 && v <= 50 ? Math.round(v) : RECURRENTE_DEFAULT;
}
const setRecurrenteDesde = (n) => {
  const v = Math.max(2, Math.min(50, Math.round(Number(n) || RECURRENTE_DEFAULT)));
  escribirConfig('recurrente_desde', String(v));
  return v;
};
function metricasPorNumero() {
  const visitas = db.prepare(`
    SELECT numero, COUNT(*) AS visitas, MAX(dia) AS ultima FROM (
      SELECT numero, substr(creado_en, 1, 10) AS dia
        FROM pagos WHERE estado = 'confirmado' AND numero IS NOT NULL
      UNION
      SELECT i.numero AS numero, p.fecha AS dia
        FROM inscripciones i JOIN partidos p ON p.id = i.partido_id
        WHERE i.numero IS NOT NULL AND i.estado != 'baja'
          AND p.cancelado_en IS NULL AND p.fecha < date('now', '-5 hours')
    ) GROUP BY numero
  `).all();
  const plata = db.prepare(`
    SELECT numero, COUNT(*) AS pagos, COALESCE(SUM(monto), 0) AS soles
    FROM pagos WHERE estado = 'confirmado' AND numero IS NOT NULL GROUP BY numero
  `).all();

  const mapa = {};
  for (const v of visitas) mapa[v.numero] = { visitas: v.visitas, ultima: v.ultima, pagos: 0, soles: 0 };
  for (const p of plata) {
    const m = mapa[p.numero] || (mapa[p.numero] = { visitas: 0, ultima: null, pagos: 0, soles: 0 });
    m.pagos = p.pagos;
    m.soles = Number(p.soles) || 0;
  }
  return mapa;
}
/** Métricas de UN contacto (misma definición que la versión batch). */
const SIN_METRICAS = { visitas: 0, ultima: null, pagos: 0, soles: 0 };
const metricasDe = (numero) => metricasPorNumero()[numero] || { ...SIN_METRICAS };

/**
 * RELACIÓN: qué tan cliente es alguien. Se DERIVA de las visitas, no se guarda
 * —por eso no se puede desactualizar y no hay ningún botón que apretar.
 */
// `largo` y `desde` del tramo de arriba se calculan: el umbral del Casero lo
// pone Clarck en Ajustes, así que escribirlo a mano acá volvería a mentir en
// cuanto lo cambie.
const RELACIONES = {
  nuevo: { label: 'Nuevo', largo: 'Nunca pagó', desde: 0 },
  probo: { label: 'Probó', largo: 'Vino una vez', desde: 1 },
  vuelve: { label: 'Vuelve', get largo() { return `Volvió (2 a ${recurrenteDesde() - 1} visitas)`; }, desde: 2 },
  casero: { label: 'Casero', get largo() { return `Casero (${recurrenteDesde()}+ visitas)`; }, get desde() { return recurrenteDesde(); } },
};
function relacionDe(visitas = 0) {
  const v = Number(visitas) || 0;
  if (v >= recurrenteDesde()) return 'casero';
  if (v >= 2) return 'vuelve';
  if (v >= 1) return 'probo';
  return 'nuevo';
}

/**
 * FRESCURA: hace cuánto no se sabe nada de él. También derivada.
 *
 * Los dos umbrales viven en `config` (dias_frio / dias_perdido) como los
 * precios y los links: el ritmo de una pichanga semanal no es el de una
 * quincenal, y eso lo sabe Clarck, no el código.
 */
const FRIO_DEFAULT = 21;      // ~3 semanas sin venir: todavía se recupera
const PERDIDO_DEFAULT = 45;   // mes y medio: ya se fue a otra pichanga
function umbralesFrescura() {
  const c = getConfigMap();
  const frio = Number(c.dias_frio) > 0 ? Math.round(Number(c.dias_frio)) : FRIO_DEFAULT;
  // El segundo umbral tiene que estar DESPUÉS del primero: si Clarck los
  // invierte sin querer, "Enfriándose" se quedaría sin ningún día adentro.
  const perdido = Number(c.dias_perdido) > 0 ? Math.round(Number(c.dias_perdido)) : PERDIDO_DEFAULT;
  return { frio, perdido: Math.max(perdido, frio + 1) };
}
const FRESCURAS = {
  al_dia: { label: 'Al día', corto: 'Al día' },
  enfriando: { label: 'Enfriándose', corto: 'Frío' },
  perdido: { label: 'Perdido', corto: 'Perdido' },
};
/** Días enteros entre una fecha (o timestamp) y hoy en Lima. null si no hay fecha. */
function diasDesde(fecha) {
  const d = String(fecha || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  return Math.max(0, Math.round((Date.parse(`${hoyLimaDb()}T00:00:00Z`) - Date.parse(`${d}T00:00:00Z`)) / 86400e3));
}
/** @param {number|null} dias @param {{frio:number,perdido:number}} [um] */
function frescuraDe(dias, um = null) {
  if (dias == null) return null;
  const { frio, perdido } = um || umbralesFrescura();
  if (dias <= frio) return 'al_dia';
  if (dias <= perdido) return 'enfriando';
  return 'perdido';
}

/** Todos los partidos con sus conteos (para el panel), próximos primero.
 *  Cada fila trae su FASE ya calculada: la pantalla no tiene que volver a
 *  deducirla (y no puede deducirla distinto que el bot, que era el problema). */
function listPartidos() {
  const ahora = ahoraLima();
  return db.prepare(`
    SELECT p.*,
      (SELECT COUNT(*) FROM inscripciones i WHERE i.partido_id = p.id AND i.estado IN ${OCUPAN}) AS ocupados,
      (SELECT COUNT(*) FROM inscripciones i WHERE i.partido_id = p.id AND i.estado = 'pagado') AS pagados,
      (SELECT COUNT(*) FROM inscripciones i WHERE i.partido_id = p.id AND i.estado = 'espera') AS en_espera
    FROM partidos p ORDER BY p.fecha DESC, p.inicio_min DESC, p.id DESC
  `).all().map((p) => ({ ...p, fase: fasePartido(p, ahora) }));
}

/**
 * Partidos con inscripción abierta.
 *
 * Dos recortes distintos, porque "todavía sirve" significa dos cosas:
 *
 * - `vigentes: true` → los que AÚN NO EMPEZARON (ofrecible). Es lo que se le
 *   OFRECE al jugador. El 15/08 a las 10:40 el bot ofrecía "Breña 9am y 10am,
 *   Comas 9am": los tres habían arrancado, porque acá solo se filtraba por
 *   FECHA.
 * - `+ incluirEnCurso: true` → los que aún NO TERMINARON. Es lo que puede
 *   recibir un PAGO AUTOMÁTICO: el Yape que entra 8:05pm es del partido de
 *   8-9pm que ya arrancó, y tiene que engancharse ahí. Ojo: acá NO corre la
 *   gracia de 24 h — el 15/08 Anthony yapeó a las 11:07 y el único candidato de
 *   Comas era el de ese día 9-10am, terminado hacía una hora, donde quedaron él
 *   y su invitado. La gracia es para lo que decide un humano (inscribir a mano,
 *   asignar un pago suelto), no para que el sistema adivine hacia atrás.
 *
 * Sin ninguna de las dos, la lista completa de los que siguen vivos: la usa el
 * panel (Clarck necesita el partido en curso para pasar lista).
 */
function partidosAbiertos(zona = null, { vigentes = false, incluirEnCurso = false } = {}) {
  const ahora = ahoraLima();
  const filas = db.prepare(`
    SELECT p.*,
      (SELECT COUNT(*) FROM inscripciones i WHERE i.partido_id = p.id AND i.estado IN ${OCUPAN}) AS ocupados
    FROM partidos p
    WHERE p.cancelado_en IS NULL AND p.liquidado_en IS NULL AND p.fecha >= ? ${zona ? 'AND p.zona = ?' : ''}
    ORDER BY p.fecha, p.id
  `).all(...(zona ? [ahora.fecha, zona] : [ahora.fecha]));
  const lista = filas
    .map((p) => ({ ...p, restante: Math.max(0, p.cupo - p.ocupados) }))
    // Dentro del día, por hora de inicio (la BD solo ordena por fecha e id).
    // Con los minutos adentro: 8:30pm ya no empata con 8:00pm.
    .sort((a, b) => (a.fecha === b.fecha
      ? (inicioAbs(a) ?? Infinity) - (inicioAbs(b) ?? Infinity)
      : (a.fecha < b.fecha ? -1 : 1)));
  // Sin filtro se devuelven todos los que no están cancelados ni liquidados,
  // incluido el cerrado a mano: el panel lo necesita para pasar lista.
  if (!vigentes) return lista;
  if (!incluirEnCurso) return lista.filter((p) => ofrecible(p, ahora));
  return lista.filter((p) => admiteInscripcion(p, ahora) && !yaPaso(p, ahora));
}

function inscripcionesDe(partidoId) {
  return db.prepare(`
    SELECT i.*, l.nombre AS lead_nombre, l.zona AS lead_zona
    FROM inscripciones i LEFT JOIN leads l ON l.numero = i.numero
    WHERE i.partido_id = ?
    ORDER BY CASE i.estado WHEN 'pagado' THEN 0 WHEN 'reservado' THEN 1 WHEN 'espera' THEN 2 ELSE 3 END, i.id
  `).all(partidoId);
}

/** Inscripción activa (reservado/pagado/espera) de un número en un partido. */
function inscripcionActiva(partidoId, numero) {
  return db.prepare(
    "SELECT * FROM inscripciones WHERE partido_id = ? AND numero = ? AND estado != 'baja' LIMIT 1"
  ).get(partidoId, numero) || null;
}

/**
 * Inscribe un cupo. Si el partido está lleno entra como 'espera'.
 * Idempotente por número: si ya tiene inscripción activa, la devuelve tal cual.
 *
 * YA NO MIRA EL ENUM. Mira si el partido todavía admite gente: no cancelado, no
 * liquidado, no cerrado a mano, y dentro de la gracia (fin + 24 h). Eso es lo
 * que hace que un Yape que llega a las 11 de la noche de un partido de las 8
 * todavía tenga dónde engancharse, sin necesidad de dejar el partido "abierto"
 * para siempre.
 *
 * Devuelve SIEMPRE el motivo: `lleno` acompaña a la lista de espera (no es un
 * fallo, es una explicación), y `cancelado` / `liquidado` / `cerrado` /
 * `muy_viejo` explican por qué no entró nadie. Sin eso el panel solo podía
 * decir "no se pudo anotar a nadie", que para Clarck es indistinguible de
 * "está roto".
 *
 * @returns {{inscripcion: object|null, resultado: 'reservado'|'espera'|'pagado'|'ya_inscrito'|null, motivo: string|null}}
 */
function inscribir(partidoId, numero, { nombre = null, estado = null, pagoId = null } = {}) {
  const p = getPartido(partidoId);
  if (!p) return { inscripcion: null, resultado: null, motivo: 'no_existe' };
  const cerrado = motivoCierre(p);
  if (cerrado) return { inscripcion: null, resultado: null, motivo: cerrado };
  if (numero) {
    const previa = inscripcionActiva(partidoId, numero);
    if (previa) return { inscripcion: previa, resultado: 'ya_inscrito', motivo: 'ya_inscrito' };
  }
  const ocupados = db.prepare(`SELECT COUNT(*) AS n FROM inscripciones WHERE partido_id = ? AND estado IN ${OCUPAN}`).get(partidoId).n;
  const lleno = ocupados >= p.cupo;
  const final = estado || (lleno ? 'espera' : 'reservado');
  // Con la cancha llena, TODO lo que ocupa lugar cae a espera — no solo
  // 'pagado'. El guard miraba únicamente ese estado, así que un
  // `estado: 'reservado'` explícito (el camino del panel y de los invitados)
  // se saltaba el cupo y metía 15 jugadores en 14. La misma regla que ya
  // cuidaban setEstadoInscripcion y pagarInscripcion.
  const estadoFinal = lleno && ['reservado', 'pagado'].includes(final) ? 'espera' : final;
  const r = db.prepare(
    "INSERT INTO inscripciones (partido_id, numero, nombre, estado, pago_id, creado_en) VALUES (?, ?, ?, ?, ?, datetime('now', '-5 hours'))"
  ).run(partidoId, numero || null, nombre || null, estadoFinal, pagoId ?? null);
  const insc = db.prepare('SELECT * FROM inscripciones WHERE id = ?').get(Number(r.lastInsertRowid));
  return { inscripcion: insc, resultado: insc.estado, motivo: lleno ? 'lleno' : null };
}

/** Cuántos cupos ocupa hoy un partido (reservados + pagados). */
function ocupadosDe(partidoId) {
  return db.prepare(`SELECT COUNT(*) AS n FROM inscripciones WHERE partido_id = ? AND estado IN ${OCUPAN}`).get(partidoId).n;
}

/**
 * Cambia el estado de una inscripción.
 *
 * Pasar a 'reservado' o 'pagado' OCUPA un lugar en la cancha, así que se
 * verifica el cupo: era un UPDATE pelado y subir a alguien de la lista de
 * espera con la cancha llena metía 15 jugadores en 14. `inscribir` y
 * `vincularPago` ya cuidaban esto; este camino —el botón del panel— no.
 *
 * @returns {{inscripcion: object|null, motivo: string|null}} motivo='lleno' si
 *   no entraba: el panel necesita poder explicar por qué no pasó nada.
 */
function setEstadoInscripcion(id, estado) {
  if (!['reservado', 'pagado', 'espera', 'baja'].includes(estado)) return { inscripcion: null, motivo: 'estado_invalido' };
  const actual = db.prepare('SELECT * FROM inscripciones WHERE id = ?').get(id);
  if (!actual) return { inscripcion: null, motivo: 'no_existe' };
  const ocupaAhora = ['reservado', 'pagado'].includes(actual.estado);
  const vaAOcupar = ['reservado', 'pagado'].includes(estado);
  if (vaAOcupar && !ocupaAhora) {
    const p = getPartido(actual.partido_id);
    if (p && ocupadosDe(actual.partido_id) >= p.cupo) return { inscripcion: actual, motivo: 'lleno' };
  }
  db.prepare('UPDATE inscripciones SET estado = ? WHERE id = ?').run(estado, id);
  return { inscripcion: db.prepare('SELECT * FROM inscripciones WHERE id = ?').get(id), motivo: null };
}

/**
 * Da de baja un cupo y promueve al primero de la lista de espera (si hay).
 * @returns {object|null} la inscripción promovida (para avisarle), o null.
 */
function darDeBaja(id) {
  const insc = db.prepare('SELECT * FROM inscripciones WHERE id = ?').get(id);
  if (!insc || insc.estado === 'baja') return null;
  db.prepare("UPDATE inscripciones SET estado = 'baja' WHERE id = ?").run(id);
  if (!['reservado', 'pagado'].includes(insc.estado)) return null; // una espera que se baja no libera cancha
  // Prioridad al promover: primero los de la espera que YA pagaron, luego por orden de llegada.
  const siguiente = db.prepare(
    "SELECT * FROM inscripciones WHERE partido_id = ? AND estado = 'espera' ORDER BY (pago_id IS NULL), id LIMIT 1"
  ).get(insc.partido_id);
  if (!siguiente) return null;
  db.prepare('UPDATE inscripciones SET estado = ? WHERE id = ?').run(siguiente.pago_id ? 'pagado' : 'reservado', siguiente.id);
  return db.prepare('SELECT * FROM inscripciones WHERE id = ?').get(siguiente.id);
}

function setAsistencia(id, valor) {
  db.prepare('UPDATE inscripciones SET asistencia = ? WHERE id = ?').run(valor === 'si' || valor === 'no' ? valor : null, id);
}

/**
 * Vincula un pago confirmado a un partido. Reglas conservadoras (v1):
 *   1. Si el contacto tiene una inscripción activa en un partido abierto,
 *      ese cupo pasa a 'pagado'.
 *   2. Si no tiene pero hay EXACTAMENTE UN partido abierto en su zona, se le
 *      inscribe directo como 'pagado' (si hay lugar; si no, 'espera').
 *   3. En cualquier otro caso no se adivina: el pago queda sin partido y
 *      Clarck lo asigna desde el panel.
 * Los cupos extra (amigos) se agregan al mismo partido.
 * @returns {null | {partido: object, inscripciones: object[]}}
 */
/**
 * Partidos a los que PODRÍA corresponder un pago suelto: los de su zona que
 * todavía no terminaron, dentro de los próximos 3 días, y cuyo precio calza
 * con lo pagado (1 a 10 cupos).
 *
 * Se expone aparte para que pagos.js pueda ver la ambigüedad ANTES de decidir:
 * con un solo candidato alcanza la aritmética, con cero o con varios hay que
 * leer la conversación.
 */
function candidatosDePago(zona, monto = null) {
  const limite = new Date(Date.now() - 5 * 3600e3 + 3 * 86400e3).toISOString().slice(0, 10);
  let candidatos = (zona ? partidosAbiertos(zona, { vigentes: true, incluirEnCurso: true }) : [])
    .filter((p) => p.fecha <= limite);
  if (monto != null && candidatos.length > 1) {
    const cfg = getConfigMap();
    const calzan = candidatos.filter((p) => cuposPorMonto(monto, precioDePartido(p, cfg)));
    if (calzan.length) candidatos = calzan;
  }
  return candidatos;
}

/**
 * A QUÉ PARTIDO PUEDE CORRESPONDER ESTE MONTO — en cualquier zona.
 *
 * El validador de vouchers comparaba el monto contra el precio de la zona de
 * CASA del contacto, pero el prompt del bot dice lo contrario: "la zona de un
 * jugador NO lo limita". Alguien de Comas (S/10) que paga S/15 por un partido
 * de Breña quedaba en "revisar" y encima se lo silenciaba con un handoff.
 *
 * Acá se mira lo que de verdad importa: si el monto son N cupos exactos de
 * ALGÚN partido al que todavía se puede entrar. Se prefiere el de su zona
 * (sigue siendo lo más probable) y, entre los demás, el más próximo.
 *
 * @returns {Array<{partido: object, cupos: number, precio: number}>}
 */
function partidosQueCalzan(monto, zonaPreferida = null) {
  if (monto == null) return [];
  const limite = new Date(Date.now() - 5 * 3600e3 + 3 * 86400e3).toISOString().slice(0, 10);
  const cfg = getConfigMap();
  return partidosAbiertos(null, { vigentes: true, incluirEnCurso: true })
    .filter((p) => p.fecha <= limite)
    .map((p) => ({ partido: p, precio: precioDePartido(p, cfg), cupos: cuposPorMonto(monto, precioDePartido(p, cfg)) }))
    .filter((x) => x.cupos)
    .sort((a, b) => (a.partido.zona === zonaPreferida ? 0 : 1) - (b.partido.zona === zonaPreferida ? 0 : 1)
      || (a.partido.fecha < b.partido.fecha ? -1 : 1));
}

/**
 * @param {object} [opciones]
 * @param {number} [opciones.partidoId] Partido decidido afuera (p. ej. leyendo
 *   la conversación). Manda sobre la aritmética, pero NUNCA sobre una reserva
 *   previa del jugador: si ya tenía cupo reservado, el pago va ahí.
 */
function vincularPago(numero, pagoId, cupos = 1, zona = null, monto = null, { partidoId = null } = {}) {
  let partido = null;
  // La misma preferencia que la validación: con varias reservas activas, el
  // pago se aplica a la reserva cuyo precio calza con el monto.
  const partidoPref = partidoReservadoDe(numero, monto);
  const activaEnAbierto = partidoPref
    ? db.prepare("SELECT * FROM inscripciones WHERE partido_id = ? AND numero = ? AND estado IN ('reservado','espera') LIMIT 1").get(partidoPref.id, numero)
    : null;
  const hechas = [];
  if (activaEnAbierto) {
    partido = getPartido(activaEnAbierto.partido_id);
    // Una ESPERA que paga no salta el cupo: si la cancha está llena, el pago
    // queda registrado en su fila de espera (prioridad al promover) pero NO
    // pasa a ocupar lugar — pagar no puede sobrevender el partido.
    let nuevoEstado = 'pagado';
    if (activaEnAbierto.estado === 'espera') {
      const ocupados = db.prepare(`SELECT COUNT(*) AS n FROM inscripciones WHERE partido_id = ? AND estado IN ${OCUPAN}`).get(partido.id).n;
      if (ocupados >= partido.cupo) nuevoEstado = 'espera';
    }
    db.prepare('UPDATE inscripciones SET estado = ?, pago_id = ? WHERE id = ?').run(nuevoEstado, pagoId, activaEnAbierto.id);
    hechas.push(db.prepare('SELECT * FROM inscripciones WHERE id = ?').get(activaEnAbierto.id));
  } else {
    // Sin reserva previa (el flujo de siempre: yapean directo). Si la
    // aritmética deja UN solo candidato se asigna; si hay varios o ninguno, NO
    // se adivina acá — quien llama puede haber leído la conversación y pasar
    // `partidoId`; si tampoco, el pago queda suelto y Clarck lo asigna.
    // Si afuera ya se decidió a qué partido va (leyendo la conversación), se
    // respeta — pero solo si sigue abierto: nunca se mete gente a un partido
    // cerrado o cancelado.
    const elegido = partidoId ? getPartido(partidoId) : null;
    if (elegido && admiteInscripcion(elegido)) {
      partido = elegido;
    } else {
      const candidatos = candidatosDePago(zona, monto);
      if (candidatos.length !== 1) return null;
      partido = candidatos[0];
    }
    const { inscripcion } = inscribir(partido.id, numero, { estado: 'pagado', pagoId });
    if (!inscripcion) return null;
    hechas.push(inscripcion);
  }
  for (let i = 1; i < cupos; i++) {
    const { inscripcion } = inscribir(partido.id, null, { nombre: `Invitado de +${numero}`, estado: 'pagado', pagoId });
    if (inscripcion) hechas.push(inscripcion);
  }
  return { partido, inscripciones: hechas };
}

/** Partido (abierto y próximo) donde el contacto tiene una reserva sin pagar.
 *  Lo usa la validación de vouchers: el precio del PARTIDO manda sobre el de
 *  la zona del contacto (partidos con precio custom, jugador multi-distrito).
 *  Con varias reservas activas (ej. Breña S/15 y Comas S/10), si se pasa el
 *  monto se PREFIERE la reserva cuyo precio calce con lo pagado. */
function partidoReservadoDe(numero, monto = null) {
  const ahora = ahoraLima();
  const filas = db.prepare(`
    SELECT p.* FROM inscripciones i JOIN partidos p ON p.id = i.partido_id
    WHERE i.numero = ? AND i.estado IN ('reservado','espera')
      AND p.cancelado_en IS NULL AND p.liquidado_en IS NULL AND p.fecha >= ?
    ORDER BY p.fecha, i.id
  `).all(numero, ahora.fecha)
    // Una reserva en un partido cerrado a mano o vencido ya no captura el pago:
    // el enum decía 'abierto' o no, ahora lo dice el reloj.
    .filter((p) => admiteInscripcion(p, ahora));
  if (!filas.length) return null;
  if (monto != null) {
    const cfg = getConfigMap();
    const calza = filas.find((p) => cuposPorMonto(monto, precioDePartido(p, cfg)));
    if (calza) return calza;
  }
  return filas[0];
}

/**
 * PUNTO DE ARRANQUE: fecha desde la que el sistema "cuenta" para las colas de
 * trabajo. Todo lo anterior es HISTÓRICO — la data queda intacta (la plata se
 * sigue sumando, las conversaciones siguen ahí), pero no aparece como
 * pendiente: esos pagos ya se jugaron y esos handoffs Clarck ya los atendió.
 * Se setea desde Config con "Empezar en limpio desde hoy".
 */
function getCorte() {
  const r = db.prepare("SELECT valor FROM config WHERE clave = 'corte_operativo'").get();
  return r && /^\d{4}-\d{2}-\d{2}$/.test(r.valor || '') ? r.valor : null;
}
function setCorte(fecha) {
  const f = /^\d{4}-\d{2}-\d{2}$/.test(fecha || '') ? fecha : hoyLimaDb();
  db.prepare("INSERT INTO config (clave, valor) VALUES ('corte_operativo', ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor").run(f);
  return f;
}
/** ¿Este timestamp entra en las colas de trabajo (es posterior al corte)? */
const despuesDelCorte = (ts) => { const c = getCorte(); return !c || (ts || '').slice(0, 10) >= c; };

/** Pagos confirmados sin partido asignado (para que Clarck los asigne a mano).
 *  Solo los del período operativo: posteriores al punto de arranque y de las
 *  últimas 48 h — un pago de la semana pasada pertenece a un partido que ya
 *  se jugó, no es una tarea de hoy. */
/**
 * Pagos confirmados que todavía no cubren ningún cupo — la cola de trabajo.
 *
 * Antes se filtraba además por una ventana de 48 h: pasados dos días, un Yape
 * cobrado y sin cupo DESAPARECÍA de la cola para siempre. Plata adentro, sin
 * lugar en ninguna lista y sin tarea que lo recordara. La tarea ahora vive
 * hasta que se asigne; para darla por saldada está el punto de arranque
 * (corte_operativo), que es el "empezar en limpio" explícito de Clarck.
 */
function pagosSinPartido(limite = 30) {
  const corte = getCorte() || '0000-00-00';
  return db.prepare(`
    SELECT p.*, l.nombre, l.zona FROM pagos p LEFT JOIN leads l ON l.numero = p.numero
    WHERE p.estado = 'confirmado'
      AND p.id NOT IN (SELECT pago_id FROM inscripciones WHERE pago_id IS NOT NULL)
      AND substr(p.creado_en, 1, 10) >= ?
    ORDER BY p.id DESC LIMIT ?
  `).all(corte, limite);
}

/**
 * El último pago suelto de un contacto — el que se engancha solo cuando por fin
 * reserva ("ya te yapeé" primero, "anótame el domingo" después).
 *
 * Mismo recorte que `pagosSinPartido`: el punto de arranque, no una ventana de
 * horas. Tenía 48 h fijas mientras la cola ya no las tenía, así que un pago de
 * tres días seguía apareciendo en el panel como pendiente pero ya no se
 * enganchaba solo — la mitad del mecanismo apagada sin que nada lo dijera.
 * El parámetro `horas` sigue existiendo para quien quiera una ventana corta.
 */
function pagoSueltoDe(numero, horas = null) {
  const corte = getCorte() || '0000-00-00';
  return db.prepare(`
    SELECT * FROM pagos WHERE numero = ? AND estado = 'confirmado'
      AND id NOT IN (SELECT pago_id FROM inscripciones WHERE pago_id IS NOT NULL)
      AND substr(creado_en, 1, 10) >= ?
      AND (? IS NULL OR creado_en >= datetime('now', '-5 hours', ?))
    ORDER BY id DESC LIMIT 1
  `).get(numero, corte, horas == null ? null : 1, horas == null ? '-0 hours' : `-${horas} hours`) || null;
}

/** Marca una inscripción como pagada con su pago (cierra un pago suelto). */
/**
 * Marca pagada una inscripción. Si estaba en ESPERA y la cancha está llena, el
 * pago queda registrado pero NO la sube a la cancha: pagar no puede sobrevender
 * (mismo criterio que vincularPago). Devuelve si logró ocupar lugar.
 */
function pagarInscripcion(inscripcionId, pagoId) {
  const insc = db.prepare('SELECT * FROM inscripciones WHERE id = ?').get(inscripcionId);
  if (!insc) return { ok: false, motivo: 'no_existe' };
  const p = getPartido(insc.partido_id);
  const ocupaAhora = ['reservado', 'pagado'].includes(insc.estado);
  if (!ocupaAhora && p && ocupadosDe(insc.partido_id) >= p.cupo) {
    db.prepare('UPDATE inscripciones SET pago_id = ? WHERE id = ?').run(pagoId, inscripcionId);
    return { ok: true, motivo: 'lleno_queda_en_espera' };
  }
  db.prepare("UPDATE inscripciones SET estado = 'pagado', pago_id = ? WHERE id = ?").run(pagoId, inscripcionId);
  return { ok: true, motivo: null };
}

/** Texto de la lista para pegar en el grupo de WhatsApp. */
function textoLista(partidoId) {
  const p = getPartido(partidoId);
  if (!p) return '';
  const neg = getNegocio();
  const zonaNombre = nombreDeZona(p.zona);
  const precio = precioDePartido(p);
  const inscritos = inscripcionesDe(partidoId).filter((i) => ['pagado', 'reservado'].includes(i.estado));
  const espera = inscripcionesDe(partidoId).filter((i) => i.estado === 'espera');
  const nombreDe = (i) => i.nombre || i.lead_nombre || (i.numero ? `+${i.numero}` : 'Por confirmar');
  const lineas = [];
  // Fecha ABSOLUTA a propósito: la lista queda pegada en el grupo y un
  // "MAÑANA" envejece mal. El relativo es solo para mensajes efímeros del chat.
  lineas.push(`⚽ PICHANGA ${zonaNombre.toUpperCase()} — ${fechaBonita(p.fecha, { relativa: false }).toUpperCase()}${p.hora ? ` · ${p.hora}` : ''}`);
  if (p.sede) lineas.push(`📍 ${p.sede}`);
  // Sin precio cargado se dice "por confirmar": pegar "S/ 0 por jugador" en el
  // grupo es peor que no decir nada.
  lineas.push(`💰 ${precio != null ? `S/ ${precio}` : 'Precio por confirmar'} por jugador · Yape al ${neg.yape.numero}`);
  lineas.push('');
  for (let i = 0; i < p.cupo; i++) {
    const insc = inscritos[i];
    lineas.push(`${i + 1}. ${insc ? `${nombreDe(insc)}${insc.estado === 'pagado' ? ' ✅' : ''}` : ''}`);
  }
  if (espera.length) {
    lineas.push('', '⏳ Lista de espera:');
    // El ✅ marca a los de la espera que YA pagaron (prioridad si se libera lugar).
    espera.forEach((i, idx) => lineas.push(`${idx + 1}. ${nombreDe(i)}${i.pago_id ? ' ✅' : ''}`));
  }
  return lineas.join('\n');
}

/**
 * A quién le escribo para llenar ESTE partido.
 *
 * La pregunta que ninguna pantalla contestaba: quedan 6 cupos para el viernes
 * en Breña y la lista de contactos está ordenada por "último mensaje", que no
 * tiene nada que ver con quién viene a jugar.
 *
 * Candidato = ya vino alguna vez (visitas ≥ 1) · es de esa zona · NO está ya
 * inscrito en este partido. Ordenados por frescura: primero el que vino hace
 * menos, que es el que más probable diga que sí.
 *
 * Los `dado-de-baja` quedan afuera: es la única marca manual que sobrevivió a
 * las etapas y significa exactamente "a este no le escribas".
 *
 * NO manda nada: devuelve la lista. Con SAFE_MODE encendido y la cuenta con
 * alertas de salud de Meta, un envío masivo de 200 mensajes es pedir un baneo.
 */
function candidatosConvocatoria(partidoId) {
  const p = getPartido(partidoId);
  if (!p) return [];
  const filas = db.prepare(`
    SELECT l.numero, l.nombre, l.distrito, l.zona, l.grupo_enviado_en, l.handoff
    FROM leads l
    WHERE l.zona = ?
      AND (l.etiquetas IS NULL OR l.etiquetas NOT LIKE '%dado-de-baja%')
      AND l.numero NOT IN (
        SELECT numero FROM inscripciones
        WHERE partido_id = ? AND numero IS NOT NULL AND estado != 'baja'
      )
  `).all(p.zona, partidoId);
  const met = metricasPorNumero();
  return filas
    .map((l) => ({ ...l, ...(met[l.numero] || SIN_METRICAS) }))
    .filter((l) => l.visitas >= 1)
    // Más fresco primero (misma fecha → el de más visitas manda).
    .sort((a, b) => (a.ultima === b.ultima ? b.visitas - a.visitas : (b.ultima || '').localeCompare(a.ultima || '')));
}

// ==============================================================================
//  COLAS DE CIERRE — liquidar lo que movió plata, archivar lo que quedó vacío
// ==============================================================================

/**
 * Los partidos que TERMINARON y siguen sin liquidar, con la caja adentro.
 *
 * Reemplaza al pendiente "N partidos ya jugados sin cerrar" del Resumen, que le
 * pedía a Clarck que rompiera la única red que atrapaba los pagos tardíos. Acá
 * no se le pide que cierre: se le pide que CUENTE la plata, que es lo único que
 * un partido terminado todavía necesita de él.
 *
 * Se parten en dos porque son dos trabajos distintos:
 *   · con gente adentro → cola de LIQUIDACIÓN (una pantalla, una decisión)
 *   · vacíos            → basura de carga: se archivan en lote, sin ritual
 */
function partidosPorLiquidar({ soloConPlata = true } = {}) {
  const ahora = ahoraLima();
  const corte = getCorte() || '0000-00-00';
  return listPartidos()
    .filter((p) => p.fase === 'por_liquidar' && p.fecha >= corte)
    .filter((p) => (soloConPlata ? (p.ocupados + p.en_espera) > 0 : true))
    .map((p) => ({ ...p, caja: cajaPartido(p.id) }))
    .sort((a, b) => (a.fecha < b.fecha ? -1 : 1));
}

/**
 * Los que se archivan en lote, sin ritual de liquidación. Dos casos:
 *
 * 1. Terminaron SIN nadie adentro: no hay nada que contar.
 * 2. Son ANTERIORES al punto de arranque, tengan gente o no. El corte declara
 *    que eso ya es historia; si no entraran acá quedarían atascados para
 *    siempre — fuera de la cola de liquidación (que respeta el corte) y fuera
 *    de "vacíos" (porque tienen inscritos). Pasó al migrar: 6 partidos del
 *    12 al 15 de agosto, uno con 10 inscritos y 9 pagados, no aparecían en
 *    NINGUNA lista. Invisibles no es lo mismo que resueltos.
 */
function partidosArchivables() {
  const corte = getCorte() || '0000-00-00';
  return listPartidos().filter((p) => p.fase === 'por_liquidar'
    && ((p.ocupados + p.en_espera) === 0 || p.fecha < corte));
}

/** Solo los vacíos, para poder contarlos aparte en el panel. */
function partidosVacios() {
  return listPartidos().filter((p) => p.fase === 'por_liquidar' && (p.ocupados + p.en_espera) === 0);
}

/**
 * Archiva en lote los partidos terminados y vacíos.
 *
 * Archivar = liquidar un partido sin plata: la afirmación "acá no hay nada que
 * cobrar" es verdadera por construcción (cero inscritos), así que no necesita
 * que un humano la revise uno por uno. Tambien entran los ANTERIORES al punto
 * de arranque: el corte ya declaro que eso es historia, y si no, quedaban
 * atascados sin aparecer en ninguna lista. Los que movieron dinero DESPUES del
 * corte nunca pasan por aca: esos se liquidan uno por uno.
 * @returns {number} cuántos se archivaron.
 */
function archivarPartidosVacios() {
  const vacios = partidosArchivables();
  const ts = ahoraLima().ts;
  const stmt = db.prepare("UPDATE partidos SET liquidado_en = ?, estado = 'jugado' WHERE id = ?");
  for (const p of vacios) stmt.run(ts, p.id);
  return vacios.length;
}

// ==============================================================================
//  TURNOS — la plantilla semanal ("todos los domingos 6pm en el Politécnico")
// ==============================================================================

const DIAS_NOMBRE = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
/** "los lunes" no lleva s; "los domingos" sí. Un turno se nombra en plural. */
const diaPlural = (dia) => (/s$/.test(dia || '') ? dia : `${dia}s`);
/** Día de la semana de una fecha (0 domingo … 6 sábado), en hora de Lima. */
const diaSemanaDe = (ymd) => new Date(`${ymd}T12:00:00-05:00`).getUTCDay();
/** Suma días a una fecha YYYY-MM-DD sin pasar por el huso horario. */
const sumarDias = (ymd, n) => new Date(Date.parse(`${ymd}T12:00:00Z`) + n * 86400e3).toISOString().slice(0, 10);

/**
 * TOPE DURO DE HORIZONTE. Un turno mal configurado (día de semana equivocado,
 * vigencia abierta) no puede materializar 300 partidos que después hay que
 * borrar a mano. 14 días es lo que se genera; 21 es lo máximo que se acepta
 * aunque alguien pida más.
 */
const HORIZONTE_DIAS = 14;
const HORIZONTE_MAX = 21;

function listTurnos({ soloActivos = false } = {}) {
  return db.prepare(`
    SELECT t.*, s.nombre AS sede_nombre
    FROM turnos t LEFT JOIN sedes s ON s.id = t.sede_id
    ${soloActivos ? 'WHERE t.activo = 1' : ''}
    ORDER BY t.activo DESC, t.dia_semana, t.inicio_min
  `).all().map((t) => ({
    ...t,
    hora: textoHora(t.inicio_min, t.duracion_min),
    dia_nombre: DIAS_NOMBRE[t.dia_semana] || '?',
  }));
}

function getTurno(id) {
  return listTurnos().find((t) => t.id === Number(id)) || null;
}

/**
 * Crea una plantilla. NACE APAGADA (`activo = 0`) salvo que se pida lo
 * contrario: encender un turno compromete a Clarck a pagar canchas reales, así
 * que esa decisión se toma con el dedo, no por inercia de una migración.
 */
function crearTurno({ zona, sede_id = null, dia_semana, hora, inicio_min, duracion_min, cupo, precio, activo = 0, vigente_desde = null, vigente_hasta = null, nota = null }) {
  if (!zonasOperativas().includes(zona)) return null;
  const h = hora ? parseHora(hora) : null;
  const ini = inicio_min != null ? Number(inicio_min) : (h ? h.inicio : null);
  if (ini == null || !Number.isFinite(ini)) return null;
  const dia = Number(dia_semana);
  if (!(dia >= 0 && dia <= 6)) return null;
  const r = db.prepare(`
    INSERT INTO turnos (zona, sede_id, dia_semana, inicio_min, duracion_min, cupo, precio, activo, vigente_desde, vigente_hasta, nota, creado_en)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '-5 hours'))
  `).run(
    zona, sede_id ?? null, dia, ini,
    Number(duracion_min) > 0 ? Number(duracion_min) : (h ? h.duracion : 60),
    Math.max(2, Math.min(60, Number(cupo) || 14)),
    precio === '' || precio == null ? null : Number(precio),
    activo ? 1 : 0, vigente_desde || null, vigente_hasta || null, nota || null,
  );
  return Number(r.lastInsertRowid);
}

function actualizarTurno(id, campos) {
  const t = getTurno(id);
  if (!t) return { ok: false, motivo: 'Ese turno ya no existe.' };
  const sets = [], valores = [];
  const poner = (col, v) => { sets.push(`${col} = ?`); valores.push(v); };
  if (campos.zona && zonasOperativas().includes(campos.zona)) poner('zona', campos.zona);
  if (campos.sede_id !== undefined) poner('sede_id', campos.sede_id ? Number(campos.sede_id) : null);
  if (campos.dia_semana !== undefined && Number(campos.dia_semana) >= 0 && Number(campos.dia_semana) <= 6) poner('dia_semana', Number(campos.dia_semana));
  if (campos.hora) {
    const h = parseHora(campos.hora);
    if (h) { poner('inicio_min', h.inicio); poner('duracion_min', h.duracion); }
  }
  if (campos.cupo != null && campos.cupo !== '') poner('cupo', Math.max(2, Math.min(60, Number(campos.cupo) || t.cupo)));
  if (campos.precio !== undefined) poner('precio', campos.precio === '' || campos.precio == null ? null : Number(campos.precio));
  if (campos.vigente_desde !== undefined) poner('vigente_desde', /^\d{4}-\d{2}-\d{2}$/.test(campos.vigente_desde || '') ? campos.vigente_desde : null);
  if (campos.vigente_hasta !== undefined) poner('vigente_hasta', /^\d{4}-\d{2}-\d{2}$/.test(campos.vigente_hasta || '') ? campos.vigente_hasta : null);
  if (!sets.length) return { ok: false, motivo: 'No cambiaste nada.' };
  db.prepare(`UPDATE turnos SET ${sets.join(', ')} WHERE id = ?`).run(...valores, id);
  return { ok: true };
}

const setTurnoActivo = (id, activo) => db.prepare('UPDATE turnos SET activo = ? WHERE id = ?').run(activo ? 1 : 0, id).changes > 0;

/** Borra la plantilla. Los partidos YA generados se quedan: son compromisos reales. */
function eliminarTurno(id) {
  db.prepare('UPDATE partidos SET turno_id = NULL WHERE turno_id = ?').run(id);
  db.prepare('DELETE FROM turno_excepciones WHERE turno_id = ?').run(id);
  return db.prepare('DELETE FROM turnos WHERE id = ?').run(id).changes > 0;
}

/** "Esta semana no se juega": la fecha queda excluida de la generación. */
function agregarExcepcion(turnoId, fecha, motivo = null) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha || '')) return false;
  db.prepare(
    "INSERT INTO turno_excepciones (turno_id, fecha, motivo, creado_en) VALUES (?, ?, ?, datetime('now','-5 hours')) ON CONFLICT(turno_id, fecha) DO UPDATE SET motivo = excluded.motivo"
  ).run(Number(turnoId), fecha, motivo);
  return true;
}
const quitarExcepcion = (turnoId, fecha) => db.prepare('DELETE FROM turno_excepciones WHERE turno_id = ? AND fecha = ?').run(Number(turnoId), fecha).changes > 0;
const excepcionesDe = (turnoId) => db.prepare('SELECT * FROM turno_excepciones WHERE turno_id = ? ORDER BY fecha').all(Number(turnoId));

/**
 * Materializa los próximos N días de cada turno activo.
 *
 * IDEMPOTENTE: correrlo dos veces no crea nada de más, porque `abrirPartido`
 * devuelve el gemelo en vez de insertar. Por eso se puede llamar en cada tick y
 * cada vez que se abre la vista Partidos, sin llevar la cuenta de nada.
 *
 * SNAPSHOT: cupo, precio y sede se COPIAN del turno al partido. Si mañana sube
 * el precio del turno, el domingo que ya está cargado sigue costando lo que
 * costaba cuando se prometió — el precio no puede moverse debajo de alguien que
 * ya se anotó.
 *
 * NUNCA se llama desde `partidosAbiertos()`: ese es el camino caliente del bot
 * y las lecturas tienen que seguir siendo lecturas.
 */
function generarPartidosDeTurnos({ dias = HORIZONTE_DIAS } = {}) {
  const horizonte = Math.max(1, Math.min(Number(dias) || HORIZONTE_DIAS, HORIZONTE_MAX));
  const hoy = hoyLimaDb();
  const creados = [];
  for (const t of db.prepare('SELECT * FROM turnos WHERE activo = 1').all()) {
    const sede = t.sede_id ? db.prepare('SELECT nombre FROM sedes WHERE id = ?').get(t.sede_id) : null;
    for (let i = 0; i < horizonte; i++) {
      const fecha = sumarDias(hoy, i);
      if (diaSemanaDe(fecha) !== t.dia_semana) continue;
      if (t.vigente_desde && fecha < t.vigente_desde) continue;
      if (t.vigente_hasta && fecha > t.vigente_hasta) continue;
      if (db.prepare('SELECT 1 FROM turno_excepciones WHERE turno_id = ? AND fecha = ?').get(t.id, fecha)) continue;
      const r = abrirPartido({
        zona: t.zona, fecha, hora: textoHora(t.inicio_min, t.duracion_min),
        sede: sede ? sede.nombre : null, sede_id: t.sede_id,
        cupo: t.cupo, precio: t.precio, turno_id: t.id,
      });
      if (r.creado) creados.push({ id: r.id, fecha, zona: t.zona, hora: textoHora(t.inicio_min, t.duracion_min) });
    }
  }
  if (creados.length) console.log(`[turnos] ${creados.length} partidos generados desde las plantillas activas.`);
  return { creados: creados.length, detalle: creados };
}

/**
 * SIEMBRA POR INFERENCIA: los turnos que Clarck ya juega sin haberlos escrito.
 *
 * Se agrupan los partidos existentes por (zona, cancha, día de semana, hora) y
 * los grupos con 2+ ocurrencias se proponen como plantilla. Se proponen APAGADAS:
 * el sistema levanta la mano, el que se compromete a pagar la cancha es él.
 */
function turnosSugeridos({ minimo = 2 } = {}) {
  const filas = db.prepare(`
    SELECT zona, sede_id, CAST(strftime('%w', fecha) AS INTEGER) AS dia_semana, inicio_min,
           COUNT(*) AS veces, MAX(fecha) AS ultima,
           MAX(duracion_min) AS duracion_min, MAX(cupo) AS cupo, MAX(precio) AS precio,
           MAX(sede) AS sede
    FROM partidos
    WHERE inicio_min IS NOT NULL AND cancelado_en IS NULL
    GROUP BY zona, sede_id, dia_semana, inicio_min
    HAVING veces >= ?
    ORDER BY veces DESC, dia_semana
  `).all(minimo);
  const yaHay = new Set(db.prepare('SELECT zona, sede_id, dia_semana, inicio_min FROM turnos').all()
    .map((t) => `${t.zona}|${t.sede_id ?? ''}|${t.dia_semana}|${t.inicio_min}`));
  return filas
    .filter((f) => !yaHay.has(`${f.zona}|${f.sede_id ?? ''}|${f.dia_semana}|${f.inicio_min}`))
    .map((f) => ({ ...f, hora: textoHora(f.inicio_min, f.duracion_min), dia_nombre: DIAS_NOMBRE[f.dia_semana] }));
}

function sembrarTurnosPorInferencia() {
  let n = 0;
  for (const s of turnosSugeridos()) {
    const id = crearTurno({
      zona: s.zona, sede_id: s.sede_id, dia_semana: s.dia_semana,
      inicio_min: s.inicio_min, duracion_min: s.duracion_min,
      cupo: s.cupo, precio: s.precio, activo: 0,
      nota: `Inferido de ${s.veces} partidos ya jugados (último: ${s.ultima}).`,
    });
    if (id) n++;
  }
  return n;
}

/**
 * DÍAS HUÉRFANOS: "los últimos 3 domingos jugaste 6-7pm en Comas y hoy no hay
 * nada cargado".
 *
 * Es el aviso que habría evitado el caso del 15/08 — un domingo prometido por
 * WhatsApp, un jugador que pagó S/20 por dos cupos, y ningún partido cargado
 * donde ponerlos. Mira la costumbre (los partidos que ya se jugaron), no las
 * plantillas: sirve incluso si Clarck nunca configuró un turno.
 *
 * @returns {Array<{fecha, zona, hora, veces, sede}>} un hueco por día/turno.
 */
function diasSinCargar({ dias = HORIZONTE_DIAS, minimo = 3 } = {}) {
  const horizonte = Math.max(1, Math.min(Number(dias) || HORIZONTE_DIAS, HORIZONTE_MAX));
  const hoy = hoyLimaDb();
  const costumbre = db.prepare(`
    SELECT zona, sede_id, MAX(sede) AS sede, CAST(strftime('%w', fecha) AS INTEGER) AS dia_semana,
           inicio_min, MAX(duracion_min) AS duracion_min, COUNT(*) AS veces
    FROM partidos
    WHERE inicio_min IS NOT NULL AND cancelado_en IS NULL AND fecha < ?
    GROUP BY zona, sede_id, dia_semana, inicio_min
    HAVING veces >= ?
  `).all(hoy, minimo);
  if (!costumbre.length) return [];

  const huecos = [];
  for (let i = 0; i < horizonte; i++) {
    const fecha = sumarDias(hoy, i);
    const dia = diaSemanaDe(fecha);
    for (const c of costumbre.filter((x) => x.dia_semana === dia)) {
      const existe = partidoGemelo({ fecha, zona: c.zona, sedeId: c.sede_id, inicioMin: c.inicio_min });
      if (existe && !existe.cancelado_en) continue;
      huecos.push({
        fecha, zona: c.zona, sede: c.sede, sede_id: c.sede_id, inicio_min: c.inicio_min,
        hora: textoHora(c.inicio_min, c.duracion_min), veces: c.veces, dia_nombre: DIAS_NOMBRE[dia],
        cancelado: Boolean(existe && existe.cancelado_en),
      });
    }
  }
  return huecos;
}

/**
 * ANTI-DUPLICADO: un índice único por (fecha, zona, cancha, hora).
 *
 * Va en try/catch y NUNCA dentro del db.exec de arranque: si hay duplicados
 * preexistentes el CREATE INDEX falla, y si eso pasa dentro del arranque el bot
 * no levanta — el negocio entero se queda sin WhatsApp por un índice.
 *
 * Antes del índice se limpian las colisiones, pero SOLO las inofensivas: si una
 * de las dos filas está vacía se borra la vacía; si las DOS tienen gente
 * adentro no se toca nada y el conflicto queda visible en el panel. Fusionar
 * inscripciones es una decisión sobre plata y personas: no la puede tomar una
 * migración a las 3 de la mañana.
 */
function asegurarIndiceUnico() {
  try {
    const grupos = db.prepare(`
      SELECT fecha, zona, COALESCE(sede_id, -1) AS s, COALESCE(inicio_min, -1) AS i, COUNT(*) AS n
      FROM partidos GROUP BY fecha, zona, s, i HAVING n > 1
    `).all();
    const conflictos = [];
    let borrados = 0;
    for (const g of grupos) {
      const filas = db.prepare(`
        SELECT p.id, p.fecha, p.zona, p.hora,
          (SELECT COUNT(*) FROM inscripciones i WHERE i.partido_id = p.id) AS gente
        FROM partidos p WHERE fecha = ? AND zona = ? AND COALESCE(sede_id, -1) = ? AND COALESCE(inicio_min, -1) = ?
        ORDER BY p.id
      `).all(g.fecha, g.zona, g.s, g.i);
      const conGente = filas.filter((f) => f.gente > 0);
      if (conGente.length > 1) {
        conflictos.push(`${g.fecha} ${g.zona}${filas[0].hora ? ` ${filas[0].hora}` : ''} → partidos ${filas.map((f) => `#${f.id} (${f.gente})`).join(' y ')}`);
        continue;
      }
      const sobrevive = conGente[0] || filas[0];
      for (const f of filas) {
        if (f.id === sobrevive.id) continue;
        db.prepare('DELETE FROM partidos WHERE id = ?').run(f.id);
        borrados++;
      }
    }
    if (borrados) console.log(`[partidos] ${borrados} duplicados VACÍOS eliminados (los que tenían gente no se tocaron).`);
    if (conflictos.length) {
      // Sin índice, pero con el conflicto a la vista: el panel lo muestra y
      // Clarck decide qué lista es la buena.
      setMarca('partidos_en_conflicto', conflictos.join(' · '));
      console.error(`[partidos] ${conflictos.length} duplicados CON GENTE en las dos listas — no se fusionan solos: ${conflictos.join(' · ')}`);
      return { ok: false, conflictos };
    }
    setMarca('partidos_en_conflicto', '');
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_partidos_unico ON partidos(fecha, zona, COALESCE(sede_id, -1), COALESCE(inicio_min, -1))');
    return { ok: true, conflictos: [] };
  } catch (e) {
    console.error('[partidos] No se pudo crear el índice anti-duplicado:', e.message);
    return { ok: false, conflictos: [], error: e.message };
  }
}
/** Los duplicados con gente en las dos listas que quedaron sin resolver. */
const conflictosDePartidos = () => (getMarca('partidos_en_conflicto') || '').split(' · ').filter(Boolean);

asegurarIndiceUnico();

// Siembra por inferencia (2026-08-17, una vez): las plantillas que Clarck ya
// juega sin haberlas escrito. Todas APAGADAS — las enciende él, una por una.
if (!db.prepare("SELECT valor FROM config WHERE clave = 'turnos_inferidos_2026_08'").get()) {
  const n = sembrarTurnosPorInferencia();
  db.prepare("INSERT INTO config (clave, valor) VALUES ('turnos_inferidos_2026_08', '1')").run();
  if (n) console.log(`[turnos] ${n} turnos propuestos desde los partidos ya jugados (apagados: los enciende Clarck).`);
}

/** Historial de asistencia de un contacto (para la ficha del CRM). */
function asistenciasDe(numero) {
  return db.prepare(`
    SELECT i.estado, i.asistencia, p.fecha, p.zona, p.hora
    FROM inscripciones i JOIN partidos p ON p.id = i.partido_id
    WHERE i.numero = ? AND i.estado != 'baja' ORDER BY p.fecha DESC LIMIT 20
  `).all(numero);
}

module.exports = {
  getLead, getOrCreateLead, updateLead, saveMessage, getHistory, setHandoff, clearHandoff, stats, listLeads,
  marcarGrupoEnviado, setEtiquetas, addNota, getNotas, ultimosRoles, deleteLead, actividadPorDia,
  checkpoint, snapshot, resumenPagos, dbPath: DB_PATH,
  registrarPago, buscarPagoConfirmado, listPagos, pagosPorRevisar, listPagosTodos,
  getConfigMap, setConfig, listSedes, addSede, updateSede, deleteSede, getNegocio, zonasOperativas, nombreDeZona,
  // El precio, en un solo lugar (zona → partido → cuántos cupos cubre un monto).
  precioDeZona, precioDePartido, cuposPorMonto, partidosQueCalzan,
  // Ajustes operativos: lo que antes vivía en Render y ahora edita Clarck.
  modoSeguro, estadoBot, setBotEncendido, numeroAvisos, setNumeroAvisos,
  avisosProbadoEn, marcarAvisosProbado, numerosDePrueba, setNumerosDePrueba,
  correoAvisos, correoRespaldo, setCorreo, recurrenteDesde, setRecurrenteDesde,
  crearPartido, abrirPartido, getPartido, actualizarPartido, cajaPartido, setEstadoPartido, eliminarPartido, listPartidos, partidosAbiertos, inscripcionesDe,
  // La fase se calcula, no se guarda: estas son las preguntas que antes
  // contestaba (mal) la columna `estado`.
  FASES, fasePartido, ofrecible, admiteInscripcion, motivoCierre, yaPaso, saldado, graciaHoras,
  cancelarPartido, cerrarInscripcion, liquidarPartido, reabrirPartido,
  partidosPorLiquidar, partidosVacios, partidosArchivables, archivarPartidosVacios, partidoGemelo,
  // Turnos: la plantilla semanal y sus instancias.
  listTurnos, getTurno, crearTurno, actualizarTurno, setTurnoActivo, eliminarTurno,
  agregarExcepcion, quitarExcepcion, excepcionesDe,
  generarPartidosDeTurnos, turnosSugeridos, sembrarTurnosPorInferencia, diasSinCargar,
  conflictosDePartidos, diaSemanaDe, sumarDias, DIAS_NOMBRE, diaPlural, HORIZONTE_DIAS,
  metricasPorNumero, metricasDe, RELACIONES, relacionDe, FRESCURAS, frescuraDe, diasDesde, umbralesFrescura,
  // Sigue siendo `db.RECURRENTE_DESDE` en las 6 pantallas que ya lo usan, pero
  // ahora se LEE de Config en cada acceso: es una regla de Clarck, no una
  // constante nuestra.
  get RECURRENTE_DESDE() { return recurrenteDesde(); },
  inscripcionActiva, inscribir, setEstadoInscripcion, darDeBaja, setAsistencia, vincularPago, candidatosDePago,
  pagosSinPartido, textoLista, asistenciasDe, partidoReservadoDe, fechaBonita, candidatosConvocatoria,
  pagoSueltoDe, pagarInscripcion, getCorte, setCorte, despuesDelCorte,
  hoyLima: hoyLimaDb, fechaLima: fechaLimaDb, ahoraLima, ordenHora, horaInput, normalizarHora, parseHora, textoHora,
  getMarca, setMarca, handoffsDesde, handoffsActivos,
};
