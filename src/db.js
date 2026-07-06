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

// Migración suave del CRM (2026-06-10): agrega columnas si la BD es anterior.
const colsLeads = db.prepare('PRAGMA table_info(leads)').all().map((c) => c.name);
if (!colsLeads.includes('etiquetas')) db.exec('ALTER TABLE leads ADD COLUMN etiquetas TEXT');
if (!colsLeads.includes('proxima_accion')) db.exec('ALTER TABLE leads ADD COLUMN proxima_accion TEXT'); // fecha YYYY-MM-DD
if (!colsLeads.includes('proxima_nota')) db.exec('ALTER TABLE leads ADD COLUMN proxima_nota TEXT');

const stmtGetLead = db.prepare('SELECT * FROM leads WHERE numero = ?');
const stmtNewLead = db.prepare('INSERT INTO leads (numero) VALUES (?)');
const stmtSaveMsg = db.prepare('INSERT INTO mensajes (numero, rol, texto) VALUES (?, ?, ?)');
const stmtHistory = db.prepare(
  'SELECT rol, texto, creado_en FROM mensajes WHERE numero = ? ORDER BY id DESC LIMIT ?'
);

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
    if (campos[campo] !== undefined && campos[campo] !== null) {
      sets.push(`${campo} = ?`);
      valores.push(campos[campo]);
    }
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

function listLeads() {
  return db
    .prepare('SELECT numero, nombre, edad, distrito, zona, estado, handoff, handoff_motivo, etiquetas, proxima_accion, proxima_nota, creado_en, actualizado_en FROM leads ORDER BY actualizado_en DESC')
    .all();
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
  db.prepare('INSERT INTO notas (numero, texto) VALUES (?, ?)').run(numero, texto);
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

module.exports = {
  getOrCreateLead, updateLead, saveMessage, getHistory, setHandoff, clearHandoff, stats, listLeads,
  setEstado, setEtiquetas, setSeguimiento, addNota, getNotas, ultimosRoles,
  checkpoint, dbPath: DB_PATH,
  getConfigMap, setConfig, listSedes, addSede, updateSede, deleteSede, getNegocio,
};
