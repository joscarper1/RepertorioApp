/* Pruebas del programa del mes (repertorio-data.js: programaMes), la tabla
   de la vista previa / PDF de eventos.html. `node --test tests/programa-mes.test.js` */
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
const servicio = R.perfilOrg({ id: 'o1', tipoCalendario: 'servicio' });
const repertorio = R.perfilOrg({ id: 'o2' });
const nombres = (celda) => Array.from(celda, (c) => c.nombre);

const eventos = [
  { id: 'e2', fecha: '2026-09-03', hora: '7:00 pm', servicio: 'Culto Filial', estado: 'BORRADOR',
    banda: [{ tipo: 'Protocolo', nombre: 'Juan' }, { tipo: 'Protocolo', nombre: 'Amadeo' }] },
  { id: 'e1', fecha: '2026-09-01', hora: '7:00 pm', servicio: 'Culto Filial', estado: 'PUBLICADO',
    banda: [
      { tipo: 'Alabanza', rol: 'Corista', numero: 1, nombre: 'Marta' },
      { tipo: 'Alabanza', rol: 'Director de Alabanza', numero: 1, nombre: 'Ana' },
      { tipo: 'Protocolo', nombre: 'David' }, { tipo: 'Protocolo', nombre: 'Estefany' },
      { tipo: 'Ofrenda', nombre: '' }, { tipo: 'Hospitalidad', nombre: 'Rosa' }
    ] },
  { id: 'e0', fecha: '2026-09-01', hora: '9:00 am', servicio: 'Culto Filial', estado: 'PUBLICADO', banda: [] },
  { id: 'e3', fecha: '2026-09-08', hora: '7:00 pm', servicio: 'Culto Filial', estado: 'CANCELADO', banda: [{ tipo: 'Protocolo', nombre: 'X' }] },
  { id: 'e4', fecha: '2026-09-10', hora: '7:00 pm', servicio: 'Culto Filial', estado: 'ARCHIVADO', banda: [] },
  { id: 'e5', fecha: '2026-10-01', hora: '7:00 pm', servicio: 'Culto Filial', estado: 'PUBLICADO', banda: [] }
];

test('programa: solo borradores y publicados del mes, por fecha y hora', () => {
  const p = R.programaMes(eventos, '2026-09', servicio);
  assert.deepEqual(Array.from(p.filas, (f) => f.id), ['e0', 'e1', 'e2']);
  assert.equal(p.filas[1].dia, 'Martes');
  assert.equal(p.filas[1].diaNumero, 1);
  assert.equal(p.filas[2].borrador, true);
  assert.equal(p.filas[1].borrador, false);
});

test('programa en servicio: todos los ministerios en orden y los extra al final', () => {
  const p = R.programaMes(eventos, '2026-09', servicio);
  assert.deepEqual(Array.from(p.columnas), ['Protocolo', 'Alabanza', 'Ofrenda', 'Limpieza', 'Oración', 'Infantil', 'Hospitalidad']);
  const e1 = p.filas[1];
  assert.deepEqual(nombres(e1.celdas[0]), ['David', 'Estefany']);
  assert.deepEqual(nombres(e1.celdas[1]), ['Ana', 'Marta'], 'el director va primero');
  assert.equal(e1.celdas[1][0].destacado, true);
  assert.equal(e1.celdas[1][1].destacado, false);
  assert.equal(e1.celdas[2].length, 0, 'sin nombre no cuenta');
  assert.deepEqual(nombres(e1.celdas[6]), ['Rosa']);
});

test('programa en repertorio: solo las columnas con alguien en el mes', () => {
  const evs = [
    { id: 'a', fecha: '2026-09-06', hora: '8:00 am', servicio: 'Cultos Dominicales', estado: 'PUBLICADO',
      banda: [{ tipo: 'Corista', numero: 2, nombre: 'Lia' }, { tipo: 'Director de Alabanza', numero: 1, nombre: 'Tomás' }, { tipo: 'Corista', numero: 1, nombre: 'Eva' }, { tipo: 'Bajo', nombre: '' }] },
    { id: 'b', fecha: '2026-09-09', hora: '7:00 pm', servicio: 'Ensayo', estado: 'PUBLICADO', banda: [{ tipo: 'Piano', nombre: 'Noé' }] }
  ];
  const p = R.programaMes(evs, '2026-09', repertorio);
  assert.deepEqual(Array.from(p.columnas), ['Director de Alabanza', 'Corista']);
  assert.equal(p.filas.length, 1, 'los ensayos no van en el programa');
  assert.deepEqual(nombres(p.filas[0].celdas[1]), ['Eva', 'Lia'], 'ordenados por número');
  assert.equal(p.filas[0].celdas[0][0].destacado, true);
});

test('programa vacío: sin eventos quedan las columnas del perfil', () => {
  const p = R.programaMes([], '2026-09', repertorio);
  assert.equal(p.filas.length, 0);
  assert.equal(p.columnas.length, 7);
});
