/**
 * disparo-logic.js
 *
 * Porta pra Node das funções PURAS de disparo.py (sem tocar banco/arquivo) —
 * qualificação, normalização de telefone, geração de nome/abertura/mensagem,
 * links de wa.me e Google, e a janela de pacing. Mantido separado de
 * database.js de propósito: é o mesmo contrato que disparo.py já usa há
 * dias em produção, só que em JS pro server.js/App.jsx consumirem.
 *
 * Qualquer mudança de regra (categoria ICP, texto da mensagem, janela de
 * horário) precisa ser espelhada aqui E em disparo.py, senão os dois
 * caminhos divergem silenciosamente.
 */

// ─── qualificação ───────────────────────────────────────────────────────
const ODO = new Set([
  'Clínica odontológica', 'Dentista', 'Cirurgião dentista', 'Odontopediatra',
  'Endodontista', 'Ortodontista', 'Implantodontista', 'Periodontista',
  'Clínica de odontologia', 'Odontologista',
]);
// B2B / fora do ICP, de propósito fora do ODO: Radiologia odontológica e
// Laboratório de odontologia atendem dentista, não paciente.
const DDD_ESPERADO = new Set(['51', '54']); // RS

// ─── overrides manuais (herdados de disparo.py, id por id) ─────────────
const ABERTURA_MANUAL = {};  // id do lead -> 'Dr./Dra. Nome' (preenchido a mao, local)
const CIDADE_MANUAL = {}  // id do lead -> cidade (override manual);
const PESO_CIDADE = {
  'Canela': 0, 'Gramado': 1, 'Três Coroas': 2, 'Igrejinha': 3, 'Taquara': 4,
  'Nova Petrópolis': 5, 'Bento Gonçalves': 6, 'Caxias do Sul': 6, 'Porto Alegre': 9,
};

const RESPOSTA_PADRAO = 'https://www.octopaginas.com.br/odontologia — dois layouts prontos ' +
  'pra clínica odontológica. A página de vocês sai com o conteúdo, as ' +
  'fotos e os serviços da clínica. Se quiser, mando os valores.';

// ─── pacing (mesma estimativa conservadora do disparo.py) ──────────────
const CAP_DIARIO = 30;
const JANELAS = [['09:00', '11:30'], ['14:00', '17:40']];
const INTERVALO = [240, 540];       // 4 a 9 min, em segundos
const PAUSA_A_CADA = 8;
const PAUSA_LONGA = [900, 1500];    // 15 a 25 min, em segundos
const BLOQUEIA_DOM = true;

