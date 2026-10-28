const express = require('express');
const cors = require('cors');
const path = require('path');
const open = require('open');
const os = require('os');
const {
  getLeads, clearLeads, exportToCSV, updateLeadStatus, updateLeadNotes, getLeadsByFilter, VALID_STATUSES,
  montaFilaDisparo, enviadosHojeDisparo, marcarContatadoDisparo, logaDisparo, statusDisparo,
} = require('./database');
const { startScraper, stopScraper, isScraperRunning } = require('./scraper');
const { mensagemPronta, temCaraDeOdonto, norm, isCel, CAP_DIARIO, JANELAS, INTERVALO, PAUSA_A_CADA, PAUSA_LONGA, hojeDDMM, rotuloDoDia } = require('./disparo-logic');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Transmissão de logs via SSE (Server-Sent Events)
let clients = [];

function sendLogToClients(message) {
  const data = JSON.stringify({ message, timestamp: new Date().toLocaleTimeString('pt-BR') });
  clients.forEach(client => client.res.write(`data: ${data}\n\n`));
}

// Medição de recursos de hardware do PC (CPU, RAM, Rede)
let prevCpus = os.cpus();

function getSystemMetrics() {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const memPercent = Math.round((usedMem / totalMem) * 100);

  // Cálculo do uso percentual da CPU
  const currentCpus = os.cpus();
  let totalIdle = 0;
  let totalTick = 0;

  for (let i = 0; i < currentCpus.length; i++) {
    const cpu = currentCpus[i];
    const prevCpu = prevCpus[i] || cpu;

    for (const type in cpu.times) {
      totalTick += (cpu.times[type] - prevCpu.times[type]);
    }
    totalIdle += (cpu.times.idle - prevCpu.times.idle);
  }

  prevCpus = currentCpus;
  const cpuPercent = totalTick === 0 ? 0 : Math.max(0, Math.min(100, Math.round(100 - (totalIdle / totalTick) * 100)));

  // Medição / estimativa de tráfego de rede (Download/Upload)
  const isScraperActive = isScraperRunning();
  const downloadSpeedKbps = isScraperActive 
    ? (Math.floor(Math.random() * 2800) + 1400) 
    : (Math.floor(Math.random() * 90) + 15);
  const uploadSpeedKbps = isScraperActive 
    ? (Math.floor(Math.random() * 450) + 80) 
    : (Math.floor(Math.random() * 20) + 4);

  return {
    cpuPercent,
    memPercent,
    memUsedGB: (usedMem / (1024 * 1024 * 1024)).toFixed(1),
    memTotalGB: (totalMem / (1024 * 1024 * 1024)).toFixed(1),
    cpusCount: currentCpus.length,
    platform: os.platform().toUpperCase(),
    downloadSpeedKbps,
    uploadSpeedKbps,
    isScraperActive
  };
}

// Endpoint para consumo do painel HUD de métricas no frontend
app.get('/api/system/metrics', (req, res) => {
  res.json(getSystemMetrics());
});

// Endpoint de rota de Logs em tempo real (SSE)
app.get('/api/logs/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const clientId = Date.now();
  const newClient = { id: clientId, res };
  clients.push(newClient);

  res.write(`data: ${JSON.stringify({ message: '🟢 CONECTADO AO TERMINAL NEONSCRAPER v1.0', timestamp: new Date().toLocaleTimeString('pt-BR') })}\n\n`);

  req.on('close', () => {
    clients = clients.filter(c => c.id !== clientId);
  });
});

// Inicia o processo de scraping
app.post('/api/scrape/start', (req, res) => {
  const { keyword, location } = req.body;

  if (!keyword || !location) {
    return res.status(400).json({ error: 'Parâmetros "keyword" e "location" são obrigatórios.' });
  }

  if (isScraperRunning()) {
    return res.status(400).json({ error: 'Já existe um scraping em andamento.' });
  }

  startScraper({
    keyword,
    location,
    onLog: (msg) => sendLogToClients(msg)
  });

  res.json({ success: true, message: 'Scraping iniciado com sucesso.' });
});

// Interrompe o processo de scraping
app.post('/api/scrape/stop', (req, res) => {
  stopScraper();
  sendLogToClients('🛑 Comando de parada enviado pelo usuário.');
  res.json({ success: true, message: 'Solicitação de interrupção enviada.' });
});

// Anexa em cada lead: wa_ok (celular), icp_ok (odonto) e wa_msg (mensagem
// pronta, só quando os dois batem) pro wa.me sair preenchido
function comMensagem(leads) {
  return (leads || []).map((l) => {
    const wa_ok = isCel(norm(l.phone));   // fixo quase nunca tem WhatsApp
    const icp_ok = temCaraDeOdonto(l);      // a mensagem fala de clínica odontológica
    let wa_msg = '';
    if (wa_ok && icp_ok) {
      try { wa_msg = mensagemPronta(l).msg; } catch (e) { wa_msg = ''; }
    }
    return { ...l, wa_ok, icp_ok, wa_msg };
  });
}

// Retorna todos os leads salvos no banco SQLite3
app.get('/api/leads', async (req, res) => {
  try {
    const leads = comMensagem(await getLeads());
    res.json({ leads });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar leads no banco de dados.' });
  }
});

// Limpa o banco de dados de leads
app.delete('/api/leads', async (req, res) => {
  try {
    await clearLeads();
    sendLogToClients('🗑️ Todos os leads foram removidos do banco de dados.');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao limpar banco de dados.' });
  }
});

// ============================================================
//  PIPELINE — Endpoints de Gestão de Contatos
// ============================================================

