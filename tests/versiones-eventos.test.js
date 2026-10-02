/* Pruebas del versionado de eventos (repertorio-data.js) con un Firebase
   simulado en memoria: nunca se conecta a la base real.
   `node --test tests/versiones-eventos.test.js` */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

/* Firebase falso con un árbol en memoria (once/update sobre rutas). */
function firebaseFalso({ rechazar = false, datos = {} } = {}) {
  const arbol = JSON.parse(JSON.stringify(datos));
  const escrito = [];
  const leer = (ruta) => ruta.split('/').filter(Boolean).reduce((n, k) => (n == null ? n : n[k]), arbol);
  function ref(ruta) {
    return {
      key: ruta.split('/').pop(),
      child: (k) => ref(ruta ? ruta + '/' + k : k),
      once: () => Promise.resolve({ val: () => (leer(ruta) === undefined ? null : leer(ruta)) }),
      update: (v) => {
        escrito.push({ ruta, v });
        if (rechazar) return Promise.reject(new Error('PERMISSION_DENIED'));
        const partes = ruta.split('/').filter(Boolean);
        let n = arbol;
        partes.forEach((k) => { n[k] = n[k] || {}; n = n[k]; });
        Object.assign(n, JSON.parse(JSON.stringify(v)));
        return Promise.resolve();
      }
    };
  }
  const database = () => ({ ref: () => ref('') });
  database.ServerValue = { TIMESTAMP: { '.sv': 'timestamp' } };
  const auth = () => ({ currentUser: { uid: 'u1' } });
  return { fb: { apps: [1], initializeApp() {}, database, auth }, escrito, arbol };
}

function cargar(fb) {
  const window = { RepertorioCifrado: require('../cifrado.js'), firebase: fb };
  const ctx = vm.createContext({ window, console, Date, Math, JSON, Promise, Map, encodeURIComponent, setTimeout });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'repertorio-data.js'), 'utf8'), ctx);
  return window.RepertorioData;
}

const copia = (x) => JSON.parse(JSON.stringify(x));

const PUBLICADO = {
  id: 'e1', organizationId: 'o1', estado: 'PUBLICADO', fecha: '2026-09-27', hora: '9:00 am',
  servicio: 'Cultos Dominicales', tema: 'Gracia',
  banda: [{ tipo: 'Piano', nombre: 'Carlos', musicianId: 'm2', estadoConfirmacion: 'aceptado' }],
  integrantes: { m2: true },
  bloques: [{ titulo: 'Júbilo', canciones: [{ t: 'Canción A' }] }]
};

const versionar = (R, anterior, nuevo) => new Promise((ok) => R.versionarEvento(anterior, nuevo, 'o1', { uid: 'u1', nombre: 'Jose' }, ok));

test('un borrador no crea versiones', () => {
  const R = cargar(firebaseFalso().fb);
  assert.equal(R.planVersionEvento(null, Object.assign(copia(PUBLICADO), { estado: 'BORRADOR' }), []), null);
});

test('cualquier evento publicado se versiona, tenga o no repertorio', () => {
  const R = cargar(firebaseFalso().fb);
  const sinRepertorio = { id: 'e2', estado: 'PUBLICADO', servicio: 'Capacitación', fecha: '2026-10-01', hora: '', detalles: 'x' };
  assert.equal(R.planVersionEvento(null, sinRepertorio, []).version, 1);
});

test('publicar un evento nuevo crea la v1', () => {
  const R = cargar(firebaseFalso().fb);
  const plan = R.planVersionEvento(null, PUBLICADO, []);
  assert.equal(plan.version, 1);
  assert.equal(plan.entradas.length, 1);
  const c = plan.entradas[0].evento;
  for (const k of ['id', 'organizationId', 'estado', 'fecha', 'integrantes', 'version']) assert.ok(!(k in c), k);
  assert.ok(!('estadoConfirmacion' in c.banda[0]));
});

test('un evento publicado antes del versionado estrena la v1 con su contenido previo', () => {
  const R = cargar(firebaseFalso().fb);
  const nuevo = Object.assign(copia(PUBLICADO), { tema: 'Fe' });
  const plan = R.planVersionEvento(PUBLICADO, nuevo, []);
  assert.equal(plan.version, 2);
  assert.equal(plan.entradas.map((e) => e.n).join(','), '1,2');
  assert.equal(plan.entradas[0].evento.tema, 'Gracia');
  assert.equal(plan.entradas[1].evento.tema, 'Fe');
});

test('guardar sin cambios no crea otra versión (ni por campos vacíos o confirmaciones)', () => {
  const R = cargar(firebaseFalso().fb);
  const anterior = Object.assign(copia(PUBLICADO), { version: 3 });
  const versiones = [{ n: 3, evento: R.planVersionEvento(null, PUBLICADO, []).entradas[0].evento }];
  const igual = R.newEvento(copia(anterior));
  igual.banda[0].estadoConfirmacion = 'rechazado';
  const plan = R.planVersionEvento(anterior, igual, versiones);
  assert.equal(plan.version, 3);
  assert.equal(plan.entradas.length, 0);
});

