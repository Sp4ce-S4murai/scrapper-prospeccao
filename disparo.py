# -*- coding: utf-8 -*-
"""
disparo.py - fila de prospeccao com pacing para WhatsApp (Octo Paginas)

RODAR NO WINDOWS, NAO PELA PONTE DO CLAUDE (sqlite no share montado da
I/O error). Python 3.9+. Sem dependencia externa.

    python disparo.py                          # mostra a fila do dia
    python disparo.py --csv                    # + exporta fila-AAAA-MM-DD.csv
    python disparo.py --rodar                  # dispara com pacing
    python disparo.py --rodar --fila fila-cobranca.json
    python disparo.py --rodar --cidade Canela --cap 12
    python disparo.py --relatorio              # funil + o que foi hoje
    python disparo.py --rodar --fila fila-previas.json --recomecar

Baixo atrito (18/09): 2 teclas por mensagem (sem Enter), bip quando a espera
acaba, e retomada — fechou o terminal, a proxima rodada continua de onde parou
(.progresso-<fila>.json). O envio segue humano: ver o paragrafo abaixo.

O script controla RITMO, FILA e BANCO. Quem aperta enviar e voce - e o
unico jeito de fazer isso sem violar os termos do WhatsApp e sem rifar o
numero da OCTO. Automatizar o envio foi tirado de proposito.
"""
import argparse, csv, datetime as dt, json, os, random, re, shutil, sqlite3
import sys, time, unicodedata, urllib.parse, webbrowser

AQUI = os.path.dirname(os.path.abspath(__file__))
DB   = os.path.join(AQUI, 'leads.db')
LOG  = os.path.join(AQUI, 'log-disparo.csv')

# ─── pacing ───────────────────────────────────────────────────────────────
# ESTIMATIVA conservadora, nao limite publicado pela Meta (ela nao publica
# limite pro app comum/Business). O que derruba numero e denuncia do
# destinatario, nao intervalo - o intervalo so evita o padrao de rajada.
CAP_DIARIO   = 30
JANELAS      = [('09:00', '11:30'), ('14:00', '17:40')]
INTERVALO    = (240, 540)      # 4 a 9 min
PAUSA_A_CADA = 8               # a cada 8 envios...
PAUSA_LONGA  = (900, 1500)     # ...15 a 25 min
BLOQUEIA_DOM = True

# ─── qualificacao ─────────────────────────────────────────────────────────
ODO = {'Clínica odontológica', 'Dentista', 'Cirurgião dentista', 'Odontopediatra',
       'Endodontista', 'Ortodontista', 'Implantodontista', 'Periodontista',
       'Clínica de odontologia', 'Odontologista'}
# B2B / fora do ICP, listados de proposito pra ninguem "consertar" isso depois:
# Radiologia odontológica e Laboratório de odontologia atendem dentista, nao paciente.
DDD_ESPERADO = {'51', '54'}    # RS - fora disso o script avisa

ABERTURA = {}   # override manual 'Dr./Dra. Nome' por id de lead (preenchido local)
CIDADE_MANUAL = {
    50:'Gramado',51:'Gramado',52:'Gramado',57:'Gramado',58:'Gramado',
    65:'Porto Alegre',66:'Porto Alegre',111:'Taquara',112:'Taquara',
    149:'Canela',151:'Canela',158:'Canela',159:'Canela',160:'Canela',161:'Canela',
}
PESO_CIDADE = {'Canela':0,'Gramado':1,'Três Coroas':2,'Igrejinha':3,'Taquara':4,
               'Nova Petrópolis':5,'Bento Gonçalves':6,'Caxias do Sul':6,'Porto Alegre':9}

RESPOSTA_PADRAO = ('https://www.octopaginas.com.br/odontologia — dois layouts prontos '
                   'pra clínica odontológica. A página de vocês sai com o conteúdo, as '
                   'fotos e os serviços da clínica. Se quiser, mando os valores.')

