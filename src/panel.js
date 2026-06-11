/**
 * Panel de control (Semana 3, adelantado) — "marcador nocturno".
 *
 * Dashboard server-rendered, mobile-first (Clarck lo usa desde el celular):
 *   /admin/leads?key=KEY                → dashboard: marcador + lista de leads
 *   /admin/leads?key=KEY&zona=comas     → filtro por zona (brena|comas|otra)
 *   /admin/leads?key=KEY&filtro=handoff → solo derivados a Clarck
 *   /admin/leads?key=KEY&numero=519...  → conversación estilo chat
 *   /admin/leads.csv?key=KEY            → export CSV (backup rápido)
 *
 * Protegido con ADMIN_KEY (env). Sin key correcta responde 404 (no revela
 * que el endpoint existe).
 */
const esc = (v) =>
  String(v ?? '—').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const ZONAS = {
  brena: { nombre: 'Breña', color: '#3ddc6e' },
  comas: { nombre: 'Comas', color: '#4f8df9' },
  otra: { nombre: 'Otra zona', color: '#b9a44c' },
};

const ESTADOS = {
  nuevo: 'Nuevo',
  datos_completos: 'Completo',
  invitado_grupo: 'En grupo',
  lista_espera: 'En espera',
};

function registrarPanel(app, db) {
  const ADMIN_KEY = process.env.ADMIN_KEY || '';
  const autorizado = (req, res) => {
    if (!ADMIN_KEY || req.query.key !== ADMIN_KEY) {
      res.status(404).send('Not found');
      return false;
    }
    return true;
  };

  // --- Export CSV --------------------------------------------------------------
  app.get('/admin/leads.csv', (req, res) => {
    if (!autorizado(req, res)) return;
    const filas = db.listLeads().map((l) =>
      [l.numero, l.nombre, l.edad, l.distrito, l.zona, l.estado, l.handoff, l.handoff_motivo, l.creado_en]
        .map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`)
        .join(',')
    );
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="pichangueros-leads.csv"');
    res.send(['numero,nombre,edad,distrito,zona,estado,handoff,handoff_motivo,creado_en', ...filas].join('\n'));
  });

  // --- Dashboard ----------------------------------------------------------------
  app.get('/admin/leads', (req, res) => {
    if (!autorizado(req, res)) return;
    const key = encodeURIComponent(req.query.key);
    const numero = (req.query.numero || '').replace(/\D/g, '');
    if (numero) return res.send(paginaConversacion(db, key, numero));
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
    --tiza:#f2f7f3; --gris:#8fa697; --cesped:#3ddc6e; --azul:#4f8df9; --rojo:#ff5d5d;
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
  header{display:flex;align-items:baseline;justify-content:space-between;border-bottom:2px dashed var(--linea);padding-bottom:14px;margin-bottom:18px}
  h1{font-family:'Barlow Condensed';font-weight:800;font-size:clamp(26px,6vw,38px);letter-spacing:.04em;text-transform:uppercase}
  h1 .punto{color:var(--cesped)}
  header a.csv{color:var(--gris);font-size:13px;text-decoration:none;border:1px solid var(--linea);padding:6px 12px;border-radius:999px}
  header a.csv:active{color:var(--tiza)}
  .marcador{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:18px}
  .tanteo{background:var(--carta);border:1px solid var(--linea);border-radius:14px;padding:12px 8px;text-align:center;animation:sube .45s ease both}
  .tanteo:nth-child(2){animation-delay:.06s}.tanteo:nth-child(3){animation-delay:.12s}.tanteo:nth-child(4){animation-delay:.18s}
  .tanteo b{font-family:'Barlow Condensed';font-weight:800;font-size:clamp(26px,7vw,40px);display:block;line-height:1}
  .tanteo span{font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--gris)}
  .tanteo.alerta b{color:var(--rojo)} .tanteo.verde b{color:var(--cesped)} .tanteo.azul b{color:var(--azul)}
  @keyframes sube{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
  .filtros{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px}
  .filtros a{font-size:13px;font-weight:600;color:var(--gris);text-decoration:none;border:1px solid var(--linea);padding:7px 14px;border-radius:999px;background:transparent}
  .filtros a.on{color:#06210f;background:var(--cesped);border-color:var(--cesped)}
  .filtros a.rojo.on{background:var(--rojo);border-color:var(--rojo);color:#2a0606}
  .lead{display:block;background:var(--carta);border:1px solid var(--linea);border-left:4px solid var(--borde,var(--linea));border-radius:14px;padding:14px;margin-bottom:10px;text-decoration:none;color:inherit;animation:sube .4s ease both}
  .lead:active{background:#13301d}
  .lead .fila1{display:flex;justify-content:space-between;align-items:center;gap:8px}
  .lead .nombre{font-family:'Barlow Condensed';font-weight:800;font-size:20px;letter-spacing:.02em}
  .lead .hora{font-size:12px;color:var(--gris);white-space:nowrap}
  .lead .fila2{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
  .pill{font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;padding:4px 10px;border-radius:999px;border:1px solid var(--linea);color:var(--gris)}
  .pill.zona{color:#06210f;border:none}
  .pill.handoff{background:var(--rojo);border:none;color:#2a0606}
  .vacio{color:var(--gris);text-align:center;padding:50px 0;font-size:15px}
  .nota{color:var(--gris);font-size:12px;text-align:center;margin-top:26px}
  /* --- chat --- */
  .volver{display:inline-block;color:var(--gris);text-decoration:none;font-size:14px;margin-bottom:14px}
  .chat{display:flex;flex-direction:column;gap:8px}
  .burbuja{max-width:82%;padding:10px 14px;border-radius:16px;font-size:15px;line-height:1.45;white-space:pre-wrap;word-break:break-word;animation:sube .3s ease both}
  .burbuja.user{align-self:flex-start;background:#1b3526;border-bottom-left-radius:4px}
  .burbuja.bot{align-self:flex-end;background:#123150;border-bottom-right-radius:4px}
  .burbuja time{display:block;font-size:10px;color:var(--gris);margin-top:5px;text-align:right}
  .wa{display:inline-block;margin-top:18px;background:var(--cesped);color:#06210f;font-weight:600;text-decoration:none;padding:10px 18px;border-radius:999px;font-size:14px}
</style></head><body><div class="wrap">${cuerpo}</div></body></html>`;
}

function paginaDashboard(db, key, query) {
  const todos = db.listLeads();
  const enHandoff = todos.filter((l) => l.handoff);
  const completos = todos.filter((l) => l.estado !== 'nuevo');
  const espera = todos.filter((l) => l.estado === 'lista_espera');

  const zona = ZONAS[query.zona] ? query.zona : '';
  const soloHandoff = query.filtro === 'handoff';
  let leads = todos;
  if (zona) leads = leads.filter((l) => l.zona === zona);
  if (soloHandoff) leads = leads.filter((l) => l.handoff);
  // los que necesitan atención primero
  leads = [...leads.filter((l) => l.handoff), ...leads.filter((l) => !l.handoff)];

  const chip = (href, label, on, extra = '') =>
    `<a class="${extra}${on ? ' on' : ''}" href="?key=${key}${href}">${label}</a>`;

  const cards = leads.map((l, i) => {
    const z = ZONAS[l.zona];
    return `<a class="lead" style="--borde:${l.handoff ? 'var(--rojo)' : z ? z.color : 'var(--linea)'};animation-delay:${Math.min(i * 0.04, 0.4)}s" href="?key=${key}&numero=${esc(l.numero)}">
      <div class="fila1"><span class="nombre">${esc(l.nombre || 'Sin nombre')}</span><span class="hora">${esc((l.actualizado_en || '').slice(5, 16))}</span></div>
      <div class="fila2">
        ${l.handoff ? `<span class="pill handoff">🔔 ${esc(l.handoff_motivo || 'derivado')}</span>` : ''}
        ${z ? `<span class="pill zona" style="background:${z.color}">${z.nombre}</span>` : ''}
        <span class="pill">${esc(ESTADOS[l.estado] || l.estado)}</span>
        ${l.edad ? `<span class="pill">${esc(l.edad)} años</span>` : ''}
        ${l.distrito ? `<span class="pill">${esc(l.distrito)}</span>` : ''}
      </div></a>`;
  }).join('');

  return baseHtml('Pichangueros — Panel', `
    <header>
      <h1>Pichangueros<span class="punto">.</span> Panel</h1>
      <a class="csv" href="/admin/leads.csv?key=${key}">⬇ CSV</a>
    </header>
    <div class="marcador">
      <div class="tanteo verde"><b>${todos.length}</b><span>Leads</span></div>
      <div class="tanteo azul"><b>${completos.length}</b><span>Completos</span></div>
      <div class="tanteo"><b>${espera.length}</b><span>En espera</span></div>
      <div class="tanteo${enHandoff.length ? ' alerta' : ''}"><b>${enHandoff.length}</b><span>Para Clarck</span></div>
    </div>
    <div class="filtros">
      ${chip('', 'Todos', !zona && !soloHandoff)}
      ${chip('&zona=brena', 'Breña', zona === 'brena')}
      ${chip('&zona=comas', 'Comas', zona === 'comas')}
      ${chip('&zona=otra', 'Otras', zona === 'otra')}
      ${chip('&filtro=handoff', '🔔 Derivados', soloHandoff, 'rojo')}
    </div>
    ${cards || '<p class="vacio">Sin pichangueros en este filtro todavía ⚽</p>'}
    <p class="nota">Se actualiza solo cada 90 s · toca un lead para ver su chat</p>
  `, true);
}

function paginaConversacion(db, key, numero) {
  const lead = db.getOrCreateLead(numero);
  const msgs = db.getHistory(numero, 200);
  const burbujas = msgs.map((m) => `
    <div class="burbuja ${m.rol === 'user' ? 'user' : 'bot'}">${esc(m.texto)}<time>${esc((m.creado_en || '').slice(5, 16))}</time></div>`).join('');

  return baseHtml(`Chat · ${lead.nombre || numero}`, `
    <a class="volver" href="/admin/leads?key=${key}">← Volver al panel</a>
    <header><h1>${esc(lead.nombre || numero)}<span class="punto">.</span></h1></header>
    <div class="chat">${burbujas || '<p class="vacio">Sin mensajes.</p>'}</div>
    <a class="wa" href="https://wa.me/${esc(numero)}" target="_blank">Abrir en WhatsApp →</a>
  `, false);
}

module.exports = { registrarPanel };
