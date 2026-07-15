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
  db.prepare(
    "INSERT INTO pagos (numero, monto, titular, numero_operacion, estado, motivo, medio, cupos, creado_en) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '-5 hours'))"
  ).run(numero, monto ?? null, titular || null, numero_operacion || null, estado || 'confirmado', motivo || null, medio || 'yape', cupos || 1);
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

/** Mapa numero → rol del ÚLTIMO mensaje (para detectar chats sin responder). */
function ultimosRoles() {
  const rows = db.prepare(
    'SELECT m.numero, m.rol FROM mensajes m WHERE m.id IN (SELECT MAX(id) FROM mensajes GROUP BY numero)'
  ).all();
  const mapa = {};
  for (const r of rows) mapa[r.numero] = r.rol;
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

// --- Configuración del negocio (editable en /admin/leads?vista=config) --------
const CAMPOS_CONFIG = [
  'marca', 'yape_numero', 'yape_titular', 'precio_brena', 'precio_comas',
  'grouplink_brena', 'grouplink_comas', 'hora_llegada', 'pago', 'devoluciones',
  'convivencia', 'mecanica', 'bienvenida', 'emojis',
];

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
  for (const clave of CAMPOS_CONFIG) {
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

/** Arma el mismo shape que antes exportaba config/negocio.js, ahora desde la BD. */
function getNegocio() {
  const c = getConfigMap();
  const sedesDe = (zona) => listSedes(zona).map((s) => ({
    nombre: s.nombre, cancha: s.cancha, cupo: s.cupo, ubicacion: s.ubicacion, horario: s.horario, estacionamiento: s.estacionamiento,
  }));
  return {
    marca: c.marca || 'Pichangueros',
    yape: { numero: c.yape_numero || '', titular: c.yape_titular || '', tipo: 'personal' },
    zonas: {
      brena: { nombre: 'Breña', precio: Number(c.precio_brena) || 0, sedes: sedesDe('brena'), groupLink: c.grouplink_brena || null },
      comas: { nombre: 'Comas', precio: Number(c.precio_comas) || 0, sedes: sedesDe('comas'), groupLink: c.grouplink_comas || null },
    },
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

module.exports = {
  getLead, getOrCreateLead, updateLead, saveMessage, getHistory, setHandoff, clearHandoff, stats, listLeads,
  setEstado, setEtiquetas, setSeguimiento, addNota, getNotas, ultimosRoles, deleteLead,
  checkpoint, dbPath: DB_PATH,
  registrarPago, buscarPagoConfirmado, listPagos, pagosPorRevisar, pagadores, numerosPagadores, listPagosTodos,
  getConfigMap, setConfig, listSedes, addSede, updateSede, deleteSede, getNegocio,
};
