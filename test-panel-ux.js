/**
 * UX/UI del panel — crawler + casuísticas de navegación (sin red, BD temporal).
 *
 *   node test-panel-ux.js
 *
 * Dos capas:
 *   1. CRAWLER: parte del home, sigue TODOS los links internos (profundidad 3)
 *      y exige 200 en cada uno — ningún clic puede llevar a un 404/500.
 *   2. CASUÍSTICAS: cada elemento clickeable importante lleva a donde promete
 *      (stats → CRM filtrado, partido → detalle, ficha → chat/acciones,
 *      exports descargan, POSTs redirigen a una página viva).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.WWEBJS_AUTH_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'pich-ux-'));
process.env.ADMIN_KEY = 'ux';
process.env.SAFE_MODE = 'true';
process.env.ALLOWED_TESTERS = '51900000001';

const db = require('./src/db');
const { registrarPanel } = require('./src/panel');
const express = require('./node_modules/express');

// --- Semilla realista: leads de todo tipo, partido con de todo ---------------
const enDias = (n) => new Date(Date.now() - 5 * 3600e3 + n * 86400e3).toISOString().slice(0, 10);

/**
 * Un partido que YA se jugó, con su gente adentro.
 *
 * Desde el 17/08 no se puede anotar a nadie en un partido que terminó hace más
 * de 24 h (la GRACIA), así que la historia vieja se construye: se abre a
 * futuro, se anota a los jugadores y recién ahí se le mueve la fecha al pasado.
 * El slot futuro se reutiliza porque al mover la fecha queda libre de nuevo.
 */
let slotLibre = 60;
const partidoJugado = (fecha, jugadores, extra = {}) => {
  // Cada llamada usa un slot futuro PROPIO: desde el 17/08 dos partidos de la
  // misma cancha, día y hora son el mismo partido, y un slot compartido
  // devolvería el gemelo y mezclaría dos listas en una.
  const id = db.crearPartido({ zona: 'brena', fecha: enDias(slotLibre++), hora: '10-11pm', cupo: 20, ...extra });
  for (const j of jugadores) db.inscribir(id, j);
  // Si la fecha destino ya está ocupada, que reviente acá y no tres tests
  // despues con un partido que quedo en el futuro sin que nadie se enterara.
  const r = db.actualizarPartido(id, { fecha });
  if (!r.ok) throw new Error(`partidoJugado(${fecha}) no pudo mover la fecha: ${r.motivo}`);
  return id;
};
const L = {
  tester: '51900000001', completo: '51911111111', handoff: '51922222222',
  espera: '51933333333', pagador: '51944444444', nuevo: '51955555555',
};
for (const n of Object.values(L)) { db.getOrCreateLead(n); db.saveMessage(n, 'user', 'hola'); }
// Ya no se siembran "etapas": la relación se deriva de los pagos y partidos que
// se cargan más abajo, que es justo lo que hay que poder verificar.
db.updateLead(L.completo, { nombre: 'María Prueba', edad: 28, distrito: 'Breña', zona: 'brena' });
db.updateLead(L.pagador, { nombre: 'Pablo Pagador', zona: 'comas' });
db.marcarGrupoEnviado(L.pagador, enDias(-4));
db.updateLead(L.espera, { nombre: 'Elsa Espera', zona: 'otra', distrito: 'Ate' });
db.setHandoff(L.handoff, 'Queja de prueba');
db.setEtiquetas(L.completo, 'casero,VIP');
db.addNota(L.completo, 'nota de prueba');
const partido = db.crearPartido({ zona: 'brena', fecha: enDias(1), hora: '8-9pm', sede: 'Melgar UX', cupo: 2 });
db.inscribir(partido, L.completo);
db.inscribir(partido, L.pagador);
const enEspera = db.inscribir(partido, L.espera);
const pagoOk = db.registrarPago({ numero: L.pagador, monto: 15, numero_operacion: 'UX-1', estado: 'confirmado' });
db.vincularPago(L.pagador, pagoOk, 1, 'comas', 15);
db.registrarPago({ numero: L.nuevo, monto: 7, numero_operacion: 'UX-2', estado: 'revisar', motivo: 'Monto raro' });
db.registrarPago({ numero: L.nuevo, monto: 15, numero_operacion: 'UX-3', estado: 'confirmado' }); // suelto sin partido

const app = express();
registrarPanel(app, db, {
  estado: () => 'ready', numero: () => '51967870413', qr: () => null,
  desconectar: async () => true, enviar: async () => ({ ok: true, id: 'x' }),
});

let ok = 0, fallos = 0;
const check = (nombre, cond, extra = '') => { if (cond) { ok++; console.log(`  ✓ ${nombre}`); } else { fallos++; console.error(`  ✗ ${nombre} ${extra}`); } };

