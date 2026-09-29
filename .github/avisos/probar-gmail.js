/* Prueba la credencial de Gmail desde tu PC, sin GitHub ni Firebase.
   Con --enviar además te manda un correo de prueba a esa misma cuenta.

   PowerShell, dentro de .github\avisos:
     $env:GMAIL_USER = "correo@gmail.com"
     $env:GMAIL_APP_PASSWORD = "abcdefghijklmnop"
     node probar-gmail.js --enviar
     Remove-Item Env:GMAIL_USER, Env:GMAIL_APP_PASSWORD */
const nodemailer = require('nodemailer');
const { limpiarCredenciales, diagnosticoGmail } = require('./enviar.js');

async function main() {
  const rawUser = process.env.GMAIL_USER, rawPass = process.env.GMAIL_APP_PASSWORD;
  if (!rawUser || !rawPass) { console.log('Define GMAIL_USER y GMAIL_APP_PASSWORD primero.'); process.exit(1); }
  console.log(diagnosticoGmail(rawUser, rawPass));
  const { user, pass } = limpiarCredenciales(rawUser, rawPass);
  const t = nodemailer.createTransport({ service: 'gmail', auth: { user, pass } });
  try {
    await t.verify();
    console.log('✓ Gmail aceptó la credencial.');
    if (process.argv.includes('--enviar')) {
      await t.sendMail({ from: user, to: user, subject: 'Prueba de avisos – RepertorioApp', text: 'Si lees esto, el envío por Gmail funciona.' });
      console.log('✓ Correo de prueba enviado a la misma cuenta.');
    }
  } catch (e) {
    console.log('✕ Gmail rechazó: ' + (e.responseCode || e.code || '') + ' ' + (e.response || e.message || ''));
    process.exitCode = 1;
  } finally {
    t.close();
  }
}

main();
