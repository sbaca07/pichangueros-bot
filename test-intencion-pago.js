/**
 * Para qué es el pago: la conversación decide cuando la aritmética no alcanza.
 *
 *   node test-intencion-pago.js        (~10 s, sin red)
 *
 * Caso real del 15/08: Anthony yapeó S/20 por dos cupos del DOMINGO y el
 * sistema se los metió en el Comas de ESE día 9-10am, terminado una hora antes.
 * El único candidato de su zona era ése, así que la aritmética lo dio por
 * bueno. La conversación decía lo contrario, y nadie la leía.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pich-int-'));
process.env.WWEBJS_AUTH_PATH = TMP;
process.env.OPENAI_API_KEY = 'sk-no-se-usa';
delete process.env.OPENAI_BASE_URL;

const db = require('./src/db');
const pagos = require('./src/pagos');

let ok = 0, fallos = 0;
const check = (nombre, cond) => { if (cond) { ok++; console.log(`  ✓ ${nombre}`); } else { fallos++; console.error(`  ✗ ${nombre}`); } };

const hoy = db.hoyLima();
const manana = new Date(Date.now() - 5 * 3600e3 + 86400e3).toISOString().slice(0, 10);
const horaAhora = Number(new Date(Date.now() - 5 * 3600e3).toISOString().slice(11, 13));
const comoTexto = (h) => `${h % 12 || 12}${h < 12 ? 'am' : 'pm'}`;

// El intérprete, guionado: acá no se prueba al modelo sino qué hace el sistema
// con lo que el modelo devuelve.
let intencionDevuelta = null;
let vecesLlamado = 0;
let historialVisto = null;
pagos.interpretarPago = async (historial) => { vecesLlamado++; historialVisto = historial; return intencionDevuelta; };
pagos.leerVoucher = async () => ({ es_comprobante_pago: true, monto: 20, nombre_remitente: 'Anthony Bernal', numero_operacion: 'OP-' + Date.now(), medio: 'yape', confianza: 'alta' });

const N = '51900777888';

(async () => {
  db.getOrCreateLead(N);
  db.updateLead(N, { nombre: 'Anthony Bernal', zona: 'comas' });

  console.log('== 1 · Con UN solo candidato no se gasta una llamada ==');
  const unico = db.crearPartido({ zona: 'comas', fecha: manana, hora: '6-7pm', sede: 'Politécnico', cupo: 12, precio: 10 });
  vecesLlamado = 0;
  let res = await pagos.procesarVoucher(N, 'comas', Buffer.from('x'));
  check('el pago se asignó', /Ya estás en la lista/.test(res.respuesta));
  check('sin leer la conversación', vecesLlamado === 0);
  check('sin alerta para Clarck', !res.alerta);

  console.log('== 2 · Con DOS candidatos, la conversación desempata ==');
  // Dos partidos de Comas al mismo precio: la aritmética no puede elegir.
  const domingo = db.crearPartido({ zona: 'comas', fecha: manana, hora: '8-9pm', sede: 'Politécnico', cupo: 12, precio: 10 });
  db.saveMessage(N, 'assistant', 'Me quedan dos cupos para este domingo 6pm');
  db.saveMessage(N, 'user', 'Para reservar los cupos del domingo, son dos verdad');
  intencionDevuelta = { partido_id: domingo.id ?? domingo, cupos: 2, confianza: 'alta', motivo: '"los cupos del domingo, son dos"', partido_no_cargado: false };
  vecesLlamado = 0;
  res = await pagos.procesarVoucher(N, 'comas', Buffer.from('x'));
  check('esta vez sí leyó la conversación', vecesLlamado === 1);
  check('y le llegaron los dos lados de la charla',
    historialVisto.some((m) => m.rol === 'assistant') && historialVisto.some((m) => m.rol === 'user'));
  check('se asignó al partido que dijo la conversación', /Ya estás en la lista/.test(res.respuesta));
  const insc = db.inscripcionesDe(domingo.id ?? domingo);
  check('con los DOS cupos (él y su invitado)', insc.filter((i) => i.estado === 'pagado').length === 2);

  console.log('== 3 · Con confianza baja NO se adivina: queda suelto y avisa ==');
  const otro = '51900777999';
  db.getOrCreateLead(otro); db.updateLead(otro, { nombre: 'Dudoso', zona: 'comas' });
  intencionDevuelta = { partido_id: domingo.id ?? domingo, cupos: 1, confianza: 'baja', motivo: 'no lo dice claro', partido_no_cargado: false };
  res = await pagos.procesarVoucher(otro, 'comas', Buffer.from('x'));
  check('el pago NO se asignó', !/Ya estás en la lista/.test(res.respuesta));
  check('se le avisa a Clarck', Boolean(res.alerta));
  check('con la corazonada citada', /no lo dice claro/.test(res.alerta));

  console.log('== 4 · Partido vendido y NO cargado: la alerta que faltaba ==');
  const tercero = '51900778000';
  db.getOrCreateLead(tercero); db.updateLead(tercero, { nombre: 'Anthony', zona: 'comas' });
  intencionDevuelta = { partido_id: null, cupos: 2, confianza: 'alta', motivo: 'acordaron el domingo 6pm en Comas', partido_no_cargado: true };
  res = await pagos.procesarVoucher(tercero, 'comas', Buffer.from('x'));
  check('no se inventa un partido', !/Ya estás en la lista/.test(res.respuesta));
  check('avisa que el partido no está cargado', /NO está cargado/.test(res.alerta || ''));
  check('y dice qué pasa si nadie lo carga', /cancha que nadie reservó/.test(res.alerta || ''));

  console.log('== 5 · Nunca se mete a nadie en un partido cerrado ==');
  db.setEstadoPartido(domingo.id ?? domingo, 'cerrado');
  const cuarto = '51900778111';
  db.getOrCreateLead(cuarto); db.updateLead(cuarto, { nombre: 'Tarde', zona: 'comas' });
  intencionDevuelta = { partido_id: domingo.id ?? domingo, cupos: 1, confianza: 'alta', motivo: 'dijo el domingo', partido_no_cargado: false };
  res = await pagos.procesarVoucher(cuarto, 'comas', Buffer.from('x'));
  check('la pista se ignora si el partido ya no está abierto',
    !db.inscripcionesDe(domingo.id ?? domingo).some((i) => i.numero === cuarto));

  console.log(`\n${fallos ? '❌' : '✅'} ${ok} checks OK, ${fallos} fallos`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  process.exit(fallos ? 1 : 0);
})();
