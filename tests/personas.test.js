/* Pruebas de renombrar una persona (repertorio-data.js): el nombre se
   reescribe en los puestos de banda de los eventos, porque Personas es la
   fuente y cada puesto guarda solo una copia.
   `node --test tests/personas.test.js` */
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

const yessy = { id: 'm1', organizationId: 'o1', nombre: 'Yessy Sorto', aliases: ['Yessy Sorto', 'Yessi'] };

test('cambiosRenombrePersona: reescribe los puestos de la persona y deja el nombre anterior como variante', () => {
  const R = cargar();
  const eventos = [
    { id: 'e1', banda: [
      { id: 's1', nombre: 'yessy sorto', musicianId: 'm1' },
      { id: 's2', nombre: 'Otra Persona', musicianId: 'm2' }
    ] },
    { id: 'e2', banda: [
      { id: 's3', nombre: 'Yessi', musicianId: null },
      { id: 's4', nombre: 'YESSY SORTO', musicianId: 'm1' }
    ] }
  ];
  const r = R.cambiosRenombrePersona(yessy, 'YESSY SORTO', eventos);
  assert.equal(r.puestos, 2);
  assert.equal(r.updates['events/e1/banda/0/nombre'], 'YESSY SORTO');
  assert.equal(r.updates['events/e1/banda/1/nombre'], undefined);
  assert.equal(r.updates['events/e2/banda/0/nombre'], 'YESSY SORTO');
  assert.equal(r.updates['events/e2/banda/0/musicianId'], 'm1');
  assert.equal(r.updates['events/e2/banda/1/nombre'], undefined);
  assert.equal(r.updates['musicians/m1/nombre'], 'YESSY SORTO');
  assert.deepEqual([...r.updates['musicians/m1/aliases']], ['Yessy Sorto', 'Yessi', 'YESSY SORTO']);
});

test('cambiosRenombrePersona: no toca puestos de otra persona aunque compartan variante', () => {
  const R = cargar();
  const eventos = [{ id: 'e1', banda: [{ id: 's1', nombre: 'Yessi', musicianId: 'm9' }] }];
  const r = R.cambiosRenombrePersona(yessy, 'Yessenia Sorto', eventos);
  assert.equal(r.puestos, 0);
  assert.equal(Object.keys(r.updates).filter((k) => k.startsWith('events/')).length, 0);
});
