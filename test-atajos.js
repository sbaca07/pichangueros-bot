/**
 * Tests de la capa rápida (src/atajos.js) — sin red, BD temporal.
 *
 *   node test-atajos.js
 *
 * Lo más importante que se prueba acá no es lo que RESPONDE, sino lo que
 * DEJA PASAR: todo mensaje con contexto/ambigüedad debe devolver null
 * para que lo atienda la IA. Un atajo agresivo rompe conversaciones.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.WWEBJS_AUTH_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'pich-atajo-'));

const db = require('./src/db');
const atajos = require('./src/atajos');

let ok = 0, fallos = 0;
const check = (nombre, cond) => { if (cond) { ok++; console.log(`  ✓ ${nombre}`); } else { fallos++; console.error(`  ✗ ${nombre}`); } };
const enDias = (n) => new Date(Date.now() - 5 * 3600e3 + n * 86400e3).toISOString().slice(0, 10);

const nuevo = { nombre: null };
const conocido = { nombre: 'Diego' };
db.crearPartido({ zona: 'brena', fecha: enDias(1), hora: '8-9pm', sede: 'Melgar', cupo: 14 });

console.log('== Responde lo inconfundible ==');
check('saludo de un nuevo → bienvenida fija', atajos.responder(nuevo, 'Hola!')?.atajo === 'bienvenida');
check('"buenas noches" también', atajos.responder(nuevo, 'buenas noches')?.atajo === 'bienvenida');
check('"¿qué pichangas hay?" → parrilla con el partido', /MAÑANA.*Breña.*Melgar/s.test(atajos.responder(conocido, '¿Qué pichangas hay?')?.respuesta || ''));
check('"partidos" a secas → parrilla', atajos.responder(conocido, 'partidos')?.atajo === 'parrilla');
check('"precios" → precios con el Yape', /S\/ .*Yape/s.test(atajos.responder(conocido, 'precios')?.respuesta || ''));
check('"¿cuánto cuesta?" → precios', atajos.responder(nuevo, 'cuanto cuesta')?.atajo === 'precios');
check('"horarios" responde', atajos.responder(conocido, 'Horarios?')?.atajo === 'horarios');
check('"¿dónde queda la cancha?" → ubicación', atajos.responder(conocido, 'donde queda la cancha')?.atajo === 'ubicacion');
check('"cómo funciona" → mecánica de Config', atajos.responder(nuevo, '¿Cómo funciona?')?.atajo === 'mecanica');

console.log('== Deja pasar a la IA todo lo demás (la regla sagrada) ==');
check('saludo de un CONOCIDO → IA (personaliza)', atajos.responder(conocido, 'hola') === null);
check('"hola soy Diego, 27" → IA (trae datos)', atajos.responder(nuevo, 'hola soy Diego, 27') === null);
check('"quiero jugar mañana" → IA (inscripción)', atajos.responder(conocido, 'quiero jugar mañana') === null);
check('"cuánto cuesta si vamos 3 y pagamos juntos el viernes" → IA (contexto)', atajos.responder(conocido, 'cuánto cuesta si vamos 3 y pagamos juntos el viernes en comas?') === null);
check('"puedo pagar en efectivo" → IA (handoff)', atajos.responder(conocido, 'puedo pagar en efectivo?') === null);
check('una queja → IA', atajos.responder(conocido, 'oye ayer me trataron mal en la cancha') === null);
check('mensaje largo con palabra clave → IA', atajos.responder(conocido, 'hola una consulta sobre los horarios de la sede de breña porque trabajo hasta tarde') === null);

console.log('== Parrilla compacta y "semana" ==');
for (let d = 2; d <= 4; d++) db.crearPartido({ zona: 'comas', fecha: enDias(d), hora: '8-9pm', cupo: 12 });
const corta = atajos.responder(conocido, 'que pichangas hay')?.respuesta || '';
check('por defecto solo 2 días y avisa que hay más', /escribe \*semana\*/.test(corta) && corta.split('⚽').length <= 3);
const completa = atajos.responder(conocido, 'semana')?.respuesta || '';
check('"semana" muestra todos los días', completa.split('⚽').length >= 4 && !/escribe \*semana\*/.test(completa));

console.log('== Sin data no improvisa ==');
for (const p of db.listPartidos()) db.setEstadoPartido(p.id, 'cancelado');
check('sin partidos abiertos, "qué pichangas hay" → IA', atajos.responder(conocido, 'que pichangas hay') === null);

console.log(fallos ? `\n❌ ${ok} OK, ${fallos} FALLOS` : `\n✅ ${ok} checks OK, 0 fallos`);
process.exit(fallos ? 1 : 0);
