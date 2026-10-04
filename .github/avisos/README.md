# Avisos de programación por correo

Al publicar un evento, o con **Reenviar eventos** en Usuarios → Cuentas, la app deja un pedido en
`/colaAvisos` y dispara `.github/workflows/avisos.yml`. Ese workflow corre `enviar.js`, que lee la
base de datos, arma el mensaje con `avisos.js` (el mismo que usa la app) y lo envía por Gmail.
`avisos-respaldo.yml` revisa la cola cada 30 minutos por si el disparo falló.

WhatsApp no pasa por aquí: el panel de la app abre `wa.me` con el mensaje ya escrito.

El estado de los workflows, el token y el historial se ven en **Administración → Avisos**.

## Configuración (una sola vez)

1. **Gmail que envía**: activa la verificación en 2 pasos y crea una
   [contraseña de aplicación](https://myaccount.google.com/apppasswords).
2. **Cuenta de servicio de Firebase**: Consola de Firebase → Configuración del proyecto →
   Cuentas de servicio → *Generar nueva clave privada* (descarga un JSON).
3. **Secrets del repositorio** (GitHub → Settings → Secrets and variables → Actions):
   - `FIREBASE_SA`: el contenido completo del JSON.
   - `GMAIL_USER`: el correo de Gmail.
   - `GMAIL_APP_PASSWORD`: la contraseña de aplicación (16 letras, sin espacios).
4. **Token para que la app dispare el envío**: GitHub → Settings → Developer settings →
   Fine-grained tokens. Solo el repositorio `joscarper1/RepertorioApp`, permiso
   *Actions: Read and write*. Pégalo en Administración → Avisos, junto con su fecha de vencimiento.
5. **Reglas de Realtime Database**: `colaAvisos`, `config/avisos`, `users/$uid/telefono` y
   `bitacoraEventos` (cualquier miembro de la organización crea entradas a su nombre; solo admins leen):

   ```json
   "bitacoraEventos": {
     ".read": "auth != null && root.child('users/' + auth.uid + '/role').val() === 'admin'",
     "$id": {
       ".write": "auth != null && !data.exists() && newData.child('autorUid').val() === auth.uid && root.child('users/' + auth.uid + '/organizationIds/' + newData.child('orgId').val()).val() === true"
     }
   }
   ```

## Bitácora de cambios y repertorio actualizado

Dos interruptores en Administración → Avisos (por administrador, apagados por defecto):
**Avisarme cuando se actualice un repertorio** y **Enviarme la bitácora de cambios de eventos**.
Al modificar, mover, cancelar o archivar un evento, `eventos.html` deja una entrada en
`/bitacoraEventos` (acción, evento, fecha, versión, estado, y si cambió un repertorio que ya tenía
más de una canción: agregadas/quitadas/lista actual). `enviar.js` (`procesarBitacora`) manda un
correo de bitácora por administrador suscrito con los cambios pendientes de su organización y uno
de repertorio por cada cambio de canciones. Si el cambio lo hace un admin el envío sale al instante;
si lo hace un editor o director, con el cron de respaldo (~30 min).

## Seguridad

- El repositorio es público y sus logs también: `enviar.js` solo imprime conteos, nunca correos,
  teléfonos ni nombres.
- Del pedido solo se usan `orgId` y `eventIds`/`uid`. Destinatarios y texto siempre se recalculan
  desde la base.
- Nunca agregues `pull_request` como disparador de estos workflows.

## Probar sin enviar

En PowerShell (Windows), desde la raíz del repo:

```powershell
cd .github\avisos
npm ci
$env:FIREBASE_SA = Get-Content -Raw "C:\ruta\a\clave.json"
$env:AVISOS_PRUEBA = "1"
node enviar.js
Remove-Item Env:FIREBASE_SA, Env:AVISOS_PRUEBA
```

En Bash:

```bash
cd .github/avisos && npm ci && FIREBASE_SA="$(cat /ruta/a/clave.json)" AVISOS_PRUEBA=1 node enviar.js
```

Guarda la clave fuera del repositorio. `.gitignore` ignora `clave*.json` y los nombres que usa Firebase
(`*firebase-adminsdk*.json`) por si acaso.

Así procesa la cola real e imprime los conteos, pero no envía correos ni modifica la cola.
