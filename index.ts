import 'dotenv/config';
import { Telegraf, Markup } from 'telegraf';
import { MongoClient, ObjectId } from 'mongodb';
import { google } from 'googleapis';
import cron from 'node-cron';

// ==================== CONFIGURAÇÕES ====================
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const MONGODB_URI = process.env.MONGODB_URI;
const GOOGLE_CREDENTIALS_STR = process.env.GOOGLE_CREDENTIALS;
const BACKOFFICE_URL = 'https://backoffice.recrearnolar.com.br';
const ADMIN_CHAT_ID_STR = process.env.ADMIN_CHAT_ID;
const AUTHORIZED_USERS_STR = process.env.AUTHORIZED_USERS;

// Validação de variáveis de ambiente
if (!TELEGRAM_TOKEN) {
  console.error('❌ Erro: TELEGRAM_BOT_TOKEN não está definido');
  process.exit(1);
}

if (!MONGODB_URI) {
  console.error('❌ Erro: MONGODB_URI não está definido');
  process.exit(1);
}

if (!GOOGLE_CREDENTIALS_STR) {
  console.error('❌ Erro: GOOGLE_CREDENTIALS não está definido');
  process.exit(1);
}

if (!ADMIN_CHAT_ID_STR) {
  console.error('❌ Erro: ADMIN_CHAT_ID não está definido');
  process.exit(1);
}

let GOOGLE_CREDENTIALS: any;
try {
  GOOGLE_CREDENTIALS = JSON.parse(GOOGLE_CREDENTIALS_STR);
} catch (error) {
  console.error('❌ Erro ao fazer parse de GOOGLE_CREDENTIALS:', error);
  process.exit(1);
}

const ADMIN_CHAT_ID = parseInt(ADMIN_CHAT_ID_STR);
if (isNaN(ADMIN_CHAT_ID)) {
  console.error('❌ Erro: ADMIN_CHAT_ID não é um número válido');
  process.exit(1);
}

// Lista de usuários autorizados
let AUTHORIZED_USERS: number[] = [];

if (AUTHORIZED_USERS_STR) {
  AUTHORIZED_USERS = AUTHORIZED_USERS_STR.split(',').map(id => parseInt(id.trim()));
  console.log('👥 Usuários autorizados:', AUTHORIZED_USERS);
} else {
  console.warn('⚠️  AUTHORIZED_USERS não definido. Bot funcionará para todos.');
}


// ==================== TYPES ====================
interface Pacote {
  _id?: ObjectId;
  responsavelId: ObjectId;
  mesReferencia: string;
  isPaid: boolean;
  valor: number;
  vencimento: Date;
  forma?: string;
  pagoEm?: Date;
  createdAt: Date;
  updatedAt: Date;
}

interface Agendamento {
  _id?: ObjectId;
  orcamentoId?: string;
  responsavelId?: ObjectId;
  tipo: 'evento' | 'festa' | 'pacote' | 'pessoal';
  data: Date;
  horario: string;
  duracao: number;
  status: 'pendente' | 'confirmado' | 'concluido' | 'cancelado';
  local: string;
  observacoes?: string;
  descricao: string;
  googleEventId?: string;
  createdAt: Date;
  updatedAt: Date;
}

interface Despesa {
  _id?: ObjectId;
  pacoteId?: string;
  tipo: 'pro_labore' | 'alimentacao' | 'transporte' | 'materiais' | 'marketing' |
  'equipamentos' | 'aluguel' | 'agua_luz' | 'telefonia' | 'impostos' |
  'manutencao' | 'terceirizados' | 'outros';
  valor: number;
  data: Date;
  descricao: string;
  formaPagamento?: 'pix' | 'dinheiro' | 'cartao_credito' | 'cartao_debito' | 'transferencia';
  createdAt: Date;
  updatedAt: Date;
}

interface Orcamento {
  _id?: ObjectId;
  cliente: string;
  tipo: 'festa' | 'evento';
  tipoPacote: 'avulso' | 'mensal';
  dataEvento?: Date;
  horario: string;
  quantidadeCriancas: number;
  quantidadeRecreadores: number;
  duracao: number;
  custoDeslocamento: number;
  desconto: number;
  isFeriadoOuFds: boolean;
  status: 'rascunho' | 'enviado' | 'aprovado' | 'concluido' | 'cancelado';
  endereco: string;
  complemento?: string;
  bairro: string;
  cidade: string;
  valorFinal: number;
  validade: Date;
  telefone?: string;
  createdAt: Date;
  updatedAt: Date;
}

// ==================== INICIALIZAÇÃO ====================
const bot = new Telegraf(TELEGRAM_TOKEN);
const mongoClient = new MongoClient(MONGODB_URI);
let db: any;

// Google Calendar
const oauth2Client = new google.auth.OAuth2(
  GOOGLE_CREDENTIALS.client_id,
  GOOGLE_CREDENTIALS.client_secret,
  GOOGLE_CREDENTIALS.redirect_uri
);
oauth2Client.setCredentials({ refresh_token: GOOGLE_CREDENTIALS.refresh_token });
const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

// Cores do Google Calendar por tipo
const CALENDAR_COLORS = {
  evento: '5',  // Laranja vibrante
  festa: '4',   // Rosa coral
  pacote: '10', // Verde esmeralda
  pessoal: '9'  // Azul claro
};

// ==================== CONEXÃO MONGODB ====================
async function connectDB() {
  await mongoClient.connect();
  db = mongoClient.db();
  console.log('✅ Conectado ao MongoDB');
}

// ==================== HELPERS ====================
const userStates = new Map<number, any>();

function formatCurrency(value: number): string {
  return `R$ ${value.toFixed(2).replace('.', ',')}`;
}

function formatDate(date: any) {
  if (!date) return '';
  try {
    const d = (date instanceof Date) ? date : new Date(date);
    if (isNaN(d.getTime())) {
      // fallback se for string no formato DD/MM/AAAA
      const [dia, mes, ano] = String(date).split('/');
      return `${dia.padStart(2, '0')}/${mes.padStart(2, '0')}/${ano}`;
    }
    return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
  } catch {
    return String(date);
  }
}
function parseDate(dateStr: string): Date {
  const [day, month, year] = dateStr.split('/');
  return new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
}

