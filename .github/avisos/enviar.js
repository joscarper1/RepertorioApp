/* Procesa la cola de avisos (/colaAvisos) y envía los correos.

   Lo corren los workflows avisos.yml (disparado por la app al publicar o
   con "Reenviar eventos") y avisos-respaldo.yml (cron, para lo que haya
   quedado pendiente). Destinatarios y mensaje se recalculan aquí desde la
   base con las mismas funciones que usa la app (../../avisos.js): del
   pedido solo se toman orgId + eventIds o uid, así nadie puede inyectar
   destinatarios ni texto.

   Además avisa a los administradores que lo pidieron cuando alguien se une
   solo desde un calendario (procesarNuevos: no pasa por la cola; se detecta
   con la marca `nuevo` de /users y queda en el historial como 'nuevoUsuario'),
   y a los que activaron la bitácora de cambios de eventos o el aviso de
   repertorio actualizado (procesarBitacora: lee /bitacoraEventos), y manda
   los recordatorios de eventos a quien los activó en Dashboard →
   Notificaciones (procesarRecordatorios: 7:00 a. m., hora de El Salvador),
   y avisa a los administradores que lo pidieron cuando alguien declina un
   evento (procesarDeclinaciones).

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
function crearLector(root, hoy) {
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
    return porOrg[orgId] && Object.assign({ usuarios, hoy: hoy || A.hoyIso() }, porOrg[orgId]);
  };
}

/* Eventos de `desde` en adelante (hasta `hasta`, si se da), de todas las
   organizaciones y agrupados por organización: [orgId] → [evento]. Pide
   solo ese rango con el índice de `fecha` (.indexOn de events), para no
   descargar todo el histórico. */
async function eventosDesde(root, desde, hasta) {
  let q = root.child('events').orderByChild('fecha').startAt(desde);
  if (hasta) q = q.endAt(hasta);
  const porOrg = {};
  lista(await q.once('value')).forEach((ev) => { (porOrg[ev.organizationId] = porOrg[ev.organizationId] || []).push(ev); });
  return porOrg;
}

function sumarDias(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
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
  const datosDe = crearLector(root, opciones.hoy);
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
  resumen.credencialesMalas = credencialesMalas;
  return resumen;
}

/* Reclama el aviso de un usuario nuevo (transacción en
   users/{uid}/avisoNuevo: si dos ejecuciones coinciden, solo una envía). */
async function reclamarNuevo(ref, ahora) {
  const r = await ref.transaction((v) => {
    if (v && !(v.tomado && !v.enviado && v.tomado < ahora - ABANDONO_MS)) return;
    return { tomado: ahora };
  });
  return r.committed && r.snapshot.val() && r.snapshot.val().tomado === ahora;
}

/* Correo a los administradores (con el aviso activado) de cada organización
   a la que se unió solo un usuario nuevo. */
