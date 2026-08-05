/**
 * Pruebas del transporte YCloud (src/ycloud.js) — `node test-ycloud.js`.
 *
 * Mismo enfoque que test-meta.js: express de verdad, payloads con la forma que
 * documenta YCloud, y un doble del fetch global para no pegarle a su API.
 */

process.env.YCLOUD_API_KEY = 'key-de-prueba';
process.env.YCLOUD_WEBHOOK_SECRET = 'secreto-webhook';
process.env.YCLOUD_NUMERO = '+51915395067';

const crypto = require('crypto');
const express = require('express');
const ycloud = require('./src/ycloud');

let ok = 0;
let fallos = 0;
function check(nombre, condicion, detalle = '') {
  if (condicion) { ok++; console.log(`  ✓ ${nombre}`); }
  else { fallos++; console.error(`  ✗ ${nombre}${detalle ? ` — ${detalle}` : ''}`); }
}

const recibidos = [];
const echoes = [];
const alertas = [];

const app = express();
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
ycloud.registrarWebhook(app, {
  onMensaje: (sock, msg) => { recibidos.push(msg); },
  onEcho: (msg) => { echoes.push(msg); },
  onAlerta: (aviso) => { alertas.push(aviso); },
});

const server = app.listen(0);
const url = () => `http://127.0.0.1:${server.address().port}/webhook/ycloud`;

function firmar(cuerpo, t) {
  return crypto.createHmac('sha256', process.env.YCLOUD_WEBHOOK_SECRET).update(`${t}.${cuerpo}`).digest('hex');
}

async function post(evento, { firma = true, firmaMala = false } = {}) {
  const cuerpo = JSON.stringify(evento);
  const t = '1785900000';
  const headers = { 'Content-Type': 'application/json' };
  if (firma) headers['YCloud-Signature'] = `t=${t},s=${firmaMala ? '0'.repeat(64) : firmar(cuerpo, t)}`;
  const r = await fetch(url(), { method: 'POST', headers, body: cuerpo });
  await new Promise((res) => setTimeout(res, 20));
  return r;
}

const entrante = (m) => ({ id: 'evt_1', type: 'whatsapp.inbound_message.received', whatsappInboundMessage: m });

// --- Doble del fetch a la API de YCloud ----------------------------------------
const fetchReal = global.fetch;
let llamadas = [];
function mockApi(respuesta = { id: 'ycid', wamid: 'wamid.OUT' }, status = 200) {
  global.fetch = async (u, opts) => {
    if (String(u).includes('127.0.0.1')) return fetchReal(u, opts);
    llamadas.push({ url: String(u), opts });
    return { ok: status === 200, status, json: async () => respuesta, arrayBuffer: async () => Buffer.from('imagen') };
  };
}

