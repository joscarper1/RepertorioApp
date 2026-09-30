/* Pruebas del balance de participaciones (repertorio-data.js: cargaDelMes,
   ocupadosMismoDia, candidatosParaPuesto). `node --test tests/balance.test.js` */
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
const nombres = (lista) => Array.from(lista, (c) => c.nombre);

const eventos = [
  { id: 'e1', fecha: '2026-10-04', hora: '8:00 am', servicio: 'Cultos Dominicales', estado: 'PUBLICADO',
    banda: [{ tipo: 'Protocolo', nombre: 'Ana' }, { tipo: 'Ofrenda', nombre: 'ana ' }, { tipo: 'Limpieza', nombre: 'Beto' }] },
  { id: 'e2', fecha: '2026-10-08', hora: '7:00 pm', servicio: 'Culto Filial', estado: 'BORRADOR',
    banda: [{ tipo: 'Protocolo', nombre: 'Ana' }, { tipo: 'Limpieza', nombre: '' }] },
  { id: 'e3', fecha: '2026-10-08', hora: '9:00 pm', servicio: 'Vigilia Filial', estado: 'CANCELADO',
    banda: [{ tipo: 'Protocolo', nombre: 'Carla' }] },
  { id: 'e4', fecha: '2026-10-08', hora: '5:00 pm', servicio: 'Capacitación', estado: 'PUBLICADO',
    banda: [{ tipo: 'Protocolo', nombre: 'Dani' }] },
  { id: 'e5', fecha: '2026-11-01', hora: '8:00 am', servicio: 'Cultos Dominicales', estado: 'PUBLICADO',
    banda: [{ tipo: 'Protocolo', nombre: 'Beto' }] }
];

test('carga del mes: cuenta eventos (no puestos), solo borradores y publicados del mes', () => {
  const c = R.cargaDelMes(eventos, '2026-10');
  assert.equal(c.ana.total, 2, 'dos puestos en e1 cuentan como una participación');
  assert.equal(c.ana.puestos.Protocolo, 2);
  assert.equal(c.ana.puestos.Ofrenda, 1);
  assert.equal(c.beto.total, 1, 'noviembre no cuenta');
  assert.equal(c.carla, undefined, 'un evento cancelado no cuenta');
  assert.equal(c.dani.total, 1);
  /* Se excluye el evento que se está editando */
  assert.equal(R.cargaDelMes(eventos, '2026-10', 'e2').ana.total, 1);
  assert.equal(R.textoCarga(1), '1 vez este mes');
  assert.equal(R.textoCarga(3), '3 veces este mes');
});

test('ocupados el mismo día: otros eventos de esa fecha, sin el que se edita ni cancelados', () => {
  const o = R.ocupadosMismoDia(eventos, '2026-10-08', 'e2');
  assert.deepEqual(Object.keys(o), ['dani']);
  assert.deepEqual(Array.from(o.dani), ['Capacitación 5:00 pm']);
  assert.deepEqual(Object.keys(R.ocupadosMismoDia(eventos, '2026-10-08', 'e4')), ['ana']);
});

test('candidatos: menos carga primero y se descarta a quien no puede', () => {
  const carga = R.cargaDelMes(eventos, '2026-10', 'nuevo');
  const base = { candidatos: ['Ana', 'Beto', 'Dani', 'Eva', 'Fer'], tipo: 'Protocolo', carga };
  assert.deepEqual(nombres(R.candidatosParaPuesto(base)), ['Eva', 'Fer', 'Beto', 'Dani', 'Ana']);
  /* A igual carga, quien menos veces ha tenido ese puesto (Dani ya fue Protocolo) */
  assert.deepEqual(nombres(R.candidatosParaPuesto(Object.assign({}, base, { candidatos: ['Dani', 'Beto'] }))), ['Beto', 'Dani']);
  const filtrado = R.candidatosParaPuesto(Object.assign({}, base, {
    enEvento: { eva: true }, mismoDia: { fer: ['X'] }, noDisponibles: { beto: true }
  }));
  assert.deepEqual(nombres(filtrado), ['Dani', 'Ana']);
  assert.equal(filtrado[0].total, 1);
  assert.equal(R.candidatosParaPuesto({ candidatos: [] }).length, 0);
});

test('un ensayo no cuenta (copia la banda de su evento)', () => {
  const evs = [{ id: 'x', fecha: '2026-10-03', servicio: 'Ensayo', estado: 'PUBLICADO', banda: [{ tipo: 'Corista', nombre: 'Ana' }] }];
  assert.equal(R.cargaDelMes(evs, '2026-10').ana, undefined);
  assert.equal(R.ocupadosMismoDia(evs, '2026-10-03').ana, undefined);
});
