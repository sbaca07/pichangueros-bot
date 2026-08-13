/**
 * Pruebas del transporte OFICIAL (src/meta.js) — se corre con `node test-meta.js`.
 *
 * No toca la BD, el cerebro ni WhatsApp: levanta un express de mentira con el
 * webhook registrado, le mete payloads como los que manda Meta y verifica que
 * salgan mensajes con la forma que espera manejarMensaje(). El `fetch` global se
 * reemplaza por un doble para no llamar a la Graph API de verdad.
 *
 * Las credenciales se setean ANTES de requerir el módulo porque meta.js las lee
 * al cargarse.
 */

process.env.META_TOKEN = 'token-de-prueba';
process.env.META_PHONE_NUMBER_ID = '123456789';
process.env.META_VERIFY_TOKEN = 'verificame';
process.env.META_APP_SECRET = 'secreto-de-app';

const crypto = require('crypto');
const express = require('express');
const meta = require('./src/meta');

let ok = 0;
let fallos = 0;
function check(nombre, condicion, detalle = '') {
  if (condicion) { ok++; console.log(`  ✓ ${nombre}`); }
  else { fallos++; console.error(`  ✗ ${nombre}${detalle ? ` — ${detalle}` : ''}`); }
}

// --- Servidor de prueba --------------------------------------------------------

const recibidos = [];
const echoes = [];
const alertas = [];

const app = express();
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
meta.registrarWebhook(app, {
  onMensaje: (sock, msg) => { recibidos.push({ sock, msg }); },
  onEcho: (msg) => { echoes.push(msg); },
  onAlerta: (aviso) => { alertas.push(aviso); },
});

const server = app.listen(0);
const base = () => `http://127.0.0.1:${server.address().port}`;

function firmar(cuerpo) {
  return 'sha256=' + crypto.createHmac('sha256', process.env.META_APP_SECRET).update(cuerpo).digest('hex');
}

async function postWebhook(payload, { firma = true, firmaMala = false } = {}) {
  const cuerpo = JSON.stringify(payload);
  const headers = { 'Content-Type': 'application/json' };
  if (firma) headers['X-Hub-Signature-256'] = firmaMala ? 'sha256=' + '0'.repeat(64) : firmar(cuerpo);
  return fetch(`${base()}/webhook/meta`, { method: 'POST', headers, body: cuerpo });
}

/** Payload con la forma real del webhook de Meta. */
function sobre(valor, field = 'messages') {
  return { object: 'whatsapp_business_account', entry: [{ id: 'WABA', changes: [{ field, value: valor }] }] };
}

// --- Doble del fetch a la Graph API --------------------------------------------

const fetchReal = global.fetch;
let llamadasGraph = [];
function mockGraph(respuesta = { messages: [{ id: 'wamid.TEST' }] }, status = 200) {
  global.fetch = async (url, opts) => {
    if (String(url).includes('127.0.0.1')) return fetchReal(url, opts); // el webhook local pasa derecho
    llamadasGraph.push({ url: String(url), opts });
    return { ok: status === 200, status, json: async () => respuesta, arrayBuffer: async () => Buffer.from('binario') };
  };
}

// --- Pruebas -------------------------------------------------------------------