# ─── helpers ──────────────────────────────────────────────────────────────
def sem_acento(s):
    return ''.join(c for c in unicodedata.normalize('NFD', s or '')
                   if unicodedata.category(c) != 'Mn').lower()

def norm(p):
    d = re.sub(r'\D', '', p or '')
    if d.startswith('55') and len(d) > 11: d = d[2:]
    if d.startswith('0'): d = d[1:]
    return d

def is_cel(d): return len(d) == 11 and d[2] == '9'
def fmt(d):    return '+55 %s %s-%s' % (d[:2], d[2:7], d[7:])

def limpa_nome(n, cidade=None):
    """Nome do Maps vem cheio de cauda de SEO, pior ainda em cidade grande:
    "Martinato Odontologia (Dentista - Caxias do Sul)",
    "Dra. Maria Souza | Odontologia Avancada",
    "Ana Pereira - Cirurgia Dentista | Caxias do Sul"."""
    n = (n or '').split('|')[0].strip()
    n = re.sub(r'\s*\([^)]*\)', '', n)                      # tira (...)
    n = re.sub(r'\s+em\s+[A-Z][^,]*?(\s+RS)?$', '', n)      # tira "em <Cidade> RS"
    n = n.split('/')[0].strip()   # "Camila Rosa Cirurgia-Dentista/ Harmonizacao Facial"
    n = re.sub(r'\s*[-–—]\s*(Cirurgi[ãa]o?([\s-]+Dentista)?|Dentista|Odontologia)\s*$', '', n, flags=re.I)
    n = re.sub(r'\s+Cirurgi[ãa]o?[\s-]+Dentista\s*$', '', n, flags=re.I)
    if cidade:   # "Odonto Rizzo - Caxias do Sul" -> "Odonto Rizzo"
        n = re.sub(r'\s*[-–—,]\s*%s\s*$' % re.escape(cidade), '', n, flags=re.I)
    # cauda que sobra depois dos cortes acima, em loop ate estabilizar:
    # "Camila Rosa Cirurgia" (o /Harmonizacao levou o "Dentista" junto),
    # "Dra Tainara da Rocha - Dentista Gramado" (titulo + cidade no fim).
    for _ in range(3):
        antes = n
        n = re.sub(r'\s*[-–—,]?\s*Cirurgi[ãa]o?\s*$', '', n, flags=re.I)
        if cidade:
            n = re.sub(r'\s*[-–—,]?\s*(Dentista|Odontologia)\s+%s\s*$' % re.escape(cidade),
                       '', n, flags=re.I)
        n = re.sub(r'\s*[-–—,]\s*Dentista\s*$', '', n, flags=re.I)
        n = n.strip(' -–—')
        if n == antes:
            break
    return re.sub(r'\s{2,}', ' ', n).strip(' -–—')

def cidade_de(row):
    if row['id'] in CIDADE_MANUAL: return CIDADE_MANUAL[row['id']]
    m = re.search(r'\bem\s+([A-ZÁÂÃÉÊÍÓÔÕÚÇ][\wÁ-ú\s]+?)\s*[-,]', (row['query'] or '') + ' ,')
    if m: return m.group(1).strip()
    partes = [p.strip() for p in (row['address'] or '').split(',') if p.strip()]
    return partes[-2] if len(partes) >= 2 else ''

RADICAIS_NEGOCIO = (
    'odont', 'clinic', 'consult', 'centro', 'instit', 'sorri', 'dent', 'oral',
    'implant', 'orto', 'ortho', 'estet', 'saude', 'espaco', 'cooper', 'studio',
    'ltda', 'integr', 'especial', 'compan', 'excel', 'digital', 'harmon',
    'prefeit', 'radio', 'estac', 'grupo', 'bucal', 'smile', 'quiro', 'psico',
    'fisio', 'cirurgi', 'endo', 'perio', 'protes',
)
PALAVRAS_NEGOCIO = {'vida', 'bem', 'art', 'bio', 'eco', 'inova', 'nova', 'oi', 'uno', 'top'}
CONECTORES = {'da', 'de', 'do', 'das', 'dos'}
MAI = 'A-ZÁÉÍÓÚÂÊÔÃÕÇ'
MIN = 'a-zà-ÿ'

