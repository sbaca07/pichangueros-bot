/**
 * Panel CRM (Semana 3 · rediseño iOS 2026-06-29) — "del marcador a la cancha".
 *
 * Tres vistas, estética iOS (claro, Inter + Barlow Condensed, acento verde
 * #A3C614 = verde de sistema y de cancha):
 *   Resumen → dashboard de data (marcador-estadio, métricas, crecimiento, zonas)
 *   CRM     → lista de leads con la cola "sin responder" al frente
 *   Ficha   → perfil + pipeline + etiquetas + seguimiento + notas + chat
 *
 * Rutas (todas con ?key=ADMIN_KEY; sin key → 404):
 *   GET  /admin/leads                  → Resumen (dashboard)
 *   GET  /admin/leads?vista=crm        → lista CRM (con filtros/búsqueda)
 *   GET  /admin/leads?numero=N         → ficha de contacto
 *   GET  /admin/leads.csv              → export CSV
 *   GET  /admin/leads.xlsx             → export Excel (con marca, colores, autofiltro)
 *   GET  /admin/backup-db              → descarga el .db completo (backup manual)
 *   POST /admin/lead/estado            → cambia etapa del pipeline (1 toque)
 *   POST /admin/lead/reactivar         → saca del handoff (el bot vuelve a atender)
 *   POST /admin/lead/etiquetas         → guarda etiquetas (separadas por coma)
 *   POST /admin/lead/seguimiento       → fecha + nota de próxima acción
 *   POST /admin/lead/nota              → agrega una nota al historial
 */
const sheetsync = require('./sheetsync');
const backup = require('./backup');
const { buildLeadsWorkbook } = require('./excel');

const esc = (v) =>
  String(v ?? '—').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const ZONAS = {
  brena: { nombre: 'Breña', color: '#A3C614' },
  comas: { nombre: 'Comas', color: '#16385F' },
  rimac: { nombre: 'Rímac', color: '#0A7E8C' },
  chorrillos: { nombre: 'Chorrillos', color: '#8944AB' },
  otra: { nombre: 'Otra zona', color: '#64748b' },
};
// Color para zonas creadas después de este mapa (nuevos distritos).
const colorZona = (z) => ZONAS[z]?.color || '#5D8A3C';
// Slug de zona a partir del nombre que escribe Clarck ("San Miguel" → sanmiguel).
const slugZona = (nombre) => (nombre || '')
  .toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z]/g, '').slice(0, 24);

// Pipeline (etapas) — orden y etiquetas pensadas para el flujo de Clarck.
const ESTADOS = {
  nuevo: 'Nuevo',
  datos_completos: 'Completo',
  invitado_grupo: 'En grupo',
  activo: 'Jugador ⭐',
  lista_espera: 'En espera',
  inactivo: 'Inactivo 💤',
};

// Colores de avatar (monograma) — se elige de forma estable por número.
const AVATARES = [
  'linear-gradient(135deg,#A3C614,#7FA30F)', 'linear-gradient(135deg,#5ac8fa,#16385F)',
  'linear-gradient(135deg,#ff9f0a,#ff7a00)', 'linear-gradient(135deg,#bf5af2,#8944ab)',
  'linear-gradient(135deg,#ff453a,#cc2f26)', 'linear-gradient(135deg,#64748b,#475569)',
  'linear-gradient(135deg,#30b0c7,#0a7e8c)', 'linear-gradient(135deg,#ffcc00,#e0a000)',
];
const avatarColor = (numero) => AVATARES[[...String(numero)].reduce((a, c) => a + c.charCodeAt(0), 0) % AVATARES.length];
const iniciales = (nombre, numero) => {
  if (!nombre) return String(numero).slice(-2);
  const p = nombre.trim().split(/\s+/);
  return ((p[0]?.[0] || '') + (p[1]?.[0] || '')).toUpperCase() || String(numero).slice(-2);
};

