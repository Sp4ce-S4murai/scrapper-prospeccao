import React, { useState, useEffect, useRef, useCallback } from 'react';
import { 
  Terminal, 
  Search, 
  Play, 
  Square, 
  Download, 
  Trash2, 
  Database, 
  MapPin, 
  Phone, 
  Tag, 
  CheckCircle, 
  AlertCircle,
  RefreshCw,
  Zap,
  ExternalLink,
  Filter,
  Cpu,
  HardDrive,
  Wifi,
  ArrowDown,
  ArrowUp,
  Activity,
  Server,
  Users,
  MessageCircle,
  Edit3,
  X,
  Check,
  Send,
  SkipForward,
  Clock,
  AlertTriangle,
  Rocket,
  ShieldAlert
} from 'lucide-react';

// ============================================================
//  Constantes e utilitários
// ============================================================

const STATUS_OPTIONS = [
  'A contatar',
  'Contatado',
  'Respondeu',
  'Reunião marcada',
  'Fechado',
  'Sem interesse',
  'Sem resposta'
];

const STATUS_COLORS = {
  'A contatar':      { bg: '#ffaa00', text: '#000', glow: 'rgba(255,170,0,0.5)' },
  'Contatado':       { bg: '#00e5ff', text: '#000', glow: 'rgba(0,229,255,0.5)' },
  'Respondeu':       { bg: '#76ff03', text: '#000', glow: 'rgba(118,255,3,0.5)' },
  'Reunião marcada': { bg: '#39ff14', text: '#000', glow: 'rgba(57,255,20,0.5)' },
  'Fechado':         { bg: '#00e676', text: '#000', glow: 'rgba(0,230,118,0.5)' },
  'Sem interesse':   { bg: '#555555', text: '#aaa', glow: 'rgba(85,85,85,0.3)' },
  'Sem resposta':    { bg: '#555555', text: '#aaa', glow: 'rgba(85,85,85,0.3)' },
};

/**
 * Formata timestamps ISO / SQLite UTC para o fuso horário local do Brasil.
 */
function formatDateTime(dateStr) {
  if (!dateStr) return 'N/A';
  let str = String(dateStr);
  if (!str.includes('Z') && !str.includes('T')) {
    str = str.replace(' ', 'T') + 'Z';
  }
  const d = new Date(str);
  if (isNaN(d.getTime())) return dateStr;
  return d.toLocaleString('pt-BR');
}

/**
 * Formata velocidade de rede em KB/s ou MB/s.
 */
function formatSpeed(kbps) {
  if (!kbps || kbps < 0) return '0 KB/s';
  if (kbps >= 1000) {
    return `${(kbps / 1024).toFixed(1)} MB/s`;
  }
  return `${kbps} KB/s`;
}

/**
 * Sanitiza número de telefone para formato wa.me (somente dígitos).
 */
function sanitizePhoneForWhatsApp(phone) {
  if (!phone) return '';
  let digits = phone.replace(/[^\d]/g, '');
  // Se começa com 0, remove o zero e adiciona +55
  if (digits.startsWith('0')) {
    digits = '55' + digits.substring(1);
  }
  // Se não começa com 55, adiciona
  if (!digits.startsWith('55') && digits.length <= 11) {
    digits = '55' + digits;
  }
  return digits;
}

/**
 * Link wa.me do gerenciador de contatos, com a mensagem pronta (wa_msg,
 * gerada no server.js) quando existir.
 */
function waLinkLead(phone, msg) {
  const base = `https://wa.me/${sanitizePhoneForWhatsApp(phone)}`;
  return msg ? `${base}?text=${encodeURIComponent(msg)}` : base;
}

/**
 * Link wa.me com a mensagem pré-preenchida — mesma fórmula do wa_link()
 * de disparo.py. `tel` já vem normalizado (11 dígitos, sem +55) da fila.
 */
function waLinkDisparo(tel, msg) {
  return 'https://wa.me/55' + tel + '?text=' + encodeURIComponent(msg);
}

/**
 * Link de busca no Google pra conferir se a clínica já tem site (mesma
 * checagem do "[g]" do disparo.py, antes de confiar no filtro do scraper).
 */
function googleLinkDisparo(clinica, cidade) {
  return 'https://www.google.com/search?q=' + encodeURIComponent(`"${clinica}" ${cidade} site`);
}

