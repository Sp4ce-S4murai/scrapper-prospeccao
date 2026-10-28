# -*- coding: utf-8 -*-
"""
gerar-previas.py - gera prévia personalizada + fila de reativação para os
leads FRIOS (contatados que nunca responderam).

RODAR NO WINDOWS, NAO PELA PONTE (sqlite no share montado da I/O error).
Python 3.9+, sem dependencia externa. Reaproveita disparo.py (mesma pasta)
pra nao ter duas versoes das regras de nome/telefone/abertura.

    python gerar-previas.py                 # mostra quem entra, nao escreve nada
    python gerar-previas.py --escrever      # grava previas.ts + fila-previas.json
    python gerar-previas.py --dias 7        # so quem esta frio ha 7+ dias
    python gerar-previas.py --limite 20

Depois de --escrever:
    1. cd ..\\OctoPaginas\\octo-paginas && npx tsc --noEmit
    2. git add src/lib/previas.ts && git commit && git push   (Vercel builda)
    3. CONFERIR no ar: https://www.octopaginas.com.br/previa/<slug>
    4. python disparo.py --rodar --fila fila-previas.json

O passo 3 nao e opcional: a mensagem manda um link: se a pagina nao subiu,
o lead recebe 404 e a reativacao vira tiro no pe.
"""
import argparse, datetime as dt, json, os, re, sqlite3, sys, unicodedata

AQUI = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, AQUI)
import disparo as D   # norm/is_cel/fmt/limpa_nome/sugere_abertura/valida_abertura/cidade_de

DB       = os.path.join(AQUI, 'leads.db')
PREVIAS  = os.path.normpath(os.path.join(
    AQUI, '..', 'OctoPaginas', 'octo-paginas', 'src', 'lib', 'previas.ts'))
FILA     = os.path.join(AQUI, 'fila-previas.json')
BASE_URL = 'https://www.octopaginas.com.br/previa/'

INI = '  // BEGIN:previas-geradas (gerar-previas.py — nao editar a mao)'
FIM = '  // END:previas-geradas'

DIAS_FRIO_PADRAO = 4

# Leads que NUNCA entram, com o motivo escrito pra ninguem "consertar" depois.
BLOQUEADOS = {}   # id do lead -> motivo (leads que nunca entram)

# ─── helpers ──────────────────────────────────────────────────────────────
PREFIXO_GENERICO = re.compile(
    r'^(cl[ií]nica\s+odontol[óo]gica|consult[óo]rio\s+odontol[óo]gico|cl[ií]nica\s+de\s+odontologia'
    r'|odontopediatra|odontologista|dentista)\b\s*[-–—:|]?\s*', re.I)

def tira_prefixo(nome):
    """'Dentista - Otavio Santos' -> 'Otavio Santos'. Se sobrar so o prefixo
    (ex.: 'Clinica Odontologica'), devolve o nome inteiro."""
    resto = PREFIXO_GENERICO.sub('', nome or '').strip(' -–—:|')
    return resto if len(resto) >= 3 else (nome or '')

def arruma_pontuacao(s):
    """'Citrino- Clínica Odontológica' -> 'Citrino - Clínica Odontológica'."""
    return re.sub(r'\s*([-–—])\s*', r' \1 ', s or '').strip(' -–—')

def abertura_de(bruto, clinica):
    """Ordem: 'Dr(a). Fulano' detectado no nome > primeiro nome da pessoa depois
    de tirar o prefixo generico > nome da clinica."""
    a = D.sugere_abertura(bruto)
    if a: return a
    resto = tira_prefixo(clinica)
    if resto != clinica:
        a = D.primeiro_nome_de_pessoa(resto)
        if a: return a
        return arruma_pontuacao(resto)
    return arruma_pontuacao(clinica)

def slugify(s):
    s = ''.join(c for c in unicodedata.normalize('NFD', s or '')
                if unicodedata.category(c) != 'Mn')
    s = re.sub(r'[^a-zA-Z0-9]+', '-', s).strip('-').lower()
    s = re.sub(r'-{2,}', '-', s)
    partes, saida = s.split('-'), []
    for parte in partes:                      # corta em palavra inteira, nao no meio
        if saida and len('-'.join(saida + [parte])) > 40: break
        saida.append(parte)
    return '-'.join(saida).strip('-')

def limpa_endereco(a):
    a = re.sub(r'[-]', '', a or '')          # icone do Maps
    return ' '.join(a.split())                           # endereco cru do Maps

def ja_tem_previa(texto_ts, slug, nome):
    return ('slug: "%s"' % slug) in texto_ts or ('nome: "%s"' % nome) in texto_ts

