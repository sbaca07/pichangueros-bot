/**
 * Panel CRM (Semana 3) — "marcador nocturno".
 *
 * Diseño basado en benchmark de CRMs WhatsApp-first (ver crm-design.md):
 * Kommo (pipeline por etapas) · Callbell (cola sin responder) · Pipedrive
 * (acciones de 1 toque, mobile-first) · OnePageCRM (próxima acción con fecha).
 *
 * Rutas (todas con ?key=ADMIN_KEY; sin key → 404):
 *   GET  /admin/leads            dashboard: marcador, filtros, búsqueda, cards
 *   GET  /admin/leads&numero=N   ficha de contacto: perfil + CRM + chat
 *   GET  /admin/leads.csv        export CSV
 *   POST /admin/lead/estado      cambia etapa del pipeline (1 toque)
 *   POST /admin/lead/reactivar   saca del handoff (el bot vuelve a atender)
 *   POST /admin/lead/etiquetas   guarda etiquetas (separadas por coma)
 *   POST /admin/lead/seguimiento fecha + nota de próxima acción
 *   POST /admin/lead/nota        agrega una nota al historial
 */
const esc = (v) =>
  String(v ?? '—').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const ZONAS = {
  brena: { nombre: 'Breña', color: '#3ddc6e' },
  comas: { nombre: 'Comas', color: '#4f8df9' },
  otra: { nombre: 'Otra zona', color: '#b9a44c' },
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

const hoyLima = () => new Date(Date.now() - 5 * 3600e3).toISOString().slice(0, 10);

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

  // --- Vistas ----------------------------------------------------------------------
  app.get('/admin/leads', (req, res) => {
    if (!autorizado(req, res)) return;
    const key = encodeURIComponent(req.query.key);
    const numero = (req.query.numero || '').replace(/\D/g, '');
    if (numero) return res.send(paginaFicha(db, key, numero));
    res.send(paginaDashboard(db, key, req.query));
  });
}

