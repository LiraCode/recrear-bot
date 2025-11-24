import TelegramBot from 'node-telegram-bot-api';
import { MongoClient, ObjectId } from 'mongodb';
import { google } from 'googleapis';
import cron from 'node-cron';

// ==================== CONFIGURAÇÕES ====================
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const MONGODB_URI = process.env.MONGODB_URI!;
const GOOGLE_CREDENTIALS = JSON.parse(process.env.GOOGLE_CREDENTIALS!);
const BACKOFFICE_URL = 'https://backoffice.recrearnolar.com.br';
const ADMIN_CHAT_ID = parseInt(process.env.ADMIN_CHAT_ID!);

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
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
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
  db = mongoClient.db('recrearnolar');
  console.log('✅ Conectado ao MongoDB');
}

// ==================== HELPERS ====================
const userStates = new Map<number, any>();

function formatCurrency(value: number): string {
  return `R$ ${value.toFixed(2).replace('.', ',')}`;
}

function formatDate(date: Date): string {
  return date.toLocaleDateString('pt-BR');
}

function parseDate(dateStr: string): Date {
  const [day, month, year] = dateStr.split('/');
  return new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
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

// ==================== COMANDOS - MENU PRINCIPAL ====================
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, 
    '🎉 *Bem-vindo ao Bot Recrear no Lar!*\n\n' +
    'Use /ajuda para ver todos os comandos disponíveis.',
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/ajuda/, (msg) => {
  const chatId = msg.chat.id;
  const helpText = `
📋 *COMANDOS DISPONÍVEIS*

💰 *PAGAMENTOS*
/buscar_pagamento - Consultar pagamento
/registrar_pagamento - Registrar pagamento de pacote
/pagamentos_pendentes - Listar pacotes não pagos

📅 *AGENDAMENTOS*
/criar_agendamento - Criar novo agendamento
/listar_agendamentos - Ver agendamentos
/editar_agendamento - Editar agendamento
/cancelar_agendamento - Cancelar agendamento
/mudar_status - Alterar status

💸 *DESPESAS*
/adicionar_despesa - Registrar despesa
/listar_despesas - Ver despesas
/editar_despesa - Editar despesa
/excluir_despesa - Remover despesa
/total_despesas - Total por período

📊 *ORÇAMENTOS*
/criar_orcamento - Criar orçamento
/listar_orcamentos - Ver orçamentos
/editar_orcamento - Editar orçamento
/mudar_status_orcamento - Alterar status
/enviar_orcamento - Enviar link do orçamento

📈 *RELATÓRIOS*
/relatorio_mensal - Relatório de receitas/despesas

🔧 *UTILITÁRIOS*
/status - Status do sistema
/ajuda - Esta mensagem
  `;
  
  bot.sendMessage(chatId, helpText, { parse_mode: 'Markdown' });
});

// ==================== PAGAMENTOS ====================
bot.onText(/\/buscar_pagamento/, async (msg) => {
  const chatId = msg.chat.id;
  userStates.set(chatId, { command: 'buscar_pagamento', step: 'vencimento' });
  bot.sendMessage(chatId, '📅 Digite a data de vencimento (formato: DD/MM/AAAA):');
});

bot.onText(/\/registrar_pagamento/, async (msg) => {
  const chatId = msg.chat.id;
  userStates.set(chatId, { command: 'registrar_pagamento', step: 'vencimento' });
  bot.sendMessage(chatId, '📅 Digite a data de vencimento (formato: DD/MM/AAAA):');
});