def perfil(nome):
    """Headline sai do proprio nome do Maps — nao e suposicao sobre a clinica."""
    n = D.sem_acento(nome)
    if 'estetic' in n or 'harmoniza' in n: return 'Odontologia e estética em %s'
    if 'ortodont' in n:                    return 'Ortodontia e odontologia em %s'
    if 'implant' in n:                     return 'Implantes e odontologia em %s'
    if 'odontopediatr' in n:               return 'Odontopediatria em %s'
    return 'Odontologia em %s'

def escapa(s):
    return (s or '').replace('\\', '\\\\').replace('"', '\\"')

# ─── mensagens (2 variacoes testaveis, as duas com saida explicita) ───────
def msg_P1(abertura, url):
    return (u'%s, montei uma prévia da página de vocês pra mostrar do que eu falei: '
            u'%s . É uma demonstração — os serviços, horários e fotos entram do jeito '
            u'que vocês confirmarem. Se não fizer sentido, me avisa que eu encerro por aqui.'
            % (abertura, url))

def msg_P2(abertura, url):
    return (u'%s, fiz uma página de demonstração com o nome, o endereço e o contato '
            u'de vocês, só pra vocês verem como ficaria: %s . Dá uma olhada e me diz o '
            u'que achou — se não for o momento, me avisa que eu não escrevo mais.'
            % (abertura, url))

VARIACOES = [('previa-P1', msg_P1), ('previa-P2', msg_P2)]

# ─── selecao ──────────────────────────────────────────────────────────────
def frios(db, dias, ts_atual):
    con = sqlite3.connect(db); con.row_factory = sqlite3.Row
    rows = [dict(r) for r in con.execute("select * from leads where status = 'Contatado'")]
    con.close()
    corte = (dt.date.today() - dt.timedelta(days=dias)).isoformat()
    saida, fora = [], {'bloqueado':0,'sem_celular':0,'ja_tem_previa':0,'recente':0,
                       'sem_whatsapp':0,'abertura_invalida':0,'categoria':0}
    vistos = set()
    for r in rows:
        nota = (r['notes'] or '').lower()
        if r['id'] in BLOQUEADOS:                 fora['bloqueado'] += 1;    continue
        if 'sem whatsapp' in nota or 'sem wpp' in nota:
            fora['sem_whatsapp'] += 1; continue
        if r['category'] and r['category'] not in D.ODO:
            fora['categoria'] += 1; continue
        tel = D.norm(r['phone'])
        if not D.is_cel(tel) or tel in vistos:    fora['sem_celular'] += 1;  continue
        if (r['last_contact_at'] or '')[:10] > corte:
            fora['recente'] += 1; continue

        cidade  = D.cidade_de(r)
        clinica = D.limpa_nome(r['name'], cidade)
        slug    = (slugify(tira_prefixo(clinica)) or slugify(clinica)
                   or ('lead-%d' % r['id']))
        if ja_tem_previa(ts_atual, slug, r['name']):
            fora['ja_tem_previa'] += 1; continue
        abertura = abertura_de(r['name'], clinica)
        if not D.valida_abertura(abertura, r['name']):
            fora['abertura_invalida'] += 1; continue   # o erro do lote 01, travado

        vistos.add(tel)
        saida.append(dict(row=r, id=r['id'], clinica=clinica, cidade=cidade, tel=tel,
                          slug=slug, abertura=abertura))
    # slug duplicado entre dois leads -> desempata pela cidade, depois pelo id
    por_slug = {}
    for L in saida: por_slug.setdefault(L['slug'], []).append(L)
    for slug, grupo in por_slug.items():
        if len(grupo) > 1:
            for L in grupo:
                L['slug'] = '%s-%s' % (slug, slugify(L['cidade']) or L['id'])
    saida.sort(key=lambda L: (D.PESO_CIDADE.get(L['cidade'], 8), L['clinica']))
    return saida, fora

