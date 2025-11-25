# Deploy no Docker Swarm

## Pré-requisitos

1. Docker Swarm inicializado
2. Redes externas criadas:
   - `traefik-public`
   - `recrearNet`

## Passos para Deploy

### 1. Criar as redes (se não existirem)

```bash
docker network create --driver overlay traefik-public
docker network create --driver overlay recrearNet
```

### 2. Construir a imagem primeiro

No Docker Swarm, é necessário construir a imagem antes de criar a stack:

```bash
# No nó manager do Swarm
docker build -t recrear-bot:latest .
```

Ou se estiver usando um registry:

```bash
docker build -t seu-registry/recrear-bot:latest .
docker push seu-registry/recrear-bot:latest
```

### 3. Configurar variáveis de ambiente

Crie um arquivo `.env` ou configure as variáveis no Portainer:

```env
TELEGRAM_BOT_TOKEN=seu_token_aqui
ADMIN_CHAT_ID=seu_chat_id
MONGODB_URI=mongodb://usuario:senha@host:porta/database
GOOGLE_CREDENTIALS={"client_id":"...","client_secret":"...","redirect_uri":"...","refresh_token":"..."}
```

### 4. Deploy da Stack

#### Opção 1: Via Portainer
- Vá em Stacks > Add Stack
- Cole o conteúdo do `docker-compose.yml`
- Configure as variáveis de ambiente
- Deploy

#### Opção 2: Via CLI

```bash
docker stack deploy -c docker-compose.yml recrear
```

### 5. Verificar o status

```bash
# Ver serviços da stack
docker stack services recrear

# Ver logs
docker service logs recrear_recrear-bot -f

# Ver detalhes do serviço
docker service ps recrear_recrear-bot
```

## Troubleshooting

### Container não inicia

1. **Verificar logs:**
   ```bash
   docker service logs recrear_recrear-bot --tail 100
   ```

2. **Verificar se a imagem foi construída:**
   ```bash
   docker images | grep recrear-bot
   ```

3. **Verificar variáveis de ambiente:**
   - Certifique-se de que todas as variáveis estão definidas
   - `GOOGLE_CREDENTIALS` deve ser um JSON válido

4. **Verificar redes:**
   ```bash
   docker network ls | grep -E "traefik-public|recrearNet"
   ```

### Erro de build

Se o build falhar, construa manualmente:

```bash
docker build -t recrear-bot:latest .
```

### Erro de permissões

Se houver erro de permissões, verifique se o usuário nodejs tem acesso aos arquivos:

```bash
docker exec -it <container_id> ls -la /app
```

## Atualização

Para atualizar a stack:

1. Faça pull das mudanças
2. Reconstrua a imagem:
   ```bash
   docker build -t recrear-bot:latest .
   ```
3. Atualize o serviço:
   ```bash
   docker service update --force recrear_recrear-bot
   ```

Ou via Portainer: Stack > Editor > Update Stack