/** Formata segundos como MM:SS pro contador de pacing. */
function formatMMSS(totalSeconds) {
  const s = Math.max(0, totalSeconds);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

// ============================================================
//  Componente principal
// ============================================================

export default function App() {
  const [activeTab, setActiveTab] = useState('console'); // 'console' | 'database' | 'pipeline' | 'disparo'
  const [keyword, setKeyword] = useState('');
  const [location, setLocation] = useState('');
  const [isScraping, setIsScraping] = useState(false);
  const [logs, setLogs] = useState([]);
  const [leads, setLeads] = useState([]);

  // Métricas de recursos do PC
  const [metrics, setMetrics] = useState({
    cpuPercent: 0,
    memPercent: 0,
    memUsedGB: '0',
    memTotalGB: '0',
    cpusCount: 1,
    platform: 'PC',
    downloadSpeedKbps: 0,
    uploadSpeedKbps: 0,
  });
  
  // Filtros da aba de banco de dados
  const [searchTerm, setSearchTerm] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [locationFilter, setLocationFilter] = useState('');

  // Estado do Pipeline
  const [pipelineLeads, setPipelineLeads] = useState([]);
  const [pipelineStatusFilter, setPipelineStatusFilter] = useState('');
  const [pipelineCategoryFilter, setPipelineCategoryFilter] = useState('');
  const [pipelineQueryFilter, setPipelineQueryFilter] = useState('');
  const [pipelineSearchTerm, setPipelineSearchTerm] = useState('');
  const [editingNotesId, setEditingNotesId] = useState(null);
  const [editingNotesValue, setEditingNotesValue] = useState('');
  const [whatsAppModal, setWhatsAppModal] = useState(null); // { leadId, leadName, phone }

  // Estado da aba DISPARO (fila com pacing, reaproveitando disparo.py)
  const [disparoCap, setDisparoCap] = useState(30);
  const [disparoCidadeFiltro, setDisparoCidadeFiltro] = useState('');
  const [filaDisparo, setFilaDisparo] = useState([]);
  const [disparoDescartes, setDisparoDescartes] = useState({});
  const [disparoRotulo, setDisparoRotulo] = useState('');
  const [disparoIndex, setDisparoIndex] = useState(0);
  const [disparoLoading, setDisparoLoading] = useState(false);
  const [waAberto, setWaAberto] = useState(false);
  const [resultadosSessao, setResultadosSessao] = useState({}); // { [leadId]: 'enviado'|'pulado'|'falhou' }
  const [disparoStatus, setDisparoStatus] = useState(null); // /api/disparo/status
  const [ignorarJanela, setIgnorarJanela] = useState(false);
  const [pacingUntil, setPacingUntil] = useState(null); // epoch ms
  const [pacingLabel, setPacingLabel] = useState('');
  const [nowTick, setNowTick] = useState(Date.now());
  const sentThisSessionRef = useRef(0);

  const [statusMessage, setStatusMessage] = useState('SISTEMA PRONTO');
  const terminalEndRef = useRef(null);
  const notesInputRef = useRef(null);

  // Busca estatísticas de hardware do backend a cada 2 segundos
  useEffect(() => {
    const fetchMetrics = async () => {
      try {
        const res = await fetch('/api/system/metrics');
        const data = await res.json();
        if (data) {
          setMetrics(data);
        }
      } catch (e) {
        // Falha silenciosa se desconectado
      }
    };

    fetchMetrics();
    const interval = setInterval(fetchMetrics, 2000);
    return () => clearInterval(interval);
  }, []);

  // Carrega os leads cadastrados
  const fetchLeads = async () => {
    try {
      const res = await fetch('/api/leads');
      const data = await res.json();
      if (data.leads) {
        setLeads(data.leads);
      }
    } catch (err) {
      console.error('Erro ao buscar leads:', err);
    }
  };

  // Carrega leads do pipeline com filtros
  const fetchPipelineLeads = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (pipelineStatusFilter) params.set('status', pipelineStatusFilter);
      if (pipelineCategoryFilter) params.set('category', pipelineCategoryFilter);
      if (pipelineQueryFilter) params.set('query', pipelineQueryFilter);
      if (pipelineSearchTerm) params.set('search', pipelineSearchTerm);

      const res = await fetch(`/api/leads/pipeline?${params.toString()}`);
      const data = await res.json();
      if (data.leads) {
        setPipelineLeads(data.leads);
      }
    } catch (err) {
      console.error('Erro ao buscar pipeline:', err);
    }
  }, [pipelineStatusFilter, pipelineCategoryFilter, pipelineQueryFilter, pipelineSearchTerm]);

  useEffect(() => {
    fetchLeads();

    const eventSource = new EventSource('/api/logs/stream');

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        setLogs((prev) => [...prev, data]);
        
        if (data.message.includes('LEAD ENCONTRADO') || data.message.includes('Processo finalizado')) {
          fetchLeads();
        }

        if (data.message.includes('Processo finalizado') || data.message.includes('interrompido')) {
          setIsScraping(false);
          setStatusMessage('SISTEMA EM ESPERA');
        }
      } catch (err) {
        console.error('Erro ao ler log:', err);
      }
    };

    return () => {
      eventSource.close();
    };
  }, []);

  // Recarrega pipeline quando filtros mudam ou aba é acessada
  useEffect(() => {
    if (activeTab === 'pipeline') {
      fetchPipelineLeads();
    }
  }, [activeTab, fetchPipelineLeads]);

  useEffect(() => {
    terminalEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  // Foca no input de notas quando entra em modo de edição
  useEffect(() => {
    if (editingNotesId !== null && notesInputRef.current) {
      notesInputRef.current.focus();
    }
  }, [editingNotesId]);

  const handleStartScrape = async (e) => {
    e.preventDefault();
    if (!keyword.trim() || !location.trim()) {
      alert('Por favor, informe a Palavra-Chave e a Cidade/Localização!');
      return;
    }

    setIsScraping(true);
    setStatusMessage('EXECUTANDO RASTREAMENTO...');

    try {
      const res = await fetch('/api/scrape/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keyword, location }),
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || 'Erro ao iniciar scraping.');
        setIsScraping(false);
        setStatusMessage('ERRO NA EXECUÇÃO');
      }
    } catch (err) {
      alert('Erro ao conectar ao servidor backend.');
      setIsScraping(false);
      setStatusMessage('FALHA DE CONEXÃO');
    }
  };

  const handleStopScrape = async () => {
    try {
      await fetch('/api/scrape/stop', { method: 'POST' });
      setStatusMessage('CANCELANDO...');
    } catch (err) {
      console.error('Erro ao parar scraping:', err);
    }
  };

  const handleClearLeads = async () => {
    if (!window.confirm('Tem certeza que deseja apagar TODOS os leads armazenados?')) {
      return;
    }
    try {
      await fetch('/api/leads', { method: 'DELETE' });
      fetchLeads();
      if (activeTab === 'pipeline') fetchPipelineLeads();
    } catch (err) {
      alert('Erro ao limpar banco de dados.');
    }
  };

  const handleDownloadCSV = () => {
    window.location.href = '/api/export/csv';
  };

  // ============================================================
  //  Pipeline — Handlers de Status e Notas
  // ============================================================

  const handleStatusChange = async (leadId, newStatus) => {
    try {
      const res = await fetch(`/api/leads/${leadId}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      });
      if (res.ok) {
        // Atualiza localmente para feedback instantâneo
        setPipelineLeads(prev => prev.map(l => 
          l.id === leadId 
            ? { ...l, status: newStatus, last_contact_at: new Date().toISOString() } 
            : l
        ));
        // Atualiza os leads da aba principal também
        setLeads(prev => prev.map(l =>
          l.id === leadId 
            ? { ...l, status: newStatus, last_contact_at: new Date().toISOString() } 
            : l
        ));
      }
    } catch (err) {
      console.error('Erro ao atualizar status:', err);
    }
  };

  const handleNotesSave = async (leadId) => {
    try {
      const res = await fetch(`/api/leads/${leadId}/notes`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes: editingNotesValue }),
      });
      if (res.ok) {
        setPipelineLeads(prev => prev.map(l => 
          l.id === leadId ? { ...l, notes: editingNotesValue } : l
        ));
        setLeads(prev => prev.map(l =>
          l.id === leadId ? { ...l, notes: editingNotesValue } : l
        ));
      }
    } catch (err) {
      console.error('Erro ao salvar observações:', err);
    }
    setEditingNotesId(null);
    setEditingNotesValue('');
  };

  const handleWhatsAppClick = (lead) => {
    const currentStatus = lead.status || 'A contatar';
    if (currentStatus === 'A contatar') {
      setWhatsAppModal({ leadId: lead.id, leadName: lead.name, phone: lead.phone, msg: lead.wa_msg || '' });
    } else {
      // Abre direto se não é "A contatar"
      window.open(waLinkLead(lead.phone, lead.wa_msg), '_blank');
    }
  };

  const handleWhatsAppConfirm = (markAsContacted) => {
    if (!whatsAppModal) return;
    window.open(waLinkLead(whatsAppModal.phone, whatsAppModal.msg), '_blank');

    if (markAsContacted) {
      handleStatusChange(whatsAppModal.leadId, 'Contatado');
    }
    setWhatsAppModal(null);
  };

  // ============================================================
  //  Disparo — fila com pacing
  // ============================================================

  // Consulta janela de horário, cap diário e quantos já saíram hoje
  const fetchDisparoStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/disparo/status');
      const data = await res.json();
      if (res.ok) setDisparoStatus(data);
    } catch (err) {
      // falha silenciosa — HUD só não atualiza
    }
  }, []);

  // Monta a fila do dia (não marca nada, só consulta) e zera o progresso local
  const fetchDisparoFila = async () => {
    setDisparoLoading(true);
    try {
      const params = new URLSearchParams();
      params.set('cap', String(disparoCap || 30));
      if (disparoCidadeFiltro.trim()) params.set('cidade', disparoCidadeFiltro.trim());

      const res = await fetch(`/api/disparo/fila?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || 'Erro ao montar fila de disparo.');
        return;
      }
      setFilaDisparo(data.fila || []);
      setDisparoDescartes(data.descartes || {});
      setDisparoRotulo(data.rotulo || '');
      setDisparoIndex(0);
      setWaAberto(false);
      setResultadosSessao({});
      setPacingUntil(null);
      sentThisSessionRef.current = 0;
    } catch (err) {
      alert('Erro ao conectar ao servidor backend.');
    } finally {
      setDisparoLoading(false);
    }
    fetchDisparoStatus();
  };

  // Registra o desfecho do lead atual e avança pro próximo da fila.
  // "enviado" marca Contatado no leads.db (igual ao marcar() do disparo.py)
  // e liga o portão de pacing; pulado/falhou só loga e segue "A contatar".
  const marcarDesfecho = async (desfecho) => {
    const item = filaDisparo[disparoIndex];
    if (!item) return;
    try {
      const res = await fetch('/api/disparo/marcar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: item.id,
          clinica: item.clinica,
          cidade: item.cidade,
          tel: item.tel,
          telFmt: item.telFmt,
          variacao: item.variacao,
          rotulo: disparoRotulo,
          desfecho,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || 'Erro ao registrar desfecho.');
        return;
      }

      setResultadosSessao((prev) => ({ ...prev, [item.id]: desfecho }));
      if (disparoStatus) setDisparoStatus((prev) => ({ ...prev, enviadosHoje: data.enviadosHoje }));

      if (desfecho === 'enviado') {
        sentThisSessionRef.current += 1;
        const pausaACada = disparoStatus?.pausaACada || 8;
        const ehPausaLonga = sentThisSessionRef.current % pausaACada === 0;
        const [minS, maxS] = ehPausaLonga
          ? (disparoStatus?.pausaLonga || [900, 1500])
          : (disparoStatus?.intervalo || [240, 540]);
        const seg = Math.floor(Math.random() * (maxS - minS + 1)) + minS;
        setPacingUntil(Date.now() + seg * 1000);
        setPacingLabel(ehPausaLonga ? 'PAUSA LONGA' : 'INTERVALO');
        setIgnorarJanela(false);
      }

      setWaAberto(false);
      setDisparoIndex((i) => i + 1);
    } catch (err) {
      alert('Erro ao conectar ao servidor backend.');
    }
  };

  const handleAbrirWhatsAppDisparo = (item) => {
    window.open(waLinkDisparo(item.tel, item.msg), '_blank');
    setWaAberto(true);
  };

  // Relógio de 1s só pra o contador de pacing (MM:SS) e a janela de horário
  useEffect(() => {
    const t = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (activeTab === 'disparo') {
      fetchDisparoStatus();
      const t = setInterval(fetchDisparoStatus, 30000);
      return () => clearInterval(t);
    }
  }, [activeTab, fetchDisparoStatus]);

  const pacingRemainingSec = pacingUntil ? Math.max(0, Math.round((pacingUntil - nowTick) / 1000)) : 0;
  const emPacing = pacingRemainingSec > 0;

  const disparoItemAtual = filaDisparo[disparoIndex] || null;
  const disparoCapAtingido = disparoStatus && disparoStatus.enviadosHoje >= disparoStatus.cap;
  const disparoForaDaJanela = disparoStatus && !disparoStatus.dentroDaJanela;
  // Cap e janela são as duas guardas "soft" que o checkbox libera de propósito
  // (mesma filosofia do disparo.py: estimativa conservadora, não limite
  // publicado). O pacing (intervalo entre envios) é à parte — só sai clicando
  // "pular espera", não pelo checkbox, pra não banalizar rajada.
  const disparoBloqueado = ((disparoCapAtingido || disparoForaDaJanela) && !ignorarJanela) || emPacing;

  // ============================================================
  //  Dados derivados
  // ============================================================

  const uniqueCategories = Array.from(new Set(leads.map(l => l.category).filter(Boolean)));
  const uniqueQueries = Array.from(new Set(leads.map(l => l.query).filter(Boolean)));

  const filteredLeads = leads.filter((lead) => {
    const term = searchTerm.toLowerCase();
    const matchesTerm = (
      lead.name.toLowerCase().includes(term) ||
      lead.category.toLowerCase().includes(term) ||
      lead.phone.toLowerCase().includes(term) ||
      lead.address.toLowerCase().includes(term)
    );

    const matchesCategory = categoryFilter ? lead.category === categoryFilter : true;
    const matchesQuery = locationFilter ? lead.query === locationFilter : true;

    return matchesTerm && matchesCategory && matchesQuery;
  });

  // Contadores de status para a aba pipeline (calculado de TODOS os leads, não apenas os filtrados)
  const statusCounts = leads.reduce((acc, lead) => {
    const s = lead.status || 'A contatar';
    acc[s] = (acc[s] || 0) + 1;
    return acc;
  }, {});

  // Categorias e queries únicas para o pipeline (reaproveitadas dos leads)
  const pipelineUniqueCategories = uniqueCategories;
  const pipelineUniqueQueries = uniqueQueries;

  // ============================================================
  //  Componentes auxiliares inline
  // ============================================================

  const StatusBadge = ({ status }) => {
    const s = status || 'A contatar';
    const color = STATUS_COLORS[s] || STATUS_COLORS['A contatar'];
    return (
      <span 
        className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider whitespace-nowrap"
        style={{ 
          backgroundColor: color.bg, 
          color: color.text, 
          boxShadow: `0 0 6px ${color.glow}`,
        }}
      >
        {s === 'Fechado' && <Check className="w-3 h-3" />}
        {s}
      </span>
    );
  };

  // ============================================================
  //  Renderização
  // ============================================================

  return (
    <div className="crt-screen min-h-screen bg-black text-neon-green font-mono p-3 md:p-6 flex flex-col justify-between selection:bg-neon-pink selection:text-black">
      <div className="crt-overlay" />

      <div>
        {/* BARRA SUPERIOR HUD DE RECURSOS DO SISTEMA */}
        <div className="border-2 border-neon-green bg-black p-2.5 mb-4 text-xs font-mono border-glow-green">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 items-center">
            
            {/* CPU */}
            <div className="flex items-center gap-2 border border-neon-border p-1.5 bg-neon-panel">
              <Cpu className="w-4 h-4 text-neon-pink flex-shrink-0" />
              <div className="flex-1">
                <div className="flex justify-between text-[11px] mb-0.5">
                  <span className="text-gray-300 font-bold">CPU ({metrics.cpusCount} CORE)</span>
                  <span className="text-neon-pink font-bold">{metrics.cpuPercent}%</span>
                </div>
                <div className="w-full bg-black border border-neon-border h-2 overflow-hidden">
                  <div 
                    className="bg-neon-pink h-full transition-all duration-500" 
                    style={{ width: `${metrics.cpuPercent}%` }}
                  />
                </div>
              </div>
            </div>

            {/* RAM */}
            <div className="flex items-center gap-2 border border-neon-border p-1.5 bg-neon-panel">
              <HardDrive className="w-4 h-4 text-neon-green flex-shrink-0" />
              <div className="flex-1">
                <div className="flex justify-between text-[11px] mb-0.5">
                  <span className="text-gray-300 font-bold">RAM ({metrics.memUsedGB}GB / {metrics.memTotalGB}GB)</span>
                  <span className="text-neon-green font-bold">{metrics.memPercent}%</span>
                </div>
                <div className="w-full bg-black border border-neon-border h-2 overflow-hidden">
                  <div 
                    className="bg-neon-green h-full transition-all duration-500" 
                    style={{ width: `${metrics.memPercent}%` }}
                  />
                </div>
              </div>
            </div>

            {/* TRÁFEGO DE REDE */}
            <div className="flex items-center justify-between border border-neon-border p-1.5 bg-neon-panel text-[11px]">
              <div className="flex items-center gap-1.5">
                <Wifi className="w-4 h-4 text-yellow-400 flex-shrink-0" />
                <span className="text-gray-300 font-bold">REDE:</span>
              </div>
              <div className="flex gap-2 font-bold">
                <span className="text-neon-green flex items-center gap-0.5">
                  <ArrowDown className="w-3 h-3 text-neon-green" /> {formatSpeed(metrics.downloadSpeedKbps)}
                </span>
                <span className="text-neon-pink flex items-center gap-0.5">
                  <ArrowUp className="w-3 h-3 text-neon-pink" /> {formatSpeed(metrics.uploadSpeedKbps)}
                </span>
              </div>
            </div>

            {/* OS & ENGINE STATUS */}
            <div className="flex items-center justify-between border border-neon-border p-1.5 bg-neon-panel text-[11px]">
              <div className="flex items-center gap-1.5">
                <Server className="w-4 h-4 text-cyan-400 flex-shrink-0" />
                <span className="text-gray-300 font-bold">SISTEMA:</span>
                <span className="text-cyan-400 font-bold">{metrics.platform}</span>
              </div>
              <div className="flex items-center gap-1 font-bold">
                <Activity className="w-3 h-3 text-neon-green animate-pulse" />
                <span className="text-neon-green">HUD ONLINE</span>
              </div>
            </div>

          </div>
        </div>

        {/* HEADER CYBERPUNK COM NAVEGAÇÃO DE ABAS */}
        <header className="border-2 border-neon-green p-4 mb-6 bg-neon-panel border-glow-green">
          <div className="flex flex-col md:flex-row justify-between items-center gap-4 border-b border-neon-border pb-4 mb-4">
            <div className="flex items-center gap-3">
              <Zap className="w-8 h-8 text-neon-pink animate-pulse" />
              <div>
                <h1 className="text-2xl md:text-4xl font-bold tracking-widest text-glow-green uppercase">
                  NEON-SCRAPER <span className="text-neon-pink text-glow-pink">v1.0</span>
                </h1>
                <p className="text-xs text-neon-muted uppercase tracking-wider">
                  SISTEMA LOCAL DE EXTRAÇÃO B2B // EXCLUSIVO PARA EMPRESAS SEM WEBSITE
                </p>
              </div>
            </div>

            <div className="flex items-center gap-3 border border-neon-border px-4 py-2 bg-black">
              <span className="text-xs text-gray-400">STATUS DO CORE:</span>
              <span className={`text-sm font-bold tracking-wider ${isScraping ? 'text-neon-pink animate-ping' : 'text-neon-green'}`}>
                ●
              </span>
              <span className={`text-sm font-bold tracking-wider ${isScraping ? 'text-neon-pink text-glow-pink' : 'text-neon-green text-glow-green'}`}>
                {statusMessage}
              </span>
            </div>
          </div>

          {/* NAVEGAÇÃO POR ABAS (TABS) */}
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => setActiveTab('console')}
              className={`flex items-center gap-2 px-4 py-2 font-bold text-xs uppercase tracking-wider border transition-colors ${
                activeTab === 'console'
                  ? 'bg-neon-green text-black border-neon-green shadow-neon-green'
                  : 'bg-black text-neon-green border-neon-border hover:border-neon-green'
              }`}
            >
              <Terminal className="w-4 h-4" /> 📟 CONSOLE & RASTREAMENTO
            </button>

            <button
              onClick={() => setActiveTab('database')}
              className={`flex items-center gap-2 px-4 py-2 font-bold text-xs uppercase tracking-wider border transition-colors ${
                activeTab === 'database'
                  ? 'bg-neon-pink text-black border-neon-pink shadow-neon-pink'
                  : 'bg-black text-neon-pink border-neon-border hover:border-neon-pink'
              }`}
            >
              <Database className="w-4 h-4" /> 🗃️ BANCO DE LEADS ({leads.length})
            </button>

            <button
              onClick={() => setActiveTab('pipeline')}
              className={`flex items-center gap-2 px-4 py-2 font-bold text-xs uppercase tracking-wider border transition-colors ${
                activeTab === 'pipeline'
                  ? 'bg-neon-cyan text-black border-neon-cyan shadow-neon-cyan'
                  : 'bg-black text-neon-cyan border-neon-border hover:border-neon-cyan'
              }`}
            >
              <Users className="w-4 h-4" /> 📋 GESTÃO DE CONTATOS ({leads.length})
            </button>

            <button
              onClick={() => setActiveTab('disparo')}
              className={`flex items-center gap-2 px-4 py-2 font-bold text-xs uppercase tracking-wider border transition-colors ${
                activeTab === 'disparo'
                  ? 'bg-neon-amber text-black border-neon-amber shadow-neon-amber'
                  : 'bg-black text-neon-amber border-neon-border hover:border-neon-amber'
              }`}
            >
              <Rocket className="w-4 h-4" /> 🚀 DISPARO {filaDisparo.length > 0 ? `(${filaDisparo.length})` : ''}
            </button>
          </div>
        </header>

        {/* ABA 1: CONSOLE E RASTREAMENTO */}
        {activeTab === 'console' && (
          <div className="space-y-6">
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
              {/* PAINEL DE COMANDO */}
              <div className="lg:col-span-5 border-2 border-neon-green p-5 bg-neon-panel flex flex-col justify-between border-glow-green">
                <div>
                  <h2 className="text-xl font-bold text-neon-pink text-glow-pink mb-4 flex items-center gap-2 border-b border-neon-border pb-2 uppercase">
                    <Search className="w-5 h-5" /> PAINEL DE COMANDO
                  </h2>

                  <form onSubmit={handleStartScrape} className="space-y-4">
                    <div>
                      <label className="block text-xs text-neon-green mb-1 uppercase tracking-wider">
                        TERMO / CATEGORIA DA EMPRESA:
                      </label>
                      <input
                        type="text"
                        placeholder="Ex: Pizzaria, Oficina Mecânica, Petshop..."
                        value={keyword}
                        onChange={(e) => setKeyword(e.target.value)}
                        disabled={isScraping}
                        className="w-full bg-black border border-neon-green p-2 text-neon-green placeholder-neon-muted focus:outline-none focus:border-neon-pink"
                      />
                    </div>

                    <div>
                      <label className="block text-xs text-neon-green mb-1 uppercase tracking-wider">
                        CIDADE / LOCALIZAÇÃO:
                      </label>
                      <input
                        type="text"
                        placeholder="Ex: São Paulo - SP, Curitiba PR..."
                        value={location}
                        onChange={(e) => setLocation(e.target.value)}
                        disabled={isScraping}
                        className="w-full bg-black border border-neon-green p-2 text-neon-green placeholder-neon-muted focus:outline-none focus:border-neon-pink"
                      />
                    </div>

                    <div className="p-3 border border-neon-border bg-black text-xs space-y-1 text-gray-300">
                      <p className="text-neon-pink font-bold uppercase">⚙️ ALGORITMO DE FILTRAGEM ATIVO:</p>
                      <p>✓ Descarta empresas com Website ativo no Google Maps.</p>
                      <p>✓ Requer obrigatoriamente número de Telefone / WhatsApp.</p>
                      <p>✓ Simulação humanizada com delays randômicos anti-block.</p>
                    </div>

                    <div className="pt-2 flex flex-col sm:flex-row gap-3">
                      {!isScraping ? (
                        <button
                          type="submit"
                          className="flex-1 bg-neon-green text-black font-bold py-3 px-4 flex items-center justify-center gap-2 hover:bg-neon-pink hover:text-black transition-colors uppercase border border-neon-green shadow-neon-green"
                        >
                          <Play className="w-5 h-5 fill-current" /> INICIAR EXTRAÇÃO
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={handleStopScrape}
                          className="flex-1 bg-neon-pink text-black font-bold py-3 px-4 flex items-center justify-center gap-2 hover:bg-red-600 hover:text-white transition-colors uppercase border border-neon-pink shadow-neon-pink"
                        >
                          <Square className="w-5 h-5 fill-current" /> INTERROMPER
                        </button>
                      )}
                    </div>
                  </form>
                </div>

                <div className="mt-6 pt-4 border-t border-neon-border flex justify-between items-center text-xs">
                  <span className="text-neon-muted">PORTA LOCAL: 3000</span>
                  <span className="text-neon-green">PLAYWRIGHT HEADLESS: ON</span>
                </div>
              </div>

              {/* JANELA DE LOGS DO TERMINAL */}
              <div className="lg:col-span-7 border-2 border-neon-green bg-black p-4 flex flex-col h-[400px] border-glow-green">
                <div className="flex justify-between items-center border-b border-neon-border pb-2 mb-3">
                  <h2 className="text-sm font-bold text-neon-green flex items-center gap-2 uppercase tracking-wider">
                    <Terminal className="w-4 h-4 text-neon-pink" /> TERMINAL DE EVENTOS DA ENGINE [LOGS]
                  </h2>
                  <span className="text-xs text-neon-muted animate-pulse">● TRANSMISSÃO SSE ATIVA</span>
                </div>

                <div className="flex-1 overflow-y-auto space-y-1 font-mono text-xs p-2 bg-[#020502] border border-neon-border">
                  {logs.length === 0 ? (
                    <div className="text-neon-muted italic p-4 text-center">
                      Aguardando comando do usuário para iniciar rastreamento no Google Maps...
                    </div>
                  ) : (
                    logs.map((logItem, index) => (
                      <div key={index} className="flex gap-2 hover:bg-neon-panel p-0.5">
                        <span className="text-neon-muted font-bold">[{logItem.timestamp}]</span>
                        <span className={
                          logItem.message.includes('LEAD ENCONTRADO') ? 'text-neon-pink font-bold text-glow-pink' :
                          logItem.message.includes('DISCARDED') ? 'text-red-400 opacity-80' :
                          logItem.message.includes('Iniciando') ? 'text-yellow-300 font-bold' : 'text-neon-green'
                        }>
                          {logItem.message}
                        </span>
                      </div>
                    ))
                  )}
                  <div ref={terminalEndRef} />
                </div>
              </div>
            </div>

            {/* VISUALIZAÇÃO RÁPIDA DE LEADS (COM SCROLL FIXO) */}
            <section className="border-2 border-neon-green p-5 bg-neon-panel border-glow-green">
              <div className="flex justify-between items-center mb-4 border-b border-neon-border pb-3">
                <div>
                  <h2 className="text-xl font-bold text-neon-green text-glow-green flex items-center gap-2 uppercase">
                    <Database className="w-5 h-5 text-neon-pink" /> LEADS RECENTES ({leads.length})
                  </h2>
                  <p className="text-xs text-neon-muted">VISUALIZAÇÃO RÁPIDA DOS ÚLTIMOS LEADS EXTRAÍDOS</p>
                </div>
                <button
                  onClick={() => setActiveTab('database')}
                  className="bg-black text-neon-pink border border-neon-pink hover:bg-neon-pink hover:text-black px-3 py-1.5 text-xs font-bold uppercase transition-colors"
                >
                  ABRIR BANCO DEDICADO DE LEADS →
                </button>
              </div>

              {/* TABELA COM SCROLL VERTICAL LIMITADO */}
              <div className="max-h-[350px] overflow-y-auto border border-neon-border bg-black">
                <table className="w-full text-left text-xs border-collapse">
                  <thead className="sticky top-0 bg-neon-panel border-b border-neon-green text-neon-pink uppercase tracking-wider z-10">
                    <tr>
                      <th className="p-3 border-r border-neon-border">#ID</th>
                      <th className="p-3 border-r border-neon-border">NOME DA EMPRESA</th>
                      <th className="p-3 border-r border-neon-border">TELEFONE / WHATSAPP</th>
                      <th className="p-3 border-r border-neon-border">CATEGORIA</th>
                      <th className="p-3 border-r border-neon-border">ENDEREÇO</th>
                      <th className="p-3">DATA CADASTRO</th>
                    </tr>
                  </thead>
                  <tbody>
                    {leads.length === 0 ? (
                      <tr>
                        <td colSpan="6" className="p-8 text-center text-neon-muted italic">
                          Nenhum lead armazenado no momento.
                        </td>
                      </tr>
                    ) : (
                      leads.slice(0, 50).map((lead) => (
                        <tr key={lead.id} className="border-b border-neon-border hover:bg-neon-panel transition-colors">
                          <td className="p-3 border-r border-neon-border text-neon-muted">#{lead.id}</td>
                          <td className="p-3 border-r border-neon-border font-bold text-neon-green">
                            <a
                              href={lead.maps_url || `https://www.google.com.br/maps/search/${encodeURIComponent(lead.name + ' ' + (lead.address || ''))}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              title="Abrir no Google Maps"
                              className="inline-flex items-center gap-1.5 hover:text-neon-pink hover:underline text-glow-green transition-colors"
                            >
                              <span>{lead.name}</span>
                              <ExternalLink className="w-3.5 h-3.5 text-neon-pink flex-shrink-0" />
                            </a>
                          </td>
                          <td className="p-3 border-r border-neon-border text-neon-pink font-bold">
                            <div className="flex items-center gap-1">
                              <Phone className="w-3.5 h-3.5 text-neon-pink" />
                              {lead.phone}
                            </div>
                          </td>
                          <td className="p-3 border-r border-neon-border text-gray-300">
                            <div className="flex items-center gap-1">
                              <Tag className="w-3 h-3 text-neon-muted" />
                              {lead.category || 'N/A'}
                            </div>
                          </td>
                          <td className="p-3 border-r border-neon-border text-gray-400 max-w-xs truncate">
                            <div className="flex items-center gap-1">
                              <MapPin className="w-3 h-3 text-neon-muted flex-shrink-0" />
                              <span className="truncate">{lead.address || 'N/A'}</span>
                            </div>
                          </td>
                          <td className="p-3 text-neon-muted text-[10px]">
                            {formatDateTime(lead.created_at)}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          </div>
        )}

        {/* ABA 2: BANCO DE LEADS (GERENCIADOR DEDICADO COM FILTROS E SCROLL) */}
        {activeTab === 'database' && (
          <div className="space-y-6">
            {/* ESTATÍSTICAS E PAINEL DE FILTROS AVANÇADOS */}
            <div className="border-2 border-neon-pink p-5 bg-neon-panel border-glow-pink">
              <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-4 border-b border-neon-border pb-3">
                <div>
                  <h2 className="text-2xl font-bold text-neon-pink text-glow-pink flex items-center gap-2 uppercase">
                    <Filter className="w-6 h-6 text-neon-green" /> GERENCIADOR DA BASE DE LEADS
                  </h2>
                  <p className="text-xs text-neon-muted">FILTRAGEM, CONSULTA E EXPORTAÇÃO COMPLETA DOS CONTATOS EXTRAÍDOS</p>
                </div>

                {/* BOTÕES DE AÇÃO GLOBAL DA BASE */}
                <div className="flex flex-wrap gap-3">
                  <button
                    onClick={handleDownloadCSV}
                    disabled={leads.length === 0}
                    className="bg-neon-pink text-black text-xs font-bold px-4 py-2.5 flex items-center gap-2 hover:bg-white hover:text-black transition-colors disabled:opacity-40 uppercase border border-neon-pink shadow-neon-pink"
                  >
                    <Download className="w-4 h-4" /> EXPORTAR CSV ({filteredLeads.length})
                  </button>

                  <button
                    onClick={handleClearLeads}
                    disabled={leads.length === 0}
                    className="bg-black text-red-500 text-xs font-bold px-4 py-2.5 flex items-center gap-2 border border-red-500 hover:bg-red-500 hover:text-black transition-colors disabled:opacity-40 uppercase"
                  >
                    <Trash2 className="w-4 h-4" /> LIMPAR BASE
                  </button>

                  <button
                    onClick={fetchLeads}
                    className="bg-black text-neon-green text-xs font-bold px-4 py-2.5 flex items-center gap-2 border border-neon-green hover:bg-neon-green hover:text-black transition-colors uppercase"
                  >
                    <RefreshCw className="w-4 h-4" /> ATUALIZAR
                  </button>
                </div>
              </div>

              {/* CAMPOS DE FILTRAGEM */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                  <label className="block text-xs text-neon-green mb-1 uppercase tracking-wider">
                    BUSCA POR PALAVRA-CHAVE / CONTATO:
                  </label>
                  <div className="relative">
                    <input
                      type="text"
                      placeholder="Digite nome, telefone ou endereço..."
                      value={searchTerm}
                      onChange={(e) => setSearchTerm(e.target.value)}
                      className="w-full bg-black border border-neon-green p-2 text-xs text-neon-green placeholder-neon-muted focus:outline-none focus:border-neon-pink"
                    />
                    {searchTerm && (
                      <button
                        onClick={() => setSearchTerm('')}
                        className="absolute right-2 top-2 text-xs text-neon-pink hover:text-white"
                      >
                        ✕
                      </button>
                    )}
                  </div>
                </div>

                <div>
                  <label className="block text-xs text-neon-green mb-1 uppercase tracking-wider">
                    FILTRAR POR CATEGORIA:
                  </label>
                  <select
                    value={categoryFilter}
                    onChange={(e) => setCategoryFilter(e.target.value)}
                    className="w-full bg-black border border-neon-green p-2 text-xs text-neon-green focus:outline-none focus:border-neon-pink"
                  >
                    <option value="">-- TODAS AS CATEGORIAS --</option>
                    {uniqueCategories.map((cat, idx) => (
                      <option key={idx} value={cat}>{cat}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs text-neon-green mb-1 uppercase tracking-wider">
                    FILTRAR POR TERMO DE BUSCA ORIGINAL:
                  </label>
                  <select
                    value={locationFilter}
                    onChange={(e) => setLocationFilter(e.target.value)}
                    className="w-full bg-black border border-neon-green p-2 text-xs text-neon-green focus:outline-none focus:border-neon-pink"
                  >
                    <option value="">-- TODOS OS TERMOS DE BUSCA --</option>
                    {uniqueQueries.map((q, idx) => (
                      <option key={idx} value={q}>{q}</option>
                    ))}
                  </select>
                </div>
              </div>
            </div>

            {/* TABELA DEDICADA DE LEADS COM SCROLL VERTICAL */}
            <section className="border-2 border-neon-green p-5 bg-black border-glow-green">
              <div className="flex justify-between items-center mb-3">
                <span className="text-xs text-neon-muted">
                  EXIBINDO <strong className="text-neon-pink">{filteredLeads.length}</strong> DE <strong className="text-neon-green">{leads.length}</strong> LEADS
                </span>
                {(searchTerm || categoryFilter || locationFilter) && (
                  <button
                    onClick={() => { setSearchTerm(''); setCategoryFilter(''); setLocationFilter(''); }}
                    className="text-xs text-neon-pink underline hover:text-white"
                  >
                    LIMPAR FILTROS DE PESQUISA
                  </button>
                )}
              </div>

              <div className="max-h-[550px] overflow-y-auto border border-neon-border bg-black">
                <table className="w-full text-left text-xs border-collapse">
                  <thead className="sticky top-0 bg-neon-panel border-b border-neon-green text-neon-pink uppercase tracking-wider z-10">
                    <tr>
                      <th className="p-3 border-r border-neon-border">#ID</th>
                      <th className="p-3 border-r border-neon-border">NOME DA EMPRESA</th>
                      <th className="p-3 border-r border-neon-border">TELEFONE / WHATSAPP</th>
                      <th className="p-3 border-r border-neon-border">CATEGORIA</th>
                      <th className="p-3 border-r border-neon-border">ENDEREÇO</th>
                      <th className="p-3 border-r border-neon-border">BUSCA ORIGEM</th>
                      <th className="p-3">DATA CADASTRO</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredLeads.length === 0 ? (
                      <tr>
                        <td colSpan="7" className="p-12 text-center text-neon-muted italic">
                          Nenhum lead encontrado com os filtros selecionados.
                        </td>
                      </tr>
                    ) : (
                      filteredLeads.map((lead) => (
                        <tr key={lead.id} className="border-b border-neon-border hover:bg-neon-panel transition-colors">
                          <td className="p-3 border-r border-neon-border text-neon-muted">#{lead.id}</td>
                          <td className="p-3 border-r border-neon-border font-bold text-neon-green">
                            <a
                              href={lead.maps_url || `https://www.google.com.br/maps/search/${encodeURIComponent(lead.name + ' ' + (lead.address || ''))}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              title="Abrir no Google Maps"
                              className="inline-flex items-center gap-1.5 hover:text-neon-pink hover:underline text-glow-green transition-colors"
                            >
                              <span>{lead.name}</span>
                              <ExternalLink className="w-3.5 h-3.5 text-neon-pink flex-shrink-0" />
                            </a>
                          </td>
                          <td className="p-3 border-r border-neon-border text-neon-pink font-bold">
                            <div className="flex items-center gap-1">
                              <Phone className="w-3.5 h-3.5 text-neon-pink" />
                              {lead.phone}
                            </div>
                          </td>
                          <td className="p-3 border-r border-neon-border text-gray-300">
                            <div className="flex items-center gap-1">
                              <Tag className="w-3 h-3 text-neon-muted" />
                              {lead.category || 'N/A'}
                            </div>
                          </td>
                          <td className="p-3 border-r border-neon-border text-gray-400 max-w-xs truncate">
                            <div className="flex items-center gap-1">
                              <MapPin className="w-3 h-3 text-neon-muted flex-shrink-0" />
                              <span className="truncate">{lead.address || 'N/A'}</span>
                            </div>
                          </td>
                          <td className="p-3 border-r border-neon-border text-gray-400 italic text-[11px]">
                            {lead.query || 'N/A'}
                          </td>
                          <td className="p-3 text-neon-muted text-[10px]">
                            {formatDateTime(lead.created_at)}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          </div>
        )}

        {/* ============================================================ */}
        {/* ABA 3: GESTÃO DE CONTATOS (PIPELINE) */}
        {/* ============================================================ */}
        {activeTab === 'pipeline' && (
          <div className="space-y-6">

            {/* BARRA DE CONTADORES POR STATUS */}
            <div className="border-2 border-neon-cyan p-4 bg-neon-panel border-glow-cyan">
              <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-3 mb-4 border-b border-neon-border pb-3">
                <div>
                  <h2 className="text-2xl font-bold text-neon-cyan text-glow-cyan flex items-center gap-2 uppercase">
                    <Users className="w-6 h-6 text-neon-green" /> PIPELINE DE CONTATOS
                  </h2>
                  <p className="text-xs text-neon-muted">FUNIL DE PROSPECÇÃO — GERENCIE O STATUS DE CADA LEAD CAPTURADO</p>
                </div>

                <div className="flex flex-wrap gap-3">
                  <button
                    onClick={handleDownloadCSV}
                    disabled={leads.length === 0}
                    className="bg-neon-cyan text-black text-xs font-bold px-4 py-2.5 flex items-center gap-2 hover:bg-white hover:text-black transition-colors disabled:opacity-40 uppercase border border-neon-cyan shadow-neon-cyan"
                  >
                    <Download className="w-4 h-4" /> EXPORTAR CSV
                  </button>

                  <button
                    onClick={fetchPipelineLeads}
                    className="bg-black text-neon-cyan text-xs font-bold px-4 py-2.5 flex items-center gap-2 border border-neon-cyan hover:bg-neon-cyan hover:text-black transition-colors uppercase"
                  >
                    <RefreshCw className="w-4 h-4" /> ATUALIZAR
                  </button>
                </div>
              </div>

              {/* CONTADORES DE STATUS */}
              <div className="flex flex-wrap gap-2 mb-4">
                {STATUS_OPTIONS.map((s) => {
                  const count = statusCounts[s] || 0;
                  const color = STATUS_COLORS[s];
                  const isActive = pipelineStatusFilter === s;
                  return (
                    <button
                      key={s}
                      onClick={() => setPipelineStatusFilter(isActive ? '' : s)}
                      className={`flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider border transition-all ${
                        isActive 
                          ? 'border-white scale-105' 
                          : 'border-transparent hover:border-gray-600'
                      }`}
                      style={{ 
                        backgroundColor: isActive ? color.bg : 'rgba(0,0,0,0.6)',
                        color: isActive ? color.text : color.bg,
                        boxShadow: isActive ? `0 0 10px ${color.glow}` : 'none',
                      }}
                    >
                      <span className="text-base font-bold">{count}</span>
                      <span>{s}</span>
                    </button>
                  );
                })}
              </div>

              {/* FILTROS DO PIPELINE */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                  <label className="block text-xs text-neon-cyan mb-1 uppercase tracking-wider">
                    BUSCAR POR NOME / TELEFONE:
                  </label>
                  <div className="relative">
                    <input
                      type="text"
                      placeholder="Digite para buscar..."
                      value={pipelineSearchTerm}
                      onChange={(e) => setPipelineSearchTerm(e.target.value)}
                      className="w-full bg-black border border-neon-cyan p-2 text-xs text-neon-cyan placeholder-neon-muted focus:outline-none focus:border-neon-pink"
                    />
                    {pipelineSearchTerm && (
                      <button
                        onClick={() => setPipelineSearchTerm('')}
                        className="absolute right-2 top-2 text-xs text-neon-pink hover:text-white"
                      >
                        ✕
                      </button>
                    )}
                  </div>
                </div>

                <div>
                  <label className="block text-xs text-neon-cyan mb-1 uppercase tracking-wider">
                    FILTRAR POR CATEGORIA:
                  </label>
                  <select
                    value={pipelineCategoryFilter}
                    onChange={(e) => setPipelineCategoryFilter(e.target.value)}
                    className="w-full bg-black border border-neon-cyan p-2 text-xs text-neon-cyan focus:outline-none focus:border-neon-pink"
                  >
                    <option value="">-- TODAS AS CATEGORIAS --</option>
                    {pipelineUniqueCategories.map((cat, idx) => (
                      <option key={idx} value={cat}>{cat}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs text-neon-cyan mb-1 uppercase tracking-wider">
                    FILTRAR POR TERMO DE BUSCA:
                  </label>
                  <select
                    value={pipelineQueryFilter}
                    onChange={(e) => setPipelineQueryFilter(e.target.value)}
                    className="w-full bg-black border border-neon-cyan p-2 text-xs text-neon-cyan focus:outline-none focus:border-neon-pink"
                  >
                    <option value="">-- TODOS OS TERMOS --</option>
                    {pipelineUniqueQueries.map((q, idx) => (
                      <option key={idx} value={q}>{q}</option>
                    ))}
                  </select>
                </div>
              </div>
            </div>

            {/* TABELA DO PIPELINE */}
            <section className="border-2 border-neon-cyan p-5 bg-black border-glow-cyan">
              <div className="flex justify-between items-center mb-3">
                <span className="text-xs text-neon-muted">
                  EXIBINDO <strong className="text-neon-cyan">{pipelineLeads.length}</strong> LEADS NO PIPELINE
                  {pipelineStatusFilter && (
                    <span className="ml-2 text-neon-pink">
                      (filtro: <strong>{pipelineStatusFilter}</strong>)
                    </span>
                  )}
                </span>
                {(pipelineStatusFilter || pipelineCategoryFilter || pipelineQueryFilter || pipelineSearchTerm) && (
                  <button
                    onClick={() => { 
                      setPipelineStatusFilter(''); 
                      setPipelineCategoryFilter(''); 
                      setPipelineQueryFilter('');
                      setPipelineSearchTerm('');
                    }}
                    className="text-xs text-neon-pink underline hover:text-white"
                  >
                    LIMPAR TODOS OS FILTROS
                  </button>
                )}
              </div>

              <div className="max-h-[600px] overflow-y-auto border border-neon-border bg-black">
                <table className="w-full text-left text-xs border-collapse">
                  <thead className="sticky top-0 bg-neon-panel border-b border-neon-cyan text-neon-cyan uppercase tracking-wider z-10">
                    <tr>
                      <th className="p-3 border-r border-neon-border">NOME</th>
                      <th className="p-3 border-r border-neon-border">TELEFONE</th>
                      <th className="p-3 border-r border-neon-border min-w-[160px]">STATUS</th>
                      <th className="p-3 border-r border-neon-border">ÚLT. CONTATO</th>
                      <th className="p-3 border-r border-neon-border min-w-[200px]">OBSERVAÇÕES</th>
                      <th className="p-3 border-r border-neon-border">CATEGORIA</th>
                      <th className="p-3 min-w-[100px]">AÇÕES</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pipelineLeads.length === 0 ? (
                      <tr>
                        <td colSpan="7" className="p-12 text-center text-neon-muted italic">
                          {leads.length === 0 
                            ? 'Nenhum lead no banco. Execute o scraper para capturar leads.' 
                            : 'Nenhum lead encontrado com os filtros selecionados.'}
                        </td>
                      </tr>
                    ) : (
                      pipelineLeads.map((lead) => (
                        <tr key={lead.id} className="border-b border-neon-border hover:bg-neon-panel transition-colors group">
                          {/* NOME */}
                          <td className="p-3 border-r border-neon-border font-bold text-neon-green">
                            <div className="flex items-center gap-1.5">
                              <span className="truncate max-w-[180px]" title={lead.name}>{lead.name}</span>
                            </div>
                          </td>

                          {/* TELEFONE */}
                          <td className="p-3 border-r border-neon-border text-neon-pink font-bold whitespace-nowrap">
                            <div className="flex items-center gap-1">
                              <Phone className="w-3.5 h-3.5 text-neon-pink flex-shrink-0" />
                              {lead.phone}
                            </div>
                          </td>

                          {/* STATUS (DROPDOWN INLINE) */}
                          <td className="p-3 border-r border-neon-border">
                            <div className="flex flex-col gap-1">
                              <StatusBadge status={lead.status} />
                              <select
                                value={lead.status || 'A contatar'}
                                onChange={(e) => handleStatusChange(lead.id, e.target.value)}
                                className="bg-black border border-neon-border p-1 text-[10px] text-neon-cyan focus:outline-none focus:border-neon-cyan cursor-pointer hover:border-neon-cyan transition-colors"
                              >
                                {STATUS_OPTIONS.map((s) => (
                                  <option key={s} value={s}>{s}</option>
                                ))}
                              </select>
                            </div>
                          </td>

                          {/* DATA DO ÚLTIMO CONTATO */}
                          <td className="p-3 border-r border-neon-border text-neon-muted text-[10px] whitespace-nowrap">
                            {formatDateTime(lead.last_contact_at)}
                          </td>

                          {/* OBSERVAÇÕES (EDITÁVEL INLINE) */}
                          <td className="p-3 border-r border-neon-border">
                            {editingNotesId === lead.id ? (
                              <div className="flex items-center gap-1">
                                <input
                                  ref={notesInputRef}
                                  type="text"
                                  value={editingNotesValue}
                                  onChange={(e) => setEditingNotesValue(e.target.value)}
                                  onBlur={() => handleNotesSave(lead.id)}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') handleNotesSave(lead.id);
                                    if (e.key === 'Escape') { setEditingNotesId(null); setEditingNotesValue(''); }
                                  }}
                                  className="w-full bg-black border border-neon-cyan p-1 text-[11px] text-neon-cyan focus:outline-none"
                                  placeholder="Adicionar observação..."
                                />
                              </div>
                            ) : (
                              <div 
                                className="flex items-center gap-1 cursor-pointer group/notes hover:text-neon-cyan transition-colors min-h-[20px]"
                                onClick={() => { setEditingNotesId(lead.id); setEditingNotesValue(lead.notes || ''); }}
                                title="Clique para editar"
                              >
                                <span className="text-[11px] text-gray-400 truncate max-w-[180px]">
                                  {lead.notes || '—'}
                                </span>
                                <Edit3 className="w-3 h-3 text-neon-muted opacity-0 group-hover/notes:opacity-100 transition-opacity flex-shrink-0" />
                              </div>
                            )}
                          </td>

                          {/* CATEGORIA */}
                          <td className="p-3 border-r border-neon-border text-gray-400 text-[11px]">
                            {lead.category || 'N/A'}
                          </td>

                          {/* AÇÕES */}
                          <td className="p-3">
                            <div className="flex items-center gap-2">
                              {/* WhatsApp */}
                              {lead.wa_ok === false ? (
                                <span
                                  className="flex items-center justify-center h-7 px-1.5 border border-gray-700 text-gray-500 text-[9px] font-bold cursor-not-allowed"
                                  title="Telefone fixo — provavelmente sem WhatsApp. Ligue ou procure o celular no Maps."
                                >
                                  FIXO
                                </span>
                              ) : (
                                <button
                                  onClick={() => handleWhatsAppClick(lead)}
                                  className={`flex items-center justify-center w-7 h-7 border transition-colors ${
                                    lead.icp_ok === false
                                      ? 'border-yellow-600 text-yellow-600 hover:bg-yellow-600 hover:text-black'
                                      : 'border-green-500 text-green-500 hover:bg-green-500 hover:text-black'
                                  }`}
                                  title={lead.icp_ok === false
                                    ? 'Fora do nicho odonto — abre o WhatsApp sem mensagem pronta'
                                    : 'Abrir WhatsApp com a mensagem pronta'}
                                >
                                  <MessageCircle className="w-3.5 h-3.5" />
                                </button>
                              )}

                              {/* Google Maps */}
                              <a
                                href={lead.maps_url || `https://www.google.com.br/maps/search/${encodeURIComponent(lead.name + ' ' + (lead.address || ''))}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="flex items-center justify-center w-7 h-7 border border-neon-pink text-neon-pink hover:bg-neon-pink hover:text-black transition-colors"
                                title="Abrir no Google Maps"
                              >
                                <MapPin className="w-3.5 h-3.5" />
                              </a>
                            </div>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          </div>
        )}

        {/* ============================================================ */}
        {/* ABA 4: DISPARO (FILA COM PACING) */}
        {/* ============================================================ */}
        {activeTab === 'disparo' && (
          <div className="space-y-6">

            {/* HUD DE PACING — JANELA, CAP DO DIA, PRÓXIMO ENVIO */}
            <div className="border-2 border-neon-amber p-4 bg-neon-panel border-glow-amber">
              <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-3 mb-4 border-b border-neon-border pb-3">
                <div>
                  <h2 className="text-2xl font-bold text-neon-amber text-glow-amber flex items-center gap-2 uppercase">
                    <Rocket className="w-6 h-6" /> DISPARO — FILA COM PACING
                  </h2>
                  <p className="text-xs text-neon-muted">
                    MONTA A FILA E ABRE O WHATSAPP COM A MENSAGEM PRONTA — QUEM MANDA É VOCÊ, SEMPRE.
                  </p>
                </div>

                <div className="flex flex-wrap gap-3 text-[11px]">
                  <div className="flex items-center gap-1.5 border border-neon-border px-3 py-2 bg-black">
                    <Clock className="w-4 h-4 text-neon-amber flex-shrink-0" />
                    <span className="text-gray-300 font-bold">HOJE:</span>
                    <span className="text-neon-amber font-bold">
                      {disparoStatus ? disparoStatus.enviadosHoje : '—'} / {disparoStatus ? disparoStatus.cap : 30}
                    </span>
                  </div>
                  <div className={`flex items-center gap-1.5 border px-3 py-2 bg-black ${
                    disparoStatus && !disparoStatus.dentroDaJanela ? 'border-red-500' : 'border-neon-green'
                  }`}>
                    {disparoStatus && disparoStatus.dentroDaJanela ? (
                      <CheckCircle className="w-4 h-4 text-neon-green flex-shrink-0" />
                    ) : (
                      <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0" />
                    )}
                    <span className="text-gray-300 font-bold">JANELA:</span>
                    <span className={disparoStatus && disparoStatus.dentroDaJanela ? 'text-neon-green font-bold' : 'text-red-500 font-bold'}>
                      {disparoStatus
                        ? (disparoStatus.dentroDaJanela ? 'ABERTA (09-11:30 / 14-17:40)' : (disparoStatus.motivoForaDaJanela || 'FECHADA').toUpperCase())
                        : '—'}
                    </span>
                  </div>
                </div>
              </div>

              {/* CONTROLES DE MONTAGEM DA FILA */}
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4 items-end">
                <div>
                  <label className="block text-xs text-neon-amber mb-1 uppercase tracking-wider">CAP DA FILA:</label>
                  <input
                    type="number"
                    min={1}
                    max={60}
                    value={disparoCap}
                    onChange={(e) => setDisparoCap(e.target.value)}
                    className="w-full bg-black border border-neon-amber p-2 text-xs text-neon-amber focus:outline-none focus:border-neon-pink"
                  />
                </div>
                <div>
                  <label className="block text-xs text-neon-amber mb-1 uppercase tracking-wider">FILTRAR POR CIDADE:</label>
                  <input
                    type="text"
                    placeholder="Ex: Caxias do Sul (opcional)"
                    value={disparoCidadeFiltro}
                    onChange={(e) => setDisparoCidadeFiltro(e.target.value)}
                    className="w-full bg-black border border-neon-amber p-2 text-xs text-neon-amber placeholder-neon-muted focus:outline-none focus:border-neon-pink"
                  />
                </div>
                <div className="md:col-span-2">
                  <button
                    onClick={fetchDisparoFila}
                    disabled={disparoLoading}
                    className="w-full bg-neon-amber text-black font-bold py-2.5 px-4 flex items-center justify-center gap-2 hover:bg-neon-pink hover:text-black transition-colors uppercase border border-neon-amber shadow-neon-amber disabled:opacity-50"
                  >
                    <RefreshCw className={`w-4 h-4 ${disparoLoading ? 'animate-spin' : ''}`} />
                    {disparoLoading ? 'MONTANDO...' : 'MONTAR FILA DO DIA'}
                  </button>
                </div>
              </div>

              {/* DESCARTES DA QUALIFICAÇÃO */}
              {Object.values(disparoDescartes).some((v) => v > 0) && (
                <div className="flex flex-wrap gap-2 mt-4 text-[10px]">
                  <span className="text-neon-muted uppercase">DESCARTADOS NA QUALIFICAÇÃO:</span>
                  {disparoDescartes.categoria > 0 && <span className="border border-neon-border px-2 py-0.5 text-gray-400">categoria {disparoDescartes.categoria}</span>}
                  {disparoDescartes.sem_celular > 0 && <span className="border border-neon-border px-2 py-0.5 text-gray-400">sem celular {disparoDescartes.sem_celular}</span>}
                  {disparoDescartes.telefone_repetido > 0 && <span className="border border-neon-border px-2 py-0.5 text-gray-400">telefone repetido {disparoDescartes.telefone_repetido}</span>}
                  {disparoDescartes.cidade > 0 && <span className="border border-neon-border px-2 py-0.5 text-gray-400">fora do filtro de cidade {disparoDescartes.cidade}</span>}
                </div>
              )}
            </div>

            {filaDisparo.length === 0 ? (
              <div className="border-2 border-neon-border p-8 bg-black text-center text-neon-muted italic">
                Nenhuma fila montada ainda. Ajuste o cap/cidade e clique em "MONTAR FILA DO DIA".
              </div>
            ) : !disparoItemAtual ? (
              <div className="border-2 border-neon-green p-8 bg-black text-center border-glow-green">
                <CheckCircle className="w-10 h-10 text-neon-green mx-auto mb-2" />
                <p className="text-neon-green font-bold uppercase text-glow-green">Fila desta sessão concluída.</p>
                <p className="text-xs text-neon-muted mt-1">Monte a fila de novo pra ver o que ainda sobrou (leads pulados continuam "A contatar").</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
                {/* CARD DO LEAD ATUAL */}
                <div className="lg:col-span-5 border-2 border-neon-amber p-5 bg-neon-panel border-glow-amber flex flex-col justify-between">
                  <div>
                    <div className="flex justify-between items-center border-b border-neon-border pb-2 mb-3">
                      <h3 className="text-sm font-bold text-neon-amber uppercase tracking-wider">
                        LEAD {disparoIndex + 1} / {filaDisparo.length}
                      </h3>
                      <span className="text-[10px] text-neon-muted">FILA "{disparoRotulo}"</span>
                    </div>

                    <p className="text-lg font-bold text-neon-green text-glow-green">{disparoItemAtual.clinica}</p>
                    <p className="text-xs text-gray-400 flex items-center gap-1 mt-1">
                      <MapPin className="w-3.5 h-3.5 text-neon-muted" /> {disparoItemAtual.cidade || 'N/A'}
                    </p>
                    <p className="text-sm text-neon-pink font-bold flex items-center gap-1 mt-1">
                      <Phone className="w-3.5 h-3.5" /> {disparoItemAtual.telFmt}
                    </p>
                    <p className="text-xs text-gray-300 mt-2">
                      ABRE COM: <span className="text-neon-cyan font-bold">{disparoItemAtual.abertura}</span>
                    </p>

                    {disparoItemAtual.alerta && (
                      <p className="text-[11px] text-yellow-400 flex items-center gap-1.5 mt-2 border border-yellow-600 px-2 py-1">
                        <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" /> {disparoItemAtual.alerta}
                      </p>
                    )}

                    <div className="mt-3 p-3 border border-neon-border bg-black text-xs text-gray-300 whitespace-pre-wrap leading-relaxed">
                      {disparoItemAtual.msg}
                    </div>
                  </div>

                  <div className="mt-4 space-y-2">
                    {(disparoForaDaJanela || disparoCapAtingido) && (
                      <label className="flex items-center gap-2 text-[11px] text-yellow-400">
                        <input type="checkbox" checked={ignorarJanela} onChange={(e) => setIgnorarJanela(e.target.checked)} />
                        Abrir mesmo assim (fora da janela/cap recomendado — só em caso pontual)
                      </label>
                    )}

                    {emPacing && !ignorarJanela && (
                      <div className="flex items-center justify-between border border-neon-border px-3 py-2 bg-black text-xs">
                        <span className="text-gray-300 flex items-center gap-1.5">
                          <Clock className="w-4 h-4 text-neon-amber animate-pulse" /> {pacingLabel}, próximo em <strong className="text-neon-amber">{formatMMSS(pacingRemainingSec)}</strong>
                        </span>
                        <button onClick={() => setPacingUntil(null)} className="text-neon-pink underline hover:text-white">
                          pular espera
                        </button>
                      </div>
                    )}

                    <div className="flex flex-col sm:flex-row gap-2">
                      <button
                        onClick={() => window.open(googleLinkDisparo(disparoItemAtual.clinica, disparoItemAtual.cidade), '_blank')}
                        className="flex-1 bg-black text-neon-cyan border border-neon-cyan font-bold py-2.5 px-3 flex items-center justify-center gap-2 hover:bg-neon-cyan hover:text-black transition-colors uppercase text-xs"
                      >
                        <Search className="w-4 h-4" /> CONFERIR NO GOOGLE
                      </button>
                      <button
                        onClick={() => handleAbrirWhatsAppDisparo(disparoItemAtual)}
                        disabled={disparoBloqueado}
                        className="flex-1 bg-neon-green text-black font-bold py-2.5 px-3 flex items-center justify-center gap-2 hover:bg-neon-pink transition-colors uppercase text-xs border border-neon-green shadow-neon-green disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        <Send className="w-4 h-4" /> ABRIR NO WHATSAPP
                      </button>
                    </div>

                    {waAberto && (
                      <div className="border border-neon-border p-3 bg-black space-y-2">
                        <p className="text-[11px] text-gray-300 flex items-center gap-1.5">
                          <ShieldAlert className="w-3.5 h-3.5 text-yellow-400 flex-shrink-0" /> Confira o texto na caixa ANTES do Enter. Enviou de verdade?
                        </p>
                        <div className="flex flex-col sm:flex-row gap-2">
                          <button
                            onClick={() => marcarDesfecho('enviado')}
                            className="flex-1 bg-neon-green text-black font-bold py-2 px-3 flex items-center justify-center gap-1.5 hover:bg-white transition-colors uppercase text-[11px] border border-neon-green"
                          >
                            <CheckCircle className="w-3.5 h-3.5" /> ENVIEI — MARCAR CONTATADO
                          </button>
                          <button
                            onClick={() => marcarDesfecho('falhou')}
                            className="flex-1 bg-black text-red-500 font-bold py-2 px-3 flex items-center justify-center gap-1.5 border border-red-500 hover:bg-red-500 hover:text-black transition-colors uppercase text-[11px]"
                          >
                            <X className="w-3.5 h-3.5" /> NÃO ENVIEI (FALHOU)
                          </button>
                        </div>
                      </div>
                    )}

                    <button
                      onClick={() => marcarDesfecho('pulado')}
                      className="w-full bg-black text-gray-400 font-bold py-2 px-3 flex items-center justify-center gap-1.5 border border-gray-600 hover:border-white hover:text-white transition-colors uppercase text-[11px]"
                    >
                      <SkipForward className="w-3.5 h-3.5" /> PULAR (MANTÉM "A CONTATAR")
                    </button>
                  </div>
                </div>

                {/* TABELA DA FILA */}
                <div className="lg:col-span-7 border-2 border-neon-border bg-black p-4">
                  <h3 className="text-sm font-bold text-neon-amber uppercase tracking-wider mb-3 flex items-center gap-2">
                    <Database className="w-4 h-4" /> FILA DESTA SESSÃO
                  </h3>
                  <div className="max-h-[500px] overflow-y-auto border border-neon-border">
                    <table className="w-full text-left text-[11px] border-collapse">
                      <thead className="sticky top-0 bg-neon-panel border-b border-neon-amber text-neon-amber uppercase tracking-wider z-10">
                        <tr>
                          <th className="p-2 border-r border-neon-border">#</th>
                          <th className="p-2 border-r border-neon-border">CLÍNICA</th>
                          <th className="p-2 border-r border-neon-border">CIDADE</th>
                          <th className="p-2 border-r border-neon-border">TELEFONE</th>
                          <th className="p-2">RESULTADO</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filaDisparo.map((item, idx) => {
                          const resultado = resultadosSessao[item.id];
                          const ehAtual = idx === disparoIndex;
                          return (
                            <tr
                              key={item.id}
                              className={`border-b border-neon-border transition-colors ${
                                ehAtual ? 'bg-neon-panel' : resultado ? 'opacity-40' : ''
                              }`}
                            >
                              <td className="p-2 border-r border-neon-border text-neon-muted">{idx + 1}</td>
                              <td className={`p-2 border-r border-neon-border font-bold ${ehAtual ? 'text-neon-amber' : 'text-neon-green'}`}>
                                {item.clinica}
                              </td>
                              <td className="p-2 border-r border-neon-border text-gray-400">{item.cidade}</td>
                              <td className="p-2 border-r border-neon-border text-neon-pink">{item.telFmt}</td>
                              <td className="p-2">
                                {resultado === 'enviado' && <span className="text-neon-green font-bold">✓ ENVIADO</span>}
                                {resultado === 'pulado' && <span className="text-gray-500">⏭ PULADO</span>}
                                {resultado === 'falhou' && <span className="text-red-500">✕ FALHOU</span>}
                                {!resultado && ehAtual && <span className="text-neon-amber font-bold animate-pulse">● ATUAL</span>}
                                {!resultado && !ehAtual && <span className="text-neon-muted">pendente</span>}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* MODAL DE CONFIRMAÇÃO WHATSAPP */}
      {whatsAppModal && (
        <div className="neon-modal-backdrop" onClick={() => setWhatsAppModal(null)}>
          <div className="neon-modal-panel font-mono" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4 border-b border-neon-border pb-3">
              <h3 className="text-sm font-bold text-neon-cyan text-glow-cyan uppercase flex items-center gap-2">
                <MessageCircle className="w-5 h-5 text-green-400" /> ABRIR WHATSAPP
              </h3>
              <button 
                onClick={() => setWhatsAppModal(null)} 
                className="text-neon-muted hover:text-white transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-3 mb-6">
              <p className="text-xs text-gray-300">
                Você está prestes a abrir o WhatsApp para:
              </p>
              <div className="border border-neon-border p-3 bg-black">
                <p className="text-neon-green font-bold text-sm">{whatsAppModal.leadName}</p>
                <p className="text-neon-pink text-xs flex items-center gap-1 mt-1">
                  <Phone className="w-3 h-3" /> {whatsAppModal.phone}
                </p>
              </div>
              {whatsAppModal.msg ? (
                <div className="border border-neon-border p-3 bg-black">
                  <p className="text-[10px] text-neon-muted uppercase mb-1">Mensagem pronta</p>
                  <p className="text-xs text-gray-300 whitespace-pre-wrap">{whatsAppModal.msg}</p>
                </div>
              ) : (
                <p className="text-xs text-neon-muted">Sem mensagem pronta — lead fora do nicho odonto, o WhatsApp abre vazio.</p>
              )}
              <p className="text-xs text-yellow-400 flex items-center gap-1.5">
                <AlertCircle className="w-4 h-4 flex-shrink-0" />
                Este lead ainda está como <strong>"A contatar"</strong>. Deseja marcá-lo automaticamente como <strong>"Contatado"</strong>?
              </p>
            </div>

            <div className="flex flex-col sm:flex-row gap-3">
              <button
                onClick={() => handleWhatsAppConfirm(true)}
                className="flex-1 bg-neon-cyan text-black font-bold py-2.5 px-4 text-xs flex items-center justify-center gap-2 hover:bg-white transition-colors uppercase border border-neon-cyan"
              >
                <CheckCircle className="w-4 h-4" /> ABRIR & MARCAR CONTATADO
              </button>
              <button
                onClick={() => handleWhatsAppConfirm(false)}
                className="flex-1 bg-black text-gray-400 font-bold py-2.5 px-4 text-xs flex items-center justify-center gap-2 border border-gray-600 hover:border-white hover:text-white transition-colors uppercase"
              >
                <ExternalLink className="w-4 h-4" /> ABRIR SEM ALTERAR
              </button>
            </div>
          </div>
        </div>
      )}

      {/* FOOTER RETRO PERSONALIZADO */}
      <footer className="mt-8 pt-4 border-t-2 border-neon-green text-center text-xs flex flex-col sm:flex-row justify-between items-center gap-2 bg-neon-panel p-3">
        <div className="text-neon-muted uppercase">
          NEONSCRAPER ENGINE // AUTOMATIZAÇÃO LOCAL B2B PRIVADA
        </div>
        <div className="text-neon-pink font-bold tracking-widest uppercase text-glow-pink">
          UMA INICIATIVA OCTO - INVOCADO POR P.O.L.V.O.L.O.X
        </div>
      </footer>
    </div>
  );
}