async function procesarNuevos(root, enviarCorreo, opciones = {}) {
  const ahora = opciones.ahora || Date.now();
  const prueba = !!opciones.prueba;
  const s = await root.child('users').once('value');
  const usuarios = [];
  s.forEach((c) => { const v = c.val() || {}; v.uid = c.key; usuarios.push(v); });
  const resumen = { nuevos: 0, enviados: 0, errores: 0, sinDestinatarios: 0 };
  let credencialesMalas = false;
  for (const u of A.nuevosPorAvisar(usuarios, ahora)) {
    const ref = root.child('users').child(u.uid).child('avisoNuevo');
    if (!prueba && !(await reclamarNuevo(ref, ahora))) continue;
    resumen.nuevos++;
    let enviados = 0, errores = 0;
    for (const orgId of Object.keys(u.organizationIds || {}).filter((k) => u.organizationIds[k])) {
      const admins = A.adminsParaNuevos(usuarios, orgId, u.uid);
      if (!admins.length) { resumen.sinDestinatarios++; continue; }
      const o = await root.child('organizations').child(orgId).once('value');
      if (!o.val()) continue;
      const org = Object.assign({}, o.val(), { id: orgId });
      const aviso = A.armarAvisoNuevoUsuario(org, u);
      let env = 0, err = 0;
      for (const a of admins) {
        if (credencialesMalas) { err++; continue; }
        try {
          if (!prueba) await enviarCorreo({ para: a.email, asunto: aviso.asunto, texto: aviso.texto, html: aviso.html, remitente: org.name || 'Repertorio' });
          env++;
        } catch (e) {
          err++;
          if (e && (e.responseCode === 535 || e.code === 'EAUTH')) credencialesMalas = true;
          console.error('Error de envío (' + (e && (e.responseCode || e.code) || 'desconocido') + ')');
        }
      }
      enviados += env; errores += err;
      /* Queda en el historial de Administración → Avisos. */
      if (!prueba) {
        await root.child(A.COLA_PATH).push({
          orgId, tipo: 'nuevoUsuario', uid: u.uid, pedidoPor: u.uid, creado: ahora, procesado: Date.now(),
          estado: err && !env ? 'error' : 'enviado', enviados: env, errores: err,
          fallo: credencialesMalas && err ? 'gmail-credenciales' : null
        });
      }
    }
    resumen.enviados += enviados; resumen.errores += errores;
    if (prueba) continue;
    /* Si todo falló se suelta para reintentar en la próxima ejecución. */
    if (errores && !enviados) await ref.remove();
    else await ref.set({ tomado: ahora, enviado: Date.now(), correos: enviados });
  }
  resumen.credencialesMalas = credencialesMalas;
  return resumen;
}

/* Bitácora de cambios de eventos (/bitacoraEventos, ver A.entradaBitacora):
   por organización, un correo de bitácora a cada admin con el interruptor
   activado (con todos los cambios pendientes) y un correo de "repertorio
   actualizado" por cada entrada que lo trae a los admins que lo pidieron.
   El autor se toma de /users (no del texto de la entrada) y se comprueba que
   el evento sea de esa organización. Cada organización con correos queda en
   el historial de Administración → Avisos como tipo 'bitacora'. */
