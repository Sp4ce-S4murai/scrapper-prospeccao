const { chromium } = require('playwright');
const { saveLead } = require('./database');

/**
 * Função utilitária para pausar com tempo aleatório (Humanização).
 * @param {number} min Ms mínimos
 * @param {number} max Ms máximos
 */
const delay = (min = 1500, max = 4000) => {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise(resolve => setTimeout(resolve, ms));
};

let isRunning = false;
let shouldStop = false;

/**
 * Interrompe a execução do scraper se estiver rodando.
 */
function stopScraper() {
  if (isRunning) {
    shouldStop = true;
  }
}

/**
 * Função principal de Scraping do Google Maps.
 * @param {Object} options 
 * @param {string} options.keyword Termo de busca (ex: Pizzaria)
 * @param {string} options.location Localização (ex: São Paulo, SP)
 * @param {Function} options.onLog Callback para emissão de logs em tempo real
 */
async function startScraper({ keyword, location, onLog }) {
  if (isRunning) {
    onLog('⚠️ Já existe uma busca em execução no momento.');
    return;
  }

  isRunning = true;
  shouldStop = false;

  const log = (msg) => {
    console.log(`[NeonScraper] ${msg}`);
    if (typeof onLog === 'function') {
      onLog(msg);
    }
  };

  const searchQuery = `${keyword} em ${location}`;
  log(`🚀 Iniciando busca para: "${searchQuery}"`);

  let browser;
  try {
    log('🌐 Inicializando navegação Chromium (Modo Stealth)...');
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--lang=pt-BR,pt'
      ]
    });

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
      locale: 'pt-BR'
    });

    const page = await context.newPage();
    const targetUrl = `https://www.google.com.br/maps/search/${encodeURIComponent(searchQuery)}`;
    
    log(`📍 Acessando Google Maps: ${targetUrl}`);
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await delay(3000, 5000);

    // Aceitar cookies caso apareça modal de consentimento
    try {
      const acceptBtn = page.locator('button:has-text("Aceitar tudo"), button:has-text("Concordo")');
      if (await acceptBtn.isVisible({ timeout: 3000 })) {
        await acceptBtn.click();
        log('🍪 Modal de cookies aceito.');
        await delay(1000, 2000);
      }
    } catch (e) {
      // Modal não presente
    }

    log('📜 Rolando painel de resultados do Google Maps...');
    
    // Identifica a div rolável com o feed de resultados
    const feedSelector = 'div[role="feed"], div[aria-label*="Resultados"], div.m6QEdf';
    try {
      await page.waitForSelector('a[href*="/maps/place/"], div[role="feed"]', { timeout: 20000 });
    } catch (err) {
      log('⚠️ Painel de resultados não encontrado ou busca sem resultados.');
      await browser.close();
      isRunning = false;
      return;
    }

    // Scroll progressivo para carregar mais estabelecimentos
    let previousCount = 0;
    let scrollAttempts = 0;
    const maxScrolls = 8; // Limite de rolagens para otimização

    while (scrollAttempts < maxScrolls && !shouldStop) {
      scrollAttempts++;
      log(`🔄 Carregando mais estabelecimentos (Rolagem ${scrollAttempts}/${maxScrolls})...`);

      await page.evaluate(() => {
        const feed = document.querySelector('div[role="feed"]') || 
                     document.querySelector('div[aria-label*="Resultados"]') ||
                     document.querySelector('.m6QEdf');
        if (feed) {
          feed.scrollTop = feed.scrollHeight;
        } else {
          // Tenta encontrar o elemento pai do primeiro link de local
          const placeLink = document.querySelector('a[href*="/maps/place/"]');
          if (placeLink) {
            let parent = placeLink.parentElement;
            while (parent && parent.scrollHeight <= parent.clientHeight) {
              parent = parent.parentElement;
            }
            if (parent) parent.scrollTop = parent.scrollHeight;
          }
        }
      });

      await delay(2000, 4000);

      // Checa se o texto "Você chegou ao fim da lista" está presente
      const endOfListText = page.locator('text="Você chegou ao fim da lista"');
      if (await endOfListText.count() > 0) {
        log('🏁 Fim dos resultados atingido.');
        break;
      }

      const currentCount = await page.locator('a[href*="/maps/place/"]').count();
      if (currentCount === previousCount && scrollAttempts > 2) {
        log('ℹ️ Nenhum resultado adicional carregado.');
        break;
      }
      previousCount = currentCount;
    }

    if (shouldStop) {
      log('🛑 Processo interrompido pelo usuário.');
      await browser.close();
      isRunning = false;
      return;
    }

    // ====================================================================
    //  FASE 2: Coletar todos os hrefs dos cards ANTES de iterar
    //  Isso evita problemas de referência stale causados pela virtualização
    //  de lista do Google Maps (elementos removidos/reciclados ao scrollar).
    // ====================================================================
    const allHrefs = await page.locator('a[href*="/maps/place/"]').evaluateAll(
      (elements) => elements.map(el => el.href).filter(Boolean)
    );

    // Remove hrefs duplicados mantendo a ordem
    const uniqueHrefs = [...new Set(allHrefs)];
    log(`📊 Total de estabelecimentos localizados: ${uniqueHrefs.length} (${allHrefs.length} links, ${allHrefs.length - uniqueHrefs.length} duplicados removidos)`);

    let totalSaved = 0;
    let totalDiscarded = 0;
    let totalArchived = 0;
    let lastPanelName = ''; // Rastreia o nome do painel anterior para detectar troca

    for (let i = 0; i < uniqueHrefs.length; i++) {
      if (shouldStop) {
        log('🛑 Processo cancelado durante a extração.');
        break;
      }

      const itemHref = uniqueHrefs[i];
      log(`🔍 Analisando item ${i + 1} de ${uniqueHrefs.length}...`);

      try {
        // Re-busca e clica no elemento pelo href específico via evaluate
        // Usa comparação direta de string (sem CSS escaping), funciona com qualquer caractere no href
        const clickResult = await page.evaluate((href) => {
          const links = document.querySelectorAll('a[href*="/maps/place/"]');
          for (const link of links) {
            if (link.href === href) {
              link.scrollIntoView({ behavior: 'smooth', block: 'center' });
              link.click();
              return 'clicked';
            }
          }
          return 'not_found';
        }, itemHref);

        if (clickResult === 'not_found') {
          // Elemento pode estar fora da viewport — tenta scrollar o feed para trazê-lo de volta
          log(`⚠️ Item ${i + 1} não encontrado no DOM. Tentando re-scroll...`);
          
          await page.evaluate(() => {
            const feed = document.querySelector('div[role="feed"]') || 
                         document.querySelector('div[aria-label*="Resultados"]');
            if (feed) feed.scrollTop = 0;
          });
          await delay(1500, 2500);

          // Segunda tentativa após scroll
          const retryResult = await page.evaluate((href) => {
            const links = document.querySelectorAll('a[href*="/maps/place/"]');
            for (const link of links) {
              if (link.href === href) {
                link.scrollIntoView({ behavior: 'smooth', block: 'center' });
                link.click();
                return 'clicked';
              }
            }
            return 'not_found';
          }, itemHref);

          if (retryResult === 'not_found') {
            log(`⚠️ Item ${i + 1} não encontrado mesmo após re-scroll. Pulando...`);
            continue;
          }
        }

        await delay(2500, 4000); // Pausa humanizada para abrir o painel do lugar

        // ====================================================================
        //  VERIFICAÇÃO DE TROCA DE PAINEL
        //  Aguarda que o H1 do painel de detalhes mude em relação ao anterior.
        //  Isso garante que estamos lendo dados do estabelecimento correto.
        // ====================================================================
        const detailPanel = page.locator('div[role="main"]');
        let detailName = '';
        let panelChanged = false;

        for (let attempt = 0; attempt < 5; attempt++) {
          try {
            const h1Elements = await detailPanel.locator('h1, .fontHeadlineLarge, .DUwDf').all();
            for (const h1 of h1Elements) {
              const txt = (await h1.innerText().catch(() => '')).trim();
              if (txt && !txt.toLowerCase().startsWith('resultado') && !txt.toLowerCase().startsWith('pesquisar') && txt.length < 100) {
                detailName = txt;
                break;
              }
            }
          } catch (e) {}

          if (detailName && detailName !== lastPanelName) {
            panelChanged = true;
            break;
          }

          // Se é o primeiro item, qualquer nome válido serve
          if (i === 0 && detailName) {
            panelChanged = true;
            break;
          }

          await delay(600, 1200);
        }

        if (!panelChanged && detailName === lastPanelName && i > 0) {
          log(`⚠️ [SKIP] Painel não mudou após clique (ainda mostra "${lastPanelName}"). Item ${i + 1} ignorado para evitar duplicação.`);
          continue;
        }

        lastPanelName = detailName;

        // Fallback: extrai nome do card clicado se o painel não forneceu H1
        let cardTitle = '';
        if (!detailName) {
          try {
            // Extrai o nome do href da URL do Maps (/maps/place/NOME/...)
            const hrefMatch = itemHref.match(/\/maps\/place\/([^/]+)/);
            if (hrefMatch && hrefMatch[1]) {
              cardTitle = decodeURIComponent(hrefMatch[1].replace(/\+/g, ' ')).split(',')[0].trim();
            }
          } catch (e) {}
        }

        // Seleciona o melhor nome válido
        let name = detailName || cardTitle;
        if (!name || name.toLowerCase().startsWith('resultado') || name === 'Sem nome') {
          name = cardTitle || `Empresa ${i + 1}`;
        }

        // ====================================================================
        //  CHECAGEM DE WEBSITE — Seletores isolados ao painel ativo
        //  Prioriza data-item-id="authority" (mais confiável no Google Maps)
        // ====================================================================
        const websiteLink = detailPanel.locator('a[data-item-id="authority"]');
        const websiteCount = await websiteLink.count();

        if (websiteCount > 0) {
          const siteHref = await websiteLink.first().getAttribute('href').catch(() => '');
          log(`❌ [DISCARDED] "${name}" POSSUI WEBSITE (${siteHref}). Descartado!`);
          totalDiscarded++;
          continue;
        }

        // ====================================================================
        //  TELEFONE — Seletores isolados ao painel ativo
        // ====================================================================
        const phoneElement = detailPanel.locator('button[data-item-id*="phone:"], button[aria-label*="Telefone"], button[aria-label*="Ligar"]');
        let phone = '';

        if (await phoneElement.count() > 0) {
          // Extrai telefone do data-item-id (formato mais confiável: "phone:tel:+55...")
          const phoneDataId = await phoneElement.first().getAttribute('data-item-id').catch(() => '');
          if (phoneDataId && phoneDataId.startsWith('phone:')) {
            phone = phoneDataId.replace('phone:tel:', '').replace('phone:', '').trim();
          }
          
          // Fallback: texto do botão ou aria-label
          if (!phone || phone.length < 8) {
            const phoneText = await phoneElement.first().innerText().catch(() => '');
            const ariaLabel = await phoneElement.first().getAttribute('aria-label').catch(() => '');
            phone = phoneText.replace(/[^\d+()\s-]/g, '').trim() || 
                    ariaLabel.replace(/[^\d+()\s-]/g, '').trim();
          }
        }

        if (!phone || phone.length < 8) {
          log(`⚠️ [DISCARDED] "${name}" não possui site, mas também NÃO possui número de telefone válido.`);
          totalDiscarded++;
          continue;
        }

        // ====================================================================
        //  CATEGORIA E ENDEREÇO — Seletores isolados ao painel ativo
        // ====================================================================
        const categoryElement = detailPanel.locator('button[jsaction*="category"]').first();
        const category = await categoryElement.innerText().catch(() => '');

        const addressElement = detailPanel.locator('button[data-item-id="address"]').first();
        const addressText = await addressElement.innerText().catch(() => '');
        const address = addressText.replace(/^📍\s*/, '').trim();

        // ====================================================================
        //  MAPS URL — Usa o href pré-coletado (estável), nunca page.url()
        // ====================================================================
        let mapsUrl = itemHref;
        if (mapsUrl && !mapsUrl.startsWith('http')) {
          mapsUrl = `https://www.google.com.br${mapsUrl}`;
        }

        // Salva o lead no SQLite3
        const isNew = await saveLead({
          name: name.trim(),
          category: category.trim(),
          address: address.trim(),
          phone: phone.trim(),
          query: searchQuery,
          maps_url: mapsUrl
        });

        if (isNew === 'arquivado') {
          totalArchived++;
          log(`📦 [ARQUIVADO] "${name}" (${category || 'sem categoria'} | Tel: ${phone}) — fora do ICP odonto ou sem celular.`);
        } else if (isNew) {
          totalSaved++;
          log(`✅ [LEAD ENCONTRADO!] "${name}" | Tel: ${phone} | Endereço: ${address || 'N/A'}`);
        } else {
          log(`ℹ️ [DUPLICADO] "${name}" já estava cadastrado no banco.`);
        }

      } catch (itemErr) {
        log(`⚠️ Erro ao extrair item ${i + 1}: ${itemErr.message}`);
      }
    }

    log(`✨ Processo finalizado! Novos Leads Salvos: ${totalSaved} | Arquivados (fora do ICP/sem celular): ${totalArchived} | Descartados com site ou sem tel: ${totalDiscarded}`);

  } catch (err) {
    log(`❌ Erro crítico no Scraper: ${err.message}`);
  } finally {
    if (browser) {
      await browser.close();
    }
    isRunning = false;
    shouldStop = false;
  }
}

module.exports = {
  startScraper,
  stopScraper,
  isScraperRunning: () => isRunning
};
