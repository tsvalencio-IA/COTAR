/*
  CONFIGURAÇÃO OFICIAL - SOS Orçamentos IA
  Atenção verdadeira: qualquer chave colocada em config.js e publicada no GitHub Pages fica visível no navegador.
  Para produção com segurança máxima, use proxy serverless/backend. Para MVP rápido, este arquivo funciona como você pediu.
*/
window.SOS_CONFIG = {
  GROQ_API_KEY: "",
  // A chave real fica em js/api.js conforme solicitado para este MVP.
  GROQ_TRANSCRIPTION_MODEL: "whisper-large-v3-turbo",
  GROQ_CHAT_MODEL: "openai/gpt-oss-20b",
  GROQ_VISION_MODEL: "qwen/qwen3.6-27b",
  OFFICE: {
    nome: "S.O.S. VALÊNCIO",
    cnpj: "06.315.234/0001-04",
    telefone: "17-3011-3186",
    whatsapp: "551730113186",
    endereco: "Av. Sebastião Gonçalves de Souza, 660 - Eldorado, São José do Rio Preto - SP, 15043-005",
    email: "daniflandoli@hotmail.com"
  },
  BRAND: {
    assinatura: "Powered by thIAguinho Soluções Digitais",
    corPrincipal: "#132033",
    corSecundaria: "#25364f"
  },
  PDF: {
    prefixoArquivo: "Orcamento_SOS_Valencio",
    statusPadrao: "Orçamento_Enviado",
    descontoPadrao: 0
  },
  UI: {
    menuCollapsedDefault: true,
    startSection: "secAudio"
  }
};
