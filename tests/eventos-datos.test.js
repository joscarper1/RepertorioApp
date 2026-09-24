/* Pruebas del guardado de eventos sin banda (repertorio-data.js) con un
   Firebase simulado en memoria: nunca se conecta a la base real.
   `node --test tests/eventos-datos.test.js` */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

/* Firebase falso: guarda lo escrito en `escrito`. */
function firebaseFalso({ rechazar = false } = {}) {
  const escrito = [];
  function ref(ruta) {
    return {
      key: ruta.split('/').pop(),
      child: (k) => ref(ruta ? ruta + '/' + k : k),
      update: (v) => { escrito.push({ ruta, v }); return rechazar ? Promise.reject(new Error('PERMISSION_DENIED')) : Promise.resolve(); }
    };
  }
  const database = () => ({ ref: () => ref('') });
  database.ServerValue = { TIMESTAMP: { '.sv': 'timestamp' } };
  const auth = () => ({ currentUser: { uid: 'u1' } });
  return { fb: { apps: [1], initializeApp() {}, database, auth }, escrito };
}

function cargar(fb) {
  const window = { RepertorioCifrado: require('../cifrado.js'), firebase: fb };
  const ctx = vm.createContext({ window, console, Date, Math, JSON, Promise, Map, encodeURIComponent, setTimeout });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'repertorio-data.js'), 'utf8'), ctx);
  return window.RepertorioData;
}

const ORIGINAL = {
  id: 'e1', organizationId: 'o1', estado: 'PUBLICADO', fecha: '2026-09-27', hora: '9:00 am',
  tema: 'Tema viejo', aviso: 'Llegar temprano',
  banda: [{ tipo: 'Piano', nombre: 'Carlos', musicianId: 'm2', estadoConfirmacion: 'aceptado' }],
  integrantes: { m2: true },
  bloques: [{ titulo: 'Júbilo', canciones: [{ t: 'Vieja' }] }]
};

function guardar(R, evento, original) {
  return new Promise((ok) => R.saveEventSinBanda(evento, original, ok));
}

test('saveEventSinBanda escribe solo los campos editables del evento', async () => {
  const { fb, escrito } = firebaseFalso();
  const R = cargar(fb);
  const evento = JSON.parse(JSON.stringify(ORIGINAL));
  evento.tema = 'Tema nuevo';
  evento.bloques[0].canciones[0].t = 'Nueva';
  // Intentos de tocar lo protegido: se ignoran
  evento.banda[0].nombre = 'Intruso';
  evento.integrantes = { m9: true };
  evento.estado = 'BORRADOR';
  evento.fecha = '2026-10-01';
  evento.organizationId = 'o2';
  delete evento.aviso;

  assert.equal(await guardar(R, evento, ORIGINAL), true);
  assert.equal(escrito.length, 1);
  assert.equal(escrito[0].ruta, 'events/e1');
  const v = escrito[0].v;
  for (const k of ['id', 'organizationId', 'estado', 'integrantes', 'banda', 'fecha']) assert.ok(!(k in v), k + ' no debe escribirse');
  assert.equal(v.tema, 'Tema nuevo');
  assert.equal(v.bloques[0].canciones[0].t, 'Nueva');
  assert.equal(v.hora, '9:00 am');
  // Un campo que se quitó en el borrador se borra en la nube
  assert.ok('aviso' in v);
  assert.equal(v.aviso, null);
});

test('saveEventSinBanda avisa cuando la base rechaza el guardado', async () => {
  const { fb } = firebaseFalso({ rechazar: true });
  const R = cargar(fb);
  const errorOriginal = console.error;
  console.error = () => {};
  try {
    assert.equal(await guardar(R, ORIGINAL, ORIGINAL), false);
  } finally {
    console.error = errorOriginal;
  }
});

test('saveEventSinBanda no escribe nada sin id de evento', async () => {
  const { fb, escrito } = firebaseFalso();
  const R = cargar(fb);
  assert.equal(await guardar(R, { tema: 'x' }, null), false);
  assert.equal(escrito.length, 0);
});
