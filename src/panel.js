/**
 * Panel CRM (Semana 3 · rediseño iOS 2026-06-29) — "del marcador a la cancha".
 *
 * Tres vistas, estética iOS (claro, Inter + Barlow Condensed, acento verde
 * #34C759 = verde de sistema y de cancha):
 *   Resumen → dashboard de data (marcador-estadio, métricas, crecimiento, zonas)
 *   CRM     → lista de leads con la cola "sin responder" al frente
 *   Ficha   → perfil + pipeline + etiquetas + seguimiento + notas + chat
 *
 * Rutas (todas con ?key=ADMIN_KEY; sin key → 404):
 *   GET  /admin/leads                  → Resumen (dashboard)
 *   GET  /admin/leads?vista=crm        → lista CRM (con filtros/búsqueda)
 *   GET  /admin/leads?numero=N         → ficha de contacto
 *   GET  /admin/leads.csv              → export CSV
 *   POST /admin/lead/estado            → cambia etapa del pipeline (1 toque)
 *   POST /admin/lead/reactivar         → saca del handoff (el bot vuelve a atender)
 *   POST /admin/lead/etiquetas         → guarda etiquetas (separadas por coma)
 *   POST /admin/lead/seguimiento       → fecha + nota de próxima acción
 *   POST /admin/lead/nota              → agrega una nota al historial
 */
const sheetsync = require('./sheetsync');

const esc = (v) =>
  String(v ?? '—').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const ZONAS = {
  brena: { nombre: 'Breña', color: '#34c759' },
  comas: { nombre: 'Comas', color: '#007aff' },
  otra: { nombre: 'Otra zona', color: '#64748b' },
};

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
  'linear-gradient(135deg,#34c759,#27a64a)', 'linear-gradient(135deg,#5ac8fa,#007aff)',
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
const fechaLima = (offsetDias = 0) => new Date(Date.now() - 5 * 3600e3 + offsetDias * MS_DIA).toISOString().slice(0, 10);
const hoyLima = () => fechaLima(0);
const horaCorta = (ts) => esc((ts || '').slice(5, 16)); // MM-DD HH:MM

