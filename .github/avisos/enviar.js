/* Procesa la cola de avisos (/colaAvisos) y envía los correos.

   Lo corren los workflows avisos.yml (disparado por la app al publicar o
   con "Reenviar eventos") y avisos-respaldo.yml (cron, para lo que haya
   quedado pendiente). Destinatarios y mensaje se recalculan aquí desde la
   base con las mismas funciones que usa la app (../../avisos.js): del
   pedido solo se toman orgId + eventIds o uid, así nadie puede inyectar
   destinatarios ni texto.

   El repositorio es público y sus logs también: aquí NUNCA se imprimen
   correos, teléfonos ni nombres, solo conteos.

   Variables de entorno (Secrets del repo):
     FIREBASE_SA         JSON de la cuenta de servicio de Firebase
     GMAIL_USER          cuenta de Gmail que envía
     GMAIL_APP_PASSWORD  contraseña de aplicación de esa cuenta
     AVISOS_PRUEBA=1     opcional: procesa sin enviar ni tocar la cola */
const A = require('../../avisos.js');

const DATABASE_URL = 'https://repertoriodb-b84d8-default-rtdb.firebaseio.com';
/* Un pedido 'procesando' más viejo que esto se da por abandonado (la
   ejecución anterior murió) y se vuelve a tomar. */
const ABANDONO_MS = 15 * 60 * 1000;
/* Pedidos ya terminados más viejos que esto se borran de la cola. */
const RETENCION_MS = 90 * 24 * 3600 * 1000;

function lista(snap) {
  const out = [];
  snap.forEach((c) => { const v = c.val() || {}; if (typeof v === 'object') { if (!v.id) v.id = c.key; out.push(v); } });
  return out;
}

/* Datos de una organización para planAvisos (con caché por ejecución). */
function crearLector(root) {
  let usuarios = null;
  const porOrg = {};
  return async function datosDe(orgId) {
    if (!usuarios) {
      const s = await root.child('users').once('value');
      usuarios = [];
      s.forEach((c) => { const v = c.val() || {}; v.uid = c.key; usuarios.push(v); });
    }
    if (!porOrg[orgId]) {
      const [o, m, e] = await Promise.all([
        root.child('organizations').child(orgId).once('value'),
        root.child('musicians').orderByChild('organizationId').equalTo(orgId).once('value'),
        root.child('events').orderByChild('organizationId').equalTo(orgId).once('value')
      ]);
      const org = o.val();
      porOrg[orgId] = org ? { org: Object.assign({}, org, { id: orgId }), musicos: lista(m), eventos: lista(e) } : null;
    }
    return porOrg[orgId] && Object.assign({ usuarios, hoy: A.hoyIso() }, porOrg[orgId]);
  };
}

/* Toma el pedido para esta ejecución (transacción: si dos ejecuciones
   coinciden, solo una lo procesa). */
async function tomar(ref, ahora) {
  const r = await ref.transaction((v) => {
    if (!v) return v;
    const abandonado = v.estado === 'procesando' && (v.tomado || 0) < ahora - ABANDONO_MS;
    if (v.estado !== 'pendiente' && !abandonado) return;
    return Object.assign({}, v, { estado: 'procesando', tomado: ahora });
  });
  return r.committed && r.snapshot.val() && r.snapshot.val().estado === 'procesando' && r.snapshot.val().tomado === ahora;
}

/* Procesa todos los pedidos pendientes. enviarCorreo({para, asunto, texto,
   html, remitente}) → Promise. Devuelve el resumen de conteos. */
