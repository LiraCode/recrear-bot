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

# Cria usuário não-root para segurança
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Ajusta permissões antes de mudar para usuário não-root
RUN chown -R nodejs:nodejs /app

USER nodejs

# Expõe a porta (se necessário no futuro)
# EXPOSE 3000

# Define o comando de inicialização
CMD ["npm", "start"]

