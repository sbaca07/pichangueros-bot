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
const backup = require('./backup');

const WEBHOOK_URL = process.env.SHEET_WEBHOOK_URL || '';
const SECRET = process.env.SHEET_SECRET || '';

/**
 * La versión de `google-apps-script.gs` que este código espera del otro lado.
 *
 * El Apps Script se PEGA a mano en el editor de Google y hay que publicar una
 * implementación nueva para que la URL sirva el código nuevo. Si uno pega y no
 * publica, sigue corriendo el anterior — en silencio, con respuestas 200 y todo.
 * El script ya devolvía su `version` en cada sync y nadie la miraba. Ahora se
 * compara: subir esta constante al mismo tiempo que la del .gs.
 */
const VERSION_ESPERADA = 'v4-anchos';

/**
 * El espejo podía estar muerto SEMANAS sin que nadie se enterara: un fallo solo
 * hacía console.error, y los logs de Render no los mira nadie. Mismo patrón que
 * el cerebro (brain.js): al 3.er fallo seguido sale un correo, y como mucho uno
 * por hora para que una caída larga no se vuelva spam.
 */
let fallosSeguidos = 0;
let ultimoAviso = 0;
function registrarFallo(motivo) {
  fallosSeguidos++;
  if (fallosSeguidos >= 3 && Date.now() - ultimoAviso > 3600e3) {
    ultimoAviso = Date.now();
    Promise.resolve(backup.avisar(
      'El espejo a Google Sheets está caído',
      `${fallosSeguidos} sincronizaciones seguidas fallaron. La hoja que mira Clarck está DESACTUALIZADA `
      + '(el panel y el bot siguen bien: esto es solo el espejo).\n\n'
      + `Último error: ${motivo}\n\n`
      + 'Revisar SHEET_WEBHOOK_URL / SHEET_SECRET en Render, y que el Apps Script siga publicado como app web.'
    )).catch(() => {});
  }
}
/** Se avisa UNA vez por versión desalineada: es un estado, no un evento. */
let versionAvisada = null;
function revisarVersion(txt) {
  let version = null;
  try { version = JSON.parse(txt).version || null; } catch (_) { /* respuesta no-JSON: ya se loguea */ }
  if (!version || version === VERSION_ESPERADA) return version;
  if (versionAvisada === version) return version;
  versionAvisada = version;
  console.error(`[sheet] VERSIÓN DESALINEADA: la hoja corre "${version}" y este bot espera "${VERSION_ESPERADA}".`);
  Promise.resolve(backup.avisar(
    'La hoja de Google corre una versión vieja del script',
    `El Web App responde "${version}" y el bot espera "${VERSION_ESPERADA}".\n\n`
    + 'Pegar el código en el editor NO alcanza: hay que Implementar → Gestionar implementaciones → editar → '
    + 'Versión "Nueva" → Implementar. Hasta entonces la hoja se sigue escribiendo con el código anterior.'
  )).catch(() => {});
  return version;
}

