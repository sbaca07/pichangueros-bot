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

// --- Semilla realista: leads en todos los estados, partido con de todo -------
const enDias = (n) => new Date(Date.now() - 5 * 3600e3 + n * 86400e3).toISOString().slice(0, 10);
const L = {
  tester: '51900000001', completo: '51911111111', handoff: '51922222222',
  espera: '51933333333', pagador: '51944444444', nuevo: '51955555555',
};
for (const n of Object.values(L)) { db.getOrCreateLead(n); db.saveMessage(n, 'user', 'hola'); }
db.updateLead(L.completo, { nombre: 'María Prueba', edad: 28, distrito: 'Breña', zona: 'brena', estado: 'datos_completos' });
db.updateLead(L.pagador, { nombre: 'Pablo Pagador', zona: 'comas', estado: 'invitado_grupo' });
db.updateLead(L.espera, { nombre: 'Elsa Espera', zona: 'otra', estado: 'lista_espera' });
db.setHandoff(L.handoff, 'Queja de prueba');
db.setEtiquetas(L.completo, 'casero,VIP');
db.setSeguimiento(L.completo, enDias(0), 'llamarla');
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
  check('ficha: muestra chat, etiquetas, nota y seguimiento', ficha.includes('hola') && ficha.includes('casero') && ficha.includes('nota de prueba') && ficha.includes('llamarla'));
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
    ['/admin/lead/estado', { key: 'ux', numero: L.completo, estado: 'activo' }],
    ['/admin/lead/etiquetas', { key: 'ux', numero: L.completo, etiquetas: 'vip' }],
    ['/admin/lead/seguimiento', { key: 'ux', numero: L.completo, fecha: enDias(2), nota: 'x' }],
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
    check('el editor viene plegado (no tapa la lista)', !/<details class="editor" open/.test(detalle.html));

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
    check('…y deja el editor ABIERTO para corregir', /<details class="editor" open/.test(pagina.html));

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

    db.setSeguimiento(L.pagador, enDias(-1), 'llamarlo, quedó en confirmar');
    const crm = (await GET('/admin/leads?key=ux&vista=crm')).html;
    check('los seguimientos del día salen arriba, no detrás de un chip', /Seguimientos para hoy/.test(crm));
    check('…y un seguimiento pasado se marca vencido', /vencido/.test(crm));

    // FICHA: mostraba quién es, no qué ha hecho.
    const pgF = db.registrarPago({ numero: L.completo, monto: 45, numero_operacion: 'FICHA-1', estado: 'confirmado' });
    const partF = db.crearPartido({ zona: 'brena', fecha: enDias(2), hora: '8-9pm', cupo: 10 });
    db.inscribir(partF, L.completo);
    db.vincularPago(L.completo, pgF, 1, 'brena', 45);
    const ficha = (await GET(`/admin/leads?key=ux&numero=${L.completo}`)).html;
    check('la ficha trae la historia del jugador', /Historia/.test(ficha));
    check('…primer contacto', /Primer contacto/.test(ficha) && /lo captó el bot/.test(ficha));
    check('…próximo partido con su estado', /Próximo partido/.test(ficha) && !/Sin reserva/.test(ficha));
    check('…y cuánto pagó en total', /S\/ 45/.test(ficha) && /verificado/.test(ficha));

    // Contacto propio: L.nuevo ya tiene pagos de bloques anteriores.
    db.getOrCreateLead('51990000009');
    const virgen = (await GET('/admin/leads?key=ux&numero=51990000009')).html;
    check('un contacto sin historia lo dice, no muestra ceros sueltos', /Nunca pagó por acá/.test(virgen) && /Sin reserva/.test(virgen));
  }

  console.log('== 4f · Recurrente = más de 5 partidos (regla de Clarck) ==');
  {
    const habitual = '51990000021', ocasional = '51990000022';
    for (const n of [habitual, ocasional]) db.getOrCreateLead(n);
    db.updateLead(habitual, { nombre: 'Hugo Habitual' });
    db.updateLead(ocasional, { nombre: 'Otto Ocasional' });
    // 6 partidos pasados para uno, 5 para el otro: el corte cae justo en medio.
    for (let i = 1; i <= 6; i++) {
      const p = db.crearPartido({ zona: 'brena', fecha: enDias(-i), cupo: 20 });
      db.inscribir(p, habitual);
      if (i <= 5) db.inscribir(p, ocasional);
    }
    const jug = db.partidosJugadosPorNumero();
    check('cuenta 6 partidos jugados', jug[habitual] === 6, String(jug[habitual]));
    check('y 5 para el otro', jug[ocasional] === 5, String(jug[ocasional]));

    const rec = (await GET('/admin/leads?key=ux&vista=crm&filtro=recurrentes')).html;
    check('con 6 partidos SÍ es recurrente', /Hugo Habitual/.test(rec));
    check('con 5 exactos NO lo es ("más de 5")', !/Otto Ocasional/.test(rec));
    check('la fila lo marca con sus partidos', /⭐ 6 partidos/.test(rec));

    // Una reserva futura y un partido cancelado no cuentan como jugados.
    const futuro = db.crearPartido({ zona: 'brena', fecha: enDias(9), cupo: 20 });
    db.inscribir(futuro, ocasional);
    const cancelado = db.crearPartido({ zona: 'brena', fecha: enDias(-9), cupo: 20 });
    db.inscribir(cancelado, ocasional);
    db.setEstadoPartido(cancelado, 'cancelado');
    check('una reserva futura no suma como jugado', db.partidosJugadosPorNumero()[ocasional] === 5, String(db.partidosJugadosPorNumero()[ocasional]));

    const fichaHab = (await GET(`/admin/leads?key=ux&numero=${habitual}`)).html;
    check('la ficha del habitual lo dice', /recurrente/.test(fichaHab));

    const nuevos = (await GET('/admin/leads?key=ux&vista=crm&filtro=nuevos')).html;
    check('el chip Nuevos filtra por los de esta semana', /Hugo Habitual/.test(nuevos));
  }

  console.log('== 5 · Sin key, nada existe ==');
  check('vista sin key → 404', (await GET('/admin/leads?vista=crm')).status === 404);
  check('export sin key → 404', (await GET('/admin/leads.csv')).status === 404);

  console.log(fallos ? `\n❌ ${ok} OK, ${fallos} FALLOS` : `\n✅ ${ok} checks OK, 0 fallos`);
  srv.close(); process.exit(fallos ? 1 : 0);
});
