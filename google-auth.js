const { google } = require('googleapis');
const readline = require('readline');

const oauth2Client = new google.auth.OAuth2(
  'SEU_CLIENT_ID',
  'SEU_CLIENT_SECRET',
  'http://localhost:3000/oauth2callback'
);

const scopes = ['https://www.googleapis.com/auth/calendar'];

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: scopes,
});

console.log('Acesse esta URL no navegador:', authUrl);

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

rl.question('Cole o código aqui: ', async (code) => {
  const { tokens } = await oauth2Client.getToken(code);
  console.log('\nRefresh Token:', tokens.refresh_token);
  console.log('\nAdicione no .env:');
  console.log(JSON.stringify({
    client_id: 'SEU_CLIENT_ID',
    client_secret: 'SEU_CLIENT_SECRET',
    redirect_uri: 'http://localhost:3000/oauth2callback',
    refresh_token: tokens.refresh_token
  }));
  rl.close();
});