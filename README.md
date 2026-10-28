# SCRAPPER

Ferramenta **local** de prospecção B2B: coleta estabelecimentos do Google Maps, organiza os contatos num funil e prepara mensagens de abordagem para **envio manual** (o app só abre o `wa.me` com o texto pronto; nada é enviado automaticamente). Estética retrô de terminal CRT.

> Este repositório contém **apenas o código**. A base de contatos (`leads.db`), planilhas, filas e logs usados na operação real ficam fora do Git de propósito, pois contêm dados de terceiros.

## O que faz

- **Scraper** (Playwright): busca por termo + cidade no Google Maps, com atrasos aleatórios.
- **Banco SQLite**: leads ativos e arquivo, com deduplicação por telefone e nome; leads fora do perfil ou sem celular vão direto para o arquivo.
- **Pipeline** de status: A contatar → Contatado → Respondeu → Reunião marcada → Fechado / Sem interesse / Sem resposta.
- **Qualificação e limpeza de nomes**: remove "cauda de SEO" do nome do Maps e sugere a abertura da mensagem (Dr./Dra. + nome).
- **Controle de ritmo**: limite diário e janela de horário para os contatos.
- **Interface web** (React + Vite + Tailwind) servida pelo Express.
- Scripts em Python (`disparo.py`, `gerar-previas.py`) que compartilham as mesmas regras do módulo JS.

## Stack

Node.js · Express · Playwright · SQLite · React · Vite · Tailwind · Python 3.

## Rodar

```bash
npm run install:all
npm run build:frontend
npm start        # abre a interface local; o leads.db é criado no primeiro uso
```

## Uso responsável

Use com dados de contato empresarial de acesso público, respeite os Termos de Uso do Google e a LGPD, e mantenha opt-out para quem pedir para não ser contatado.

## Sobre o desenvolvimento

Desenvolvido com apoio de ferramentas de IA (Claude e outras), com regras de negócio, testes na operação e revisão feitos por mim.