// ─── helpers de texto ────────────────────────────────────────────────────
function semAcento(s) {
  return (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function norm(p) {
  let d = (p || '').replace(/\D/g, '');
  if (d.startsWith('55') && d.length > 11) d = d.slice(2);
  if (d.startsWith('0')) d = d.slice(1);
  return d;
}

function isCel(d) { return d.length === 11 && d[2] === '9'; }
function fmt(d) { return `+55 ${d.slice(0, 2)} ${d.slice(2, 7)}-${d.slice(7)}`; }

function escapeRegExp(s) {
  return (s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Nome do Maps vem cheio de cauda de SEO, pior em cidade grande:
 * "Martinato Odontologia (Dentista - Caxias do Sul)",
 * "Dra. Maria Souza | Odontologia Avançada",
 * "Ana Pereira - Cirurgiã Dentista | Caxias do Sul".
 */
function limpaNome(nome, cidade) {
  let n = (nome || '').split('|')[0].trim();
  n = n.replace(/\s*\([^)]*\)/g, '');
  n = n.replace(/\s+em\s+[A-Z][^,]*?(\s+RS)?$/, '');
  n = n.split('/')[0].trim(); // "Camila Rosa Cirurgiã-Dentista/ Harmonização Facial"
  n = n.replace(/\s*[-–—]\s*(Cirurgi[ãa]o?([\s-]+Dentista)?|Dentista|Odontologia)\s*$/i, '');
  n = n.replace(/\s+Cirurgi[ãa]o?[\s-]+Dentista\s*$/i, ''); // "Daniela Zwirtes Cirurgiã Dentista"
  if (cidade) {
    n = n.replace(new RegExp('\\s*[-–—,]\\s*' + escapeRegExp(cidade) + '\\s*$', 'i'), '');
  }
  // cauda que sobra depois dos cortes acima, em loop ate estabilizar:
  // "Camila Rosa Cirurgia" (o /Harmonizacao levou o "Dentista" junto),
  // "Dra Tainara da Rocha - Dentista Gramado" (titulo + cidade no fim).
  for (let i = 0; i < 3; i++) {
    const antes = n;
    n = n.replace(/\s*[-–—,]?\s*Cirurgi[ãa]o?\s*$/i, '');
    if (cidade) {
      n = n.replace(
        new RegExp('\\s*[-–—,]?\\s*(Dentista|Odontologia)\\s+' + escapeRegExp(cidade) + '\\s*$', 'i'),
        ''
      );
    }
    n = n.replace(/\s*[-–—,]\s*Dentista\s*$/i, '');
    n = n.replace(/^[-–—\s]+|[-–—\s]+$/g, '');
    if (n === antes) break;
  }
  return n.replace(/\s{2,}/g, ' ').trim().replace(/^[-–—\s]+|[-–—\s]+$/g, '');
}

function cidadeDe(row) {
  if (CIDADE_MANUAL[row.id]) return CIDADE_MANUAL[row.id];
  const q = (row.query || '') + ' ,';
  const m = q.match(/\bem\s+([A-ZÁÂÃÉÊÍÓÔÕÚÇ][\wÁ-ú\s]+?)\s*[-,]/);
  if (m) return m[1].trim();
  const partes = (row.address || '').split(',').map((p) => p.trim()).filter(Boolean);
  return partes.length >= 2 ? partes[partes.length - 2] : '';
}

/**
 * Detecta "Dr./Dra. Fulano" no nome do estabelecimento. Devolve null
 * quando não tem certeza — na dúvida quem chama monta_fila() abre com o
 * nome da clínica.
 */
function sugereAbertura(clinica) {
  const bruto = clinica || '';
  // "Dr. Fulano", "Dra.Danieli" (sem espaço), "Doutor Carlos"
  let m = bruto.match(/\b(Dra?\.\s*|Dra?\s+|Doutora?\s+)([A-ZÁÉÍÓÚÂÊÔÃÕÇ][\wÁ-ú]+)/);
  if (m) {
    const t = semAcento(m[1]);
    const titulo = (t.startsWith('dra') || t.startsWith('doutora')) ? 'Dra.' : 'Dr.';
    return `${titulo} ${m[2]}`;
  }
  // "Ana Pereira - Cirurgiã Dentista", "Camila Rosa Cirurgiã-Dentista/ ...",
  // "Ana Laura N. Bonalume | Cirurgiã-dentista": o gênero vem do próprio título
  m = bruto.match(/cirurgi(ã|ão)/i);
  const primeiro = bruto.match(/^([A-ZÁÉÍÓÚÂÊÔÃÕÇ][a-zà-ÿ]{2,})\s/);
  if (m && primeiro && !ehPalavraDeNegocio(primeiro[1])) {
    return `${m[1].toLowerCase() === 'ã' ? 'Dra.' : 'Dr.'} ${primeiro[1]}`;
  }
  // Nome de pessoa sem título ("Márcio A Costanzi", "Grando, Kelen"): não dá
  // pra saber Dr. ou Dra., então abre só com o primeiro nome.
  const pessoa = primeiroNomeDePessoa(bruto);
  if (pessoa) return pessoa;
  return null;
}

// Radicais que denunciam nome de estabelecimento, não de pessoa
const RADICAIS_NEGOCIO = [
  'odont', 'clinic', 'consult', 'centro', 'instit', 'sorri', 'dent', 'oral',
  'implant', 'orto', 'ortho', 'estet', 'saude', 'espaco', 'cooper', 'studio',
  'ltda', 'integr', 'especial', 'compan', 'excel', 'digital', 'harmon',
  'prefeit', 'radio', 'estac', 'grupo', 'bucal', 'smile', 'quiro', 'psico',
  'fisio', 'cirurgi', 'endo', 'perio', 'protes',
];
const PALAVRAS_NEGOCIO = new Set(['vida', 'bem', 'art', 'bio', 'eco', 'inova', 'nova', 'oi', 'uno', 'top']);

function ehPalavraDeNegocio(palavra) {
  const p = semAcento(palavra).replace(/[^a-z]/g, '');
  return PALAVRAS_NEGOCIO.has(p) || RADICAIS_NEGOCIO.some((r) => p.startsWith(r));
}

const CONECTORES = new Set(['da', 'de', 'do', 'das', 'dos']);

function primeiroNomeDePessoa(nome) {
  let n = (nome || '').trim();
  // "Sobrenome, Nome" (formato de cadastro antigo do Maps)
  const inv = n.match(/^([A-ZÁÉÍÓÚÂÊÔÃÕÇ][a-zà-ÿ]+),\s*([A-ZÁÉÍÓÚÂÊÔÃÕÇ][a-zà-ÿ]+)$/);
  if (inv) n = `${inv[2]} ${inv[1]}`;
  const tokens = n.split(/\s+/);
  if (tokens.length < 2 || tokens.length > 5) return null;
  if (!/^[A-ZÁÉÍÓÚÂÊÔÃÕÇ][a-zà-ÿ]{2,}$/.test(tokens[0])) return null;
  for (const t of tokens) {
    const ok = /^[A-ZÁÉÍÓÚÂÊÔÃÕÇ][a-zà-ÿ]+$/.test(t) || /^[A-Z]\.?$/.test(t) || CONECTORES.has(t);
    if (!ok || ehPalavraDeNegocio(t)) return null;
  }
  return tokens[0];
}

/**
 * Trava o erro do lote 01 (mensagem saiu com o nome de outro lead): se
 * abre com Dr(a). Fulano, "Fulano" TEM que estar no nome da clínica.
 */
function validaAbertura(abertura, clinica) {
  if (!/^Dra?\./.test(abertura)) return true;
  const nome = abertura.split(/\s+/).slice(1).join(' ');
  return semAcento(clinica).includes(semAcento(nome));
}

// ─── mensagem (variação A — a que gerou os 2 pedidos de exemplo) ───────
function msgA(abertura, clinica, cidade) {
  const alvo = abertura === clinica ? 'vocês' : 'seu perfil';
  return `${abertura}, vi ${alvo} no Google Maps de ${cidade}. Vocês não têm uma página ` +
    'própria listada — quem procura pela clínica não encontra um lugar com serviços, ' +
    'endereço e horários. Eu monto páginas para clínicas odontológicas, no ar em poucos ' +
    'dias, com hospedagem e ajustes inclusos. Posso mandar um exemplo?';
}

/**
 * Mensagem pronta pra QUALQUER lead (mesma regra de abertura da fila de
 * disparo). Usada pelo gerenciador de contatos (aba Pipeline) pra abrir o
 * wa.me já preenchido.
 */
function temCaraDeOdonto(row) {
  if (ODO.has(row.category)) return true;
  // categoria vazia no Maps: confia na busca que trouxe o lead
  return !row.category && /odont|dentist/i.test(row.query || '');
}

/**
 * Por que um lead NÃO deve ficar na tabela ativa `leads` (null = fica).
 * Mesma regra da limpeza manual de 15/09. Enquanto o ICP for só odonto,
 * o resto vai pra `leads_arquivo` — quando OCTO abrir outro nicho, trocar
 * ARQUIVAR_FORA_DO_ICP pra false (ou ampliar temCaraDeOdonto).
 */
const ARQUIVAR_FORA_DO_ICP = true;
function motivoArquivamento(row) {
  if (ARQUIVAR_FORA_DO_ICP && !temCaraDeOdonto(row)) return 'fora_do_icp';
  if (!isCel(norm(row.phone))) return 'sem_celular_valido';
  return null;
}

function mensagemPronta(row) {
  const cidade = cidadeDe(row);
  const clinica = limpaNome(row.name, cidade);
  let abertura = ABERTURA_MANUAL[row.id] || sugereAbertura(row.name) || clinica;
  if (!validaAbertura(abertura, clinica)) abertura = clinica;
  return { cidade, clinica, abertura, msg: msgA(abertura, clinica, cidade) };
}

function waLink(tel, msg) {
  return 'https://wa.me/55' + tel + '?text=' + encodeURIComponent(msg);
}

function googleLink(clinica, cidade) {
  return 'https://www.google.com/search?q=' + encodeURIComponent(`"${clinica}" ${cidade} site`);
}

// ─── janela de horário ───────────────────────────────────────────────────
function hhmmParaMinutos(s) {
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
}

function dentroDaJanela(agora) {
  agora = agora || new Date();
  if (BLOQUEIA_DOM && agora.getDay() === 0) return { ok: false, motivo: 'domingo' };
  const minsAgora = agora.getHours() * 60 + agora.getMinutes();
  for (const [ini, fim] of JANELAS) {
    if (minsAgora >= hhmmParaMinutos(ini) && minsAgora <= hhmmParaMinutos(fim)) {
      return { ok: true, motivo: '' };
    }
  }
  return { ok: false, motivo: `fora da janela (${JANELAS.map((j) => j.join('-')).join(', ')})` };
}

function proximaJanela(agora) {
  agora = agora || new Date();
  const candidatasHoje = JANELAS
    .map(([ini]) => {
      const [h, m] = ini.split(':').map(Number);
      const d = new Date(agora);
      d.setHours(h, m, 0, 0);
      return d;
    })
    .filter((d) => d > agora)
    .sort((a, b) => a - b);
  if (candidatasHoje.length) return candidatasHoje[0];
  const [h, m] = JANELAS[0][0].split(':').map(Number);
  const amanha = new Date(agora);
  amanha.setDate(amanha.getDate() + 1);
  amanha.setHours(h, m, 0, 0);
  return amanha;
}

// ─── formatação de data local (evita bug de fuso do toISOString) ───────
function hojeISO(agora) {
  const d = agora || new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function hojeDDMM(agora) {
  const d = agora || new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}`;
}

function agoraFmt(agora) {
  const d = agora || new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function rotuloDoDia(agora) {
  const d = agora || new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `lote-${pad(d.getDate())}${pad(d.getMonth() + 1)}`;
}

module.exports = {
  ODO, DDD_ESPERADO, ABERTURA_MANUAL, CIDADE_MANUAL, PESO_CIDADE, RESPOSTA_PADRAO,
  CAP_DIARIO, JANELAS, INTERVALO, PAUSA_A_CADA, PAUSA_LONGA, BLOQUEIA_DOM,
  semAcento, norm, isCel, fmt, limpaNome, cidadeDe, sugereAbertura, validaAbertura,
  msgA, mensagemPronta, temCaraDeOdonto, motivoArquivamento, primeiroNomeDePessoa, waLink, googleLink, dentroDaJanela, proximaJanela,
  hojeISO, hojeDDMM, agoraFmt, rotuloDoDia,
};