const srv = app.listen(0, async () => {
  const B = `http://127.0.0.1:${srv.address().port}`;
  const GET = async (ruta) => { const r = await fetch(B + ruta); return { status: r.status, html: await r.text() }; };
  const POST = async (ruta, obj) => {
    const r = await fetch(B + ruta, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(obj).toString(), redirect: 'manual' });
    return { status: r.status, location: r.headers.get('location') || '' };
  };

  console.log('== 1 · CRAWLER: ningún clic del panel puede dar 404/500 ==');
  const vistos = new Set();
  const porVisitar = ['/admin/leads?key=ux'];
  let rotos = 0, visitados = 0;
  while (porVisitar.length && visitados < 200) {
    const ruta = porVisitar.shift();
    if (vistos.has(ruta)) continue;
    vistos.add(ruta); visitados++;
    const { status, html } = await GET(ruta);
    if (status !== 200) { rotos++; console.error(`  ✗ ${status} en ${ruta}`); continue; }
    // Solo páginas HTML del panel siguen aportando links (los exports no).
    if (!ruta.startsWith('/admin/leads?')) continue;
    for (const m of html.matchAll(/href="(\/admin[^"]+)"/g)) {
      const href = m[1].replace(/&amp;/g, '&');
      if (!vistos.has(href)) porVisitar.push(href);
    }
  }
  check(`${visitados} URLs internas visitadas, 0 rotas`, rotos === 0, `(${rotos} rotas)`);

  console.log('== 2 · Los clics llevan a donde prometen ==');
  const home = (await GET('/admin/leads?key=ux')).html;
  check('el hero del partido linkea a SU detalle', home.includes(`vista=partidos&partido=${partido}`));
  const crmResp = (await GET('/admin/leads?key=ux&vista=crm&filtro=responder')).html;
  check('stat "Sin responder" → CRM muestra al tester (único real en modo seguro)', crmResp.includes(L.tester));
  check('…y NO a los silenciados por diseño', !crmResp.includes(L.nuevo));
  const crmHandoff = (await GET('/admin/leads?key=ux&vista=crm&filtro=handoff')).html;
  check('chip "Clarck" → muestra al derivado', crmHandoff.includes('Queja de prueba'));
  const crmZona = (await GET('/admin/leads?key=ux&vista=crm&zona=brena')).html;
  check('fila de zona → CRM filtrado por Breña', crmZona.includes('María Prueba') && !crmZona.includes('Pablo Pagador'));
  const crmCombo = (await GET('/admin/leads?key=ux&vista=crm&zona=brena&filtro=responder')).html;
  check('los chips COMBINAN sin romperse', crmCombo.length > 500);
  const ficha = (await GET(`/admin/leads?key=ux&numero=${L.completo}`)).html;
  check('ficha: botón WhatsApp con wa.me', ficha.includes(`wa.me/${L.completo}`));
  check('ficha: muestra chat, etiquetas y notas', ficha.includes('hola') && ficha.includes('casero') && ficha.includes('nota de prueba'));
  const detalle = (await GET(`/admin/leads?key=ux&vista=partidos&partido=${partido}`)).html;
  check('detalle del partido: inscritos con link a su ficha', detalle.includes(`numero=${L.completo}`));
  check('detalle: la espera y la lista copiable presentes', detalle.includes('Elsa Espera') && detalle.includes('Copiar lista'));
  check('detalle: pago suelto reciente ofrecido para asignar', detalle.includes('Asignar acá'));
  const pagos7d = (await GET('/admin/leads?key=ux&vista=pagos')).html;
  check('La plata abre en 7 días con el histórico a un clic', pagos7d.includes('Últimos 7 días') && pagos7d.includes('Todo el histórico'));

  console.log('== 2b · NADA clickeable es decorativo ni ambiguo ==');
  // Toda tarjeta .stat debe ser un <a> con destino propio: una métrica que no
  // lleva a su detalle es un callejón sin salida (hallazgo de Sebas, 11-ago).
  for (const [vista, nombre] of [['', 'Hoy'], ['&vista=pagos', 'La plata']]) {
    const html = (await GET(`/admin/leads?key=ux${vista}`)).html;
    const muertas = [...html.matchAll(/<div class="stat[^"]*">([\s\S]*?)<\/div>\s*<\/div>/g)].length;
    check(`${nombre}: ninguna tarjeta de métrica es un div muerto`, muertas === 0, `(${muertas} sin link)`);
  }
  const pagosHtml = (await GET('/admin/leads?key=ux&vista=pagos')).html;
  check('La plata: "Cobrado" lleva a los pagos que lo componen', /Cobrado[^<]*›/.test(pagosHtml) && pagosHtml.includes('estado=conf'));
  check('La plata: "Cupos pagados" lleva a Partidos', pagosHtml.includes('vista=partidos'));
  const filtrado = (await GET('/admin/leads?key=ux&vista=pagos&estado=rev')).html;
  check('el filtro activo se ve marcado en su tarjeta', /class="stat[^"]*sel/.test(filtrado));
  check('…y ofrece quitarlo con ✕', filtrado.includes('Por revisar ✕'));
  // Cada destino de las tarjetas debe existir de verdad.
  for (const m of pagosHtml.matchAll(/<a class="stat[^"]*" href="([^"]+)"/g)) {
    const destino = m[1].replace(/&amp;/g, '&');
    const r = await GET(destino);
    check(`destino vivo: ${destino.replace(/key=ux&?/, '').slice(0, 46)}`, r.status === 200);
  }

  console.log('== 3 · Exports y descargas responden ==');
  for (const ruta of ['/admin/leads.csv?key=ux', '/admin/leads.xlsx?key=ux', '/admin/backup-db?key=ux']) {
    check(`GET ${ruta.split('?')[0]}`, (await GET(ruta)).status === 200);
  }

  console.log('== 4 · Cada POST redirige a una página viva ==');
  const posts = [
    ['/admin/lead/grupo', { key: 'ux', numero: L.completo }],
    ['/admin/lead/etiquetas', { key: 'ux', numero: L.completo, etiquetas: 'vip' }],
    ['/admin/lead/nota', { key: 'ux', numero: L.completo, texto: 'otra nota' }],
    ['/admin/lead/reactivar', { key: 'ux', numero: L.handoff }],
    ['/admin/partido', { key: 'ux', zona: 'comas', fecha: enDias(3), hora: '9pm', cupo: 10 }],
    ['/admin/partido/estado', { key: 'ux', id: partido, estado: 'cerrado' }],
    ['/admin/partido/inscribir', { key: 'ux', partido_id: partido, nombre: 'Invitado UX' }],
    ['/admin/inscripcion/estado', { key: 'ux', id: enEspera.inscripcion.id, partido_id: partido, estado: 'baja' }],
    ['/admin/config/general', { key: 'ux', marca: 'Pichangueros' }],
    ['/admin/config/zona', { key: 'ux', zona: 'brena', precio: '15', grouplink: '', nombre_mostrar: 'Breña' }],
    ['/admin/config/zona/nueva', { key: 'ux', nombre: 'San Borja', precio: '15', sede: 'Cancha UX', cupo: '12' }],
  ];
  for (const [ruta, body] of posts) {
    const r = await POST(ruta, body);
    const destinoOk = r.status === 302 && (await GET(r.location.replace(B, ''))).status === 200;
    check(`POST ${ruta}`, destinoOk, `(HTTP ${r.status} → ${r.location.slice(0, 60)})`);
  }
  check('el distrito nuevo quedó operativo tras el POST', db.zonasOperativas().includes('sanborja'));

  console.log('== 4b · Editar un partido ya creado (sin cancelar y rehacer) ==');
  {
    // Hasta ahora un partido se podía abrir, cerrar, cancelar y borrar, pero no
    // ARREGLAR: una hora mal cargada obligaba a cancelar y rehacer, dejando
    // afuera a los inscritos. De ahí salieron los "Cancelado" vacíos.
    const detalle = await GET(`/admin/leads?key=ux&vista=partidos&partido=${partido}`);
    check('el detalle ofrece "Editar este partido"', /Editar este partido/.test(detalle.html));
    check('el editor viene plegado (no tapa la lista)', !/<details class="editor[^"]*"[^>]*\sopen/.test(detalle.html));

    const antes = db.getPartido(partido);
    const r = await POST('/admin/partido/editar', {
      key: 'ux', id: partido, zona: antes.zona, fecha: antes.fecha,
      hora: '9pm', sede: 'Cancha Corregida', cupo: '20', precio: '18',
    });
    check('POST /admin/partido/editar redirige a una página viva',
      r.status === 302 && (await GET(r.location.replace(B, ''))).status === 200);
    const p2 = db.getPartido(partido);
    check('la hora se normaliza al guardar (9pm → 9-10pm)', p2.hora === '9-10pm', p2.hora);
    check('la sede cambió', p2.sede === 'Cancha Corregida', p2.sede);
    check('el cupo cambió', p2.cupo === 20, String(p2.cupo));
    check('el precio cambió', Number(p2.precio) === 18, String(p2.precio));
    check('los inscritos siguen adentro', db.inscripcionesDe(partido).length > 0);

    // El cupo no puede dejar gente afuera en silencio. Va en un partido propio:
    // el de arriba lo cerraron los bloques anteriores y ahí `inscribir` rechaza,
    // así que el caso dependía del orden de los tests en vez de la regla.
    const lleno = db.crearPartido({ zona: 'brena', fecha: enDias(4), hora: '8-9pm', cupo: 10 });
    for (const n of ['51970000001', '51970000002', '51970000003', '51970000004']) db.inscribir(lleno, n);
    const dentro = db.inscripcionesDe(lleno).filter((i) => ['pagado', 'reservado'].includes(i.estado)).length;
    check(`hay ${dentro} jugadores adentro para probar el recorte`, dentro === 4, String(dentro));
    const rechazo = db.actualizarPartido(lleno, { cupo: '2' });
    check('bajar el cupo por debajo de los inscritos se rechaza', rechazo.ok === false, JSON.stringify(rechazo));
    check('…y el motivo dice cuántos hay adentro', /ya hay \d+ jugadores/.test(rechazo.motivo || ''), rechazo.motivo);
    check('…y el cupo NO se tocó', db.getPartido(lleno).cupo === 10, String(db.getPartido(lleno).cupo));

    const conError = await POST('/admin/partido/editar', { key: 'ux', id: lleno, cupo: '2' });
    const pagina = await GET(conError.location.replace(B, ''));
    check('un rechazo vuelve con el aviso visible', /ya hay/.test(pagina.html), 'sin aviso en la página');
    check('…y deja el editor ABIERTO para corregir', /<details class="editor[^"]*"[^>]*\sopen/.test(pagina.html));

    check('editar un partido inexistente no rompe', db.actualizarPartido(999999, { hora: '8pm' }).ok === false);
    check('guardar sin cambios avisa en vez de mentir', db.actualizarPartido(partido, {}).ok === false);
  }

  console.log('== 4c · Cinco pestañas con sentido, no seis ==');
  {
    // "Conexión" mostraba el QR de Baileys. Con el canal oficial qr() devuelve
    // null SIEMPRE, así que era una pantalla que se autorefrescaba cada 6 s
    // esperando un código que no llega. Se fue; su dato vivo está en Ajustes.
    const home = (await GET('/admin/leads?key=ux')).html;
    const tabs = [...home.matchAll(/class="tab [^"]*"[^>]*>(?:<svg[\s\S]*?<\/svg>)?([^<]+)</g)].map((m) => m[1].trim());
    check(`la barra tiene 5 pestañas: ${tabs.join(' · ')}`, tabs.length === 5, `(${tabs.length})`);
    check('y son las de la propuesta v2', tabs.join(',') === 'Resumen,Partidos,Jugadores,Pagos,Ajustes', tabs.join(','));
    check('ya no hay pestaña Conexión', !/vista=conexion/.test(home));

    const viejo = await fetch(`${B}/admin/leads?key=ux&vista=conexion`, { redirect: 'manual' });
    check('un link viejo a Conexión redirige, no muere en 404', viejo.status === 302, `HTTP ${viejo.status}`);
    const ajustes = (await GET('/admin/leads?key=ux&vista=config')).html;
    check('Ajustes dice qué número está atendiendo', /Canal de WhatsApp/.test(ajustes) && /51967870413/.test(ajustes));
    check('…y explica que con canal oficial no hay QR', /no se enlaza por QR/.test(ajustes));
  }

  console.log('== 4d · La caja del partido: no solo cuánta gente, cuánta plata ==');
  {
    const conCaja = db.crearPartido({ zona: 'brena', fecha: enDias(5), hora: '8-9pm', sede: 'Cancha Caja', cupo: 10, precio: 15 });
    db.addSede({ zona: 'brena', nombre: 'Cancha Caja', cupo: 10, costo: 150 });
    db.inscribir(conCaja, '51980000001');
    db.inscribir(conCaja, '51980000002');
    const pg = db.registrarPago({ numero: '51980000001', monto: 15, numero_operacion: 'CJ-UX', estado: 'confirmado' });
    db.vincularPago('51980000001', pg, 1, 'brena', 15);

    const k = db.cajaPartido(conCaja);
    check('cobrado sale de los pagos confirmados enganchados', k.cobrado === 15, JSON.stringify(k));
    check('por cobrar = reservados sin pagar × precio', k.porCobrar === 15, JSON.stringify(k));
    check('el costo de la cancha sale de la sede', k.costoCancha === 150, JSON.stringify(k));

    const html = (await GET(`/admin/leads?key=ux&vista=partidos&partido=${conCaja}`)).html;
    check('la pantalla muestra Cobrado y Por cobrar', /Cobrado/.test(html) && /Por cobrar/.test(html));
    check('…y cuánto falta para cubrir la cancha', /Faltan S\/ 135/.test(html), 'sin el resultado de la cancha');

    // Un solo Yape que paga por varios NO puede contarse dos veces.
    const dobles = db.crearPartido({ zona: 'brena', fecha: enDias(6), cupo: 10, precio: 15 });
    db.inscribir(dobles, '51980000003');
    const pgDoble = db.registrarPago({ numero: '51980000003', monto: 30, numero_operacion: 'CJ-DOB', estado: 'confirmado', cupos: 2 });
    db.vincularPago('51980000003', pgDoble, 2, 'brena', 30);
    check('un Yape por 2 cupos suma una sola vez', db.cajaPartido(dobles).cobrado === 30, JSON.stringify(db.cajaPartido(dobles)));

    const sinCosto = db.crearPartido({ zona: 'comas', fecha: enDias(7), cupo: 10 });
    const htmlSin = (await GET(`/admin/leads?key=ux&vista=partidos&partido=${sinCosto}`)).html;
    check('sin costo cargado, invita a ponerlo en vez de mentir', /Poner costo/.test(htmlSin));
  }

  console.log('== 4e · Las tres pantallas restantes de la propuesta v2 ==');
  {
    // RESUMEN: las zonas estaban escritas a mano (Breña/Comas/Otras). Rímac y
    // Chorrillos ya tenían leads, sedes y partidos y aun así no se dibujaban:
    // contaban como clasificadas y después nadie las mostraba.
    db.getOrCreateLead('51990000001'); db.updateLead('51990000001', { zona: 'sanborja', nombre: 'Zona Nueva' });
    const resumen = (await GET('/admin/leads?key=ux')).html;
    check('el desglose por zona incluye un distrito creado desde Ajustes', /San Borja/.test(resumen));
    check('"otra" se lee como lo que es: gente sin cancha cerca', /Sin sede cerca/.test(resumen) || !/zona=otra/.test(resumen));

    // La plata parada se ve arriba, no al final de la página.
    const posAlerta = resumen.indexOf('pago') >= 0 ? resumen.indexOf('por revisar') : -1;
    const posComunidad = resumen.indexOf('La comunidad');
    check('la alerta de pagos por revisar va ANTES del detalle', posAlerta !== -1 && posAlerta < posComunidad, `alerta=${posAlerta} comunidad=${posComunidad}`);
    check('…y lleva a los pagos ya filtrados', /vista=pagos&estado=rev/.test(resumen));

    // JUGADORES: un filtro de zona que el código no conoce se ignoraba en
    // silencio y mostraba a TODOS, como si el filtro no existiera.
    const crmNueva = (await GET('/admin/leads?key=ux&vista=crm&zona=sanborja')).html;
    check('filtrar por un distrito nuevo devuelve solo a los suyos', /Zona Nueva/.test(crmNueva) && !/Pablo Pagador/.test(crmNueva));


    // FICHA: mostraba quién es, no qué ha hecho.
    const pgF = db.registrarPago({ numero: L.completo, monto: 45, numero_operacion: 'FICHA-1', estado: 'confirmado' });
    const partF = db.crearPartido({ zona: 'brena', fecha: enDias(2), hora: '8-9pm', cupo: 10 });
    db.inscribir(partF, L.completo);
    db.vincularPago(L.completo, pgF, 1, 'brena', 45);
    const ficha = (await GET(`/admin/leads?key=ux&numero=${L.completo}`)).html;
    check('la ficha trae la historia del jugador', /Historia/.test(ficha));
    check('…primer contacto', /Primer contacto/.test(ficha) && /lo captó el bot/.test(ficha));
    // Los cuatro números viven arriba, en los cuadros destacados — no repetidos
    // como filas de "Historia", que era el estado anterior.
    check('…los cuatro destacados arriba', /class="hl"/.test(ficha)
      && /Visitas/.test(ficha) && /Pagado/.test(ficha) && /Última/.test(ficha) && /Próxima/.test(ficha));
    // Tiene reserva futura: el cuadro trae la fecha (no un guion) y debajo la
    // hora con el estado. No se fija QUÉ partido: otros bloques del test le
    // crean más de uno y el que sale es el más próximo, no el último inscrito.
    check('…su próxima pichanga sale con fecha, hora y estado',
      /Próxima<\/div>\s*<div class="hlv"[^>]*>(?!—)[^<]+<\/div>\s*<div class="hls">\d{1,2}-\d{1,2}[ap]m · (reservado|pagado)/.test(ficha));
    check('…y cuánto pagó, con cuántos Yapes', /S\/ 45/.test(ficha) && /1 Yape/.test(ficha));
    check('…sin repetir esos datos como filas de Historia', !/>Total pagado</.test(ficha) && !/>Próximo partido</.test(ficha));

    // Contacto propio: L.nuevo ya tiene pagos de bloques anteriores.
    db.getOrCreateLead('51990000009');
    const virgen = (await GET('/admin/leads?key=ux&numero=51990000009')).html;
    check('un contacto sin historia lo dice, no muestra ceros sueltos', /nunca pagó/.test(virgen) && /sin reserva/.test(virgen));
  }

  console.log('== 4f · Casero = 6+ visitas, contadas con TODA su historia ==');
  {
    const habitual = '51990000021', ocasional = '51990000022';
    for (const n of [habitual, ocasional]) db.getOrCreateLead(n);
    db.updateLead(habitual, { nombre: 'Hugo Habitual', zona: 'brena' });
    db.updateLead(ocasional, { nombre: 'Otto Ocasional', zona: 'brena' });
    // 6 partidos pasados para uno, 5 para el otro: el corte cae justo en medio.
    for (let i = 1; i <= 6; i++) {
      partidoJugado(enDias(-i), i <= 5 ? [habitual, ocasional] : [habitual]);
    }
    const met = db.metricasPorNumero();
    check('cuenta 6 visitas', met[habitual].visitas === 6, String(met[habitual].visitas));
    check('y 5 para el otro', met[ocasional].visitas === 5, String(met[ocasional].visitas));
    check('la última visita es la fecha real del partido', met[habitual].ultima === enDias(-1), met[habitual].ultima);

    const rec = (await GET('/admin/leads?key=ux&vista=crm&filtro=recurrentes')).html;
    check('con 6 visitas SÍ es casero', /Hugo Habitual/.test(rec));
    check('con 5 exactas NO lo es ("más de 5")', !/Otto Ocasional/.test(rec));
    check('la fila lo marca con su relación y sus visitas', /⭐ Casero · 6/.test(rec));

    // Una reserva futura y un partido cancelado no cuentan como visitas.
    const futuro = db.crearPartido({ zona: 'brena', fecha: enDias(9), cupo: 20 });
    db.inscribir(futuro, ocasional);
    const cancelado = partidoJugado(enDias(-9), [ocasional]);
    db.setEstadoPartido(cancelado, 'cancelado');
    check('una reserva futura no suma como visita', db.metricasPorNumero()[ocasional].visitas === 5, String(db.metricasPorNumero()[ocasional].visitas));

    // EL AGUJERO QUE ORIGINÓ TODO: los pagos de julio no tenían partido (la
    // tabla nació el 10/08), así que contar solo inscripciones dejaba a los
    // clientes viejos con cero. Un pago SIN partido tiene que valer una visita.
    const viejo = '51990000023';
    db.getOrCreateLead(viejo);
    db.updateLead(viejo, { nombre: 'Vito Viejo', zona: 'brena' });
    const conn = new (require('node:sqlite').DatabaseSync)(db.dbPath);
    for (let i = 1; i <= 3; i++) {
      const id = db.registrarPago({ numero: viejo, monto: 15, numero_operacion: `VJ-${i}`, estado: 'confirmado' });
      conn.prepare("UPDATE pagos SET creado_en = datetime(? || ' 20:00:00') WHERE id = ?").run(enDias(-30 - i), id);
    }
    conn.close();
    check('tres pagos de julio, sin ningún partido, son tres visitas',
      db.metricasPorNumero()[viejo].visitas === 3, String(db.metricasPorNumero()[viejo].visitas));
    const crmViejo = (await GET('/admin/leads?key=ux&vista=crm')).html;
    check('…y en la lista aparece como "Vuelve · 3", no como Nuevo', /Vuelve · 3/.test(crmViejo));
    check('…con su badge de frescura porque hace un mes que no viene', /Frío · 3\d d/.test(crmViejo));

    const fichaHab = (await GET(`/admin/leads?key=ux&numero=${habitual}`)).html;
    // El badge dice la relación y el texto de al lado el detalle: sin repetir
    // la palabra "Casero" dos veces en la misma línea.
    check('la ficha del habitual lo dice: badge Casero y 6 visitas en los destacados',
      /class="valor"[\s\S]*?⭐ Casero/.test(fichaHab)
      && /class="hl"[\s\S]*?Visitas<\/div>\s*<div class="hlv"[^>]*>6</.test(fichaHab));

    const nuevos = (await GET('/admin/leads?key=ux&vista=crm&filtro=nuevos')).html;
    check('el chip Nuevos filtra por los de esta semana', /Hugo Habitual/.test(nuevos));
  }

  console.log('== 4f2 · Relación y frescura: dos ejes, cero botones ==');
  {
    // La ficha ya no pide declarar en qué escalón está nadie.
    const ficha = (await GET(`/admin/leads?key=ux&numero=${L.completo}`)).html;
    check('la ficha NO tiene botones de etapa', !/action="\/admin\/lead\/estado"/.test(ficha) && !/class="pstep/.test(ficha));
    check('…ni la fila "Etapa" del perfil', !/>Etapa</.test(ficha));
    check('en su lugar hay badge de relación y los cuatro destacados',
      /class="valor"/.test(ficha) && /class="hl"/.test(ficha) && /Visitas/.test(ficha));
    check('y la fila "En el grupo"', /En el grupo/.test(ficha));

    // El POST viejo tiene que estar MUERTO, no solo escondido de la pantalla.
    const zombi = await POST('/admin/lead/estado', { key: 'ux', numero: L.completo, estado: 'activo' });
    check('POST /admin/lead/estado ya no existe (404)', zombi.status === 404, `HTTP ${zombi.status}`);

    // El botón del grupo solo aparece si la zona tiene link: sin link nadie
    // pudo haber mandado nada.
    db.setConfig({ grouplink_comas: '' });
    const sinLink = (await GET(`/admin/leads?key=ux&numero=${L.nuevo}`)).html;
    check('sin link cargado no se ofrece marcar el grupo', !/Le mandé el link/.test(sinLink));
    db.setConfig({ grouplink_brena: 'https://chat.whatsapp.com/UX-BRENA' });
    const conLink = (await GET(`/admin/leads?key=ux&numero=${L.completo}`)).html;
    check('con link cargado sí', /Le mandé el link/.test(conLink) || /En el grupo<\/span><span class="v" style="color:var\(--lime-ink\)">Sí/.test(conLink));

    // Los siete filtros de relación existen y filtran de verdad.
    const crm = (await GET('/admin/leads?key=ux&vista=crm')).html;
    check('el desplegable de etapas se volvió el de relación', /<select name="rel"/.test(crm) && !/<select name="estado"/.test(crm));
    // Las opciones del desplegable son EXACTAMENTE los conjuntos que muestra el
    // Resumen: cada fila de allá tiene que poder abrirse acá, ni más ni menos.
    for (const v of ['nunca', 'probo', 'vuelve', 'casero', 'al_dia', 'enfriando', 'perdido', 'en_grupo', 'sin_grupo']) {
      check(`opción de relación "${v}"`, new RegExp(`<option value="${v}"`).test(crm));
    }
    const soloCaseros = await GET('/admin/leads?key=ux&vista=crm&rel=casero');
    check('rel=casero deja marcado el desplegable', /<option value="casero" selected/.test(soloCaseros.html));
    check('…y muestra solo a los caseros', /Hugo Habitual/.test(soloCaseros.html) && !/Elsa Espera/.test(soloCaseros.html));
    const enGrupo = (await GET('/admin/leads?key=ux&vista=crm&rel=en_grupo')).html;
    check('rel=en_grupo usa la fecha guardada, no una etapa', /Pablo Pagador/.test(enGrupo));

    // El Resumen: dos bloques monótonos en vez de un embudo que se cruzaba.
    const resumen = (await GET('/admin/leads?key=ux')).html;
    check('el embudo comercial va del primer mensaje al casero', /Del primer mensaje al casero/.test(resumen));
    check('…y sus escalones llevan al CRM filtrado por relación', /vista=crm&rel=casero/.test(resumen));
    check('hay un bloque de salud de la base', /Salud de la base/.test(resumen));
    check('…con los tres estados de frescura', /Al día/.test(resumen) && /Enfriándose/.test(resumen) && /Perdidos/.test(resumen));
    // Cada fila abre EXACTAMENTE su conjunto: si "Perdidos: 120" abriera una
    // lista de 200 porque el filtro incluye a los que recién se enfrían, sería
    // la misma clase de mentira que se vino a sacar de encima.
    for (const v of ['al_dia', 'enfriando', 'perdido']) {
      check(`la fila de salud "${v}" lleva a su propio filtro`, new RegExp(`vista=crm&rel=${v}`).test(resumen));
    }
    const nSalud = [...resumen.matchAll(/vista=crm&rel=(al_dia|enfriando|perdido)"[\s\S]*?<span class="zval">(\d+)/g)].map((m) => Number(m[2]));
    const nClientes = Number((resumen.match(/de los (\d+) que ya vinieron/) || [, 0])[1]);
    check(`los tres estados suman los ${nClientes} clientes (${nSalud.join('+')})`,
      nSalud.reduce((a, b) => a + b, 0) === nClientes, nSalud.join('+'));
    check('ya no se muestra el escalón "Dejaron sus datos" cruzado con pagos', !/Dejaron sus datos/.test(resumen));

    // Monotonía: cada escalón tiene que ser subconjunto del anterior.
    const nums = [...resumen.matchAll(/<span class="zname">(Escribieron al número|Vinieron alguna vez|Volvieron|Caseros)[\s\S]*?<span class="zval">(\d+)/g)].map((m) => Number(m[2]));
    check(`el embudo no crece hacia abajo: ${nums.join(' ≥ ')}`,
      nums.length === 4 && nums.every((n, i) => i === 0 || n <= nums[i - 1]), nums.join(','));

    // Los cortes de frescura se editan en Ajustes.
    const cfg = (await GET('/admin/leads?key=ux&vista=config')).html;
    check('Ajustes deja cambiar cuándo se enfría un jugador', /id="frescura"/.test(cfg) && /name="dias_frio"/.test(cfg));
    const rFrio = await POST('/admin/config/general', { key: 'ux', dias_frio: '10', dias_perdido: '20' });
    check('guardar los cortes redirige a una página viva', rFrio.status === 302 && (await GET(rFrio.location.replace(B, ''))).status === 200);
    check('…y quedaron guardados', db.umbralesFrescura().frio === 10 && db.umbralesFrescura().perdido === 20);
    db.setConfig({ dias_frio: '21', dias_perdido: '45' });
  }

  console.log('== 4f3 · Convocar: la lista, no el envío ==');
  {
    // "¿A quién le escribo para llenar el viernes en Breña?" — la pregunta que
    // ninguna pantalla contestaba.
    const viernes = db.crearPartido({ zona: 'brena', fecha: enDias(8), hora: '8-9pm', sede: 'Melgar UX', cupo: 14, precio: 15 });
    const cerrada = (await GET(`/admin/leads?key=ux&vista=partidos&partido=${viernes}`)).html;
    check('el partido ofrece "Ver a quién convocar"', /Ver a quién convocar/.test(cerrada));
    check('…y no lista a nadie hasta que se lo pidas', !/wa\.me\/51990000021\?text/.test(cerrada));

    const abierta = (await GET(`/admin/leads?key=ux&vista=partidos&partido=${viernes}&convocar=1`)).html;
    check('pedida, aparece el casero de esa zona', /Hugo Habitual/.test(abierta));
    check('…con su relación y sus visitas', /Casero · 6/.test(abierta));
    check('…y su link de WhatsApp con el mensaje ya escrito', /wa\.me\/51990000021\?text=/.test(abierta));
    check('el mensaje dice el día, la hora y los cupos', /Quedan%2014%20cupos/.test(abierta) || /Quedan\+14\+cupos/.test(abierta));
    check('NO hay ningún botón de envío masivo', !/Enviar a todos/.test(abierta) && !/action="\/admin\/convocar/.test(abierta));
    check('el de otra zona no aparece', !/Pablo Pagador/.test(abierta));
    check('el que nunca vino tampoco', !/Elsa Espera/.test(abierta));

    // Inscribirlo lo saca de la lista: no se convoca a quien ya está adentro.
    db.inscribir(viernes, '51990000021');
    const trasInscribir = (await GET(`/admin/leads?key=ux&vista=partidos&partido=${viernes}&convocar=1`)).html;
    check('inscrito, deja de ser candidato', !/wa\.me\/51990000021\?text=/.test(trasInscribir));
  }

  console.log('== 4g · Guardar avisa QUÉ se guardó y vuelve donde estabas ==');
  {
    // El pedido que originó esto: "algo más intuitivo para que Clarck modifique
    // las cosas". Los POST volvían a la vista pelada, sin confirmación y arriba
    // de todo — en Ajustes, que es un scroll largo, eso significa pegar el link
    // del grupo de Chorrillos y aparecer en el bloque del canal de WhatsApp.
    const avisoDe = (loc) => decodeURIComponent((loc.match(/aviso=([^&#]*)/) || [, ''])[1].replace(/\+/g, ' '));
    const anclaDe = (loc) => (loc.match(/#(.+)$/) || [, ''])[1];

    const rZona = await POST('/admin/config/zona', {
      key: 'ux', zona: 'comas', precio: '10', grouplink: 'https://chat.whatsapp.com/UX123', nombre_mostrar: 'Comas',
    });
    check('guardar una zona nombra el dato concreto, no "guardado" a secas', /link del grupo guardado/.test(avisoDe(rZona.location)), avisoDe(rZona.location));
    check('…y vuelve al bloque de ESA zona, no al top', anclaDe(rZona.location) === 'zona-comas', anclaDe(rZona.location));
    const pagZona = await GET(rZona.location);
    check('…y el aviso se ve en la página que recibe', /link del grupo guardado/.test(pagZona.html));
    check('…con un destino de ancla que existe de verdad', /id="zona-comas"/.test(pagZona.html));
    check('el link quedó guardado en la BD', db.getConfigMap().grouplink_comas === 'https://chat.whatsapp.com/UX123');

    // Guardar sin cambiar nada no puede decir "guardado": sería mentir.
    const rIgual = await POST('/admin/config/zona', { key: 'ux', zona: 'comas', precio: '10', grouplink: 'https://chat.whatsapp.com/UX123', nombre_mostrar: 'Comas' });
    check('guardar sin cambios lo dice en vez de fingir', /no cambiaste nada/.test(avisoDe(rIgual.location)), avisoDe(rIgual.location));

    const rGen = await POST('/admin/config/general', { key: 'ux', marca: 'Pichangueros', yape_numero: '999111222' });
    check('los datos del negocio avisan y anclan a su bloque', /guardados/.test(avisoDe(rGen.location)) && anclaDe(rGen.location) === 'general');

    // Rechazos que antes eran mudos: la pantalla recargaba igual y el usuario
    // no técnico concluye "esto está roto".
    const rSinNombre = await POST('/admin/config/sede', { key: 'ux', zona: 'brena', nombre: '' });
    check('una cancha sin nombre explica por qué no entró', /nombre a la cancha/.test(avisoDe(rSinNombre.location)) && /err=1/.test(rSinNombre.location));
    const rSinFecha = await POST('/admin/partido', { key: 'ux', zona: 'brena', fecha: '' });
    check('abrir un partido sin día explica por qué no se abrió', /Elige el día/.test(avisoDe(rSinFecha.location)) && /err=1/.test(rSinFecha.location));
    const rNotaVacia = await POST('/admin/lead/nota', { key: 'ux', numero: L.completo, texto: '  ' });
    check('una nota vacía avisa en vez de descartarse en silencio', /Escribe algo/.test(avisoDe(rNotaVacia.location)));

    // Inscribir a mano sobre un partido cerrado no hacía NADA: ni inscripción
    // ni mensaje. Es el caso real de "llega un amigo a la cancha".
    // Fecha/hora propias: desde el 17/08 dos partidos de la misma cancha, día y
    // hora son EL MISMO partido (crearPartido devuelve el que ya existe).
    const cerrado = db.crearPartido({ zona: 'brena', fecha: enDias(13), hora: '7-8pm', cupo: 10 });
    db.setEstadoPartido(cerrado, 'cerrado');
    const rCerrado = await POST('/admin/partido/inscribir', { key: 'ux', partido_id: cerrado, nombre: 'Amigo Tardío' });
    check('inscribir en un partido cerrado dice qué hacer', /Reabrir/.test(avisoDe(rCerrado.location)) && /err=1/.test(rCerrado.location), avisoDe(rCerrado.location));
    check('…y de verdad no lo inscribió', db.inscripcionesDe(cerrado).length === 0);

    // Pasar lista: 14 toques seguidos, parado en la cancha. Cada uno recargaba
    // y devolvía arriba de todo, había que volver a bajar hasta donde ibas.
    const jugado = partidoJugado(enDias(-15), ['51960000001'], { cupo: 10 });
    const iAsist = db.inscripcionesDe(jugado)[0];
    const rAsist = await POST('/admin/inscripcion/asistencia', { key: 'ux', id: iAsist.id, partido_id: jugado, valor: 'si' });
    check('marcar asistencia vuelve a LA FILA, no al top', anclaDe(rAsist.location) === `insc-${iAsist.id}`, anclaDe(rAsist.location));
    const pagAsist = await GET(rAsist.location);
    check('…y esa fila existe como destino', pagAsist.html.includes(`id="insc-${iAsist.id}"`));
    check('…y confirma a quién marcaste', /vino/.test(avisoDe(rAsist.location)));
  }

  console.log('== 4h · Ajustes: campos con etiqueta, no cajas mudas ==');
  {
    // Eran 7 <input> con solo placeholder: al editar una sede YA cargada el
    // placeholder desaparece y quedan siete cajas sin nombre, con "14" y "150"
    // pegadas sin decir cuál es el cupo y cuál el costo.
    const cfg = (await GET('/admin/leads?key=ux&vista=config')).html;
    for (const etiqueta of ['Nombre de la cancha', 'Costo de la cancha (S/)', 'Cupo', 'Link del grupo de WhatsApp', 'Precio por jugador (S/)']) {
      check(`la etiqueta "${etiqueta}" se ve en pantalla`, cfg.includes(`>${etiqueta}</label>`), 'sin <label>');
    }
    const sedeBrena = db.listSedes('brena')[0];
    check('cada campo tiene su label asociado por for/id', cfg.includes(`for="s${sedeBrena.id}-costo"`) && cfg.includes(`id="s${sedeBrena.id}-costo"`));
    check('la ayuda del costo ya no vive en un title= (invisible en celular)', !/title="Lo que te cuesta/.test(cfg));
    check('…sino como texto bajo el campo', /cuesta alquilarla por turno/.test(cfg));
    check('un link de grupo faltante se señala en su propio campo', /Todavía sin cargar/.test(cfg));
    check('…y explica cómo conseguirlo', /Invitar por enlace/.test(cfg));
    check('los bloques de Ajustes son destinos de ancla', /id="general"/.test(cfg) && /id="corte"/.test(cfg) && /id="nuevo-distrito"/.test(cfg));
  }

  console.log('== 4i · La última cancha de un distrito NO se puede borrar ==');
  {
    // Las zonas no son una tabla: se derivan de las sedes (zonasOperativas).
    // Borrar la última cancha borraba el distrito ENTERO y en silencio — sale
    // del bot, del CRM y de Partidos, y su precio/link dejan de poder guardarse.
    const avisoDe = (loc) => decodeURIComponent((loc.match(/aviso=([^&#]*)/) || [, ''])[1].replace(/\+/g, ' '));
    const unica = db.listSedes('sanborja');
    check('San Borja tiene una sola cancha (el caso peligroso)', unica.length === 1, String(unica.length));

    const rBloqueo = await POST('/admin/config/sede/eliminar', { key: 'ux', id: unica[0].id });
    check('el servidor lo RECHAZA (no alcanza un confirm en el cliente)', /err=1/.test(rBloqueo.location));
    check('…y explica que se llevaría el distrito entero', /única cancha/.test(avisoDe(rBloqueo.location)) && /desaparece el distrito/.test(avisoDe(rBloqueo.location)), avisoDe(rBloqueo.location));
    check('la cancha sigue ahí', db.listSedes('sanborja').length === 1);
    check('y el distrito sigue operativo', db.zonasOperativas().includes('sanborja'));

    // Con dos canchas sí se puede: la regla es "la última", no "ninguna".
    db.addSede({ zona: 'sanborja', nombre: 'Segunda Cancha UX', cupo: 12 });
    const dos = db.listSedes('sanborja');
    const rOk = await POST('/admin/config/sede/eliminar', { key: 'ux', id: dos[1].id });
    check('con dos canchas, borrar una sí funciona', !/err=1/.test(rOk.location) && db.listSedes('sanborja').length === 1);
    check('…y confirma cuál borró', /Segunda Cancha UX/.test(avisoDe(rOk.location)), avisoDe(rOk.location));
  }

  console.log('== 4j · "Para que el bot trabaje solo": la deuda a la vista ==');
  {
    // El panel nunca decía que faltaba algo. Las cuatro zonas están sin link de
    // grupo desde el primer día y no había pantalla donde enterarse.
    db.setConfig({ grouplink_brena: '' });
    const resumen = (await GET('/admin/leads?key=ux')).html;
    check('el Resumen muestra qué falta cargar', /Para que el bot trabaje solo/.test(resumen));
    check('…nombra la zona sin link de grupo', /no tiene link de grupo/.test(resumen));
    check('…dice qué se desbloquea, no reprocha', /no puede meter a nadie al grupo/.test(resumen));
    check('…y lleva al campo exacto que lo resuelve', /vista=config#zona-brena/.test(resumen));

    // El link tiene que existir como destino en Ajustes (si no, es un callejón).
    const destino = (resumen.match(/href="([^"]*vista=config#zona-brena)"/) || [, ''])[1].replace(/&amp;/g, '&');
    const cfg = await GET(destino);
    check('el destino del atajo existe y responde', cfg.status === 200 && /id="zona-brena"/.test(cfg.html));

    // Cuando el dato ya está cargado, la fila desaparece: es una lista de
    // pendientes, no un cartel permanente.
    db.setConfig({ grouplink_brena: 'https://chat.whatsapp.com/UX-BRENA' });
    const resumen2 = (await GET('/admin/leads?key=ux')).html;
    check('al cargar el link, esa fila se va', !/Breña no tiene link de grupo/.test(resumen2));
    check('las canchas sin costo también se listan', /sin costo de alquiler/.test(resumen2));
  }

  console.log('== 4k · Lo que se rompe con un toque, pregunta antes ==');
  {
    const conGente = db.crearPartido({ zona: 'brena', fecha: enDias(3), hora: '8-9pm', cupo: 10 });
    db.inscribir(conGente, '51960000011');
    db.inscribir(conGente, '51960000012');
    const html = (await GET(`/admin/leads?key=ux&vista=partidos&partido=${conGente}`)).html;

    check('"Baja" pregunta antes (libera cupo y sube a alguien de la espera)',
      /onsubmit="return confirm\([^)]*Dar de baja/.test(html));
    check('…y avisa que no se deshace con un botón', /No se puede deshacer con un bot/.test(html));
    check('"Cancelar" pregunta antes', /onsubmit="return confirm\([^)]*CANCELAR/.test(html));
    check('…contando los inscritos que quedan colgados', /Hay 2 inscritos/.test(html), 'sin el conteo');
    check('…y avisando que nadie recibe aviso automático', /nadie recibe aviso autom/.test(html));
    check('la acción destructiva va separada de las comunes', /class="finsc-peligro"/.test(html));
    check('los botones de fila son tocables (44px)', /class="btn-fila"/.test(html) && /\.btn-fila\{min-height:44px/.test(html));
    check('cada inscrito es un destino de ancla para pasar lista', /id="insc-\d+"/.test(html));
    // Sin JS el confirm no corre, así que el bloqueo REAL vive en el servidor:
    // eliminar un partido con gente adentro se rechaza igual.
    const rEliminar = await POST('/admin/partido/eliminar', { key: 'ux', id: conGente });
    check('borrar un partido con gente se rechaza en el servidor', /err=1/.test(rEliminar.location) && db.getPartido(conGente) !== null);
  }

  console.log('== 4k2 · La semana, los turnos fijos y la cola de liquidación ==');
  {
    const avisoDe = (loc) => decodeURIComponent((loc.match(/aviso=([^&#]*)/) || [, ''])[1].replace(/\+/g, ' '));
    const partidos = (await GET('/admin/leads?key=ux&vista=partidos')).html;
    check('la vista abre en SEMANA, no en lista plana', /La semana/.test(partidos) && /Semana siguiente/.test(partidos));
    check('cada día de la semana es un bloque con su atajo para abrir', (partidos.match(/\+ abrir/g) || []).length === 7);
    check('hay un bloque de turnos fijos', /Turnos fijos/.test(partidos) && /id="turnos"/.test(partidos));
    check('…que explica que la plantilla no es el partido', /la plantilla, no el partido/.test(partidos));
    const otra = await GET('/admin/leads?key=ux&vista=partidos&semana=1');
    check('la semana siguiente responde', otra.status === 200 && /Esta semana/.test(otra.html));

    // Un turno fijo: nace apagado, se enciende a mano y recién ahí carga fechas.
    const rTurno = await POST('/admin/turno', { key: 'ux', zona: 'comas', dia_semana: '3', hora: '18:00', cupo: '12', precio: '10' });
    check('crear un turno avisa que quedó APAGADO', /APAGADO/.test(avisoDe(rTurno.location)), avisoDe(rTurno.location));
    const t = db.listTurnos().find((x) => x.dia_semana === 3 && x.inicio_min === 1080);
    check('…y en la BD está apagado de verdad', t && t.activo === 0);
    const antesGen = db.listPartidos().filter((p) => p.turno_id === t.id).length;
    check('apagado no cargó ninguna fecha', antesGen === 0);
    const rOn = await POST('/admin/turno/activo', { key: 'ux', id: t.id, activo: '1' });
    check('encenderlo carga las fechas al toque', db.listPartidos().filter((p) => p.turno_id === t.id).length >= 1, avisoDe(rOn.location));
    check('…y lo dice en el aviso', /encendido/i.test(avisoDe(rOn.location)), avisoDe(rOn.location));
    const conTurno = (await GET('/admin/leads?key=ux&vista=partidos')).html;
    check('los partidos generados se marcan como "turno fijo"', /turno fijo/.test(conTurno));

    // Cancelar UNA fecha no toca el turno, y el generador no la resucita.
    const instancia = db.listPartidos().filter((p) => p.turno_id === t.id).sort((a, b) => (a.fecha < b.fecha ? -1 : 1))[0];
    const rCanc = await POST('/admin/partido/cancelar-fecha', { key: 'ux', id: instancia.id });
    check('cancelar una fecha avisa que el turno sigue activo', /turno fijo sigue activo/.test(avisoDe(rCanc.location)), avisoDe(rCanc.location));
    check('…el turno sigue encendido', db.getTurno(t.id).activo === 1);
    db.generarPartidosDeTurnos();
    check('…y el generador NO la vuelve a crear', Boolean(db.getPartido(instancia.id).cancelado_en)
      && db.listPartidos().filter((p) => p.fecha === instancia.fecha && p.turno_id === t.id).length === 1);

    // Liquidar: la pantalla que "Marcar jugado" nunca fue.
    const viejo = partidoJugado(enDias(-11), ['51965000001'], { cupo: 10, precio: 15 });
    const detalleViejo = (await GET(`/admin/leads?key=ux&vista=partidos&partido=${viejo}`)).html;
    check('un partido terminado ofrece LIQUIDAR, no "marcar jugado"', /Liquidar este partido/.test(detalleViejo) && !/Marcar jugado/.test(detalleViejo));
    check('…mostrando a quién falta cobrarle, con su wa.me', /Falta cobrarle a 1/.test(detalleViejo) && /wa\.me\/51965000001/.test(detalleViejo), (detalleViejo.match(/Falta cobrarle[\s\S]{0,220}/) || ['SIN BLOQUE'])[0]);
    check('la cola de liquidación aparece en Partidos', /id="liquidar"/.test(partidos) || /id="liquidar"/.test(conTurno));
    const rLiq = await POST('/admin/partido/liquidar', { key: 'ux', id: viejo });
    check('liquidar dice cuánta plata quedó contada', /cobrados/.test(avisoDe(rLiq.location)), avisoDe(rLiq.location));
    check('…y queda con su fecha de liquidación', Boolean(db.getPartido(viejo).liquidado_en));
    check('…sin que nada se autoliquide', !db.partidosPorLiquidar().some((p) => p.id === viejo));

    // Los vacíos se archivan en lote, sin ritual.
    const vacio = partidoJugado(enDias(-12), [], { cupo: 10 });
    check('un partido terminado y vacío entra a la cola de archivo', db.partidosVacios().some((p) => p.id === vacio));
    const rArch = await POST('/admin/partidos/archivar-vacios', { key: 'ux' });
    check('se archivan todos de un toque', /archivado/.test(avisoDe(rArch.location)) && !db.partidosVacios().length, avisoDe(rArch.location));

    // Anotar sobre un partido vencido explica qué hacer, no falla mudo.
    const rTarde = await POST('/admin/partido/inscribir', { key: 'ux', partido_id: vacio, nombre: 'Muy Tarde' });
    check('inscribir en un partido liquidado dice cómo destrabarlo', /Reabrir|reabrirlo/.test(avisoDe(rTarde.location)) && /err=1/.test(rTarde.location), avisoDe(rTarde.location));

    const rDel = await POST('/admin/turno/eliminar', { key: 'ux', id: t.id });
    check('borrar el turno no se lleva los partidos ya cargados',
      !db.getTurno(t.id) && db.listPartidos().some((p) => p.fecha === instancia.fecha));
    check('…y lo dice', /no se tocaron/.test(avisoDe(rDel.location)), avisoDe(rDel.location));
  }

  console.log('== 4l · Jugadores: tres desplegables, no catorce chips ==');
  {
    // 14 chips en 3 filas ocupaban media pantalla antes del primer contacto.
    // Como cada familia es EXCLUYENTE (el código guarda un solo valor por
    // filtro/zona/estado), la fila de chips prometía una combinatoria falsa.
    const crm = (await GET('/admin/leads?key=ux&vista=crm')).html;
    const selects = [...crm.matchAll(/<select name="(\w+)"/g)].map((m) => m[1]);
    check(`la barra tiene los desplegables: ${selects.join(' · ')}`,
      ['filtro', 'zona', 'rel'].every((s) => selects.includes(s)), selects.join(','));
    check('ya no quedan chips de filtro sueltos', !/fchip[^"]*" href="[^"]*&filtro=nuevos/.test(crm));

    // Sin JS el onchange no corre: el botón de envío es la única salida.
    const barra = (crm.match(/<form class="fbar"[\s\S]*?<\/form>/) || [''])[0];
    check('la barra es un form GET…', /method="get"/.test(barra));
    check('…con botón de envío visible (funciona sin JS)', /<button[^>]*>Filtrar<\/button>/.test(barra));
    check('…y el onchange es solo mejora progresiva', /onchange="this\.form\.submit\(\)"/.test(barra));
    check('el conteo de contactos sigue a la vista', /contactos<\/div>/.test(crm));

    // El texto del elegido tiene que leerse solo: cerrado es lo único visible.
    check('los option de zona dicen de qué familia son', /<option value="brena"[^>]*>Zona: Breña/.test(crm));
    check('los de relación también', /Relación: casero/.test(crm));
    check('y traen el conteo para no tener que abrirlos', /Sin responder \(\d+\)/.test(crm));

    // Las zonas salen de zonasOperativas, no de una lista escrita a mano.
    check('un distrito creado desde Ajustes aparece en el desplegable', /<option value="sanborja"[^>]*>Zona: San Borja/.test(crm), 'zona nueva ausente');
    check('…y "otra" se lee como lo que es', /Zona: sin sede cerca/.test(crm));

    // Llegar por URL tiene que dejar el desplegable marcado. Con los chips,
    // entrar desde el embudo del Resumen filtraba la lista pero ningún chip
    // quedaba encendido: N de 912 sin decir por qué.
    for (const [campo, valor] of [['filtro', 'handoff'], ['zona', 'comas'], ['rel', 'casero'], ['rel', 'nunca']]) {
      const r = await GET(`/admin/leads?key=ux&vista=crm&${campo}=${valor}`);
      check(`${campo}=${valor}: la página vive y el desplegable queda marcado`,
        r.status === 200 && new RegExp(`<option value="${valor}" selected`).test(r.html), `HTTP ${r.status}`);
    }

    // Y filtrar de verdad sigue filtrando.
    const soloComas = (await GET('/admin/leads?key=ux&vista=crm&zona=comas')).html;
    check('zona=comas devuelve solo los de Comas', /Pablo Pagador/.test(soloComas) && !/María Prueba/.test(soloComas));

    // "Limpiar" solo cuando hay algo que limpiar.
    check('sin filtros no se ofrece limpiar', !/Limpiar filtros/.test(crm));
    check('con filtro sí', /Limpiar filtros/.test(soloComas));
    const limpio = (soloComas.match(/href="([^"]*)"[^>]*>✕ Limpiar/) || [, ''])[1].replace(/&amp;/g, '&');
    check('…y limpiar deja la vista por defecto', limpio === '/admin/leads?key=ux&vista=crm', limpio);

    // Buscar no puede borrar los filtros puestos.
    const buscador = (soloComas.match(/<form class="search"[\s\S]*?<\/form>/) || [''])[0];
    check('el buscador conserva la zona elegida', /name="zona" value="comas"/.test(buscador));
  }

  console.log('== 4l2 · Vistas rápidas: las seis listas que se abren de verdad ==');
  {
    // Los desplegables dan ~30 combinaciones; en el día a día se usan seis, y
    // armarlas cuesta dos toques cada vez. Van arriba, con su cuenta al lado.
    const crm = (await GET('/admin/leads?key=ux&vista=crm')).html;
    const bloque = (crm.match(/<div class="vistas">[\s\S]*?<\/div>\s*\n/) || [''])[0];
    check('la fila de vistas existe', /class="vistas"/.test(crm));
    for (const txt of ['Sin responder', 'Para Clarck', 'Mandar el link', 'Enfriándose', 'Caseros', 'Nuevos']) {
      check(`…con la vista "${txt}"`, bloque.includes(txt));
    }
    check('cada vista trae su cuenta al lado', /class="vn">\d+<\/span>/.test(bloque));

    // "Listos para el grupo" NO es "sin grupo": ese último son casi todos los
    // contactos (el que escribió una vez y nunca dijo su nombre también). La
    // lista de trabajo son los que ya se pueden meter: con nombre y con zona.
    const nListos = Number((bloque.match(/Mandar el link<\/span><span class="vn">(\d+)</) || [, '-1'])[1]);
    const nSinGrupo = (await GET('/admin/leads?key=ux&vista=crm&rel=sin_grupo')).html.match(/class="lrow"/g) || [];
    check('"listos para el grupo" es un subconjunto real de "sin grupo"',
      nListos >= 0 && nListos < nSinGrupo.length, `listos=${nListos} sinGrupo=${nSinGrupo.length}`);
    const listos = (await GET('/admin/leads?key=ux&vista=crm&rel=listo_grupo')).html;
    check('…y todos los que abre tienen nombre y zona', !/Sin nombre/.test(listos.replace(/<title>[\s\S]*?<\/title>/, '')));

    // El número del chip y la lista que abre TIENEN que ser el mismo conjunto:
    // el error clásico es que el contador diga 120 y la lista muestre 80.
    const nCaseros = Number((bloque.match(/Caseros<\/span><span class="vn">(\d+)</) || [, '-1'])[1]);
    const listaCaseros = (await GET('/admin/leads?key=ux&vista=crm&rel=casero')).html;
    const enLista = (listaCaseros.match(/class="lrow"/g) || []).length;
    check('la cuenta de la vista coincide con lo que abre', nCaseros === enLista, `chip=${nCaseros} lista=${enLista}`);

    // Encendida solo si los filtros son EXACTAMENTE los suyos.
    check('al abrirla, esa vista queda encendida', /class="vista on"[^>]*>\s*<span class="vt">⭐ Caseros/.test(listaCaseros));
    check('…y las demás no', (listaCaseros.match(/class="vista on"/g) || []).length === 1);
    check('volver a tocarla la apaga', /class="vista on" href="\/admin\/leads\?key=ux&vista=crm"/.test(listaCaseros));
    const conOtro = (await GET('/admin/leads?key=ux&vista=crm&rel=casero&zona=comas')).html;
    check('con otro filtro encima ninguna vista miente que está encendida',
      (conOtro.match(/class="vista on"/g) || []).length === 0);
  }

  console.log('== 4l3 · El recorrido del partido: de dónde viene y qué falta ==');
  {
    // La fase salía como un badge suelto: decía dónde está, no qué falta.
    const pAbierto = db.crearPartido({ zona: 'brena', fecha: enDias(2), hora: '8-9pm', cupo: 10 });
    const abierto = (await GET(`/admin/leads?key=ux&vista=partidos&partido=${pAbierto}`)).html;
    const via = (abierto.match(/<div class="via">[\s\S]*?<\/div>\s*\n/) || [''])[0];
    check('el partido dibuja su recorrido', /class="via"/.test(abierto));
    check('…con los cuatro escalones', ['Jugándose', 'Terminó', 'Liquidado'].every((t) => via.includes(t)));
    check('…y el actual marcado', /class="vp aqui">Abierto/.test(via));
    check('…sin ninguno pintado como hecho todavía', !/class="vp hecho"/.test(via));

    // Uno que ya se jugó y se liquidó: todo el camino recorrido.
    const pViejo = db.crearPartido({ zona: 'brena', fecha: enDias(-3), hora: '8-9pm', cupo: 10 });
    db.liquidarPartido(pViejo);
    const viejo = (await GET(`/admin/leads?key=ux&vista=partidos&partido=${pViejo}`)).html;
    const viaV = (viejo.match(/<div class="via">[\s\S]*?<\/div>\s*\n/) || [''])[0];
    check('el liquidado tiene los tres primeros escalones hechos', (viaV.match(/class="vp hecho"/g) || []).length === 3);
    check('…y está parado en el último', /class="vp aqui">Liquidado/.test(viaV));

    // Cancelar no es un escalón del camino: es salirse de él.
    const pCanc = db.crearPartido({ zona: 'brena', fecha: enDias(2), hora: '9-10pm', cupo: 10 });
    db.cancelarPartido(pCanc);
    const canc = (await GET(`/admin/leads?key=ux&vista=partidos&partido=${pCanc}`)).html;
    check('el cancelado no finge estar en el camino', /class="vp corte"/.test(canc) && /cancelado/i.test(canc));
  }

  console.log('== 4m · Pagos: "limpiar" solo si hay algo que limpiar ==');
  {
    // El período arranca en '7d', así que hayFiltro daba true SIEMPRE: el botón
    // estaba siempre encendido y al tocarlo no cambiaba nada.
    const base = (await GET('/admin/leads?key=ux&vista=pagos')).html;
    check('sin filtros no aparece "Limpiar filtros"', !/Limpiar filtros/.test(base));
    check('…y la tarjeta no dice "(filtro)" sin filtro', /Cobrado \(confirmado\)/.test(base));
    const conFiltro = (await GET('/admin/leads?key=ux&vista=pagos&periodo=todo')).html;
    check('cambiando el período sí aparece', /Limpiar filtros/.test(conFiltro));
    check('…y la tarjeta lo refleja', /Cobrado \(filtro\)/.test(conFiltro));
    const barraPagos = (base.match(/<form class="fbar"[\s\S]*?<\/form>/) || [''])[0];
    check('Pagos también tiene botón de envío (sin JS no aplicaba nada)', /<button[^>]*>Filtrar<\/button>/.test(barraPagos));
    check('y sus medios dicen de qué familia son', /Medio: Yape/.test(base));
  }

  console.log('== 5 · Sin key, nada existe ==');
  check('vista sin key → 404', (await GET('/admin/leads?vista=crm')).status === 404);
  check('export sin key → 404', (await GET('/admin/leads.csv')).status === 404);

  console.log(fallos ? `\n❌ ${ok} OK, ${fallos} FALLOS` : `\n✅ ${ok} checks OK, 0 fallos`);
  srv.close(); process.exit(fallos ? 1 : 0);
});