// Las zonas ya no son tres fijas: Clarck abrió Chorrillos y Rímac desde el
// panel, y el mapa viejo (brena/comas/otra) las habría escrito en minúscula y
// sin tilde en la hoja que él mira. El nombre sale de la config en vivo.
// La columna "Etapa" se fue el 16/08 con la escalera de estados: exportaba una
// columna congelada que ya no escribe nadie. En su lugar van tres que se
// calculan solos y responden preguntas de verdad — Relación (qué tan cliente
// es), Última vez (cuándo vino) y Datos (cuánto sabemos de él). Los dos ejes
// que la etapa mezclaba, ahora separados en columnas distintas.
const ESTADOS_PAGO = { confirmado: 'Confirmado', revisar: 'Por revisar' };
// El estado del partido dejó de ser una columna que alguien mantiene: se
// calcula (db.fasePartido). La hoja copia la etiqueta ya calculada, así que no
// puede quedar desfasada respecto de lo que ve el bot.
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
  const met = db.metricasPorNumero();

  // "Datos" es el OTRO eje que la etapa mezclaba: cuánto sabemos de la persona.
  // Sin nada no se le puede escribir de nada; completo entra a cualquier lista.
  const nivelDatos = (l) => {
    if (l.nombre && l.edad && l.distrito) return 'Completo';
    return (l.nombre || l.edad || l.distrito) ? 'Parcial' : 'Sin datos';
  };

  const hojaLeads = {
    nombre: 'Leads',
    header: ['Número', 'Nombre', 'Edad', 'Distrito', 'Zona', 'Relación', 'Visitas', 'Última vez',
      'Datos', 'Handoff', 'Motivo', 'Etiquetas', 'Creado', 'Mes de ingreso', 'Actualizado', 'WhatsApp'],
    filas: leads.map((l) => {
      const m = met[l.numero] || { visitas: 0, ultima: null };
      return [
        l.numero, l.nombre || '', l.edad || '', l.distrito || '',
        l.zona ? db.nombreDeZona(l.zona) : '',
        db.RELACIONES[db.relacionDe(m.visitas)].label, m.visitas, m.ultima || '',
        nivelDatos(l), l.handoff ? 'Sí' : '', l.handoff_motivo || '', l.etiquetas || '',
        l.creado_en || '', mes(l.creado_en), l.actualizado_en || '', `https://wa.me/${l.numero}`,
      ];
    }),
    // Fecha de verdad (no texto): así se puede filtrar "los que no vienen desde
    // julio" tildando una casilla, que es para lo que Clarck abre la hoja.
    fechas: [7, 12, 14],
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
    header: ['Fecha', 'Mes', 'Hora', 'Zona', 'Sede', 'Estado', 'Cupo', 'Ocupados', 'Pagados', 'En espera', 'Precio', 'Turno fijo'],
    filas: partidos.map((p) => [
      p.fecha || '', mes(p.fecha), p.hora || '', p.zona ? db.nombreDeZona(p.zona) : '', p.sede || '',
      (db.FASES[p.fase] || {}).corto || '', p.cupo || 0,
      p.ocupados || 0, p.pagados || 0, p.en_espera || 0, soles(p.precio),
      p.turno_id ? 'Sí' : '',
    ]),
    fechas: [0],
    moneda: [10],
  };

  // Resumen: lo que Clarck quiere saber sin filtrar nada. Todo sale de la data
  // de arriba — no hay ningún número calculado en otro lado que pueda diferir.
  const porZona = {};
  for (const l of leads) if (l.zona) porZona[l.zona] = (porZona[l.zona] || 0) + 1;
  const confirmados = pagos.filter((p) => p.estado === 'confirmado');
  // "Por revisar" y "esperando a Clarck" salen de las MISMAS funciones que usa
  // el panel (db.pagosPorRevisar / db.handoffsActivos). Antes cada hoja contaba
  // por su cuenta —todos los 'revisar' de la historia, todos los handoff de
  // siempre— y la hoja decía un número distinto del que veía Clarck en el
  // panel, con los dos "bien" según su propia cuenta.
  const porRevisar = db.pagosPorRevisar();
  const esperando = db.handoffsActivos();
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
      // Mismo criterio que la columna "Datos" de la hoja Leads y que el panel:
      // nombre + edad + distrito. Antes acá se pedía la ZONA en vez del
      // distrito y daba un total distinto al de la columna de al lado.
      ['Con datos completos', leads.filter((l) => nivelDatos(l) === 'Completo').length],
      ['Esperando a Clarck ahora (72 h)', esperando.length],
      ['Derivados en total (histórico)', leads.filter((l) => l.handoff).length],
      ['', ''],
      // El embudo comercial, con la misma métrica que el panel: cada uno es
      // subconjunto del anterior (una visita = un día que vino).
      ['Vinieron alguna vez (1+ visita)', leads.filter((l) => (met[l.numero] || {}).visitas >= 1).length],
      ['Volvieron (2+ visitas)', leads.filter((l) => (met[l.numero] || {}).visitas >= 2).length],
      [`Caseros (${db.RECURRENTE_DESDE}+ visitas)`, leads.filter((l) => (met[l.numero] || {}).visitas >= db.RECURRENTE_DESDE).length],
      ['', ''],
      ...Object.keys(porZona).sort((a, b) => porZona[b] - porZona[a])
        .map((z) => [`Contactos en ${db.nombreDeZona(z)}`, porZona[z]]),
      ['', ''],
      ['Pagos confirmados', confirmados.length],
      ['Recaudado (S/)', recaudado],
      ['Pagos por revisar (cola de hoy)', porRevisar.length],
      ['', ''],
      ['Partidos creados', partidos.length],
      // `estado` es la columna CONGELADA del enum viejo: contarla acá dejaba
      // "Partidos abiertos" pegado en un número que ya no escribe nadie. La
      // fase se calcula (db.fasePartido) y es la misma que ve el bot.
      ['Con inscripción abierta', partidos.filter((p) => p.fase === 'proximo').length],
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
    // Lo que el Apps Script dice que quedó en la hoja: versión, rango del
    // filtro por pestaña, anchos. Va al log para poder verificar el estado real
    // sin que nadie tenga que abrir la hoja y mirar.
    console.log(`[sheet] Respuesta del script: ${txt.slice(0, 900)}`);
    fallosSeguidos = 0;
    const version = revisarVersion(txt);
    return {
      ok: true, n: hojas.find((h) => h.nombre === 'Leads')?.filas.length || 0, hojas: hojas.length,
      version, versionOk: !version || version === VERSION_ESPERADA,
    };
  } catch (e) {
    console.error('[sheet] Error sincronizando:', e.message);
    registrarFallo(e.message);
    return { ok: false, motivo: e.message, fallosSeguidos };
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

module.exports = {
  syncToSheet, programarSync, activo, armarHojas,
  VERSION_ESPERADA, estado: () => ({ fallosSeguidos, versionVista: versionAvisada }),
};
