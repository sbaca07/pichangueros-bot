/**
 * QUE TODO CUADRE — los números dicen lo mismo que las listas a las que llevan,
 * y la plata no se confirma sin poder verificarla.
 *
 *   node test-cuadre.js        (~8 s, sin red)
 *
 * Cada bloque es un agujero real de la auditoría del 17/08:
 *   1. Contadores que no cuadran con su lista (banner, tiles, Sheet).
 *   2. Zona sin precio: el bot cotizaba "S/ 0" y confirmaba cualquier Yape.
 *   3. El monto se validaba contra la zona de CASA, no contra el partido.
 *   4. El espejo a Sheets podía estar muerto semanas sin que nadie se enterara.
 *   5. El nombre del distrito: tres superficies, dos respuestas.
 *   6. Menores: cupo, pagos sueltos, hora vacía, precio que ve el modelo.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.WWEBJS_AUTH_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'pich-cuadre-'));
process.env.ADMIN_KEY = 'cu';
process.env.SAFE_MODE = 'false';
process.env.KIPI_EMAIL_USER = 'kipi@ejemplo.com';
process.env.KIPI_EMAIL_APP_PASSWORD = 'no-se-usa';

const db = require('./src/db');
const backup = require('./src/backup');
const pagos = require('./src/pagos');
const atajos = require('./src/atajos');
const sheetsync = require('./src/sheetsync');
const { registrarPanel } = require('./src/panel');
const express = require('./node_modules/express');

// Correo interceptado: interesa QUÉ se avisa, no mandarlo.
const correos = [];
backup.avisar = async (asunto, cuerpo) => { correos.push({ asunto, cuerpo }); return { ok: true }; };

let ok = 0, fallos = 0;
const check = (nombre, cond, extra = '') => { if (cond) { ok++; console.log(`  ✓ ${nombre}`); } else { fallos++; console.error(`  ✗ ${nombre} ${extra}`); } };
const enDias = (n) => new Date(Date.now() - 5 * 3600e3 + n * 86400e3).toISOString().slice(0, 10);
const crudo = () => new (require('node:sqlite').DatabaseSync)(db.dbPath);

const app = express();
registrarPanel(app, db, { estado: () => 'ready', numero: () => '51967870413', qr: () => null, desconectar: async () => true, enviar: async () => ({ ok: true }) });

const srv = app.listen(0, async () => {
  const B = `http://127.0.0.1:${srv.address().port}`;
  const GET = async (ruta) => { const r = await fetch(B + ruta); return { status: r.status, html: await r.text() }; };
  const POST = async (ruta, obj) => {
    const r = await fetch(B + ruta, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(obj).toString(), redirect: 'manual' });
    return { status: r.status, location: r.headers.get('location') || '' };
  };
  const avisoDe = (loc) => decodeURIComponent((loc.match(/aviso=([^&#]*)/) || [, ''])[1].replace(/\+/g, ' '));
  /** Los números que el panel pinta en una tarjeta .stat, por su etiqueta. */
  const tile = (html, etiqueta) => {
    const m = html.match(new RegExp(`<div class="sn">([\\d.,]+)</div><div class="sl">${etiqueta}`));
    return m ? Number(m[1]) : null;
  };
  /** Cuántas filas de pago (lrow) trae una vista. */
  const filasPago = (html) => (html.match(/class="lrow"/g) || []).length;

  console.log('== 1 · El banner de pagos y la lista a la que lleva cuentan LO MISMO ==');
  {
    // Se siembran pagos por revisar de HOY y de hace 20 días: el banner contaba
    // todo el histórico y linkeaba a una vista que abre en 7 días (decía 12,
    // mostraba 3).
    const c = crudo();
    for (let i = 0; i < 5; i++) {
      db.getOrCreateLead(`5190001000${i}`);
      const id = db.registrarPago({ numero: `5190001000${i}`, monto: 7, numero_operacion: `CU-REV-${i}`, estado: 'revisar', motivo: 'Monto raro' });
      if (i >= 2) c.prepare("UPDATE pagos SET creado_en = datetime('now','-5 hours','-20 days') WHERE id = ?").run(id);
    }
    c.close();
    const cola = db.pagosPorRevisar();
    check('la cola es UNA lista, no un número suelto', Array.isArray(cola) && cola.length === 5, String(cola.length));

    const resumen = (await GET('/admin/leads?key=cu')).html;
    const banner = Number((resumen.match(/<b>(\d+) pagos? por revisar/) || [, 0])[1]);
    check(`el banner anuncia los ${cola.length} de la cola`, banner === cola.length, String(banner));
    const destino = (resumen.match(/href="([^"]*vista=pagos[^"]*estado=rev[^"]*)"/) || [, ''])[1].replace(/&amp;/g, '&');
    check('…y su link lleva al histórico completo, no a los últimos 7 días', /periodo=todo/.test(destino), destino);
    const lista = (await GET(destino)).html;
    check(`…donde la lista muestra los mismos ${banner}`, filasPago(lista) === banner, `${filasPago(lista)} filas`);
    check('…y el tile "Por revisar" también', tile(lista, 'Por revisar') === banner, String(tile(lista, 'Por revisar')));
  }

  console.log('== 1b · El punto de arranque manda en el banner, el tile y la lista a la vez ==');
  {
    db.setCorte(enDias(-2)); // deja afuera los 3 pagos viejos
    const cola = db.pagosPorRevisar();
    check('la cola se achica al poner el corte', cola.length === 2, String(cola.length));
    const resumen = (await GET('/admin/leads?key=cu')).html;
    const banner = Number((resumen.match(/<b>(\d+) pagos? por revisar/) || [, 0])[1]);
    check('el banner lo respeta', banner === 2, String(banner));
    const lista = (await GET('/admin/leads?key=cu&vista=pagos&estado=rev&periodo=todo')).html;
    check('el tile lo respeta (antes contaba ignorando el corte)', tile(lista, 'Por revisar') === 2, String(tile(lista, 'Por revisar')));
    check('la lista lo respeta', filasPago(lista) === 2, `${filasPago(lista)} filas`);
    check('…y se dice que los otros quedaron como historial, no que desaparecieron',
      /anteriores? al punto de arranque quedaron como historial/.test(lista));
    db.setCorte('2000-01-01');
  }

  console.log('== 1c · "Para Clarck" cuenta a los que esperan AHORA, y abre a esos ==');
  {
    // Tres derivados: uno que escribió recién, uno de hace 5 días y uno de hace
    // 5 días con el corte por delante. El tile contaba los tres.
    const c = crudo();
    const derivar = (n, diasAtras) => {
      db.getOrCreateLead(n);
      db.updateLead(n, { nombre: `Derivado ${n.slice(-2)}` });
      db.saveMessage(n, 'user', 'tengo un problema');
      db.setHandoff(n, 'queja de prueba');
      if (diasAtras) c.prepare("UPDATE mensajes SET creado_en = datetime('now','-5 hours','-' || ? || ' days') WHERE numero = ?").run(diasAtras, n);
    };
    derivar('51900020001', 0);
    derivar('51900020002', 5);
    derivar('51900020003', 9);
    c.close();

    const activos = db.handoffsActivos();
    check('solo el reciente está "esperando ahora"', activos.length === 1 && activos[0].numero === '51900020001', JSON.stringify(activos.map((a) => a.numero)));
    const resumen = (await GET('/admin/leads?key=cu')).html;
    check('el tile cuenta 1, no los 3 de la historia', tile(resumen, 'Para Clarck ahora') === 1, String(tile(resumen, 'Para Clarck ahora')));
    const destino = (resumen.match(/href="([^"]*filtro=esperando[^"]*)"/) || [, ''])[1].replace(/&amp;/g, '&');
    check('…y lleva a un filtro propio', Boolean(destino), 'el tile no linkea a filtro=esperando');
    const lista = (await GET(destino)).html;
    check('…que muestra exactamente a ese', /Derivado 01/.test(lista) && !/Derivado 02/.test(lista), 'la lista no coincide con el tile');
    const todosDerivados = (await GET('/admin/leads?key=cu&vista=crm&filtro=handoff')).html;
    check('el filtro "todos los derivados" sigue mostrando la historia completa',
      /Derivado 01/.test(todosDerivados) && /Derivado 02/.test(todosDerivados) && /Derivado 03/.test(todosDerivados));
  }

  console.log('== 1d · El Sheet cuenta con las mismas funciones que el panel ==');
  {
    const hojas = sheetsync.armarHojas(db);
    const resumenHoja = hojas.find((h) => h.nombre === 'Resumen');
    const valor = (etiqueta) => (resumenHoja.filas.find((f) => String(f[0]).startsWith(etiqueta)) || [])[1];
    check('"Pagos por revisar" es la MISMA cola del panel', valor('Pagos por revisar') === db.pagosPorRevisar().length, String(valor('Pagos por revisar')));
    check('"Esperando a Clarck ahora" también', valor('Esperando a Clarck ahora') === db.handoffsActivos().length, String(valor('Esperando a Clarck ahora')));
    check('…y el histórico va aparte, no mezclado', typeof valor('Derivados en total') === 'number');
    check('"Con datos completos" usa el mismo criterio que la columna Datos de la hoja Leads',
      valor('Con datos completos') === db.listLeads().filter((l) => l.nombre && l.edad && l.distrito).length,
      String(valor('Con datos completos')));
    check('los partidos abiertos salen de la FASE calculada, no de la columna congelada',
      valor('Con inscripción abierta') === db.listPartidos().filter((p) => p.fase === 'proximo').length,
      String(valor('Con inscripción abierta')));
  }

  console.log('== 1e · Cada escalón del embudo abre EXACTAMENTE la gente que cuenta ==');
  {
    // "Vinieron alguna vez: 120" abría la lista de los que vinieron UNA sola
    // vez (80): el escalón cuenta acumulado y el filtro contaba el tramo.
    const c = crudo();
    const visitasA = (n, cuantas) => {
      db.getOrCreateLead(n);
      db.updateLead(n, { nombre: `Jugador ${n.slice(-3)}`, zona: 'brena' });
      for (let i = 1; i <= cuantas; i++) {
        const id = db.registrarPago({ numero: n, monto: 15, numero_operacion: `CU-EMB-${n}-${i}`, estado: 'confirmado' });
        c.prepare("UPDATE pagos SET creado_en = datetime('now','-5 hours','-' || ? || ' days') WHERE id = ?").run(i, id);
      }
    };
    visitasA('51900070001', 1);
    visitasA('51900070002', 3);
    visitasA('51900070003', 4);
    c.close();

    const resumen = (await GET('/admin/leads?key=cu')).html;
    const escalon = (nombre) => {
      const m = resumen.match(new RegExp(`<span class="zname">${nombre}[\\s\\S]*?<span class="zval">(\\d+)`));
      return m ? Number(m[1]) : null;
    };
    const destinoDe = (nombre) => {
      const m = resumen.match(new RegExp(`href="([^"]+)"[^>]*><span class="zdot"[^>]*></span>\\s*<span class="zname">${nombre}`));
      return m ? m[1].replace(/&amp;/g, '&') : null;
    };
    const filasCrm = (html) => (html.match(/class="lrow"/g) || []).length;

    for (const nombre of ['Vinieron alguna vez', 'Volvieron', 'Caseros']) {
      const n = escalon(nombre);
      const destino = destinoDe(nombre);
      check(`"${nombre}" (${n}) lleva a una lista`, Boolean(destino), 'sin link');
      const lista = (await GET(destino)).html;
      check(`…y esa lista tiene esos mismos ${n}`, filasCrm(lista) === n, `${filasCrm(lista)} filas`);
    }

    // "¿Dónde abrir?" ordena por PAGADORES: el link tiene que abrir a los
    // pagadores de ese distrito, no a todos los interesados.
    db.getOrCreateLead('51900070010');
    db.updateLead('51900070010', { nombre: 'De Ate Pagó', zona: 'otra', distrito: 'Ate' });
    db.registrarPago({ numero: '51900070010', monto: 15, numero_operacion: 'CU-ATE-1', estado: 'confirmado' });
    db.getOrCreateLead('51900070011');
    db.updateLead('51900070011', { nombre: 'De Ate Preguntó', zona: 'otra', distrito: 'Ate' });
    const resumen2 = (await GET('/admin/leads?key=cu')).html;
    const filaAte = resumen2.match(/href="([^"]*distrito=ate[^"]*)"[\s\S]{0,400}?<span class="zval">(\d+) <small[^>]*>pagaron · (\d+) interesados/);
    check('la fila del distrito distingue pagadores de interesados', Boolean(filaAte) && filaAte[2] === '1' && filaAte[3] === '2', filaAte && filaAte.slice(2).join('/'));
    const listaAte = (await GET(filaAte[1].replace(/&amp;/g, '&'))).html;
    check('…y el link abre a los que PAGARON, que es el número que ordena',
      /De Ate Pagó/.test(listaAte) && !/De Ate Preguntó/.test(listaAte), 'la lista no coincide con el número');
  }

  console.log('== 2 · Zona sin precio: ni "S/ 0" ni Yapes confirmados a ciegas ==');
  {
    db.addSede({ zona: 'surco', nombre: 'Cancha Surco', cupo: 14 });
    // Se fuerza el precio vacío como quedaba al guardar la tarjeta en blanco.
    db.setConfig({ precio_surco: '' });
    check('sin precio, la zona vale null (no 0)', db.getNegocio().zonas.surco.precio === null);

    check('el precio de zona se lee en un solo lugar', db.precioDeZona('surco') === null && Number(db.precioDeZona('brena')) > 0);

    const p = db.crearPartido({ zona: 'surco', fecha: enDias(1), hora: '8-9pm', cupo: 14 });
    check('un partido sin precio propio hereda el de su zona… o ninguno', db.precioDePartido(db.getPartido(p)) === null);
    check('la lista para el grupo dice "por confirmar", no "S/ 0"',
      /Precio por confirmar/.test(db.textoLista(p)) && !/S\/ 0/.test(db.textoLista(p)), db.textoLista(p).split('\n')[2]);
    const parrilla = atajos.responder({ nombre: 'Test' }, 'que pichangas hay');
    check('la parrilla del bot tampoco cotiza S/ 0',
      !parrilla || (!/S\/ 0/.test(parrilla.respuesta) && /precio por confirmar/.test(parrilla.respuesta)), parrilla && parrilla.respuesta);

    // El agujero grande: sin precio, `precioEsperado > 0` era falso y NO se
    // validaba nada — un Yape de S/1 salía confirmado y ocupaba un cupo.
    db.getOrCreateLead('51900030001');
    db.updateLead('51900030001', { zona: 'surco', nombre: 'Sin Precio' });
    const r = pagos.evaluarVoucher('51900030001', 'surco', {
      es_comprobante_pago: true, medio: 'yape', monto: 1, nombre_remitente: 'X', numero_operacion: 'CU-SP-1', confianza: 'alta',
    });
    check('un Yape de S/1 sobre una zona sin precio NO se confirma', r.estado === 'revisar', r.estado);
    check('…y el motivo dice qué falta cargar', /Sin precio cargado/.test(r.motivo || ''), r.motivo);
    check('…y se avisa a Clarck (es config faltante, no un jugador tramposo)', r.handoff === true);

    // Y el panel no deja volver a dejarla sin precio.
    const rechazo = await POST('/admin/config/zona', { key: 'cu', zona: 'surco', precio: '', grouplink: '', nombre_mostrar: 'Surco' });
    check('guardar una zona con el precio vacío se rechaza', /err=1/.test(rechazo.location));
    check('…explicando que sin precio no se pueden verificar los Yapes', /verificar los Yapes/.test(avisoDe(rechazo.location)), avisoDe(rechazo.location));
    const cero = await POST('/admin/config/zona', { key: 'cu', zona: 'surco', precio: '0', grouplink: '', nombre_mostrar: 'Surco' });
    check('y S/ 0 tampoco es un precio', /err=1/.test(cero.location));
    const nuevoSinPrecio = await POST('/admin/config/zona/nueva', { key: 'cu', nombre: 'La Molina', precio: '', sede: 'Cancha LM' });
    check('un distrito nuevo tampoco nace sin precio', /err=1/.test(nuevoSinPrecio.location) && !db.zonasOperativas().includes('lamolina'));

    await POST('/admin/config/zona', { key: 'cu', zona: 'surco', precio: '12', grouplink: '', nombre_mostrar: 'Surco' });
    check('con precio guardado, la zona vuelve a cotizar', db.getNegocio().zonas.surco.precio === 12);
  }

  console.log('== 3 · El monto se valida contra el PARTIDO que va a jugar, no contra su distrito ==');
  {
    // Caso del prompt: "la zona de un jugador NO lo limita". Alguien de Comas
    // (S/10) que paga S/15 por un partido de Breña quedaba en revisar Y en
    // handoff: se lo silenciaba por pagar bien.
    db.setConfig({ precio_comas: '10', precio_brena: '15' });
    const enBrena = db.crearPartido({ zona: 'brena', fecha: enDias(1), hora: '9-10pm', sede: 'Melgar Cuadre', cupo: 14 });
    db.getOrCreateLead('51900040001');
    db.updateLead('51900040001', { zona: 'comas', nombre: 'Viajero' });

    const r = pagos.evaluarVoucher('51900040001', 'comas', {
      es_comprobante_pago: true, medio: 'yape', monto: 15, nombre_remitente: 'Viajero', numero_operacion: 'CU-CRUZ-1', confianza: 'alta',
    });
    check('S/15 de alguien de Comas se ACEPTA si hay un partido de Breña a S/15', r.estado === 'confirmado', `${r.estado} · ${r.motivo}`);
    check('…con un solo cupo', r.cupos === 1, String(r.cupos));
    check('…y sin derivarlo a Clarck', r.handoff === false);

    // S/45 no es múltiplo de S/10 (su zona) pero sí 3 cupos de S/15 (el partido).
    // Ojo: S/30 SÍ es múltiplo de su zona (3 × 10) y por eso se resuelve antes,
    // sin llegar a mirar los partidos de otras zonas — el precio de su zona
    // sigue siendo la primera hipótesis, como debe ser.
    const tres = pagos.evaluarVoucher('51900040001', 'comas', {
      es_comprobante_pago: true, medio: 'yape', monto: 45, nombre_remitente: 'Viajero', numero_operacion: 'CU-CRUZ-2', confianza: 'alta',
    });
    check('S/45 se lee como 3 cupos de ese partido de Breña', tres.estado === 'confirmado' && tres.cupos === 3, `${tres.estado} ${tres.cupos}`);
    const suZona = pagos.evaluarVoucher('51900040001', 'comas', {
      es_comprobante_pago: true, medio: 'yape', monto: 30, nombre_remitente: 'Viajero', numero_operacion: 'CU-CRUZ-2b', confianza: 'alta',
    });
    check('…y S/30 sigue leyéndose como 3 cupos de SU zona (S/10), que es la primera hipótesis',
      suZona.estado === 'confirmado' && suZona.cupos === 3, `${suZona.estado} ${suZona.cupos}`);

    const raro = pagos.evaluarVoucher('51900040001', 'comas', {
      es_comprobante_pago: true, medio: 'yape', monto: 17, nombre_remitente: 'Viajero', numero_operacion: 'CU-CRUZ-3', confianza: 'alta',
    });
    check('un monto que no calza con NINGÚN partido sigue yendo a revisar', raro.estado === 'revisar', raro.estado);

    // Con reserva propia el precio esperado no es una suposición: es lo que se
    // le prometió. Ahí un monto distinto sí es para revisar.
    const propio = db.crearPartido({ zona: 'comas', fecha: enDias(2), hora: '8-9pm', sede: 'Politécnico Cuadre', cupo: 14, precio: 20 });
    db.inscribir(propio, '51900040001', { nombre: 'Viajero' });
    const conReserva = pagos.evaluarVoucher('51900040001', 'comas', {
      es_comprobante_pago: true, medio: 'yape', monto: 15, nombre_remitente: 'Viajero', numero_operacion: 'CU-CRUZ-4', confianza: 'alta',
    });
    check('con una reserva de S/20, pagar S/15 sí es para revisar', conReserva.estado === 'revisar', conReserva.estado);
    check('partidosQueCalzan mira todas las zonas y prefiere la suya',
      db.partidosQueCalzan(20, 'comas')[0].partido.zona === 'comas');
  }

  console.log('== 4 · El espejo a Sheets avisa cuando se muere (y cuando corre código viejo) ==');
  {
    const fetchReal = globalThis.fetch;
    process.env.SHEET_WEBHOOK_URL = 'https://script.google.com/simulado';
    process.env.SHEET_SECRET = 'secreto';
    delete require.cache[require.resolve('./src/sheetsync')];
    const espejo = require('./src/sheetsync');

    correos.length = 0;
    globalThis.fetch = async () => { throw new Error('getaddrinfo ENOTFOUND'); };
    let r = await espejo.syncToSheet(db);
    check('un fallo no tira excepción', r.ok === false);
    check('el 1.er fallo NO manda correo (puede ser un hipo de red)', correos.length === 0);
    await espejo.syncToSheet(db);
    check('el 2.º tampoco', correos.length === 0);
    r = await espejo.syncToSheet(db);
    check('al 3.º seguido sí avisa por correo', correos.length === 1, JSON.stringify(correos.map((c) => c.asunto)));
    check('…diciendo que la hoja quedó desactualizada', /desactualizada|caído/i.test(correos[0].asunto + correos[0].cuerpo));
    check('…y aclarando que el bot sigue funcionando', /el panel y el bot siguen bien/i.test(correos[0].cuerpo));

    // Versión: el .gs publica su VERSION en cada respuesta y nadie la comparaba.
    correos.length = 0;
    globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true, version: 'v1-vieja', hojas: 4 }) });
    r = await espejo.syncToSheet(db);
    check('con una versión distinta, el sync "funciona" pero se marca', r.ok === true && r.versionOk === false, JSON.stringify(r));
    check('…y sale un correo explicando que hay que PUBLICAR, no solo pegar',
      correos.some((c) => /versión vieja/i.test(c.asunto) && /Implementar/.test(c.cuerpo)), JSON.stringify(correos.map((c) => c.asunto)));
    const antes = correos.length;
    await espejo.syncToSheet(db);
    check('no se repite el aviso cada 6 h (es un estado, no un evento)', correos.length === antes);

    correos.length = 0;
    globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true, version: espejo.VERSION_ESPERADA }) });
    r = await espejo.syncToSheet(db);
    check('con la versión esperada, ni marca ni avisa', r.versionOk === true && correos.length === 0);
    check('la versión esperada es la del archivo .gs que se pega en Google',
      new RegExp(`VERSION = '${espejo.VERSION_ESPERADA}'`).test(fs.readFileSync(path.join(__dirname, 'google-apps-script.gs'), 'utf8')),
      espejo.VERSION_ESPERADA);

    globalThis.fetch = fetchReal;
    delete process.env.SHEET_WEBHOOK_URL;
    delete process.env.SHEET_SECRET;
  }

  console.log('== 5 · El nombre del distrito: una sola respuesta en las tres superficies ==');
  {
    // Renombrar Breña desde Ajustes cambiaba lo que decía el bot y NO lo que
    // decía el panel (tenía su propio mapa escrito a mano).
    await POST('/admin/config/zona', { key: 'cu', zona: 'brena', precio: '15', grouplink: '', nombre_mostrar: 'Breña Centro' });
    check('db.nombreDeZona toma el nombre nuevo', db.nombreDeZona('brena') === 'Breña Centro');

    const partido = db.listPartidos().find((p) => p.zona === 'brena');
    const detalle = (await GET(`/admin/leads?key=cu&vista=partidos&partido=${partido.id}`)).html;
    check('el panel lo usa en el detalle del partido', /Breña Centro/.test(detalle), 'el panel sigue con su mapa a mano');
    const lista = (await GET('/admin/leads?key=cu&vista=partidos')).html;
    check('…y en la grilla de la semana', /Breña Centro/.test(lista));
    check('la lista para el grupo también', /BREÑA CENTRO/.test(db.textoLista(partido.id)));

    // Un distrito nuevo salía con su slug crudo ("surco" en vez de "Surco").
    const resumen = (await GET('/admin/leads?key=cu')).html;
    check('un distrito creado desde Ajustes se ve con su nombre, no con su slug',
      !/>surco</.test(resumen) && !/>lamolina</.test(resumen));

    // El export a Excel tenía su PROPIO mapa, y solo con tres zonas: Rímac,
    // Chorrillos y cualquier distrito nuevo salían con el slug.
    db.getOrCreateLead('51900080001');
    db.updateLead('51900080001', { nombre: 'De Surco', zona: 'surco' });
    const xlsx = await require('./src/excel').buildLeadsWorkbook(db);
    const libro = new (require('./node_modules/exceljs').Workbook)();
    await libro.xlsx.load(Buffer.from(xlsx));
    const zonas = new Set();
    libro.worksheets[0].eachRow((fila) => { const v = fila.getCell(5).value; if (v) zonas.add(String(v)); });
    check('el export a Excel usa el nombre de la zona, no el slug',
      zonas.has('Surco') && !zonas.has('surco'), [...zonas].join('/'));
    await POST('/admin/config/zona', { key: 'cu', zona: 'brena', precio: '15', grouplink: '', nombre_mostrar: 'Breña' });
  }

  console.log('== 6 · Los menores, que también muerden ==');
  {
    console.log('   — cupo: un estado explícito no puede colar gente');
    const lleno = db.crearPartido({ zona: 'brena', fecha: enDias(3), hora: '7-8pm', sede: 'Melgar Cuadre', cupo: 2 });
    db.inscribir(lleno, '51900050001');
    db.inscribir(lleno, '51900050002');
    const forzado = db.inscribir(lleno, '51900050003', { estado: 'reservado' });
    check('inscribir con estado "reservado" explícito respeta el cupo', forzado.inscripcion.estado === 'espera', forzado.inscripcion.estado);
    const ocupados = db.inscripcionesDe(lleno).filter((i) => ['reservado', 'pagado'].includes(i.estado)).length;
    check('la cancha sigue con 2 de 2', ocupados === 2, String(ocupados));

    console.log('   — pago suelto: la cola y el enganche automático miran lo mismo');
    const n = '51900060001';
    db.getOrCreateLead(n);
    db.updateLead(n, { zona: 'brena', nombre: 'Yapeó Antes' });
    const pagoViejo = db.registrarPago({ numero: n, monto: 15, numero_operacion: 'CU-SUELTO', estado: 'confirmado' });
    const c = crudo();
    c.prepare("UPDATE pagos SET creado_en = datetime('now','-5 hours','-3 days') WHERE id = ?").run(pagoViejo);
    c.close();
    check('un pago de hace 3 días sigue en la cola del panel', db.pagosSinPartido().some((p) => p.id === pagoViejo));
    check('…y AHORA también se engancha solo (antes la ventana era de 48 h)', db.pagoSueltoDe(n)?.id === pagoViejo, JSON.stringify(db.pagoSueltoDe(n)));
    db.setCorte(enDias(-1));
    check('el punto de arranque los saca a los DOS a la vez',
      !db.pagosSinPartido().some((p) => p.id === pagoViejo) && db.pagoSueltoDe(n) === null);
    db.setCorte('2000-01-01');

    console.log('   — hora vacía: un partido sin hora se ofrece todo el día');
    const conHora = db.crearPartido({ zona: 'brena', fecha: enDias(4), hora: '8-9pm', sede: 'Melgar Cuadre', cupo: 14 });
    const r = db.actualizarPartido(conHora, { hora: '', cupo: '16' });
    check('guardar el editor con la hora en blanco NO borra la hora', db.getPartido(conHora).hora === '8-9pm', String(db.getPartido(conHora).hora));
    check('…y sigue teniendo su inicio en minutos', db.getPartido(conHora).inicio_min === 1200, String(db.getPartido(conHora).inicio_min));
    check('…el resto del formulario sí se guarda', db.getPartido(conHora).cupo === 16 && r.ok === true);
    check('…y se avisa que quedó la de antes', r.horaIgnorada === true);
    const post = await POST('/admin/partido/editar', { key: 'cu', id: conHora, fecha: enDias(4), hora: '', cupo: '16', precio: '' });
    check('el panel lo dice en la pantalla', /dejaste la hora en blanco/i.test(avisoDe(post.location)), avisoDe(post.location));

    console.log('   — el precio que ve el modelo es el mismo que usa el emparejador');
    {
      // `interpretarPago` le mostraba "S/ ?" al modelo cuando el partido no
      // tenía precio propio —la mayoría—, mientras la aritmética de al lado sí
      // caía al precio de la zona. El modelo decidía sobre plata a ciegas.
      const sinPrecioPropio = db.getPartido(conHora);
      check('el partido no tiene precio propio pero su zona sí',
        sinPrecioPropio.precio == null && db.precioDePartido(sinPrecioPropio) === 15,
        `${sinPrecioPropio.precio} / ${db.precioDePartido(sinPrecioPropio)}`);

      // Se sustituye el SDK entero por uno de mentira (sin red) y se recarga
      // pagos.js encima: así se puede leer el prompt exacto que se manda.
      let promptVisto = null;
      const rutaSdk = require.resolve('openai');
      const sdkReal = require.cache[rutaSdk];
      class SdkFalso {
        constructor() {
          this.chat = { completions: { create: async ({ messages }) => {
            promptVisto = messages.map((m) => m.content).join('\n');
            return { choices: [{ message: { content: JSON.stringify({ partido_id: null, cupos: 1, confianza: 'baja', motivo: 'prueba', partido_no_cargado: false }) } }] };
          } } };
        }
      }
      require.cache[rutaSdk] = { id: rutaSdk, filename: rutaSdk, loaded: true, exports: SdkFalso };
      delete require.cache[require.resolve('./src/pagos')];
      process.env.OPENAI_API_KEY = 'sk-de-mentira';
      const pagosAislado = require('./src/pagos');
      await pagosAislado.interpretarPago(
        [{ rol: 'user', texto: 'ya te yapeé' }],
        [{ ...sinPrecioPropio, restante: 10 }],
        15,
      );
      delete process.env.OPENAI_API_KEY;
      require.cache[rutaSdk] = sdkReal;
      delete require.cache[require.resolve('./src/pagos')];

      check('al modelo se le muestra S/ 15, no "S/ ?"', /S\/ 15 por jugador/.test(promptVisto || ''), (promptVisto || '').slice(0, 400));
      check('…y ya no aparece el "S/ ?" que lo dejaba adivinando', !/S\/ \?/.test(promptVisto || ''));
    }
  }

  console.log(fallos ? `\n❌ ${ok} OK, ${fallos} FALLOS` : `\n✅ ${ok} checks OK, 0 fallos`);
  srv.close(); process.exit(fallos ? 1 : 0);
});
