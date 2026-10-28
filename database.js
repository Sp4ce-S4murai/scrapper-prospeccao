const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const {
  ODO, ABERTURA_MANUAL, PESO_CIDADE, CAP_DIARIO,
  norm, isCel, limpaNome, cidadeDe, sugereAbertura, validaAbertura, msgA, fmt,
  dentroDaJanela, proximaJanela, hojeISO, agoraFmt, rotuloDoDia, motivoArquivamento,
} = require('./disparo-logic');

const dbPath = path.join(__dirname, 'leads.db');
const db = new sqlite3.Database(dbPath);
const LOG_DISPARO_PATH = path.join(__dirname, 'log-disparo.csv');

// Lista de status válidos para o pipeline de contatos
const VALID_STATUSES = [
  'A contatar',
  'Contatado',
  'Respondeu',
  'Reunião marcada',
  'Fechado',
  'Sem interesse',
  'Sem resposta'
];

// Inicializa a tabela de leads com suporte a URL do Google Maps
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      category TEXT,
      address TEXT,
      phone TEXT NOT NULL,
      query TEXT,
      maps_url TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Migration de compatibilidade para adicionar a coluna maps_url caso a tabela já exista
  db.run(`ALTER TABLE leads ADD COLUMN maps_url TEXT`, () => {
    // Ignora o erro se a coluna já existir
  });

  // Migration: coluna de status do pipeline (default = 'A contatar')
  db.run(`ALTER TABLE leads ADD COLUMN status TEXT DEFAULT 'A contatar'`, () => {
    // Ignora o erro se a coluna já existir
  });

  // Migration: coluna de data do último contato
  db.run(`ALTER TABLE leads ADD COLUMN last_contact_at DATETIME`, () => {
    // Ignora o erro se a coluna já existir
  });

  // Arquivo de leads fora do ICP / sem celular (criado na limpeza de 15/09)
  db.run(`
    CREATE TABLE IF NOT EXISTS leads_arquivo (
      id INTEGER PRIMARY KEY,
      name TEXT, category TEXT, address TEXT, phone TEXT, query TEXT,
      maps_url TEXT, created_at DATETIME, status TEXT, last_contact_at DATETIME, notes TEXT,
      motivo_arquivamento TEXT, arquivado_em DATETIME
    )
  `);

  // Migration: coluna de observações do pipeline
  db.run(`ALTER TABLE leads ADD COLUMN notes TEXT DEFAULT ''`, () => {
    // Ignora o erro se a coluna já existir
  });
});

/**
 * Salva um lead novo. Duplicado = mesmo telefone e nome, na tabela ativa OU
 * no arquivo (senão todo re-scrape traz de volta o que já foi arquivado).
 * Lead fora do ICP ou sem celular vai direto pra `leads_arquivo`.
 * @param {Object} lead
 * @returns {Promise<false|'novo'|'arquivado'>} false se já existia.
 */
function saveLead(lead) {
  return new Promise((resolve, reject) => {
    const checkQuery = `
      SELECT id FROM leads WHERE phone = ? AND name = ?
      UNION ALL
      SELECT id FROM leads_arquivo WHERE phone = ? AND name = ?
      LIMIT 1`;
    db.get(checkQuery, [lead.phone, lead.name, lead.phone, lead.name], (err, row) => {
      if (err) return reject(err);
      if (row) {
        return resolve(false);
      }

      const createdAt = new Date().toISOString(); // ISO string UTC (ex: 2026-08-03T20:22:37.123Z)
      const valores = [
        lead.name,
        lead.category || '',
        lead.address || '',
        lead.phone,
        lead.query || '',
        lead.maps_url || '',
        createdAt,
      ];
      const motivo = motivoArquivamento({ ...lead, category: lead.category || '' });

      db.run(`
        INSERT INTO leads (name, category, address, phone, query, maps_url, created_at, status, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'A contatar', '')
      `, valores, function (err) {
        if (err) return reject(err);
        if (!motivo) return resolve('novo');

        // Move pro arquivo mantendo o id da sequência de `leads` (restaurar
        // depois é só copiar de volta, sem conflito de id)
        const id = this.lastID;
        db.run(`
          INSERT INTO leads_arquivo (id, name, category, address, phone, query, maps_url, created_at,
                                     status, last_contact_at, notes, motivo_arquivamento, arquivado_em)
          SELECT id, name, category, address, phone, query, maps_url, created_at,
                 status, last_contact_at, notes, ?, ?
          FROM leads WHERE id = ?
        `, [motivo, createdAt, id], (err2) => {
          if (err2) return resolve('novo'); // se falhar, o lead só fica na tabela ativa
          db.run(`DELETE FROM leads WHERE id = ?`, [id], () => resolve('arquivado'));
        });
      });
    });
  });
}

