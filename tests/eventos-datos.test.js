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
  evento.servicio = 'Otro tipo';
  delete evento.aviso;

  assert.equal(await guardar(R, evento, ORIGINAL), true);
  assert.equal(escrito.length, 1);
  assert.equal(escrito[0].ruta, 'events/e1');
  const v = escrito[0].v;
  for (const k of ['id', 'organizationId', 'estado', 'integrantes', 'banda', 'fecha', 'servicio']) assert.ok(!(k in v), k + ' no debe escribirse');
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

test('horaPorServicio da la hora predefinida de cada tipo de evento', () => {
  const R = cargar(firebaseFalso().fb);
  assert.equal(R.horaPorServicio('Cultos Dominicales'), '8:00 am');
  assert.equal(R.horaPorServicio('Culto Familiar'), '6:30 pm');
  assert.equal(R.horaPorServicio('Vigilia General'), '7:00 pm');
  assert.equal(R.horaPorServicio('Vigilia Juvenil'), '7:00 pm');
  assert.equal(R.horaPorServicio('Capacitación'), '');
  assert.equal(R.newEvento({ servicio: 'Culto Familiar' }).hora, '6:30 pm');
  assert.equal(R.newEvento({ servicio: 'Culto Familiar', hora: '5:00 pm' }).hora, '5:00 pm');
});

test('horaAlCambiarServicio respeta la hora ajustada a mano', () => {
  const R = cargar(firebaseFalso().fb);
  // Hora predefinida (de cualquier tipo) → se cambia a la del nuevo
  assert.equal(R.horaAlCambiarServicio('8:00 am', 'Culto Familiar'), '6:30 pm');
  assert.equal(R.horaAlCambiarServicio('7:00 pm', 'Cultos Dominicales'), '8:00 am');
  assert.equal(R.horaAlCambiarServicio('', 'Vigilia General'), '7:00 pm');
  // Hora ajustada a mano → se conserva
  assert.equal(R.horaAlCambiarServicio('9:30 am', 'Culto Familiar'), '9:30 am');
  // Tipo nuevo sin hora predefinida → se conserva la actual
  assert.equal(R.horaAlCambiarServicio('6:30 pm', 'Capacitación'), '6:30 pm');
});

test('publicarEventos marca todos como PUBLICADO en una sola escritura', async () => {
  const { fb, escrito } = firebaseFalso();
  const R = cargar(fb);
  const ok = await new Promise((fin) => R.publicarEventos(['e1', 'e2'], fin));
  assert.equal(ok, true);
  assert.equal(escrito.length, 1);
  assert.equal(escrito[0].ruta, 'events');
  assert.deepEqual({ ...escrito[0].v }, { 'e1/estado': 'PUBLICADO', 'e2/estado': 'PUBLICADO' });
  // Sin ids no escribe nada
  assert.equal(await new Promise((fin) => R.publicarEventos([], fin)), false);
  assert.equal(escrito.length, 1);
});

test('cancionesEvento cuenta solo las canciones con título', () => {
  const R = cargar(firebaseFalso().fb);
  assert.equal(R.cancionesEvento(R.newEvento({ servicio: 'Cultos Dominicales' })), 0);
  assert.equal(R.cancionesEvento({ bloques: [{ canciones: [{ t: ' ' }, { t: 'Santo' }] }, { canciones: [{ t: 'Digno' }] }] }), 2);
  assert.equal(R.cancionesEvento(null), 0);
});
