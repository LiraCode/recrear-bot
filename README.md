# Bot Telegram Recrear no Lar

Bot Telegram para gerenciamento de agendamentos, orçamentos, despesas e pagamentos.

## 🚀 Instalação

### 1. Instalar dependências

```bash
npm install
```

### 2. Configurar variáveis de ambiente

Crie um arquivo `.env` na raiz do projeto com as seguintes variáveis:

```env
TELEGRAM_BOT_TOKEN=seu_token_do_bot
ADMIN_CHAT_ID=seu_chat_id
MONGODB_URI=mongodb://usuario:senha@host:porta/database
GOOGLE_CREDENTIALS={"client_id":"...","client_secret":"...","redirect_uri":"...","refresh_token":"..."}
```

**Importante:** 
- O `GOOGLE_CREDENTIALS` deve ser um JSON válido em uma única linha
- Para obter o `ADMIN_CHAT_ID`, envie `/start` para [@userinfobot](https://t.me/userinfobot) no Telegram
- Para obter o `TELEGRAM_BOT_TOKEN`, crie um bot com [@BotFather](https://t.me/botfather)

### 3. Compilar o TypeScript

```bash
npm run build
```

### 4. Executar o bot

```bash
npm start
```

Ou em modo desenvolvimento:

```bash
npm run dev
```

## 📦 Docker

Veja [README-DOCKER.md](./README-DOCKER.md) para instruções de deploy no Docker Swarm.

## 🔧 Tecnologias

- **Telegraf** - Framework moderno para bots do Telegram
- **TypeScript** - Tipagem estática
- **MongoDB** - Banco de dados
- **Google Calendar API** - Integração com calendário
- **node-cron** - Agendamento de tarefas

## 📝 Comandos Disponíveis

Use `/ajuda` no bot para ver todos os comandos disponíveis.