function escapeMarkdownV2(text: string) {
  if (!text) return '';
  return text.replace(/([_\[\]()~`>#+\-=|{}.!\\])/g, '\\$1')
    .replace(/-/g, '\-')   // hífen
    .replace(/\$/g, '\$')  // cifrão
    .replace(/\//g, '\/'); // barra
}
// ==================== GOOGLE CALENDAR ====================
async function createCalendarEvent(agendamento: Agendamento): Promise<string> {
  const event = {
    summary: `${agendamento.tipo.toUpperCase()} - ${agendamento.descricao}`,
    location: agendamento.local,
    description: agendamento.observacoes || '',
    start: {
      dateTime: new Date(`${agendamento.data.toISOString().split('T')[0]}T${agendamento.horario}`).toISOString(),
      timeZone: 'America/Maceio',
    },
    end: {
      dateTime: new Date(new Date(`${agendamento.data.toISOString().split('T')[0]}T${agendamento.horario}`).getTime() + agendamento.duracao * 3600000).toISOString(),
      timeZone: 'America/Maceio',
    },
    colorId: CALENDAR_COLORS[agendamento.tipo],
  };

  const response = await calendar.events.insert({
    calendarId: 'primary',
    requestBody: event,
  });

  return response.data.id!;
}

async function updateCalendarEvent(eventId: string, agendamento: Agendamento) {
  const event = {
    summary: `${agendamento.tipo.toUpperCase()} - ${agendamento.descricao}`,
    location: agendamento.local,
    description: agendamento.observacoes || '',
    start: {
      dateTime: new Date(`${agendamento.data.toISOString().split('T')[0]}T${agendamento.horario}`).toISOString(),
      timeZone: 'America/Maceio',
    },
    end: {
      dateTime: new Date(new Date(`${agendamento.data.toISOString().split('T')[0]}T${agendamento.horario}`).getTime() + agendamento.duracao * 3600000).toISOString(),
      timeZone: 'America/Maceio',
    },
    colorId: CALENDAR_COLORS[agendamento.tipo],
  };

  await calendar.events.update({
    calendarId: 'primary',
    eventId: eventId,
    requestBody: event,
  });
}

async function deleteCalendarEvent(eventId: string) {
  await calendar.events.delete({
    calendarId: 'primary',
    eventId: eventId,
  });
}

// ==================== CÁLCULO DE ORÇAMENTO ====================
function calcularValorOrcamento(orcamento: Partial<Orcamento>): number {
  const { quantidadeCriancas = 0, quantidadeRecreadores = 1, duracao = 0,
    isFeriadoOuFds = false, custoDeslocamento = 0, desconto = 0 } = orcamento;

  // Base por hora
  const valorPorHora = quantidadeCriancas <= 15 ? 200 : 250;
  const valorBase = valorPorHora * duracao;

  // Recreadores adicionais
  const valorRecreadores = (quantidadeRecreadores - 1) * 150;

  // Adicional feriado/FDS
  const adicionalFeriado = isFeriadoOuFds ? 50 : 0;

  return valorBase + valorRecreadores + adicionalFeriado + custoDeslocamento - desconto;
}

// ========================= Autenticação ==========================
// Middleware de autenticação
bot.use(async (ctx, next) => {
  const userId = ctx.from?.id;

  // Se não há lista de autorizados, permite todos
  if (AUTHORIZED_USERS.length === 0) {
    return next();
  }

  // Verifica se o usuário está autorizado
  if (userId && AUTHORIZED_USERS.includes(userId)) {
    return next();
  }

  // Usuário não autorizado
  console.log(`🚫 Acesso negado para usuário: ${userId} (${ctx.from?.first_name})`);

  await ctx.reply(
    '🚫 *Acesso Negado*\n\n' +
    'Você não tem permissão para usar este bot.\n\n' +
    'Entre em contato com o administrador.',
    { parse_mode: 'Markdown' }
  );

  // Notifica o admin
  try {
    await bot.telegram.sendMessage(
      ADMIN_CHAT_ID,
      `🚫 Tentativa de acesso não autorizado:\n\n` +
      `👤 Nome: ${ctx.from?.first_name} ${ctx.from?.last_name || ''}\n` +
      `🆔 ID: ${userId}\n` +
      `📝 Username: @${ctx.from?.username || 'sem username'}`
    );
  } catch (error) {
    console.error('Erro ao notificar admin:', error);
  }
});

// ==================== COMANDOS - MENU PRINCIPAL ====================
bot.command('start', (ctx) => {
  ctx.reply(
    '🎉 *Bem-vindo ao Bot Recrear no Lar!*\n\n' +
    'Use /ajuda para ver todos os comandos disponíveis.',
    { parse_mode: 'Markdown' }
  );
});

bot.command('ajuda', (ctx) => {
  const helpText = `
📋 *COMANDOS DISPONÍVEIS*

💰 *PAGAMENTOS*
/buscar\\_pagamento - Consultar pagamento
/registrar\\_pagamento - Registrar pagamento de pacote
/pagamentos\\_pendentes - Listar pacotes não pagos

📅 *AGENDAMENTOS*
/criar\\_agendamento - Criar novo agendamento
/listar\\_agendamentos - Ver agendamentos
/editar\\_agendamento - Editar agendamento
/cancelar\\_agendamento - Cancelar agendamento
/mudar\\_status - Alterar status

💸 *DESPESAS*
/adicionar\\_despesa - Registrar despesa
/listar\\_despesas - Ver despesas
/editar\\_despesa - Editar despesa
/excluir\\_despesa - Remover despesa
/total\\_despesas - Total por período

📊 *ORÇAMENTOS*
/criar\\_orcamento - Criar orçamento
/listar\\_orcamentos - Ver orçamentos
/editar\\_orcamento - Editar orçamento
/status\\_orcamento - Alterar status
/enviar\\_orcamento - Enviar link do orçamento

📈 *RELATÓRIOS*
/relatorio\\_mensal - Relatório de receitas/despesas

🔧 *UTILITÁRIOS*
/ajuda - Esta mensagem
  `;

  ctx.reply(helpText, { parse_mode: 'Markdown' });
});

// ==================== PAGAMENTOS ====================
bot.command('buscar_pagamento', async (ctx) => {
  const chatId = ctx.chat.id;
  userStates.set(chatId, { command: 'buscar_pagamento', step: 'vencimento' });
  ctx.reply('📅 Digite a data de vencimento (formato: DD/MM/AAAA):');
});

bot.command('registrar_pagamento', async (ctx) => {
  const chatId = ctx.chat.id;
  userStates.set(chatId, { command: 'registrar_pagamento', step: 'vencimento' });
  ctx.reply('📅 Digite a data de vencimento (formato: DD/MM/AAAA):');
});

bot.command('pagamentos_pendentes', async (ctx) => {
  const chatId = ctx.chat.id;

  try {
    const pacotes = await db.collection('pagamentos').find({ isPaid: false }).toArray();

    if (pacotes.length === 0) {
      ctx.reply('✅ Não há pagamentos pendentes!');
      return;
    }

    let message = '📋 *PAGAMENTOS PENDENTES*\n\n';

    for (const pacote of pacotes) {
      const responsavel = await db.collection('responsaveis').findOne({ _id: pacote.responsavelId });
      message += `👤 ${responsavel?.nome || 'Desconhecido'}\n`;
      message += `📅 Vencimento: ${formatDate(new Date(pacote.vencimento))}\n`;
      message += `💰 Valor: ${formatCurrency(pacote.valor)}\n`;
      message += `📆 Mês: ${pacote.mesReferencia}\n`;
      message += '---\n';
    }

    ctx.reply(message, { parse_mode: 'Markdown' });
  } catch (error) {
    ctx.reply('❌ Erro ao buscar pagamentos pendentes.');
    console.error(error);
  }
});

// ==================== AGENDAMENTOS ====================
bot.command('criar_agendamento', (ctx) => {
  const chatId = ctx.chat.id;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🎉 Evento', 'ag_tipo_evento')],
    [Markup.button.callback('🎈 Festa', 'ag_tipo_festa')],
    [Markup.button.callback('📦 Pacote', 'ag_tipo_pacote')],
    [Markup.button.callback('👤 Pessoal', 'ag_tipo_pessoal')]
  ]);

  userStates.set(chatId, { command: 'criar_agendamento', data: {} });
  ctx.reply('Selecione o tipo de agendamento:', keyboard);
});

bot.command('listar_agendamentos', (ctx) => {
  const chatId = ctx.chat.id;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('📅 Hoje', 'list_ag_hoje')],
    [Markup.button.callback('📆 Esta semana', 'list_ag_semana')],
    [Markup.button.callback('🗓️ Data específica', 'list_ag_data')]
  ]);

  ctx.reply('Selecione o período:', keyboard);
});

bot.command('cancelar_agendamento', (ctx) => {
  const chatId = ctx.chat.id;
  userStates.set(chatId, { command: 'cancelar_agendamento', step: 'data' });
  ctx.reply('📅 Digite a data do agendamento (DD/MM/AAAA):');
});

bot.command('mudar_status', (ctx) => {
  const chatId = ctx.chat.id;
  userStates.set(chatId, { command: 'mudar_status', step: 'data' });
  ctx.reply('📅 Digite a data do agendamento (DD/MM/AAAA):');
});

// ==================== DESPESAS ====================
bot.command('adicionar_despesa', (ctx) => {
  const chatId = ctx.chat.id;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('💼 Pró-labore', 'desp_pro_labore')],
    [Markup.button.callback('🍔 Alimentação', 'desp_alimentacao')],
    [Markup.button.callback('🚗 Transporte', 'desp_transporte')],
    [Markup.button.callback('📦 Materiais', 'desp_materiais')],
    [Markup.button.callback('📢 Marketing', 'desp_marketing')],
    [Markup.button.callback('🔧 Equipamentos', 'desp_equipamentos')],
    [Markup.button.callback('🏢 Aluguel', 'desp_aluguel')],
    [Markup.button.callback('💡 Água/Luz', 'desp_agua_luz')],
    [Markup.button.callback('📱 Telefonia', 'desp_telefonia')],
    [Markup.button.callback('📋 Impostos', 'desp_impostos')],
    [Markup.button.callback('🛠️ Manutenção', 'desp_manutencao')],
    [Markup.button.callback('👥 Terceirizados', 'desp_terceirizados')],
    [Markup.button.callback('📌 Outros', 'desp_outros')]
  ]);

  userStates.set(chatId, { command: 'adicionar_despesa', data: {} });
  ctx.reply('Selecione o tipo de despesa:', keyboard);
});

bot.command('listar_despesas', (ctx) => {
  const chatId = ctx.chat.id;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('📅 Hoje', 'list_desp_hoje')],
    [Markup.button.callback('📆 Esta semana', 'list_desp_semana')],
    [Markup.button.callback('🗓️ Este mês', 'list_desp_mes')],
    [Markup.button.callback('📊 Período personalizado', 'list_desp_periodo')]
  ]);

  ctx.reply('Selecione o período:', keyboard);
});

bot.command('total_despesas', async (ctx) => {
  const chatId = ctx.chat.id;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('📅 Hoje', 'total_desp_hoje')],
    [Markup.button.callback('📆 Esta semana', 'total_desp_semana')],
    [Markup.button.callback('🗓️ Este mês', 'total_desp_mes')]
  ]);

  ctx.reply('Selecione o período:', keyboard);
});

// ==================== ORÇAMENTOS ====================
bot.command('criar_orcamento', (ctx) => {
  const chatId = ctx.chat.id;
  userStates.set(chatId, { command: 'criar_orcamento', step: 'cliente', data: {} });
  ctx.reply('👤 Digite o nome do cliente:');
});

bot.command('listar_orcamentos', (ctx) => {
  const chatId = ctx.chat.id;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('📝 Rascunhos', 'list_orc_rascunho')],
    [Markup.button.callback('📤 Enviados', 'list_orc_enviado')],
    [Markup.button.callback('✅ Aprovados', 'list_orc_aprovado')],
    [Markup.button.callback('🎉 Concluídos', 'list_orc_concluido')],
    [Markup.button.callback('📋 Todos', 'list_orc_todos')]
  ]);

  ctx.reply('Filtrar por status:', keyboard);
});

bot.command('enviar_orcamento', (ctx) => {
  const chatId = ctx.chat.id;
  userStates.set(chatId, { command: 'enviar_orcamento', step: 'buscar' });
  ctx.reply('🔍 Digite o nome do cliente para buscar o orçamento:');
});

bot.command('status_orcamento', (ctx) => {
  const chatId = ctx.chat.id;
  userStates.set(chatId, { command: 'status_orcamento', step: 'buscar' });
  ctx.reply('🔍 Digite o nome do cliente para buscar o orçamento:');
});

// ==================== Relatórios ====================

bot.command('relatorio_mensal', (ctx) => {
  const chatId = ctx.chat.id;
  userStates.set(chatId, { command: 'relatorio_mensal', step: 'mes' });
  ctx.reply('📅 Digite o mês/ano (formato: MM/AAAA):');
});

// ==================== CALLBACK HANDLERS ====================

// ==================== MESSAGE HANDLER ====================
bot.on('text', async (ctx) => {
  if (ctx.message.text.startsWith('/')) return; // Ignora comandos

  const chatId = ctx.chat.id;
  const state = userStates.get(chatId);

  if (!state) return;

  const text = ctx.message.text;

  // ========== BUSCAR/REGISTRAR PAGAMENTO ==========
  if (state.command === 'buscar_pagamento' || state.command === 'registrar_pagamento') {
    if (state.step === 'vencimento') {
      try {
        const vencimento = parseDate(text);
        state.data = { vencimento };
        state.step = 'responsavel';
        ctx.reply('👤 Digite o nome do responsável:');
      } catch (error) {
        ctx.reply('❌ Data inválida. Use o formato DD/MM/AAAA');
      }
    } else if (state.step === 'responsavel') {
      try {
        const responsavel = await db.collection('responsaveis').findOne({
          nome: text.trim()
        });

        if (!responsavel) {
          ctx.reply('❌ Responsável não encontrado.');
          userStates.delete(chatId);
          return;
        }
        const inicioDia = new Date(state.data.vencimento);
        inicioDia.setHours(0, 0, 0, 0);   // 00:00:00

        const fimDia = new Date(state.data.vencimento);
        fimDia.setHours(23, 59, 59, 999); // 23:59:59

        const pagamento = await db.collection('pagamentos').findOne({
          responsavelId: responsavel._id,
          vencimento: { $gte: inicioDia, $lt: fimDia }
        });

        console.log("Pagamento:", pagamento);
        console.log("Vencimento:", state.data.vencimento);
        console.log("Responsável ID:", responsavel._id);

        if (!pagamento) {
          ctx.reply('❌   pagamento não encontrado para esta data e responsável.');
          userStates.delete(chatId);
          return;
        }

        let message = `📦 *PAGAMENTO ENCONTRADO*\n\n`;
        message += `👤 Responsável: ${responsavel.nome}\n`;
        message += `📆 Mês: ${pagamento.mesReferencia}\n`;
        message += `💰 Valor: ${formatCurrency(pagamento.valor)}\n`;
        message += `📅 Vencimento: ${formatDate(new Date(pagamento.vencimento))}\n`;
        message += `✅ Pago: ${pagamento.isPaid ? 'Sim' : 'Não'}\n`;

        if (pagamento.isPaid) {
          message += `💳 Forma: ${pagamento.forma}\n`;
          message += `📅 Pago em: ${formatDate(new Date(pagamento.pagoEm))}\n`;
        }

        if (state.command === 'registrar_pagamento' && !pagamento.isPaid) {
          state.data.pacoteId = pagamento._id;
          state.step = 'forma';

          const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('💳 PIX', 'pag_pix')],
            [Markup.button.callback('💵 Dinheiro', 'pag_dinheiro')],
            [Markup.button.callback('💳 Cartão', 'pag_cartao')],
            [Markup.button.callback('🏦 Transferência', 'pag_transferencia')]
          ]);

          ctx.reply(message + '\n💳 Selecione a forma de pagamento:', {
            parse_mode: 'Markdown',
            ...keyboard
          });
        } else {
          ctx.reply(message, { parse_mode: 'Markdown' });
          userStates.delete(chatId);
        }
      } catch (error) {
        ctx.reply('❌ Erro ao buscar pagamento.');
        console.error(error);
        userStates.delete(chatId);
      }
    }
  }

  // ========== ADICIONAR DESPESA ==========
  if (state.command === 'adicionar_despesa') {
    if (state.step === 'valor') {
      state.data.valor = parseFloat(text.replace(',', '.'));
      state.step = 'data';

      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('📅 Hoje', 'desp_data_hoje')],
        [Markup.button.callback('🗓️ Outra data', 'desp_data_outra')]
      ]);
      ctx.reply('Quando foi a despesa?', keyboard);
    } else if (state.step === 'data_manual') {
      try {
        state.data.data = parseDate(text);
        state.step = 'descricao';
        ctx.reply('📝 Digite a descrição da despesa:');
      } catch (error) {
        ctx.reply('❌ Data inválida. Use DD/MM/AAAA');
      }
    } else if (state.step === 'descricao') {
      state.data.descricao = text;

      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('💳 PIX', 'desp_pag_pix')],
        [Markup.button.callback('💵 Dinheiro', 'desp_pag_dinheiro')],
        [Markup.button.callback('💳 Cartão Crédito', 'desp_pag_cartao_credito')],
        [Markup.button.callback('💳 Cartão Débito', 'desp_pag_cartao_debito')],
        [Markup.button.callback('🏦 Transferência', 'desp_pag_transferencia')],
        [Markup.button.callback('⏭️ Pular', 'desp_pag_pular')]
      ]);

      ctx.reply('Forma de pagamento (opcional):', keyboard);
    }
  }

  // ========== CRIAR ORÇAMENTO ==========
  if (state.command === 'criar_orcamento') {
    if (state.step === 'cliente') {
      state.data.cliente = text;
      state.step = 'tipo';

      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('🎉 Festa', 'orc_tipo_festa')],
        [Markup.button.callback('📅 Evento', 'orc_tipo_evento')]
      ]);
      ctx.reply('Tipo de serviço:', keyboard);
    } else if (state.step === 'data') {
      try {
        state.data.dataEvento = parseDate(text);
        state.step = 'horario';
        ctx.reply('⏰ Digite o horário (HH:MM):');
      } catch (error) {
        ctx.reply('❌ Data inválida. Use DD/MM/AAAA');
      }
    } else if (state.step === 'horario') {
      state.data.horario = text;
      state.step = 'criancas';
      ctx.reply('👶 Quantidade de crianças:');
    } else if (state.step === 'criancas') {
      state.data.quantidadeCriancas = parseInt(text);
      state.step = 'duracao';
      ctx.reply('⏱️ Duração em horas (ex: 2 ou 1.5):');
    } else if (state.step === 'duracao') {
      state.data.duracao = parseFloat(text.replace(',', '.'));

      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('1 recreador', 'orc_rec_1')],
        [Markup.button.callback('2 recreadores', 'orc_rec_2')],
        [Markup.button.callback('3 recreadores', 'orc_rec_3')],
        [Markup.button.callback('Outro', 'orc_rec_outro')]
      ]);

      ctx.reply('Quantidade de recreadores:', keyboard);
    } else if (state.step === 'recreadores_manual') {
      state.data.quantidadeRecreadores = parseInt(text);

      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('Sim', 'orc_fds_sim')],
        [Markup.button.callback('Não', 'orc_fds_nao')]
      ]);

      ctx.reply('É feriado ou fim de semana?', keyboard);
    } else if (state.step === 'deslocamento') {
      state.data.custoDeslocamento = parseFloat(text.replace(',', '.')) || 0;
      state.step = 'desconto';
      ctx.reply('💰 Desconto (ou 0):');
    } else if (state.step === 'desconto') {
      state.data.desconto = parseFloat(text.replace(',', '.')) || 0;
      state.step = 'endereco';
      ctx.reply('📍 Digite o endereço:');
    } else if (state.step === 'endereco') {
      state.data.endereco = text;
      state.step = 'complemento';
      ctx.reply('📍 Complemento (ou "pular"):');
    } else if (state.step === 'complemento') {
      if (text.toLowerCase() !== 'pular') {
        state.data.complemento = text;
      }
      state.step = 'bairro';
      ctx.reply('🏘️ Bairro:');
    } else if (state.step === 'bairro') {
      state.data.bairro = text;
      state.step = 'cidade';
      ctx.reply('🏙️ Cidade:');
    } else if (state.step === 'cidade') {
      state.data.cidade = text;
      state.step = 'telefone';
      ctx.reply('📱 Telefone (opcional, ou "pular"):');
    } else if (state.step === 'telefone') {
      if (text.toLowerCase() !== 'pular') {
        state.data.telefone = text;
      }

      // Calcula o valor final
      state.data.valorFinal = calcularValorOrcamento(state.data);
      state.data.status = 'rascunho';
      state.data.tipoPacote = 'avulso';
      state.data.validade = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 dias
      state.data.createdAt = new Date();
      state.data.updatedAt = new Date();

      try {
        const result = await db.collection('orcamentos').insertOne(state.data);
        const orcamentoId = result.insertedId.toString();

        let message = '✅ *Orçamento criado com sucesso!*\n\n';
        message += `👤 Cliente: ${state.data.cliente}\n`;
        message += `📅 Data: ${formatDate(state.data.dataEvento)}\n`;
        message += `⏰ Horário: ${state.data.horario}\n`;
        message += `💰 Valor: ${formatCurrency(state.data.valorFinal)}\n`;
        message += `🆔 ID: ${orcamentoId}\n\n`;
        message += `🔗 Link: ${BACKOFFICE_URL}/orcamentos/visualizar/${orcamentoId}`;

        ctx.reply(message, { parse_mode: 'Markdown' });
        userStates.delete(chatId);
      } catch (error) {
        ctx.reply('❌ Erro ao criar orçamento.');
        console.error(error);
        userStates.delete(chatId);
      }
    }
  }

  // ========== CRIAR AGENDAMENTO ==========
  if (state.command === 'criar_agendamento') {
    if (state.step === 'orcamento_id') {
      state.data.orcamentoId = text;
      state.step = 'data';
      ctx.reply('📅 Digite a data (DD/MM/AAAA):');
    } else if (state.step === 'responsavel_nome') {
      try {
        const responsavel = await db.collection('responsaveis').findOne({
          nome: { $regex: text, $options: 'i' }
        });

        if (!responsavel) {
          ctx.reply('❌ Responsável não encontrado.');
          userStates.delete(chatId);
          return;
        }

        state.data.responsavelId = responsavel._id;
        state.step = 'data';
        ctx.reply('📅 Digite a data (DD/MM/AAAA):');
      } catch (error) {
        ctx.reply('❌ Erro ao buscar responsável.');
        console.error(error);
        userStates.delete(chatId);
      }
    } else if (state.step === 'data') {
      try {
        state.data.data = parseDate(text);
        state.step = 'horario';
        ctx.reply('⏰ Digite o horário (HH:MM):');
      } catch (error) {
        ctx.reply('❌ Data inválida. Use DD/MM/AAAA');
      }
    } else if (state.step === 'horario') {
      state.data.horario = text;
      state.step = 'duracao';
      ctx.reply('⏱️ Duração em horas:');
    } else if (state.step === 'duracao') {
      state.data.duracao = parseFloat(text.replace(',', '.'));
      state.step = 'local';
      ctx.reply('📍 Digite o local:');
    } else if (state.step === 'local') {
      state.data.local = text;
      state.step = 'descricao';
      ctx.reply('📝 Digite a descrição:');
    } else if (state.step === 'descricao') {
      state.data.descricao = text;
      state.step = 'observacoes';
      ctx.reply('💬 Observações (ou "pular"):');
    } else if (state.step === 'observacoes') {
      if (text.toLowerCase() !== 'pular') {
        state.data.observacoes = text;
      }
      state.data.status = 'pendente';
      state.data.createdAt = new Date();
      state.data.updatedAt = new Date();

      try {
        // Cria evento no Google Calendar
        const googleEventId = await createCalendarEvent(state.data);
        state.data.googleEventId = googleEventId;

        // Salva no banco
        await db.collection('agendamentos').insertOne(state.data);

        ctx.reply('✅ Agendamento criado com sucesso!');
        userStates.delete(chatId);
      } catch (error) {
        ctx.reply('❌ Erro ao criar agendamento.');
        console.error(error);
        userStates.delete(chatId);
      }
    }
  }

  // ========== MUDAR STATUS AGENDAMENTO ==========
  if (state.command === 'mudar_status') {
    if (state.step === 'data') {
      try {
        const data = parseDate(text); // DD/MM/AAAA
        state.data = { data };
        state.step = 'hora';
        ctx.reply('⏰ Digite a hora do agendamento (formato HH:mm):');
      } catch (error) {
        ctx.reply('❌ Data inválida. Use o formato DD/MM/AAAA');
      }
    } else if (state.step === 'hora') {
      try {
        const inicioDia = new Date(state.data.data);
        inicioDia.setHours(0, 0, 0, 0);

        const fimDia = new Date(state.data.data);
        fimDia.setHours(23, 59, 59, 999);

        const agendamento = await db.collection('agendamentos').findOne({
          horario: text.trim(),
          data: { $gte: inicioDia, $lte: fimDia }
        });

        if (!agendamento) {
          ctx.reply('❌ Nenhum agendamento encontrado para esta data/hora.');
          userStates.delete(chatId);
          return;
        }

        state.step = 'status';
        state.data.agendamentoId = agendamento._id; // guarda o id para usar depois

        const keyboard = Markup.inlineKeyboard([
          [Markup.button.callback('✅ Confirmado', 'status_confirmado')],
          [Markup.button.callback('❌ Cancelado', 'status_cancelado')],
          [Markup.button.callback('⏳ agendado', 'status_agendado')],
          [Markup.button.callback('📌 Concluído', 'status_concluido')]
        ]);

        ctx.reply('📌 Selecione o novo status para este agendamento:', keyboard);
      } catch (error) {
        ctx.reply('❌ Hora inválida. Use o formato HH:mm - ' + error);
      }
    }

  }
  // ========== RELATÓRIO MENSAL ==========
  if (state.command === 'relatorio_mensal') {
    if (state.step === 'mes') {
      try {
        const [mes, ano] = text.split('/');
        const mesAno = `${ano}-${mes.padStart(2, '0')}`;
        await enviarRelatorioMensal(chatId, mesAno);
        userStates.delete(chatId);
      } catch (error) {
        ctx.reply('❌ Formato inválido. Use MM/AAAA');
      }
    }
  }

  // ========== ENVIAR ORÇAMENTO ==========
  if (state.command === 'enviar_orcamento') {
    if (state.step === 'buscar') {
      try {
        const orcamentos = await db.collection('orcamentos').find({
          cliente: { $regex: text, $options: 'i' }
        }).sort({ createdAt: -1 }).limit(5).toArray();

        if (orcamentos.length === 0) {
          ctx.reply('❌ Nenhum orçamento encontrado.');
          userStates.delete(chatId);
          return;
        }

        if (orcamentos.length === 1) {
          const orc = orcamentos[0];
          const link = `${BACKOFFICE_URL}/orcamentos/visualizar/${orc._id}`;
          ctx.reply(`🔗 Link do orçamento:\n${link}`);
          userStates.delete(chatId);
        } else {
          // Múltiplos orçamentos - mostra lista
          let message = '📋 *Orçamentos encontrados:*\n\n';
          for (const orc of orcamentos) {
            message += `👤 ${orc.cliente}\n`;
            message += `📅 ${formatDate(orc.dataEvento)}\n`;
            message += `💰 ${formatCurrency(orc.valorFinal)}\n`;
            message += `🔗 ${BACKOFFICE_URL}/orcamentos/visualizar/${orc._id}\n\n`;
          }
          ctx.reply(message, { parse_mode: 'Markdown' });
          userStates.delete(chatId);
        }
      } catch (error) {
        ctx.reply('❌ Erro ao buscar orçamento.');
        console.error(error);
        userStates.delete(chatId);
      }
    }
  }

  // ========== STATUS ORÇAMENTO ==========
  if (state.command === 'status_orcamento') {
    if (state.step === 'buscar') {
      try {
        const inicioDia = new Date(state.data.data);
        inicioDia.setHours(0, 0, 0, 0);

        const fimDia = new Date(state.data.data);
        fimDia.setHours(23, 59, 59, 999);

        const orcamentos = await db.collection('orcamentos').find({
          cliente: { $regex: text, $options: 'i' },
          dataEvento: { $gte: inicioDia, $lt: fimDia }
        }).sort({ createdAt: -1 }).limit(5).toArray();

        if (orcamentos.length === 0) {
          ctx.reply('❌ Nenhum orçamento encontrado.');
          userStates.delete(chatId);
          return;
        }

        // Cria botões para cada orçamento encontrado
        const botoesOrcamentos = orcamentos.map((o: Orcamento) => [
          {
            text:
              `📄 Cliente: ${o.cliente}\n` +
              `🆔 ID: ${o._id}\n` +
              `📅 Data: ${o.dataEvento}\n` +
              `⏰ Horário: ${o.horario}\n` +
              `🕒 Duração: ${o.duracao}\n` +
              `💰 Valor: R$ ${o.valorFinal}\n` +
              `📌 Status: ${o.status}`,
            callback_data: `editar_status:${o._id}`
          }
        ]);


        await ctx.reply(
          '📌 Selecione o orçamento para editar o status:',
          {
            reply_markup: {
              inline_keyboard: botoesOrcamentos
            }
          }
        );

      } catch (error) {
        ctx.reply('❌ Erro ao buscar orçamento.');
        console.error(error);
        userStates.delete(chatId);
      }
    }
  }


  // ========== LISTAR AGENDAMENTOS - DATA ESPECÍFICA ==========
  if (state.command === 'listar_agendamentos') {
    if (state.step === 'data_especifica') {
      try {
        const data = parseDate(text);
        const inicio = new Date(data);
        inicio.setHours(0, 0, 0, 0);
        const fim = new Date(inicio);
        fim.setDate(fim.getDate() + 1);

        await listarAgendamentos(chatId, 'hoje');
        // Sobrescreve a data para a data específica
        const agendamentos = await db.collection('agendamentos').find({
          data: { $gte: inicio, $lt: fim },
          status: { $ne: 'cancelado' }
        }).sort({ data: 1, horario: 1 }).toArray();

        if (agendamentos.length === 0) {
          ctx.reply('📭 Não há agendamentos para esta data.');
        } else {
          let message = `📅 *AGENDAMENTOS - ${formatDate(data)}*\n\n`;

          const tipoEmoji: { [key: string]: string } = { evento: '🎉', festa: '🎈', pacote: '📦', pessoal: '👤' };
          const statusEmojiMap: { [key: string]: string } = { pendente: '⏳', confirmado: '✅', concluido: '🎉', cancelado: '❌' };

          for (const ag of agendamentos) {
            const emoji = tipoEmoji[ag.tipo] || '📅';
            const statusEmoji = statusEmojiMap[ag.status] || '❓';

            message += `${emoji} ${ag.tipo.toUpperCase()} - ${ag.horario}\n`;
            message += `📝 ${ag.descricao}\n`;
            message += `📍 ${ag.local}\n`;
            message += `⏱️ ${ag.duracao}h\n`;
            message += `${statusEmoji} ${ag.status.toUpperCase()}\n`;
            message += '---\n';
          }

          ctx.reply(message, { parse_mode: 'Markdown' });
        }

        userStates.delete(chatId);
      } catch (error) {
        ctx.reply('❌ Data inválida. Use DD/MM/AAAA');
      }
    }
  }

  // ========== LISTAR DESPESAS - PERÍODO PERSONALIZADO ==========
  if (state.command === 'listar_despesas') {
    if (state.step === 'inicio') {
      try {
        state.data.inicio = parseDate(text);
        state.step = 'fim';
        ctx.reply('📅 Digite a data final (DD/MM/AAAA):');
      } catch (error) {
        ctx.reply('❌ Data inválida. Use DD/MM/AAAA');
      }
    } else if (state.step === 'fim') {
      try {
        const fim = parseDate(text);
        const inicio = state.data.inicio;
        inicio.setHours(0, 0, 0, 0);
        fim.setHours(23, 59, 59, 999);

        const despesas = await db.collection('despesas').find({
          data: { $gte: inicio, $lte: fim }
        }).sort({ data: -1 }).toArray();

        if (despesas.length === 0) {
          ctx.reply('📭 Não há despesas para este período.');
          userStates.delete(chatId);
          return;
        }

        let message = `💸 *DESPESAS \\- ${escapeMarkdownV2(formatDate(inicio))} a ${escapeMarkdownV2(formatDate(fim))}*\n\n`;
        let total = 0;

        const tiposLabels: { [key: string]: string } = {
          pro_labore: '💼', alimentacao: '🍔', transporte: '🚗',
          materiais: '📦', marketing: '📢', equipamentos: '🔧',
          aluguel: '🏢', agua_luz: '💡', telefonia: '📱',
          impostos: '📋', manutencao: '🛠️', terceirizados: '👥', outros: '📌'
        };

        for (const desp of despesas) {
          message += `${tiposLabels[desp.tipo] || '📌'} ${escapeMarkdownV2(desp.descricao)}\n`;
          message += `💰 ${escapeMarkdownV2(formatCurrency(desp.valor))} \\- ${escapeMarkdownV2(formatDate(desp.data))}\n`;
          if (desp.formaPagamento) message += `💳 ${escapeMarkdownV2(desp.formaPagamento)}\n`;
          message += escapeMarkdownV2('---\n');
          total += desp.valor;
        }

        message += `\n💵 *TOTAL: ${escapeMarkdownV2(formatCurrency(total))}*`;

        ctx.reply(message, { parse_mode: 'MarkdownV2' });
        console.log(message);
        userStates.delete(chatId);
      } catch (error) {
        ctx.reply('❌ Data inválida. Use DD/MM/AAAA');
      }
    }
  }
});

// ==================== LEMBRETES E CRON JOBS ====================

// Lembrete diário às 6h
cron.schedule('0 6 * * *', async () => {
  try {
    const hoje = new Date();
    hoje.setHours(0, 0, 0, 0);
    const amanha = new Date(hoje);
    amanha.setDate(amanha.getDate() + 1);

    const agendamentos = await db.collection('agendamentos').find({
      data: { $gte: hoje, $lt: amanha },
      status: { $ne: 'cancelado' }
    }).toArray();

    if (agendamentos.length === 0) {
      bot.telegram.sendMessage(ADMIN_CHAT_ID, '☀️ Bom dia! Não há agendamentos no sistema para hoje.');
      return;
    }

    let message = '☀️ *BOM DIA! Agendamentos de hoje:*\n\n';

    for (const ag of agendamentos) {
      const tipoEmoji: { [key: string]: string } = { evento: '🎉', festa: '🎈', pacote: '📦', pessoal: '👤' };
      const emoji = tipoEmoji[ag.tipo] || '📅';
      message += `${emoji} ${ag.horario} - ${ag.tipo.toUpperCase()}\n`;
      message += `📝 ${ag.descricao}\n`;
      message += `📍 ${ag.local}\n`;
      message += `⏱️ ${ag.duracao}h\n\n`;
    }

    message += `📋 Total: ${agendamentos.length} agendamento(s)`;

    bot.telegram.sendMessage(ADMIN_CHAT_ID, message, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('Erro no lembrete diário:', error);
  }
});

// Lembrete 1 hora antes - verifica a cada 15 minutos
cron.schedule('*/15 * * * *', async () => {
  try {
    const agora = new Date();
    const umaHoraDepois = new Date(agora.getTime() + 60 * 60 * 1000);

    const agendamentos = await db.collection('agendamentos').find({
      status: { $ne: 'cancelado' },
      lembreteEnviado: { $ne: true }
    }).toArray();

    for (const ag of agendamentos) {
      const dataHoraAgendamento = new Date(`${ag.data.toISOString().split('T')[0]}T${ag.horario}`);
      const diffMinutos = (dataHoraAgendamento.getTime() - agora.getTime()) / 1000 / 60;

      // Envia lembrete entre 55 e 65 minutos antes
      if (diffMinutos >= 55 && diffMinutos <= 65) {
        const tipoEmoji: { [key: string]: string } = { evento: '🎉', festa: '🎈', pacote: '📦', pessoal: '👤' };
        const emoji = tipoEmoji[ag.tipo] || '📅';

        let message = '⏰ *LEMBRETE - Em 1 hora!*\n\n';
        message += `${emoji} ${ag.tipo.toUpperCase()} - ${ag.horario}\n`;
        message += `📝 ${ag.descricao}\n`;
        message += `📍 ${ag.local}\n`;
        message += `⏱️ Duração: ${ag.duracao}h\n`;
        if (ag.observacoes) message += `💬 ${ag.observacoes}\n`;

        const keyboard = Markup.inlineKeyboard([
          [Markup.button.callback('✅ Confirmar', `ag_conf_${ag._id}`)],
          [Markup.button.callback('📅 Reagendar', `ag_reag_${ag._id}`)],
          [Markup.button.callback('❌ Cancelar', `ag_canc_${ag._id}`)]
        ]);

        await bot.telegram.sendMessage(ADMIN_CHAT_ID, message, {
          parse_mode: 'Markdown',
          ...keyboard
        });

        // Marca como lembrete enviado
        await db.collection('agendamentos').updateOne(
          { _id: ag._id },
          { $set: { lembreteEnviado: true } }
        );
      }
    }
  } catch (error) {
    console.error('Erro no lembrete de 1h:', error);
  }
});

// Relatório mensal automático - dia 1º às 8h
cron.schedule('0 8 1 * *', async () => {
  try {
    const mesAnterior = new Date();
    mesAnterior.setMonth(mesAnterior.getMonth() - 1);
    const mesAno = `${mesAnterior.getFullYear()}-${String(mesAnterior.getMonth() + 1).padStart(2, '0')}`;

    await enviarRelatorioMensal(ADMIN_CHAT_ID, mesAno);
  } catch (error) {
    console.error('Erro no relatório mensal automático:', error);
  }
});

// ==================== FUNÇÃO DE RELATÓRIO MENSAL ====================
async function enviarRelatorioMensal(chatId: number, mesAno: string) {
  try {
    const [ano, mes] = mesAno.split('-');
    const inicioMes = new Date(parseInt(ano), parseInt(mes) - 1, 1);
    const fimMes = new Date(parseInt(ano), parseInt(mes), 1);

    // RECEITAS - pagamentos de orçamento usando a colletion orcamentos_pagamentos para pegar o pagamento de agendamentos tambem
    const PagamentosOrc = await db.collection('orcamentos_pagamentos').aggregate([
      {
        $match: {
          dataPagamento: { $gte: inicioMes, $lt: fimMes }
        }
      },
      {
        $group: {
          _id: null,
          total: { $sum: "$valor" }
        }
      }
    ]).toArray();

    const receitaOrcamentos = PagamentosOrc.length > 0 ? PagamentosOrc[0].total : 0;

    // RECEITAS - Pacotes pagos alterei o find para agregate
    const pacotesPagos = await db.collection('pagamentos').aggregate([
      {
        $match: {
          isPaid: true,
          pagoEm: { $gte: inicioMes, $lt: fimMes }
        }
      },
      {
        $group: {
          _id: null,
          total: { $sum: "$valor" }
        }
      }
    ]).toArray();

    const receitaPacotes = pacotesPagos.length > 0 ? pacotesPagos[0].total : 0;

    // soma das receitas 
    const receitaTotal = receitaOrcamentos + receitaPacotes;

    // DESPESAS por categoria
    const despesas = await db.collection('despesas').find({
      data: { $gte: inicioMes, $lt: fimMes }
    }).toArray();

    const despesasPorTipo: { [key: string]: number } = {};
    let despesaTotal = 0;

    despesas.forEach((d: any) => {
      if (!despesasPorTipo[d.tipo]) despesasPorTipo[d.tipo] = 0;
      despesasPorTipo[d.tipo] += d.valor;
      despesaTotal += d.valor;
    });

    const saldo = receitaTotal - despesaTotal;
    const margemLucro = receitaTotal > 0 ? ((saldo / receitaTotal) * 100).toFixed(1) : '0';

    // Formatar mensagem
    const mesNome = new Date(inicioMes).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });

    let message = `📊 *RELATÓRIO - ${mesNome.toUpperCase()}*\n\n`;

    message += '💰 *RECEITAS*\n';
    message += `├─ Orçamentos pagos: ${formatCurrency(receitaOrcamentos)}\n`;
    message += `├─ Pacotes pagos: ${formatCurrency(receitaPacotes)}\n`;
    message += `└─ *TOTAL RECEITAS: ${formatCurrency(receitaTotal)}*\n\n`;

    message += '💸 *DESPESAS*\n';
    const tiposLabels: { [key: string]: string } = {
      pro_labore: 'Pró-labore',
      alimentacao: 'Alimentação',
      transporte: 'Transporte',
      materiais: 'Materiais',
      marketing: 'Marketing',
      equipamentos: 'Equipamentos',
      aluguel: 'Aluguel',
      agua_luz: 'Água/Luz',
      telefonia: 'Telefonia',
      impostos: 'Impostos',
      manutencao: 'Manutenção',
      terceirizados: 'Terceirizados',
      outros: 'Outros'
    };

    Object.keys(despesasPorTipo).sort((a, b) => despesasPorTipo[b] - despesasPorTipo[a]).forEach(tipo => {
      message += `├─ ${tiposLabels[tipo]}: ${formatCurrency(despesasPorTipo[tipo])}\n`;
    });
    message += `└─ *TOTAL DESPESAS: ${formatCurrency(despesaTotal)}*\n\n`;

    message += `💵 *SALDO DO MÊS: ${formatCurrency(saldo)}*\n`;

    if (saldo > 0) {
      message += `🟢 Lucro de ${margemLucro}%`;
    } else if (saldo < 0) {
      message += `🔴 Prejuízo de ${margemLucro}%`;
    } else {
      message += `⚪ Empatou no mês`;
    }

    bot.telegram.sendMessage(chatId, message, { parse_mode: 'Markdown' });
  } catch (error) {
    bot.telegram.sendMessage(chatId, '❌ Erro ao gerar relatório mensal.');
    console.error(error);
  }
}

// ==================== CALLBACK HANDLERS ====================
// Agendamento - Tipo
bot.action(/^ag_tipo_(.+)$/, async (ctx) => {
  if (!ctx.chat) return;
  const chatId = ctx.chat.id;
  const tipo = ctx.match[1] as 'evento' | 'festa' | 'pacote' | 'pessoal';
  const state = userStates.get(chatId);
  if (state) {
    state.data.tipo = tipo;

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('🔢 Por Orçamento', 'ag_vinc_orcamento')],
      [Markup.button.callback('👤 Por Responsável', 'ag_vinc_responsavel')],
      [Markup.button.callback('📌 Sem vínculo', 'ag_vinc_nenhum')]
    ]);

    await ctx.editMessageText('Como deseja vincular o agendamento?', keyboard);
  }
  await ctx.answerCbQuery();
});

// Agendamento - Vínculo
bot.action(/^ag_vinc_(.+)$/, async (ctx) => {
  if (!ctx.chat) return;
  const chatId = ctx.chat.id;
  const vinculo = ctx.match[1];
  const state = userStates.get(chatId);
  if (state) {
    state.data.vinculo = vinculo;

    if (vinculo === 'orcamento') {
      state.step = 'orcamento_id';
      ctx.reply('🔢 Digite o ID do orçamento:');
    } else if (vinculo === 'responsavel') {
      state.step = 'responsavel_nome';
      ctx.reply('👤 Digite o nome do responsável:');
    } else {
      state.step = 'data';
      ctx.reply('📅 Digite a data (DD/MM/AAAA):');
    }
  }
  await ctx.answerCbQuery();
});

// Despesa - Tipo
bot.action(/^desp_(?!pag_|data_)(.+)$/, async (ctx) => {
  if (!ctx.chat) return;
  const chatId = ctx.chat.id;
  const tipo = ctx.match[1];
  const state = userStates.get(chatId);
  if (state) {
    state.data.tipo = tipo;
    state.step = 'valor';
    ctx.reply('💰 Digite o valor da despesa (ex: 150.50):');
  }
  await ctx.answerCbQuery();
});

// Callbacks de pagamento
bot.action(/^pag_(.+)$/, async (ctx) => {
  if (!ctx.chat) return;
  const chatId = ctx.chat.id;
  const forma = ctx.match[1];
  const state = userStates.get(chatId);

  if (state && state.data && state.data.pacoteId) {
    try {
      await db.collection('pagamentos').updateOne(
        { _id: state.data.pacoteId },
        {
          $set: {
            isPaid: true,
            forma: forma,
            pagoEm: new Date(),
            updatedAt: new Date()
          }
        }
      );

      ctx.reply(`✅ Pagamento registrado com sucesso!\n💳 Forma: ${forma}`);
      userStates.delete(chatId);
    } catch (error) {
      ctx.reply('❌ Erro ao registrar pagamento.');
      console.error(error);
    }
  }
  await ctx.answerCbQuery();
});

// Callbacks de despesa - data
bot.action('desp_data_hoje', async (ctx) => {
  if (!ctx.chat) return;
  const chatId = ctx.chat.id;
  const state = userStates.get(chatId);
  if (state) {
    state.data.data = new Date();
    state.step = 'descricao';
    ctx.reply('📝 Digite a descrição da despesa:');
  }
  await ctx.answerCbQuery();
});

bot.action('desp_data_outra', async (ctx) => {
  if (!ctx.chat) return;
  const chatId = ctx.chat.id;
  const state = userStates.get(chatId);
  if (state) {
    state.step = 'data_manual';
    ctx.reply('📅 Digite a data (DD/MM/AAAA):');
  }
  await ctx.answerCbQuery();
});

// Callbacks de despesa - forma pagamento
bot.action(/^desp_pag_(.+)$/, async (ctx) => {
  if (!ctx.chat) return;
  const chatId = ctx.chat.id;
  const forma = ctx.match[1];
  const state = userStates.get(chatId);

  if (state && state.data) {
    if (forma !== 'pular') {
      state.data.formaPagamento = forma;
    }

    try {
      const despesa: Despesa = {
        tipo: state.data.tipo,
        valor: state.data.valor,
        data: state.data.data,
        descricao: state.data.descricao,
        formaPagamento: state.data.formaPagamento,
        createdAt: new Date(),
        updatedAt: new Date()
      };

      function escapeMarkdownV2(text: string) {
        return text.replace(/([_*\[\]()~`>#+\-=|{}.!])/g, '\\$1');
      }


      await db.collection('despesas').insertOne(despesa);

      let message = '✅ *Despesa adicionada com sucesso!*\n\n';
      message += `📝 ${escapeMarkdownV2(despesa.descricao)}\n`;
      message += `💰 ${escapeMarkdownV2(formatCurrency(despesa.valor))}\n`;
      message += `📅 ${escapeMarkdownV2(formatDate(despesa.data))}\n`;
      if (despesa.formaPagamento) message += `💳 ${escapeMarkdownV2(despesa.formaPagamento)}\n`;



      ctx.reply(message, { parse_mode: 'Markdown' });
      userStates.delete(chatId);
    } catch (error) {
      ctx.reply('❌ Erro ao adicionar despesa.');
      console.error(error);
    }
  }
  await ctx.answerCbQuery();
});