async function procesarBitacora(root, enviarCorreo, opciones = {}) {
  const ahora = opciones.ahora || Date.now();
  const prueba = !!opciones.prueba;
  const ref = root.child(A.BITACORA_PATH);
  const snap = await ref.once('value');
  const porOrg = {};
  const viejos = [];
  snap.forEach((c) => {
    const v = c.val() || {};
    if (v.estado === 'pendiente' || (v.estado === 'procesando' && (v.tomado || 0) < ahora - ABANDONO_MS)) {
      (porOrg[v.orgId || ''] = porOrg[v.orgId || ''] || []).push({ key: c.key, v });
    } else if ((v.creado || 0) < ahora - RETENCION_MS) viejos.push(c.key);
  });
  const resumen = { cambios: 0, enviados: 0, errores: 0, invalidos: 0 };
  let credencialesMalas = false;
  let usuarios = null;

  for (const orgId of Object.keys(porOrg)) {
    const tomadas = [];
    for (const p of porOrg[orgId]) {
      if (!prueba && !(await tomar(ref.child(p.key), ahora))) continue;
      tomadas.push(p);
    }
    if (!tomadas.length) continue;
    if (!usuarios) {
      const s = await root.child('users').once('value');
      usuarios = [];
      s.forEach((c) => { const v = c.val() || {}; v.uid = c.key; usuarios.push(v); });
    }
    const o = orgId ? await root.child('organizations').child(orgId).once('value') : null;
    const org = o && o.val() ? Object.assign({}, o.val(), { id: orgId }) : null;
    const autores = {};
    usuarios.forEach((u) => { autores[u.uid] = String(u.displayName || u.email || '').trim() || 'Alguien'; });
    const validas = [];
    const estadoDe = {};
    for (const p of tomadas) {
      const e = Object.assign({}, p.v, { id: p.key });
      let ok = !!org && A.entradaValida(e);
      if (ok) {
        const autor = usuarios.find((u) => u.uid === e.autorUid);
        const ev = (await root.child('events').child(e.eventId).once('value')).val();
        ok = !!autor && Object.keys(autor.organizationIds || {}).some((k) => k === orgId && autor.organizationIds[k]) &&
          !!ev && ev.organizationId === orgId;
      }
      if (ok) validas.push(e); else { estadoDe[p.key] = 'invalido'; resumen.invalidos++; }
    }
    resumen.cambios += validas.length;

    let env = 0, err = 0;
    const enviar = async (para, aviso) => {
      if (credencialesMalas) { err++; return false; }
      try {
        if (!prueba) await enviarCorreo({ para, asunto: aviso.asunto, texto: aviso.texto, html: aviso.html, remitente: org.name || 'Repertorio' });
        env++; return true;
      } catch (e) {
        err++;
        if (e && (e.responseCode === 535 || e.code === 'EAUTH')) credencialesMalas = true;
        console.error('Error de envío (' + (e && (e.responseCode || e.code) || 'desconocido') + ')');
        return false;
      }
    };
    const resultado = {};
    validas.forEach((e) => { resultado[e.id] = { env: 0, err: 0 }; });
    if (validas.length) {
      const aviso = A.armarAvisoBitacora(org, validas, autores);
      for (const a of A.adminsConPref(usuarios, orgId, A.PREF_BITACORA)) {
        const okEnv = await enviar(a.email, aviso);
        validas.forEach((e) => { resultado[e.id][okEnv ? 'env' : 'err']++; });
      }
      const adminsRep = A.adminsConPref(usuarios, orgId, A.PREF_REPERTORIO);
      for (const e of validas.filter((x) => x.repertorio)) {
        const avisoRep = A.armarAvisoRepertorio(org, e, autores);
        for (const a of adminsRep) resultado[e.id][(await enviar(a.email, avisoRep)) ? 'env' : 'err']++;
      }
    }
    resumen.enviados += env; resumen.errores += err;
    if (prueba) continue;

    const patch = {};
    tomadas.forEach((p) => {
      const r = resultado[p.key];
      const estado = estadoDe[p.key] || (!r.env && !r.err ? 'sin-destinatarios' : (r.err && !r.env ? 'error' : 'enviado'));
      patch[p.key + '/estado'] = estado;
      patch[p.key + '/procesado'] = Date.now();
      if (r) { patch[p.key + '/enviados'] = r.env; patch[p.key + '/errores'] = r.err; }
    });
    await ref.update(patch);
    if (env || err) {
      await root.child(A.COLA_PATH).push({
        orgId, tipo: 'bitacora', cambios: validas.length, pedidoPor: validas[0] ? validas[0].autorUid : null,
        creado: ahora, procesado: Date.now(), estado: err && !env ? 'error' : 'enviado', enviados: env, errores: err,
        fallo: credencialesMalas && err ? 'gmail-credenciales' : null
      });
    }
  }

  if (!prueba && viejos.length) {
    const borrar = {};
    viejos.forEach((k) => { borrar[k] = null; });
    await ref.update(borrar);
  }
  resumen.credencialesMalas = credencialesMalas;
  return resumen;
}

/* Reclama un recordatorio (transacción en
   recordatoriosEnviados/{eventId}/{uid}/{opcion}: si dos ejecuciones
   coinciden, solo una envía; un reclamo a medias de hace más de 15 min se
   da por abandonado). */
async function reclamarRecordatorio(ref, ahora) {
  const r = await ref.transaction((v) => {
    if (v && !(v.tomado && !v.enviado && v.tomado < ahora - ABANDONO_MS)) return;
    return { tomado: ahora };
  });
  return r.committed && r.snapshot.val() && r.snapshot.val().tomado === ahora;
}

