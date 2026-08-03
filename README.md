# SOS Orçamentos IA - versão final usável

Arquivos:
- index.html
- config.js

Suba os dois arquivos no GitHub Pages.
Edite o `config.js` com a chave Groq e dados da oficina.

Fluxo recomendado:
1. Abra o sistema.
2. Use a aba Áudio para gravar/enviar áudio.
3. Revise e edite manualmente em Orçamento.
4. Complete cabeçalho e dados em Dados.
5. Confira o Preview antes de gerar PDF.
6. Gere PDF ou envie resumo pelo WhatsApp.

Observação: em GitHub Pages, qualquer chave colocada em config.js fica visível no navegador. Para uso interno/MVP funciona, mas para produção use proxy/backend.


## Chave Groq
A chave foi movida para `js/api.js` conforme solicitado. O `config.js` fica sem a chave real.

## Comparador inteligente de preços — atualização 03/08/2026

A nova aba **Comparar** permite interpretar a lista solicitada, cadastrar vários fornecedores, colar respostas em texto, ler fotos de tabelas, relacionar nomenclaturas diferentes e calcular a compra completa mais econômica.

O comparador salva seus dados separadamente no navegador e não apaga o orçamento principal. O arquivo `comparador-exemplo-uno.json` contém o exemplo real usado na validação.