// ------------------------------------------------------------------------------
function baseHtml(titulo, cuerpo, autoRefresh) {
  return `<!doctype html><html lang="es"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(titulo)}</title>
${autoRefresh ? '<meta http-equiv="refresh" content="90">' : ''}
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@600;800&family=Barlow:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  :root{
    --campo:#08130c; --carta:#0e2014; --linea:rgba(242,247,243,.12);
    --tiza:#f2f7f3; --gris:#8fa697; --cesped:#3ddc6e; --azul:#4f8df9; --rojo:#ff5d5d; --ambar:#ffc24b;
  }
  *{box-sizing:border-box;margin:0;padding:0}
  body{
    font-family:'Barlow',sans-serif; color:var(--tiza); background:var(--campo);
    background-image:
      radial-gradient(ellipse 90% 50% at 50% -10%, rgba(61,220,110,.14), transparent 60%),
      repeating-linear-gradient(90deg, transparent 0 72px, rgba(255,255,255,.015) 72px 144px);
    min-height:100vh; padding:18px 14px 60px;
  }
  .wrap{max-width:880px;margin:0 auto}
  header{display:flex;align-items:baseline;justify-content:space-between;border-bottom:2px dashed var(--linea);padding-bottom:14px;margin-bottom:18px;gap:10px}
  h1{font-family:'Barlow Condensed';font-weight:800;font-size:clamp(24px,6vw,38px);letter-spacing:.04em;text-transform:uppercase}
  h1 .punto{color:var(--cesped)}
  header a.csv{color:var(--gris);font-size:13px;text-decoration:none;border:1px solid var(--linea);padding:6px 12px;border-radius:999px;white-space:nowrap}
  .marcador{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:14px}
  .tanteo{background:var(--carta);border:1px solid var(--linea);border-radius:14px;padding:12px 8px;text-align:center;animation:sube .45s ease both;text-decoration:none;color:inherit;display:block}
  .tanteo:nth-child(2){animation-delay:.06s}.tanteo:nth-child(3){animation-delay:.12s}.tanteo:nth-child(4){animation-delay:.18s}
  .tanteo b{font-family:'Barlow Condensed';font-weight:800;font-size:clamp(26px,7vw,40px);display:block;line-height:1}
  .tanteo span{font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--gris)}
  .tanteo.alerta b{color:var(--rojo)} .tanteo.verde b{color:var(--cesped)} .tanteo.ambar b{color:var(--ambar)}
  @keyframes sube{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
  .buscar{display:flex;gap:8px;margin-bottom:12px}
  .buscar input{flex:1;background:var(--carta);border:1px solid var(--linea);border-radius:999px;padding:9px 16px;color:var(--tiza);font-family:inherit;font-size:14px;outline:none}
  .buscar input::placeholder{color:var(--gris)}
  .buscar button{background:var(--cesped);color:#06210f;border:none;border-radius:999px;padding:9px 18px;font-weight:600;font-family:inherit}
  .filtros{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px}
  .filtros a{font-size:13px;font-weight:600;color:var(--gris);text-decoration:none;border:1px solid var(--linea);padding:7px 14px;border-radius:999px}
  .filtros a.on{color:#06210f;background:var(--cesped);border-color:var(--cesped)}
  .filtros a.rojo.on{background:var(--rojo);border-color:var(--rojo);color:#2a0606}
  .filtros a.ambar.on{background:var(--ambar);border-color:var(--ambar);color:#2a1d06}
  .lead{display:block;background:var(--carta);border:1px solid var(--linea);border-left:4px solid var(--borde,var(--linea));border-radius:14px;padding:14px;margin-bottom:10px;text-decoration:none;color:inherit;animation:sube .4s ease both}
  .lead:active{background:#13301d}
  .lead .fila1{display:flex;justify-content:space-between;align-items:center;gap:8px}
  .lead .nombre{font-family:'Barlow Condensed';font-weight:800;font-size:20px;letter-spacing:.02em}
  .lead .hora{font-size:12px;color:var(--gris);white-space:nowrap}
  .lead .fila2{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
  .pill{font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;padding:4px 10px;border-radius:999px;border:1px solid var(--linea);color:var(--gris)}
  .pill.zona{color:#06210f;border:none}
  .pill.handoff{background:var(--rojo);border:none;color:#2a0606}
  .pill.resp{background:var(--ambar);border:none;color:#2a1d06}
  .pill.venc{border-color:var(--rojo);color:var(--rojo)}
  .pill.tag{border-style:dashed}
  .vacio{color:var(--gris);text-align:center;padding:50px 0;font-size:15px}
  .nota{color:var(--gris);font-size:12px;text-align:center;margin-top:26px}
  /* --- ficha --- */
  .volver{display:inline-block;color:var(--gris);text-decoration:none;font-size:14px;margin-bottom:14px}
  .bloque{background:var(--carta);border:1px solid var(--linea);border-radius:14px;padding:14px;margin-bottom:12px}
  .bloque h3{font-family:'Barlow Condensed';font-weight:800;font-size:15px;letter-spacing:.12em;text-transform:uppercase;color:var(--gris);margin-bottom:10px}
  .datos{display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:14px}
  .datos b{color:var(--gris);font-weight:500;display:block;font-size:11px;letter-spacing:.1em;text-transform:uppercase}
  .etapas{display:flex;gap:6px;flex-wrap:wrap}
  .etapas button{font-family:inherit;font-size:12px;font-weight:600;padding:7px 12px;border-radius:999px;border:1px solid var(--linea);background:transparent;color:var(--gris)}
  .etapas button.on{background:var(--azul);border-color:var(--azul);color:#061325}
  form.inline{display:flex;gap:8px;flex-wrap:wrap}
  form.inline input{flex:1;min-width:120px;background:#0a1810;border:1px solid var(--linea);border-radius:10px;padding:9px 12px;color:var(--tiza);font-family:inherit;font-size:14px;outline:none}
  form.inline button{background:var(--cesped);color:#06210f;border:none;border-radius:10px;padding:9px 16px;font-weight:600;font-family:inherit}
  .btn-rojo{background:var(--rojo)!important;color:#2a0606!important}
  .notas p{font-size:14px;border-left:3px solid var(--linea);padding:4px 10px;margin-bottom:8px}
  .notas time{display:block;font-size:11px;color:var(--gris)}
  .chat{display:flex;flex-direction:column;gap:8px}
  .burbuja{max-width:82%;padding:10px 14px;border-radius:16px;font-size:15px;line-height:1.45;white-space:pre-wrap;word-break:break-word}
  .burbuja.user{align-self:flex-start;background:#1b3526;border-bottom-left-radius:4px}
  .burbuja.bot{align-self:flex-end;background:#123150;border-bottom-right-radius:4px}
  .burbuja time{display:block;font-size:10px;color:var(--gris);margin-top:5px;text-align:right}
  .wa{display:inline-block;background:var(--cesped);color:#06210f;font-weight:600;text-decoration:none;padding:10px 18px;border-radius:999px;font-size:14px}
</style></head><body><div class="wrap">${cuerpo}</div></body></html>`;
}