const MS_DIA = 86400e3;
// Normaliza texto libre para agrupar/filtrar: minúsculas y sin tildes.
const normTexto = (t) => (t || '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const fechaLima = (offsetDias = 0) => new Date(Date.now() - 5 * 3600e3 + offsetDias * MS_DIA).toISOString().slice(0, 10);
const hoyLima = () => fechaLima(0);
// Timestamp Lima de hace N horas (mismo formato 'YYYY-MM-DD HH:MM:SS' de la BD).
const limaHace = (horas) => new Date(Date.now() - 5 * 3600e3 - horas * 3600e3).toISOString().slice(0, 19).replace('T', ' ');
// "Sin responder" REAL: el último mensaje es del contacto Y es reciente (48 h).
// Y en MODO SEGURO el bot calla a propósito con todos menos los testers: esos
// silenciados NO "necesitan respuesta" — están siendo capturados por diseño.
// Mostrarlos como deuda pintaba 124 pendientes falsos en el CRM.
const modoSeguroOn = () => (process.env.SAFE_MODE || 'true') !== 'false';
const testersPanel = () => (process.env.ALLOWED_TESTERS || '').split(',').map((n) => n.replace(/\D/g, '')).filter(Boolean);
const sinResponder = (roles, l) => {
  const u = roles[l.numero];
  if (!(u && u.rol === 'user' && !l.handoff && u.en >= limaHace(48))) return false;
  return !modoSeguroOn() || testersPanel().includes(l.numero);
};
/** Capturados en silencio por el modo seguro (últimas 48 h) — para el banner. */
const silenciados48h = (roles, todos) =>
  todos.filter((l) => { const u = roles[l.numero]; return u && u.rol === 'user' && !l.handoff && u.en >= limaHace(48); }).length;
const horaCorta = (ts) => esc((ts || '').slice(5, 16)); // MM-DD HH:MM

function registrarPanel(app, db, conexion = null) {
  const express = require('express');
  app.use(express.urlencoded({ extended: false }));

  const ADMIN_KEY = process.env.ADMIN_KEY || '';
  const autorizado = (req, res) => {
    const key = req.method === 'POST' ? req.body.key : req.query.key;
    if (!ADMIN_KEY || key !== ADMIN_KEY) {
      res.status(404).send('Not found');
      return false;
    }
    return true;
  };
  const volverAFicha = (req, res) =>
    res.redirect(`/admin/leads?key=${encodeURIComponent(req.body.key)}&numero=${encodeURIComponent((req.body.numero || '').replace(/\D/g, ''))}`);

  // --- Acciones CRM (1 toque desde la ficha) -----------------------------------
  app.post('/admin/lead/estado', (req, res) => {
    if (!autorizado(req, res)) return;
    const estado = ESTADOS[req.body.estado] ? req.body.estado : null;
    if (estado) db.setEstado((req.body.numero || '').replace(/\D/g, ''), estado);
    volverAFicha(req, res);
  });

  app.post('/admin/lead/reactivar', (req, res) => {
    if (!autorizado(req, res)) return;
    db.clearHandoff((req.body.numero || '').replace(/\D/g, ''));
    volverAFicha(req, res);
  });

  app.post('/admin/lead/etiquetas', (req, res) => {
    if (!autorizado(req, res)) return;
    const limpio = (req.body.etiquetas || '').split(',').map((t) => t.trim()).filter(Boolean).slice(0, 10).join(',');
    db.setEtiquetas((req.body.numero || '').replace(/\D/g, ''), limpio);
    volverAFicha(req, res);
  });

  app.post('/admin/lead/seguimiento', (req, res) => {
    if (!autorizado(req, res)) return;
    const fecha = /^\d{4}-\d{2}-\d{2}$/.test(req.body.fecha || '') ? req.body.fecha : null;
    db.setSeguimiento((req.body.numero || '').replace(/\D/g, ''), fecha, (req.body.nota || '').slice(0, 200));
    volverAFicha(req, res);
  });

  app.post('/admin/lead/nota', (req, res) => {
    if (!autorizado(req, res)) return;
    const texto = (req.body.texto || '').trim().slice(0, 500);
    if (texto) db.addNota((req.body.numero || '').replace(/\D/g, ''), texto);
    volverAFicha(req, res);
  });

  // Borra un contacto completo (pruebas internas, spam) — no vuelve a la ficha
  // (quedaría vacía) sino a la lista del CRM.
  app.post('/admin/lead/eliminar', (req, res) => {
    if (!autorizado(req, res)) return;
    db.deleteLead((req.body.numero || '').replace(/\D/g, ''));
    res.redirect(`/admin/leads?key=${encodeURIComponent(req.body.key)}&vista=crm`);
  });

  // --- Export CSV ----------------------------------------------------------------
  app.get('/admin/leads.csv', (req, res) => {
    if (!autorizado(req, res)) return;
    const filas = db.listLeads().map((l) =>
      [l.numero, l.nombre, l.edad, l.distrito, l.zona, l.estado, l.handoff, l.handoff_motivo, l.etiquetas, l.proxima_accion, l.creado_en]
        .map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`)
        .join(',')
    );
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="pichangueros-leads.csv"');
    res.send(['numero,nombre,edad,distrito,zona,estado,handoff,handoff_motivo,etiquetas,proxima_accion,creado_en', ...filas].join('\n'));
  });

  // Export Excel — bonito y de marca (vs. el CSV plano), mismos datos.
  app.get('/admin/leads.xlsx', async (req, res) => {
    if (!autorizado(req, res)) return;
    const buffer = await buildLeadsWorkbook(db);
    res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.set('Content-Disposition', `attachment; filename="pichangueros-leads-${hoyLima()}.xlsx"`);
    res.send(Buffer.from(buffer));
  });

  // Backup manual: descarga el .db completo (checkpoint del WAL primero para
  // que el archivo tenga todo lo escrito hasta este momento).
  app.get('/admin/backup-db', (req, res) => {
    if (!autorizado(req, res)) return;
    db.checkpoint();
    res.download(db.dbPath, `pichangueros-${hoyLima()}.db`);
  });

  // Respaldar a Google Sheet ahora (backup manual desde el panel).
  app.get('/admin/sync-sheet', async (req, res) => {
    if (!autorizado(req, res)) return;
    const r = await sheetsync.syncToSheet(db);
    res.redirect(`/admin/leads?key=${encodeURIComponent(req.query.key)}&sync=${r.ok ? r.n : 'err'}`);
  });

  // Mandar el respaldo completo por correo ahora mismo (no espera las 24 h).
  app.get('/admin/backup-email', async (req, res) => {
    if (!autorizado(req, res)) return;
    const r = await backup.enviarBackup(db, { motivo: 'manual desde el panel' });
    res.redirect(`/admin/leads?key=${encodeURIComponent(req.query.key)}&mail=${r.ok ? 'ok' : 'err'}`);
  });

  // --- Configuración del negocio (sedes, precios, textos) — sin tocar código ------
  const volverAConfig = (req, res) => res.redirect(`/admin/leads?key=${encodeURIComponent(req.body.key)}&vista=config`);

  app.post('/admin/config/general', (req, res) => {
    if (!autorizado(req, res)) return;
    db.setConfig(req.body);
    volverAConfig(req, res);
  });

  app.post('/admin/config/sede', (req, res) => {
    if (!autorizado(req, res)) return;
    const campos = {
      zona: db.zonasOperativas().includes(req.body.zona) ? req.body.zona : 'brena',
      nombre: (req.body.nombre || '').trim(),
      cancha: (req.body.cancha || '').trim(),
      cupo: req.body.cupo ? Number(req.body.cupo) : null,
      ubicacion: (req.body.ubicacion || '').trim(),
      horario: (req.body.horario || '').trim(),
      estacionamiento: (req.body.estacionamiento || '').trim(),
    };
    if (campos.nombre) {
      if (req.body.id) db.updateSede(Number(req.body.id), campos);
      else db.addSede(campos);
    }
    volverAConfig(req, res);
  });

  app.post('/admin/config/sede/eliminar', (req, res) => {
    if (!autorizado(req, res)) return;
    db.deleteSede(Number(req.body.id));
    volverAConfig(req, res);
  });

  // Punto de arranque: deja atrás la historia previa al sistema SIN borrarla.
  app.post('/admin/config/corte', (req, res) => {
    if (!autorizado(req, res)) return;
    db.setCorte(req.body.fecha);
    volverAConfig(req, res);
  });

  // Precio, link de grupo y nombre para mostrar de UNA zona (tarjeta por distrito).
  app.post('/admin/config/zona', (req, res) => {
    if (!autorizado(req, res)) return;
    const zona = db.zonasOperativas().includes(req.body.zona) ? req.body.zona : null;
    if (zona) db.setConfig({
      [`precio_${zona}`]: (req.body.precio || '').trim(),
      [`grouplink_${zona}`]: (req.body.grouplink || '').trim(),
      [`zonanombre_${zona}`]: (req.body.nombre_mostrar || '').trim(),
    });
    volverAConfig(req, res);
  });

  // Crear un DISTRITO nuevo: nace con su primera sede (la fuente de verdad de
  // las zonas) y desde ese momento existe en todo el sistema — guion del bot,
  // partidos, clasificación de leads, esta página.
  app.post('/admin/config/zona/nueva', (req, res) => {
    if (!autorizado(req, res)) return;
    const nombre = (req.body.nombre || '').trim().slice(0, 40);
    const zona = slugZona(nombre);
    if (zona.length >= 3 && !db.zonasOperativas().includes(zona)) {
      db.addSede({
        zona,
        nombre: (req.body.sede || '').trim().slice(0, 120) || 'Sede por definir',
        cupo: Math.max(2, Math.min(60, Number(req.body.cupo) || 14)),
      });
      db.setConfig({
        [`zonanombre_${zona}`]: nombre,
        [`precio_${zona}`]: (req.body.precio || '').trim() || '15',
      });
    }
    volverAConfig(req, res);
  });

  // --- Partidos: convocatorias, inscripciones, asistencia ----------------------
  const volverAPartidos = (req, res, partidoId = null) =>
    res.redirect(`/admin/leads?key=${encodeURIComponent(req.body.key)}&vista=partidos${partidoId ? `&partido=${partidoId}` : ''}`);

  app.post('/admin/partido', (req, res) => {
    if (!autorizado(req, res)) return;
    const zona = db.zonasOperativas().includes(req.body.zona) ? req.body.zona : 'brena';
    const fecha = /^\d{4}-\d{2}-\d{2}$/.test(req.body.fecha || '') ? req.body.fecha : null;
    if (!fecha) return volverAPartidos(req, res);
    const id = db.crearPartido({
      zona, fecha,
      hora: (req.body.hora || '').trim().slice(0, 40),
      sede: (req.body.sede || '').trim().slice(0, 120),
      cupo: Math.max(2, Math.min(60, Number(req.body.cupo) || 14)),
      precio: req.body.precio ? Number(req.body.precio) : null,
    });
    volverAPartidos(req, res, id);
  });

  app.post('/admin/partido/estado', (req, res) => {
    if (!autorizado(req, res)) return;
    db.setEstadoPartido(Number(req.body.id), req.body.estado);
    volverAPartidos(req, res, Number(req.body.id));
  });

  // Inscripción manual desde el panel (jugador con número, o invitado a nombre).
  app.post('/admin/partido/inscribir', (req, res) => {
    if (!autorizado(req, res)) return;
    const partidoId = Number(req.body.partido_id);
    const numero = (req.body.numero || '').replace(/\D/g, '') || null;
    const nombre = (req.body.nombre || '').trim().slice(0, 80) || null;
    if (numero || nombre) db.inscribir(partidoId, numero, { nombre });
    volverAPartidos(req, res, partidoId);
  });

  app.post('/admin/inscripcion/estado', (req, res) => {
    if (!autorizado(req, res)) return;
    const id = Number(req.body.id);
    if (req.body.estado === 'baja') {
      const promovido = db.darDeBaja(id);
      // El que sube de la espera NO se entera solo: el bot no puede iniciarle
      // conversación (131047 fuera de la ventana de 24 h). Se le avisa al
      // número de control para que Clarck le escriba y le pida el Yape.
      const control = (process.env.NOTIFY_NUMBER || '').replace(/\D/g, '');
      if (promovido && control && conexion && conexion.enviar) {
        const p = db.getPartido(promovido.partido_id);
        const lead = promovido.numero ? db.getLead(promovido.numero) : null;
        const quien = promovido.nombre || (lead && lead.nombre) || (promovido.numero ? `+${promovido.numero}` : 'alguien');
        Promise.resolve(conexion.enviar(control,
          `⬆ ${quien} subió de la lista de espera al partido del ${p ? db.fechaBonita(p.fecha) : '?'}${p && p.hora ? ` ${p.hora}` : ''}. Avísale y pídele su Yape${promovido.numero ? `: wa.me/${promovido.numero}` : ''}.`
        )).catch((e) => console.error('[partido] Aviso de promoción falló:', e.message));
      }
    } else db.setEstadoInscripcion(id, req.body.estado);
    volverAPartidos(req, res, Number(req.body.partido_id));
  });

  app.post('/admin/inscripcion/asistencia', (req, res) => {
    if (!autorizado(req, res)) return;
    db.setAsistencia(Number(req.body.id), req.body.valor);
    volverAPartidos(req, res, Number(req.body.partido_id));
  });

  // Asignar a un partido un pago confirmado que quedó sin vincular.
  app.post('/admin/pago/asignar', (req, res) => {
    if (!autorizado(req, res)) return;
    const partidoId = Number(req.body.partido_id);
    const pago = db.listPagosTodos().find((p) => p.id === Number(req.body.pago_id));
    if (pago && partidoId) {
      // Si el pagador YA tiene inscripción activa en este partido, se le
      // vincula el pago (inscribir devolvería 'ya_inscrito' sin hacer nada y
      // el botón quedaba muerto — hallazgo del code review 2026-08-11).
      const activa = pago.numero ? db.inscripcionActiva(partidoId, pago.numero) : null;
      if (activa) db.pagarInscripcion(activa.id, pago.id);
      else db.inscribir(partidoId, pago.numero, { estado: 'pagado', pagoId: pago.id });
      for (let i = 1; i < (pago.cupos || 1); i++) db.inscribir(partidoId, null, { nombre: `Invitado de +${pago.numero}`, estado: 'pagado', pagoId: pago.id });
    }
    volverAPartidos(req, res, partidoId);
  });

  // --- Conexión (WhatsApp): desconectar / cambiar de número --------------------
  // Mensaje suelto desde el panel (prueba de conexión o aviso manual).
  app.post('/admin/enviar', async (req, res) => {
    if (!autorizado(req, res)) return;
    const numero = (req.body.numero || '').replace(/\D/g, '');
    const texto = (req.body.texto || '').trim().slice(0, 1000);
    if (!numero || !texto) return res.status(400).json({ ok: false, error: 'faltan numero/texto' });
    if (!conexion || !conexion.enviar) return res.status(500).json({ ok: false, error: 'conexión no disponible' });
    res.json(await conexion.enviar(numero, texto));
  });

  app.post('/admin/conexion/desconectar', async (req, res) => {
    if (!autorizado(req, res)) return;
    if (conexion) await conexion.desconectar();
    res.redirect(`/admin/leads?key=${encodeURIComponent(req.body.key)}&vista=conexion`);
  });

  // --- Vistas ----------------------------------------------------------------------
  app.get('/admin/leads', (req, res) => {
    if (!autorizado(req, res)) return;
    const key = encodeURIComponent(req.query.key);
    const numero = (req.query.numero || '').replace(/\D/g, '');
    if (numero) return res.send(paginaFicha(db, key, numero));
    if (req.query.vista === 'crm') return res.send(paginaCRM(db, key, req.query));
    if (req.query.vista === 'pagos') return res.send(paginaPagos(db, key, req.query));
    if (req.query.vista === 'partidos') return res.send(paginaPartidos(db, key, req.query));
    if (req.query.vista === 'config') return res.send(paginaConfig(db, key));
    if (req.query.vista === 'conexion') return res.send(paginaConexion(key, conexion));
    res.send(paginaResumen(db, key, req.query));
  });
}

// ==============================================================================
//  Base HTML + sistema de diseño iOS
// ==============================================================================
function baseHtml(titulo, cuerpo, { refresh = false, activo = '', key = '', tabbarMobile = true } = {}) {
  return `<!doctype html><html lang="es"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(titulo)}</title>
${refresh ? `<meta http-equiv="refresh" content="${typeof refresh === 'number' ? refresh : 90}">` : ''}
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Big+Shoulders:ital,wght@0,700;0,800;1,700;1,800&family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
  /* Sistema de diseño Pichangueros (2026-08-11): navy + lima del logo, trazo
     "sticker" de la mascota (borde grueso + sombra dura), números de marcador
     en Big Shoulders itálica. Reemplaza a la estética iOS genérica. */
  :root{
    --bg:#F2F4EC; --card:#fff; --ink:#1C2B3A; --muted:#5D6B7A; --faint:#8C99A6;
    --sep:#E2E5DC; --inset:#F4F6EF; --trazo:#2E3A45;
    --green:#A3C614; --green-d:#55770B; --navy:#16385F; --navy2:#1E4470;
    --amber:#E8930C; --amber-d:#9A5B00; --red:#D14538; --blue:#16385F; --lime:#A3C614;
  }
  *{box-sizing:border-box;margin:0;padding:0;-webkit-font-smoothing:antialiased;-webkit-tap-highlight-color:transparent}
  body{font-family:'Inter',-apple-system,'Segoe UI',sans-serif;color:var(--ink);background:var(--bg);
    min-height:100vh;line-height:1.4}
  a{color:inherit;text-decoration:none}
  .app{max-width:480px;margin:0 auto;min-height:100vh;background:var(--bg);
    padding:calc(env(safe-area-inset-top) + 8px) 0 96px;position:relative}
  .px{padding-left:16px;padding-right:16px}

  /* large title */
  .ltitle{padding:6px 18px 10px;display:flex;align-items:flex-end;justify-content:space-between;gap:10px}
  .ltitle .eyebrow{font-size:11px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:var(--green-d);margin-bottom:2px}
  .ltitle h2{font-family:'Big Shoulders',sans-serif;font-style:italic;text-transform:uppercase;font-size:34px;font-weight:800;letter-spacing:.01em;line-height:1;color:var(--navy)}
  .live{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:600;color:var(--green-d);
    background:rgba(163,198,20,.12);padding:5px 11px;border-radius:999px;white-space:nowrap}
  .live i{width:7px;height:7px;border-radius:50%;background:var(--green);animation:pulse 2s infinite}
  @keyframes pulse{0%{box-shadow:0 0 0 0 rgba(163,198,20,.5)}70%{box-shadow:0 0 0 7px rgba(163,198,20,0)}100%{box-shadow:0 0 0 0 rgba(163,198,20,0)}}
  .csv{font-size:13px;color:var(--muted);border:1px solid var(--sep);background:var(--card);padding:6px 12px;border-radius:999px;white-space:nowrap}

  /* scoreboard hero */
  .marcador{background:linear-gradient(160deg,#1E4470,#0E2542);border:2.5px solid var(--trazo);border-radius:18px;padding:18px 20px 16px;
    color:#fff;position:relative;overflow:hidden;box-shadow:4px 4px 0 rgba(46,58,69,.25);margin:2px 0 0}
  .marcador::before{content:"";position:absolute;inset:0;
    background:repeating-linear-gradient(90deg,transparent 0 30px,rgba(255,255,255,.025) 30px 60px)}
  .marcador>*{position:relative}
  .mtop{display:flex;justify-content:space-between;align-items:center}
  .mlabel{font-size:11px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:#9fb6d6}
  .mdelta{font-size:12px;font-weight:700;color:#C6E34E;background:rgba(163,198,20,.14);padding:4px 10px;border-radius:999px}
  .mnum{font-family:'Big Shoulders',sans-serif;font-style:italic;font-weight:800;font-size:62px;line-height:.92;color:#fff;margin-top:2px;font-variant-numeric:tabular-nums}
  .bars{display:flex;align-items:flex-end;gap:3px;height:62px;margin-top:10px}
  .bar{flex:1;display:flex;flex-direction:column;align-items:center;gap:3px;height:100%}
  .bar .bn{font-size:9px;font-weight:700;color:#a9c2e6;line-height:1;min-height:10px}
  .bar .track{flex:1;width:100%;display:flex;flex-direction:column;justify-content:flex-end;gap:1px}
  .bar .track i{width:100%;background:linear-gradient(180deg,#C6E34E,#A3C614);border-radius:2px;min-height:3px;display:block;opacity:.95}
  .bar .track i.brec{background:linear-gradient(180deg,#8fb3e0,#5a7fb5);opacity:.8}
  .bar.hot .track i.bnue{background:linear-gradient(180deg,#cde96b,var(--lime))}
  .bar.hot .bn{color:var(--lime)}
  .bar .bd{font-size:8px;color:#7e97b8;line-height:1;white-space:nowrap;margin-top:1px}
  .bar .bd.bhoy{color:var(--lime);font-weight:700}
  .mfoot{font-size:9.5px;color:#7e97b8;margin-top:8px;line-height:1.35}

  /* banner */
  .banner{display:flex;gap:12px;align-items:center;background:#fff7e8;border:2px solid var(--trazo);border-radius:16px;padding:13px 15px;margin-top:14px;box-shadow:3px 3px 0 rgba(46,58,69,.12)}
  .banner.ok{background:#eafaf0;border-color:#b7ebca}
  .bic{flex:0 0 auto;width:34px;height:34px;border-radius:10px;background:var(--amber);display:grid;place-items:center;font-size:18px}
  .banner.ok .bic{background:var(--green)}
  .btxt{font-size:12.5px;line-height:1.35;color:#7a5300}
  .banner.ok .btxt{color:#1c6b3a}
  .btxt b{font-weight:700}

  /* stat grid */
  .grid2{display:grid;grid-template-columns:1fr 1fr;gap:11px;margin-top:14px}
  .stat{background:var(--card);border:2px solid var(--trazo);border-radius:16px;padding:14px 15px;box-shadow:3px 3px 0 rgba(46,58,69,.14);display:block}
  .stat .sn{font-family:'Big Shoulders',sans-serif;font-style:italic;font-weight:800;font-size:34px;line-height:1;font-variant-numeric:tabular-nums}
  .stat .sl{font-size:12px;color:var(--muted);font-weight:500;margin-top:3px}
  .stat.amber .sn{color:var(--amber)} .stat.green .sn{color:var(--green-d)} .stat.navy .sn{color:var(--navy2)} .stat.red .sn{color:var(--red)}
  /* Tarjeta-filtro activa: se ve que ESA es la que está aplicada. */
  .stat.sel{background:var(--navy);box-shadow:3px 3px 0 rgba(46,58,69,.3)}
  .stat.sel .sn,.stat.sel .sl{color:#fff}
  a.stat:hover{transform:translate(-1px,-1px);box-shadow:4px 4px 0 rgba(46,58,69,.2)}
  .stat .chip{float:right;font-size:10px;font-weight:700;padding:3px 8px;border-radius:999px}
  .chip.up{background:rgba(163,198,20,.14);color:var(--green-d)}
  .chip.wait{background:rgba(255,149,0,.14);color:var(--amber-d)}

  /* section header */
  .shdr{font-family:'Big Shoulders',sans-serif;font-style:italic;font-size:15px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--navy);padding:18px 6px 8px;display:flex;align-items:center;gap:8px}
  .shdr::after{content:'';flex:1;height:3px;background:var(--lime);border-radius:2px;transform:skewX(-20deg);opacity:.75}
  .shdr small{font-family:'Inter',sans-serif;font-style:normal;text-transform:none;letter-spacing:0;font-weight:500;font-size:11.5px;color:var(--faint)}

  /* zona rows */
  .zlist{background:var(--card);border:2px solid var(--trazo);border-radius:16px;overflow:hidden;box-shadow:3px 3px 0 rgba(46,58,69,.14)}
  .zrow{display:flex;align-items:center;gap:12px;padding:12px 15px;border-bottom:1px solid var(--sep)}
  .zrow:last-child{border-bottom:none}
  .zdot{width:11px;height:11px;border-radius:3px;flex:0 0 auto}
  .zname{font-size:14.5px;font-weight:600;flex:0 0 96px}
  .ztrack{flex:1;height:7px;background:var(--inset);border-radius:999px;overflow:hidden}
  .ztrack i{display:block;height:100%;border-radius:999px}
  .zval{font-size:13px;font-weight:600;color:var(--muted);flex:0 0 auto;min-width:40px;text-align:right}

  /* search + chips */
  .search{display:flex;align-items:center;gap:8px;background:var(--inset);border-radius:12px;padding:0 13px;margin:2px 0 4px}
  .search svg{flex:0 0 auto;color:var(--faint)}
  .search input{flex:1;border:none;background:transparent;outline:none;font:inherit;font-size:15px;padding:10px 0;color:var(--ink)}
  .search input::placeholder{color:var(--faint)}
  .search button{border:2px solid var(--trazo);background:var(--lime);color:var(--navy);font:inherit;font-weight:800;font-size:13px;padding:6px 14px;border-radius:9px;margin:5px 0;cursor:pointer}
  .chips{display:flex;gap:7px;padding:8px 2px 4px;flex-wrap:wrap}
  .fchip{font-size:12.5px;font-weight:600;color:var(--muted);background:var(--card);border:1px solid var(--sep);padding:7px 13px;border-radius:999px;white-space:nowrap}
  .fchip.on{background:var(--navy2);color:#fff;border-color:var(--navy2)}
  .fchip.amber.on{background:var(--amber);border-color:var(--amber);color:#fff}
  .fchip.red.on{background:var(--red);border-color:var(--red);color:#fff}

  /* barra de filtros (selects estilo slicer) */
  .fbar{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0 2px}
  .fbar select,.fbar input[type=date]{flex:1;min-width:105px;background:var(--card);border:1px solid var(--sep);
    border-radius:12px;padding:9px 11px;font:inherit;font-size:13px;font-weight:600;color:var(--ink);outline:none;
    -webkit-appearance:none;appearance:none}
  .fbar select{background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%236b7c72' stroke-width='1.6' fill='none' stroke-linecap='round'/%3E%3C/svg%3E");
    background-repeat:no-repeat;background-position:right 11px center;padding-right:26px}

  /* lead list */
  .llist{background:var(--card);border:2px solid var(--trazo);border-radius:16px;overflow:hidden;box-shadow:3px 3px 0 rgba(46,58,69,.14)}
  .lrow{display:flex;align-items:center;gap:13px;padding:12px 14px;border-bottom:1px solid var(--sep);position:relative}
  .lrow:last-child{border-bottom:none}
  .lrow:active{background:var(--inset)}
  .ava{width:44px;height:44px;border-radius:50%;flex:0 0 auto;display:grid;place-items:center;font-weight:700;font-size:15px;color:#fff}
  .lbody{flex:1;min-width:0;overflow:hidden;display:flex;flex-direction:column}
  .lname{font-size:15.5px;font-weight:600;letter-spacing:-.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .lsub{font-size:12.5px;color:var(--muted);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
  .lmeta{display:flex;flex-direction:column;align-items:flex-end;gap:5px;flex:0 0 auto;margin-left:10px}
  .ltime{font-size:11.5px;color:var(--faint);white-space:nowrap}
  .badge{font-size:10px;font-weight:700;padding:3px 8px;border-radius:999px;white-space:nowrap}
  .b-wait{background:rgba(255,149,0,.15);color:var(--amber-d)}
  .b-hand{background:rgba(255,59,48,.13);color:#cc2f26}
  .b-done{background:rgba(163,198,20,.15);color:var(--green-d)}
  .b-new{background:var(--inset);color:var(--muted)}
  .b-zona{color:#fff}
  .chev{color:#c7d0cb;flex:0 0 auto}
  .pico{width:40px;height:40px;border-radius:12px;flex:0 0 auto;display:grid;place-items:center;font-weight:800;font-size:12px;color:#fff;letter-spacing:.04em}
  .dotnew{position:absolute;left:5px;top:50%;transform:translateY(-50%);width:7px;height:7px;border-radius:50%;background:var(--amber)}
  .vacio{color:var(--muted);text-align:center;padding:48px 16px;font-size:15px}

  /* ficha */
  .navbar{display:flex;align-items:center;justify-content:space-between;padding:2px 4px 6px}
  .navback{display:inline-flex;align-items:center;gap:2px;color:var(--green-d);font-size:16px;font-weight:500}
  .wabtn{display:inline-flex;align-items:center;gap:6px;background:var(--green);color:#fff;font-size:13px;font-weight:600;padding:8px 14px;border-radius:999px;box-shadow:0 4px 12px -4px rgba(163,198,20,.6)}
  .fhead{display:flex;flex-direction:column;align-items:center;text-align:center;padding:4px 0 12px}
  .fava{width:74px;height:74px;border-radius:50%;display:grid;place-items:center;font-weight:700;font-size:26px;color:#fff;margin-bottom:10px}
  .fhead h2{font-size:21px;font-weight:700;letter-spacing:-.01em}
  .fnum{font-size:13px;color:var(--muted);margin-top:2px}
  .fpills{display:flex;gap:7px;margin-top:10px;flex-wrap:wrap;justify-content:center}
  .pz{font-size:11.5px;font-weight:700;padding:5px 12px;border-radius:999px;color:#fff}

  .group{background:var(--card);border:2px solid var(--trazo);border-radius:16px;overflow:hidden;box-shadow:3px 3px 0 rgba(46,58,69,.14)}
  .grow{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 15px;border-bottom:1px solid var(--sep);font-size:14.5px}
  .grow:last-child{border-bottom:none}
  .grow .k{color:var(--muted)} .grow .v{font-weight:600;text-align:right}
  .pipe{display:flex;gap:6px;flex-wrap:wrap;padding:13px 14px}
  .pstep{font-family:inherit;font-size:12px;font-weight:600;padding:7px 12px;border-radius:999px;background:var(--inset);color:var(--muted);border:none}
  .pstep.on{background:var(--blue);color:#fff}
  form.inline{display:flex;gap:8px;flex-wrap:wrap;padding:12px 14px}
  form.inline input{flex:1;min-width:130px;background:var(--inset);border:1px solid var(--sep);border-radius:11px;padding:10px 13px;color:var(--ink);font:inherit;font-size:14px;outline:none}
  form.inline textarea{flex-basis:100%;background:var(--inset);border:1px solid var(--sep);border-radius:11px;padding:10px 13px;color:var(--ink);font:inherit;font-size:14px;outline:none;resize:vertical;min-height:64px}
  form.inline button{background:var(--lime);color:var(--navy);border:2px solid var(--trazo);border-radius:11px;padding:9px 16px;font:inherit;font-weight:800;box-shadow:2px 2px 0 rgba(46,58,69,.25);cursor:pointer}
  form.inline button:active{transform:translate(1px,1px);box-shadow:1px 1px 0 rgba(46,58,69,.25)}
  form.inline label{flex-basis:100%;font-size:12px;font-weight:700;color:var(--muted);margin-bottom:-4px}
  .config-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;padding:12px 14px;border-bottom:1px solid var(--sep)}
  .config-row:last-child{border-bottom:none}
  .config-row input{flex:1;min-width:90px}
  .btn-rojo{background:var(--red)!important}
  .notas-list{padding:0 14px 12px}
  .notas-list p{font-size:14px;border-left:3px solid var(--sep);padding:4px 10px;margin-bottom:8px}
  .notas-list time{display:block;font-size:11px;color:var(--faint)}
  .chat{padding:8px 4px 2px;display:flex;flex-direction:column;gap:6px}
  .bub{max-width:80%;padding:8px 12px;border-radius:18px;font-size:14px;line-height:1.4;white-space:pre-wrap;word-break:break-word}
  .bub.in{align-self:flex-start;background:#e9ebec;color:#0b1b12;border-bottom-left-radius:5px}
  .bub.out{align-self:flex-end;background:var(--navy);color:#fff;border-bottom-right-radius:5px}
  .bub time{display:block;font-size:10px;margin-top:3px;opacity:.55;text-align:right}
  .noreply{align-self:center;display:inline-flex;align-items:center;gap:7px;font-size:11.5px;font-weight:600;color:var(--amber-d);background:rgba(255,149,0,.12);border:1px dashed #ffce8a;padding:5px 12px;border-radius:999px;margin:6px 0}

  .stack>*+*{margin-top:6px}
  .foot{color:var(--faint);font-size:12px;text-align:center;padding:22px 16px 6px}

  /* tab bar */
  .tabbar{position:fixed;bottom:0;left:50%;transform:translateX(-50%);width:100%;max-width:480px;
    height:calc(64px + env(safe-area-inset-bottom));background:var(--navy);
    border-top:3px solid var(--trazo);display:flex;padding:8px 0 env(safe-area-inset-bottom);z-index:50}
  .tab{flex:1;display:flex;flex-direction:column;align-items:center;gap:3px;color:#8FA3BC;
    font-family:'Big Shoulders',sans-serif;font-size:11.5px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}
  .tab svg{width:25px;height:25px}
  .tab.on{color:var(--lime)}

  /* sidebar (solo escritorio) */
  .shell{min-height:100vh}
  .sidebar{display:none}
  .sidebar .brand{display:flex;align-items:center;gap:11px;font-family:'Big Shoulders',sans-serif;font-style:italic;text-transform:uppercase;font-weight:800;font-size:22px;color:var(--navy);letter-spacing:.02em;margin-bottom:26px}
  .sidebar .brand .iso{width:36px;height:36px;border-radius:11px;border:2px solid var(--trazo);background:var(--lime);display:grid;place-items:center;font-size:19px;box-shadow:2px 2px 0 rgba(46,58,69,.2)}
  .snav{display:flex;flex-direction:column;gap:4px}
  .snav a{display:flex;align-items:center;gap:12px;padding:11px 13px;border-radius:12px;font-weight:600;font-size:15px;color:var(--muted)}
  .snav a svg{width:22px;height:22px}
  .snav a.on{background:rgba(163,198,20,.12);color:var(--green-d)}
  .snav a:hover{background:var(--inset)}
  .sbottom{margin-top:auto;display:flex;flex-direction:column;gap:2px}
  .scsv{display:inline-flex;align-items:center;gap:7px;font-size:13.5px;color:var(--muted);padding:11px 13px;border-radius:12px}
  .scsv:hover{background:var(--inset)}
  .fcol-right .group{margin-bottom:0}

  /* RESPONSIVE: a partir de 980px, layout de escritorio */
  @media (min-width:980px){
    body{background:#e3e8e5}
    .shell{display:flex;max-width:1180px;margin:0 auto;background:var(--bg);min-height:100vh;box-shadow:0 0 90px -50px rgba(16,39,68,.45)}
    .sidebar{display:flex;flex-direction:column;flex:0 0 250px;background:#fff;border-right:1px solid var(--sep);padding:28px 20px;position:sticky;top:0;height:100vh}
    .app{flex:1;min-width:0;max-width:none;margin:0;padding:24px 36px 56px}
    .px{padding-left:0;padding-right:0}
    .tabbar{display:none}
    .ltitle{padding-left:2px;padding-right:2px}
    .grid2{grid-template-columns:repeat(4,1fr)}
    .marcador{padding:22px 26px 20px}
    .mnum{font-size:70px}
    .bars{height:80px}
    /* ficha en 2 columnas */
    .ficha-grid{display:grid;grid-template-columns:minmax(0,360px) 1fr;gap:26px;align-items:start}
    .fcol-right{position:sticky;top:24px}
    .fcol-left .fhead{align-items:flex-start;text-align:left}
    .fcol-left .fhead .fpills{justify-content:flex-start}
    /* listas con ancho de lectura cómodo */
    .llist,.zlist{max-width:none}
  }
  @media (min-width:1280px){
    .app{padding:28px 56px 56px}
  }
</style></head><body>
<div class="shell">${key ? sidebar(key, activo) : ''}<div class="app">${cuerpo}</div></div>
${tabbarMobile && activo ? tabbar(key, activo) : ''}</body></html>`;
}

// SVGs reutilizables ----------------------------------------------------------
const SVG = {
  chev: '<svg class="chev" width="8" height="14" viewBox="0 0 8 14"><path d="m1 1 6 6-6 6" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>',
  lupa: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="7" cy="7" r="5" stroke="currentColor" stroke-width="1.6"/><path d="m11 11 3 3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  back: '<svg width="9" height="16" viewBox="0 0 9 16"><path d="M8 1 1 8l7 7" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>',
  wa: '<svg width="15" height="15" viewBox="0 0 24 24" fill="#fff"><path d="M12 2a10 10 0 0 0-8.6 15l-1.3 4.7 4.8-1.3A10 10 0 1 0 12 2Zm5.3 14.1c-.2.6-1.3 1.2-1.8 1.2-.5.1-1 .1-1.7-.1-.4-.1-1-.3-1.6-.6-2.9-1.3-4.8-4.2-4.9-4.4-.2-.2-1.2-1.6-1.2-3 0-1.5.7-2.2 1-2.5.2-.3.6-.4.8-.4h.6c.2 0 .4 0 .6.5l.8 2c.1.2.1.4 0 .5l-.4.6-.3.3c-.2.2-.3.4-.2.6.2.4.8 1.3 1.6 2 .9.8 1.7 1.1 2.1 1.3.3.1.5.1.7-.1l.7-.9c.2-.3.4-.2.6-.1l1.9.9c.2.1.4.2.4.3.1.2.1.7-.1 1.2Z"/></svg>',
  iResumen: '<svg viewBox="0 0 24 24" fill="none"><path d="M4 13h6v7H4zM14 4h6v16h-6zM4 4h6v6H4z" fill="currentColor"/></svg>',
  iCrm: '<svg viewBox="0 0 24 24" fill="none"><circle cx="9" cy="8" r="3.4" stroke="currentColor" stroke-width="1.8"/><path d="M3.5 19c.6-3.2 3-5 5.5-5s4.9 1.8 5.5 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M16.5 7.5c1.7 0 3 1.3 3 3s-1.3 3-3 3M18 19c-.2-1.6-.8-3-2-4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  iConfig: '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.8"/><path d="M19.4 13.5a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.04 1.56V20a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.04-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.04H4a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.56-1.04 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H10a1.7 1.7 0 0 0 1.04-1.56V4a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1.04 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V10a1.7 1.7 0 0 0 1.56 1.04H20a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.56 1.04Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
  iConexion: '<svg viewBox="0 0 24 24" fill="none"><path d="M9 15l6-6M10.5 6.5l.9-.9a4 4 0 0 1 5.66 5.66l-.9.9M13.5 17.5l-.9.9a4 4 0 0 1-5.66-5.66l.9-.9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  iPagos: '<svg viewBox="0 0 24 24" fill="none"><rect x="2.5" y="6" width="19" height="12.5" rx="2.5" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="12.2" r="2.8" stroke="currentColor" stroke-width="1.8"/><path d="M6 9.2h.01M18 15.2h.01" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
  iPartidos: '<svg viewBox="0 0 24 24" fill="none"><rect x="3" y="5" width="18" height="16" rx="2.5" stroke="currentColor" stroke-width="1.8"/><path d="M3 9.5h18M8 3v4M16 3v4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="12" cy="15.2" r="2.6" stroke="currentColor" stroke-width="1.6"/></svg>',
};

const tabbar = (key, activo) => `<nav class="tabbar">
  <a class="tab ${activo === 'resumen' ? 'on' : ''}" href="/admin/leads?key=${key}">${SVG.iResumen}Hoy</a>
  <a class="tab ${activo === 'partidos' ? 'on' : ''}" href="/admin/leads?key=${key}&vista=partidos">${SVG.iPartidos}Partidos</a>
  <a class="tab ${activo === 'crm' ? 'on' : ''}" href="/admin/leads?key=${key}&vista=crm">${SVG.iCrm}Jugadores</a>
  <a class="tab ${activo === 'pagos' ? 'on' : ''}" href="/admin/leads?key=${key}&vista=pagos">${SVG.iPagos}La plata</a>
  <a class="tab ${activo === 'config' ? 'on' : ''}" href="/admin/leads?key=${key}&vista=config">${SVG.iConfig}Config</a>
  <a class="tab ${activo === 'conexion' ? 'on' : ''}" href="/admin/leads?key=${key}&vista=conexion">${SVG.iConexion}Conexión</a>
</nav>`;

const sidebar = (key, activo) => `<aside class="sidebar">
  <div class="brand"><span class="iso">⚽</span> Pichangueros</div>
  <nav class="snav">
    <a class="${activo === 'resumen' ? 'on' : ''}" href="/admin/leads?key=${key}">${SVG.iResumen} Hoy</a>
    <a class="${activo === 'partidos' ? 'on' : ''}" href="/admin/leads?key=${key}&vista=partidos">${SVG.iPartidos} Partidos</a>
    <a class="${activo === 'crm' ? 'on' : ''}" href="/admin/leads?key=${key}&vista=crm">${SVG.iCrm} Jugadores</a>
    <a class="${activo === 'pagos' ? 'on' : ''}" href="/admin/leads?key=${key}&vista=pagos">${SVG.iPagos} La plata</a>
    <a class="${activo === 'config' ? 'on' : ''}" href="/admin/leads?key=${key}&vista=config">${SVG.iConfig} Config</a>
    <a class="${activo === 'conexion' ? 'on' : ''}" href="/admin/leads?key=${key}&vista=conexion">${SVG.iConexion} Conexión</a>
  </nav>
  <div class="sbottom">
    ${sheetsync.activo() ? `<a class="scsv" href="/admin/sync-sheet?key=${key}">☁ Respaldar a Sheet</a>` : ''}
    <a class="scsv" href="/admin/leads.csv?key=${key}">⬇ Exportar CSV</a>
    <a class="scsv" href="/admin/leads.xlsx?key=${key}">📊 Exportar Excel</a>
    <a class="scsv" href="/admin/backup-db?key=${key}">💾 Descargar backup BD</a>
    ${backup.activo() ? `<a class="scsv" href="/admin/backup-email?key=${key}">✉ Enviar backup por correo</a>` : ''}
  </div>
</aside>`;

function badges(l, sinResponder) {
  const z = ZONAS[l.zona];
  const vencido = l.proxima_accion && l.proxima_accion <= hoyLima();
  const tags = (l.etiquetas || '').split(',').filter(Boolean);
  return `
    ${l.handoff ? `<span class="badge b-hand">🔔 ${esc(l.handoff_motivo || 'derivado')}</span>` : ''}
    ${sinResponder ? '<span class="badge b-wait">📥 sin responder</span>' : ''}
    ${vencido ? `<span class="badge b-wait">⏰ ${esc(l.proxima_nota || 'seguimiento')}</span>` : ''}
    ${z ? `<span class="badge b-zona" style="background:${z.color}">${z.nombre}</span>` : ''}
    <span class="badge b-new">${esc(ESTADOS[l.estado] || l.estado)}</span>
    ${tags.map((t) => `<span class="badge b-new">${esc(t)}</span>`).join('')}`;
}

// ==============================================================================
//  Vista 1 · RESUMEN (dashboard)
// ==============================================================================
function paginaResumen(db, key, query = {}) {
  const todos = db.listLeads();
  const roles = db.ultimosRoles();
  const sinResp = (l) => sinResponder(roles, l);
  const hoy = hoyLima();

  // Altas por día (últimos 14, terminando hoy Lima).
  const porDia = {};
  for (const l of todos) {
    const d = (l.creado_en || '').slice(0, 10);
    if (d) porDia[d] = (porDia[d] || 0) + 1;
  }
  // Actividad por día: quiénes escribieron — separados en NUEVOS (su primer
  // día) vs RECURRENTES (ya estaban registrados y volvieron a escribir).
  const creadoDe = {};
  for (const l of todos) creadoDe[l.numero] = (l.creado_en || '').slice(0, 10);
  const actividad = {};
  for (const r of db.actividadPorDia(fechaLima(-13))) {
    const a = actividad[r.d] || (actividad[r.d] = { nuevos: 0, rec: 0 });
    if (creadoDe[r.numero] === r.d) a.nuevos++; else a.rec++;
  }
  const dias = [];
  for (let i = 13; i >= 0; i--) {
    const d = fechaLima(-i);
    const a = actividad[d] || { nuevos: 0, rec: 0 };
    // Respaldo: si el historial no cubre ese día, al menos los leads creados.
    const nuevos = Math.max(a.nuevos, porDia[d] || 0);
    dias.push({ d, nuevos, rec: a.rec, n: nuevos + a.rec });
  }
  const maxN = Math.max(1, ...dias.map((x) => x.n));
  // "Esta semana" cuenta solo NUEVOS (captación), no la actividad total.
  const semana = dias.slice(-7).reduce((a, x) => a + x.nuevos, 0);
  const previa = dias.slice(0, 7).reduce((a, x) => a + x.nuevos, 0);
  const delta = previa ? Math.round(((semana - previa) / previa) * 100) : (semana ? 100 : 0);
  const hoyN = porDia[hoy] || 0;

  const colaResp = todos.filter(sinResp).length;
  const enHandoff = todos.filter((l) => l.handoff).length;
  const paraHoy = todos.filter((l) => l.proxima_accion && l.proxima_accion <= hoy).length;
  const pagosRevisar = db.pagosPorRevisar();

  // Por zona (las clasificadas + las que faltan).
  const zc = { brena: 0, comas: 0, otra: 0 };
  let clasificadas = 0;
  for (const l of todos) if (ZONAS[l.zona]) { zc[l.zona] = (zc[l.zona] || 0) + 1; clasificadas++; }
  const sinClasificar = todos.length - clasificadas;
  const maxZ = Math.max(1, zc.brena, zc.comas, zc.otra, sinClasificar);
  // Cada fila es un link al CRM ya filtrado (todo el Resumen es navegable).
  const zrow = (nombre, n, color, filtroUrl) => {
    const inner = `<span class="zdot" style="background:${color}"></span><span class="zname">${nombre}</span>
      <span class="ztrack"><i style="width:${Math.max(3, Math.round((n / maxZ) * 100))}%;background:${color}"></i></span>
      <span class="zval">${n}</span>`;
    return filtroUrl
      ? `<a class="zrow" href="/admin/leads?key=${key}&vista=crm${filtroUrl}">${inner}</a>`
      : `<div class="zrow">${inner}</div>`;
  };

  // Demanda por distrito (zona 'otra' = lista de espera): ¿dónde conviene abrir?
  // Agrupa el distrito de texto libre normalizado (minúsculas, sin tildes).
  const UMBRAL_PILOTO = 28; // ~2 pichangas llenas (14 c/u) → distrito candidato a piloto
  const desde30 = fechaLima(-29);
  const dd = {};
  for (const l of todos) {
    if (l.zona !== 'otra' || !(l.distrito || '').trim()) continue;
    const k = normTexto(l.distrito);
    if (!dd[k]) dd[k] = { k, nombre: l.distrito.trim().toLowerCase().replace(/(^|\s)\p{L}/gu, (c) => c.toUpperCase()), n: 0, mes: 0 };
    dd[k].n++;
    if ((l.creado_en || '').slice(0, 10) >= desde30) dd[k].mes++;
  }
  const distritos = Object.values(dd).sort((a, b) => b.n - a.n).slice(0, 8);
  const maxD = Math.max(1, ...distritos.map((d) => d.n));
  const drow = (d) => {
    const listo = d.n >= UMBRAL_PILOTO;
    const color = listo ? '#A3C614' : '#64748b';
    return `<a class="zrow" href="/admin/leads?key=${key}&vista=crm&distrito=${encodeURIComponent(d.k)}"><span class="zdot" style="background:${color}"></span>
      <span class="zname">${esc(d.nombre)}${listo ? ' 🔥' : ''}</span>
      <span class="ztrack"><i style="width:${Math.max(3, Math.round((d.n / maxD) * 100))}%;background:${color}"></i></span>
      <span class="zval">${d.n}${d.mes ? ` <small style="color:var(--faint);font-weight:400">+${d.mes} este mes</small>` : ''}</span></a>`;
  };

  // Cada barra es un link: toca un día → CRM filtrado a los contactos de ese día.
  // Barra APILADA: verde = nuevos (escribieron por 1.ª vez), azul = recurrentes.
  const barras = dias.map((x, i) => {
    const hNue = x.nuevos ? Math.max(6, Math.round((x.nuevos / maxN) * 100)) : 0;
    const hRec = x.rec ? Math.max(6, Math.round((x.rec / maxN) * 100)) : 0;
    const hot = x.nuevos >= maxN * 0.5 && x.nuevos > 0;
    const esHoy = x.d === hoy;
    const nDia = Number(x.d.slice(8));
    const etiqueta = esHoy ? 'hoy' : (i === 0 || nDia === 1 ? `${nDia}${mesCorto(x.d)}` : String(nDia));
    return `<a class="bar ${hot ? 'hot' : ''}" href="/admin/leads?key=${key}&vista=crm&dia=${x.d}" title="${x.d}: ${x.nuevos} nuevos + ${x.rec} recurrentes — toca para verlos">
      <span class="bn">${x.n || ''}</span>
      <div class="track">${x.rec ? `<i class="brec" style="height:${hRec}%"></i>` : ''}${x.nuevos ? `<i class="bnue" style="height:${hNue}%"></i>` : ''}</div>
      <span class="bd${esHoy ? ' bhoy' : ''}">${etiqueta}</span></a>`;
  }).join('');

  // Embudo: en qué paso del camino está cada contacto (primer mensaje → pago).
  const conDatos = todos.filter((l) => l.estado && l.estado !== 'nuevo').length;
  const invitados = todos.filter((l) => l.estado === 'invitado_grupo').length;
  const enEspera = todos.filter((l) => l.estado === 'lista_espera').length;
  const nPagadores = db.pagadores ? db.pagadores() : 0;
  const pct = (n) => (todos.length ? Math.round((n / todos.length) * 100) : 0);
  // Cada escalón del embudo lleva al CRM con ESA gente filtrada.
  const frow = (nombre, n, color, detalle, filtroUrl) =>
    `<a class="zrow" href="/admin/leads?key=${key}&vista=crm${filtroUrl || ''}"><span class="zdot" style="background:${color}"></span>
      <span class="zname">${nombre}${detalle ? ` <small style="color:var(--faint);font-weight:400">${detalle}</small>` : ''}</span>
      <span class="ztrack"><i style="width:${Math.max(3, pct(n))}%;background:${color}"></i></span>
      <span class="zval">${n} <small style="color:var(--faint);font-weight:400">${pct(n)}%</small></span></a>`;

  // El banner refleja el modo real del bot (misma lectura de env que index.js).
  const modoSeguro = (process.env.SAFE_MODE || 'true') !== 'false';
  const capturados = silenciados48h(roles, todos);
  const bannerSeguro = modoSeguro
    ? `<a class="banner px" href="/admin/leads?key=${key}&vista=crm" style="text-decoration:none">
    <div class="bic">🔒</div>
    <div class="btxt"><b>Modo seguro activo.</b> El bot captura en silencio (por diseño):
      <b>${capturados} conversacion${capturados === 1 ? '' : 'es'}</b> registradas en las últimas 48 h, listas para cuando se encienda.</div></a>`
    : `<div class="banner ok px"><div class="bic">🤖</div>
    <div class="btxt"><b>Bot activo.</b> Responde a todos los que escriban al número.</div></div>`;

  // Acción primero: la pichanga más próxima como marcador, antes que cualquier
  // métrica. Si no hay partido abierto, invita a abrir uno.
  const abiertos = db.partidosAbiertos();
  const prox = abiertos[0] || null;
  const heroPartido = prox
    ? `<a class="marcador" style="display:block;margin-bottom:14px" href="/admin/leads?key=${key}&vista=partidos&partido=${prox.id}">
        <div class="mtop"><span class="mlabel">⚽ Próxima pichanga · ${ZONAS[prox.zona]?.nombre || esc(prox.zona)}</span>
          <span class="mdelta">${prox.restante > 0 ? `${prox.restante} cupos libres` : '⏳ LLENO — hay espera'}</span></div>
        <div class="mnum">${prox.ocupados}<span style="font-size:32px;color:#8FA3BC">/${prox.cupo}</span></div>
        <div class="mfoot" style="font-size:12px;color:#C4D1DF">${esc(db.fechaBonita(prox.fecha))}${prox.hora ? ` · ${esc(prox.hora)}` : ''}${prox.sede ? ` · ${esc(prox.sede)}` : ''} — toca para ver la lista y copiarla al grupo</div>
      </a>`
    : `<a class="banner px" href="/admin/leads?key=${key}&vista=partidos" style="margin:0 0 14px;text-decoration:none"><div class="bic">⚽</div>
        <div class="btxt"><b>No hay partidos con inscripción abierta.</b> Abre uno y el bot empieza a llenar la lista solo.</div></a>`;

  return baseHtml('Pichangueros — Hoy', `
    <div class="ltitle">
      <div><div class="eyebrow">Pichangueros · Tu equipo está aquí</div><h2>Hoy</h2></div>
      <span class="live"><i></i> En vivo</span>
    </div>
    <div class="px">
      ${query.sync ? `<div class="banner ${query.sync === 'err' ? '' : 'ok'}" style="margin:0 0 12px"><div class="bic">☁</div><div class="btxt">${query.sync === 'err' ? 'No se pudo respaldar al Sheet — revisá SHEET_WEBHOOK_URL/SHEET_SECRET.' : `<b>Respaldado al Google Sheet</b> · ${esc(query.sync)} leads.`}</div></div>` : ''}
      ${heroPartido}
      ${bannerSeguro}

      <div class="shdr">Pendientes <small>· toca para actuar</small></div>
      <div class="grid2" style="margin-top:2px">
        <a class="stat green" href="/admin/leads?key=${key}&vista=crm">${delta ? `<span class="chip ${delta > 0 ? 'up' : 'wait'}">${delta > 0 ? '▲' : '▼'} ${Math.abs(delta)}%</span>` : ''}<div class="sn">${semana}</div><div class="sl">Esta semana</div></a>
        <a class="stat navy" href="/admin/leads?key=${key}&vista=crm&dia=${hoy}&tipo=nuevos" title="Ver a los que escribieron por primera vez hoy"><div class="sn">${hoyN}</div><div class="sl">Nuevos hoy ›</div></a>
        <a class="stat amber" href="/admin/leads?key=${key}&vista=crm&filtro=responder">${colaResp ? '<span class="chip wait">pendiente</span>' : ''}<div class="sn">${colaResp}</div><div class="sl">${modoSeguro ? 'Testers sin responder' : 'Sin responder (48 h)'}</div></a>
        <a class="stat ${enHandoff ? 'red' : ''}" href="/admin/leads?key=${key}&vista=crm&filtro=handoff"><div class="sn">${enHandoff}</div><div class="sl">Para Clarck</div></a>
      </div>

      <div class="shdr">La comunidad <small>· ${todos.length} contactos</small></div>
      <div class="marcador">
        <div class="mtop"><span class="mlabel">Contactos captados</span>
          <span class="mdelta">▲ +${semana} esta semana</span></div>
        <div class="mnum">${todos.length}</div>
        <div style="font-size:13px;font-weight:700;margin-top:4px">
          <span style="color:#C6E34E">Hoy: ${dias[dias.length - 1].nuevos} nuevo${dias[dias.length - 1].nuevos === 1 ? '' : 's'}</span>
          <span style="color:#8fb3e0"> · ${dias[dias.length - 1].rec} recurrente${dias[dias.length - 1].rec === 1 ? '' : 's'} (ya registrados, volvieron a escribir)</span>
        </div>
        <div class="bars">${barras}</div>
        <div class="mfoot"><span style="color:#C6E34E">■ Nuevos</span> (escriben por 1.ª vez) · <span style="color:#8fb3e0">■ Recurrentes</span> (ya registrados, volvieron a escribir) — solo chats directos, los grupos no cuentan. Toca una barra para ver a todos los de ese día, separados en nuevos y recurrentes.</div>
      </div>

      <div class="shdr">Pipeline · del primer mensaje al pago <small>· toca para ver quiénes</small></div>
      <div class="zlist">
        ${frow('Escribieron al número', todos.length, '#0a84ff', '', '')}
        ${frow('Dejaron sus datos', conDatos, '#5e5ce6', 'nombre · edad · distrito', '&estado=con_datos')}
        ${frow('Invitados al grupo', invitados, '#A3C614', 'Breña / Comas', '&estado=invitado_grupo')}
        ${frow('Lista de espera', enEspera, '#ff9f0a', 'otras zonas', '&estado=lista_espera')}
        ${frow('Pagaron por Yape', nPagadores, '#55770B', '', '&estado=pago')}
      </div>
      <div class="foot" style="padding:8px 2px 0">"Escribieron" cuenta a <b>todos</b> los que chatean al número (también conocidos y jugadores antiguos), no solo interesados nuevos.</div>

      <div class="shdr">Por zona <small>· toca para ver quiénes son</small></div>
      <div class="zlist">
        ${zrow('Breña', zc.brena, ZONAS.brena.color, '&zona=brena')}
        ${zrow('Comas', zc.comas, ZONAS.comas.color, '&zona=comas')}
        ${zc.otra ? zrow('Otras zonas', zc.otra, ZONAS.otra.color, '&zona=otra') : ''}
        ${sinClasificar ? zrow('Por clasificar', sinClasificar, 'var(--faint)', null) : ''}
      </div>

      ${distritos.length ? `
      <div class="shdr">¿Dónde abrir? · demanda por distrito</div>
      <div class="zlist">${distritos.map(drow).join('')}</div>
      <div class="foot" style="padding:8px 2px 0">Referencia: ${UMBRAL_PILOTO}+ interesados ≈ 2 pichangas llenas → 🔥 candidato a piloto.</div>` : ''}

      ${paraHoy ? `<a class="banner px" href="/admin/leads?key=${key}&vista=crm&filtro=hoy" style="margin-top:12px;text-decoration:none"><div class="bic">⏰</div><div class="btxt"><b>${paraHoy} seguimiento${paraHoy === 1 ? '' : 's'} para hoy.</b> Toca para verlos.</div></a>` : ''}
      ${pagosRevisar ? `<div class="banner px" style="margin-top:12px"><div class="bic">💸</div><div class="btxt"><b>${pagosRevisar} pago${pagosRevisar === 1 ? '' : 's'} de Yape por revisar.</b> Monto no coincide, comprobante repetido o ilegible — entra a la ficha del contacto para verlo.</div></div>` : ''}

      <div class="foot">Se actualiza solo cada 90 s · <a href="/admin/leads.csv?key=${key}" style="color:var(--green-d)">⬇ exportar CSV</a></div>
    </div>
  `, { refresh: true, activo: 'resumen', key });
}

const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const mesCorto = (yyyymmdd) => MESES[Number((yyyymmdd || '').slice(5, 7)) - 1] || '';

// ==============================================================================
//  Vista · PAGOS (finanzas: todos los cobros, medio, operación, estado)
// ==============================================================================
const MEDIOS = {
  yape: { nombre: 'Yape', color: '#7b2f8e' },
  plin: { nombre: 'Plin', color: '#0aa5a8' },
  bcp: { nombre: 'BCP', color: '#003b7a' },
  interbank: { nombre: 'Interbank', color: '#12a14b' },
  otro: { nombre: 'Otro', color: '#64748b' },
};

function paginaPagos(db, key, query = {}) {
  const todosPagos = db.listPagosTodos();
  const hoy = hoyLima();
  const soles = (n) => `S/ ${Number(n || 0) % 1 === 0 ? Number(n || 0) : Number(n || 0).toFixed(2)}`;
  const fechaHora = (ts) => (ts ? `${Number(ts.slice(8, 10))} ${mesCorto(ts)} · ${ts.slice(11, 16)}` : '—');

  // Filtros (combinables): estado, medio, período o día exacto.
  const fEstado = ['conf', 'rev'].includes(query.estado) ? query.estado : '';
  const fMedio = MEDIOS[query.medio] ? query.medio : '';
  // Por defecto la vista abre en los ÚLTIMOS 7 DÍAS: la operación es "de hoy
  // en adelante" — abrir con S/ 4,500 históricos y pagos de julio "por revisar"
  // confundía (parecía que todo estaba pendiente de nuevo). "Todo" sigue
  // disponible en el selector para auditar la historia.
  const fPeriodo = ['hoy', '7d', '30d', 'todo'].includes(query.periodo) ? query.periodo : '7d';
  const fDia = /^\d{4}-\d{2}-\d{2}$/.test(query.dia || '') ? query.dia : '';

  // "Alcance": medio + período/día (sin el filtro de estado). Las tarjetas de
  // arriba se calculan sobre el alcance — estilo Power BI: tocas un filtro y
  // TODO (tarjetas y listas) se recalcula sobre ese corte.
  let alcance = todosPagos;
  if (fMedio) alcance = alcance.filter((p) => (p.medio || 'yape') === fMedio);
  if (fDia) {
    // Un día puntual se revisa contra la app de Yape: orden cronológico (como Yape).
    alcance = alcance.filter((p) => (p.creado_en || '').slice(0, 10) === fDia)
      .sort((a, b) => (a.creado_en || '').localeCompare(b.creado_en || '') || a.id - b.id);
  } else if (fPeriodo && fPeriodo !== 'todo') {
    const desde = fPeriodo === 'hoy' ? hoy : fechaLima(fPeriodo === '7d' ? -6 : -29);
    alcance = alcance.filter((p) => (p.creado_en || '').slice(0, 10) >= desde);
  }
  const pagos = fEstado
    ? alcance.filter((p) => (fEstado === 'conf' ? p.estado === 'confirmado' : p.estado === 'revisar'))
    : alcance;
  const hayFiltro = Boolean(fEstado || fMedio || fPeriodo || fDia);

  const qs = (over) => {
    const p = { estado: fEstado, medio: fMedio, periodo: fPeriodo, dia: fDia, ...over };
    return Object.entries(p).filter(([, v]) => v).map(([k, v]) => `&${k}=${encodeURIComponent(v)}`).join('');
  };

  const conf = pagos.filter((p) => p.estado === 'confirmado');
  // "Por revisar" es una COLA DE TRABAJO: solo lo posterior al punto de
  // arranque. Los de julio siguen en la data (y en el filtro de estado), pero
  // no son tareas de hoy.
  const rev = pagos.filter((p) => p.estado === 'revisar' && (fEstado === 'rev' || db.despuesDelCorte(p.creado_en)));
  // Tarjetas: siempre sobre el ALCANCE (reaccionan a medio/período/día).
  const confAlcance = alcance.filter((p) => p.estado === 'confirmado');
  const revAlcance = alcance.filter((p) => p.estado === 'revisar');
  const totalAlcance = confAlcance.reduce((a, p) => a + (p.monto || 0), 0);
  const cuposAlcance = confAlcance.reduce((a, p) => a + (p.cupos || 1), 0);

  // Para los reenvíos: mapa nº de operación → el pago confirmado original,
  // para mostrar la EVIDENCIA (quién/cuándo/cuánto) en vez de un "posible".
  const confirmadoPorOp = {};
  for (const p of todosPagos) {
    if (p.estado === 'confirmado' && p.numero_operacion && !confirmadoPorOp[p.numero_operacion]) {
      confirmadoPorOp[p.numero_operacion] = p;
    }
  }

  const fila = (p) => {
    const m = MEDIOS[p.medio] || MEDIOS.otro;
    const ok = p.estado === 'confirmado';
    const quien = p.nombre || p.titular || `+${p.numero}`;
    const original = !ok && p.numero_operacion ? confirmadoPorOp[p.numero_operacion] : null;
    const evidencia = original && original.id !== p.id
      ? `↩ mismo nº de operación que el pago CONFIRMADO de ${esc(original.nombre || original.titular || `+${original.numero}`)} · ${fechaHora(original.creado_en)} · S/${original.monto}`
      : '';
    const detalles = [
      p.cupos > 1 ? `${p.cupos} cupos` : '',
      p.numero_operacion ? `op. ${esc(p.numero_operacion)}` : 'sin nº de operación',
      fechaHora(p.creado_en),
      ok && p.pagos_contacto > 1 ? `pago #${p.pagos_contacto} del contacto` : '',
    ].filter(Boolean).join(' · ');
    return `<a class="lrow" href="/admin/leads?key=${key}&numero=${p.numero}">
      <div class="pico" style="background:${m.color}">${esc(m.nombre.slice(0, 2).toUpperCase())}</div>
      <div class="lbody">
        <div class="lname">${soles(p.monto)} · ${esc(quien)}</div>
        <div class="lsub">${detalles}</div>
        ${!ok && p.motivo ? `<div class="lsub" style="color:var(--amber-d)">⚠ ${esc(p.motivo)}</div>` : ''}
        ${evidencia ? `<div class="lsub" style="color:var(--amber-d);white-space:normal">${evidencia}</div>` : ''}
      </div>
      <div class="lmeta">
        <span class="badge ${ok ? 'b-done' : 'b-wait'}">${ok ? 'confirmado' : 'por revisar'}</span>
        <span class="ltime">${esc(m.nombre)}</span>
      </div>
    </a>`;
  };

  return baseHtml('Pichangueros — Pagos', `
    <div class="ltitle">
      <div><div class="eyebrow">Pichangueros</div><h2>Pagos</h2></div>
      <span class="live"><i></i> En vivo</span>
    </div>
    <div class="px">
      <div class="grid2">
        <a class="stat green ${fEstado === 'conf' ? 'sel' : ''}" href="/admin/leads?key=${key}&vista=pagos${qs({ estado: 'conf' })}" title="Ver los pagos que suman este monto"><div class="sn">${soles(totalAlcance)}</div><div class="sl">Cobrado${hayFiltro ? ' (filtro)' : ' (confirmado)'} ›</div></a>
        <a class="stat navy" href="/admin/leads?key=${key}&vista=partidos" title="Ver los partidos donde están estos cupos"><div class="sn">${cuposAlcance}</div><div class="sl">Cupos pagados ›</div></a>
        <a class="stat ${fEstado === 'conf' ? 'sel' : ''}" href="/admin/leads?key=${key}&vista=pagos${qs({ estado: fEstado === 'conf' ? '' : 'conf' })}" title="${fEstado === 'conf' ? 'Quitar el filtro' : 'Ver solo los confirmados'}"><div class="sn">${confAlcance.length}</div><div class="sl">Pagos confirmados ${fEstado === 'conf' ? '✕' : '›'}</div></a>
        <a class="stat ${revAlcance.length ? 'amber' : ''} ${fEstado === 'rev' ? 'sel' : ''}" href="/admin/leads?key=${key}&vista=pagos${qs({ estado: fEstado === 'rev' ? '' : 'rev' })}" title="${fEstado === 'rev' ? 'Quitar el filtro' : 'Ver solo los que hay que revisar'}"><div class="sn">${revAlcance.length}</div><div class="sl">Por revisar ${fEstado === 'rev' ? '✕' : '›'}</div></a>
      </div>

      <form class="fbar" method="get" action="/admin/leads">
        <input type="hidden" name="key" value="${key}"><input type="hidden" name="vista" value="pagos">
        <select name="estado" onchange="this.form.submit()">
          <option value="">Estado: todos</option>
          <option value="conf"${fEstado === 'conf' ? ' selected' : ''}>✅ Confirmados</option>
          <option value="rev"${fEstado === 'rev' ? ' selected' : ''}>⚠ Por revisar</option>
        </select>
        <select name="medio" onchange="this.form.submit()">
          <option value="">Medio: todos</option>
          ${Object.entries(MEDIOS).map(([k, m]) => `<option value="${k}"${fMedio === k ? ' selected' : ''}>${m.nombre}</option>`).join('')}
        </select>
        <select name="periodo" onchange="this.form.submit()">
          <option value="hoy"${fPeriodo === 'hoy' ? ' selected' : ''}>Hoy</option>
          <option value="7d"${fPeriodo === '7d' ? ' selected' : ''}>Últimos 7 días</option>
          <option value="30d"${fPeriodo === '30d' ? ' selected' : ''}>Últimos 30 días</option>
          <option value="todo"${fPeriodo === 'todo' ? ' selected' : ''}>Todo el histórico</option>
        </select>
        <input type="date" name="dia" value="${fDia}" max="${hoy}" onchange="this.form.submit()">
      </form>
      ${hayFiltro ? `<div style="padding:6px 2px 0"><a class="fchip" href="/admin/leads?key=${key}&vista=pagos">✕ Limpiar filtros</a></div>` : ''}
      ${rev.length ? `
      <div class="shdr">Por revisar <small>· monto no coincide, comprobante repetido o ilegible — toca para ir a la ficha</small></div>
      <div class="llist">${rev.map(fila).join('')}</div>` : ''}

      <div class="shdr">Confirmados <small>· ${conf.length} pago${conf.length === 1 ? '' : 's'}</small></div>
      ${conf.length ? `<div class="llist">${conf.map(fila).join('')}</div>` : `<div class="vacio">${hayFiltro ? 'Sin pagos confirmados con este filtro.' : 'Todavía no hay pagos confirmados.<br>Cuando un jugador mande su captura de Yape, aparece acá.'}</div>`}

      <div class="foot">La IA lee cada comprobante (monto, remitente, nº de operación y app/banco).<br>Se actualiza solo cada 90 s.</div>
    </div>
  `, { refresh: true, activo: 'pagos', key });
}

// ==============================================================================
//  Vista 2 · CRM (lista de leads)
// ==============================================================================
function paginaCRM(db, key, query) {
  const todos = db.listLeads();
  const roles = db.ultimosRoles();
  const sinResp = (l) => sinResponder(roles, l);
  const hoy = hoyLima();

  const q = (query.q || '').trim().toLowerCase();
  const zona = ZONAS[query.zona] ? query.zona : '';
  const filtro = query.filtro || '';
  const estadoF = Object.keys(ESTADOS).includes(query.estado) || ['pago', 'con_datos'].includes(query.estado) ? query.estado : '';
  const dia = /^\d{4}-\d{2}-\d{2}$/.test(query.dia || '') ? query.dia : '';
  const distritoF = normTexto(query.distrito || '');
  let leads = todos;
  if (q) leads = leads.filter((l) => [l.nombre, l.numero, l.distrito, l.etiquetas].join(' ').toLowerCase().includes(q));
  if (zona) leads = leads.filter((l) => l.zona === zona);
  if (filtro === 'handoff') leads = leads.filter((l) => l.handoff);
  if (filtro === 'responder') leads = leads.filter(sinResp);
  if (filtro === 'hoy') leads = leads.filter((l) => l.proxima_accion && l.proxima_accion <= hoy);
  // Filtro por día: TODOS los que escribieron ese día (no solo los nuevos),
  // distinguibles entre nuevos (se registraron ese día) y recurrentes.
  const tipo = dia && ['nuevos', 'recurrentes'].includes(query.tipo) ? query.tipo : '';
  const esNuevoEse = (l) => (l.creado_en || '').slice(0, 10) === dia;
  if (dia) {
    const activos = new Set(db.actividadPorDia(dia).filter((r) => r.d === dia).map((r) => r.numero));
    leads = leads.filter((l) => activos.has(l.numero) || esNuevoEse(l));
    if (tipo === 'nuevos') leads = leads.filter(esNuevoEse);
    if (tipo === 'recurrentes') leads = leads.filter((l) => !esNuevoEse(l));
  }
  if (distritoF) leads = leads.filter((l) => normTexto(l.distrito) === distritoF);
  if (estadoF === 'pago') {
    const pagaron = new Set(db.numerosPagadores());
    leads = leads.filter((l) => pagaron.has(l.numero));
  } else if (estadoF === 'con_datos') {
    leads = leads.filter((l) => l.estado && l.estado !== 'nuevo');
  } else if (estadoF) {
    leads = leads.filter((l) => l.estado === estadoF);
  }
  const hayFiltro = Boolean(q || zona || filtro || estadoF || dia || distritoF);

  // Distritos existentes (texto libre normalizado) para el selector.
  const ddCrm = {};
  for (const l of todos) {
    const d = (l.distrito || '').trim();
    if (!d) continue;
    const k = normTexto(d);
    if (!ddCrm[k]) ddCrm[k] = { label: d, n: 0 };
    ddCrm[k].n++;
  }
  const distritosCrm = Object.entries(ddCrm).sort((a, b) => b[1].n - a[1].n);

  // Dos grupos: necesitan respuesta (handoff o sin responder) y el resto.
  // Un handoff solo es URGENTE si el contacto sigue activo (habló en 72 h).
  // Los derivados de julio que Clarck ya atendió a mano no son cola de hoy:
  // siguen filtrables con el chip "Clarck" y el bot sigue callado con ellos,
  // pero no infla "Necesitan respuesta" con historia muerta.
  const handoffActivo = (l) => {
    const u = roles[l.numero];
    return Boolean(l.handoff && u && u.en >= limaHace(72) && db.despuesDelCorte(u.en));
  };
  const urgentes = leads.filter((l) => handoffActivo(l) || sinResp(l));
  const resto = leads.filter((l) => !(handoffActivo(l) || sinResp(l)));

  // Los chips COMBINAN filtros (no se pisan); tocar uno activo lo quita.
  const qsCrm = (over) => {
    const p = { q: query.q || '', zona, filtro, estado: estadoF, dia, tipo, distrito: distritoF, ...over };
    return Object.entries(p).filter(([, v]) => v).map(([k, v]) => `&${k}=${encodeURIComponent(v)}`).join('');
  };
  const chip = (campo, valor, label, cls = '') => {
    const actual = { zona, filtro, estado: estadoF }[campo];
    const on = actual === valor;
    return `<a class="fchip ${cls}${on ? ' on' : ''}" href="/admin/leads?key=${key}&vista=crm${qsCrm({ [campo]: on ? '' : valor })}">${label}</a>`;
  };

  const fila = (l) => {
    const sr = sinResp(l);
    const z = ZONAS[l.zona];
    const ultima = db.getHistory(l.numero, 1)[0];
    const sub = l.handoff ? esc(l.handoff_motivo || 'derivado a Clarck')
      : ultima && ultima.rol === 'user' ? `"${esc((ultima.texto || '').slice(0, 40))}"`
      : [l.distrito ? esc(l.distrito) : null, l.edad ? `${l.edad} años` : null].filter(Boolean).join(' · ') || 'sin datos aún';
    const badge = l.handoff ? '<span class="badge b-hand">🔔 Clarck</span>'
      : sr ? '<span class="badge b-wait">sin responder</span>'
      : l.estado === 'lista_espera' ? '<span class="badge b-new">en espera</span>'
      : l.estado && l.estado !== 'nuevo' ? `<span class="badge b-done">${esc(ESTADOS[l.estado] || l.estado)}</span>`
      : z ? `<span class="badge b-zona" style="background:${z.color}">${z.nombre}</span>` : '';
    return `<a class="lrow" href="/admin/leads?key=${key}&numero=${esc(l.numero)}">
      ${(l.handoff || sr) ? '<span class="dotnew" style="background:' + (l.handoff ? 'var(--red)' : 'var(--amber)') + '"></span>' : ''}
      <span class="ava" style="background:${avatarColor(l.numero)}">${esc(iniciales(l.nombre, l.numero))}</span>
      <span class="lbody"><span class="lname">${esc(l.nombre || 'Sin nombre')}</span><span class="lsub">${sub}</span></span>
      <span class="lmeta"><span class="ltime">${horaCorta(l.actualizado_en)}</span>${badge}</span>
      ${SVG.chev}</a>`;
  };

  const grupo = (titulo, arr) => arr.length
    ? `<div class="shdr">${titulo} · ${arr.length}</div><div class="llist">${arr.map(fila).join('')}</div>` : '';

  // Con filtro de día, la agrupación útil es nuevos vs recurrentes de ese día.
  const lista = dia
    ? (leads.length
      ? grupo('🟢 Nuevos ese día', leads.filter(esNuevoEse)) + grupo('🔵 Recurrentes · ya estaban registrados', leads.filter((l) => !esNuevoEse(l)))
      : '<p class="vacio">Nadie escribió ese día ⚽</p>')
    : ((urgentes.length || resto.length)
      ? grupo('Necesitan tu atención ahora', urgentes) + grupo('Todos los contactos', resto)
      : `<p class="vacio">${Object.keys(query).some((k) => ['filtro', 'zona', 'estado', 'distrito', 'q'].includes(k))
          ? 'Ningún pichanguero calza con este filtro ⚽<br><a style="color:var(--green-d);font-weight:600" href="/admin/leads?key=' + key + '&vista=crm">Ver todos</a>'
          : 'Todavía no hay pichangueros registrados ⚽<br>Cuando alguien escriba al número, aparece acá.'}</p>`);

  return baseHtml('Pichangueros — CRM', `
    <div class="ltitle"><div><div class="eyebrow">${hayFiltro ? `${leads.length} de ${todos.length}` : todos.length} contactos</div><h2>CRM</h2></div>
      <div style="display:flex;gap:8px">
        <a class="csv" href="/admin/leads.csv?key=${key}">⬇ CSV</a>
        <a class="csv" href="/admin/leads.xlsx?key=${key}">📊 Excel</a>
      </div></div>
    <div class="px">
      <form class="search" method="get" action="/admin/leads">
        ${SVG.lupa}
        <input type="hidden" name="key" value="${key}"><input type="hidden" name="vista" value="crm">
        <input name="q" value="${esc(query.q || '')}" placeholder="Buscar nombre, número, distrito…">
        ${q ? '<button>Buscar</button>' : ''}
      </form>
      <div class="chips">
        <a class="fchip${!hayFiltro ? ' on' : ''}" href="/admin/leads?key=${key}&vista=crm">Todos</a>
        ${chip('filtro', 'responder', '📥 Sin responder', 'amber')}
        ${chip('filtro', 'handoff', '🔔 Clarck', 'red')}
        ${chip('filtro', 'hoy', '⏰ Para hoy', 'amber')}
        ${chip('zona', 'brena', 'Breña')}
        ${chip('zona', 'comas', 'Comas')}
        ${chip('zona', 'otra', 'Otras')}
      </div>
      <div class="chips" style="padding-top:0">
        ${chip('estado', 'nuevo', 'Nuevos')}
        ${chip('estado', 'datos_completos', 'Con datos')}
        ${chip('estado', 'invitado_grupo', 'En grupo')}
        ${chip('estado', 'lista_espera', 'En espera')}
        ${chip('estado', 'pago', '💰 Pagaron')}
        ${dia ? `<a class="fchip on" href="/admin/leads?key=${key}&vista=crm${qsCrm({ dia: '', tipo: '' })}">📅 ${Number(dia.slice(8))} ${mesCorto(dia)} ✕</a>
        <a class="fchip${tipo === 'nuevos' ? ' on' : ''}" href="/admin/leads?key=${key}&vista=crm${qsCrm({ tipo: tipo === 'nuevos' ? '' : 'nuevos' })}">🟢 Nuevos</a>
        <a class="fchip${tipo === 'recurrentes' ? ' on' : ''}" href="/admin/leads?key=${key}&vista=crm${qsCrm({ tipo: tipo === 'recurrentes' ? '' : 'recurrentes' })}">🔵 Recurrentes</a>` : ''}
        ${distritoF ? `<a class="fchip on" href="/admin/leads?key=${key}&vista=crm${qsCrm({ distrito: '' })}">📍 ${esc(ddCrm[distritoF]?.label || distritoF)} ✕</a>` : ''}
      </div>
      ${distritosCrm.length ? `
      <form class="search" method="get" action="/admin/leads" style="margin-top:4px">
        <input type="hidden" name="key" value="${key}"><input type="hidden" name="vista" value="crm">
        ${zona ? `<input type="hidden" name="zona" value="${zona}">` : ''}
        ${filtro ? `<input type="hidden" name="filtro" value="${filtro}">` : ''}
        ${estadoF ? `<input type="hidden" name="estado" value="${estadoF}">` : ''}
        <select name="distrito" onchange="this.form.submit()" style="flex:1;border:none;background:transparent;outline:none;font:inherit;font-size:14px;padding:10px 0;color:var(--ink)">
          <option value="">📍 Filtrar por distrito…</option>
          ${distritosCrm.map(([k, d]) => `<option value="${esc(k)}"${k === distritoF ? ' selected' : ''}>${esc(d.label)} (${d.n})</option>`).join('')}
        </select>
        <input type="date" name="dia" value="${dia}" max="${hoy}" style="flex:0 0 auto">
        <button>Filtrar</button>
      </form>` : ''}
      ${lista}
      <div class="foot">Se actualiza solo cada 90 s · toca un lead para abrir su ficha</div>
    </div>
  `, { refresh: true, activo: 'crm', key });
}

// ==============================================================================
//  Vista 3 · FICHA (contacto)
// ==============================================================================
function paginaFicha(db, key, numero) {
  const lead = db.getOrCreateLead(numero);
  const msgs = db.getHistory(numero, 200);
  const notas = db.getNotas(numero);
  const pagosLead = db.listPagos(numero);
  // Evidencia de reenvíos: contra qué pago confirmado choca el nº de operación.
  const opsRevisar = pagosLead.filter((p) => p.estado === 'revisar' && p.numero_operacion);
  const originalDe = {};
  for (const p of opsRevisar) {
    const o = db.buscarPagoConfirmado(p.numero_operacion);
    if (o && o.id !== p.id) originalDe[p.id] = o;
  }
  const roles = db.ultimosRoles();
  const keyRaw = decodeURIComponent(key);
  const sinResp = sinResponder(roles, lead);
  const z = ZONAS[lead.zona];

  const botonesEtapa = Object.entries(ESTADOS).map(([v, label]) => `
    <form method="post" action="/admin/lead/estado" style="display:inline">
      <input type="hidden" name="key" value="${esc(keyRaw)}"><input type="hidden" name="numero" value="${esc(numero)}">
      <input type="hidden" name="estado" value="${v}">
      <button class="pstep ${lead.estado === v ? 'on' : ''}">${label}</button>
    </form>`).join('');

  const hayBot = msgs.some((m) => m.rol !== 'user');
  const burbujas = msgs.map((m) => `
    <div class="bub ${m.rol === 'user' ? 'in' : 'out'}">${esc(m.texto)}<time>${horaCorta(m.creado_en)}</time></div>`).join('');
  const chat = msgs.length
    ? burbujas + (!hayBot ? '<div class="noreply">🔒 El bot no respondió · modo seguro</div>' : '')
    : '<p class="vacio">Sin mensajes.</p>';

  const dato = (k, v, color) => `<div class="grow"><span class="k">${k}</span><span class="v"${color ? ` style="color:${color}"` : ''}>${esc(v)}</span></div>`;

  return baseHtml(`Ficha · ${lead.nombre || numero}`, `
    <div class="px">
      <div class="navbar">
        <a class="navback" href="/admin/leads?key=${key}&vista=crm">${SVG.back} CRM</a>
        <a class="wabtn" href="https://wa.me/${esc(numero)}" target="_blank" rel="noopener">${SVG.wa} WhatsApp</a>
      </div>
      <div class="ficha-grid">
        <div class="fcol-left stack">
      <div class="fhead">
        <div class="fava" style="background:${avatarColor(numero)}">${esc(iniciales(lead.nombre, numero))}</div>
        <h2>${esc(lead.nombre || 'Sin nombre')}</h2>
        <div class="fnum">+${esc(numero)}</div>
        <div class="fpills">
          ${z ? `<span class="pz" style="background:${z.color}">${z.nombre}</span>` : ''}
          ${lead.handoff ? `<span class="pz" style="background:var(--red)">🔔 ${esc(lead.handoff_motivo || 'derivado')}</span>` : ''}
          ${sinResp ? '<span class="pz" style="background:var(--amber)">📥 Sin responder</span>' : ''}
        </div>
      </div>

        <div>
          <div class="shdr">Perfil</div>
          <div class="group">
            ${dato('Edad', lead.edad)}
            ${dato('Distrito', lead.distrito)}
            ${dato('Zona', (z && z.nombre) || lead.zona, z && z.color)}
            ${dato('Etapa', ESTADOS[lead.estado] || lead.estado)}
          </div>
        </div>

        ${lead.handoff ? `<form method="post" action="/admin/lead/reactivar">
          <input type="hidden" name="key" value="${esc(keyRaw)}"><input type="hidden" name="numero" value="${esc(numero)}">
          <button class="wabtn btn-rojo" style="width:100%;justify-content:center;border:none;padding:13px;font-size:14px">🔓 Reactivar el bot para este contacto</button>
        </form>` : ''}

        <div>
          <div class="shdr">Etapa</div>
          <div class="group"><div class="pipe">${botonesEtapa}</div></div>
        </div>

        <div>
          <div class="shdr">Etiquetas <small>(separadas por coma)</small></div>
          <div class="group"><form class="inline" method="post" action="/admin/lead/etiquetas">
            <input type="hidden" name="key" value="${esc(keyRaw)}"><input type="hidden" name="numero" value="${esc(numero)}">
            <input name="etiquetas" value="${esc(lead.etiquetas || '')}" placeholder="casero, paga efectivo, VIP…">
            <button>Guardar</button>
          </form></div>
        </div>

        <div>
          <div class="shdr">Próxima acción</div>
          <div class="group"><form class="inline" method="post" action="/admin/lead/seguimiento">
            <input type="hidden" name="key" value="${esc(keyRaw)}"><input type="hidden" name="numero" value="${esc(numero)}">
            <input type="date" name="fecha" value="${esc(lead.proxima_accion || '')}">
            <input name="nota" value="${esc(lead.proxima_nota || '')}" placeholder="ej. avisarle del cupo del viernes">
            <button>Guardar</button>
          </form></div>
        </div>

        ${pagosLead.length ? `<div>
          <div class="shdr">Pagos (Yape)</div>
          <div class="group">
            ${pagosLead.map((p) => `
              <div class="grow" style="align-items:flex-start">
                <span class="k">${p.monto != null ? `S/ ${esc(p.monto)}` : 'Monto ilegible'}${p.titular ? ` · ${esc(p.titular)}` : ''}<br>
                  <small style="color:var(--faint)">${esc((p.creado_en || '').slice(0, 16))}${p.numero_operacion ? ` · op. ${esc(p.numero_operacion)}` : ''}</small>
                  ${p.estado === 'revisar' && p.motivo ? `<br><small style="color:var(--red)">⚠ ${esc(p.motivo)}</small>` : ''}
                  ${originalDe[p.id] ? `<br><small style="color:var(--red)">↩ mismo nº de operación que el pago CONFIRMADO de <a href="/admin/leads?key=${key}&numero=${esc(originalDe[p.id].numero)}" style="text-decoration:underline">+${esc(originalDe[p.id].numero)}</a> · ${esc((originalDe[p.id].creado_en || '').slice(0, 16))} · S/${esc(originalDe[p.id].monto)}</small>` : ''}
                </span>
                <span class="v" style="color:${p.estado === 'confirmado' ? 'var(--green-d)' : 'var(--red)'}">${p.estado === 'confirmado' ? '✅ Confirmado' : '⚠ Revisar'}</span>
              </div>`).join('')}
          </div>
        </div>` : ''}

        <div>
          <div class="shdr">Notas</div>
          <div class="group">
            <form class="inline" method="post" action="/admin/lead/nota">
              <input type="hidden" name="key" value="${esc(keyRaw)}"><input type="hidden" name="numero" value="${esc(numero)}">
              <input name="texto" placeholder="ej. vino con 3 amigos, buen arquero…">
              <button>+ Nota</button>
            </form>
            <div class="notas-list">${notas.map((n) => `<p>${esc(n.texto)}<time>${esc((n.creado_en || '').slice(0, 16))}</time></p>`).join('') || '<p style="border:none;color:var(--faint)">Sin notas.</p>'}</div>
          </div>
        </div>

        <form method="post" action="/admin/lead/eliminar" onsubmit="return confirm('¿Eliminar este contacto y todo su historial? No se puede deshacer.')">
          <input type="hidden" name="key" value="${esc(keyRaw)}"><input type="hidden" name="numero" value="${esc(numero)}">
          <button style="width:100%;background:none;border:1px dashed var(--red);color:var(--red);border-radius:11px;padding:10px;font:inherit;font-size:13px">🗑 Eliminar contacto (prueba/spam)</button>
        </form>

        </div>
        <div class="fcol-right">
          <div class="shdr">Conversación</div>
          <div class="chat">${chat}</div>
        </div>
      </div>
      <div class="foot">⚽ Pichangueros CRM</div>
    </div>
  `, { refresh: false, activo: 'crm', key, tabbarMobile: false });
}

// ==============================================================================
//  Config — sedes, precios y textos del negocio (editable, sin tocar código)
// ==============================================================================
function paginaConfig(db, key) {
  const keyRaw = decodeURIComponent(key);
  const c = db.getConfigMap();
  // Zonas dinámicas: las mismas que ve el bot (siguen a las sedes).
  const zonasOp = db.zonasOperativas();
  const sedesPorZona = Object.fromEntries(zonasOp.map((z) => [z, db.listSedes(z)]));

  const filaSede = (zona, s) => `
    <form class="inline" method="post" action="/admin/config/sede">
      <input type="hidden" name="key" value="${esc(keyRaw)}">
      <input type="hidden" name="zona" value="${esc(zona)}">
      ${s ? `<input type="hidden" name="id" value="${s.id}">` : ''}
      <input name="nombre" value="${esc(s?.nombre || '')}" placeholder="Nombre de la sede" required>
      <input name="cancha" value="${esc(s?.cancha || '')}" placeholder="Cancha (opcional)">
      <input name="cupo" type="number" min="1" value="${esc(s?.cupo ?? '')}" placeholder="Cupo" style="max-width:90px">
      <input name="ubicacion" value="${esc(s?.ubicacion || '')}" placeholder="Link de ubicación">
      <input name="horario" value="${esc(s?.horario || '')}" placeholder="Horario">
      <input name="estacionamiento" value="${esc(s?.estacionamiento || '')}" placeholder="Estacionamiento (opcional)">
      <button>${s ? 'Guardar' : '+ Agregar sede'}</button>
    </form>
    ${s ? `<form method="post" action="/admin/config/sede/eliminar" style="padding:0 14px 12px">
      <input type="hidden" name="key" value="${esc(keyRaw)}"><input type="hidden" name="id" value="${s.id}">
      <button class="btn-rojo" style="border:none;border-radius:11px;color:#fff;padding:8px 14px;font:inherit;font-size:13px" onclick="return confirm('¿Eliminar esta sede?')">Eliminar</button>
    </form>` : ''}`;

  // Una TARJETA por distrito: precio + grupo + nombre + sus sedes, todo junto.
  const bloqueZona = (zona) => `
    <div class="shdr">📍 ${esc(db.nombreDeZona(zona))} <small>· precio, grupo y sedes de este distrito</small></div>
    <div class="group" style="border-left:6px solid ${colorZona(zona)}">
      <form class="inline" method="post" action="/admin/config/zona">
        <input type="hidden" name="key" value="${esc(keyRaw)}"><input type="hidden" name="zona" value="${esc(zona)}">
        <label>Precio por jugador (S/)</label>
        <input name="precio" type="number" step="0.5" value="${esc(c[`precio_${zona}`] || '')}" style="max-width:110px">
        <label>Link del grupo de WhatsApp <small>(el bot lo entrega a los que se unen)</small></label>
        <input name="grouplink" value="${esc(c[`grouplink_${zona}`] || '')}" placeholder="https://chat.whatsapp.com/…">
        <label>Nombre para mostrar</label>
        <input name="nombre_mostrar" value="${esc(db.nombreDeZona(zona))}" style="max-width:200px">
        <button>Guardar ${esc(db.nombreDeZona(zona))}</button>
      </form>
      ${sedesPorZona[zona].map((s) => filaSede(zona, s)).join('') || '<p style="padding:0 14px 10px;color:var(--faint);font-size:14px">Sin sedes todavía.</p>'}
      ${filaSede(zona, null)}
    </div>`;

  const corteActual = db.getCorte();
  const bloqueCorte = `
    <div class="shdr">🚦 Punto de arranque <small>· desde cuándo cuentan las colas de trabajo</small></div>
    <div class="group">
      <form class="inline" method="post" action="/admin/config/corte">
        <input type="hidden" name="key" value="${esc(keyRaw)}">
        <p style="flex-basis:100%;font-size:13.5px;color:var(--muted);line-height:1.45;margin-bottom:4px">
          Los pagos y las derivaciones <b>anteriores</b> a esta fecha quedan como historial: la plata se sigue
          sumando y las conversaciones siguen ahí, pero <b>no aparecen como pendientes</b> (esos partidos ya se
          jugaron y esas derivaciones ya las atendiste). <b>No se borra nada.</b>
        </p>
        <label>Cuenta desde</label>
        <input name="fecha" type="date" value="${esc(corteActual || hoyLima())}" max="${hoyLima()}">
        <button>🚦 Empezar en limpio desde esta fecha</button>
        <p style="flex-basis:100%;font-size:12.5px;color:var(--faint);margin-top:2px">
          ${corteActual ? `Actualmente el sistema cuenta desde el <b>${esc(corteActual)}</b>.` : 'Todavía no hay punto de arranque: las colas incluyen toda la historia.'}
        </p>
      </form>
    </div>`;

  const nuevoDistrito = `
    <div class="shdr">➕ Nuevo distrito <small>· al crearlo aparece en el bot, los partidos y esta página</small></div>
    <div class="group" style="border:2.5px dashed var(--trazo);box-shadow:none">
      <form class="inline" method="post" action="/admin/config/zona/nueva">
        <input type="hidden" name="key" value="${esc(keyRaw)}">
        <label>Nombre del distrito</label>
        <input name="nombre" placeholder="Ej. Miraflores" required style="max-width:220px">
        <label>Precio (S/)</label>
        <input name="precio" type="number" step="0.5" value="15" style="max-width:100px">
        <label>Primera cancha <small>(puedes editarla después)</small></label>
        <input name="sede" placeholder="Nombre de la sede">
        <input name="cupo" type="number" min="2" max="60" value="14" style="max-width:84px" title="Cupo">
        <button>➕ Crear distrito</button>
      </form>
    </div>`;

  return baseHtml('Config · Pichangueros', `
    <div class="px">
      <div class="ltitle"><div><div class="eyebrow">Ajustes</div><h2>Configuración</h2></div></div>

      <div class="shdr">General <small>(no requiere redesplegar)</small></div>
      <div class="group">
        <form class="inline" method="post" action="/admin/config/general">
          <input type="hidden" name="key" value="${esc(keyRaw)}">
          <label>Marca</label>
          <input name="marca" value="${esc(c.marca)}">
          <label>Yape — número</label>
          <input name="yape_numero" value="${esc(c.yape_numero)}">
          <label>Yape — titular</label>
          <input name="yape_titular" value="${esc(c.yape_titular)}">
          <label>Regla de llegada <small>(relativa, vale para todo horario y sede — ej. "15 minutos antes del inicio de tu turno". Si una cancha necesita algo especial, ponlo en el horario de esa sede)</small></label>
          <input name="hora_llegada" value="${esc(c.hora_llegada)}">
          <label>Emojis de la casa <small>(separados por coma)</small></label>
          <input name="emojis" value="${esc(c.emojis)}">
          <label>Política de pago</label>
          <textarea name="pago">${esc(c.pago)}</textarea>
          <label>Política de devoluciones</label>
          <textarea name="devoluciones">${esc(c.devoluciones)}</textarea>
          <label>Reglas de convivencia</label>
          <textarea name="convivencia">${esc(c.convivencia)}</textarea>
          <label>Mecánica para jugar <small>(el bot la manda tal cual)</small></label>
          <textarea name="mecanica" style="min-height:110px">${esc(c.mecanica)}</textarea>
          <label>Mensaje de bienvenida <small>(el bot lo manda tal cual)</small></label>
          <textarea name="bienvenida" style="min-height:110px">${esc(c.bienvenida)}</textarea>
          <button>Guardar cambios generales</button>
        </form>
      </div>

      ${bloqueCorte}
      ${zonasOp.map((z) => bloqueZona(z)).join('')}
      ${nuevoDistrito}

      <div class="foot">⚽ Pichangueros · Config</div>
    </div>
  `, { refresh: false, activo: 'config', key });
}

// ==============================================================================
//  Vista PARTIDOS — convocatorias, inscripciones, lista de espera, asistencia
// ==============================================================================
const ESTADOS_PARTIDO = { abierto: 'Abierto', cerrado: 'Cerrado', jugado: 'Jugado ✅', cancelado: 'Cancelado' };
const ESTADOS_INSC = { pagado: 'Pagado ✅', reservado: 'Reservado', espera: 'En espera ⏳', baja: 'Baja' };

function paginaPartidos(db, key, query = {}) {
  const keyRaw = decodeURIComponent(key);
  const partidoId = Number(query.partido) || null;
  if (partidoId) return paginaPartidoDetalle(db, key, keyRaw, partidoId);

  const partidos = db.listPartidos();
  const neg = db.getNegocio();
  const hoy = hoyLima();

  const fila = (p) => {
    const z = ZONAS[p.zona];
    const pasado = p.fecha < hoy;
    return `<a class="lrow" href="/admin/leads?key=${key}&vista=partidos&partido=${p.id}" style="display:flex;align-items:center;gap:12px;padding:13px 14px;border-bottom:1px solid var(--sep)">
      <div style="min-width:52px;text-align:center">
        <div style="font-family:'Big Shoulders',sans-serif;font-weight:800;font-size:22px;line-height:1">${esc(p.fecha.slice(8, 10))}</div>
        <div style="font-size:11px;color:var(--faint)">${esc(p.fecha.slice(5, 7))}/${esc(p.fecha.slice(2, 4))}</div>
      </div>
      <div style="flex:1;min-width:0">
        <div style="font-weight:700;font-size:15px">${z ? z.nombre : esc(p.zona)}${p.hora ? ` · ${esc(p.hora)}` : ''}</div>
        <div style="font-size:12.5px;color:var(--muted)">${esc(p.sede || 'Sede por definir')} · S/ ${esc(p.precio ?? neg.zonas[p.zona]?.precio ?? '?')}</div>
      </div>
      <div style="text-align:right">
        <div style="font-weight:800;font-size:15px;color:${p.ocupados >= p.cupo ? 'var(--amber-d)' : 'var(--green-d)'}">${p.ocupados}/${p.cupo}</div>
        <div style="font-size:11px;color:var(--faint)">${p.pagados} pagados${p.en_espera ? ` · ${p.en_espera} espera` : ''}</div>
      </div>
      <span class="badge ${p.estado === 'abierto' && !pasado ? 'b-zona' : 'b-new'}" style="${p.estado === 'abierto' && !pasado ? 'background:var(--green)' : ''}">${esc(ESTADOS_PARTIDO[p.estado] || p.estado)}</span>
      ${SVG.chev}
    </a>`;
  };

  return baseHtml('Partidos · Pichangueros', `
    <div class="px">
      <div class="ltitle"><div><div class="eyebrow">Convocatorias</div><h2>Partidos</h2></div></div>

      <div class="shdr">Abrir partido nuevo <small>· 3 toques: zona, día y listo</small></div>
      <style>
        .zbtn{flex:1;text-align:center;padding:11px;border:2px solid var(--trazo);border-radius:12px;background:#fff;
          font-family:'Big Shoulders',sans-serif;font-style:italic;font-weight:800;font-size:16px;letter-spacing:.06em;
          text-transform:uppercase;color:var(--muted);cursor:pointer}
        .zbtn:has(input:checked){background:var(--navy);color:#fff;box-shadow:2px 2px 0 rgba(46,58,69,.25)}
        .zbtn input{display:none}
        .qd{padding:10px 14px;border:2px solid var(--trazo);border-radius:12px;background:#fff;font:inherit;font-weight:700;font-size:13px;cursor:pointer}
        .qd.on{background:var(--lime);color:var(--navy)}
      </style>
      <div class="group">
        <form class="inline" method="post" action="/admin/partido">
          <input type="hidden" name="key" value="${esc(keyRaw)}">
          <label>¿Dónde?</label>
          <div style="display:flex;gap:8px;flex-basis:100%;flex-wrap:wrap">
            ${db.zonasOperativas().map((z, i) => `<label class="zbtn"><input type="radio" name="zona" value="${esc(z)}" ${i === 0 ? 'checked' : ''} onchange="pintaSedes('${esc(z)}')">${esc(db.nombreDeZona(z))}</label>`).join('')}
          </div>
          <select name="sede" id="selSede" onchange="cupoDeSede()" style="flex-basis:100%;font:inherit;font-size:14px;padding:10px 12px;border-radius:11px;border:1px solid var(--sep);background:var(--inset)"></select>
          <label>¿Cuándo?</label>
          <div style="display:flex;gap:8px;flex-basis:100%;align-items:center">
            <button type="button" class="qd on" onclick="setDia(this,'${hoy}')">Hoy</button>
            <button type="button" class="qd" onclick="setDia(this,'${fechaLima(1)}')">Mañana</button>
            <input name="fecha" id="fFecha" type="date" required min="${hoy}" value="${hoy}" style="flex:1;min-width:130px">
          </div>
          <label>Hora, cupo y precio</label>
          <input name="hora" placeholder="Hora (ej. 8-9pm)" style="flex:2">
          <input name="cupo" id="fCupo" type="number" min="2" max="60" value="14" style="max-width:84px" title="Cupo (se llena solo al elegir cancha)">
          <input name="precio" type="number" step="0.5" placeholder="S/ auto" style="max-width:100px" title="Vacío = precio de la zona">
          <button style="flex-basis:100%">⚽ Abrir partido — el bot empieza a llenarlo</button>
        </form>
      </div>
      <script>
        const SEDES = ${JSON.stringify(Object.fromEntries(
          db.zonasOperativas().map((z) => [z, db.listSedes(z).map((s) => ({ n: s.nombre, c: s.cupo || 14 }))])
        )).replace(/</g, '\\u003c')};
        function pintaSedes(z){
          const sel = document.getElementById('selSede');
          sel.innerHTML = (SEDES[z] || []).map(s => '<option value="' + s.n.replace(/"/g,'&quot;') + '" data-cupo="' + s.c + '">🏟 ' + s.n + ' (cupo ' + s.c + ')</option>').join('')
            + '<option value="" data-cupo="14">Otra cancha / por definir</option>';
          cupoDeSede();
        }
        function cupoDeSede(){
          const sel = document.getElementById('selSede');
          const c = sel.selectedOptions[0] && sel.selectedOptions[0].dataset.cupo;
          if (c) document.getElementById('fCupo').value = c;
        }
        function setDia(btn, d){
          document.getElementById('fFecha').value = d;
          document.querySelectorAll('.qd').forEach(b => b.classList.toggle('on', b === btn));
        }
        document.getElementById('fFecha').addEventListener('input', () =>
          document.querySelectorAll('.qd').forEach(b => b.classList.remove('on')));
        pintaSedes('brena');
      </script>

      <div class="shdr">Todos los partidos</div>
      <div class="group">
        ${partidos.map(fila).join('') || '<p style="padding:14px;color:var(--faint);font-size:14px">Sin partidos todavía. Abre el primero arriba — el bot lo ofrece automáticamente a quien pida jugar.</p>'}
      </div>

      <div class="foot">⚽ Pichangueros · Partidos</div>
    </div>
  `, { refresh: false, activo: 'partidos', key });
}

function paginaPartidoDetalle(db, key, keyRaw, partidoId) {
  const p = db.getPartido(partidoId);
  if (!p) return baseHtml('Partido · Pichangueros', `<div class="px"><p style="padding:20px">Partido no encontrado. <a href="/admin/leads?key=${key}&vista=partidos">Volver</a></p></div>`, { activo: 'partidos', key });

  const neg = db.getNegocio();
  const z = ZONAS[p.zona];
  const inscripciones = db.inscripcionesDe(partidoId);
  const activas = inscripciones.filter((i) => i.estado !== 'baja');
  const ocupados = inscripciones.filter((i) => ['pagado', 'reservado'].includes(i.estado)).length;
  const lista = db.textoLista(partidoId);
  const pagosSueltos = db.pagosSinPartido();

  const accion = (i, estado, etiqueta, estilo = '') => `
    <form method="post" action="/admin/inscripcion/estado" style="display:inline">
      <input type="hidden" name="key" value="${esc(keyRaw)}"><input type="hidden" name="id" value="${i.id}"><input type="hidden" name="partido_id" value="${partidoId}"><input type="hidden" name="estado" value="${estado}">
      <button style="border:none;border-radius:9px;padding:6px 10px;font:inherit;font-size:12px;font-weight:600;cursor:pointer;${estilo}">${etiqueta}</button>
    </form>`;
  const btnAsist = (i, valor, etiqueta, on) => `
    <form method="post" action="/admin/inscripcion/asistencia" style="display:inline">
      <input type="hidden" name="key" value="${esc(keyRaw)}"><input type="hidden" name="id" value="${i.id}"><input type="hidden" name="partido_id" value="${partidoId}"><input type="hidden" name="valor" value="${i.asistencia === valor ? '' : valor}">
      <button style="border:none;border-radius:9px;padding:6px 10px;font:inherit;font-size:12px;font-weight:700;cursor:pointer;background:${on ? (valor === 'si' ? 'var(--green)' : 'var(--red)') : 'var(--inset)'};color:${on ? '#fff' : 'var(--muted)'}">${etiqueta}</button>
    </form>`;

  const filaInsc = (i) => {
    const nombre = i.nombre || i.lead_nombre || (i.numero ? `+${i.numero}` : '¿?');
    return `<div style="display:flex;align-items:center;gap:10px;padding:11px 14px;border-bottom:1px solid var(--sep);flex-wrap:wrap">
      <div style="flex:1;min-width:140px">
        <div style="font-weight:700;font-size:14.5px">${i.numero ? `<a href="/admin/leads?key=${key}&numero=${i.numero}">${esc(nombre)}</a>` : esc(nombre)}</div>
        <div style="font-size:12px;color:var(--faint)">${esc(ESTADOS_INSC[i.estado] || i.estado)}${i.pago_id ? ` · pago #${i.pago_id}` : ''}</div>
      </div>
      ${i.estado !== 'baja' ? `
        ${i.estado !== 'pagado' ? accion(i, 'pagado', '💰 Pagó', 'background:rgba(163,198,20,.14);color:var(--green-d)') : ''}
        ${i.estado === 'espera' ? accion(i, 'reservado', '⬆ Subir', 'background:var(--inset);color:var(--muted)') : ''}
        ${p.estado === 'jugado' || p.fecha <= hoyLima() ? `${btnAsist(i, 'si', '✔ Vino', i.asistencia === 'si')}${btnAsist(i, 'no', '✘ Faltó', i.asistencia === 'no')}` : ''}
        ${accion(i, 'baja', '🗑 Baja', 'background:rgba(255,59,48,.12);color:var(--red)')}` : ''}
    </div>`;
  };

  const cambioEstado = (estado, etiqueta, clase) => `
    <form method="post" action="/admin/partido/estado" style="display:inline">
      <input type="hidden" name="key" value="${esc(keyRaw)}"><input type="hidden" name="id" value="${partidoId}"><input type="hidden" name="estado" value="${estado}">
      <button style="border:none;border-radius:11px;padding:9px 14px;font:inherit;font-size:13px;font-weight:700;cursor:pointer;${clase}">${etiqueta}</button>
    </form>`;

  return baseHtml(`Partido ${p.fecha} · Pichangueros`, `
    <div class="px">
      <div class="ltitle">
        <div>
          <div class="eyebrow"><a href="/admin/leads?key=${key}&vista=partidos" style="color:inherit">← Partidos</a></div>
          <h2>${z ? z.nombre : esc(p.zona)} · ${esc(db.fechaBonita(p.fecha))}${p.hora ? ` · ${esc(p.hora)}` : ''}</h2>
        </div>
        <span class="badge b-zona" style="background:${p.estado === 'abierto' ? 'var(--green)' : 'var(--faint)'}">${esc(ESTADOS_PARTIDO[p.estado] || p.estado)}</span>
      </div>
      <p style="color:var(--muted);font-size:13.5px;margin:-6px 0 14px">${esc(p.sede || 'Sede por definir')} · S/ ${esc(p.precio ?? neg.zonas[p.zona]?.precio ?? '?')} · <b style="color:${ocupados >= p.cupo ? 'var(--amber-d)' : 'var(--green-d)'}">${ocupados}/${p.cupo} cupos</b></p>

      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px">
        ${p.estado === 'abierto' ? cambioEstado('cerrado', '🔒 Cerrar inscripción', 'background:var(--inset);color:var(--muted)') : cambioEstado('abierto', '🔓 Reabrir', 'background:rgba(163,198,20,.14);color:var(--green-d)')}
        ${p.estado !== 'jugado' ? cambioEstado('jugado', '✅ Marcar jugado', 'background:rgba(163,198,20,.14);color:var(--green-d)') : ''}
        ${p.estado !== 'cancelado' ? cambioEstado('cancelado', '✖ Cancelar', 'background:rgba(255,59,48,.12);color:var(--red)') : ''}
      </div>

      <div class="shdr">Inscritos (${activas.length})</div>
      <div class="group">
        ${activas.map(filaInsc).join('') || '<p style="padding:14px;color:var(--faint);font-size:14px">Nadie inscrito aún.</p>'}
        <form class="inline" method="post" action="/admin/partido/inscribir" style="padding-top:10px">
          <input type="hidden" name="key" value="${esc(keyRaw)}"><input type="hidden" name="partido_id" value="${partidoId}">
          <input name="numero" placeholder="Número WhatsApp (o vacío)" style="max-width:200px">
          <input name="nombre" placeholder="Nombre (para invitados)" style="max-width:200px">
          <button>+ Inscribir a mano</button>
        </form>
      </div>

      ${pagosSueltos.length ? `
      <div class="shdr">Pagos confirmados sin partido <small>(asignar a este partido)</small></div>
      <div class="group">
        ${pagosSueltos.map((pg) => `
          <form method="post" action="/admin/pago/asignar" style="display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--sep)">
            <input type="hidden" name="key" value="${esc(keyRaw)}"><input type="hidden" name="pago_id" value="${pg.id}"><input type="hidden" name="partido_id" value="${partidoId}">
            <div style="flex:1;font-size:13.5px"><b>${esc(pg.nombre || `+${pg.numero}`)}</b> · S/ ${esc(pg.monto)} ${pg.cupos > 1 ? `(${pg.cupos} cupos)` : ''} · ${horaCorta(pg.creado_en)}</div>
            <button style="border:none;border-radius:9px;padding:7px 12px;font:inherit;font-size:12.5px;font-weight:700;cursor:pointer;background:rgba(163,198,20,.14);color:var(--green-d)">Asignar acá</button>
          </form>`).join('')}
      </div>` : ''}

      <div class="shdr">Lista para el grupo <small>(el bot la arma, tú la pegas)</small></div>
      <div class="group" style="padding:14px">
        <textarea id="lista" readonly style="width:100%;min-height:${Math.min(420, 90 + (p.cupo + 4) * 21)}px;font:13px/1.6 ui-monospace,monospace;border:1px solid var(--sep);border-radius:11px;padding:12px;background:var(--inset);resize:vertical">${esc(lista)}</textarea>
        <button onclick="navigator.clipboard.writeText(document.getElementById('lista').value).then(()=>{this.textContent='✅ Copiada'; setTimeout(()=>this.textContent='📋 Copiar lista',1500)})"
          style="margin-top:10px;width:100%;border:none;border-radius:12px;padding:13px;font:inherit;font-weight:700;font-size:14px;cursor:pointer;background:var(--green);color:#fff">📋 Copiar lista</button>
      </div>

      <div class="foot">⚽ Pichangueros · Partido #${partidoId}</div>
    </div>
  `, { refresh: false, activo: 'partidos', key });
}

// ==============================================================================
//  Conexión — estado de WhatsApp, número enlazado, QR en vivo, desconectar
// ==============================================================================
function paginaConexion(key, conexion) {
  const keyRaw = decodeURIComponent(key);
  const estado = conexion ? conexion.estado() : 'desconocido';
  const numero = conexion ? conexion.numero() : null;
  const qr = conexion ? conexion.qr() : null;
  const conectado = estado === 'ready';

  // Refresco automático: rápido mientras se muestra el QR (cambia cada ~20s),
  // lento cuando ya está conectado (solo para reflejar cambios de estado).
  const refresh = conectado ? 30 : 6;

  const cuerpo = conectado
    ? `<div class="group" style="text-align:center;padding:26px 20px">
         <div style="font-size:40px;line-height:1">✅</div>
         <div style="font-size:19px;font-weight:800;margin-top:8px">Conectado a WhatsApp</div>
         <div style="font-size:15px;color:var(--muted);margin-top:4px">Número enlazado</div>
         <div style="font-size:26px;font-weight:800;font-family:'Big Shoulders',sans-serif;letter-spacing:.02em;margin-top:2px">
           ${numero ? `+${esc(numero)}` : 'no disponible'}</div>
       </div>
       <div class="shdr">Cambiar de número / desconectar</div>
       <div class="group" style="padding:16px">
         <p style="font-size:13.5px;color:var(--muted);line-height:1.45;margin-bottom:14px">
           Al desconectar, el bot cierra la sesión actual y muestra un código QR nuevo acá mismo.
           Para enlazar OTRO número, desconecta y escanea el nuevo QR desde ese WhatsApp
           (Ajustes → Dispositivos vinculados → Vincular dispositivo). Mientras tanto el bot no
           responde a nadie.</p>
         <form method="post" action="/admin/conexion/desconectar"
               onsubmit="return confirm('¿Desconectar el bot de WhatsApp? Dejará de responder hasta que escanees un QR nuevo.')">
           <input type="hidden" name="key" value="${esc(keyRaw)}">
           <button class="btn-rojo" style="width:100%;border:none;border-radius:12px;color:#fff;padding:13px;font:inherit;font-weight:700;font-size:14px">
             🔌 Desconectar / cambiar número</button>
         </form>
       </div>`
    : `<div class="banner px" style="margin:0 0 14px"><div class="bic">📴</div>
         <div class="btxt"><b>El bot no está conectado.</b> ${estado === 'qr' || qr ? 'Escanea el código de abajo para enlazar un número.' : 'Reconectando… en unos segundos aparecerá el código QR.'}</div></div>
       <div class="group" style="text-align:center;padding:22px 20px">
         ${qr
           ? `<img src="${qr}" alt="Código QR de WhatsApp" style="width:280px;max-width:82vw;height:auto;border-radius:12px"/>
              <div style="font-size:13.5px;color:var(--muted);margin-top:12px;line-height:1.45">
                Desde el WhatsApp que quieres enlazar:<br><b>Ajustes → Dispositivos vinculados → Vincular dispositivo</b><br>
                y apunta la cámara a este código.</div>`
           : `<div style="font-size:34px">⏳</div>
              <div style="font-size:15px;color:var(--muted);margin-top:8px">Generando código QR… esta página se actualiza sola.</div>`}
       </div>`;

  return baseHtml('Conexión · Pichangueros', `
    <div class="px">
      <div class="ltitle"><div><div class="eyebrow">WhatsApp</div><h2>Conexión</h2></div>
        <span class="live" style="${conectado ? '' : 'background:rgba(255,149,0,.14);color:var(--amber-d)'}">
          <i style="${conectado ? '' : 'background:var(--amber)'}"></i> ${conectado ? 'En vivo' : esc(estado)}</span></div>
      ${cuerpo}
      <div class="foot">⚽ Pichangueros · Conexión${conexion ? '' : ' (no disponible)'}</div>
    </div>
  `, { refresh, activo: 'conexion', key });
}

module.exports = { registrarPanel, paginaResumen, paginaCRM, paginaFicha, paginaConfig, paginaConexion };