async function main() {
  console.log('\n== Verificación del webhook (GET) ==');
  {
    const r = await fetch(`${base()}/webhook/meta?hub.mode=subscribe&hub.verify_token=verificame&hub.challenge=desafio123`);
    check('token correcto → devuelve el challenge', (await r.text()) === 'desafio123');

    const malo = await fetch(`${base()}/webhook/meta?hub.mode=subscribe&hub.verify_token=otro&hub.challenge=x`);
    check('token incorrecto → 403', malo.status === 403, `status=${malo.status}`);

    const sinModo = await fetch(`${base()}/webhook/meta?hub.verify_token=verificame&hub.challenge=x`);
    check('sin hub.mode → 403', sinModo.status === 403, `status=${sinModo.status}`);
  }

  console.log('\n== Firma X-Hub-Signature-256 ==');
  {
    recibidos.length = 0;
    const buena = await postWebhook(sobre({ messages: [{ id: 'm1', from: '51943791755', type: 'text', text: { body: 'hola' } }] }));
    check('firma válida → 200', buena.status === 200, `status=${buena.status}`);

    const mala = await postWebhook(sobre({ messages: [{ id: 'm2', from: '51943791755', type: 'text', text: { body: 'falso' } }] }), { firmaMala: true });
    check('firma inválida → 403', mala.status === 403, `status=${mala.status}`);

    const sin = await postWebhook(sobre({ messages: [{ id: 'm3', from: '51943791755', type: 'text', text: { body: 'falso' } }] }), { firma: false });
    check('sin firma → 403', sin.status === 403, `status=${sin.status}`);

    await new Promise((r) => setTimeout(r, 20));
    check('solo el mensaje firmado llegó al cerebro', recibidos.length === 1, `llegaron ${recibidos.length}`);
  }

  console.log('\n== Normalización a la forma Baileys ==');
  {
    recibidos.length = 0;
    await postWebhook(sobre({ messages: [{ id: 'wamid.1', from: '+51 943 791 755', type: 'text', text: { body: 'quiero jugar' } }] }));
    await new Promise((r) => setTimeout(r, 20));
    const { msg } = recibidos[0] || {};
    check('jid armado con el número limpio', msg?.key?.remoteJid === '51943791755@s.whatsapp.net', msg?.key?.remoteJid);
    check('fromMe = false en mensajes de clientes', msg?.key?.fromMe === false);
    check('el texto va en message.conversation', msg?.message?.conversation === 'quiero jugar');
    check('conserva el id de Meta', msg?.key?.id === 'wamid.1');
  }

  console.log('\n== Mensajes sin número de contacto (11 y 12 de agosto) ==');
  {
    // 68 mensajes el 12-ago y 48 el 11 se loguearon como "DM de  (…)": el
    // payload llegó sin `from` y se armaba el jid "@s.whatsapp.net", así que
    // conversaciones de gente distinta se apilaban en UN lead de clave vacía.
    recibidos.length = 0;
    await postWebhook(sobre({ messages: [{ id: 'sin-from-1', type: 'text', text: { body: 'Separame' } }] }));
    await new Promise((r) => setTimeout(r, 20));
    check('un mensaje sin `from` NO llega al cerebro', recibidos.length === 0, `recibidos=${recibidos.length}`);

    // Pero antes de descartarlo se busca el número donde Meta también lo manda.
    recibidos.length = 0;
    await postWebhook(sobre({
      contacts: [{ wa_id: '51955508975', profile: { name: 'Jugador' } }],
      messages: [{ id: 'sin-from-2', type: 'text', text: { body: 'Ahora te yapeo' } }],
    }));
    await new Promise((r) => setTimeout(r, 20));
    check('sin `from`, el número sale de contacts[].wa_id', recibidos[0]?.msg?.key?.remoteJid === '51955508975@s.whatsapp.net', recibidos[0]?.msg?.key?.remoteJid);

    echoes.length = 0;
    await postWebhook(sobre({
      contacts: [{ wa_id: '51955508975' }],
      message_echoes: [{ id: 'sin-to-1', from: '51915395067', type: 'text', text: { body: 'ya te agrego' } }],
    }));
    await new Promise((r) => setTimeout(r, 20));
    check('un echo sin `to` también recupera el número', echoes[0]?.key?.remoteJid === '51955508975@s.whatsapp.net', echoes[0]?.key?.remoteJid);

    // Y nunca se fabrica un jid vacío, pase lo que pase.
    check('aMensajeBaileys sin número devuelve null', meta.aMensajeBaileys({ id: 'x', type: 'text', text: { body: 'hola' } }, false) === null);
    check('`from` sin dígitos tampoco pasa', meta.aMensajeBaileys({ id: 'x', from: '+++', type: 'text', text: { body: 'hola' } }, false) === null);
  }

  console.log('\n== Imagen (voucher de Yape) ==');
  {
    recibidos.length = 0;
    mockGraph({ url: 'https://lookaside.fb/media/abc' });
    await postWebhook(sobre({ messages: [{ id: 'wamid.2', from: '51943791755', type: 'image', image: { id: 'MEDIA_1', caption: 'ya yapeé' } }] }));
    await new Promise((r) => setTimeout(r, 20));
    const { msg } = recibidos[0] || {};
    check('llega como imageMessage', Boolean(msg?.message?.imageMessage));
    check('conserva el caption', msg?.message?.imageMessage?.caption === 'ya yapeé');
    check('expone _descargar() para bajar el media', typeof msg?._descargar === 'function');

    const bin = await msg._descargar();
    check('_descargar() devuelve un Buffer', Buffer.isBuffer(bin), typeof bin);
    check('pidió la url firmada del media_id', llamadasGraph.some((c) => c.url.includes('/MEDIA_1')));
  }

  console.log('\n== Echoes de coexistencia (Clarck responde a mano) ==');
  {
    echoes.length = 0;
    recibidos.length = 0;
    await postWebhook(sobre({ message_echoes: [{ id: 'wamid.3', to: '51943791755', from: '51915395067', type: 'text', text: { body: 'ya te paso el link' } }] }));
    await new Promise((r) => setTimeout(r, 20));
    check('el echo se registra como respuesta manual', echoes.length === 1, `echoes=${echoes.length}`);
    check('el echo NO despierta al cerebro', recibidos.length === 0, `recibidos=${recibidos.length}`);
    check('fromMe = true', echoes[0]?.key?.fromMe === true);
    check('el jid del echo es el DESTINATARIO, no el negocio', echoes[0]?.key?.remoteJid === '51943791755@s.whatsapp.net', echoes[0]?.key?.remoteJid);
  }

  console.log('\n== Tipos no soportados y estados ==');
  {
    recibidos.length = 0;
    await postWebhook(sobre({ messages: [{ id: 'r1', from: '51943791755', type: 'reaction', reaction: { emoji: '👍' } }] }));
    await new Promise((r) => setTimeout(r, 20));
    check('una reacción se ignora sin romper', recibidos.length === 0, `recibidos=${recibidos.length}`);

    const r = await postWebhook(sobre({ statuses: [{ id: 's1', status: 'failed', recipient_id: '51943791755', errors: [{ code: 131047, title: 'fuera de ventana' }] }] }));
    check('un status failed responde 200 y no tumba el server', r.status === 200);

    const vacio = await postWebhook({ object: 'whatsapp_business_account' });
    check('payload sin entry responde 200', vacio.status === 200);
  }

  console.log('\n== Handshake sin credenciales (alta del webhook antes del token) ==');
  {
    // Para dar de alta el webhook en Dualhook, Meta pega un GET con el
    // challenge — pero eso pasa ANTES de tener token/phone_number_id. Se expone
    // solo el GET; el POST no se registra, asi que no se puede ingerir nada.
    const previo = { ...process.env };
    process.env.META_TOKEN = '';
    process.env.META_PHONE_NUMBER_ID = '';
    process.env.META_VERIFY_TOKEN = 'solo-verificacion';
    delete require.cache[require.resolve('./src/meta')];
    const soloVerif = require('./src/meta');
    process.env = previo;
    delete require.cache[require.resolve('./src/meta')];

    check('sin credenciales, activo() sigue en false', soloVerif.activo() === false);

    const app2 = express();
    const reg = soloVerif.registrarVerificacion(app2);
    check('registrarVerificacion() devuelve true con verify token', reg === true);
    const srv2 = app2.listen(0);
    const b2 = `http://127.0.0.1:${srv2.address().port}`;

    const ok2 = await fetch(`${b2}/webhook/meta?hub.mode=subscribe&hub.verify_token=solo-verificacion&hub.challenge=reto`);
    check('el handshake responde el challenge sin credenciales', (await ok2.text()) === 'reto');

    const mal2 = await fetch(`${b2}/webhook/meta?hub.mode=subscribe&hub.verify_token=otro&hub.challenge=x`);
    check('verify token incorrecto → 403', mal2.status === 403, `status=${mal2.status}`);

    const post2 = await fetch(`${b2}/webhook/meta`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    check('la INGESTA sigue cerrada → 404', post2.status === 404, `status=${post2.status}`);
    srv2.close();

    // Sin verify token no se registra nada: no exponemos una ruta inútil.
    const previo2 = { ...process.env };
    process.env.META_VERIFY_TOKEN = '';
    delete require.cache[require.resolve('./src/meta')];
    const sinNada = require('./src/meta');
    process.env = previo2;
    delete require.cache[require.resolve('./src/meta')];
    const app3 = express();
    check('sin verify token no se registra el handshake', sinNada.registrarVerificacion(app3) === false);
  }

  console.log('\n== activo(): placeholders NO cuentan como credenciales ==');
  {
    // Regresión del incidente 2026-08: Render tenía
    // META_PHONE_NUMBER_ID=PENDIENTE-reemplazar-con-phone-number-id y el
    // Boolean() original lo daba por válido → el bot apagó Baileys, abrió el
    // webhook sin App Secret y reportó ready durante un mes, mudo.
    // meta.js lee el env al cargarse, así que se recarga el módulo por caso.
    const recargar = (envs) => {
      const previo = { ...process.env };
      Object.assign(process.env, envs);
      delete require.cache[require.resolve('./src/meta')];
      const mod = require('./src/meta');
      process.env = previo;
      delete require.cache[require.resolve('./src/meta')];
      return mod;
    };
    const buenas = { META_TOKEN: 'EAAG7ZBxyz0011TokenDeVerdad', META_PHONE_NUMBER_ID: '123456789012345', META_VERIFY_TOKEN: 'verificame' };

    check('credenciales reales → activo', recargar(buenas).activo() === true);
    // Un token real puede traer "xxx"/"todo" como subcadena: no debe rechazarse.
    check('token con "xxx" adentro NO se confunde con placeholder', recargar({ ...buenas, META_TOKEN: 'EAAxxxTokenReal' }).activo() === true);

    const ph = recargar({ ...buenas, META_PHONE_NUMBER_ID: 'PENDIENTE-reemplazar-con-phone-number-id' });
    check('el placeholder EXACTO de producción → NO activo', ph.activo() === false);
    check('y el motivo nombra la variable', /META_PHONE_NUMBER_ID/.test(ph.motivoInactivo()), ph.motivoInactivo());

    check('phone_number_id no numérico → NO activo', recargar({ ...buenas, META_PHONE_NUMBER_ID: 'abc123' }).activo() === false);
    check('token con "reemplazar" → NO activo', recargar({ ...buenas, META_TOKEN: 'reemplazar-con-el-token' }).activo() === false);
    check('verify token "TODO" → NO activo', recargar({ ...buenas, META_VERIFY_TOKEN: 'TODO' }).activo() === false);

    const vacio = recargar({ ...buenas, META_TOKEN: '' });
    check('token vacío → NO activo', vacio.activo() === false);
    check('el motivo distingue vacía de placeholder', /META_TOKEN vacía/.test(vacio.motivoInactivo()), vacio.motivoInactivo());

    check('motivo vacío cuando todo está bien', recargar(buenas).motivoInactivo() === '', recargar(buenas).motivoInactivo());
  }

  console.log('\n== Alertas de salud de la cuenta ==');
  {
    alertas.length = 0;
    recibidos.length = 0;

    await postWebhook(sobre({ display_phone_number: '51915395067', event: 'FLAGGED', current_limit: 'TIER_1K' }, 'phone_number_quality_update'));
    await new Promise((r) => setTimeout(r, 20));
    check('calidad del número dispara aviso', alertas.length === 1, `alertas=${alertas.length}`);
    check('el aviso dice el evento y el límite', /FLAGGED/.test(alertas[0] || '') && /TIER_1K/.test(alertas[0] || ''), alertas[0]);

    await postWebhook(sobre({ phone_number: '51915395067', event: 'ACCOUNT_RESTRICTION', ban_info: { waba_ban_state: 'SCHEDULE_FOR_DISABLE' } }, 'account_update'));
    await new Promise((r) => setTimeout(r, 20));
    check('restricción de la cuenta dispara aviso', alertas.length === 2, `alertas=${alertas.length}`);
    check('el aviso incluye el ban_state', /SCHEDULE_FOR_DISABLE/.test(alertas[1] || ''), alertas[1]);

    await postWebhook(sobre({ decision: 'REJECTED' }, 'account_review_update'));
    await new Promise((r) => setTimeout(r, 20));
    check('revisión de la cuenta dispara aviso', alertas.length === 3 && /REJECTED/.test(alertas[2] || ''), alertas[2]);

    check('ninguna alerta despertó al cerebro', recibidos.length === 0, `recibidos=${recibidos.length}`);

    const sinFirma = await postWebhook(sobre({ event: 'DISABLED_UPDATE' }, 'account_update'), { firma: false });
    check('una alerta sin firma se rechaza igual que un mensaje', sinFirma.status === 403, `status=${sinFirma.status}`);
    await new Promise((r) => setTimeout(r, 20));
    check('la alerta sin firma no llegó', alertas.length === 3, `alertas=${alertas.length}`);

    const desconocido = await postWebhook(sobre({ cosa: 1 }, 'template_status_update'));
    check('un field que no manejamos responde 200 sin romper', desconocido.status === 200, `status=${desconocido.status}`);
    await new Promise((r) => setTimeout(r, 20));
    check('un field desconocido no genera aviso', alertas.length === 3, `alertas=${alertas.length}`);
  }

  console.log('\n== Campos hostiles: no heredar de Object.prototype ==');
  {
    // `change.field` viene del payload. Con ALERTAS como objeto literal,
    // ALERTAS['toString'] heredaba de Object.prototype y daba truthy: un POST con
    // field:"toString" mandaba "[object Object]" al número de control, y
    // field:"__proto__" tiraba TypeError que abortaba el loop entero.
    for (const hostil of ['toString', 'constructor', 'valueOf', 'hasOwnProperty', '__proto__']) {
      alertas.length = 0;
      const r = await postWebhook(sobre({ cosa: 1 }, hostil));
      check(`field:"${hostil}" → 200 sin avisar`, r.status === 200 && alertas.length === 0, `status=${r.status} alertas=${alertas.length}`);
    }

    // El caso que se comía mensajes: un change hostil ANTES de uno legítimo.
    recibidos.length = 0;
    alertas.length = 0;
    await postWebhook({
      object: 'whatsapp_business_account',
      entry: [{ id: 'W', changes: [
        { field: '__proto__', value: {} },
        { field: 'messages', value: { messages: [{ id: 'no-perder', from: '51943791755', type: 'text', text: { body: 'hola quiero jugar' } }] } },
      ] }],
    });
    await new Promise((r) => setTimeout(r, 30));
    check('un field hostil NO se come el mensaje legítimo que viene después', recibidos.length === 1, `recibidos=${recibidos.length}`);
  }

  console.log('\n== account_alerts y eventos que dejan el bot mudo ==');
  {
    alertas.length = 0;
    await postWebhook(sobre({ alert_info: { alert_severity: 'WARNING', alert_status: 'ACTIVE', alert_type: 'INCREASED_CAPABILITIES_ELIGIBILITY_DEFERRED', alert_description: 'Limits cannot be increased' } }, 'account_alerts'));
    await new Promise((r) => setTimeout(r, 20));
    check('account_alerts dispara aviso', alertas.length === 1, `alertas=${alertas.length}`);
    check('el aviso trae severidad y tipo', /WARNING/.test(alertas[0] || '') && /DEFERRED/.test(alertas[0] || ''), alertas[0]);

    // PARTNER_REMOVED es EL evento que avisa que la coexistencia se cayó.
    alertas.length = 0;
    await postWebhook(sobre({ event: 'PARTNER_REMOVED', disconnection_info: { reason: 'inactivity' } }, 'account_update'));
    await new Promise((r) => setTimeout(r, 20));
    check('PARTNER_REMOVED se marca como corte grave', /🚨/.test(alertas[0] || '') && /DESCONECTÓ/.test(alertas[0] || ''), alertas[0]);

    // quality_update ya no reporta calidad: no inventar que bajó.
    alertas.length = 0;
    await postWebhook(sobre({ event: 'THROUGHPUT_UPGRADE', max_daily_conversations_per_business: 'TIER_1K' }, 'phone_number_quality_update'));
    await new Promise((r) => setTimeout(r, 20));
    check('quality_update NO dice "bajó la calidad"', !/CALIDAD/.test(alertas[0] || ''), alertas[0]);
    check('usa max_daily_conversations_per_business', /TIER_1K/.test(alertas[0] || ''), alertas[0]);
  }

  console.log('\n== Idempotencia: Meta reintenta ==');
  {
    recibidos.length = 0;
    const dup = sobre({ messages: [{ id: 'wamid.REPETIDO', from: '51943791755', type: 'text', text: { body: 'una sola vez' } }] });
    await postWebhook(dup);
    await postWebhook(dup);
    await new Promise((r) => setTimeout(r, 30));
    check('el mismo id entregado dos veces se procesa una sola', recibidos.length === 1, `recibidos=${recibidos.length}`);
  }

  console.log('\n== Handshake: content-type ==');
  {
    const r = await fetch(`${base()}/webhook/meta?hub.mode=subscribe&hub.verify_token=verificame&hub.challenge=%3Cscript%3E1%3C/script%3E`);
    check('el challenge se devuelve como text/plain', /text\/plain/.test(r.headers.get('content-type') || ''), r.headers.get('content-type'));
    check('y sin alterar el contenido', (await r.text()) === '<script>1</script>');
  }

  console.log('\n== Envío por la Graph API ==');
  {
    llamadasGraph = [];
    mockGraph();
    const res = await meta.enviarTexto('51943791755', 'nos vemos 7:45');
    check('devuelve la forma {key:{id}} de Baileys', res?.key?.id === 'wamid.TEST', JSON.stringify(res));

    const [call] = llamadasGraph;
    const body = JSON.parse(call.opts.body);
    check('pega al phone_number_id correcto', call.url.includes('/123456789/messages'), call.url);
    check('manda el Bearer token', call.opts.headers.Authorization === 'Bearer token-de-prueba');
    check('messaging_product = whatsapp', body.messaging_product === 'whatsapp');
    check('el texto viaja en text.body', body.text?.body === 'nos vemos 7:45');

    llamadasGraph = [];
    await meta.sockAdapter.sendMessage('51943791755@s.whatsapp.net', { text: 'por el adaptador' });
    check('sockAdapter.sendMessage limpia el @s.whatsapp.net', JSON.parse(llamadasGraph[0].opts.body).to === '51943791755');

    mockGraph({ error: { message: 'Invalid OAuth access token' } }, 401);
    let tiro = null;
    try { await meta.enviarTexto('51943791755', 'x'); } catch (e) { tiro = e.message; }
    check('un 401 de Meta se propaga como error legible', /401/.test(tiro || '') && /OAuth/.test(tiro || ''), tiro);
  }

  global.fetch = fetchReal;
  server.close();

  console.log(`\n${fallos === 0 ? '✅' : '❌'} ${ok} checks OK, ${fallos} fallos\n`);
  process.exit(fallos === 0 ? 0 : 1);
}

main().catch((e) => { console.error('Error corriendo las pruebas:', e); server.close(); process.exit(1); });