test('quitar filas de canción vacías o secciones sin canciones no cuenta como cambio', () => {
  const R = cargar(firebaseFalso().fb);
  const conHuecos = Object.assign(copia(PUBLICADO), {
    bloques: [
      { titulo: 'Júbilo', canciones: [{ t: 'Canción A' }, { t: '', d: '', k: '', u: '', sm: '' }] },
      { titulo: 'Ofrenda', canciones: [{ t: '', d: '', k: '', u: '', sm: '' }] }
    ]
  });
  /* El asistente ya no guarda los huecos, y Firebase no devuelve el arreglo vacío. */
  const sinHuecos = Object.assign(copia(PUBLICADO), {
    bloques: [{ titulo: 'Júbilo', canciones: [{ t: 'Canción A' }] }, { titulo: 'Ofrenda', canciones: [] }]
  });
  const deLaNube = Object.assign(copia(PUBLICADO), { bloques: [{ titulo: 'Júbilo', canciones: [{ t: 'Canción A' }] }, { titulo: 'Ofrenda' }] });
  assert.ok(R.mismoContenidoEvento(conHuecos, sinHuecos));
  assert.ok(R.mismoContenidoEvento(sinHuecos, deLaNube));
  assert.ok(!R.mismoContenidoEvento(sinHuecos, Object.assign(copia(PUBLICADO), { bloques: [{ titulo: 'Júbilo', canciones: [{ t: 'Canción B' }] }, { titulo: 'Ofrenda' }] })));
});

test('las secciones de un evento nuevo arrancan sin filas vacías', () => {
  const R = cargar(firebaseFalso().fb);
  const ev = R.newEvento({ fecha: '2026-10-04' });
  assert.ok(ev.bloques.length > 0);
  assert.ok(ev.bloques.every((bl) => bl.canciones.length === 0));
  assert.ok(R.nuevaParte(2).every((bl) => bl.parte === 2 && bl.canciones.length === 0));
});

test('versionarEvento escribe v{n} y devuelve el número nuevo', async () => {
  const { fb, arbol } = firebaseFalso();
  const R = cargar(fb);
  assert.equal(await versionar(R, null, PUBLICADO), 1);
  const nuevo = Object.assign(copia(PUBLICADO), { tema: 'Fe', version: 1 });
  assert.equal(await versionar(R, Object.assign(copia(PUBLICADO), { version: 1 }), nuevo), 2);
  const v = arbol.eventVersions.e1;
  assert.deepEqual(Object.keys(v).sort(), ['v1', 'v2']);
  assert.equal(v.v2.evento.tema, 'Fe');
  assert.equal(v.v2.autorNombre, 'Jose');
  assert.equal(v.v2.organizationId, 'o1');
});

test('si la base rechaza las versiones, el evento conserva su número anterior', async () => {
  const { fb } = firebaseFalso({ rechazar: true });
  const R = cargar(fb);
  const errorOriginal = console.error;
  console.error = () => {};
  try {
    const anterior = Object.assign(copia(PUBLICADO), { version: 4 });
    assert.equal(await versionar(R, anterior, Object.assign(copia(anterior), { tema: 'Otro' })), 4);
    assert.equal(await versionar(R, null, PUBLICADO), null);
  } finally {
    console.error = errorOriginal;
  }
});

test('eventoDesdeVersion conserva fecha, estado y confirmaciones del evento actual', () => {
  const R = cargar(firebaseFalso().fb);
  const version = { n: 1, evento: { hora: '8:00 am', tema: 'Viejo', banda: [{ tipo: 'Piano', nombre: 'Carlos', musicianId: 'm2' }], bloques: [] } };
  const actual = Object.assign(copia(PUBLICADO), { fecha: '2026-10-04', estado: 'CANCELADO', version: 2 });
  const ev = R.eventoDesdeVersion(version, actual);
  assert.equal(ev.tema, 'Viejo');
  assert.equal(ev.fecha, '2026-10-04');
  assert.equal(ev.estado, 'CANCELADO');
  assert.equal(ev.id, 'e1');
  assert.equal(ev.banda[0].estadoConfirmacion, 'aceptado');
});

test('regresar a una versión anterior no crea copia: el evento vuelve a ese número', async () => {
  const { fb, arbol } = firebaseFalso();
  const R = cargar(fb);
  assert.equal(await versionar(R, null, PUBLICADO), 1);
  const v1 = Object.assign(copia(PUBLICADO), { version: 1 });
  const v2 = Object.assign(copia(PUBLICADO), { tema: 'Fe', version: 2 });
  assert.equal(await versionar(R, v1, v2), 2);
  // Se carga la v1 desde el menú y se guarda tal cual
  const restaurado = R.eventoDesdeVersion(arbol.eventVersions.e1.v1, v2);
  const r = await new Promise((ok) => R.versionarEvento(v2, restaurado, 'o1', {}, (n, creada) => ok({ n, creada })));
  assert.equal(r.n, 1);
  assert.equal(r.creada, false);
  assert.deepEqual(Object.keys(arbol.eventVersions.e1).sort(), ['v1', 'v2']);
  // Editar después de regresar crea la siguiente a la más alta (v3), sin pisar la v2
  const editado = Object.assign(copia(restaurado), { tema: 'Esperanza', version: 1 });
  const r2 = await new Promise((ok) => R.versionarEvento(Object.assign(copia(restaurado), { version: 1 }), editado, 'o1', {}, (n, creada) => ok({ n, creada })));
  assert.equal(r2.n, 3);
  assert.equal(r2.creada, true);
  assert.equal(arbol.eventVersions.e1.v2.evento.tema, 'Fe');
});
