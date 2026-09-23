/* Pruebas de la capa de datos de cifrados (repertorio-data.js) con un
   Firebase simulado en memoria: nunca se conecta a la base real.
   `node --test tests/cifrados-datos.test.js` */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

/* Firebase falso: guarda lo escrito en `escrito` y responde lecturas desde `datos`. */
function firebaseFalso({ uid = 'u1', rechazar = false, datos = {} } = {}) {
  const escrito = [];
  let n = 0;
  function ref(ruta) {
    return {
      key: ruta.split('/').pop(),
      child: (k) => ref(ruta ? ruta + '/' + k : k),
      push: () => ref(ruta + '/-nuevo' + (++n)),
      update: (v) => { escrito.push({ ruta, v }); return rechazar ? Promise.reject(new Error('PERMISSION_DENIED')) : Promise.resolve(); },
      once: () => Promise.resolve({ val: () => (ruta in datos ? datos[ruta] : null) })
    };
  }
  const database = () => ({ ref: () => ref('') });
  database.ServerValue = { TIMESTAMP: { '.sv': 'timestamp' } };
  const auth = () => ({ currentUser: uid ? { uid } : null });
  return { fb: { apps: [1], initializeApp() {}, database, auth }, escrito };
}

function cargar(fb) {
  const window = { RepertorioCifrado: require('../cifrado.js'), firebase: fb };
  const ctx = vm.createContext({ window, console, Date, Math, JSON, Promise, Map, encodeURIComponent, setTimeout });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'repertorio-data.js'), 'utf8'), ctx);
  return window.RepertorioData;
}

const CIFRADO = {
  titulo: ' Canción de prueba ', artista: 'Artista',
  fuenteUrl: 'https://acordes.lacuerda.net/artista/cancion',
  tonoOriginal: ' A ',
  lineas: [{ t: 'a', x: 'A   D', i: [[0, 'A'], [4, 'D']] }, { t: 'l', x: 'letra' }]
};

test('prepararCifrado normaliza y rechaza datos incompletos', () => {
  const R = cargar(firebaseFalso().fb);
  const p = R.prepararCifrado(CIFRADO);
  assert.equal(p.fuenteUrl, 'https://acordes.lacuerda.net/artista/cancion.shtml');
  assert.equal(p.tonoOriginal, 'A');
  assert.equal(p.titulo, 'Canción de prueba');
  // El enlace es opcional y puede ser de otra fuente; solo se rechaza si no es http(s)
  assert.equal(R.prepararCifrado({ ...CIFRADO, fuenteUrl: '' }).fuenteUrl, '');
  assert.equal(R.prepararCifrado({ ...CIFRADO, fuenteUrl: ' https://www.cifraclub.com/x/y/ ' }).fuenteUrl, 'https://www.cifraclub.com/x/y/');
  assert.equal(R.prepararCifrado({ ...CIFRADO, fuenteUrl: 'javascript:alert(1)' }), null);
  assert.equal(R.prepararCifrado({ ...CIFRADO, fuenteUrl: 'no es un enlace' }), null);
  assert.equal(R.prepararCifrado({ ...CIFRADO, tonoOriginal: 'Original' }), null);
  assert.equal(R.prepararCifrado({ ...CIFRADO, tonoOriginal: '' }), null);
  assert.equal(R.prepararCifrado({ ...CIFRADO, tonoOriginal: 'xx' }), null);
  assert.equal(R.prepararCifrado({ ...CIFRADO, lineas: [{ t: 'l', x: 'solo letra' }] }), null);
  // Campos extra y posiciones fuera de la línea se descartan
  const sucio = R.prepararCifrado({ ...CIFRADO, html: '<script>', lineas: [{ t: 'a', x: 'A', i: [[0, 'A'], [9, 'E'], ['0', 'D']], extra: 1 }] });
  assert.deepEqual(Object.keys(sucio).sort(), ['artista', 'fuenteUrl', 'lineas', 'titulo', 'tonoOriginal']);
  assert.deepEqual(JSON.parse(JSON.stringify(sucio.lineas)), [{ t: 'a', x: 'A', i: [[0, 'A']] }]);
});

test('saveCifrado crea con push y campos de auditoría', async () => {
  const { fb, escrito } = firebaseFalso();
  const R = cargar(fb);
  const r = await new Promise((ok) => R.saveCifrado('org1', '', CIFRADO, (bien, id) => ok({ bien, id })));
  assert.deepEqual(r, { bien: true, id: '-nuevo1' });
  assert.equal(escrito.length, 1);
  assert.equal(escrito[0].ruta, 'cifrados/org1/-nuevo1');
  const v = escrito[0].v;
  assert.equal(v.createdBy, 'u1');
  assert.equal(v.updatedBy, 'u1');
  assert.deepEqual(v.updatedAt, { '.sv': 'timestamp' });
  // Queda en caché: leerlo no vuelve a la base
  const leido = await new Promise((ok) => R.getCifrado('org1', '-nuevo1', (c) => ok(c)));
  assert.equal(leido.tonoOriginal, 'A');
});

