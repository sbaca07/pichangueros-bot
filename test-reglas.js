/**
 * La IA, de última instancia: responder por estado.
 *
 *   node test-reglas.js        (~5 s, sin red)
 *
 * Se leyeron los 12.719 mensajes que entraron en 30 días (906 personas). Casi
 * todo iba a la IA y casi nada lo necesitaba: uno de cada ocho mensajes es
 * "gracias"/"ok"/"listo" y uno de cada trece es un saludo pelado.
 *
 * Lo que decidió el diseño fue mirar QUÉ CONTESTA CLARCK a esos mensajes. Al
 * mismo "ok" le responde tres cosas distintas, según cómo esté el jugador:
 *
 *     "Me pasas foto del yape porfa"   → tiene el cupo sin pagar
 *     "Anotado. Gracias!"              → ya está en la lista
 *     "Si se baja alguien te aviso"    → quedó en espera
 *
 * O sea que la respuesta no sale del texto sino del ESTADO, que está en la
 * base. Estos checks son esa tabla, más la regla de oro de la casa: ante la
 * menor duda, null (que conteste la IA).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pich-reglas-'));
process.env.WWEBJS_AUTH_PATH = TMP;

const db = require('./src/db');
const reglas = require('./src/reglas');

let ok = 0, fallos = 0;
const check = (nombre, cond, extra) => {
  if (cond) { ok++; console.log(`  ✓ ${nombre}`); }
  else { fallos++; console.error(`  ✗ ${nombre}${extra ? ` — ${extra}` : ''}`); }
};

const hoy = db.hoyLima();
const partido = db.crearPartido({ zona: 'comas', fecha: hoy, hora: '9-10pm', sede: 'Politécnico', cupo: 2, precio: 10 });

function jugador(numero, estado, datos = {}) {
  db.getOrCreateLead(numero);
  db.updateLead(numero, { nombre: 'Marco Salas', edad: 31, distrito: 'Comas', zona: 'comas', ...datos });
  if (estado !== 'nada') {
    const { inscripcion } = db.inscribir(partido, numero, { nombre: 'Marco Salas' });
    if (estado === 'pagado') db.setEstadoInscripcion(inscripcion.id, 'pagado');
  }
  return db.getLead(numero);
}

const SIN_NADA = jugador('51911100001', 'nada');
const PAGADO = jugador('51911100002', 'pagado');
const RESERVADO = jugador('51911100003', 'reservado');
// El cupo era 2 y ya se llenó: éste cae a espera solo, como en la vida real.
const EN_ESPERA = jugador('51911100004', 'reservado');

const r = (lead, texto, adj) => reglas.responder(lead, texto, adj);

console.log('== 1 · El mismo "ok", tres respuestas distintas ==');
// Es la tabla de Clarck, tal cual.
check('en espera: se le dice que se le avisa si se libera',
  /espera/i.test(r(EN_ESPERA, 'ok')?.respuesta || ''), JSON.stringify(r(EN_ESPERA, 'ok')));
check('con el cupo sin pagar: se le pide la foto del Yape',
  /yape/i.test(r(RESERVADO, 'gracias')?.respuesta || ''), JSON.stringify(r(RESERVADO, 'gracias')));
check('ya pagado: se le confirma que está en la lista',
  /ya estas en la lista/i.test((r(PAGADO, 'listo')?.respuesta || '').normalize('NFD').replace(/[̀-ͯ]/g, '')),
  JSON.stringify(r(PAGADO, 'listo')));
check('sin nada pendiente: se entiende y NO se contesta',
  r(SIN_NADA, 'gracias')?.respuesta === null);

console.log('\n== 2 · El cupo sin pagar nunca se llama confirmado ==');
// Regla 1 de la casa: pagado es que hay un Yape identificado. Decirle a alguien
// que está confirmado cuando solo tiene el cupo guardado es inventar plata.
const alReservado = r(RESERVADO, 'ok').respuesta.toLowerCase();
check('no le dice que quedó confirmado', !/(ya estas confirmado|estas confirmado|quedaste confirmado)/.test(alReservado.normalize('NFD').replace(/[̀-ͯ]/g, '')));
check('le dice el monto y a quién yapear', /s\/10/.test(alReservado) && /915395067/.test(alReservado));

console.log('\n== 3 · "Ahí te yapeo" no es un pago ==');
const promesa = r(RESERVADO, 'ahi te yapeo');
check('se entiende como promesa, no como pago', promesa !== null);
check('se le pide la captura', /captura/i.test(promesa.respuesta));
check('no se lo da por pagado', !/ya estas pagado|quedaste confirmado/i.test(promesa.respuesta));
check('al que YA pagó se le avisa que ya está', /ya te tengo pagado/i.test(r(PAGADO, 'ahora te yapeo')?.respuesta || ''));

console.log('\n== 4 · El saludo del conocido no necesita IA ==');
check('lo saluda por su nombre', /marco/i.test(r(RESERVADO, 'buenas noches')?.respuesta || ''));
check('y le dice cómo está su cupo', /yape/i.test(r(RESERVADO, 'hola amigo')?.respuesta || ''));
check('al conocido sin cupo le ofrece anotarlo', /te anoto/i.test(r(SIN_NADA, 'hola')?.respuesta || ''));
// Al desconocido lo atiende atajos.js con la bienvenida de Config: si esta capa
// también contestara, se pisarían y el nuevo nunca daría sus datos.
check('al que NO conocemos no le contesta (es de atajos.js)',
  r({ numero: '51911100009' }, 'hola') === null);

console.log('\n== 5 · Los adjuntos que no se pueden leer ==');
check('el audio se contesta sin gastar una llamada', /audios/i.test(r(SIN_NADA, '', 'audio')?.respuesta || ''));
check('el video también', /no puedo abrir/i.test(r(SIN_NADA, '', 'video')?.respuesta || ''));
check('el sticker se entiende y no se contesta', r(SIN_NADA, '', 'sticker')?.respuesta === null);
// La FOTO no: puede ser un Yape, y eso necesita ojos.
check('la foto NO la agarra esta capa', r(SIN_NADA, '', 'imagen') === null);

console.log('\n== 6 · Las ráfagas ==');
// La gente escribe de a pedacitos y index.js los junta con \n. Medido con 100
// pichangueros reales: las 100 llegaron agrupadas y esta capa, que cortaba por
// largo TOTAL, no disparó ni una vez — todo se fue a la IA.
check('tres acuses seguidos siguen siendo un acuse',
  /yape/i.test(r(RESERVADO, 'listo\ngracias\nok amigo')?.respuesta || ''));
check('saludo + acuse manda el saludo (te llama por tu nombre)',
  /marco/i.test(r(RESERVADO, 'hola\ngracias')?.respuesta || ''));
check('un "ahí te yapeo" adentro de la ráfaga pesa más',
  /captura/i.test(r(RESERVADO, 'hola amigo\nya\nahi te yapeo')?.respuesta || ''));
// Lo importante: si UNA línea trae contenido, va toda a la IA. Contestar el
// "gracias" e ignorar la pregunta es peor que no contestar.
check('si una línea trae una pregunta, va entera a la IA',
  r(RESERVADO, 'gracias\ny a que hora tengo que llegar') === null);
check('y si trae un pedido tampoco la agarra',
  r(RESERVADO, 'hola\nanotame tambien a mi primo') === null);

console.log('\n== 7 · Ante la duda, la IA ==');
// Cada uno de estos parece cercano a una regla y NO lo es. Si alguno disparara,
// el jugador recibiría una respuesta que no tiene nada que ver con lo que pidió.
const alaIA = [
  'ya pague mi cupo hay algun problema',
  'ok pero puedo llevar a un amigo',
  'gracias, y a que hora tengo que llegar?',
  'hola, se juega si llueve?',
  'listo pero cambiame para el jueves',
  'ahi te yapeo pero son 3 cupos',
  'buenas, cuanto sale la de comas',
];
let fugas = [];
for (const t of alaIA) { if (r(RESERVADO, t)) fugas.push(t); }
check('los mensajes con contexto van a la IA', fugas.length === 0, fugas.join(' | '));

console.log(`\n${fallos === 0 ? '✅' : '❌'} ${ok} checks OK · ${fallos} fallos`);
process.exit(fallos === 0 ? 0 : 1);