def eh_palavra_de_negocio(palavra):
    p = re.sub(r'[^a-z]', '', sem_acento(palavra))
    return p in PALAVRAS_NEGOCIO or p.startswith(RADICAIS_NEGOCIO)

def primeiro_nome_de_pessoa(nome):
    """'Marcio A Costanzi' -> 'Marcio'; 'Grando, Kelen' -> 'Kelen'. None se
    tiver cara de estabelecimento."""
    n = (nome or '').strip()
    inv = re.match(r'^([%s][%s]+),\s*([%s][%s]+)$' % (MAI, MIN, MAI, MIN), n)
    if inv: n = '%s %s' % (inv.group(2), inv.group(1))
    tokens = n.split()
    if not 2 <= len(tokens) <= 5: return None
    if not re.match(r'^[%s][%s]{2,}$' % (MAI, MIN), tokens[0]): return None
    for t in tokens:
        ok = (re.match(r'^[%s][%s]+$' % (MAI, MIN), t) or re.match(r'^[A-Z]\.?$', t)
              or t in CONECTORES)
        if not ok or eh_palavra_de_negocio(t): return None
    return tokens[0]

def sugere_abertura(clinica):
    """Detecta 'Dr./Dra. Fulano' no nome do estabelecimento. Devolve None
    quando nao tem certeza - na duvida abre com o nome da clinica.
    Mantido igual a sugereAbertura() de disparo-logic.js."""
    bruto = clinica or ''
    m = re.search(r'\b(Dra?\.\s*|Dra?\s+|Doutora?\s+)([A-ZÁÉÍÓÚÂÊÔÃÕÇ][\wÁ-ú]+)', bruto)
    if m:
        titulo = 'Dra.' if sem_acento(m.group(1)).startswith(('dra', 'doutora')) else 'Dr.'
        return '%s %s' % (titulo, m.group(2))
    # "Ana Pereira - Cirurgia Dentista", "Camila Rosa Cirurgia-Dentista/ ...":
    # o genero vem do proprio titulo
    m = re.search(r'cirurgi(ã|ão)', bruto, flags=re.I)
    primeiro = re.match(r'^([%s][%s]{2,})\s' % (MAI, MIN), bruto)
    if m and primeiro and not eh_palavra_de_negocio(primeiro.group(1)):
        return '%s %s' % ('Dra.' if m.group(1).lower() == 'ã' else 'Dr.', primeiro.group(1))
    # pessoa sem titulo: nao da pra saber Dr. ou Dra., abre so com o primeiro nome
    return primeiro_nome_de_pessoa(bruto)

def valida_abertura(abertura, clinica):
    """Trava o erro do lote 01 (mensagem saiu com o nome de outro lead):
    se abre com Dr(a). Fulano, 'Fulano' TEM que estar no nome da clinica."""
    if not re.match(r'^Dra?\.', abertura): return True
    nome = abertura.split(None, 1)[1]
    return sem_acento(nome) in sem_acento(clinica)

# ─── mensagem (variacao A - a que gerou os 2 pedidos de exemplo) ──────────
def msg_A(abertura, clinica, cidade):
    alvo = 'vocês' if abertura == clinica else 'seu perfil'
    return (u'%s, vi %s no Google Maps de %s. Vocês não têm uma página própria '
            u'listada — quem procura pela clínica não encontra um lugar com serviços, '
            u'endereço e horários. Eu monto páginas para clínicas odontológicas, no ar '
            u'em poucos dias, com hospedagem e ajustes inclusos. Posso mandar um exemplo?'
            % (abertura, alvo, cidade))