function registrarPanel(app, db) {
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
      zona: req.body.zona === 'comas' ? 'comas' : 'brena',
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

  // --- Vistas ----------------------------------------------------------------------
  app.get('/admin/leads', (req, res) => {
    if (!autorizado(req, res)) return;
    const key = encodeURIComponent(req.query.key);
    const numero = (req.query.numero || '').replace(/\D/g, '');
    if (numero) return res.send(paginaFicha(db, key, numero));
    if (req.query.vista === 'crm') return res.send(paginaCRM(db, key, req.query));
    if (req.query.vista === 'config') return res.send(paginaConfig(db, key));
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
${refresh ? '<meta http-equiv="refresh" content="90">' : ''}
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@700;800&family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
  :root{
    --bg:#eef1ef; --card:#fff; --ink:#0b1b12; --muted:#6b7c72; --faint:#9aa7a0;
    --sep:#e7eae8; --inset:#f4f6f5;
    --green:#34c759; --green-d:#27a64a; --navy:#142847; --navy2:#1c3661;
    --amber:#ff9500; --amber-d:#c26f00; --red:#ff3b30; --blue:#007aff; --lime:#8fc12c;
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
  .ltitle h2{font-size:30px;font-weight:800;letter-spacing:-.02em;line-height:1}
  .live{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:600;color:var(--green-d);
    background:rgba(52,199,89,.12);padding:5px 11px;border-radius:999px;white-space:nowrap}
  .live i{width:7px;height:7px;border-radius:50%;background:var(--green);animation:pulse 2s infinite}
  @keyframes pulse{0%{box-shadow:0 0 0 0 rgba(52,199,89,.5)}70%{box-shadow:0 0 0 7px rgba(52,199,89,0)}100%{box-shadow:0 0 0 0 rgba(52,199,89,0)}}
  .csv{font-size:13px;color:var(--muted);border:1px solid var(--sep);background:var(--card);padding:6px 12px;border-radius:999px;white-space:nowrap}

  /* scoreboard hero */
  .marcador{background:linear-gradient(160deg,#1c3661,#102744);border-radius:24px;padding:18px 20px 16px;
    color:#fff;position:relative;overflow:hidden;box-shadow:0 14px 30px -16px rgba(16,39,68,.7);margin:2px 0 0}
  .marcador::before{content:"";position:absolute;inset:0;
    background:repeating-linear-gradient(90deg,transparent 0 30px,rgba(255,255,255,.025) 30px 60px)}
  .marcador>*{position:relative}
  .mtop{display:flex;justify-content:space-between;align-items:center}
  .mlabel{font-size:11px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:#9fb6d6}
  .mdelta{font-size:12px;font-weight:700;color:#5fe487;background:rgba(52,199,89,.14);padding:4px 10px;border-radius:999px}
  .mnum{font-family:'Barlow Condensed',sans-serif;font-weight:800;font-size:62px;line-height:.92;color:#fff;margin-top:2px}
  .bars{display:flex;align-items:flex-end;gap:3px;height:62px;margin-top:10px}
  .bar{flex:1;display:flex;flex-direction:column;align-items:center;gap:3px;height:100%}
  .bar .bn{font-size:9px;font-weight:700;color:#a9c2e6;line-height:1;min-height:10px}
  .bar .track{flex:1;width:100%;display:flex;align-items:flex-end}
  .bar .track i{width:100%;background:linear-gradient(180deg,#5fe487,#34c759);border-radius:3px 3px 1px 1px;min-height:3px;display:block;opacity:.95}
  .bar.hot .track i{background:linear-gradient(180deg,#cde96b,var(--lime))}
  .bar.hot .bn{color:var(--lime)}
  .bars-x{display:flex;justify-content:space-between;font-size:9.5px;color:#7e97b8;margin-top:5px}

  /* banner */
  .banner{display:flex;gap:12px;align-items:center;background:#fff7e8;border:1px solid #ffe2ad;border-radius:18px;padding:13px 15px;margin-top:14px}
  .banner.ok{background:#eafaf0;border-color:#b7ebca}
  .bic{flex:0 0 auto;width:34px;height:34px;border-radius:10px;background:var(--amber);display:grid;place-items:center;font-size:18px}
  .banner.ok .bic{background:var(--green)}
  .btxt{font-size:12.5px;line-height:1.35;color:#7a5300}
  .banner.ok .btxt{color:#1c6b3a}
  .btxt b{font-weight:700}

  /* stat grid */
  .grid2{display:grid;grid-template-columns:1fr 1fr;gap:11px;margin-top:14px}
  .stat{background:var(--card);border-radius:18px;padding:14px 15px;box-shadow:0 1px 2px rgba(11,27,18,.04);display:block}
  .stat .sn{font-family:'Barlow Condensed',sans-serif;font-weight:800;font-size:34px;line-height:1}
  .stat .sl{font-size:12px;color:var(--muted);font-weight:500;margin-top:3px}
  .stat.amber .sn{color:var(--amber)} .stat.green .sn{color:var(--green-d)} .stat.navy .sn{color:var(--navy2)} .stat.red .sn{color:var(--red)}
  .stat .chip{float:right;font-size:10px;font-weight:700;padding:3px 8px;border-radius:999px}
  .chip.up{background:rgba(52,199,89,.14);color:var(--green-d)}
  .chip.wait{background:rgba(255,149,0,.14);color:var(--amber-d)}

  /* section header */
  .shdr{font-size:12px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:var(--faint);padding:18px 6px 8px}
  .shdr small{text-transform:none;letter-spacing:0;font-weight:500}

  /* zona rows */
  .zlist{background:var(--card);border-radius:18px;overflow:hidden}
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
  .search button{border:none;background:var(--green);color:#fff;font:inherit;font-weight:600;font-size:13px;padding:7px 14px;border-radius:9px;margin:5px 0}
  .chips{display:flex;gap:7px;padding:8px 2px 4px;flex-wrap:wrap}
  .fchip{font-size:12.5px;font-weight:600;color:var(--muted);background:var(--card);border:1px solid var(--sep);padding:7px 13px;border-radius:999px;white-space:nowrap}
  .fchip.on{background:var(--navy2);color:#fff;border-color:var(--navy2)}
  .fchip.amber.on{background:var(--amber);border-color:var(--amber);color:#fff}
  .fchip.red.on{background:var(--red);border-color:var(--red);color:#fff}

  /* lead list */
  .llist{background:var(--card);border-radius:18px;overflow:hidden;box-shadow:0 1px 2px rgba(11,27,18,.04)}
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
  .b-done{background:rgba(52,199,89,.15);color:var(--green-d)}
  .b-new{background:var(--inset);color:var(--muted)}
  .b-zona{color:#fff}
  .chev{color:#c7d0cb;flex:0 0 auto}
  .dotnew{position:absolute;left:5px;top:50%;transform:translateY(-50%);width:7px;height:7px;border-radius:50%;background:var(--amber)}
  .vacio{color:var(--muted);text-align:center;padding:48px 16px;font-size:15px}

  /* ficha */
  .navbar{display:flex;align-items:center;justify-content:space-between;padding:2px 4px 6px}
  .navback{display:inline-flex;align-items:center;gap:2px;color:var(--green-d);font-size:16px;font-weight:500}
  .wabtn{display:inline-flex;align-items:center;gap:6px;background:var(--green);color:#fff;font-size:13px;font-weight:600;padding:8px 14px;border-radius:999px;box-shadow:0 4px 12px -4px rgba(52,199,89,.6)}
  .fhead{display:flex;flex-direction:column;align-items:center;text-align:center;padding:4px 0 12px}
  .fava{width:74px;height:74px;border-radius:50%;display:grid;place-items:center;font-weight:700;font-size:26px;color:#fff;margin-bottom:10px}
  .fhead h2{font-size:21px;font-weight:700;letter-spacing:-.01em}
  .fnum{font-size:13px;color:var(--muted);margin-top:2px}
  .fpills{display:flex;gap:7px;margin-top:10px;flex-wrap:wrap;justify-content:center}
  .pz{font-size:11.5px;font-weight:700;padding:5px 12px;border-radius:999px;color:#fff}

  .group{background:var(--card);border-radius:18px;overflow:hidden;box-shadow:0 1px 2px rgba(11,27,18,.04)}
  .grow{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 15px;border-bottom:1px solid var(--sep);font-size:14.5px}
  .grow:last-child{border-bottom:none}
  .grow .k{color:var(--muted)} .grow .v{font-weight:600;text-align:right}
  .pipe{display:flex;gap:6px;flex-wrap:wrap;padding:13px 14px}
  .pstep{font-family:inherit;font-size:12px;font-weight:600;padding:7px 12px;border-radius:999px;background:var(--inset);color:var(--muted);border:none}
  .pstep.on{background:var(--blue);color:#fff}
  form.inline{display:flex;gap:8px;flex-wrap:wrap;padding:12px 14px}
  form.inline input{flex:1;min-width:130px;background:var(--inset);border:1px solid var(--sep);border-radius:11px;padding:10px 13px;color:var(--ink);font:inherit;font-size:14px;outline:none}
  form.inline textarea{flex-basis:100%;background:var(--inset);border:1px solid var(--sep);border-radius:11px;padding:10px 13px;color:var(--ink);font:inherit;font-size:14px;outline:none;resize:vertical;min-height:64px}
  form.inline button{background:var(--green);color:#fff;border:none;border-radius:11px;padding:10px 16px;font:inherit;font-weight:600}
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
  .bub.out{align-self:flex-end;background:var(--green);color:#fff;border-bottom-right-radius:5px}
  .bub time{display:block;font-size:10px;margin-top:3px;opacity:.55;text-align:right}
  .noreply{align-self:center;display:inline-flex;align-items:center;gap:7px;font-size:11.5px;font-weight:600;color:var(--amber-d);background:rgba(255,149,0,.12);border:1px dashed #ffce8a;padding:5px 12px;border-radius:999px;margin:6px 0}

  .stack>*+*{margin-top:6px}
  .foot{color:var(--faint);font-size:12px;text-align:center;padding:22px 16px 6px}

  /* tab bar */
  .tabbar{position:fixed;bottom:0;left:50%;transform:translateX(-50%);width:100%;max-width:480px;
    height:calc(64px + env(safe-area-inset-bottom));background:rgba(255,255,255,.88);backdrop-filter:blur(20px);
    border-top:1px solid var(--sep);display:flex;padding:8px 0 env(safe-area-inset-bottom);z-index:50}
  .tab{flex:1;display:flex;flex-direction:column;align-items:center;gap:3px;color:var(--faint);font-size:10.5px;font-weight:600}
  .tab svg{width:25px;height:25px}
  .tab.on{color:var(--green-d)}

  /* sidebar (solo escritorio) */
  .shell{min-height:100vh}
  .sidebar{display:none}
  .sidebar .brand{display:flex;align-items:center;gap:11px;font-weight:800;font-size:19px;color:var(--navy);letter-spacing:-.01em;margin-bottom:26px}
  .sidebar .brand .iso{width:36px;height:36px;border-radius:11px;background:linear-gradient(135deg,var(--green),var(--green-d));display:grid;place-items:center;font-size:19px;box-shadow:0 6px 14px -6px rgba(52,199,89,.7)}
  .snav{display:flex;flex-direction:column;gap:4px}
  .snav a{display:flex;align-items:center;gap:12px;padding:11px 13px;border-radius:12px;font-weight:600;font-size:15px;color:var(--muted)}
  .snav a svg{width:22px;height:22px}
  .snav a.on{background:rgba(52,199,89,.12);color:var(--green-d)}
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
};

const tabbar = (key, activo) => `<nav class="tabbar">
  <a class="tab ${activo === 'resumen' ? 'on' : ''}" href="/admin/leads?key=${key}">${SVG.iResumen}Resumen</a>
  <a class="tab ${activo === 'crm' ? 'on' : ''}" href="/admin/leads?key=${key}&vista=crm">${SVG.iCrm}CRM</a>
  <a class="tab ${activo === 'config' ? 'on' : ''}" href="/admin/leads?key=${key}&vista=config">${SVG.iConfig}Config</a>
</nav>`;

const sidebar = (key, activo) => `<aside class="sidebar">
  <div class="brand"><span class="iso">⚽</span> Pichangueros</div>
  <nav class="snav">
    <a class="${activo === 'resumen' ? 'on' : ''}" href="/admin/leads?key=${key}">${SVG.iResumen} Resumen</a>
    <a class="${activo === 'crm' ? 'on' : ''}" href="/admin/leads?key=${key}&vista=crm">${SVG.iCrm} CRM</a>
    <a class="${activo === 'config' ? 'on' : ''}" href="/admin/leads?key=${key}&vista=config">${SVG.iConfig} Config</a>
  </nav>
  <div class="sbottom">
    ${sheetsync.activo() ? `<a class="scsv" href="/admin/sync-sheet?key=${key}">☁ Respaldar a Sheet</a>` : ''}
    <a class="scsv" href="/admin/leads.csv?key=${key}">⬇ Exportar CSV</a>
    <a class="scsv" href="/admin/backup-db?key=${key}">💾 Descargar backup BD</a>
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
  const sinResp = (l) => roles[l.numero] === 'user' && !l.handoff;
  const hoy = hoyLima();

  // Altas por día (últimos 14, terminando hoy Lima).
  const porDia = {};
  for (const l of todos) {
    const d = (l.creado_en || '').slice(0, 10);
    if (d) porDia[d] = (porDia[d] || 0) + 1;
  }
  const dias = [];
  for (let i = 13; i >= 0; i--) { const d = fechaLima(-i); dias.push({ d, n: porDia[d] || 0 }); }
  const maxN = Math.max(1, ...dias.map((x) => x.n));
  const semana = dias.slice(-7).reduce((a, x) => a + x.n, 0);
  const previa = dias.slice(0, 7).reduce((a, x) => a + x.n, 0);
  const delta = previa ? Math.round(((semana - previa) / previa) * 100) : (semana ? 100 : 0);
  const hoyN = porDia[hoy] || 0;

  const colaResp = todos.filter(sinResp).length;
  const enHandoff = todos.filter((l) => l.handoff).length;
  const paraHoy = todos.filter((l) => l.proxima_accion && l.proxima_accion <= hoy).length;

  // Por zona (las clasificadas + las que faltan).
  const zc = { brena: 0, comas: 0, otra: 0 };
  let clasificadas = 0;
  for (const l of todos) if (ZONAS[l.zona]) { zc[l.zona] = (zc[l.zona] || 0) + 1; clasificadas++; }
  const sinClasificar = todos.length - clasificadas;
  const maxZ = Math.max(1, zc.brena, zc.comas, zc.otra, sinClasificar);
  const zrow = (nombre, n, color) =>
    `<div class="zrow"><span class="zdot" style="background:${color}"></span><span class="zname">${nombre}</span>
      <span class="ztrack"><i style="width:${Math.max(3, Math.round((n / maxZ) * 100))}%;background:${color}"></i></span>
      <span class="zval">${n}</span></div>`;

  const barras = dias.map((x) => {
    const h = x.n ? Math.max(8, Math.round((x.n / maxN) * 100)) : 0;
    const hot = x.n >= maxN * 0.75 && x.n > 0;
    return `<div class="bar ${hot ? 'hot' : ''}" title="${x.d}: ${x.n} ${x.n === 1 ? 'contacto' : 'contactos'}">
      <span class="bn">${x.n || ''}</span><div class="track"><i style="height:${h}%"></i></div></div>`;
  }).join('');

  const bannerSeguro = `<a class="banner px" href="/admin/leads?key=${key}&vista=crm&filtro=responder" style="text-decoration:none">
    <div class="bic">🔒</div>
    <div class="btxt"><b>Modo seguro activo.</b> El bot registra a todos pero todavía no responde.
      <b>${colaResp} ${colaResp === 1 ? 'persona' : 'personas'}</b> esperando respuesta — se activa con un cambio.</div></a>`;

  return baseHtml('Pichangueros — Resumen', `
    <div class="ltitle">
      <div><div class="eyebrow">Pichangueros</div><h2>Resumen</h2></div>
      <span class="live"><i></i> En vivo</span>
    </div>
    <div class="px">
      ${query.sync ? `<div class="banner ${query.sync === 'err' ? '' : 'ok'}" style="margin:0 0 12px"><div class="bic">☁</div><div class="btxt">${query.sync === 'err' ? 'No se pudo respaldar al Sheet — revisá SHEET_WEBHOOK_URL/SHEET_SECRET.' : `<b>Respaldado al Google Sheet</b> · ${esc(query.sync)} leads.`}</div></div>` : ''}
      <div class="marcador">
        <div class="mtop"><span class="mlabel">Contactos captados</span>
          <span class="mdelta">▲ +${semana} esta semana</span></div>
        <div class="mnum">${todos.length}</div>
        <div class="bars">${barras}</div>
        <div class="bars-x"><span>${dias[0].d.slice(8)} ${mesCorto(dias[0].d)}</span><span>hoy</span></div>
      </div>

      ${bannerSeguro}

      <div class="grid2">
        <a class="stat green" href="/admin/leads?key=${key}&vista=crm">${delta ? `<span class="chip up">▲ ${delta}%</span>` : ''}<div class="sn">${semana}</div><div class="sl">Esta semana</div></a>
        <div class="stat navy"><div class="sn">${hoyN}</div><div class="sl">Nuevos hoy</div></div>
        <a class="stat amber" href="/admin/leads?key=${key}&vista=crm&filtro=responder"><span class="chip wait">pendiente</span><div class="sn">${colaResp}</div><div class="sl">Sin responder</div></a>
        <a class="stat ${enHandoff ? 'red' : ''}" href="/admin/leads?key=${key}&vista=crm&filtro=handoff"><div class="sn">${enHandoff}</div><div class="sl">Para Clarck</div></a>
      </div>

      <div class="shdr">Por zona</div>
      <div class="zlist">
        ${zrow('Breña', zc.brena, ZONAS.brena.color)}
        ${zrow('Comas', zc.comas, ZONAS.comas.color)}
        ${zc.otra ? zrow('Otras zonas', zc.otra, ZONAS.otra.color) : ''}
        ${sinClasificar ? zrow('Por clasificar', sinClasificar, 'var(--faint)') : ''}
      </div>

      ${paraHoy ? `<a class="banner px" href="/admin/leads?key=${key}&vista=crm&filtro=hoy" style="margin-top:12px;text-decoration:none"><div class="bic">⏰</div><div class="btxt"><b>${paraHoy} seguimiento${paraHoy === 1 ? '' : 's'} para hoy.</b> Toca para verlos.</div></a>` : ''}

      <div class="foot">Se actualiza solo cada 90 s · <a href="/admin/leads.csv?key=${key}" style="color:var(--green-d)">⬇ exportar CSV</a></div>
    </div>
  `, { refresh: true, activo: 'resumen', key });
}

const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const mesCorto = (yyyymmdd) => MESES[Number((yyyymmdd || '').slice(5, 7)) - 1] || '';

// ==============================================================================
//  Vista 2 · CRM (lista de leads)
// ==============================================================================
function paginaCRM(db, key, query) {
  const todos = db.listLeads();
  const roles = db.ultimosRoles();
  const sinResp = (l) => roles[l.numero] === 'user' && !l.handoff;
  const hoy = hoyLima();

  const q = (query.q || '').trim().toLowerCase();
  const zona = ZONAS[query.zona] ? query.zona : '';
  const filtro = query.filtro || '';
  let leads = todos;
  if (q) leads = leads.filter((l) => [l.nombre, l.numero, l.distrito, l.etiquetas].join(' ').toLowerCase().includes(q));
  if (zona) leads = leads.filter((l) => l.zona === zona);
  if (filtro === 'handoff') leads = leads.filter((l) => l.handoff);
  if (filtro === 'responder') leads = leads.filter(sinResp);
  if (filtro === 'hoy') leads = leads.filter((l) => l.proxima_accion && l.proxima_accion <= hoy);

  // Dos grupos: necesitan respuesta (handoff o sin responder) y el resto.
  const urgentes = leads.filter((l) => l.handoff || sinResp(l));
  const resto = leads.filter((l) => !(l.handoff || sinResp(l)));

  const chip = (extra, label, on, cls = '') =>
    `<a class="fchip ${cls}${on ? ' on' : ''}" href="/admin/leads?key=${key}&vista=crm${extra}">${label}</a>`;

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

  const lista = (urgentes.length || resto.length)
    ? grupo('Necesitan respuesta', urgentes) + grupo('Todos', resto)
    : '<p class="vacio">Sin pichangueros en este filtro todavía ⚽</p>';

  return baseHtml('Pichangueros — CRM', `
    <div class="ltitle"><div><div class="eyebrow">${todos.length} contactos</div><h2>CRM</h2></div>
      <a class="csv" href="/admin/leads.csv?key=${key}">⬇ CSV</a></div>
    <div class="px">
      <form class="search" method="get" action="/admin/leads">
        ${SVG.lupa}
        <input type="hidden" name="key" value="${key}"><input type="hidden" name="vista" value="crm">
        <input name="q" value="${esc(query.q || '')}" placeholder="Buscar nombre, número, distrito…">
        ${q ? '<button>Buscar</button>' : ''}
      </form>
      <div class="chips">
        ${chip('', 'Todos', !zona && !filtro && !q)}
        ${chip('&filtro=responder', '📥 Sin responder', filtro === 'responder', 'amber')}
        ${chip('&filtro=handoff', '🔔 Clarck', filtro === 'handoff', 'red')}
        ${chip('&filtro=hoy', '⏰ Para hoy', filtro === 'hoy', 'amber')}
        ${chip('&zona=brena', 'Breña', zona === 'brena')}
        ${chip('&zona=comas', 'Comas', zona === 'comas')}
        ${chip('&zona=otra', 'Otras', zona === 'otra')}
      </div>
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
  const roles = db.ultimosRoles();
  const keyRaw = decodeURIComponent(key);
  const sinResp = roles[numero] === 'user' && !lead.handoff;
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
  const sedesPorZona = { brena: db.listSedes('brena'), comas: db.listSedes('comas') };

  const filaSede = (zona, s) => `
    <form class="inline" method="post" action="/admin/config/sede">
      <input type="hidden" name="key" value="${esc(keyRaw)}">
      <input type="hidden" name="zona" value="${zona}">
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

  const bloqueZona = (zona, nombreZona) => `
    <div class="shdr">Sedes · ${nombreZona} <small>(precio S/ ${esc(c[`precio_${zona}`])} por jugador)</small></div>
    <div class="group">
      ${sedesPorZona[zona].map((s) => filaSede(zona, s)).join('') || '<p style="padding:14px;color:var(--faint);font-size:14px">Sin sedes todavía.</p>'}
    </div>
    <div class="group" style="margin-top:8px">${filaSede(zona, null)}</div>`;

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
          <label>Precio Breña (S/)</label>
          <input name="precio_brena" type="number" value="${esc(c.precio_brena)}">
          <label>Precio Comas (S/)</label>
          <input name="precio_comas" type="number" value="${esc(c.precio_comas)}">
          <label>Link grupo WhatsApp — Breña</label>
          <input name="grouplink_brena" value="${esc(c.grouplink_brena)}" placeholder="https://chat.whatsapp.com/…">
          <label>Link grupo WhatsApp — Comas</label>
          <input name="grouplink_comas" value="${esc(c.grouplink_comas)}" placeholder="https://chat.whatsapp.com/…">
          <label>Hora de llegada</label>
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

      ${bloqueZona('brena', 'Breña')}
      ${bloqueZona('comas', 'Comas')}

      <div class="foot">⚽ Pichangueros · Config</div>
    </div>
  `, { refresh: false, activo: 'config', key });
}

module.exports = { registrarPanel, paginaResumen, paginaCRM, paginaFicha, paginaConfig };
