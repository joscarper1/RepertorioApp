/* Pruebas del calendario preferido (cookie repertorio_org) y de la
   organización con que arranca una cuenta (repertorio-data.js).
   `node --test tests/preferencia-org.test.js` */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

/* document.cookie mínimo: guarda "nombre=valor" y respeta max-age=0. */
function documentoFalso() {
  const jar = {};
  const escritas = [];
  return {
    escritas,
    get cookie() { return Object.keys(jar).map((k) => k + '=' + jar[k]).join('; '); },
    set cookie(v) {
      escritas.push(v);
      const [par, ...attrs] = v.split(';').map((x) => x.trim());
      const i = par.indexOf('=');
      const k = par.slice(0, i), val = par.slice(i + 1);
      if (attrs.some((a) => a === 'max-age=0')) delete jar[k]; else jar[k] = val;
    }
  };
}

function cargar() {
  const document = documentoFalso();
  const window = { RepertorioCifrado: require('../cifrado.js'), document, location: { pathname: '/RepertorioApp/index.html' } };
  const ctx = vm.createContext({ window, console, Date, Math, JSON, Promise, Map, encodeURIComponent, decodeURIComponent, setTimeout, RegExp, String });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'repertorio-data.js'), 'utf8'), ctx);
  return { R: window.RepertorioData, document };
}

test('guarda, lee y borra el calendario preferido', () => {
  const { R, document } = cargar();
  assert.equal(R.orgPreferida(), null);
  R.guardarOrgPreferida('-Nabc123');
  assert.equal(R.orgPreferida(), '-Nabc123');
  const escrita = document.escritas[0];
  assert.match(escrita, /^repertorio_org=-Nabc123; max-age=31536000; path=\/RepertorioApp\/; SameSite=Lax$/);
  R.guardarOrgPreferida('templobetel');
  assert.equal(R.orgPreferida(), 'templobetel');
  R.borrarOrgPreferida();
  assert.equal(R.orgPreferida(), null);
  R.guardarOrgPreferida('');
  assert.equal(R.orgPreferida(), null, 'un id vacío no se guarda');
});

test('no confunde otra cookie que termine en el mismo nombre', () => {
  const { R, document } = cargar();
  document.cookie = 'otro_repertorio_org=x';
  assert.equal(R.orgPreferida(), null);
  R.guardarOrgPreferida('o2');
  assert.equal(R.orgPreferida(), 'o2');
});

test('una cuenta arranca en su último calendario abierto si pertenece a él', () => {
  const { R } = cargar();
  const doc = { organizationIds: { o1: true, o2: true, o3: true }, musicianLinks: { o2: 'm1' } };
  /* Sin preferencia: la primera con persona vinculada */
  assert.equal(R.orgInicialDeUsuario(doc), 'o2');
  R.guardarOrgPreferida('o3');
  assert.equal(R.orgInicialDeUsuario(doc), 'o3');
  /* Una preferencia de otra organización (vista sin sesión) se ignora */
  R.guardarOrgPreferida('ajena');
  assert.equal(R.orgInicialDeUsuario(doc), 'o2');
  assert.equal(R.orgInicialDeUsuario({ organizationIds: {} }), null);
});

test('sin document (Node) las funciones no fallan', () => {
  const window = { RepertorioCifrado: require('../cifrado.js') };
  const ctx = vm.createContext({ window, console, Date, Math, JSON, Promise, Map, encodeURIComponent, setTimeout });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'repertorio-data.js'), 'utf8'), ctx);
  const R = window.RepertorioData;
  R.guardarOrgPreferida('x');
  assert.equal(R.orgPreferida(), null);
  assert.equal(R.orgInicialDeUsuario({ organizationIds: { a: true } }), 'a');
});

test('usuarios sin correo: al menos correo o WhatsApp', () => {
  const { R } = cargar();
  assert.equal(R.contactoValido('a@b.com', ''), true);
  assert.equal(R.contactoValido('', '50370000000'), true);
  assert.equal(R.contactoValido('  ', ' '), false);
  assert.equal(R.esUsuarioSinCorreo({ sinCorreo: true, email: '' }), true);
  /* Si ya tiene correo cuenta como cuenta normal */
  assert.equal(R.esUsuarioSinCorreo({ sinCorreo: true, email: 'a@b.com' }), false);
  assert.equal(R.esUsuarioSinCorreo({ email: 'a@b.com' }), false);
});
