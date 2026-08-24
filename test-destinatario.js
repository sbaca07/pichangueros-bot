/**
 * ¿A quién se le pagó? (sin red, BD temporal)
 *
 *   node test-destinatario.js
 *
 * El validador comparaba el destino del voucher contra UN número y mandaba a
 * revisar todo lo demás. Clarck cobra por más de uno: entre el 17 y el 24 de
 * agosto quedaron trabados 19 pagos suyos (S/ 287) con el motivo "Pago a OTRO
 * destinatario: Clarck Val* (…050)". Plata suya, a un número suyo, contada
 * como no pagada — y al jugador el bot le pedía que reenviara la captura.
 *
 * Acá se prueban las dos señales que ahora valen: los números cargados y el
 * NOMBRE del titular (que Yape muestra recortado).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pich-dest-'));
process.env.WWEBJS_AUTH_PATH = TMP;

const db = require('./src/db');
const pagos = require('./src/pagos');

let ok = 0, fallos = 0;
function check(nombre, cond) {
  if (cond) { ok++; console.log(`  ✓ ${nombre}`); }
  else { fallos++; console.error(`  ✗ ${nombre}`); }
}

db.setConfig({ yape_numero: '915395067', yape_titular: 'Clarck Valentin' });
const voucher = (destinatario, digitos) => ({
  es_comprobante_pago: true, medio: 'yape', monto: 15, confianza: 'alta',
  nombre_remitente: 'Un Jugador', numero_operacion: `OP-${String(destinatario || 'nadie').length}-${digitos || 'x'}`,
  destinatario, destino_ultimos_digitos: digitos,
});
const esOtro = (r) => /OTRO destinatario/.test(r.motivo || '');

console.log('== El nombre recortado del titular ==');
check('"Clarck Val*" es Clarck Valentin', pagos.mismoTitular('Clarck Val*', 'Clarck Valentin'));
check('"Clarck S Valentin T - Yape" también', pagos.mismoTitular('Clarck S Valentin T - Yape', 'Clarck Valentin'));
check('"CLARCK VALENTIN" (mayúsculas) también', pagos.mismoTitular('CLARCK VALENTIN', 'Clarck Valentin'));
check('"Amaretti Import Sac" NO', !pagos.mismoTitular('Amaretti Import Sac', 'Clarck Valentin'));
check('"BBVA Perú" NO', !pagos.mismoTitular('BBVA Perú', 'Clarck Valentin'));
check('un solo apellido suelto NO alcanza', !pagos.mismoTitular('Valentin', 'Clarck Valentin'));
check('sin destinatario NO inventa', !pagos.mismoTitular(null, 'Clarck Valentin'));
check('sin titular cargado NO inventa', !pagos.mismoTitular('Clarck Val*', ''));

console.log('== El caso real: otro número, mismo dueño ==');
db.getOrCreateLead('51955000001');
db.updateLead('51955000001', { zona: 'brena' });
const r1 = pagos.evaluarVoucher('51955000001', 'brena', voucher('Clarck Val*', '050'));
check('el pago al …050 a nombre de Clarck YA NO se traba', !esOtro(r1));

const r2 = pagos.evaluarVoucher('51955000001', 'brena', voucher('Amaretti Import Sac', '321'));
check('el pago a un tercero SÍ sigue yendo a revisión', esOtro(r2) && r2.estado === 'revisar');

console.log('== Los otros Yapes se cargan en Ajustes ==');
check('por defecto solo está el principal', db.yapesDelNegocio().join() === '915395067');
db.setConfig({ yape_otros: '987654050, 111' });
check('se suman los que cargó Clarck', db.yapesDelNegocio().length === 3);
const r3 = pagos.evaluarVoucher('51955000001', 'brena', voucher('Otra Persona SAC', '050'));
check('un destinatario desconocido pero al número cargado, pasa', !esOtro(r3));
const r4 = pagos.evaluarVoucher('51955000001', 'brena', voucher('Otra Persona SAC', '999'));
check('ni el número ni el nombre: a revisión', esOtro(r4));

console.log('== Lo que ya funcionaba no se rompió ==');
const r5 = pagos.evaluarVoucher('51955000001', 'brena', voucher('Clarck Valentin', '067'));
check('el pago al Yape de siempre pasa derecho', !esOtro(r5));
const r6 = pagos.evaluarVoucher('51955000001', 'brena', voucher(null, null));
check('un voucher que no muestra destino NO se rechaza por eso', !esOtro(r6));

console.log(`\n${fallos === 0 ? '✅' : '❌'} ${ok} checks OK, ${fallos} fallos`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
process.exit(fallos === 0 ? 0 : 1);
