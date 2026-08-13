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
if (!colsLeads.includes('proxima_accion')) db.exec('ALTER TABLE leads ADD COLUMN proxima_accion TEXT'); // fecha YYYY-MM-DD
if (!colsLeads.includes('proxima_nota')) db.exec('ALTER TABLE leads ADD COLUMN proxima_nota TEXT');

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

/** Actualiza solo los campos provistos (no pisa datos ya capturados con null). */
function updateLead(numero, campos) {
  const permitidos = ['nombre', 'edad', 'distrito', 'zona', 'estado', 'handoff', 'handoff_motivo'];
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
  db.prepare('DELETE FROM mensajes WHERE numero = ?').run(numero);
  db.prepare('DELETE FROM notas WHERE numero = ?').run(numero);
  db.prepare('DELETE FROM pagos WHERE numero = ?').run(numero);
  db.prepare('DELETE FROM leads WHERE numero = ?').run(numero);
}

function listLeads() {
  return db
    .prepare('SELECT numero, nombre, edad, distrito, zona, estado, handoff, handoff_motivo, etiquetas, proxima_accion, proxima_nota, creado_en, actualizado_en FROM leads ORDER BY actualizado_en DESC')
    .all();
}

// --- Pagos (Yape + IA) ---------------------------------------------------------
function registrarPago({ numero, monto, titular, numero_operacion, estado, motivo, medio, cupos }) {
  const r = db.prepare(
    "INSERT INTO pagos (numero, monto, titular, numero_operacion, estado, motivo, medio, cupos, creado_en) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '-5 hours'))"
  ).run(numero, monto ?? null, titular || null, numero_operacion || null, estado || 'confirmado', motivo || null, medio || 'yape', cupos || 1);
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

function pagosPorRevisar() {
  return db.prepare("SELECT COUNT(*) AS n FROM pagos WHERE estado = 'revisar'").get().n;
}

/** Cuántas personas distintas tienen al menos un pago confirmado (para el embudo). */
function pagadores() {
  return db.prepare("SELECT COUNT(DISTINCT numero) AS n FROM pagos WHERE estado = 'confirmado'").get().n;
}

/** Números (distintos) con al menos un pago confirmado (para el filtro "pagaron"). */
function numerosPagadores() {
  return db.prepare("SELECT DISTINCT numero FROM pagos WHERE estado = 'confirmado'").all().map((r) => r.numero);
}

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
function setEstado(numero, estado) {
  db.prepare("UPDATE leads SET estado = ?, actualizado_en = datetime('now', '-5 hours') WHERE numero = ?").run(estado, numero);
}

function setEtiquetas(numero, etiquetas) {
  db.prepare("UPDATE leads SET etiquetas = ?, actualizado_en = datetime('now', '-5 hours') WHERE numero = ?").run(etiquetas || null, numero);
}

function setSeguimiento(numero, fecha, nota) {
  db.prepare("UPDATE leads SET proxima_accion = ?, proxima_nota = ?, actualizado_en = datetime('now', '-5 hours') WHERE numero = ?")
    .run(fecha || null, nota || null, numero);
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
    completos: db.prepare("SELECT COUNT(*) AS n FROM leads WHERE estado != 'nuevo'").get().n,
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

function listSedes(zona) {
  return zona
    ? db.prepare('SELECT * FROM sedes WHERE zona = ? ORDER BY orden, id').all(zona)
    : db.prepare('SELECT * FROM sedes ORDER BY zona, orden, id').all();
}

function addSede(campos) {
  db.prepare(
    'INSERT INTO sedes (zona, nombre, cancha, cupo, ubicacion, horario, estacionamiento, orden) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(campos.zona, campos.nombre, campos.cancha || null, campos.cupo || null, campos.ubicacion || null, campos.horario || null, campos.estacionamiento || null, campos.orden || 0);
}

function updateSede(id, campos) {
  db.prepare('UPDATE sedes SET zona=?, nombre=?, cancha=?, cupo=?, ubicacion=?, horario=?, estacionamiento=? WHERE id=?')
    .run(campos.zona, campos.nombre, campos.cancha || null, campos.cupo || null, campos.ubicacion || null, campos.horario || null, campos.estacionamiento || null, id);
}

function deleteSede(id) {
  db.prepare('DELETE FROM sedes WHERE id = ?').run(id);
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
      precio: Number(c[`precio_${z}`]) || 0,
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
`);

const hoyLimaDb = () => new Date(Date.now() - 5 * 3600e3).toISOString().slice(0, 10);

/** '9pm' → '9-10pm' (los turnos duran 1 h): un solo formato en todo el sistema. */
function normalizarHora(hora) {
  const t = (hora || '').trim();
  const m = /^(\d{1,2})\s*(am|pm)$/i.exec(t);
  if (!m) return t;
  const n = Number(m[1]);
  return `${n}-${n === 12 ? 1 : n + 1}${m[2].toLowerCase()}`;
}

/** '8-9pm' → 20 · '9-10am' → 9 — para ordenar los turnos dentro del día. */
function ordenHora(hora) {
  const m = /^(\d{1,2})/.exec(hora || '');
  if (!m) return 99;
  let h = Number(m[1]) % 12;
  if (/pm/i.test(hora || '')) h += 12;
  return h;
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

function crearPartido({ zona, fecha, hora, sede, cupo, precio }) {
  const r = db.prepare(
    "INSERT INTO partidos (zona, fecha, hora, sede, cupo, precio, creado_en) VALUES (?, ?, ?, ?, ?, ?, datetime('now', '-5 hours'))"
  ).run(zona, fecha, normalizarHora(hora) || null, sede || null, cupo || 14, precio ?? null);
  return Number(r.lastInsertRowid);
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
  if (campos.hora !== undefined) poner('hora', normalizarHora(campos.hora) || null);
  if (campos.sede !== undefined) poner('sede', (campos.sede || '').trim() || null);
  if (campos.cupo != null && campos.cupo !== '') {
    const cupo = Math.max(2, Math.min(60, Number(campos.cupo) || p.cupo));
    if (cupo < ocupados) {
      return { ok: false, motivo: `No se puede bajar el cupo a ${cupo}: ya hay ${ocupados} jugadores adentro. Da de baja a alguien primero.` };
    }
    poner('cupo', cupo);
  }
  if (campos.precio !== undefined) poner('precio', campos.precio === '' || campos.precio == null ? null : Number(campos.precio));

  if (!sets.length) return { ok: false, motivo: 'No cambiaste nada.' };
  db.prepare(`UPDATE partidos SET ${sets.join(', ')} WHERE id = ?`).run(...valores, id);
  return { ok: true };
}

/** Borra un partido SIN inscripciones (errores de carga, duplicados).
 *  Si tiene gente adentro no se toca: para eso está "cancelar". */
function eliminarPartido(id) {
  const n = db.prepare('SELECT COUNT(*) AS n FROM inscripciones WHERE partido_id = ?').get(id).n;
  if (n > 0) return false;
  db.prepare('DELETE FROM partidos WHERE id = ?').run(id);
  return true;
}

function setEstadoPartido(id, estado) {
  if (!['abierto', 'cerrado', 'jugado', 'cancelado'].includes(estado)) return;
  db.prepare('UPDATE partidos SET estado = ? WHERE id = ?').run(estado, id);
}

/** Todos los partidos con sus conteos (para el panel), próximos primero. */
function listPartidos() {
  return db.prepare(`
    SELECT p.*,
      (SELECT COUNT(*) FROM inscripciones i WHERE i.partido_id = p.id AND i.estado IN ${OCUPAN}) AS ocupados,
      (SELECT COUNT(*) FROM inscripciones i WHERE i.partido_id = p.id AND i.estado = 'pagado') AS pagados,
      (SELECT COUNT(*) FROM inscripciones i WHERE i.partido_id = p.id AND i.estado = 'espera') AS en_espera
    FROM partidos p ORDER BY p.fecha DESC, p.id DESC
  `).all();
}

/** Partidos abiertos de hoy en adelante, con cupo restante — es lo que ve el cerebro. */
function partidosAbiertos(zona = null) {
  const filas = db.prepare(`
    SELECT p.*,
      (SELECT COUNT(*) FROM inscripciones i WHERE i.partido_id = p.id AND i.estado IN ${OCUPAN}) AS ocupados
    FROM partidos p
    WHERE p.estado = 'abierto' AND p.fecha >= ? ${zona ? 'AND p.zona = ?' : ''}
    ORDER BY p.fecha, p.id
  `).all(...(zona ? [hoyLimaDb(), zona] : [hoyLimaDb()]));
  return filas
    .map((p) => ({ ...p, restante: Math.max(0, p.cupo - p.ocupados) }))
    // Dentro del día, por hora de inicio (la BD solo ordena por fecha e id).
    .sort((a, b) => (a.fecha === b.fecha ? ordenHora(a.hora) - ordenHora(b.hora) : a.fecha < b.fecha ? -1 : 1));
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
 * @returns {{inscripcion: object, resultado: 'reservado'|'espera'|'ya_inscrito'|null}}
 */
function inscribir(partidoId, numero, { nombre = null, estado = null, pagoId = null } = {}) {
  const p = getPartido(partidoId);
  if (!p || p.estado !== 'abierto') return { inscripcion: null, resultado: null };
  if (numero) {
    const previa = inscripcionActiva(partidoId, numero);
    if (previa) return { inscripcion: previa, resultado: 'ya_inscrito' };
  }
  const ocupados = db.prepare(`SELECT COUNT(*) AS n FROM inscripciones WHERE partido_id = ? AND estado IN ${OCUPAN}`).get(partidoId).n;
  const final = estado || (ocupados < p.cupo ? 'reservado' : 'espera');
  const r = db.prepare(
    "INSERT INTO inscripciones (partido_id, numero, nombre, estado, pago_id, creado_en) VALUES (?, ?, ?, ?, ?, datetime('now', '-5 hours'))"
  ).run(partidoId, numero || null, nombre || null, final === 'pagado' && ocupados >= p.cupo ? 'espera' : final, pagoId ?? null);
  const insc = db.prepare('SELECT * FROM inscripciones WHERE id = ?').get(Number(r.lastInsertRowid));
  return { inscripcion: insc, resultado: insc.estado };
}

function setEstadoInscripcion(id, estado) {
  if (!['reservado', 'pagado', 'espera', 'baja'].includes(estado)) return null;
  db.prepare('UPDATE inscripciones SET estado = ? WHERE id = ?').run(estado, id);
  return db.prepare('SELECT * FROM inscripciones WHERE id = ?').get(id);
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
function vincularPago(numero, pagoId, cupos = 1, zona = null, monto = null) {
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
    // Sin reserva previa (el flujo de siempre: yapean directo). La gente paga
    // para un partido PRÓXIMO, así que se busca entre los de su zona en los
    // siguientes 3 días y con precio que calce con lo pagado. Si queda
    // exactamente uno, se asigna; si hay varios o ninguno, NO se adivina — el
    // bot pregunta y, si está callado, Clarck lo asigna desde el panel.
    const limite = new Date(Date.now() - 5 * 3600e3 + 3 * 86400e3).toISOString().slice(0, 10);
    const neg = getNegocio();
    let candidatos = (zona ? partidosAbiertos(zona) : []).filter((p) => p.fecha <= limite);
    if (monto != null && candidatos.length > 1) {
      const calzan = candidatos.filter((p) => {
        const precio = p.precio ?? neg.zonas[p.zona]?.precio;
        if (!precio) return false;
        const n = Math.round(monto / precio);
        return n >= 1 && n <= 10 && Math.abs(monto - n * precio) <= 0.5;
      });
      if (calzan.length) candidatos = calzan;
    }
    if (candidatos.length !== 1) return null;
    partido = candidatos[0];
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
  const filas = db.prepare(`
    SELECT p.* FROM inscripciones i JOIN partidos p ON p.id = i.partido_id
    WHERE i.numero = ? AND i.estado IN ('reservado','espera') AND p.estado = 'abierto' AND p.fecha >= ?
    ORDER BY p.fecha, i.id
  `).all(numero, hoyLimaDb());
  if (!filas.length) return null;
  if (monto != null) {
    const neg = getNegocio();
    const calza = filas.find((p) => {
      const precio = p.precio ?? neg.zonas[p.zona]?.precio;
      if (!precio) return false;
      const n = Math.round(monto / precio);
      return n >= 1 && n <= 10 && Math.abs(monto - n * precio) <= 0.5;
    });
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
function pagosSinPartido(horas = 48) {
  const corte = getCorte() || '0000-00-00';
  return db.prepare(`
    SELECT p.*, l.nombre, l.zona FROM pagos p LEFT JOIN leads l ON l.numero = p.numero
    WHERE p.estado = 'confirmado'
      AND p.id NOT IN (SELECT pago_id FROM inscripciones WHERE pago_id IS NOT NULL)
      AND p.creado_en >= datetime('now', '-5 hours', ?)
      AND substr(p.creado_en, 1, 10) >= ?
    ORDER BY p.id DESC LIMIT 15
  `).all(`-${horas} hours`, corte);
}

/** Último pago confirmado RECIENTE de un contacto que quedó sin partido. */
function pagoSueltoDe(numero, horas = 48) {
  return db.prepare(`
    SELECT * FROM pagos WHERE numero = ? AND estado = 'confirmado'
      AND id NOT IN (SELECT pago_id FROM inscripciones WHERE pago_id IS NOT NULL)
      AND creado_en >= datetime('now', '-5 hours', ?)
    ORDER BY id DESC LIMIT 1
  `).get(numero, `-${horas} hours`) || null;
}

/** Marca una inscripción como pagada con su pago (cierra un pago suelto). */
function pagarInscripcion(inscripcionId, pagoId) {
  db.prepare("UPDATE inscripciones SET estado = 'pagado', pago_id = ? WHERE id = ?").run(pagoId, inscripcionId);
}

/** Texto de la lista para pegar en el grupo de WhatsApp. */
function textoLista(partidoId) {
  const p = getPartido(partidoId);
  if (!p) return '';
  const neg = getNegocio();
  const zonaNombre = neg.zonas[p.zona]?.nombre || p.zona;
  const precio = p.precio ?? neg.zonas[p.zona]?.precio;
  const inscritos = inscripcionesDe(partidoId).filter((i) => ['pagado', 'reservado'].includes(i.estado));
  const espera = inscripcionesDe(partidoId).filter((i) => i.estado === 'espera');
  const nombreDe = (i) => i.nombre || i.lead_nombre || (i.numero ? `+${i.numero}` : 'Por confirmar');
  const lineas = [];
  // Fecha ABSOLUTA a propósito: la lista queda pegada en el grupo y un
  // "MAÑANA" envejece mal. El relativo es solo para mensajes efímeros del chat.
  lineas.push(`⚽ PICHANGA ${zonaNombre.toUpperCase()} — ${fechaBonita(p.fecha, { relativa: false }).toUpperCase()}${p.hora ? ` · ${p.hora}` : ''}`);
  if (p.sede) lineas.push(`📍 ${p.sede}`);
  lineas.push(`💰 S/ ${precio} por jugador · Yape al ${neg.yape.numero}`);
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
  setEstado, setEtiquetas, setSeguimiento, addNota, getNotas, ultimosRoles, deleteLead, actividadPorDia,
  checkpoint, snapshot, resumenPagos, dbPath: DB_PATH,
  registrarPago, buscarPagoConfirmado, listPagos, pagosPorRevisar, pagadores, numerosPagadores, listPagosTodos,
  getConfigMap, setConfig, listSedes, addSede, updateSede, deleteSede, getNegocio, zonasOperativas, nombreDeZona,
  crearPartido, getPartido, actualizarPartido, setEstadoPartido, eliminarPartido, listPartidos, partidosAbiertos, inscripcionesDe,
  inscripcionActiva, inscribir, setEstadoInscripcion, darDeBaja, setAsistencia, vincularPago,
  pagosSinPartido, textoLista, asistenciasDe, partidoReservadoDe, fechaBonita,
  pagoSueltoDe, pagarInscripcion, getCorte, setCorte, despuesDelCorte,
};
