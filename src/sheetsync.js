/**
 * Espejo a Google Sheets — backup + visibilidad para Clarck.
 *
 * El bot manda TODOS los leads a un Web App de Google Apps Script (POST con
 * un secreto compartido). Eso deja una copia de la data fuera del disco de
 * Render (backup) y un Sheet que Clarck puede abrir y filtrar (visibilidad).
 *
 * Queda INACTIVO (no-op) si faltan SHEET_WEBHOOK_URL o SHEET_SECRET, así que
 * desplegar este código no rompe nada hasta que se configure en Render.
 *
 * Setup (una vez): crear un Google Sheet → Extensiones → Apps Script → pegar
 * el doPost (ver README / mensaje de setup) → Implementar como app web
 * ("cualquiera con el enlace") → copiar la URL a SHEET_WEBHOOK_URL y usar el
 * mismo secreto en ambos lados.
 */
const WEBHOOK_URL = process.env.SHEET_WEBHOOK_URL || '';
const SECRET = process.env.SHEET_SECRET || '';

// Las zonas ya no son tres fijas: Clarck abrió Chorrillos y Rímac desde el
// panel, y el mapa viejo (brena/comas/otra) las habría escrito en minúscula y
// sin tilde en la hoja que él mira. El nombre sale de la config en vivo.
const ESTADOS = {
  nuevo: 'Nuevo', datos_completos: 'Completo', invitado_grupo: 'En grupo',
  activo: 'Jugador', lista_espera: 'En espera', inactivo: 'Inactivo',
};

const ESTADOS_PAGO = { confirmado: 'Confirmado', revisar: 'Por revisar' };
const ESTADOS_PARTIDO = { abierto: 'Abierto', cerrado: 'Cerrado', jugado: 'Jugado', cancelado: 'Cancelado' };
const MEDIOS = {
  yape: 'Yape', plin: 'Plin', bcp: 'BCP', interbank: 'Interbank',
  bbva: 'BBVA', scotiabank: 'Scotiabank', otro: 'Otro',
};

const activo = () => Boolean(WEBHOOK_URL && SECRET);

const soles = (n) => (n == null ? '' : Number(n));

/**
 * Columnas de Día y Mes al lado de cada fecha.
 *
 * Un timestamp con hora y minuto es único por fila, así que el filtro por
 * valores de Sheets ofrece una lista de 296 opciones distintas y no sirve para
 * nada: para preguntar "¿cuánto entró en agosto?" hay que armar una condición,
 * y eso ya es pedirle demasiado a quien solo quiere tildar una casilla. Con
 * estas dos columnas se tilda "Agosto" igual que se tilda "Comas".
 *
 * Van como TEXTO a propósito: lo que se busca es agrupar, y el orden
 * cronológico lo sigue dando la columna de fecha de al lado. El mes arranca con
 * el año-mes numérico para que ordene bien igual.
 */
