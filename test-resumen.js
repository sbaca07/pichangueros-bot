/**
 * Resumen de derivados por correo: agrupado, no uno por uno.
 *
 *   node test-resumen.js        (~5 s, sin red)
 *
 * Se marcan ~41 handoffs por día. Mandar un correo por cada uno no es caro
 * —Gmail no cobra por mensaje— pero es ilegible: 41 correos diarios se
 * ignoran, y encima comparten el cupo de envío con el respaldo de la BD.
 * Así que el WhatsApp sigue saliendo al toque y el correo va junto, 3 veces
 * al día. Lo que tiene plata adentro (pagos) NO pasa por acá: sale al instante.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pich-res-'));
process.env.WWEBJS_AUTH_PATH = TMP;
process.env.KIPI_EMAIL_USER = 'test@pichangueros.pe';
process.env.KIPI_EMAIL_APP_PASSWORD = 'no-se-usa';

const db = require('./src/db');
const backup = require('./src/backup');

const enviados = [];
backup.avisar = async (asunto, cuerpo) => { enviados.push({ asunto, cuerpo }); return { ok: true }; };

let ok = 0, fallos = 0;
const check = (nombre, cond) => { if (cond) { ok++; console.log(`  ✓ ${nombre}`); } else { fallos++; console.error(`  ✗ ${nombre}`); } };
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const derivar = (numero, nombre, motivo) => {
  db.getOrCreateLead(numero);
  db.updateLead(numero, { nombre });
  db.setHandoff(numero, motivo);
};

(async () => {
  console.log('== 1 · Varios derivados entran en UN solo correo ==');
  derivar('51900000401', 'Ana Pérez', 'quiere pagar en efectivo');
  derivar('51900000402', 'Beto Ruiz', 'reclamo por la cancha');
  derivar('51900000403', 'Caro Díaz', 'pide descuento');
  let r = await backup.enviarResumenHandoffs(db, { motivo: 'test' });
  check('los tres van juntos', r.enviados === 3);
  check('un solo correo', enviados.length === 1);
  check('el asunto dice cuántos son', /3 contactos esperando/.test(enviados[0].asunto));
  check('lista a cada uno con su motivo', /Ana Pérez — quiere pagar en efectivo/.test(enviados[0].cuerpo));
  check('con el link para escribirle', /wa\.me\/51900000401/.test(enviados[0].cuerpo));
  check('y cómo devolverle el contacto al bot', /kipi reactivar/.test(enviados[0].cuerpo));

  console.log('== 2 · Sin novedad no manda nada ==');
  r = await backup.enviarResumenHandoffs(db, { motivo: 'test' });
  check('no hay derivados nuevos', r.enviados === 0);
  check('y no se manda un correo vacío', enviados.length === 1);

  console.log('== 3 · El siguiente resumen trae solo lo nuevo ==');
  await esperar(1100); // los timestamps de la BD van al segundo
  derivar('51900000404', 'Dani Soto', 'lesión en la cancha');
  r = await backup.enviarResumenHandoffs(db, { motivo: 'test' });
  check('solo el nuevo', r.enviados === 1);
  check('no repite a los de antes', /Dani Soto/.test(enviados[1].cuerpo) && !/Ana Pérez/.test(enviados[1].cuerpo));

  console.log('== 4 · Respeta el punto de arranque ==');
  await esperar(1100);
  db.setCorte(new Date(Date.now() - 5 * 3600e3 + 86400e3).toISOString().slice(0, 10));
  derivar('51900000405', 'Eva Luna', 'caso especial');
  r = await backup.enviarResumenHandoffs(db, { motivo: 'test' });
  check('lo anterior al corte no se reporta', r.enviados === 0);
  check('sin correo de más', enviados.length === 2);

  console.log('== 5 · El parte semanal: legible en el mail y señalando lo que FALTA ==');
  {
    // Clarck no abre el panel: la semana tiene que leerse en el cuerpo del
    // correo. Y tiene que decir lo que falta, no solo lo que hay — el 15/08
    // vendió por WhatsApp un domingo que nunca se cargó y cobró S/20 por dos
    // cupos que no existían.
    enviados.length = 0;
    const r0 = await backup.enviarParteSemanal(db, { motivo: 'test' });
    check('sin NADA cargado, el parte sale igual (eso es una anomalía)', r0.enviado === true);
    check('y lo dice sin rodeos', /No hay NINGÚN partido cargado/.test(enviados[0].cuerpo));

    // Tres domingos jugados a la misma hora = costumbre. Se construyen abriendo
    // a futuro y moviendo la fecha (un partido vencido ya no acepta gente).
    const domingos = [];
    for (let i = 1; i <= 40 && domingos.length < 3; i++) {
      const f = db.fechaLima(-i);
      if (db.diaSemanaDe(f) === 0) domingos.push(f);
    }
    let slot = 60;
    for (const f of domingos) {
      const id = db.crearPartido({ zona: 'comas', fecha: db.fechaLima(slot++), hora: '18:00', sede: 'Politécnico', cupo: 12, precio: 10 });
      db.actualizarPartido(id, { fecha: f });
    }
    enviados.length = 0;
    const r1 = await backup.enviarParteSemanal(db, { motivo: 'test' });
    check('el domingo que viene aparece como hueco', /NADA CARGADO/.test(enviados[0].cuerpo));
    check('…citando la costumbre que lo delata', /los últimos 3 domingos/.test(enviados[0].cuerpo));
    check('…y el asunto ya dice que falta algo', /faltan 1 pichanga/.test(enviados[0].asunto), enviados[0].asunto);
    check('la semana entera va en el CUERPO, no detrás de un link', /Semana del/.test(enviados[0].cuerpo) && r1.anomalias > 0);

    // Cargado lo que faltaba y liquidado lo viejo, el parte NO insiste.
    for (const h of db.diasSinCargar()) {
      db.crearPartido({ zona: h.zona, fecha: h.fecha, hora: db.textoHora(h.inicio_min, 60), sede: h.sede, sede_id: h.sede_id, cupo: 12, precio: 10 });
    }
    for (const p of db.partidosPorLiquidar()) db.liquidarPartido(p.id);
    db.archivarPartidosVacios();
    enviados.length = 0;
    const r2 = await backup.enviarParteSemanal(db, { motivo: 'test' });
    check('si la semana salió como siempre, NO se manda nada', r2.enviado === false && enviados.length === 0);
    check('…escala por anomalía, no por calendario', r2.anomalias === 0);
  }

  console.log(`\n${fallos ? '❌' : '✅'} ${ok} checks OK, ${fallos} fallos`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  process.exit(fallos ? 1 : 0);
})();
