/* Pruebas de permisos por puesto en el evento (repertorio-data.js,
   puedeSobreEvento). Sin Firebase: solo funciones puras.
   `node --test tests/permisos.test.js` */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function cargar() {
  const window = { RepertorioCifrado: require('../cifrado.js') };
  const ctx = vm.createContext({ window, console, Date, Math, JSON, Promise, Map, encodeURIComponent, setTimeout });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'repertorio-data.js'), 'utf8'), ctx);
  return window.RepertorioData;
}
const R = cargar();

const usuario = (musicianId, role) => ({ role: role || 'normal', musicianLinks: { o1: musicianId } });
const evento = (slots) => ({ id: 'e1', organizationId: 'o1', banda: slots });
const slot = (tipo, musicianId, nombre) => ({ tipo, musicianId, nombre: nombre === undefined ? 'X' : nombre });

for (const permiso of ['eventos.editar', 'canciones.editar', 'cifrados.editar']) {
  test(permiso + ': asignado como Director de Alabanza en el evento sí puede', () => {
    assert.equal(R.puedeSobreEvento(usuario('d'), permiso, evento([slot('Director de Alabanza', 'd')])), true);
    /* Director y además otro puesto en el mismo evento */
    assert.equal(R.puedeSobreEvento(usuario('d'), permiso, evento([slot('Corista', 'd'), slot('Director de Alabanza', 'd')])), true);
  });

  test(permiso + ': participa pero no como Director no puede', () => {
    assert.equal(R.puedeSobreEvento(usuario('d'), permiso, evento([slot('Corista', 'd'), slot('Director de Alabanza', 'otro')])), false);
    assert.equal(R.puedeSobreEvento(usuario('m'), permiso, evento([slot('Bajo', 'm')])), false);
  });

  test(permiso + ': no participa no puede', () => {
    assert.equal(R.puedeSobreEvento(usuario('d'), permiso, evento([slot('Director de Alabanza', 'otro')])), false);
  });

  test(permiso + ': admin siempre puede', () => {
    assert.equal(R.puedeSobreEvento({ role: 'admin' }, permiso, evento([])), true);
  });
}

test('puesto de Director sin nombre (vacío) o sin cuenta vinculada no cuenta', () => {
  assert.equal(R.puedeSobreEvento(usuario('d'), 'eventos.editar', evento([slot('Director de Alabanza', 'd', '')])), false);
  assert.equal(R.puedeSobreEvento({ role: 'normal' }, 'eventos.editar', evento([slot('Director de Alabanza', 'd')])), false);
});

test('el puesto de Director no da mover ni banda', () => {
  const ev = evento([slot('Director de Alabanza', 'd')]);
  assert.equal(R.puedeSobreEvento(usuario('d'), 'eventos.mover', ev), false);
  assert.equal(R.puedeSobreEvento(usuario('d'), 'banda.editar', ev), false);
  assert.equal(R.puede(usuario('d'), 'eventos.editar'), false);
});

test('editor: eventos como admin (cualquier evento, sin estar en la banda) y Repertorio', () => {
  const editor = { role: 'editor' };
  for (const p of ['eventos.ver', 'eventos.crear', 'eventos.editar', 'eventos.mover', 'eventos.estado', 'eventos.todos',
    'eventos.tipo', 'banda.editar', 'canciones.editar', 'cifrados.editar', 'repertorio.gestionar']) {
    assert.equal(R.puede(editor, p), true, p);
  }
  const ev = evento([slot('Director de Alabanza', 'otro')]);
  for (const p of ['eventos.editar', 'eventos.mover', 'canciones.editar', 'cifrados.editar', 'banda.editar']) {
    assert.equal(R.puedeSobreEvento(editor, p, ev), true, p);
  }
});

test('editor: sin usuarios, organizaciones ni avisos', () => {
  for (const p of ['usuarios.gestionar', 'organizaciones.gestionar', 'avisos.gestionar']) {
    assert.equal(R.puede({ role: 'editor' }, p), false, p);
  }
});

test('rolLabel y ROLES incluyen al editor', () => {
  assert.equal(R.ROLES.map((r) => r.id).join(','), 'normal,editor,admin');
  assert.equal(R.rolLabel('editor'), 'Editor');
  assert.equal(R.rolLabel(undefined), 'Normal');
});

test('puedeVerEventos: admin y editor siempre; normal solo si es director', () => {
  const ev = (fecha, slots) => Object.assign(evento(slots), { fecha });
  const hoy = '2026-10-04';
  assert.equal(R.puedeVerEventos(usuario('d', 'admin'), [], null, null, hoy), true);
  assert.equal(R.puedeVerEventos(usuario('d', 'editor'), [], null, null, hoy), true);
  assert.equal(R.puedeVerEventos(usuario('d'), [], null, null, hoy), false);
  assert.equal(R.puedeVerEventos(null, [], null, null, hoy), false);
  /* Rol de director en su perfil */
  assert.equal(R.puedeVerEventos(usuario('d'), [], { rolesBanda: ['Director de Alabanza'] }, null, hoy), true);
  assert.equal(R.puedeVerEventos(usuario('d'), [], { rolesBanda: ['Corista'] }, null, hoy), false);
  /* Director en un evento próximo sí; en uno pasado o como corista, no */
  assert.equal(R.puedeVerEventos(usuario('d'), [ev('2026-10-11', [slot('Director de Alabanza', 'd')])], null, null, hoy), true);
  assert.equal(R.puedeVerEventos(usuario('d'), [ev('2026-09-27', [slot('Director de Alabanza', 'd')])], null, null, hoy), false);
  assert.equal(R.puedeVerEventos(usuario('d'), [ev('2026-10-11', [slot('Corista', 'd')])], null, null, hoy), false);
});