def wa_link(tel, msg):
    return 'https://wa.me/55' + tel + '?text=' + urllib.parse.quote(msg)

def google_link(clinica, cidade):
    return 'https://www.google.com/search?q=' + urllib.parse.quote(
        '"%s" %s site' % (clinica, cidade))

# ─── banco ────────────────────────────────────────────────────────────────
def conectar(db, ro=False):
    if ro: return sqlite3.connect('file:%s?mode=ro' % db, uri=True)
    con = sqlite3.connect(db, timeout=30)
    con.execute('PRAGMA journal_mode=DELETE')
    return con

def backup(db):
    bak = db + '.bak-' + dt.date.today().strftime('%Y%m%d')
    if not os.path.exists(bak):
        shutil.copy2(db, bak); print('backup: %s' % os.path.basename(bak))

def telefones_ja_usados(db):
    """Nao mandar duas vezes pro mesmo numero, mesmo que sejam leads
    diferentes (matriz e filial costumam repetir telefone)."""
    con = conectar(db, ro=True)
    usados = {norm(r[0]) for r in con.execute(
        "select phone from leads where status != 'A contatar'")}
    con.close(); return usados

def monta_fila(db, cap, cidade_filtro=None):
    con = conectar(db, ro=True); con.row_factory = sqlite3.Row
    rows = con.execute("select * from leads where status = 'A contatar'").fetchall()
    con.close()
    usados = telefones_ja_usados(db)
    fila, descartes = [], {'categoria':0,'sem_celular':0,'telefone_repetido':0,'cidade':0}
    for r in rows:
        if r['category'] not in ODO: descartes['categoria'] += 1; continue
        tel = norm(r['phone'])
        if not is_cel(tel):        descartes['sem_celular'] += 1; continue
        if tel in usados:          descartes['telefone_repetido'] += 1; continue
        usados.add(tel)
        cidade  = cidade_de(r)
        if cidade_filtro and sem_acento(cidade_filtro) not in sem_acento(cidade):
            descartes['cidade'] += 1; continue
        clinica = limpa_nome(r['name'], cidade)
        # abertura sai do nome CRU: limpa_nome corta justamente o "- Cirurgia
        # Dentista" de onde se descobre o titulo.
        abertura = ABERTURA.get(r['id']) or sugere_abertura(r['name']) or clinica
        if not valida_abertura(abertura, clinica): abertura = clinica
        fila.append(dict(id=r['id'], clinica=clinica, cidade=cidade, tel=tel,
                         abertura=abertura, variacao='A',
                         msg=msg_A(abertura, clinica, cidade),
                         alerta='' if tel[:2] in DDD_ESPERADO else 'DDD %s fora do RS' % tel[:2]))
    fila.sort(key=lambda x: (PESO_CIDADE.get(x['cidade'], 8), x['clinica']))
    return fila[:cap], descartes

def marcar(db, lead_id, nota):
    con = conectar(db)
    atual = con.execute('select notes from leads where id=?', (lead_id,)).fetchone()[0] or ''
    con.execute('update leads set status=?, last_contact_at=?, notes=? where id=?',
                ('Contatado', dt.date.today().isoformat(),
                 (atual + ' | ' if atual else '') + nota, lead_id))
    con.commit(); con.close()

def enviados_hoje(db):
    con = conectar(db, ro=True)
    n = con.execute('select count(*) from leads where last_contact_at=?',
                    (dt.date.today().isoformat(),)).fetchone()[0]
    con.close(); return n

def loga(lead, rotulo, desfecho):
    novo = not os.path.exists(LOG)
    with open(LOG, 'a', newline='', encoding='utf-8-sig') as f:
        w = csv.writer(f, delimiter=';')
        if novo: w.writerow(['quando','lote','id','clinica','cidade','telefone','variacao','desfecho'])
        w.writerow([dt.datetime.now().strftime('%Y-%m-%d %H:%M'), rotulo, lead['id'],
                    lead['clinica'], lead['cidade'], fmt(lead['tel']),
                    lead.get('variacao',''), desfecho])