function badges(l, key, sinResponder) {
  const z = ZONAS[l.zona];
  const vencido = l.proxima_accion && l.proxima_accion <= hoyLima();
  const tags = (l.etiquetas || '').split(',').filter(Boolean);
  return `
    ${l.handoff ? `<span class="pill handoff">🔔 ${esc(l.handoff_motivo || 'derivado')}</span>` : ''}
    ${sinResponder ? '<span class="pill resp">📥 sin responder</span>' : ''}
    ${vencido ? `<span class="pill venc">⏰ ${esc(l.proxima_nota || 'seguimiento')}</span>` : ''}
    ${z ? `<span class="pill zona" style="background:${z.color}">${z.nombre}</span>` : ''}
    <span class="pill">${esc(ESTADOS[l.estado] || l.estado)}</span>
    ${tags.map((t) => `<span class="pill tag">${esc(t)}</span>`).join('')}`;
}

function paginaDashboard(db, key, query) {
  const todos = db.listLeads();
  const roles = db.ultimosRoles();
  const sinResp = (l) => roles[l.numero] === 'user' && !l.handoff;
  const hoy = hoyLima();
  const paraHoy = todos.filter((l) => l.proxima_accion && l.proxima_accion <= hoy);
  const enHandoff = todos.filter((l) => l.handoff);
  const colaResp = todos.filter(sinResp);

  const q = (query.q || '').trim().toLowerCase();
  const zona = ZONAS[query.zona] ? query.zona : '';
  const filtro = query.filtro || '';
  let leads = todos;
  if (q) leads = leads.filter((l) => [l.nombre, l.numero, l.distrito, l.etiquetas].join(' ').toLowerCase().includes(q));
  if (zona) leads = leads.filter((l) => l.zona === zona);
  if (filtro === 'handoff') leads = leads.filter((l) => l.handoff);
  if (filtro === 'responder') leads = leads.filter(sinResp);
  if (filtro === 'hoy') leads = leads.filter((l) => l.proxima_accion && l.proxima_accion <= hoy);
  // prioridad visual: handoff → sin responder → resto
  leads = [...leads.filter((l) => l.handoff), ...leads.filter((l) => !l.handoff && sinResp(l)), ...leads.filter((l) => !l.handoff && !sinResp(l))];

  const chip = (href, label, on, extra = '') =>
    `<a class="${extra}${on ? ' on' : ''}" href="?key=${key}${href}">${label}</a>`;

  const cards = leads.map((l, i) => `
    <a class="lead" style="--borde:${l.handoff ? 'var(--rojo)' : sinResp(l) ? 'var(--ambar)' : (ZONAS[l.zona] || { color: 'var(--linea)' }).color};animation-delay:${Math.min(i * 0.04, 0.4)}s" href="?key=${key}&numero=${esc(l.numero)}">
      <div class="fila1"><span class="nombre">${esc(l.nombre || 'Sin nombre')}</span><span class="hora">${esc((l.actualizado_en || '').slice(5, 16))}</span></div>
      <div class="fila2">${badges(l, key, sinResp(l))}</div>
    </a>`).join('');

  return baseHtml('Pichangueros — CRM', `
    <header>
      <h1>Pichangueros<span class="punto">.</span> CRM</h1>
      <a class="csv" href="/admin/leads.csv?key=${key}">⬇ CSV</a>
    </header>
    <div class="marcador">
      <a class="tanteo verde" href="?key=${key}"><b>${todos.length}</b><span>Leads</span></a>
      <a class="tanteo ambar" href="?key=${key}&filtro=responder"><b>${colaResp.length}</b><span>Sin responder</span></a>
      <a class="tanteo${paraHoy.length ? ' alerta' : ''}" href="?key=${key}&filtro=hoy"><b>${paraHoy.length}</b><span>Para hoy</span></a>
      <a class="tanteo${enHandoff.length ? ' alerta' : ''}" href="?key=${key}&filtro=handoff"><b>${enHandoff.length}</b><span>Para Clarck</span></a>
    </div>
    <form class="buscar" method="get" action="/admin/leads">
      <input type="hidden" name="key" value="${key}">
      <input name="q" value="${esc(query.q || '')}" placeholder="Buscar por nombre, número, distrito o etiqueta…">
      <button>Buscar</button>
    </form>
    <div class="filtros">
      ${chip('', 'Todos', !zona && !filtro && !q)}
      ${chip('&zona=brena', 'Breña', zona === 'brena')}
      ${chip('&zona=comas', 'Comas', zona === 'comas')}
      ${chip('&zona=otra', 'Otras', zona === 'otra')}
      ${chip('&filtro=responder', '📥 Sin responder', filtro === 'responder', 'ambar')}
      ${chip('&filtro=hoy', '⏰ Para hoy', filtro === 'hoy', 'ambar')}
      ${chip('&filtro=handoff', '🔔 Derivados', filtro === 'handoff', 'rojo')}
    </div>
    ${cards || '<p class="vacio">Sin pichangueros en este filtro todavía ⚽</p>'}
    <p class="nota">Se actualiza solo cada 90 s · toca un lead para abrir su ficha</p>
  `, true);
}

