/**
 * AUTOGESTIÓN — que Clarck pueda manejar su negocio sin que entremos a Render.
 *
 *   node test-autogestion.js        (~5 s, sin red)
 *
 * Cinco decisiones vivían en variables de entorno: si el bot atiende a todos, a
 * qué número van los avisos, qué números son de prueba, a qué correo llega cada
 * cosa y cuántas visitas hacen a un "Casero". Cambiar cualquiera era un pedido
 * hacia nosotros y un redeploy.
 *
 * Lo que se prueba acá:
 *   1. La env var sigue mandando MIENTRAS nadie toque el panel (un deploy no
 *      puede cambiar el comportamiento por su cuenta).
 *   2. Encender el bot CUESTA (palabra escrita + ensayo previo) y apagarlo no.
 *   3. Los interruptores se leen POR MENSAJE: no hace falta reiniciar nada.
 *   4. El respaldo de la BD y los avisos pueden ir a correos distintos.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.WWEBJS_AUTH_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'pich-auto-'));
process.env.ADMIN_KEY = 'auto';
process.env.SAFE_MODE = 'true';
process.env.ALLOWED_TESTERS = '51900000001';
process.env.NOTIFY_NUMBER = '51999000111';
process.env.BACKUP_EMAIL_TO = 'kipi@ejemplo.com';

const db = require('./src/db');
const backup = require('./src/backup');
const { registrarPanel } = require('./src/panel');
const express = require('./node_modules/express');

let ok = 0, fallos = 0;
const check = (nombre, cond, extra = '') => { if (cond) { ok++; console.log(`  ✓ ${nombre}`); } else { fallos++; console.error(`  ✗ ${nombre} ${extra}`); } };

// Semilla mínima: contactos reales para que el aviso cuente gente de verdad.
for (let i = 0; i < 5; i++) db.getOrCreateLead(`5190000010${i}`);

// Canal de WhatsApp simulado: interesa QUÉ se manda y si el panel lo registra.
const mandados = [];
let canalOk = true;
const app = express();
registrarPanel(app, db, {
  estado: () => 'ready', numero: () => '51967870413', qr: () => null,
  desconectar: async () => true,
  enviar: async (numero, texto) => {
    mandados.push({ numero, texto });
    return canalOk ? { ok: true, id: 'x' } : { ok: false, error: 'bot no conectado' };
  },
});

const srv = app.listen(0, async () => {
  const B = `http://127.0.0.1:${srv.address().port}`;
  const GET = async (ruta) => { const r = await fetch(B + ruta); return { status: r.status, html: await r.text() }; };
  const POST = async (ruta, obj) => {
    const r = await fetch(B + ruta, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(obj).toString(), redirect: 'manual' });
    return { status: r.status, location: r.headers.get('location') || '' };
  };
  const avisoDe = (loc) => decodeURIComponent((loc.match(/aviso=([^&#]*)/) || [, ''])[1].replace(/\+/g, ' '));

  console.log('== 1 · Sin tocar nada, manda el entorno (un deploy no cambia el comportamiento) ==');
  check('el modo seguro sale de SAFE_MODE', db.modoSeguro() === true);
  check('los números de prueba salen de ALLOWED_TESTERS', db.numerosDePrueba().join() === '51900000001');
  check('el número de avisos sale de NOTIFY_NUMBER', db.numeroAvisos() === '51999000111');
  check('…y el estado lo dice: todavía manda el entorno', db.estadoBot().fuente === 'entorno');
  check('los dos correos caen al mismo default (decisión del cliente)',
    backup.paraAvisos() === 'kipi@ejemplo.com' && backup.paraRespaldo() === 'kipi@ejemplo.com');

  console.log('== 2 · Encender el bot CUESTA: la palabra escrita y el ensayo previo ==');
  const ajustes = (await GET('/admin/leads?key=auto&vista=config')).html;
  check('Ajustes tiene el interruptor y dice que está apagado', /id="bot"/.test(ajustes) && /El bot está APAGADO/.test(ajustes));
  check('la consecuencia va en contactos REALES, no en "todos los usuarios"', /5 contactos registrados/.test(ajustes), 'sin el número real');
  check('pide escribir la palabra, no un checkbox', /name="confirmacion"/.test(ajustes) && /Escribe ENCENDER/.test(ajustes));
  check('y trae el checklist del ensayo previo',
    /name="ensayo_prueba"/.test(ajustes) && /name="ensayo_bienvenida"/.test(ajustes) && /name="ensayo_mecanica"/.test(ajustes));

  const sinPalabra = await POST('/admin/config/bot', { key: 'auto', accion: 'encender', ensayo_prueba: '1', ensayo_bienvenida: '1', ensayo_mecanica: '1' });
  check('sin escribir ENCENDER no se enciende', db.modoSeguro() === true && /err=1/.test(sinPalabra.location));
  check('…y explica qué falta', /escribe la palabra ENCENDER/i.test(avisoDe(sinPalabra.location)), avisoDe(sinPalabra.location));

  const sinEnsayo = await POST('/admin/config/bot', { key: 'auto', accion: 'encender', confirmacion: 'ENCENDER' });
  check('con la palabra pero sin el ensayo, tampoco', db.modoSeguro() === true && /err=1/.test(sinEnsayo.location));
  check('…y nombra los tres pasos que faltan', /tu propio número/.test(avisoDe(sinEnsayo.location)), avisoDe(sinEnsayo.location));

  const aMedias = await POST('/admin/config/bot', { key: 'auto', accion: 'encender', confirmacion: 'ENCENDER', ensayo_prueba: '1' });
  check('con el ensayo a medias, tampoco', db.modoSeguro() === true && /err=1/.test(aMedias.location));

  const encendido = await POST('/admin/config/bot', {
    key: 'auto', accion: 'encender', confirmacion: 'encender', // minúsculas: se acepta, lo que cuesta es escribirla
    ensayo_prueba: '1', ensayo_bienvenida: '1', ensayo_mecanica: '1',
  });
  check('con la palabra Y el ensayo completo, se enciende', db.modoSeguro() === false, JSON.stringify(db.estadoBot()));
  check('…y el aviso cuenta a cuántos les va a responder', /5 contactos/.test(avisoDe(encendido.location)), avisoDe(encendido.location));

  console.log('== 3 · Queda registrado quién y cuándo ==');
  const est = db.estadoBot();
  check('con fecha y hora', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(est.encendidoEn || ''), String(est.encendidoEn));
  check('con quién lo hizo (panel + IP)', /^panel \(/.test(est.por || ''), String(est.por));
  check('y la fuente pasa a ser el panel, no el entorno', est.fuente === 'panel');
  const resumen = (await GET('/admin/leads?key=auto')).html;
  check('el Resumen dice desde cuándo está encendido', /Encendido desde el/.test(resumen), 'sin la fecha');

  console.log('== 4 · Apagar es un toque, y desde el Resumen ==');
  check('el Resumen trae el botón de apagar', /action="\/admin\/bot\/apagar"/.test(resumen));
  const apagado = await POST('/admin/bot/apagar', { key: 'auto' });
  check('un solo POST, sin palabra ni checklist', db.modoSeguro() === true && !/err=1/.test(apagado.location));
  check('…y avisa que lo que llegue se sigue registrando', /se sigue registrando/.test(avisoDe(apagado.location)), avisoDe(apagado.location));
  check('el apagado también queda fechado', /^\d{4}-\d{2}-\d{2}/.test(db.estadoBot().apagadoEn || ''));

  console.log('== 5 · El interruptor se lee POR MENSAJE (sin reiniciar nada) ==');
  {
    // index.js leía SAFE_MODE una sola vez al arrancar: cambiarlo exigía un
    // deploy. Acá se prueba lo que hace el bot en caliente, sin recargar módulos.
    db.setBotEncendido(true, 'prueba');
    check('el bot ve el cambio al instante', db.modoSeguro() === false);
    db.setBotEncendido(false, 'prueba');
    check('y el apagado también', db.modoSeguro() === true);
    // El panel tiene que leer LO MISMO: si el panel mirara el entorno y el bot
    // la BD, apagar desde Ajustes dejaría el Resumen diciendo que está prendido.
    const r = (await GET('/admin/leads?key=auto')).html;
    check('el panel lee el mismo interruptor que el bot', /El bot está apagado/.test(r), 'el Resumen no refleja el estado');
  }

  console.log('== 6 · Los avisos: número editable y botón que PRUEBA que llegan ==');
  {
    const r = await POST('/admin/config/avisos', { key: 'auto', notify_numero: '51 955 444 333', testers: '51900000009, 51900000008' });
    check('el número se guarda normalizado a dígitos', db.numeroAvisos() === '51955444333', db.numeroAvisos());
    check('los números de prueba también', db.numerosDePrueba().join() === '51900000009,51900000008', db.numerosDePrueba().join());
    check('y avisa que hay que probarlo', /probalo/.test(avisoDe(r.location)), avisoDe(r.location));

    check('cambiar el número invalida la prueba anterior', db.avisosProbadoEn() === null);
    // Borrarlo tiene que BORRARLO: si volviera a caer en la env var, los avisos
    // seguirían yendo a un teléfono que Clarck cree haber sacado.
    db.setNumeroAvisos('');
    check('vaciar el número NO resucita el de Render', db.numeroAvisos() === '', db.numeroAvisos());
    db.setNumeroAvisos('51955444333');
    const cfg = (await GET('/admin/leads?key=auto&vista=config')).html;
    check('Ajustes señala que nunca se probó', /Todavía sin probar/.test(cfg));
    const pendientes = (await GET('/admin/leads?key=auto')).html;
    check('…y el Resumen lo pone como pendiente', /nunca se probó/.test(pendientes), 'sin la fila de pendiente');

    const prueba = await POST('/admin/config/avisos/probar', { key: 'auto' });
    check('el botón manda un WhatsApp DE VERDAD', mandados.length === 1 && mandados[0].numero === '51955444333', JSON.stringify(mandados));
    check('…con un texto que se entiende al leerlo', /Prueba de Pichangueros/.test(mandados[0].texto));
    check('…y queda registrado que llegó', /^\d{4}-\d{2}-\d{2}/.test(db.avisosProbadoEn() || ''));
    check('…sin marcar error', !/err=1/.test(prueba.location));
    const cfg2 = (await GET('/admin/leads?key=auto&vista=config')).html;
    check('Ajustes ahora lo da por probado', /Probado el/.test(cfg2) && !/Todavía sin probar/.test(cfg2));

    // Si el envío falla, NO se puede dar por probado: sería la mentira que este
    // botón viene a evitar.
    canalOk = false;
    const falla = await POST('/admin/config/avisos/probar', { key: 'auto' });
    check('si el canal falla, lo dice y marca error', /err=1/.test(falla.location) && /No se pudo enviar/.test(avisoDe(falla.location)), avisoDe(falla.location));
    canalOk = true;
  }

  console.log('== 7 · Dos correos: los avisos por un lado, la BASE ENTERA por otro ==');
  {
    const cfg = (await GET('/admin/leads?key=auto&vista=config')).html;
    check('Ajustes los muestra separados', /name="aviso_email"/.test(cfg) && /name="backup_email"/.test(cfg));
    check('…y dice qué viaja en el respaldo', /conversaciones completas/.test(cfg), 'sin advertir qué contiene');
    check('…exponiendo el default de KIPI en vez de esconderlo', /kipi@ejemplo\.com/.test(cfg));

    const r = await POST('/admin/config/correos', { key: 'auto', aviso_email: 'clarck@pichangueros.pe', backup_email: '' });
    check('el correo de avisos se separa del de respaldo',
      backup.paraAvisos() === 'clarck@pichangueros.pe' && backup.paraRespaldo() === 'kipi@ejemplo.com',
      `${backup.paraAvisos()} / ${backup.paraRespaldo()}`);
    check('y el aviso dice a dónde va cada cosa', /Respaldo de la base/.test(avisoDe(r.location)), avisoDe(r.location));

    const malo = await POST('/admin/config/correos', { key: 'auto', aviso_email: 'esto-no-es-un-correo', backup_email: '' });
    check('un correo inválido se rechaza (si no, los avisos se pierden)', /err=1/.test(malo.location));
    check('…y el anterior sigue en pie', backup.paraAvisos() === 'clarck@pichangueros.pe');

    const vacio = await POST('/admin/config/correos', { key: 'auto', aviso_email: '', backup_email: '' });
    check('vaciarlo vuelve al default de KIPI', backup.paraAvisos() === 'kipi@ejemplo.com' && !/err=1/.test(vacio.location));
  }

  console.log('== 8 · "Casero" es una regla de Clarck, no una constante nuestra ==');
  {
    // Con los datos reales el tope son 5 visitas y el umbral 6: el filtro
    // "Caseros" muestra CERO y siempre lo haría hasta que alguien venga una
    // sexta vez. Tiene que poder bajarlo.
    const n = '51900000200';
    db.getOrCreateLead(n);
    db.updateLead(n, { nombre: 'Cinco Visitas', zona: 'brena' });
    const conn = new (require('node:sqlite').DatabaseSync)(db.dbPath);
    for (let i = 1; i <= 5; i++) {
      const id = db.registrarPago({ numero: n, monto: 15, numero_operacion: `AUTO-${i}`, estado: 'confirmado' });
      conn.prepare("UPDATE pagos SET creado_en = datetime('now','-5 hours','-' || ? || ' days') WHERE id = ?").run(i, id);
    }
    conn.close();
    check('tiene 5 visitas', db.metricasDe(n).visitas === 5, String(db.metricasDe(n).visitas));
    check('con el corte en 6 NO es casero (y el filtro sale vacío)', db.relacionDe(db.metricasDe(n).visitas) !== 'casero');

    const cfg = (await GET('/admin/leads?key=auto&vista=config')).html;
    check('Ajustes lo dice sin rodeos: hoy nadie llega', /Hoy nadie llega/.test(cfg), 'no explica por qué el filtro sale vacío');

    const r = await POST('/admin/config/casero', { key: 'auto', recurrente_desde: '4' });
    check('bajado a 4, ahora sí es casero', db.relacionDe(db.metricasDe(n).visitas) === 'casero');
    check('…y el aviso dice cuántos quedaron', /casero/.test(avisoDe(r.location)), avisoDe(r.location));
    check('el cambio llega al CRM', /Casero/.test((await GET('/admin/leads?key=auto&vista=crm&rel=casero')).html));
    check('…y a la etiqueta del tramo, que se recalcula', db.RELACIONES.casero.largo === 'Casero (4+ visitas)', db.RELACIONES.casero.largo);
    check('un valor absurdo se acota en vez de romper', db.setRecurrenteDesde('999') === 50 && db.setRecurrenteDesde(0) === 6);
    db.setRecurrenteDesde(6);
  }

  console.log('== 9 · Lo que NO se expone (decisión tomada) ==');
  {
    const cfg = (await GET('/admin/leads?key=auto&vista=config')).html;
    // Un typo en las credenciales de Meta deja al bot mudo Y sin canal para
    // avisar que quedó mudo. No hay formulario que las toque.
    for (const prohibido of ['META_TOKEN', 'OPENAI_API_KEY', 'DEBOUNCE_MS', 'RESPUESTA_DELAY_MS', 'TRANSPORTE']) {
      check(`Ajustes no ofrece editar ${prohibido}`, !cfg.includes(prohibido));
    }
    check('ni el prompt del cerebro', !/name="prompt/.test(cfg));
  }

  console.log(fallos ? `\n❌ ${ok} OK, ${fallos} FALLOS` : `\n✅ ${ok} checks OK, 0 fallos`);
  srv.close(); process.exit(fallos ? 1 : 0);
});
