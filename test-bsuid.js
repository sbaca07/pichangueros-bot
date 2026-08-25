/**
 * IDENTIDADES SIN TELÉFONO (BSUID de Meta) — sin red, BD temporal.
 *
 *   node test-bsuid.js
 *
 * Desde abril de 2026 Meta identifica a algunos usuarios con un
 * "business-scoped user ID" (`PE.187019082`) en vez del número: pasa con quien
 * activó su nombre de usuario en WhatsApp y no está en la agenda del negocio
 * ni habló en los últimos 30 días. Soportarlo no es opcional — Meta lo exige,
 * y mientras no lo hicimos se descartaron 100 mensajes de 5 conversaciones en
 * 30 horas, con el bot callado y la gente pensando que nadie la lee.
 *
 * Lo que se prueba acá es lo único que no se puede probar contra Meta: que la
 * identidad se conserve entera, que no se confunda con un teléfono, y que el
 * mensaje de salida lleve `recipient` en vez de `to`.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pich-bsuid-'));
process.env.WWEBJS_AUTH_PATH = TMP;
process.env.TRANSPORTE = 'meta';
process.env.META_TOKEN = 'token-de-prueba';
process.env.META_PHONE_NUMBER_ID = '123456';

const { esBsuid, jidToNumero } = require('./src/mensajes');
const meta = require('./src/meta');

let ok = 0, fallos = 0;
function check(nombre, cond) {
  if (cond) { ok++; console.log(`  ✓ ${nombre}`); }
  else { fallos++; console.error(`  ✗ ${nombre}`); }
}

console.log('== Reconocer una identidad sin teléfono ==');
check('PE.187019082 es un BSUID', esBsuid('PE.187019082'));
check('US.13491208655302741918 también', esBsuid('US.13491208655302741918'));
check('un teléfono NO es un BSUID', !esBsuid('51927825455'));
check('un LID pelado tampoco', !esBsuid('201382560821305'));
check('vacío tampoco', !esBsuid('') && !esBsuid(null));

console.log('== La identidad se conserva ENTERA ==');
check('el jid con BSUID devuelve el BSUID', jidToNumero('PE.187019082@s.whatsapp.net') === 'PE.187019082');
// Sin esto, "PE.187019082" quedaba en "187019082": un teléfono válido de otra
// persona. Dos desconocidos en la misma ficha.
check('…y NO se le comen las letras', jidToNumero('PE.187019082@s.whatsapp.net') !== '187019082');
check('el jid con teléfono sigue igual que siempre', jidToNumero('51927825455@s.whatsapp.net') === '51927825455');
check('el LID sigue quedando en sus dígitos', jidToNumero('201382560821305@lid') === '201382560821305');

console.log('== El webhook entrante ==');
const entrante = {
  from_user_id: 'PE.187019082',
  id: 'wamid.TEST-1',
  timestamp: '1756000000',
  type: 'text',
  text: { body: 'Hola, ¿hay cupo para hoy?' },
};
const msg = meta.aMensajeBaileys(entrante, false, '');
check('un mensaje sin teléfono YA NO se descarta', Boolean(msg));
check('…y queda a nombre de su identidad', msg && msg.key.remoteJid === 'PE.187019082@s.whatsapp.net');
check('…con su texto intacto', msg && msg.message.conversation === 'Hola, ¿hay cupo para hoy?');

const conTelefono = { from: '51927825455', id: 'wamid.TEST-2', type: 'text', text: { body: 'hola' } };
const msg2 = meta.aMensajeBaileys(conTelefono, false, '');
check('el que SÍ trae teléfono no cambió', msg2 && msg2.key.remoteJid === '51927825455@s.whatsapp.net');

// El eco de lo que Clarck manda desde su app viene con `to_user_id`.
const eco = { to_user_id: 'PE.187019082', from: '51967870413', id: 'wamid.TEST-3', type: 'text', text: { body: 'Claro amigo' } };
const msg3 = meta.aMensajeBaileys(eco, true, '');
check('el eco saliente se atribuye al mismo contacto', msg3 && msg3.key.remoteJid === 'PE.187019082@s.whatsapp.net');

// Cuando Meta manda el teléfono en `contacts`, ese gana: es más útil.
const conRespaldo = { from_user_id: 'PE.187019082', id: 'wamid.TEST-4', type: 'text', text: { body: 'hey' } };
const msg4 = meta.aMensajeBaileys(conRespaldo, false, '51927825455');
check('si el teléfono viene en contacts, se prefiere el teléfono',
  msg4 && msg4.key.remoteJid === '51927825455@s.whatsapp.net');

const basura = { id: 'wamid.TEST-5', type: 'text', text: { body: 'x' } };
check('sin teléfono NI identidad, se sigue descartando', meta.aMensajeBaileys(basura, false, '') === null);

(async () => {
  console.log('== El mensaje de salida ==');
  // A un BSUID se le escribe con `recipient` y SIN `to`: si van los dos, Meta
  // le hace caso al teléfono y el envío se pierde.
  let enviado = null;
  global.fetch = async (url, opts) => {
    enviado = { url, body: JSON.parse(opts.body) };
    return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.OUT' }] }) };
  };
  await meta.enviarTexto('PE.187019082', 'Te guardo el cupo');
  check('a un BSUID se le manda `recipient`', enviado.body.recipient === 'PE.187019082');
  check('…y NO se manda `to`', !('to' in enviado.body));
  check('…marcado como individual', enviado.body.recipient_type === 'individual');
  check('…con el texto', enviado.body.text.body === 'Te guardo el cupo');

  await meta.enviarTexto('51927825455', 'Hola');
  check('a un teléfono se le sigue mandando `to`', enviado.body.to === '51927825455');
  check('…y NO `recipient`', !('recipient' in enviado.body));

  console.log(`\n${fallos === 0 ? '✅' : '❌'} ${ok} checks OK, ${fallos} fallos`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  process.exit(fallos === 0 ? 0 : 1);
})();