test('saveCifrado reemplaza sin tocar createdAt/createdBy', async () => {
  const { fb, escrito } = firebaseFalso();
  const R = cargar(fb);
  const ok = await new Promise((res) => R.saveCifrado('org1', 'c9', CIFRADO, (b) => res(b)));
  assert.equal(ok, true);
  assert.equal(escrito[0].ruta, 'cifrados/org1/c9');
  assert.equal('createdAt' in escrito[0].v, false);
  assert.equal('createdBy' in escrito[0].v, false);
});

test('saveCifrado sin enlace: lo borra al reemplazar', async () => {
  const { fb, escrito } = firebaseFalso();
  const R = cargar(fb);
  const ok = await new Promise((res) => R.saveCifrado('org1', 'c9', { ...CIFRADO, fuenteUrl: '' }, (b) => res(b)));
  assert.equal(ok, true);
  assert.equal(escrito[0].v.fuenteUrl, null);
});

test('saveCifrado no escribe sin sesión o con datos inválidos, y reporta el rechazo', async () => {
  const sinSesion = firebaseFalso({ uid: null });
  let R = cargar(sinSesion.fb);
  assert.equal(await new Promise((r) => R.saveCifrado('org1', '', CIFRADO, r)), false);
  assert.equal(sinSesion.escrito.length, 0);
  const normal = firebaseFalso();
  R = cargar(normal.fb);
  assert.equal(await new Promise((r) => R.saveCifrado('org1', '', { ...CIFRADO, tonoOriginal: '' }, r)), false);
  assert.equal(normal.escrito.length, 0);
  const rechazo = firebaseFalso({ rechazar: true });
  R = cargar(rechazo.fb);
  const errores = console.error; console.error = () => {};
  try { assert.equal(await new Promise((r) => R.saveCifrado('org1', '', CIFRADO, r)), false); }
  finally { console.error = errores; }
});

test('getCifrado: inexistente = null sin error', async () => {
  const R = cargar(firebaseFalso({ datos: { 'cifrados/org1/x': { tonoOriginal: 'G' } } }).fb);
  const r1 = await new Promise((ok) => R.getCifrado('org1', 'nada', (c, e) => ok([c, e])));
  assert.deepEqual(r1, [null, null]);
  const r2 = await new Promise((ok) => R.getCifrado('org1', 'x', (c, e) => ok([c, e])));
  assert.equal(r2[0].tonoOriginal, 'G');
  assert.equal(r2[1], null);
});

test('el catálogo propaga el cifrado de los eventos y el override manda', () => {
  const R = cargar(firebaseFalso().fb);
  const cancion = (cid) => ({ t: 'Canción', sm: 'Artista', u: 'https://youtu.be/abc12345678', k: 'G', d: '', cid });
  const eventos = [
    { fecha: '2026-08-01', bloques: [{ canciones: [cancion('viejo')] }] },
    { fecha: '2026-09-01', bloques: [{ canciones: [cancion('nuevo')] }] },
    { fecha: '2026-10-01', bloques: [{ canciones: [cancion(undefined)] }] }
  ];
  let cat = R.buildSongCatalog(eventos, {});
  assert.equal(cat.length, 1);
  assert.equal(cat[0].cifradoId, 'nuevo', 'toma el del evento más reciente que lo tiene');
  // Una canción sin cid en el evento lo toma del catálogo
  assert.equal(R.cifradoIdDeCancion(cancion(undefined), cat), 'nuevo');
  // El suyo propio tiene prioridad
  assert.equal(R.cifradoIdDeCancion(cancion('propio'), cat), 'propio');
  // Override del admin
  cat = R.buildSongCatalog(eventos, { [cat[0].key]: { cifradoId: 'admin' } });
  assert.equal(cat[0].cifradoId, 'admin');
  // Sin coincidencia
  assert.equal(R.cifradoIdDeCancion({ t: 'Otra', sm: '', u: '' }, cat), '');
  assert.equal(R.cifradoIdDeCancion({ t: '', sm: '', u: '' }, cat), '');
  // Canción creada solo en el catálogo (sin eventos)
  const soloCat = R.buildSongCatalog([], { k1: { titulo: 'X', cifradoId: 'c1' } });
  assert.equal(soloCat[0].cifradoId, 'c1');
});