/* Recordatorios de eventos (ver A.planRecordatorios): a las 7:00 a. m. de
   El Salvador, a cada persona con la opción activada en Dashboard →
   Notificaciones. Solo trabaja en la ventana de envío del día; fuera de ella
   no lee la base. */
async function procesarRecordatorios(root, enviarCorreo, opciones = {}) {
  const ahora = opciones.ahora || Date.now();
  const prueba = !!opciones.prueba;
  const resumen = { candidatos: 0, enviados: 0, errores: 0, omitidos: 0, credencialesMalas: false };
  if (!A.enVentanaRecordatorios(ahora)) return resumen;
  const orgs = [];
  (await root.child('organizations').once('value')).forEach((c) => { orgs.push(c.key); });
  if (!orgs.length) return resumen;
  const s = await root.child('users').once('value');
  const usuarios = [];
  s.forEach((c) => { const v = c.val() || {}; v.uid = c.key; usuarios.push(v); });

  /* Una sola lectura de los eventos de los próximos días (el más lejano es el de "una semana antes"). */
  const hoy = A.hoyIso(new Date(ahora));
  const eventosPorOrg = await eventosDesde(root, hoy, sumarDias(hoy, 8));
  for (const orgId of orgs) {
    if (resumen.credencialesMalas) break;
    if (!(eventosPorOrg[orgId] || []).length) continue;
    /* Sin nadie con recordatorios y vínculo en esta organización no se leen sus eventos. */
    if (!usuarios.some((u) => u.email && A.orgIdsDe(u).indexOf(orgId) >= 0 && ((u.musicianLinks || {})[orgId]) &&
      !A.sinRecordatorios(A.recordatoriosDe(u)))) continue;
    const [o, m] = await Promise.all([
      root.child('organizations').child(orgId).once('value'),
      root.child('musicians').orderByChild('organizationId').equalTo(orgId).once('value')
    ]);
    const org = Object.assign({}, o.val(), { id: orgId });
    for (const f of A.planRecordatorios({ org, usuarios, musicos: lista(m), eventos: eventosPorOrg[orgId] }, ahora)) {
      resumen.candidatos++;
      const ref = root.child(A.RECORDATORIOS_PATH).child(f.ev.id).child(f.uid).child(f.opcion);
      if (prueba) continue;
      if (!(await reclamarRecordatorio(ref, ahora))) { resumen.omitidos++; continue; }
      if (resumen.credencialesMalas) { await ref.remove(); resumen.errores++; continue; }
      try {
        await enviarCorreo({ para: f.email, asunto: f.aviso.asunto, texto: f.aviso.texto, html: f.aviso.html, remitente: org.name || 'Repertorio' });
        await ref.set({ tomado: ahora, enviado: Date.now() });
        resumen.enviados++;
      } catch (err) {
        /* Se suelta para reintentar en la próxima corrida (mientras dure la gracia). */
        await ref.remove();
        resumen.errores++;
        if (err && (err.responseCode === 535 || err.code === 'EAUTH')) resumen.credencialesMalas = true;
        console.error('Error de envío (' + (err && (err.responseCode || err.code) || 'desconocido') + ')');
      }
    }
  }
  return resumen;
}

/* Declinaciones de participación (ver A.declinacionesActuales): un correo
   por organización con todas las declinaciones nuevas a los administradores
   que activaron el aviso. Lo ya avisado se anota en
   declinacionesAvisadas/{eventId}/{clave}; la marca se borra cuando el
   puesto deja de estar declinado (la persona cambió a "Sí" o la
   reemplazaron), para que una nueva declinación vuelva a avisar. */
