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

const app = express();
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
meta.registrarWebhook(app, {
  onMensaje: (sock, msg) => { recibidos.push({ sock, msg }); },
  onEcho: (msg) => { echoes.push(msg); },
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
function sobre(valor) {
  return { object: 'whatsapp_business_account', entry: [{ id: 'WABA', changes: [{ field: 'messages', value: valor }] }] };
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