# ─── janela de horario ────────────────────────────────────────────────────
def hhmm(s):
    h, m = s.split(':'); return dt.time(int(h), int(m))

def dentro_da_janela(agora=None):
    agora = agora or dt.datetime.now()
    if BLOQUEIA_DOM and agora.weekday() == 6: return False, 'domingo'
    for ini, fim in JANELAS:
        if hhmm(ini) <= agora.time() <= hhmm(fim): return True, ''
    return False, 'fora da janela (%s)' % ', '.join('%s-%s' % j for j in JANELAS)

def espera_janela():
    ok, por = dentro_da_janela()
    while not ok:
        agora, prox = dt.datetime.now(), None
        for ini, _ in JANELAS:
            c = dt.datetime.combine(agora.date(), hhmm(ini))
            if c > agora and (prox is None or c < prox): prox = c
        if prox is None:
            print('\n%s. Proxima janela so amanha - parando por hoje.' % por); return False
        seg = int((prox - agora).total_seconds())
        print('\n%s. Retomo as %s (%d min). Ctrl+C sai.' % (por, prox.strftime('%H:%M'), seg//60))
        time.sleep(min(seg + 5, 600))
        ok, por = dentro_da_janela()
    return True

def dorme(seg, rotulo='', proximo=None):
    """Espera do pacing. Bipa no fim pra voce poder fazer outra coisa nesses
    minutos em vez de ficar olhando o terminal."""
    if proximo:
        print('   proxima: %s (%s) em ~%d min' % (proximo['clinica'][:40],
                                                  proximo['cidade'], max(1, seg//60)))
    fim = time.time() + seg
    pulou = False
    try:
        while True:
            r = int(fim - time.time())
            if r <= 0: break
            sys.stdout.write('\r   %s proximo em %02d:%02d  '
                             '[Ctrl+C pula - foi assim que saiu a rajada de 14/09] '
                             % (rotulo, r//60, r % 60)); sys.stdout.flush(); time.sleep(1)
    except KeyboardInterrupt:
        pulou = True; print('\n   espera pulada.')
    sys.stdout.write('\r' + ' ' * 78 + '\r')
    if not pulou: bip()

# ─── baixo atrito: uma tecla, aviso sonoro, retomada ──────────────────────
# O envio continua sendo humano (ver docstring). O que foi automatizado aqui
# e o PROCESSO: menos teclas por mensagem, aviso quando a proxima esta pronta
# e retomada de onde parou. Nada disso manda mensagem sozinho.
try:
    import msvcrt
    def _uma_tecla():
        ch = msvcrt.getch()
        if ch in (b'\x00', b'\xe0'): msvcrt.getch(); return ''   # tecla especial
        if ch == b'\x03': raise KeyboardInterrupt
        return ch.decode('latin-1', 'ignore')
except ImportError:                      # linux/mac (ponte, testes)
    def _uma_tecla():
        try:
            import termios, tty
            fd = sys.stdin.fileno(); velho = termios.tcgetattr(fd)
            try:
                tty.setraw(fd); ch = sys.stdin.read(1)
            finally:
                termios.tcsetattr(fd, termios.TCSADRAIN, velho)
            if ch == '\x03': raise KeyboardInterrupt
            return ch
        except Exception:
            return (sys.stdin.readline() or '\n')[:1]

def tecla(validas, prompt=''):
    """Le UMA tecla, sem Enter. 'enter' representa a tecla Enter."""
    if prompt: sys.stdout.write(prompt); sys.stdout.flush()
    while True:
        c = _uma_tecla()
        c = 'enter' if c in ('\r', '\n') else c.lower()
        if c in validas:
            print('' if c == 'enter' else c); return c

def bip(n=1):
    for _ in range(n):
        try:
            import winsound; winsound.Beep(880, 180)
        except Exception:
            sys.stdout.write('\a'); sys.stdout.flush()
        time.sleep(0.12)

def _arq_progresso(rotulo):
    return os.path.join(AQUI, '.progresso-%s.json' % rotulo)

def carrega_progresso(rotulo):
    try:
        return json.load(open(_arq_progresso(rotulo), encoding='utf-8'))
    except Exception:
        return {}

def grava_progresso(rotulo, lead_id, desfecho):
    """Fechou o terminal no meio? A proxima rodada pula quem ja foi resolvido.
    Pra refazer a fila inteira: apague o .progresso-<fila>.json (ou use
    --recomecar)."""
    d = carrega_progresso(rotulo)
    d[str(lead_id)] = {'desfecho': desfecho,
                       'quando': dt.datetime.now().strftime('%Y-%m-%d %H:%M')}
    try:
        json.dump(d, open(_arq_progresso(rotulo), 'w', encoding='utf-8'),
                  ensure_ascii=False, indent=1)
    except Exception as e:
        print('   (aviso: nao consegui gravar o progresso: %s)' % e)

# ─── execucao ─────────────────────────────────────────────────────────────
def rodar(db, fila, rotulo, cap=CAP_DIARIO, recomecar=False):
    if not dentro_da_janela()[0] and not espera_janela(): return
    prog = {} if recomecar else carrega_progresso(rotulo)
    if prog:
        antes = len(fila)
        fila = [L for L in fila if str(L['id']) not in prog]
        print('retomando "%s": %d de %d ja resolvidos numa rodada anterior, '
              '%d pela frente.\n' % (rotulo, antes - len(fila), antes, len(fila)))
        if not fila:
            print('nada pendente nesta fila. (--recomecar refaz do zero)'); return
    total = len(fila)
    feitos = pulados = 0
    for i, L in enumerate(fila, 1):
        if enviados_hoje(db) >= cap:
            print('\nCap de %d no dia atingido. Parando.' % cap); break
        if not dentro_da_janela()[0] and not espera_janela(): break

        print('\n' + '=' * 70)
        print('[%d/%d]  %s  -  %s' % (i, total, L['clinica'], L['cidade']))
        print('        %s   (lead %s, variacao %s)' % (fmt(L['tel']), L['id'], L['variacao']))
        print('        abre com: %s' % L['abertura'])
        if L.get('alerta'): print('        ATENCAO: %s' % L['alerta'])
        if L.get('tem_site'): print('        ATENCAO: pre-checagem achou site - [p] pula')
        print('-' * 70); print(L['msg']); print('-' * 70)
        print('  [Enter] abrir no WhatsApp   [g] conferir no Google   [p] pular   [q] sair')
        r = tecla(('enter', 'g', 'p', 'q'), '  > ')
        while r == 'g':
            webbrowser.open(google_link(L['clinica'], L['cidade']))
            print('  achou site da clinica? entao [p] pula - a mensagem diria uma mentira.')
            r = tecla(('enter', 'g', 'p', 'q'), '  > ')
        if r == 'q': print('encerrado por voce.'); break
        if r == 'p':
            pulados += 1; loga(L, rotulo, 'pulado'); grava_progresso(rotulo, L['id'], 'pulado')
            print('  pulado (segue A contatar).'); continue

        webbrowser.open(wa_link(L['tel'], L['msg']))
        print('  confira o texto na caixa ANTES de enviar.')
        if tecla(('s', 'n'), '  enviou? [s] sim  [n] nao: ') == 's':
            marcar(db, L['id'], '%s var %s enviado %s'
                   % (rotulo, L['variacao'], dt.date.today().strftime('%d/%m')))
            loga(L, rotulo, 'enviado'); grava_progresso(rotulo, L['id'], 'enviado'); feitos += 1
            print('  marcado. %d/%d hoje.' % (enviados_hoje(db), cap))
            print('  se responder "pode mandar":\n  %s' % RESPOSTA_PADRAO)
        else:
            loga(L, rotulo, 'falhou'); print('  NAO marcado - segue "A contatar".')

        if i < total:
            prox = fila[i]
            if feitos and feitos % PAUSA_A_CADA == 0:
                dorme(random.randint(*PAUSA_LONGA), 'pausa longa,', prox)
            else:
                dorme(random.randint(*INTERVALO), '', prox)
    bip(2)
    print('\nFim. %d enviados nesta sessao, %d pulados, %d hoje no total.'
          % (feitos, pulados, enviados_hoje(db)))
    if feitos + pulados < total:
        print('Sobrou %d na fila - rode o mesmo comando amanha, ele retoma daqui.'
              % (total - feitos - pulados))

def relatorio(db):
    con = conectar(db, ro=True)
    print('--- funil ---')
    for st, n in con.execute('select status, count(*) from leads group by status order by 2 desc'):
        print('  %-14s %d' % (st, n))
    print('--- ultimos 7 dias ---')
    for d, n in con.execute("select last_contact_at, count(*) from leads "
                            "where last_contact_at is not null group by 1 order by 1 desc limit 7"):
        print('  %s  %d' % (d, n))
    con.close()
    print('hoje: %d / %d' % (enviados_hoje(db), CAP_DIARIO))

# ─── main ─────────────────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--rodar', action='store_true')
    ap.add_argument('--relatorio', action='store_true')
    ap.add_argument('--csv', action='store_true')
    ap.add_argument('--fila', help='json externo (ex.: fila-cobranca.json)')
    ap.add_argument('--cidade', help='filtra a fila por cidade')
    ap.add_argument('--cap', type=int, default=CAP_DIARIO)
    ap.add_argument('--db', default=DB)
    ap.add_argument('--recomecar', action='store_true',
                    help='ignora o progresso salvo e refaz a fila do zero')
    a = ap.parse_args()

    if a.relatorio: relatorio(a.db); return

    if a.fila:
        fila = json.load(open(os.path.join(AQUI, a.fila), encoding='utf-8'))
        rotulo, desc = os.path.splitext(os.path.basename(a.fila))[0], {}
    else:
        fila, desc = monta_fila(a.db, a.cap, a.cidade)
        rotulo = 'lote-' + dt.date.today().strftime('%d%m')

    print('Fila "%s": %d leads (cap %d, %d ja enviados hoje)\n'
          % (rotulo, len(fila), a.cap, enviados_hoje(a.db)))
    for i, L in enumerate(fila, 1):
        print('%2d. %-44s %-15s %s%s' % (i, L['clinica'][:44], L['cidade'], fmt(L['tel']),
                                         '  <- ' + L['alerta'] if L.get('alerta') else ''))
    if desc:
        print('\ndescartados na qualificacao: ' +
              ', '.join('%s %d' % (k, v) for k, v in desc.items() if v))
    if a.csv:
        nome = 'fila-%s.csv' % dt.date.today().isoformat()
        with open(os.path.join(AQUI, nome), 'w', newline='', encoding='utf-8-sig') as f:
            w = csv.writer(f, delimiter=';')
            w.writerow(['id','clinica','cidade','telefone','abertura','variacao','mensagem','link'])
            for L in fila:
                w.writerow([L['id'], L['clinica'], L['cidade'], fmt(L['tel']), L['abertura'],
                            L['variacao'], L['msg'], wa_link(L['tel'], L['msg'])])
        print('\n-> %s' % nome)
    if not a.rodar:
        print('\n(nada foi enviado. use --rodar)'); return

    backup(a.db)
    rodar(a.db, fila, rotulo, a.cap, a.recomecar)

if __name__ == '__main__':
    main()