async function main() {
  console.log('\n== Firma HMAC del webhook ==');
  {
    const buena = await post(entrante({ wamid: 'wamid.1', from: '+51943791755', type: 'text', text: { body: 'hola' } }));
    check('firma válida → 200', buena.status === 200, `status=${buena.status}`);
    check('el mensaje llegó al cerebro', recibidos.length === 1, `recibidos=${recibidos.length}`);

    const mala = await post(entrante({ wamid: 'x', from: '+51943791755', type: 'text', text: { body: 'falso' } }), { firmaMala: true });
    check('firma inválida → 403', mala.status === 403, `status=${mala.status}`);

    const sin = await post(entrante({ wamid: 'y', from: '+51943791755', type: 'text', text: { body: 'falso' } }), { firma: false });
    check('sin firma → 403', sin.status === 403, `status=${sin.status}`);
    check('los falsos no llegaron al cerebro', recibidos.length === 1, `recibidos=${recibidos.length}`);
  }

  console.log('\n== Traducción a la forma Baileys ==');
  {
    recibidos.length = 0;
    await post(entrante({ wamid: 'wamid.2', from: '+51 943 791 755', type: 'text', text: { body: 'quiero jugar' } }));
    const msg = recibidos[0];
    check('jid con el número limpio', msg?.key?.remoteJid === '51943791755@s.whatsapp.net', msg?.key?.remoteJid);
    check('fromMe = false', msg?.key?.fromMe === false);
    check('texto en message.conversation', msg?.message?.conversation === 'quiero jugar');
    check('conserva el wamid', msg?.key?.id === 'wamid.2');
  }

  console.log('\n== Voucher de Yape (imagen con link directo) ==');
  {
    recibidos.length = 0;
    llamadas = [];
    mockApi();
    await post(entrante({
      wamid: 'wamid.3', from: '+51943791755', type: 'image',
      image: { id: 'MEDIA_1', link: 'https://cdn.ycloud.com/media/abc', caption: 'ya yapeé', mime_type: 'image/jpeg' },
    }));
    const msg = recibidos[0];
    check('llega como imageMessage', Boolean(msg?.message?.imageMessage));
    check('conserva el caption', msg?.message?.imageMessage?.caption === 'ya yapeé');
    check('expone _descargar()', typeof msg?._descargar === 'function');

    const bin = await msg._descargar();
    check('_descargar() devuelve Buffer', Buffer.isBuffer(bin), typeof bin);
    check('baja del link directo (un solo GET)', llamadas.length === 1 && llamadas[0].url.includes('/media/abc'), JSON.stringify(llamadas.map((c) => c.url)));
  }

  console.log('\n== Echo de coexistencia ==');
  {
    echoes.length = 0;
    recibidos.length = 0;
    await post({
      id: 'evt_e', type: 'whatsapp.smb.message.echoes',
      whatsappMessage: { wamid: 'wamid.4', from: '+51915395067', to: '+51943791755', type: 'text', text: { body: 'ya te paso el link' } },
    });
    check('se registra como respuesta manual', echoes.length === 1, `echoes=${echoes.length}`);
    check('NO despierta al cerebro', recibidos.length === 0, `recibidos=${recibidos.length}`);
    check('fromMe = true', echoes[0]?.key?.fromMe === true);
    check('el jid es el DESTINATARIO, no el negocio', echoes[0]?.key?.remoteJid === '51943791755@s.whatsapp.net', echoes[0]?.key?.remoteJid);
  }

  console.log('\n== Alertas de salud de la cuenta ==');
  {
    alertas.length = 0;
    await post({ id: 'e1', type: 'whatsapp.phone_number.quality_updated', whatsappPhoneNumber: { qualityRating: 'RED' } });
    check('calidad del número dispara aviso', alertas.length === 1, `alertas=${alertas.length}`);
    check('el aviso dice la calidad', /RED/.test(alertas[0] || ''), alertas[0]);

    await post({ id: 'e2', type: 'whatsapp.business_account.reviewed', whatsappBusinessAccount: { banState: 'REINSTATE' } });
    check('revisión de la cuenta dispara aviso', alertas.length === 2, `alertas=${alertas.length}`);

    await post({ id: 'e3', type: 'whatsapp.phone_number.deleted', whatsappPhoneNumber: {} });
    check('número eliminado dispara aviso', alertas.length === 3 && /ELIMINADO/.test(alertas[2]), alertas[2]);
  }

  console.log('\n== Eventos ignorados y robustez ==');
  {
    recibidos.length = 0;
    alertas.length = 0;
    const r1 = await post(entrante({ wamid: 'r', from: '+51943791755', type: 'reaction', reaction: { emoji: '👍' } }));
    check('reacción se ignora sin romper', r1.status === 200 && recibidos.length === 0);

    const r2 = await post({ id: 'e4', type: 'whatsapp.message.updated', whatsappMessage: { status: 'failed', to: '+51943791755', error: { code: 131047 } } });
    check('envío fallido responde 200 sin alertar', r2.status === 200 && alertas.length === 0);

    const r3 = await post({ id: 'e5', type: 'whatsapp.template.reviewed', whatsappTemplate: {} });
    check('evento no usado se ignora', r3.status === 200);

    const r4 = await post({ id: 'e6' });
    check('evento sin type responde 200', r4.status === 200);
  }

  console.log('\n== Envío por la API de YCloud ==');
  {
    llamadas = [];
    mockApi();
    const res = await ycloud.enviarTexto('51943791755', 'nos vemos 7:45');
    check('devuelve la forma {key:{id}} de Baileys', res?.key?.id === 'wamid.OUT', JSON.stringify(res));

    const [call] = llamadas;
    const body = JSON.parse(call.opts.body);
    check('pega al endpoint de mensajes', call.url === 'https://api.ycloud.com/v2/whatsapp/messages', call.url);
    check('manda el X-API-Key', call.opts.headers['X-API-Key'] === 'key-de-prueba');
    check('from en E.164 con +', body.from === '+51915395067', body.from);
    check('to en E.164 con +', body.to === '+51943791755', body.to);
    check('el texto viaja en text.body', body.text?.body === 'nos vemos 7:45');

    llamadas = [];
    await ycloud.sockAdapter.sendMessage('51943791755@s.whatsapp.net', { text: 'por el adaptador' });
    check('sockAdapter limpia el @s.whatsapp.net', JSON.parse(llamadas[0].opts.body).to === '+51943791755');

    mockApi({ message: 'Invalid API key' }, 401);
    let tiro = null;
    try { await ycloud.enviarTexto('51943791755', 'x'); } catch (e) { tiro = e.message; }
    check('un 401 se propaga legible', /401/.test(tiro || '') && /Invalid API key/.test(tiro || ''), tiro);
  }

  global.fetch = fetchReal;
  server.close();
  console.log(`\n${fallos === 0 ? '✅' : '❌'} ${ok} checks OK, ${fallos} fallos\n`);
  process.exit(fallos === 0 ? 0 : 1);
}

main().catch((e) => { console.error('Error corriendo las pruebas:', e); server.close(); process.exit(1); });