bot.onText(/\/pagamentos_pendentes/, async (msg) => {
  const chatId = msg.chat.id;
  
  try {
    const pacotes = await db.collection('pacotes').find({ isPaid: false }).toArray();
    
    if (pacotes.length === 0) {
      bot.sendMessage(chatId, '✅ Não há pagamentos pendentes!');
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
    
    bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
  } catch (error) {
    bot.sendMessage(chatId, '❌ Erro ao buscar pagamentos pendentes.');
    console.error(error);
  }
});

// ==================== AGENDAMENTOS ====================
bot.onText(/\/criar_agendamento/, (msg) => {
  const chatId = msg.chat.id;
  
  const keyboard = {
    inline_keyboard: [
      [{ text: '🎉 Evento', callback_data: 'ag_tipo_evento' }],
      [{ text: '🎈 Festa', callback_data: 'ag_tipo_festa' }],
      [{ text: '📦 Pacote', callback_data: 'ag_tipo_pacote' }],
      [{ text: '👤 Pessoal', callback_data: 'ag_tipo_pessoal' }]
    ]
  };
  
  userStates.set(chatId, { command: 'criar_agendamento', data: {} });
  bot.sendMessage(chatId, 'Selecione o tipo de agendamento:', { reply_markup: keyboard });
});

bot.onText(/\/listar_agendamentos/, (msg) => {
  const chatId = msg.chat.id;
  
  const keyboard = {
    inline_keyboard: [
      [{ text: '📅 Hoje', callback_data: 'list_ag_hoje' }],
      [{ text: '📆 Esta semana', callback_data: 'list_ag_semana' }],
      [{ text: '🗓️ Data específica', callback_data: 'list_ag_data' }]
    ]
  };
  
  bot.sendMessage(chatId, 'Selecione o período:', { reply_markup: keyboard });
});

bot.onText(/\/cancelar_agendamento/, (msg) => {
  const chatId = msg.chat.id;
  userStates.set(chatId, { command: 'cancelar_agendamento', step: 'data' });
  bot.sendMessage(chatId, '📅 Digite a data do agendamento (DD/MM/AAAA):');
});

// ==================== DESPESAS ====================
bot.onText(/\/adicionar_despesa/, (msg) => {
  const chatId = msg.chat.id;
  
  const keyboard = {
    inline_keyboard: [
      [{ text: '💼 Pró-labore', callback_data: 'desp_pro_labore' }],
      [{ text: '🍔 Alimentação', callback_data: 'desp_alimentacao' }],
      [{ text: '🚗 Transporte', callback_data: 'desp_transporte' }],
      [{ text: '📦 Materiais', callback_data: 'desp_materiais' }],
      [{ text: '📢 Marketing', callback_data: 'desp_marketing' }],
      [{ text: '🔧 Equipamentos', callback_data: 'desp_equipamentos' }],
      [{ text: '🏢 Aluguel', callback_data: 'desp_aluguel' }],
      [{ text: '💡 Água/Luz', callback_data: 'desp_agua_luz' }],
      [{ text: '📱 Telefonia', callback_data: 'desp_telefonia' }],
      [{ text: '📋 Impostos', callback_data: 'desp_impostos' }],
      [{ text: '🛠️ Manutenção', callback_data: 'desp_manutencao' }],
      [{ text: '👥 Terceirizados', callback_data: 'desp_terceirizados' }],
      [{ text: '📌 Outros', callback_data: 'desp_outros' }]
    ]
  };
  
  userStates.set(chatId, { command: 'adicionar_despesa', data: {} });
  bot.sendMessage(chatId, 'Selecione o tipo de despesa:', { reply_markup: keyboard });
});

bot.onText(/\/listar_despesas/, (msg) => {
  const chatId = msg.chat.id;
  
  const keyboard = {
    inline_keyboard: [
      [{ text: '📅 Hoje', callback_data: 'list_desp_hoje' }],
      [{ text: '📆 Esta semana', callback_data: 'list_desp_semana' }],
      [{ text: '🗓️ Este mês', callback_data: 'list_desp_mes' }],
      [{ text: '📊 Período personalizado', callback_data: 'list_desp_periodo' }]
    ]
  };
  
  bot.sendMessage(chatId, 'Selecione o período:', { reply_markup: keyboard });
});

bot.onText(/\/total_despesas/, async (msg) => {
  const chatId = msg.chat.id;
  
  const keyboard = {
    inline_keyboard: [
      [{ text: '📅 Hoje', callback_data: 'total_desp_hoje' }],
      [{ text: '📆 Esta semana', callback_data: 'total_desp_semana' }],
      [{ text: '🗓️ Este mês', callback_data: 'total_desp_mes' }]
    ]
  };
  
  bot.sendMessage(chatId, 'Selecione o período:', { reply_markup: keyboard });
});

// ==================== ORÇAMENTOS ====================
bot.onText(/\/criar_orcamento/, (msg) => {
  const chatId = msg.chat.id;
  userStates.set(chatId, { command: 'criar_orcamento', step: 'cliente', data: {} });
  bot.sendMessage(chatId, '👤 Digite o nome do cliente:');
});

bot.onText(/\/listar_orcamentos/, (msg) => {
  const chatId = msg.chat.id;
  
  const keyboard = {
    inline_keyboard: [
      [{ text: '📝 Rascunhos', callback_data: 'list_orc_rascunho' }],
      [{ text: '📤 Enviados', callback_data: 'list_orc_enviado' }],
      [{ text: '✅ Aprovados', callback_data: 'list_orc_aprovado' }],
      [{ text: '🎉 Concluídos', callback_data: 'list_orc_concluido' }],
      [{ text: '📋 Todos', callback_data: 'list_orc_todos' }]
    ]
  };
  
  bot.sendMessage(chatId, 'Filtrar por status:', { reply_markup: keyboard });
});

bot.onText(/\/enviar_orcamento/, (msg) => {
  const chatId = msg.chat.id;
  userStates.set(chatId, { command: 'enviar_orcamento', step: 'buscar' });
  bot.sendMessage(chatId, '🔍 Digite o nome do cliente para buscar o orçamento:');
});

bot.onText(/\/relatorio_mensal/, (msg) => {
  const chatId = msg.chat.id;
  userStates.set(chatId, { command: 'relatorio_mensal', step: 'mes' });
  bot.sendMessage(chatId, '📅 Digite o mês/ano (formato: MM/AAAA):');
});

// ==================== CALLBACK HANDLERS ====================

// ==================== MESSAGE HANDLER ====================
bot.on('message', async (msg) => {
  if (msg.text?.startsWith('/')) return; // Ignora comandos
  
  const chatId = msg.chat.id;
  const state = userStates.get(chatId);
  
  if (!state) return;
  
  const text = msg.text || '';
  
  // ========== BUSCAR/REGISTRAR PAGAMENTO ==========
  if (state.command === 'buscar_pagamento' || state.command === 'registrar_pagamento') {
    if (state.step === 'vencimento') {
      try {
        const vencimento = parseDate(text);
        state.data = { vencimento };
        state.step = 'responsavel';
        bot.sendMessage(chatId, '👤 Digite o nome do responsável:');
      } catch (error) {
        bot.sendMessage(chatId, '❌ Data inválida. Use o formato DD/MM/AAAA');
      }
    } else if (state.step === 'responsavel') {
      try {
        const responsavel = await db.collection('responsaveis').findOne({ 
          nome: { $regex: text, $options: 'i' } 
        });
        
        if (!responsavel) {
          bot.sendMessage(chatId, '❌ Responsável não encontrado.');
          userStates.delete(chatId);
          return;
        }
        
        const pacote = await db.collection('pacotes').findOne({
          responsavelId: responsavel._id,
          vencimento: state.data.vencimento
        });
        
        if (!pacote) {
          bot.sendMessage(chatId, '❌ Pacote não encontrado para esta data e responsável.');
          userStates.delete(chatId);
          return;
        }
        
        let message = `📦 *PACOTE ENCONTRADO*\n\n`;
        message += `👤 Responsável: ${responsavel.nome}\n`;
        message += `📆 Mês: ${pacote.mesReferencia}\n`;
        message += `💰 Valor: ${formatCurrency(pacote.valor)}\n`;
        message += `📅 Vencimento: ${formatDate(new Date(pacote.vencimento))}\n`;
        message += `✅ Pago: ${pacote.isPaid ? 'Sim' : 'Não'}\n`;
        
        if (pacote.isPaid) {
          message += `💳 Forma: ${pacote.forma}\n`;
          message += `📅 Pago em: ${formatDate(new Date(pacote.pagoEm))}\n`;
        }
        
        if (state.command === 'registrar_pagamento' && !pacote.isPaid) {
          state.data.pacoteId = pacote._id;
          state.step = 'forma';
          
          const keyboard = {
            inline_keyboard: [
              [{ text: '💳 PIX', callback_data: 'pag_pix' }],
              [{ text: '💵 Dinheiro', callback_data: 'pag_dinheiro' }],
              [{ text: '💳 Cartão', callback_data: 'pag_cartao' }],
              [{ text: '🏦 Transferência', callback_data: 'pag_transferencia' }]
            ]
          };
          
          bot.sendMessage(chatId, message + '\n💳 Selecione a forma de pagamento:', { 
            parse_mode: 'Markdown',
            reply_markup: keyboard 
          });
        } else {
          bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
          userStates.delete(chatId);
        }
      } catch (error) {
        bot.sendMessage(chatId, '❌ Erro ao buscar pacote.');
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
      
      const keyboard = {
        inline_keyboard: [
          [{ text: '📅 Hoje', callback_data: 'desp_data_hoje' }],
          [{ text: '🗓️ Outra data', callback_data: 'desp_data_outra' }]
        ]
      };
      
      bot.sendMessage(chatId, 'Quando foi a despesa?', { reply_markup: keyboard });
    } else if (state.step === 'data_manual') {
      try {
        state.data.data = parseDate(text);
        state.step = 'descricao';
        bot.sendMessage(chatId, '📝 Digite a descrição da despesa:');
      } catch (error) {
        bot.sendMessage(chatId, '❌ Data inválida. Use DD/MM/AAAA');
      }
    } else if (state.step === 'descricao') {
      state.data.descricao = text;
      
      const keyboard = {
        inline_keyboard: [
          [{ text: '💳 PIX', callback_data: 'desp_pag_pix' }],
          [{ text: '💵 Dinheiro', callback_data: 'desp_pag_dinheiro' }],
          [{ text: '💳 Cartão Crédito', callback_data: 'desp_pag_cartao_credito' }],
          [{ text: '💳 Cartão Débito', callback_data: 'desp_pag_cartao_debito' }],
          [{ text: '🏦 Transferência', callback_data: 'desp_pag_transferencia' }],
          [{ text: '⏭️ Pular', callback_data: 'desp_pag_pular' }]
        ]
      };
      
      bot.sendMessage(chatId, 'Forma de pagamento (opcional):', { reply_markup: keyboard });
    }
  }
  
  // ========== CRIAR ORÇAMENTO ==========
  if (state.command === 'criar_orcamento') {
    if (state.step === 'cliente') {
      state.data.cliente = text;
      state.step = 'tipo';
      
      const keyboard = {
        inline_keyboard: [
          [{ text: '🎉 Festa', callback_data: 'orc_tipo_festa' }],
          [{ text: '📅 Evento', callback_data: 'orc_tipo_evento' }]
        ]
      };
      
      bot.sendMessage(chatId, 'Tipo de serviço:', { reply_markup: keyboard });
    } else if (state.step === 'data') {
      try {
        state.data.dataEvento = parseDate(text);
        state.step = 'horario';
        bot.sendMessage(chatId, '⏰ Digite o horário (HH:MM):');
      } catch (error) {
        bot.sendMessage(chatId, '❌ Data inválida. Use DD/MM/AAAA');
      }
    } else if (state.step === 'horario') {
      state.data.horario = text;
      state.step = 'criancas';
      bot.sendMessage(chatId, '👶 Quantidade de crianças:');
    } else if (state.step === 'criancas') {
      state.data.quantidadeCriancas = parseInt(text);
      state.step = 'duracao';
      bot.sendMessage(chatId, '⏱️ Duração em horas (ex: 2 ou 1.5):');
    } else if (state.step === 'duracao') {
      state.data.duracao = parseFloat(text.replace(',', '.'));
      
      const keyboard = {
        inline_keyboard: [
          [{ text: '1 recreador', callback_data: 'orc_rec_1' }],
          [{ text: '2 recreadores', callback_data: 'orc_rec_2' }],
          [{ text: '3 recreadores', callback_data: 'orc_rec_3' }],
          [{ text: 'Outro', callback_data: 'orc_rec_outro' }]
        ]
      };
      
      bot.sendMessage(chatId, 'Quantidade de recreadores:', { reply_markup: keyboard });
    } else if (state.step === 'recreadores_manual') {
      state.data.quantidadeRecreadores = parseInt(text);
      
      const keyboard = {
        inline_keyboard: [
          [{ text: 'Sim', callback_data: 'orc_fds_sim' }],
          [{ text: 'Não', callback_data: 'orc_fds_nao' }]
        ]
      };
      
      bot.sendMessage(chatId, 'É feriado ou fim de semana?', { reply_markup: keyboard });
    } else if (state.step === 'deslocamento') {
      state.data.custoDeslocamento = parseFloat(text.replace(',', '.')) || 0;
      state.step = 'desconto';
      bot.sendMessage(chatId, '💰 Desconto (ou 0):');
    } else if (state.step === 'desconto') {
      state.data.desconto = parseFloat(text.replace(',', '.')) || 0;
      state.step = 'endereco';
      bot.sendMessage(chatId, '📍 Digite o endereço:');
    } else if (state.step === 'endereco') {
      state.data.endereco = text;
      state.step = 'complemento';
      bot.sendMessage(chatId, '📍 Complemento (ou "pular"):');
    } else if (state.step === 'complemento') {
      if (text.toLowerCase() !== 'pular') {
        state.data.complemento = text;
      }
      state.step = 'bairro';
      bot.sendMessage(chatId, '🏘️ Bairro:');
    } else if (state.step === 'bairro') {
      state.data.bairro = text;
      state.step = 'cidade';
      bot.sendMessage(chatId, '🏙️ Cidade:');
    } else if (state.step === 'cidade') {
      state.data.cidade = text;
      state.step = 'telefone';
      bot.sendMessage(chatId, '📱 Telefone (opcional, ou "pular"):');
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
        message += `🔗 Link: ${BACKOFFICE_URL}/orcamento/${orcamentoId}`;
        
        bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
        userStates.delete(chatId);
      } catch (error) {
        bot.sendMessage(chatId, '❌ Erro ao criar orçamento.');
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
      bot.sendMessage(chatId, '📅 Digite a data (DD/MM/AAAA):');
    } else if (state.step === 'responsavel_nome') {
      try {
        const responsavel = await db.collection('responsaveis').findOne({ 
          nome: { $regex: text, $options: 'i' } 
        });
        
        if (!responsavel) {
          bot.sendMessage(chatId, '❌ Responsável não encontrado.');
          userStates.delete(chatId);
          return;
        }
        
        state.data.responsavelId = responsavel._id;
        state.step = 'data';
        bot.sendMessage(chatId, '📅 Digite a data (DD/MM/AAAA):');
      } catch (error) {
        bot.sendMessage(chatId, '❌ Erro ao buscar responsável.');
        console.error(error);
        userStates.delete(chatId);
      }
    } else if (state.step === 'data') {
      try {
        state.data.data = parseDate(text);
        state.step = 'horario';
        bot.sendMessage(chatId, '⏰ Digite o horário (HH:MM):');
      } catch (error) {
        bot.sendMessage(chatId, '❌ Data inválida. Use DD/MM/AAAA');
      }
    } else if (state.step === 'horario') {
      state.data.horario = text;
      state.step = 'duracao';
      bot.sendMessage(chatId, '⏱️ Duração em horas:');
    } else if (state.step === 'duracao') {
      state.data.duracao = parseFloat(text.replace(',', '.'));
      state.step = 'local';
      bot.sendMessage(chatId, '📍 Digite o local:');
    } else if (state.step === 'local') {
      state.data.local = text;
      state.step = 'descricao';
      bot.sendMessage(chatId, '📝 Digite a descrição:');
    } else if (state.step === 'descricao') {
      state.data.descricao = text;
      state.step = 'observacoes';
      bot.sendMessage(chatId, '💬 Observações (ou "pular"):');
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
        
        bot.sendMessage(chatId, '✅ Agendamento criado com sucesso!');
        userStates.delete(chatId);
      } catch (error) {
        bot.sendMessage(chatId, '❌ Erro ao criar agendamento.');
        console.error(error);
        userStates.delete(chatId);
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
        bot.sendMessage(chatId, '❌ Formato inválido. Use MM/AAAA');
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
          bot.sendMessage(chatId, '❌ Nenhum orçamento encontrado.');
          userStates.delete(chatId);
          return;
        }
        
        if (orcamentos.length === 1) {
          const orc = orcamentos[0];
          const link = `${BACKOFFICE_URL}/orcamento/${orc._id}`;
          bot.sendMessage(chatId, `🔗 Link do orçamento:\n${link}`);
          userStates.delete(chatId);
        } else {
          // Múltiplos orçamentos - mostra lista
          let message = '📋 *Orçamentos encontrados:*\n\n';
          for (const orc of orcamentos) {
            message += `👤 ${orc.cliente}\n`;
            message += `📅 ${formatDate(orc.dataEvento)}\n`;
            message += `💰 ${formatCurrency(orc.valorFinal)}\n`;
            message += `🔗 ${BACKOFFICE_URL}/orcamento/${orc._id}\n\n`;
          }
          bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
          userStates.delete(chatId);
        }
      } catch (error) {
        bot.sendMessage(chatId, '❌ Erro ao buscar orçamento.');
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
          bot.sendMessage(chatId, '📭 Não há agendamentos para esta data.');
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
          
          bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
        }
        
        userStates.delete(chatId);
      } catch (error) {
        bot.sendMessage(chatId, '❌ Data inválida. Use DD/MM/AAAA');
      }
    }
  }
  
  // ========== LISTAR DESPESAS - PERÍODO PERSONALIZADO ==========
  if (state.command === 'listar_despesas') {
    if (state.step === 'inicio') {
      try {
        state.data.inicio = parseDate(text);
        state.step = 'fim';
        bot.sendMessage(chatId, '📅 Digite a data final (DD/MM/AAAA):');
      } catch (error) {
        bot.sendMessage(chatId, '❌ Data inválida. Use DD/MM/AAAA');
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
          bot.sendMessage(chatId, '📭 Não há despesas para este período.');
          userStates.delete(chatId);
          return;
        }
        
        let message = `💸 *DESPESAS - ${formatDate(inicio)} a ${formatDate(fim)}*\n\n`;
        let total = 0;
        
        const tiposLabels: { [key: string]: string } = {
          pro_labore: '💼', alimentacao: '🍔', transporte: '🚗',
          materiais: '📦', marketing: '📢', equipamentos: '🔧',
          aluguel: '🏢', agua_luz: '💡', telefonia: '📱',
          impostos: '📋', manutencao: '🛠️', terceirizados: '👥', outros: '📌'
        };
        
        for (const desp of despesas) {
          message += `${tiposLabels[desp.tipo] || '📌'} ${desp.descricao}\n`;
          message += `💰 ${formatCurrency(desp.valor)} - ${formatDate(desp.data)}\n`;
          if (desp.formaPagamento) message += `💳 ${desp.formaPagamento}\n`;
          message += '---\n';
          total += desp.valor;
        }
        
        message += `\n💵 *TOTAL: ${formatCurrency(total)}*`;
        
        bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
        userStates.delete(chatId);
      } catch (error) {
        bot.sendMessage(chatId, '❌ Data inválida. Use DD/MM/AAAA');
      }
    }
  }
});

