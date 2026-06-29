/**
 * Espejo a Google Sheets — backup + visibilidad para Clarck.
 *
 * El bot manda TODOS los leads a un Web App de Google Apps Script (POST con
 * un secreto compartido). Eso deja una copia de la data fuera del disco de
 * Render (backup) y un Sheet que Clarck puede abrir y filtrar (visibilidad).
 *
 * Queda INACTIVO (no-op) si faltan SHEET_WEBHOOK_URL o SHEET_SECRET, así que
 * desplegar este código no rompe nada hasta que se configure en Render.
 *
 * Setup (una vez): crear un Google Sheet → Extensiones → Apps Script → pegar
 * el doPost (ver README / mensaje de setup) → Implementar como app web
 * ("cualquiera con el enlace") → copiar la URL a SHEET_WEBHOOK_URL y usar el
 * mismo secreto en ambos lados.
 */
const WEBHOOK_URL = process.env.SHEET_WEBHOOK_URL || '';
const SECRET = process.env.SHEET_SECRET || '';

const ZONAS = { brena: 'Breña', comas: 'Comas', otra: 'Otra' };
const ESTADOS = {
  nuevo: 'Nuevo', datos_completos: 'Completo', invitado_grupo: 'En grupo',
  activo: 'Jugador', lista_espera: 'En espera', inactivo: 'Inactivo',
};

const activo = () => Boolean(WEBHOOK_URL && SECRET);

async function syncToSheet(db) {
  if (!activo()) return { ok: false, motivo: 'no configurado (faltan SHEET_WEBHOOK_URL / SHEET_SECRET)' };
  const leads = db.listLeads().map((l) => ({
    numero: l.numero,
    nombre: l.nombre || '',
    edad: l.edad || '',
    distrito: l.distrito || '',
    zona: ZONAS[l.zona] || l.zona || '',
    estado: ESTADOS[l.estado] || l.estado || '',
    handoff: l.handoff ? 'Sí' : '',
    motivo: l.handoff_motivo || '',
    etiquetas: l.etiquetas || '',
    proxima_accion: l.proxima_accion || '',
    proxima_nota: l.proxima_nota || '',
    creado_en: l.creado_en || '',
    actualizado_en: l.actualizado_en || '',
    wa: `https://wa.me/${l.numero}`,
  }));
  try {
    const res = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: SECRET, leads }),
      redirect: 'follow',
    });
    const txt = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status} ${txt.slice(0, 140)}`);
    console.log(`[sheet] Sincronizados ${leads.length} leads → Google Sheet.`);
    return { ok: true, n: leads.length };
  } catch (e) {
    console.error('[sheet] Error sincronizando:', e.message);
    return { ok: false, motivo: e.message };
  }
}

/** Sincronización periódica (al arrancar + cada N horas). No hace nada si está inactivo. */
function programarSync(db, horas = 6) {
  if (!activo()) {
    console.log('[sheet] Espejo a Google Sheet inactivo (sin SHEET_WEBHOOK_URL/SHEET_SECRET).');
    return;
  }
  setTimeout(() => syncToSheet(db), 30_000); // 30 s después de arrancar
  setInterval(() => syncToSheet(db), horas * 3600e3);
  console.log(`[sheet] Espejo a Google Sheet activo (cada ${horas} h).`);
}

module.exports = { syncToSheet, programarSync, activo };