async function procesarDeclinaciones(root, enviarCorreo, opciones = {}) {
  const ahora = opciones.ahora || Date.now();
  const prueba = !!opciones.prueba;
  const hoy = opciones.hoy || A.hoyIso(new Date(ahora));
  const resumen = { declinaciones: 0, enviados: 0, errores: 0, credencialesMalas: false };
  const s = await root.child('users').once('value');
  const usuarios = [];
  s.forEach((c) => { const v = c.val() || {}; v.uid = c.key; usuarios.push(v); });
  const orgIds = new Set();
  usuarios.forEach((u) => { if (u.role === 'admin' && u.email && A.prefActiva(u, A.PREF_DECLINACIONES)) A.orgIdsDe(u).forEach((k) => orgIds.add(k)); });

  if (!orgIds.size) return resumen;
  /* Solo eventos de hoy en adelante, en una sola lectura (los pasados ya no se revisan). */
  const eventosPorOrg = await eventosDesde(root, hoy);
  for (const orgId of orgIds) {
    if (resumen.credencialesMalas) break;
    const admins = A.adminsConPref(usuarios, orgId, A.PREF_DECLINACIONES);
    if (!admins.length) continue;
    const eventos = eventosPorOrg[orgId] || [];
    const o = await root.child('organizations').child(orgId).once('value');
    if (!o.val()) continue;
    const org = Object.assign({}, o.val(), { id: orgId });
    const actuales = A.declinacionesActuales(eventos, hoy);
    const vigentes = {};
    actuales.forEach((d) => { vigentes[d.ev.id + '/' + d.clave] = true; });
    const reg = root.child(A.DECLINACIONES_PATH);
    const nuevas = [];
    /* Una sola lectura de las marcas; se borran las de puestos que ya no están declinados. */
    const marcasTodas = (await reg.once('value')).val() || {};
    for (const ev of eventos) {
      for (const k of Object.keys(marcasTodas[ev.id] || {})) {
        if (!vigentes[ev.id + '/' + k] && !prueba) await reg.child(ev.id).child(k).remove();
      }
    }
    for (const d of actuales) {
      const ref = reg.child(d.ev.id).child(d.clave);
      if (prueba) { const m = (await ref.once('value')).val(); if (!m) nuevas.push(d); continue; }
      if (await reclamarRecordatorio(ref, ahora)) nuevas.push(d);
    }
    if (!nuevas.length) continue;
    resumen.declinaciones += nuevas.length;
    const aviso = A.armarAvisoDeclinaciones(org, nuevas, hoy);
    let env = 0, err = 0;
    for (const a of admins) {
      if (resumen.credencialesMalas) { err++; continue; }
      try {
        if (!prueba) await enviarCorreo({ para: a.email, asunto: aviso.asunto, texto: aviso.texto, html: aviso.html, remitente: org.name || 'Repertorio' });
        env++;
      } catch (ex) {
        err++;
        if (ex && (ex.responseCode === 535 || ex.code === 'EAUTH')) resumen.credencialesMalas = true;
        console.error('Error de envío (' + (ex && (ex.responseCode || ex.code) || 'desconocido') + ')');
      }
    }
    resumen.enviados += env; resumen.errores += err;
    if (prueba) continue;
    for (const d of nuevas) {
      const ref = reg.child(d.ev.id).child(d.clave);
      /* Si no llegó a nadie se suelta para reintentar en la próxima corrida. */
      if (err && !env) await ref.remove(); else await ref.set({ tomado: ahora, enviado: Date.now() });
    }
    await root.child(A.COLA_PATH).push({
      orgId, tipo: 'declinacion', cambios: nuevas.length, pedidoPor: null, creado: ahora, procesado: Date.now(),
      estado: err && !env ? 'error' : 'enviado', enviados: env, errores: err,
      fallo: resumen.credencialesMalas && err ? 'gmail-credenciales' : null
    });
  }
  return resumen;
}

