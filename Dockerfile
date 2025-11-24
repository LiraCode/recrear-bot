# Dockerfile para Bot Telegram Recrear no Lar
FROM node:20-alpine

# Define o diretório de trabalho
WORKDIR /app

# Copia os arquivos de configuração
COPY package*.json ./
COPY tsconfig.json ./

# Instala todas as dependências (incluindo dev para build)
RUN npm ci

# Copia o código fonte
COPY index.ts ./

# Compila o TypeScript
RUN npm run build

# Remove dependências de desenvolvimento após build
RUN npm prune --production

# Expõe a porta (se necessário no futuro)
# EXPOSE 3000

# Define o comando de inicialização
CMD ["npm", "start"]