/**
 * Obtém todos os leads ordenados por data de criação.
 * @returns {Promise<Array>}
 */
function getLeads() {
  return new Promise((resolve, reject) => {
    db.all(`SELECT * FROM leads ORDER BY id DESC`, [], (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

/**
 * Limpa todos os leads salvos.
 * @returns {Promise<void>}
 */
function clearLeads() {
  return new Promise((resolve, reject) => {
    db.run(`DELETE FROM leads`, [], (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

/**
 * Atualiza o status de um lead e registra a data do último contato automaticamente.
 * @param {number} id ID do lead
 * @param {string} status Novo status do pipeline
 * @returns {Promise<boolean>} true se o lead foi atualizado, false se não encontrado
 */
function updateLeadStatus(id, status) {
  return new Promise((resolve, reject) => {
    if (!VALID_STATUSES.includes(status)) {
      return reject(new Error(`Status inválido: "${status}". Valores aceitos: ${VALID_STATUSES.join(', ')}`));
    }

    const lastContactAt = new Date().toISOString();
    const query = `UPDATE leads SET status = ?, last_contact_at = ? WHERE id = ?`;
    db.run(query, [status, lastContactAt, id], function (err) {
      if (err) return reject(err);
      resolve(this.changes > 0);
    });
  });
}

/**
 * Atualiza as observações de um lead.
 * @param {number} id ID do lead
 * @param {string} notes Texto livre de observações
 * @returns {Promise<boolean>} true se o lead foi atualizado, false se não encontrado
 */
function updateLeadNotes(id, notes) {
  return new Promise((resolve, reject) => {
    const query = `UPDATE leads SET notes = ? WHERE id = ?`;
    db.run(query, [notes, id], function (err) {
      if (err) return reject(err);
      resolve(this.changes > 0);
    });
  });
}

/**
 * Obtém leads com filtros dinâmicos e ordenação de pipeline.
 * Leads com status "A contatar" aparecem primeiro, depois por data de criação mais recente.
 * @param {Object} filters
 * @param {string} [filters.status] Filtrar por status específico
 * @param {string} [filters.category] Filtrar por categoria
 * @param {string} [filters.query] Filtrar por termo de busca original
 * @param {string} [filters.search] Busca textual no nome, telefone, endereço
 * @returns {Promise<Array>}
 */
function getLeadsByFilter({ status, category, query, search } = {}) {
  return new Promise((resolve, reject) => {
    const conditions = [];
    const params = [];

    if (status) {
      conditions.push(`status = ?`);
      params.push(status);
    }
    if (category) {
      conditions.push(`category = ?`);
      params.push(category);
    }
    if (query) {
      conditions.push(`query = ?`);
      params.push(query);
    }
    if (search) {
      conditions.push(`(name LIKE ? OR phone LIKE ? OR address LIKE ?)`);
      const likeParam = `%${search}%`;
      params.push(likeParam, likeParam, likeParam);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Ordenação pipeline: "A contatar" primeiro, depois por data de criação DESC
    const sql = `
      SELECT * FROM leads
      ${whereClause}
      ORDER BY 
        CASE WHEN status = 'A contatar' THEN 0 ELSE 1 END ASC,
        created_at DESC
    `;

    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

/**
 * Converte os registros da tabela em formato CSV (com colunas de pipeline).
 * @returns {Promise<string>}
 */
async function exportToCSV() {
  const leads = await getLeads();
  const headers = [
    'ID', 'Nome', 'Categoria', 'Endereço', 'Telefone / WhatsApp',
    'Termo de Busca', 'Link Google Maps', 'Status', 'Data Último Contato',
    'Observações', 'Data de Registro'
  ];
  
  const escapeCSV = (field) => {
    if (field === null || field === undefined) return '""';
    const str = String(field).replace(/"/g, '""');
    return `"${str}"`;
  };

  /**
   * Converte timestamp ISO / SQLite para formato legível pt-BR.
   */
  const formatDate = (dateStr) => {
    if (!dateStr) return '';
    let str = String(dateStr);
    if (str && !str.includes('Z') && !str.includes('T')) {
      str = str.replace(' ', 'T') + 'Z';
    }
    const d = new Date(str);
    return isNaN(d.getTime()) ? dateStr : d.toLocaleString('pt-BR');
  };

  const rows = leads.map(l => {
    const mapsLink = l.maps_url || `https://www.google.com.br/maps/search/${encodeURIComponent(l.name + ' ' + (l.address || ''))}`;

    return [
      l.id,
      escapeCSV(l.name),
      escapeCSV(l.category),
      escapeCSV(l.address),
      escapeCSV(l.phone),
      escapeCSV(l.query),
      escapeCSV(mapsLink),
      escapeCSV(l.status || 'A contatar'),
      escapeCSV(formatDate(l.last_contact_at)),
      escapeCSV(l.notes),
      escapeCSV(formatDate(l.created_at))
    ].join(',');
  });

  return [headers.join(','), ...rows].join('\n');
}

// ============================================================
//  DISPARO — fila com pacing, reaproveitando a mesma qualificação e os
//  mesmos textos de disparo.py (ver disparo-logic.js). O rodapé "quem
//  aperta enviar é você" continua valendo: esta aba só monta a fila e
//  abre o wa.me com o texto pronto — ninguém aqui manda nada sozinho.
// ============================================================

/**
 * Telefones que já saíram da fila "A contatar" (mesma regra do
 * telefones_ja_usados do disparo.py) — evita mandar duas vezes pro mesmo
 * número quando matriz e filial repetem telefone com ids diferentes.
 */
function telefonesJaUsados() {
  return new Promise((resolve, reject) => {
    db.all(`SELECT phone FROM leads WHERE status != 'A contatar'`, [], (err, rows) => {
      if (err) return reject(err);
      resolve(new Set(rows.map((r) => norm(r.phone))));
    });
  });
}

/**
 * Monta a fila do dia: mesmas travas de disparo.py monta_fila() —
 * categoria ICP, celular válido, sem telefone repetido, filtro de
 * cidade opcional — e ordena por proximidade (PESO_CIDADE) e nome.
 * @param {number} cap
 * @param {string} [cidadeFiltro]
 * @returns {Promise<{fila: Array, descartes: Object}>}
 */
async function montaFilaDisparo(cap, cidadeFiltro) {
  const rows = await new Promise((resolve, reject) => {
    db.all(`SELECT * FROM leads WHERE status = 'A contatar'`, [], (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });

  const usados = await telefonesJaUsados();
  const fila = [];
  const descartes = { categoria: 0, sem_celular: 0, telefone_repetido: 0, cidade: 0 };
  const { semAcento } = require('./disparo-logic');

  for (const r of rows) {
    if (!ODO.has(r.category)) { descartes.categoria++; continue; }
    const tel = norm(r.phone);
    if (!isCel(tel)) { descartes.sem_celular++; continue; }
    if (usados.has(tel)) { descartes.telefone_repetido++; continue; }
    usados.add(tel);
    const cidade = cidadeDe(r);
    if (cidadeFiltro && !semAcento(cidade).includes(semAcento(cidadeFiltro))) {
      descartes.cidade++; continue;
    }
    const clinica = limpaNome(r.name, cidade);
    let abertura = ABERTURA_MANUAL[r.id] || sugereAbertura(r.name) || clinica;
    if (!validaAbertura(abertura, clinica)) abertura = clinica;
    const ddd = tel.slice(0, 2);
    fila.push({
      id: r.id,
      clinica,
      cidade,
      tel,
      telFmt: fmt(tel),
      abertura,
      variacao: 'A',
      msg: msgA(abertura, clinica, cidade),
      alerta: (ddd === '51' || ddd === '54') ? '' : `DDD ${ddd} fora do RS`,
    });
  }

  fila.sort((a, b) => {
    const pa = PESO_CIDADE[a.cidade] ?? 8;
    const pb = PESO_CIDADE[b.cidade] ?? 8;
    if (pa !== pb) return pa - pb;
    return a.clinica.localeCompare(b.clinica, 'pt-BR');
  });

  return { fila: fila.slice(0, cap), descartes };
}

/**
 * Quantos leads já foram marcados "Contatado" hoje (comparação por data
 * pura, igual disparo.py — não por timestamp completo).
 * @returns {Promise<number>}
 */
function enviadosHojeDisparo() {
  return new Promise((resolve, reject) => {
    db.get(`SELECT COUNT(*) as n FROM leads WHERE last_contact_at = ?`, [hojeISO()], (err, row) => {
      if (err) return reject(err);
      resolve(row ? row.n : 0);
    });
  });
}

/**
 * Marca um lead como "Contatado" da mesma forma que o marcar() do
 * disparo.py: concatena a nota nova na existente com " | " e grava
 * last_contact_at como data pura (YYYY-MM-DD) — não timestamp — porque
 * enviadosHojeDisparo() e o --relatorio do disparo.py comparam por essa
 * string exata.
 * @param {number} id
 * @param {string} nota
 * @returns {Promise<boolean>}
 */
function marcarContatadoDisparo(id, nota) {
  return new Promise((resolve, reject) => {
    db.get(`SELECT notes FROM leads WHERE id = ?`, [id], (err, row) => {
      if (err) return reject(err);
      if (!row) return resolve(false);
      const atual = row.notes || '';
      const novaNota = (atual ? atual + ' | ' : '') + nota;
      db.run(
        `UPDATE leads SET status = 'Contatado', last_contact_at = ?, notes = ? WHERE id = ?`,
        [hojeISO(), novaNota, id],
        function (err2) {
          if (err2) return reject(err2);
          resolve(this.changes > 0);
        }
      );
    });
  });
}

/**
 * Grava uma linha no MESMO log-disparo.csv que o disparo.py usa
 * (cabeçalho, delimitador ";" e BOM utf-8-sig idênticos) — os dois
 * caminhos (CLI e esta aba) compartilham um log só.
 */
function logaDisparo(lead, rotulo, desfecho) {
  const novo = !fs.existsSync(LOG_DISPARO_PATH);
  const escapa = (v) => {
    const s = String(v === undefined || v === null ? '' : v);
    return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const linhas = [];
  if (novo) linhas.push(['quando', 'lote', 'id', 'clinica', 'cidade', 'telefone', 'variacao', 'desfecho'].join(';'));
  linhas.push([
    agoraFmt(), rotulo, lead.id, lead.clinica, lead.cidade,
    lead.telFmt || fmt(lead.tel || ''), lead.variacao || '', desfecho,
  ].map(escapa).join(';'));
  const conteudo = linhas.join('\r\n') + '\r\n';
  if (novo) {
    fs.writeFileSync(LOG_DISPARO_PATH, '﻿' + conteudo, 'utf8');
  } else {
    fs.appendFileSync(LOG_DISPARO_PATH, conteudo, 'utf8');
  }
}

/**
 * Status de pacing pro HUD da aba: janela atual, cap e quantos já
 * saíram hoje — mesmos números que `python disparo.py --relatorio`
 * mostraria, só que consultáveis pela API.
 */
async function statusDisparo() {
  const hoje = await enviadosHojeDisparo();
  const janela = dentroDaJanela();
  return {
    enviadosHoje: hoje,
    cap: CAP_DIARIO,
    dentroDaJanela: janela.ok,
    motivoForaDaJanela: janela.motivo,
    proximaJanela: janela.ok ? null : proximaJanela().toISOString(),
    rotulo: rotuloDoDia(),
  };
}

module.exports = {
  saveLead,
  getLeads,
  clearLeads,
  exportToCSV,
  updateLeadStatus,
  updateLeadNotes,
  getLeadsByFilter,
  VALID_STATUSES,
  // disparo
  montaFilaDisparo,
  enviadosHojeDisparo,
  marcarContatadoDisparo,
  logaDisparo,
  statusDisparo,
};
