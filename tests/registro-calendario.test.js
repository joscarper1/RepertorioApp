/* Pruebas del registro de cuentas que inician sesión desde el calendario
   público (R.ensureUserRegistered con la organización visitada): quedan como
   'normal', en esa organización y marcadas `nuevo`. Firebase falso en
   memoria. `node --test tests/registro-calendario.test.js` */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function cargar(datos) {
  const db = JSON.parse(JSON.stringify(datos || {}));
  const leer = (p) => p.reduce((o, k) => (o == null ? undefined : o[k]), db);
  const escribir = (p, v) => {
    let o = db;
    p.slice(0, -1).forEach((k) => { if (o[k] == null || typeof o[k] !== 'object') o[k] = {}; o = o[k]; });
    if (v === null) delete o[p[p.length - 1]]; else o[p[p.length - 1]] = JSON.parse(JSON.stringify(v));
  };
  const ref = (p) => ({
    child: (k) => ref(p.concat(String(k).split('/'))),
    once: () => Promise.resolve({ val: () => leer(p) ?? null, exists: () => leer(p) != null }),
    set: (v) => { escribir(p, v); return Promise.resolve(); },
    remove: () => { escribir(p, null); return Promise.resolve(); },
    update: (u) => { Object.keys(u).forEach((k) => escribir(p.concat(k.split('/')), u[k])); return Promise.resolve(); }
  });
  const window = {
    RepertorioCifrado: require('../cifrado.js'),
    firebase: { apps: [1], database: () => ({ ref: () => ref([]) }) }
  };
  const ctx = vm.createContext({ window, console, Date, Math, JSON, Promise, Map, encodeURIComponent, setTimeout });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'repertorio-data.js'), 'utf8'), ctx);
  return { R: window.RepertorioData, db };
}
const registrar = (R, user, orgId) => new Promise((resolve) => R.ensureUserRegistered(user, resolve, orgId));
const ana = { uid: 'u1', email: 'ana@example.com', displayName: 'Ana López' };

test('cuenta nueva desde el calendario: normal, en esa organización y marcada nueva', async () => {
  const { R, db } = cargar({ organizations: { o1: { name: 'Iglesia' } } });
  const doc = await registrar(R, ana, 'o1');
  const u = db.users.u1;
  assert.equal(u.displayName, 'Ana López');
  assert.equal(u.role, 'normal');
  assert.deepEqual(u.organizationIds, { o1: true });
  assert.equal(u.nuevo, true);
  assert.equal(doc.nuevo, true);
});

test('cuenta que ya tiene organizaciones: no se le suma la del calendario', async () => {
  const { R, db } = cargar({ users: { u1: { uid: 'u1', email: ana.email, displayName: 'Ana', role: 'editor', organizationIds: { o2: true } } } });
  await registrar(R, ana, 'o1');
  assert.deepEqual(db.users.u1.organizationIds, { o2: true });
  assert.equal(db.users.u1.nuevo, undefined);
  assert.equal(db.users.u1.role, 'editor');
});

test('sin organización visitada (bienvenida): queda sin organizaciones ni marca', async () => {
  const { R, db } = cargar();
  await registrar(R, ana);
  assert.equal(db.users.u1.organizationIds, undefined);
  assert.equal(db.users.u1.nuevo, undefined);
});

test('organización de una cookie vieja que ya no existe: queda registrada sin organización', async () => {
  const { R, db } = cargar();
  await registrar(R, ana, 'borrada');
  assert.equal(db.users.u1.displayName, 'Ana López');
  assert.equal(db.users.u1.organizationIds, undefined);
  assert.equal(db.users.u1.nuevo, undefined);
});

test('quitarMarcaNuevo borra la marca', async () => {
  const { R, db } = cargar({ users: { u1: { uid: 'u1', nuevo: true } } });
  assert.equal(await new Promise((r) => R.quitarMarcaNuevo('u1', r)), true);
  assert.equal(db.users.u1.nuevo, undefined);
});
