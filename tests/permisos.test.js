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