// Callbacks de orçamento - tipo
bot.action(/^orc_tipo_(.+)$/, async (ctx) => {
  if (!ctx.chat) return;
  const chatId = ctx.chat.id;
  const tipo = ctx.match[1] as 'festa' | 'evento';
  const state = userStates.get(chatId);
  if (state) {
    state.data.tipo = tipo;
    state.step = 'data';
    ctx.reply('📅 Digite a data do evento (DD/MM/AAAA):');
  }
  await ctx.answerCbQuery();
});

// Callbacks de orçamento - recreadores
bot.action(/^orc_rec_(.+)$/, async (ctx) => {
  if (!ctx.chat) return;
  const chatId = ctx.chat.id;
  const rec = ctx.match[1];
  const state = userStates.get(chatId);

  if (state) {
    if (rec === 'outro') {
      state.step = 'recreadores_manual';
      ctx.reply('👥 Digite a quantidade de recreadores:');
    } else {
      state.data.quantidadeRecreadores = parseInt(rec);

      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('Sim', 'orc_fds_sim')],
        [Markup.button.callback('Não', 'orc_fds_nao')]
      ]);

      ctx.reply('É feriado ou fim de semana?', keyboard);
    }
  }
  await ctx.answerCbQuery();
});

// Callbacks de orçamento - feriado/FDS
bot.action(/^orc_fds_(.+)$/, async (ctx) => {
  if (!ctx.chat) return;
  const chatId = ctx.chat.id;
  const data = ctx.match[0];
  const state = userStates.get(chatId);
  if (state) {
    state.data.isFeriadoOuFds = data === 'orc_fds_sim';
    state.step = 'deslocamento';
    ctx.reply('🚗 Custo de deslocamento (ou 0):');
  }
  await ctx.answerCbQuery();
});