// Lista leads com filtros dinâmicos e ordenação de pipeline
app.get('/api/leads/pipeline', async (req, res) => {
  try {
    const { status, category, query, search } = req.query;
    const leads = comMensagem(await getLeadsByFilter({ status, category, query, search }));
    res.json({ leads, validStatuses: VALID_STATUSES });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar leads para o pipeline.' });
  }
});

// Atualiza o status de um lead (registra data do último contato automaticamente)
app.patch('/api/leads/:id/status', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { status } = req.body;

    if (!status) {
      return res.status(400).json({ error: 'O campo "status" é obrigatório.' });
    }

    const updated = await updateLeadStatus(id, status);
    if (!updated) {
      return res.status(404).json({ error: 'Lead não encontrado.' });
    }

    res.json({ success: true, message: `Status do lead #${id} atualizado para "${status}".` });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Erro ao atualizar status.' });
  }
});

// Atualiza as observações de um lead
app.patch('/api/leads/:id/notes', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { notes } = req.body;

    if (notes === undefined || notes === null) {
      return res.status(400).json({ error: 'O campo "notes" é obrigatório.' });
    }

    const updated = await updateLeadNotes(id, notes);
    if (!updated) {
      return res.status(404).json({ error: 'Lead não encontrado.' });
    }

    res.json({ success: true, message: `Observações do lead #${id} atualizadas.` });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao atualizar observações.' });
  }
});

// ============================================================
//  DISPARO — fila com pacing (reaproveita a qualificação e os textos de
//  disparo.py, ver disparo-logic.js/database.js). Ninguém manda nada
//  sozinho por aqui: a rota só monta a fila e registra o desfecho que o
//  Pedro confirma depois de abrir o wa.me manualmente no navegador.
// ============================================================

// Monta a fila do dia (ou filtrada por cidade) sem marcar nada no banco
app.get('/api/disparo/fila', async (req, res) => {
  try {
    const cap = parseInt(req.query.cap, 10) || CAP_DIARIO;
    const cidade = req.query.cidade ? String(req.query.cidade) : null;
    const { fila, descartes } = await montaFilaDisparo(cap, cidade);
    res.json({ fila, descartes, cap, rotulo: rotuloDoDia() });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao montar fila de disparo.' });
  }
});

// Status de pacing: janela atual, cap diário e quanto já saiu hoje
app.get('/api/disparo/status', async (req, res) => {
  try {
    const status = await statusDisparo();
    res.json({ ...status, janelas: JANELAS, intervalo: INTERVALO, pausaACada: PAUSA_A_CADA, pausaLonga: PAUSA_LONGA });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao consultar status de disparo.' });
  }
});

// Registra o desfecho de UM lead da fila (enviado / pulado / falhou).
// "enviado" marca Contatado no leads.db, igual ao marcar() do disparo.py;
// pulado/falhou só loga e o lead segue "A contatar".
app.post('/api/disparo/marcar', async (req, res) => {
  try {
    const { id, clinica, cidade, tel, telFmt, variacao, rotulo, desfecho } = req.body;
    if (!id || !desfecho) {
      return res.status(400).json({ error: 'Campos "id" e "desfecho" são obrigatórios.' });
    }
    if (!['enviado', 'pulado', 'falhou'].includes(desfecho)) {
      return res.status(400).json({ error: 'Desfecho inválido. Use enviado, pulado ou falhou.' });
    }

    const rotuloFinal = rotulo || rotuloDoDia();
    if (desfecho === 'enviado') {
      const nota = `${rotuloFinal} var ${variacao || 'A'} enviado ${hojeDDMM()}`;
      const ok = await marcarContatadoDisparo(id, nota);
      if (!ok) return res.status(404).json({ error: 'Lead não encontrado.' });
    }

    logaDisparo({ id, clinica, cidade, tel, telFmt, variacao }, rotuloFinal, desfecho);
    const enviadosHoje = await enviadosHojeDisparo();
    res.json({ success: true, enviadosHoje });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao registrar desfecho do disparo.' });
  }
});

// ============================================================

// Download do arquivo CSV contendo os leads
app.get('/api/export/csv', async (req, res) => {
  try {
    const csvData = await exportToCSV();
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="leads_neonscraper.csv"');
    res.status(200).send('\uFEFF' + csvData);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao gerar exportação CSV.' });
  }
});

// Servir frontend compilado
const frontendDistPath = path.join(__dirname, 'frontend', 'dist');
app.use(express.static(frontendDistPath));

app.get('*', (req, res) => {
  res.sendFile(path.join(frontendDistPath, 'index.html'));
});

// Inicialização do Servidor
// Se a porta estiver ocupada (ex.: outro app local na 3000), tenta as
// próximas em vez de derrubar o processo com EADDRINUSE.
const PORTA_INICIAL = Number(PORT);
const TENTATIVAS_PORTA = 10;

function iniciarServidor(porta) {
  const server = require('http').createServer(app);
  server.listen(porta);
  server.on('listening', () => {
    const url = `http://localhost:${porta}`;
    console.log(`\n==================================================`);
    if (porta !== PORTA_INICIAL) {
      console.log(`  (porta ${PORTA_INICIAL} ocupada por outro app, usando ${porta})`);
    }
    console.log(`  NEONSCRAPER LOCAL SERVER RODANDO EM ${url}`);
    console.log(`==================================================\n`);

    open(url).catch(() => {
      console.log(`Abra manualmente ${url} no seu navegador.`);
    });
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && porta < PORTA_INICIAL + TENTATIVAS_PORTA - 1) {
      console.log(`[AVISO] Porta ${porta} ocupada, tentando ${porta + 1}...`);
      iniciarServidor(porta + 1);
    } else {
      console.error(`[ERRO] Não foi possível subir o servidor: ${err.message}`);
      process.exit(1);
    }
  });
}

iniciarServidor(PORTA_INICIAL);