/* Host mínimo del modal (lo que en la página es state.cifrado + setState). */
function hostFalso(R, extra = {}) {
  const h = { cifrado: null, guardados: [] };
  h.ctl = R.modalCifrado(Object.assign({
    estado: () => h.cifrado,
    poner: (v) => { h.cifrado = v; },
    parchar: (p) => { if (h.cifrado) h.cifrado = Object.assign({}, h.cifrado, p); },
    orgId: () => 'org1',
    puedeEditar: () => true,
    alGuardar: (id, c, listo) => { h.guardados.push([id, c.songKey]); listo('Guardado.'); }
  }, extra));
  return h;
}
const espera = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const HTML_LC = '<pre><div></div><a>A</a>    <a>D</a>\nLetra\nIntro: A - E</pre>';
const TXT_LC = 'A    D\nLetra\nIntro: A - E';

test('modalCifrado: importar, el enlace decide el modo, guardar y ver', async () => {
  const { fb, escrito } = firebaseFalso();
  const R = cargar(fb);
  const h = hostFalso(R);
  h.ctl.abrir({ songKey: 'k1', t: 'Canción', sm: 'Artista', k: null }, '');
  assert.equal(h.cifrado.modo, 'importar');
  h.ctl.procesarPegado(HTML_LC, TXT_LC);
  assert.equal(h.cifrado.pegado.origen, 'texto', 'sin enlace: texto plano');
  h.ctl.cambiarUrl('https://acordes.lacuerda.net/a/b');
  assert.equal(h.cifrado.pegado.origen, 'html', 'con LaCuerda: marcas del HTML');
  h.ctl.cambiarUrl('https://otro.com/x');
  assert.equal(h.cifrado.pegado.origen, 'texto');
  assert.equal(h.cifrado.tono, 'A');
  let v = h.ctl.vals();
  assert.equal(v.cifImportar, true);
  assert.equal(v.cifGuardarLabel, 'Guardar cifrado');
  v.guardarCifrado();
  await espera();
  assert.equal(escrito[0].ruta, 'cifrados/org1/-nuevo1');
  assert.equal(escrito[0].v.fuenteUrl, 'https://otro.com/x');
  assert.deepEqual(h.guardados, [['-nuevo1', 'k1']]);
  assert.equal(h.cifrado.modo, 'ver');
  v = h.ctl.vals();
  assert.equal(v.cifVer, true);
  assert.equal(v.cifTonoMostrado, 'A');
  assert.deepEqual(v.cifAvisos, [], 'sin tono configurado (catálogo): sin avisos de tono');
  assert.equal(v.cifFuenteNombre, 'otro.com');
});

test('modalCifrado: abrir uno ya en caché lo muestra (lectura inmediata)', async () => {
  const { fb } = firebaseFalso();
  const R = cargar(fb);
  const h = hostFalso(R);
  await new Promise((ok) => R.saveCifrado('org1', 'c7', CIFRADO, ok));
  h.ctl.abrir({ t: 'Canción', sm: '', k: 'B' }, 'c7');
  assert.equal(h.cifrado.cargando, true);
  await espera();
  assert.equal(h.cifrado.cargando, false);
  const v = h.ctl.vals();
  assert.equal(v.cifTonoMostrado, 'B');
  assert.equal(v.cifTonoOrigenTxt, 'Transpuesto desde A (tono del cifrado)');
  assert.deepEqual(v.cifLineas[0].segs.filter((s) => s.style).map((s) => s.txt), ['B', 'E']);
});

test('modalCifrado: sin permiso no guarda; inexistente pasa a importar', async () => {
  const { fb, escrito } = firebaseFalso();
  const R = cargar(fb);
  const h = hostFalso(R, { puedeEditar: () => false });
  h.ctl.abrir({ t: 'X', sm: '', k: 'C' }, '');
  h.ctl.procesarPegado('', 'C  G\nletra');
  h.ctl.vals().guardarCifrado();
  await espera();
  assert.equal(escrito.length, 0);
  assert.ok(/not-allowed/.test(h.ctl.vals().cifGuardarStyle));
  h.ctl.abrir({ t: 'X', sm: '', k: 'C' }, 'no-existe');
  await espera();
  assert.equal(h.cifrado.modo, 'importar');
  assert.ok(/ya no existe/.test(h.cifrado.aviso));
});

test('permisos: normal y admin pueden editar cifrados', () => {
  const R = cargar(firebaseFalso().fb);
  assert.equal(R.puede({ role: 'normal' }, 'cifrados.editar'), true);
  assert.equal(R.puede({ role: 'admin' }, 'cifrados.editar'), true);
  assert.equal(R.puede(null, 'cifrados.editar'), false);
});