async function procesarCola(root, enviarCorreo, opciones = {}) {
  const ahora = opciones.ahora || Date.now();
  const prueba = !!opciones.prueba;
  const datosDe = crearLector(root);
  const cola = root.child(A.COLA_PATH);
  const snap = await cola.once('value');
  const pedidos = [];
  const viejos = [];
  snap.forEach((c) => {
    const v = c.val() || {};
    if (v.estado === 'pendiente' || (v.estado === 'procesando' && (v.tomado || 0) < ahora - ABANDONO_MS)) pedidos.push({ key: c.key, v });
    else if ((v.creado || 0) < ahora - RETENCION_MS) viejos.push(c.key);
  });
  const resumen = { pedidos: pedidos.length, enviados: 0, errores: 0, sinCorreo: 0, sinEventos: 0 };
  /* Gmail rechazó usuario/contraseña (535 / EAUTH): los demás envíos de
     esta corrida fallarían igual, así que ya no se intentan. */
  let credencialesMalas = false;

  for (const p of pedidos) {
    const ref = cola.child(p.key);
    if (!prueba && !(await tomar(ref, ahora))) continue;
    const res = { enviados: 0, errores: 0, sinCorreo: 0, sinEventos: 0, resultados: {} };
    let fallo = '';
    try {
      const valido = p.v.orgId && (p.v.tipo === 'publicacion' ? p.v.eventIds : (p.v.tipo === 'reenvio' && p.v.uid));
      const datos = valido ? await datosDe(p.v.orgId) : null;
      if (!datos) fallo = valido ? 'organizacion-inexistente' : 'pedido-invalido';
      else {
        const filas = A.planAvisos({ tipo: p.v.tipo, eventIds: p.v.eventIds, uid: p.v.uid, orgId: p.v.orgId }, datos);
        for (const f of filas) {
          if (!f.aviso) { res.sinEventos++; res.resultados[f.uid] = 'sin_eventos'; continue; }
          if (!f.email) { res.sinCorreo++; res.resultados[f.uid] = 'sin_correo'; continue; }
          if (credencialesMalas) { res.errores++; res.resultados[f.uid] = 'error'; continue; }
          try {
            if (!prueba) await enviarCorreo({ para: f.email, asunto: f.aviso.asunto, texto: f.aviso.texto, html: f.aviso.html, remitente: datos.org.name || 'Repertorio' });
            res.enviados++; res.resultados[f.uid] = 'enviado';
          } catch (e) {
            res.errores++; res.resultados[f.uid] = 'error';
            if (e && (e.responseCode === 535 || e.code === 'EAUTH')) credencialesMalas = true;
            console.error('Error de envío (' + (e && (e.responseCode || e.code) || 'desconocido') + ')' + (credencialesMalas ? ': Gmail rechazó GMAIL_USER / GMAIL_APP_PASSWORD' : ''));
          }
        }
      }
    } catch (e) {
      fallo = 'error-interno';
      console.error('Error procesando un pedido:', e && e.message);
    }
    ['enviados', 'errores', 'sinCorreo', 'sinEventos'].forEach((k) => { resumen[k] += res[k]; });
    if (prueba) continue;
    await ref.update({
      estado: fallo || (res.errores && !res.enviados) ? 'error' : 'enviado',
      fallo: fallo || (credencialesMalas && res.errores ? 'gmail-credenciales' : null),
      enviados: res.enviados, errores: res.errores, sinCorreo: res.sinCorreo, sinEventos: res.sinEventos,
      resultados: Object.keys(res.resultados).length ? res.resultados : null,
      procesado: Date.now()
    });
  }

  if (!prueba && viejos.length) {
    const borrar = {};
    viejos.forEach((k) => { borrar[k] = null; });
    await cola.update(borrar);
  }
  resumen.borrados = prueba ? 0 : viejos.length;
  return resumen;
}

async function main() {
  const admin = require('firebase-admin');
  const nodemailer = require('nodemailer');
  const sa = process.env.FIREBASE_SA;
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  const prueba = process.env.AVISOS_PRUEBA === '1';
  /* Sin configurar todavía: el cron no debe fallar (y mandar un correo de
     error de GitHub) cada 30 minutos; queda una advertencia en la corrida. */
  const faltan = [!sa && 'FIREBASE_SA', !prueba && !user && 'GMAIL_USER', !prueba && !pass && 'GMAIL_APP_PASSWORD'].filter(Boolean);
  if (faltan.length) {
    console.log('::warning::Avisos sin configurar: faltan los secrets ' + faltan.join(', ') + '. No se procesó la cola.');
    return;
  }

  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(sa)), databaseURL: DATABASE_URL });
  const transporte = prueba ? null : nodemailer.createTransport({ service: 'gmail', auth: { user, pass } });
  const enviarCorreo = (m) => transporte.sendMail({
    from: { name: m.remitente, address: user },
    to: m.para, subject: m.asunto, text: m.texto, html: m.html
  });

  try {
    const r = await procesarCola(admin.database().ref(), enviarCorreo, { prueba });
    console.log('Pedidos: ' + r.pedidos + ' · correos enviados: ' + r.enviados + ' · errores: ' + r.errores +
      ' · sin correo: ' + r.sinCorreo + ' · sin eventos: ' + r.sinEventos + ' · borrados de la cola: ' + r.borrados + (prueba ? ' (prueba, sin enviar)' : ''));
    if (r.errores && !r.enviados) process.exitCode = 1;
  } finally {
    if (transporte) transporte.close();
    await admin.app().delete();
  }
}

if (require.main === module) {
  main().catch((e) => { console.error(e && e.message ? e.message : 'Error'); process.exit(1); });
}

module.exports = { procesarCola };