// callbacks de orçamento - escolher status
bot.action(/editar_status:(.+)/, async (ctx) => {
  const orcamentoId = ctx.match[1];

  // Botões de status
  const botoesStatus = [
    [{ text: '❌ Cancelado', callback_data: `status:${orcamentoId}:cancelado` }],
    [{ text: '📝 Rascunho', callback_data: `status:${orcamentoId}:rascunho` }],
    [{ text: '📤 Enviado', callback_data: `status:${orcamentoId}:enviado` }],
    [{ text: '✅ Confirmado', callback_data: `status:${orcamentoId}:confirmado` }],
    [{ text: '👍 Aprovado', callback_data: `status:${orcamentoId}:aprovado` }],
    [{ text: '🏁 Concluído', callback_data: `status:${orcamentoId}:concluido` }]
  ];

  await ctx.reply(
    '🔄 Escolha o novo status para este orçamento:',
    {
      reply_markup: {
        inline_keyboard: botoesStatus
      }
    }
  );
});

// callbacks orçamento - atualiza status orçamento
bot.action(/status:(.+):(.+)/, async (ctx) => {
  const orcamentoId = ctx.match[1];
  const novoStatus = ctx.match[2];

  try {
    await db.collection('orcamentos').updateOne(
      { _id: new ObjectId(orcamentoId) },
      { $set: { status: novoStatus } }
    );

    await ctx.reply(`✅ Status do orçamento atualizado para *${novoStatus}*`, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error(error);
    await ctx.reply('❌ Erro ao atualizar status.');
  }
});



// Callbacks de listagem de agendamentos
bot.action(/^list_ag_(.+)$/, async (ctx) => {
  if (!ctx.chat) return;
  const chatId = ctx.chat.id;
  const periodo = ctx.match[1];
  await listarAgendamentos(chatId, periodo);
  await ctx.answerCbQuery();
});

// Callbacks de listagem de despesas
bot.action(/^list_desp_(.+)$/, async (ctx) => {
  if (!ctx.chat) return;
  const chatId = ctx.chat.id;
  const periodo = ctx.match[1];
  await listarDespesas(chatId, periodo);
  await ctx.answerCbQuery();
});

// Callbacks de total de despesas
bot.action(/^total_desp_(.+)$/, async (ctx) => {
  if (!ctx.chat) return;
  const chatId = ctx.chat.id;
  const periodo = ctx.match[1];
  await calcularTotalDespesas(chatId, periodo);
  await ctx.answerCbQuery();
});

// Callbacks de listagem de orçamentos
bot.action(/^list_orc_(.+)$/, async (ctx) => {
  if (!ctx.chat) return;
  const chatId = ctx.chat.id;
  const status = ctx.match[1];
  await listarOrcamentos(chatId, status);
  await ctx.answerCbQuery();
});

// Callbacks de ações rápidas no lembrete
bot.action(/^ag_conf_(.+)$/, async (ctx) => {
  if (!ctx.chat) return;
  const chatId = ctx.chat.id;
  const agId = new ObjectId(ctx.match[1]);
  await db.collection('agendamentos').updateOne(
    { _id: agId },
    { $set: { status: 'confirmado', updatedAt: new Date() } }
  );
  ctx.reply('✅ Agendamento confirmado!');
  await ctx.answerCbQuery();
});

bot.action(/^ag_canc_(.+)$/, async (ctx) => {
  if (!ctx.chat) return;
  const chatId = ctx.chat.id;
  const agId = new ObjectId(ctx.match[1]);
  const ag = await db.collection('agendamentos').findOne({ _id: agId });

  await db.collection('agendamentos').updateOne(
    { _id: agId },
    { $set: { status: 'cancelado', updatedAt: new Date() } }
  );

  if (ag?.googleEventId) {
    await deleteCalendarEvent(ag.googleEventId);
  }

  ctx.reply('❌ Agendamento cancelado!');
  await ctx.answerCbQuery();
});

// callback listagem mudança de status agendamento
bot.action(/status_(.+)/, async (ctx) => {
  if (!ctx.chat) return;
  const novoStatus = ctx.match[1];
  const chatId = ctx.chat.id;
  const state = userStates.get(chatId);

  if (!state || !state.data || !state.data.agendamentoId) {
    return ctx.reply('❌ Nenhum agendamento em andamento.');
  }

  await db.collection('agendamentos').updateOne(
    { _id: state.data.agendamentoId },
    { $set: { status: novoStatus, updatedAt: new Date() } }
  );

  ctx.reply(`✅ Status do agendamento alterado para: *${novoStatus}*`, { parse_mode: 'Markdown' });
  await ctx.answerCbQuery();
  userStates.delete(chatId);
});

// ==================== FUNÇÕES AUXILIARES DE LISTAGEM ====================

async function listarAgendamentos(chatId: number, periodo: string) {
  try {
    let inicio: Date | undefined, fim: Date | undefined;

    if (periodo === 'hoje') {
      inicio = new Date();
      inicio.setHours(0, 0, 0, 0);
      fim = new Date(inicio);
      fim.setDate(fim.getDate() + 1);
    } else if (periodo === 'semana') {
      inicio = new Date();
      inicio.setHours(0, 0, 0, 0);
      fim = new Date(inicio);
      fim.setDate(fim.getDate() + 7);
    } else if (periodo === 'data') {
      userStates.set(chatId, { command: 'listar_agendamentos', step: 'data_especifica' });
      bot.telegram.sendMessage(chatId, '📅 Digite a data (DD/MM/AAAA):');
      return;
    }

    if (!inicio || !fim) {
      bot.telegram.sendMessage(chatId, '❌ Período inválido.');
      return;
    }

    const agendamentos = await db.collection('agendamentos').find({
      data: { $gte: inicio, $lt: fim },
      status: { $ne: 'cancelado' }
    }).sort({ data: 1, horario: 1 }).toArray();

    if (agendamentos.length === 0) {
      bot.telegram.sendMessage(chatId, '📭 Não há agendamentos para este período.');
      return;
    }

    let message = `📅 *AGENDAMENTOS - ${periodo.toUpperCase()}*\n\n`;

    const tipoEmoji: { [key: string]: string } = { evento: '🎉', festa: '🎈', pacote: '📦', pessoal: '👤' };
    const statusEmojiMap: { [key: string]: string } = { pendente: '⏳', confirmado: '✅', concluido: '🎉', cancelado: '❌' };

    for (const ag of agendamentos) {
      const emoji = tipoEmoji[ag.tipo] || '📅';
      const statusEmoji = statusEmojiMap[ag.status] || '❓';

      message += `${emoji} ${ag.tipo.toUpperCase()} - ${formatDate(ag.data)} às ${ag.horario}\n`;
      message += `📝 ${ag.descricao}\n`;
      message += `📍 ${ag.local}\n`;
      message += `⏱️ ${ag.duracao}h\n`;
      message += `${statusEmoji} ${ag.status.toUpperCase()}\n`;
      message += '---\n';
    }

    bot.telegram.sendMessage(chatId, message, { parse_mode: 'Markdown' });
  } catch (error) {
    bot.telegram.sendMessage(chatId, '❌ Erro ao listar agendamentos.');
    console.error(error);
  }
}

async function listarDespesas(chatId: number, periodo: string) {
  try {
    let inicio: Date | undefined, fim: Date | undefined;

    if (periodo === 'hoje') {
      inicio = new Date();
      inicio.setHours(0, 0, 0, 0);
      fim = new Date(inicio);
      fim.setDate(fim.getDate() + 1);
    } else if (periodo === 'semana') {
      inicio = new Date();
      inicio.setHours(0, 0, 0, 0);
      fim = new Date(inicio);
      fim.setDate(fim.getDate() + 7);
    } else if (periodo === 'mes') {
      inicio = new Date();
      inicio.setDate(1);
      inicio.setHours(0, 0, 0, 0);
      fim = new Date(inicio);
      fim.setMonth(fim.getMonth() + 1);
    } else if (periodo === 'periodo') {
      userStates.set(chatId, { command: 'listar_despesas', step: 'inicio' });
      bot.telegram.sendMessage(chatId, '📅 Digite a data inicial (DD/MM/AAAA):');
      return;
    }

    if (!inicio || !fim) {
      bot.telegram.sendMessage(chatId, '❌ Período inválido.');
      return;
    }

    const despesas = await db.collection('despesas').find({
      data: { $gte: inicio, $lt: fim }
    }).sort({ data: -1 }).toArray();

    if (despesas.length === 0) {
      bot.telegram.sendMessage(chatId, '📭 Não há despesas para este período.');
      return;
    }

    let message = `💸 *DESPESAS \\- ${escapeMarkdownV2(periodo.toUpperCase())}*\n\n`;
    let total = 0;

    const tiposLabels: { [key: string]: string } = {
      pro_labore: '💼', alimentacao: '🍔', transporte: '🚗',
      materiais: '📦', marketing: '📢', equipamentos: '🔧',
      aluguel: '🏢', agua_luz: '💡', telefonia: '📱',
      impostos: '📋', manutencao: '🛠️', terceirizados: '👥', outros: '📌'
    };

    for (const desp of despesas) {
      message += `${tiposLabels[desp.tipo]} ${escapeMarkdownV2(desp.descricao)}\n`;
      message += `💰 ${escapeMarkdownV2(formatCurrency(desp.valor))} \\- ${escapeMarkdownV2(formatDate(desp.data))}\n`;
      if (desp.formaPagamento) message += `💳 ${escapeMarkdownV2(desp.formaPagamento)}\n`;
      message += escapeMarkdownV2('---\n');
      total += desp.valor;
    }

    message += `\n💵 *TOTAL: ${escapeMarkdownV2(formatCurrency(total))}*`;

    bot.telegram.sendMessage(chatId, message, { parse_mode: 'MarkdownV2' });
  } catch (error) {
    bot.telegram.sendMessage(chatId, '❌ Erro ao listar despesas.');
    console.error(error);
  }
}

async function calcularTotalDespesas(chatId: number, periodo: string) {
  try {
    let inicio: Date | undefined, fim: Date | undefined;

    if (periodo === 'hoje') {
      inicio = new Date();
      inicio.setHours(0, 0, 0, 0);
      fim = new Date(inicio);
      fim.setDate(fim.getDate() + 1);
    } else if (periodo === 'semana') {
      inicio = new Date();
      inicio.setHours(0, 0, 0, 0);
      fim = new Date(inicio);
      fim.setDate(fim.getDate() + 7);
    } else if (periodo === 'mes') {
      inicio = new Date();
      inicio.setDate(1);
      inicio.setHours(0, 0, 0, 0);
      fim = new Date(inicio);
      fim.setMonth(fim.getMonth() + 1);
    }

    if (!inicio || !fim) {
      bot.telegram.sendMessage(chatId, '❌ Período inválido.');
      return;
    }

    const despesas = await db.collection('despesas').find({
      data: { $gte: inicio, $lt: fim }
    }).toArray();

    const despesasPorTipo: { [key: string]: number } = {};
    let total = 0;

    despesas.forEach((d: any) => {
      if (!despesasPorTipo[d.tipo]) despesasPorTipo[d.tipo] = 0;
      despesasPorTipo[d.tipo] += d.valor;
      total += d.valor;
    });

    let message = `💸 *TOTAL DESPESAS - ${periodo.toUpperCase()}*\n\n`;

    const tiposLabels: { [key: string]: string } = {
      pro_labore: 'Pró-labore',
      alimentacao: 'Alimentação',
      transporte: 'Transporte',
      materiais: 'Materiais',
      marketing: 'Marketing',
      equipamentos: 'Equipamentos',
      aluguel: 'Aluguel',
      agua_luz: 'Água/Luz',
      telefonia: 'Telefonia',
      impostos: 'Impostos',
      manutencao: 'Manutenção',
      terceirizados: 'Terceirizados',
      outros: 'Outros'
    };

    Object.keys(despesasPorTipo).sort((a, b) => despesasPorTipo[b] - despesasPorTipo[a]).forEach(tipo => {
      message += `${tiposLabels[tipo]}: ${formatCurrency(despesasPorTipo[tipo])}\n`;
    });

    message += `\n💵 *TOTAL GERAL: ${formatCurrency(total)}*`;

    bot.telegram.sendMessage(chatId, message, { parse_mode: 'Markdown' });
  } catch (error) {
    bot.telegram.sendMessage(chatId, '❌ Erro ao calcular total.');
    console.error(error);
  }
}

async function listarOrcamentos(chatId: number, status: string) {
  try {
    const query = status === 'todos' ? {} : { status };
    const orcamentos = await db.collection('orcamentos').find(query).sort({ createdAt: -1 }).toArray();

    if (orcamentos.length === 0) {
      bot.telegram.sendMessage(chatId, '📭 Não há orçamentos nesta categoria.');
      return;
    }

    let message = `📊 *ORÇAMENTOS \\- ${escapeMarkdownV2(status.toUpperCase())}*\n\n`;

    const statusEmoji: { [key: string]: string } = {
      rascunho: '📝',
      enviado: '📤',
      aprovado: '✅',
      concluido: '🎉',
      cancelado: '❌'
    };

    for (const orc of orcamentos) {
      message += `${statusEmoji[orc.status]} ${escapeMarkdownV2(orc.cliente)}\n`;
      message += `${orc.tipo === 'festa' ? '🎈' : '📅'} ${escapeMarkdownV2(orc.tipo.toUpperCase())}\n`;
      message += `📅 ${escapeMarkdownV2(formatDate(orc.dataEvento))} às ${escapeMarkdownV2(orc.horario)}\n`;
      message += `💰 ${escapeMarkdownV2(formatCurrency(orc.valorFinal))}\n`;
      message += `📍 ${escapeMarkdownV2(orc.endereco)}\n`;
      message += `🆔 ${escapeMarkdownV2(String(orc._id))}\n`;
      message += `\\-\\-\\-\n`; // separador seguro
    }

    bot.telegram.sendMessage(chatId, message, { parse_mode: 'MarkdownV2' });
  } catch (error) {
    bot.telegram.sendMessage(chatId, '❌ Erro ao listar orçamentos.');
    console.error(error);
  }
}

// ==================== INICIALIZAÇÃO DO BOT ====================
async function start() {
  try {
    await connectDB();
    console.log('🤖 Bot Telegram iniciado!');

    // Inicia o bot com polling
    await bot.launch();
    console.log('✅ Bot iniciado e escutando mensagens...');

    // Aguarda um pouco antes de enviar mensagem para garantir que o bot está pronto
    setTimeout(async () => {
      try {
        await bot.telegram.sendMessage(ADMIN_CHAT_ID, '🤖 Bot Recrear no Lar iniciado com sucesso!');
      } catch (error) {
        console.error('Erro ao enviar mensagem de inicialização:', error);
      }
    }, 2000);

    // Graceful stop
    process.once('SIGINT', () => bot.stop('SIGINT'));
    process.once('SIGTERM', () => bot.stop('SIGTERM'));
  } catch (error) {
    console.error('❌ Erro ao iniciar o bot:', error);
    process.exit(1);
  }
}

// Tratamento de erros não capturados
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  process.exit(1);
});

start().catch((error) => {
  console.error('Erro fatal ao iniciar:', error);
  process.exit(1);
});