/* Los secrets pegados en GitHub suelen traer un salto de línea o espacios
   invisibles al final, o comillas; la contraseña de aplicación se muestra
   en grupos de 4 con espacios. Gmail rechaza cualquiera de esos (535). */
function limpiarCredenciales(user, pass) {
  return {
    user: String(user || '').trim().replace(/^["']|["']$/g, '').trim(),
    pass: String(pass || '').replace(/\s+/g, '').replace(/^["']|["']$/g, '')
  };
}

/* Diagnóstico sin revelar nada: el log del repositorio es público. */
function diagnosticoGmail(userRaw, passRaw) {
  const u = String(userRaw || ''), p = String(passRaw || '');
  const c = limpiarCredenciales(u, p);
  const si = (b) => (b ? 'sí' : 'no');
  return [
    'GMAIL_USER: parece correo ' + si(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.user)) +
      ', termina en @gmail.com ' + si(/@gmail\.com$/i.test(c.user)) +
      ', traía espacios/saltos/comillas ' + si(c.user !== u),
    'GMAIL_APP_PASSWORD: ' + c.pass.length + ' caracteres (debe ser 16)' +
      ', solo letras ' + si(/^[a-zA-Z]+$/.test(c.pass)) +
      ', traía espacios/saltos/comillas ' + si(c.pass !== p)
  ].join(' · ');
}

async function main() {
  const admin = require('firebase-admin');
  const nodemailer = require('nodemailer');
  const sa = process.env.FIREBASE_SA;
  const { user, pass } = limpiarCredenciales(process.env.GMAIL_USER, process.env.GMAIL_APP_PASSWORD);
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
    const n = await procesarNuevos(admin.database().ref(), enviarCorreo, { prueba });
    console.log('Usuarios nuevos: ' + n.nuevos + ' · avisos a administradores: ' + n.enviados + ' · errores: ' + n.errores +
      ' · sin administrador suscrito: ' + n.sinDestinatarios);
    const b = await procesarBitacora(admin.database().ref(), enviarCorreo, { prueba });
    console.log('Bitácora: ' + b.cambios + ' cambios · correos a administradores: ' + b.enviados + ' · errores: ' + b.errores +
      ' · entradas inválidas: ' + b.invalidos);
    const rec = await procesarRecordatorios(admin.database().ref(), enviarCorreo, { prueba });
    console.log('Recordatorios: ' + rec.candidatos + ' por enviar · enviados: ' + rec.enviados + ' · ya enviados: ' + rec.omitidos + ' · errores: ' + rec.errores);
    const dec = await procesarDeclinaciones(admin.database().ref(), enviarCorreo, { prueba });
    console.log('Declinaciones nuevas: ' + dec.declinaciones + ' · correos a administradores: ' + dec.enviados + ' · errores: ' + dec.errores);
    r.credencialesMalas = r.credencialesMalas || n.credencialesMalas || b.credencialesMalas || rec.credencialesMalas || dec.credencialesMalas;
    console.log('Pedidos: ' + r.pedidos + ' · correos enviados: ' + r.enviados + ' · errores: ' + r.errores +
      ' · sin correo: ' + r.sinCorreo + ' · sin eventos: ' + r.sinEventos + ' · borrados de la cola: ' + r.borrados + (prueba ? ' (prueba, sin enviar)' : ''));
    if (r.credencialesMalas) console.log('::error::Gmail rechazó la credencial (535). ' + diagnosticoGmail(process.env.GMAIL_USER, process.env.GMAIL_APP_PASSWORD));
    if (r.errores && !r.enviados) process.exitCode = 1;
  } finally {
    if (transporte) transporte.close();
    await admin.app().delete();
  }
}

if (require.main === module) {
  main().catch((e) => { console.error(e && e.message ? e.message : 'Error'); process.exit(1); });
}

module.exports = { procesarCola, procesarNuevos, procesarBitacora, procesarRecordatorios, procesarDeclinaciones, limpiarCredenciales, diagnosticoGmail };