function paginaFicha(db, key, numero) {
  const lead = db.getOrCreateLead(numero);
  const msgs = db.getHistory(numero, 200);
  const notas = db.getNotas(numero);
  const roles = db.ultimosRoles();
  const keyRaw = decodeURIComponent(key);

  const botonesEtapa = Object.entries(ESTADOS).map(([v, label]) => `
    <form method="post" action="/admin/lead/estado" style="display:inline">
      <input type="hidden" name="key" value="${esc(keyRaw)}"><input type="hidden" name="numero" value="${esc(numero)}">
      <input type="hidden" name="estado" value="${v}">
      <button class="${lead.estado === v ? 'on' : ''}">${label}</button>
    </form>`).join('');

  const burbujas = msgs.map((m) => `
    <div class="burbuja ${m.rol === 'user' ? 'user' : 'bot'}">${esc(m.texto)}<time>${esc((m.creado_en || '').slice(5, 16))}</time></div>`).join('');

  return baseHtml(`Ficha · ${lead.nombre || numero}`, `
    <a class="volver" href="/admin/leads?key=${key}">← Volver al CRM</a>
    <header><h1>${esc(lead.nombre || numero)}<span class="punto">.</span></h1>
      <a class="wa" href="https://wa.me/${esc(numero)}" target="_blank">WhatsApp →</a></header>

    <div class="bloque"><h3>Perfil</h3>
      <div class="datos">
        <div><b>Número</b>${esc(numero)}</div><div><b>Edad</b>${esc(lead.edad)}</div>
        <div><b>Distrito</b>${esc(lead.distrito)}</div><div><b>Zona</b>${esc((ZONAS[lead.zona] || {}).nombre || lead.zona)}</div>
      </div>
      <div class="fila2" style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px">${badges(lead, key, roles[numero] === 'user' && !lead.handoff)}</div>
      ${lead.handoff ? `
      <form method="post" action="/admin/lead/reactivar" style="margin-top:12px">
        <input type="hidden" name="key" value="${esc(keyRaw)}"><input type="hidden" name="numero" value="${esc(numero)}">
        <button class="btn-rojo" style="border:none;border-radius:10px;padding:10px 16px;font-weight:600;font-family:inherit">🔓 Reactivar bot para este contacto</button>
      </form>` : ''}
    </div>

    <div class="bloque"><h3>Etapa</h3><div class="etapas">${botonesEtapa}</div></div>

    <div class="bloque"><h3>Etiquetas <small style="text-transform:none;letter-spacing:0">(separadas por coma)</small></h3>
      <form class="inline" method="post" action="/admin/lead/etiquetas">
        <input type="hidden" name="key" value="${esc(keyRaw)}"><input type="hidden" name="numero" value="${esc(numero)}">
        <input name="etiquetas" value="${esc(lead.etiquetas || '')}" placeholder="casero, paga efectivo, VIP…">
        <button>Guardar</button>
      </form>
    </div>

    <div class="bloque"><h3>Próxima acción</h3>
      <form class="inline" method="post" action="/admin/lead/seguimiento">
        <input type="hidden" name="key" value="${esc(keyRaw)}"><input type="hidden" name="numero" value="${esc(numero)}">
        <input type="date" name="fecha" value="${esc(lead.proxima_accion || '')}">
        <input name="nota" value="${esc(lead.proxima_nota || '')}" placeholder="ej. avisarle del cupo del viernes">
        <button>Guardar</button>
      </form>
    </div>

    <div class="bloque notas"><h3>Notas</h3>
      <form class="inline" method="post" action="/admin/lead/nota" style="margin-bottom:10px">
        <input type="hidden" name="key" value="${esc(keyRaw)}"><input type="hidden" name="numero" value="${esc(numero)}">
        <input name="texto" placeholder="ej. vino con 3 amigos, buen arquero…">
        <button>+ Nota</button>
      </form>
      ${notas.map((n) => `<p>${esc(n.texto)}<time>${esc((n.creado_en || '').slice(0, 16))}</time></p>`).join('') || '<p style="color:var(--gris);border:none">Sin notas.</p>'}
    </div>

    <div class="bloque"><h3>Conversación</h3><div class="chat">${burbujas || '<p class="vacio">Sin mensajes.</p>'}</div></div>
  `, false);
}

module.exports = { registrarPanel };