const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Setiembre', 'Octubre', 'Noviembre', 'Diciembre'];
const partesFecha = (ts) => String(ts || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
const dia = (ts) => { const m = partesFecha(ts); return m ? `${m[3]}/${m[2]}/${m[1]}` : ''; };
const mes = (ts) => { const m = partesFecha(ts); return m ? `${m[1]}-${m[2]} · ${MESES[+m[2] - 1]}` : ''; };

/**
 * Las cuatro pestañas que se mandan en cada sync. Cada una es
 * {nombre, header, filas} más dos listas de índices de columna: `fechas` (las
 * convierte a fecha de verdad, si no Sheets las trata como texto y no se puede
 * filtrar "esta semana") y `moneda` (formato S/). El Apps Script las escribe
 * genéricamente, así que agregar una vista mañana es tocar solo este archivo.
 *
 * Leads solo no alcanzaba: Clarck mira la plata, y una hoja sin un sol adentro
 * no le dice nada de su negocio.
 */
function armarHojas(db) {
  const leads = db.listLeads();
  const pagos = db.listPagosTodos();
  const partidos = db.listPartidos();

  const hojaLeads = {
    nombre: 'Leads',
    header: ['Número', 'Nombre', 'Edad', 'Distrito', 'Zona', 'Etapa', 'Handoff', 'Motivo',
      'Etiquetas', 'Próxima acción', 'Nota seguimiento', 'Creado', 'Mes de ingreso', 'Actualizado', 'WhatsApp'],
    filas: leads.map((l) => [
      l.numero, l.nombre || '', l.edad || '', l.distrito || '',
      l.zona ? db.nombreDeZona(l.zona) : '', ESTADOS[l.estado] || l.estado || '',
      l.handoff ? 'Sí' : '', l.handoff_motivo || '', l.etiquetas || '',
      l.proxima_accion || '', l.proxima_nota || '', l.creado_en || '', mes(l.creado_en),
      l.actualizado_en || '', `https://wa.me/${l.numero}`,
    ]),
    fechas: [11, 13],
  };

  const hojaPagos = {
    nombre: 'Pagos',
    header: ['Fecha', 'Día', 'Mes', 'Número', 'Nombre', 'Zona', 'Monto', 'Medio', 'Estado',
      'Cupos', 'Titular del voucher', 'Nº operación', 'Motivo', 'WhatsApp'],
    filas: pagos.map((p) => [
      p.creado_en || '', dia(p.creado_en), mes(p.creado_en),
      p.numero, p.nombre || '', p.zona ? db.nombreDeZona(p.zona) : '',
      soles(p.monto), MEDIOS[p.medio] || p.medio || '', ESTADOS_PAGO[p.estado] || p.estado || '',
      p.cupos || 1, p.titular || '', p.numero_operacion || '', p.motivo || '',
      `https://wa.me/${p.numero}`,
    ]),
    fechas: [0],
    moneda: [6],
  };

  const hojaPartidos = {
    nombre: 'Partidos',
    header: ['Fecha', 'Mes', 'Hora', 'Zona', 'Sede', 'Estado', 'Cupo', 'Ocupados', 'Pagados', 'En espera', 'Precio'],
    filas: partidos.map((p) => [
      p.fecha || '', mes(p.fecha), p.hora || '', p.zona ? db.nombreDeZona(p.zona) : '', p.sede || '',
      ESTADOS_PARTIDO[p.estado] || p.estado || '', p.cupo || 0,
      p.ocupados || 0, p.pagados || 0, p.en_espera || 0, soles(p.precio),
    ]),
    fechas: [0],
    moneda: [10],
  };

  // Resumen: lo que Clarck quiere saber sin filtrar nada. Todo sale de la data
  // de arriba — no hay ningún número calculado en otro lado que pueda diferir.
  const porZona = {};
  for (const l of leads) if (l.zona) porZona[l.zona] = (porZona[l.zona] || 0) + 1;
  const confirmados = pagos.filter((p) => p.estado === 'confirmado');
  const porRevisar = pagos.filter((p) => p.estado === 'revisar');
  const recaudado = confirmados.reduce((s, p) => s + (Number(p.monto) || 0), 0);

  const hojaResumen = {
    nombre: 'Resumen',
    header: ['Indicador', 'Valor'],
    filas: [
      // Primero de todo, porque es lo único que hay que saber para no perder
      // trabajo: esta hoja se mira, no se edita.
      ['⚠️ Esta hoja se reescribe sola cada 6 horas', 'Para cambiar algo entrá al panel — lo que escribas acá se pierde'],
      ['', ''],
      ['Contactos totales', leads.length],
      ['Con datos completos', leads.filter((l) => l.nombre && l.edad && l.zona).length],
      ['Esperando a Clarck (handoff)', leads.filter((l) => l.handoff).length],
      ['', ''],
      ...Object.keys(porZona).sort((a, b) => porZona[b] - porZona[a])
        .map((z) => [`Contactos en ${db.nombreDeZona(z)}`, porZona[z]]),
      ['', ''],
      ['Pagos confirmados', confirmados.length],
      ['Recaudado (S/)', recaudado],
      ['Pagos por revisar', porRevisar.length],
      ['', ''],
      ['Partidos creados', partidos.length],
      ['Partidos abiertos', partidos.filter((p) => p.estado === 'abierto').length],
      ['Cupos vendidos (pagados)', partidos.reduce((s, p) => s + (p.pagados || 0), 0)],
      ['', ''],
      ['Última sincronización', new Date().toLocaleString('es-PE', { timeZone: 'America/Lima' })],
    ],
  };

  return [hojaResumen, hojaLeads, hojaPagos, hojaPartidos];
}

async function syncToSheet(db) {
  if (!activo()) return { ok: false, motivo: 'no configurado (faltan SHEET_WEBHOOK_URL / SHEET_SECRET)' };
  const hojas = armarHojas(db);
  try {
    const res = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: SECRET, hojas }),
      redirect: 'follow',
    });
    const txt = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status} ${txt.slice(0, 140)}`);
    const detalle = hojas.map((h) => `${h.nombre} ${h.filas.length}`).join(' · ');
    console.log(`[sheet] Sincronizado → Google Sheet: ${detalle}.`);
    return { ok: true, n: hojas.find((h) => h.nombre === 'Leads')?.filas.length || 0, hojas: hojas.length };
  } catch (e) {
    console.error('[sheet] Error sincronizando:', e.message);
    return { ok: false, motivo: e.message };
  }
}

/** Sincronización periódica (al arrancar + cada N horas). No hace nada si está inactivo. */
function programarSync(db, horas = 6) {
  if (!activo()) {
    console.log('[sheet] Espejo a Google Sheet inactivo (sin SHEET_WEBHOOK_URL/SHEET_SECRET).');
    return;
  }
  setTimeout(() => syncToSheet(db), 30_000); // 30 s después de arrancar
  setInterval(() => syncToSheet(db), horas * 3600e3);
  console.log(`[sheet] Espejo a Google Sheet activo (cada ${horas} h).`);
}

module.exports = { syncToSheet, programarSync, activo, armarHojas };