# ─── saida ────────────────────────────────────────────────────────────────
def entrada_ts(L):
    r, cidade = L['row'], L['cidade']
    maps = (r['maps_url'] or '').split('/data=')[0].split('?')[0]   # tira o tracking do Maps
    if not maps:
        maps = ('https://maps.google.com/?q=' +
                re.sub(r'\s+', '+', '%s %s' % (r['name'], cidade)))
    trat = ('\n    tratamento: "%s",' % escapa(L['abertura'])
            if L['abertura'].startswith(('Dr.', 'Dra.')) else '')
    return ('''  {
    slug: "%(slug)s",
    nome: "%(nome)s",%(trat)s
    cidade: "%(cidade)s",
    uf: "RS",
    endereco: "%(end)s",
    telefone: "(%(ddd)s) %(p1)s-%(p2)s",
    whatsapp: "55%(tel)s",
    mapsUrl: "%(maps)s",
    headline: "%(head)s",
    subheadline:
      "Serviços, endereço e horários em um lugar só, " +
      "com contato direto pelo WhatsApp.",
    servicos: SERVICOS_BASE,
    aConfirmar: [
      "Lista real de especialidades atendidas",
      "Horário de funcionamento",
      "Responsável técnico e número do CRO (obrigatório na publicidade odontológica)",
      "Fotos da clínica",
    ],
    origem: "%(origem)s",
  },''' % dict(
        # nome da PAGINA usa o nome limpo (L['clinica']), nao o cru do Maps:
        # o cru traz cauda de SEO ("| Dentista em Igrejinha| Lentes de Porcelana")
        # e vira o titulo da previa, denunciando raspagem. 18->22/09/2026.
        slug=L['slug'], nome=escapa(L['clinica']), trat=trat, cidade=escapa(cidade),
        end=escapa(limpa_endereco(r['address'])),
        ddd=L['tel'][:2], p1=L['tel'][2:7], p2=L['tel'][7:], tel=L['tel'],
        maps=escapa(maps), head=escapa(perfil(r['name']) % cidade),
        origem=escapa('Frio — contatado em %s sem resposta; prévia gerada em %s'
                      % ((r['last_contact_at'] or '?')[:10],
                         dt.date.today().strftime('%d/%m/%Y')))))

def escreve_previas(lista):
    txt = open(PREVIAS, encoding='utf-8').read()
    bloco = '\n'.join([INI] + [entrada_ts(L) for L in lista] + [FIM])
    if INI in txt and FIM in txt:
        novo = re.sub(re.escape(INI) + r'.*?' + re.escape(FIM), lambda _: bloco,
                      txt, flags=re.S)
    else:
        # Primeira vez: entra no fim do array PREVIAS. NAO usar o primeiro ']'
        # do arquivo - esse fecha o SERVICOS_BASE, e o bloco cai dentro dele
        # (tsc: "'slug' does not exist in type 'Servico'"). Foi o bug de 18/09.
        i = txt.index('export const PREVIAS')
        j = txt.index('\n];', i)
        novo = txt[:j] + '\n' + bloco + txt[j:]
    open(PREVIAS, 'w', encoding='utf-8', newline='\n').write(novo)

def escreve_fila(lista):
    fila = []
    for i, L in enumerate(lista):
        rotulo, montar = VARIACOES[i % len(VARIACOES)]
        fila.append(dict(id=L['id'], clinica=L['clinica'], cidade=L['cidade'],
                         tel=L['tel'], abertura=L['abertura'], variacao=rotulo,
                         msg=montar(L['abertura'], BASE_URL + L['slug'])))
    json.dump(fila, open(FILA, 'w', encoding='utf-8'),
              ensure_ascii=False, indent=1)
    return fila

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--db', default=DB)
    ap.add_argument('--dias', type=int, default=DIAS_FRIO_PADRAO,
                    help='minimo de dias desde o ultimo contato (padrao %d)' % DIAS_FRIO_PADRAO)
    ap.add_argument('--limite', type=int)
    ap.add_argument('--escrever', action='store_true',
                    help='grava previas.ts e fila-previas.json (sem isso, so mostra)')
    a = ap.parse_args()

    ts = open(PREVIAS, encoding='utf-8').read()
    lista, fora = frios(a.db, a.dias, ts)
    if a.limite: lista = lista[:a.limite]

    print('\nfrios ha %d+ dias: %d lead(s)' % (a.dias, len(lista)))
    print('fora: ' + ', '.join('%s=%d' % kv for kv in fora.items() if kv[1]))
    for i, L in enumerate(lista):
        print('  %-4s %-14s %-38s abre: %-18s /previa/%s'
              % (L['id'], L['cidade'][:14], L['clinica'][:38], L['abertura'][:18], L['slug']))
    for lid, motivo in BLOQUEADOS.items():
        print('  [bloqueado] %s: %s' % (lid, motivo))

    if not a.escrever:
        print('\n(nada escrito. use --escrever)'); return
    escreve_previas(lista); fila = escreve_fila(lista)
    print('\nprevias.ts atualizado (%d entradas no bloco gerado)' % len(lista))
    print('fila-previas.json: %d mensagens (%s)'
          % (len(fila), ' / '.join(r for r, _ in VARIACOES)))
    print('\nagora: tsc --noEmit -> commit -> push -> CONFERIR o link no ar '
          '-> python disparo.py --rodar --fila fila-previas.json')

if __name__ == '__main__':
    main()