// ==================== LEMBRETES E CRON JOBS ====================

// Lembrete diário às 7h
cron.schedule('0 7 * * *', async () => {
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
      bot.sendMessage(ADMIN_CHAT_ID, '☀️ Bom dia! Não há agendamentos para hoje.');
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
    
    bot.sendMessage(ADMIN_CHAT_ID, message, { parse_mode: 'Markdown' });
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
        
        const keyboard = {
          inline_keyboard: [
            [{ text: '✅ Confirmar', callback_data: `ag_conf_${ag._id}` }],
            [{ text: '📅 Reagendar', callback_data: `ag_reag_${ag._id}` }],
            [{ text: '❌ Cancelar', callback_data: `ag_canc_${ag._id}` }]
          ]
        };
        
        await bot.sendMessage(ADMIN_CHAT_ID, message, { 
          parse_mode: 'Markdown',
          reply_markup: keyboard 
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

// Relatório mensal automático - dia 1º às 9h
cron.schedule('0 9 1 * *', async () => {
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
    
    // RECEITAS - Orçamentos pagos
    const orcamentosPagos = await db.collection('orcamentos').find({
      status: 'concluido',
      updatedAt: { $gte: inicioMes, $lt: fimMes }
    }).toArray();
    
    const receitaOrcamentos = orcamentosPagos.reduce((sum: number, o: any) => sum + o.valorFinal, 0);
    
    // RECEITAS - Pacotes pagos
    const pacotesPagos = await db.collection('pacotes').find({
      isPaid: true,
      pagoEm: { $gte: inicioMes, $lt: fimMes }
    }).toArray();
    
    const receitaPacotes = pacotesPagos.reduce((sum: number, p: any) => sum + p.valor, 0);
    
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
    
    bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
  } catch (error) {
    bot.sendMessage(chatId, '❌ Erro ao gerar relatório mensal.');
    console.error(error);
  }
}

// ==================== CALLBACK HANDLERS ====================
bot.on('callback_query', async (query) => {
  const chatId = query.message!.chat.id;
  const data = query.data!;
  const state = userStates.get(chatId);
  
  // Agendamento - Tipo
  if (data.startsWith('ag_tipo_')) {
    const tipo = data.replace('ag_tipo_', '') as 'evento' | 'festa' | 'pacote' | 'pessoal';
    const state = userStates.get(chatId);
    if (state) {
      state.data.tipo = tipo;
      
      const keyboard = {
        inline_keyboard: [
          [{ text: '🔢 Por Orçamento', callback_data: 'ag_vinc_orcamento' }],
          [{ text: '👤 Por Responsável', callback_data: 'ag_vinc_responsavel' }],
          [{ text: '📌 Sem vínculo', callback_data: 'ag_vinc_nenhum' }]
        ]
      };
      
      bot.editMessageText('Como deseja vincular o agendamento?', {
        chat_id: chatId,
        message_id: query.message!.message_id,
        reply_markup: keyboard
      });
    }
  }
  
  // Agendamento - Vínculo
  if (data.startsWith('ag_vinc_')) {
    const vinculo = data.replace('ag_vinc_', '');
    const state = userStates.get(chatId);
    if (state) {
      state.data.vinculo = vinculo;
      
      if (vinculo === 'orcamento') {
        state.step = 'orcamento_id';
        bot.sendMessage(chatId, '🔢 Digite o ID do orçamento:');
      } else if (vinculo === 'responsavel') {
        state.step = 'responsavel_nome';
        bot.sendMessage(chatId, '👤 Digite o nome do responsável:');
      } else {
        state.step = 'data';
        bot.sendMessage(chatId, '📅 Digite a data (DD/MM/AAAA):');
      }
    }
  }
  
  // Despesa - Tipo
  if (data.startsWith('desp_') && !data.startsWith('desp_pag_') && !data.startsWith('desp_data_')) {
    const tipo = data.replace('desp_', '');
    const state = userStates.get(chatId);
    if (state) {
      state.data.tipo = tipo;
      state.step = 'valor';
      bot.sendMessage(chatId, '💰 Digite o valor da despesa (ex: 150.50):');
    }
  }
  
  // Callbacks de pagamento
  if (data.startsWith('pag_')) {
    const forma = data.replace('pag_', '');
    
    if (state && state.data && state.data.pacoteId) {
      try {
        await db.collection('pacotes').updateOne(
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
        
        bot.sendMessage(chatId, `✅ Pagamento registrado com sucesso!\n💳 Forma: ${forma}`);
        userStates.delete(chatId);
      } catch (error) {
        bot.sendMessage(chatId, '❌ Erro ao registrar pagamento.');
        console.error(error);
      }
    }
  }
  
  // Callbacks de despesa - data
  if (data === 'desp_data_hoje') {
    if (state) {
      state.data.data = new Date();
      state.step = 'descricao';
      bot.sendMessage(chatId, '📝 Digite a descrição da despesa:');
    }
  } else if (data === 'desp_data_outra') {
    if (state) {
      state.step = 'data_manual';
      bot.sendMessage(chatId, '📅 Digite a data (DD/MM/AAAA):');
    }
  }
  
  // Callbacks de despesa - forma pagamento
  if (data.startsWith('desp_pag_')) {
    const forma = data.replace('desp_pag_', '');
    
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
        
        await db.collection('despesas').insertOne(despesa);
        
        let message = '✅ *Despesa adicionada com sucesso!*\n\n';
        message += `📝 ${despesa.descricao}\n`;
        message += `💰 ${formatCurrency(despesa.valor)}\n`;
        message += `📅 ${formatDate(despesa.data)}\n`;
        if (despesa.formaPagamento) message += `💳 ${despesa.formaPagamento}\n`;
        
        bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
        userStates.delete(chatId);
      } catch (error) {
        bot.sendMessage(chatId, '❌ Erro ao adicionar despesa.');
        console.error(error);
      }
    }
  }
  
  // Callbacks de orçamento - tipo
  if (data.startsWith('orc_tipo_')) {
    const tipo = data.replace('orc_tipo_', '') as 'festa' | 'evento';
    if (state) {
      state.data.tipo = tipo;
      state.step = 'data';
      bot.sendMessage(chatId, '📅 Digite a data do evento (DD/MM/AAAA):');
    }
  }
  
  // Callbacks de orçamento - recreadores
  if (data.startsWith('orc_rec_')) {
    const rec = data.replace('orc_rec_', '');
    
    if (state) {
      if (rec === 'outro') {
        state.step = 'recreadores_manual';
        bot.sendMessage(chatId, '👥 Digite a quantidade de recreadores:');
      } else {
        state.data.quantidadeRecreadores = parseInt(rec);
        
        const keyboard = {
          inline_keyboard: [
            [{ text: 'Sim', callback_data: 'orc_fds_sim' }],
            [{ text: 'Não', callback_data: 'orc_fds_nao' }]
          ]
        };
        
        bot.sendMessage(chatId, 'É feriado ou fim de semana?', { reply_markup: keyboard });
      }
    }
  }
  
  // Callbacks de orçamento - feriado/FDS
  if (data.startsWith('orc_fds_')) {
    if (state) {
      state.data.isFeriadoOuFds = data === 'orc_fds_sim';
      state.step = 'deslocamento';
      bot.sendMessage(chatId, '🚗 Custo de deslocamento (ou 0):');
    }
  }
  
  // Callbacks de listagem de agendamentos
  if (data.startsWith('list_ag_')) {
    const periodo = data.replace('list_ag_', '');
    await listarAgendamentos(chatId, periodo);
  }
  
  // Callbacks de listagem de despesas
  if (data.startsWith('list_desp_')) {
    const periodo = data.replace('list_desp_', '');
    await listarDespesas(chatId, periodo);
  }
  
  // Callbacks de total de despesas
  if (data.startsWith('total_desp_')) {
    const periodo = data.replace('total_desp_', '');
    await calcularTotalDespesas(chatId, periodo);
  }
  
  // Callbacks de listagem de orçamentos
  if (data.startsWith('list_orc_')) {
    const status = data.replace('list_orc_', '');
    await listarOrcamentos(chatId, status);
  }
  
  // Callbacks de ações rápidas no lembrete
  if (data.startsWith('ag_conf_')) {
    const agId = new ObjectId(data.replace('ag_conf_', ''));
    await db.collection('agendamentos').updateOne(
      { _id: agId },
      { $set: { status: 'confirmado', updatedAt: new Date() } }
    );
    bot.sendMessage(chatId, '✅ Agendamento confirmado!');
  }
  
  if (data.startsWith('ag_canc_')) {
    const agId = new ObjectId(data.replace('ag_canc_', ''));
    const ag = await db.collection('agendamentos').findOne({ _id: agId });
    
    await db.collection('agendamentos').updateOne(
      { _id: agId },
      { $set: { status: 'cancelado', updatedAt: new Date() } }
    );
    
    if (ag.googleEventId) {
      await deleteCalendarEvent(ag.googleEventId);
    }
    
    bot.sendMessage(chatId, '❌ Agendamento cancelado!');
  }
  
  bot.answerCallbackQuery(query.id);
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
      bot.sendMessage(chatId, '📅 Digite a data (DD/MM/AAAA):');
      return;
    }
    
    if (!inicio || !fim) {
      bot.sendMessage(chatId, '❌ Período inválido.');
      return;
    }
    
    const agendamentos = await db.collection('agendamentos').find({
      data: { $gte: inicio, $lt: fim },
      status: { $ne: 'cancelado' }
    }).sort({ data: 1, horario: 1 }).toArray();
    
    if (agendamentos.length === 0) {
      bot.sendMessage(chatId, '📭 Não há agendamentos para este período.');
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
    
    bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
  } catch (error) {
    bot.sendMessage(chatId, '❌ Erro ao listar agendamentos.');
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
      bot.sendMessage(chatId, '📅 Digite a data inicial (DD/MM/AAAA):');
      return;
    }
    
    if (!inicio || !fim) {
      bot.sendMessage(chatId, '❌ Período inválido.');
      return;
    }
    
    const despesas = await db.collection('despesas').find({
      data: { $gte: inicio, $lt: fim }
    }).sort({ data: -1 }).toArray();
    
    if (despesas.length === 0) {
      bot.sendMessage(chatId, '📭 Não há despesas para este período.');
      return;
    }
    
    let message = `💸 *DESPESAS - ${periodo.toUpperCase()}*\n\n`;
    let total = 0;
    
    const tiposLabels: { [key: string]: string } = {
      pro_labore: '💼', alimentacao: '🍔', transporte: '🚗',
      materiais: '📦', marketing: '📢', equipamentos: '🔧',
      aluguel: '🏢', agua_luz: '💡', telefonia: '📱',
      impostos: '📋', manutencao: '🛠️', terceirizados: '👥', outros: '📌'
    };
    
    for (const desp of despesas) {
      message += `${tiposLabels[desp.tipo]} ${desp.descricao}\n`;
      message += `💰 ${formatCurrency(desp.valor)} - ${formatDate(desp.data)}\n`;
      if (desp.formaPagamento) message += `💳 ${desp.formaPagamento}\n`;
      message += '---\n';
      total += desp.valor;
    }
    
    message += `\n💵 *TOTAL: ${formatCurrency(total)}*`;
    
    bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
  } catch (error) {
    bot.sendMessage(chatId, '❌ Erro ao listar despesas.');
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
      bot.sendMessage(chatId, '❌ Período inválido.');
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
    
    bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
  } catch (error) {
    bot.sendMessage(chatId, '❌ Erro ao calcular total.');
    console.error(error);
  }
}

async function listarOrcamentos(chatId: number, status: string) {
  try {
    const query = status === 'todos' ? {} : { status };
    const orcamentos = await db.collection('orcamentos').find(query).sort({ createdAt: -1 }).toArray();
    
    if (orcamentos.length === 0) {
      bot.sendMessage(chatId, '📭 Não há orçamentos nesta categoria.');
      return;
    }
    
    let message = `📊 *ORÇAMENTOS - ${status.toUpperCase()}*\n\n`;
    
    const statusEmoji: { [key: string]: string } = {
      rascunho: '📝',
      enviado: '📤',
      aprovado: '✅',
      concluido: '🎉',
      cancelado: '❌'
    };
    
    for (const orc of orcamentos) {
      message += `${statusEmoji[orc.status]} ${orc.cliente}\n`;
      message += `${orc.tipo === 'festa' ? '🎈' : '📅'} ${orc.tipo.toUpperCase()}\n`;
      message += `📅 ${formatDate(orc.dataEvento)} às ${orc.horario}\n`;
      message += `💰 ${formatCurrency(orc.valorFinal)}\n`;
      message += `📍 ${orc.endereco}\n`;
      message += `🆔 ${orc._id}\n`;
      message += '---\n';
    }
    
    bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
  } catch (error) {
    bot.sendMessage(chatId, '❌ Erro ao listar orçamentos.');
    console.error(error);
  }
}

// ==================== INICIALIZAÇÃO DO BOT ====================
async function start() {
  await connectDB();
  console.log('🤖 Bot Telegram iniciado!');
  bot.sendMessage(ADMIN_CHAT_ID, '🤖 Bot Recrear no Lar iniciado com sucesso!');
}

start().catch(console.error);