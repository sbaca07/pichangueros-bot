#!/usr/bin/env node
/**
 * Corre la suite entera y devuelve 0 solo si TODO pasó.
 *
 *   npm test
 *
 * Existía como un `for f in test-*.js; do node "$f"; done` escrito a mano en el
 * CLAUDE.md. Eso tiene dos problemas: hay que acordarse de escribirlo, y no
 * devuelve un código de salida útil —el `for` termina bien aunque un test haya
 * fallado en el medio—, así que no se puede colgar nada de él. El hook de
 * pre-push necesita justamente eso: una sola cosa que diga sí o no.
 *
 * Node puro y sin dependencias, a propósito: esto tiene que correr igual en
 * Windows, en el contenedor y en la máquina de cualquiera.
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const RAIZ = __dirname;
const archivos = fs.readdirSync(RAIZ)
  .filter((f) => /^test-.*\.js$/.test(f))
  .sort();

if (!archivos.length) {
  console.error('No encontré ningún test-*.js. ¿Estás parado en la raíz del repo?');
  process.exit(1);
}

const soloEste = process.argv[2];
const aCorrer = soloEste ? archivos.filter((f) => f.includes(soloEste)) : archivos;
if (soloEste && !aCorrer.length) {
  console.error(`Ningún test coincide con "${soloEste}". Hay: ${archivos.join(', ')}`);
  process.exit(1);
}

const arranque = Date.now();
const rotos = [];
let checks = 0;

for (const f of aCorrer) {
  const r = spawnSync(process.execPath, [path.join(RAIZ, f)], { encoding: 'utf8', cwd: RAIZ });
  const salida = `${r.stdout || ''}${r.stderr || ''}`;
  const m = salida.match(/(\d+) checks OK/g);
  const n = m ? Number(m[m.length - 1].match(/\d+/)[0]) : 0;
  if (r.status === 0) {
    checks += n;
    console.log(`  ✓ ${f.padEnd(26)} ${n} checks`);
  } else {
    rotos.push(f);
    console.error(`  ✗ ${f}`);
    // Solo las líneas que fallaron: el volcado entero esconde el motivo.
    const fallas = salida.split('\n').filter((l) => l.includes('✗') || /^\s*(Error|TypeError|ReferenceError|SyntaxError|AssertionError)/.test(l));
    for (const l of fallas.slice(0, 12)) console.error(`      ${l.trim()}`);
    if (!fallas.length) console.error(`      (salió con código ${r.status} y sin decir por qué — mirá: node ${f})`);
  }
}

const seg = ((Date.now() - arranque) / 1000).toFixed(0);
console.log('');
if (rotos.length) {
  console.error(`❌ ${rotos.length} archivo(s) en rojo: ${rotos.join(', ')}  ·  ${seg}s`);
  console.error('   Un test rojo es un rollback esperando ocurrir, y este sistema maneja plata ajena.');
  process.exit(1);
}
console.log(`✅ ${checks} checks OK en ${aCorrer.length} archivos  ·  ${seg}s`);
