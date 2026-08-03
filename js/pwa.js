'use strict';

(() => {
  let deferredPrompt = null;

  const $ = (id) => document.getElementById(id);
  const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent);
  const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

  function showInstallButton() {
    const button = $('installAppBtn');
    if (!button || isStandalone()) return;
    button.classList.remove('hidden');
  }

  function hideInstallButton() {
    const button = $('installAppBtn');
    if (button) button.classList.add('hidden');
  }

  function openHelp(message, title = 'Instalar SOS Orçamentos IA') {
    const modal = $('pwaInstallModal');
    const text = $('pwaInstallMessage');
    const heading = $('pwaInstallTitle');
    if (!modal || !text || !heading) return;
    heading.textContent = title;
    text.innerHTML = message;
    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');
  }

  function closeHelp() {
    const modal = $('pwaInstallModal');
    if (!modal) return;
    modal.classList.add('hidden');
    modal.setAttribute('aria-hidden', 'true');
  }

  async function install() {
    if (isStandalone()) {
      openHelp('O aplicativo já está instalado neste aparelho.', 'Aplicativo instalado');
      return;
    }

    if (deferredPrompt) {
      deferredPrompt.prompt();
      const result = await deferredPrompt.userChoice;
      deferredPrompt = null;
      if (result.outcome === 'accepted') hideInstallButton();
      return;
    }

    if (isIOS()) {
      openHelp(
        '<b>No iPhone ou iPad:</b><br>1. Abra este endereço no <b>Safari</b>.<br>2. Toque no botão <b>Compartilhar</b>.<br>3. Escolha <b>Adicionar à Tela de Início</b>.<br>4. Confirme em <b>Adicionar</b>.'
      );
      return;
    }

    openHelp(
      '<b>No Chrome ou Edge:</b><br>1. Abra o menu do navegador.<br>2. Toque em <b>Instalar app</b> ou <b>Adicionar à tela inicial</b>.<br>3. Confirme a instalação.'
    );
  }

  async function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    try {
      const registration = await navigator.serviceWorker.register('./sw.js', { scope: './' });
      if (registration.waiting) registration.waiting.postMessage('SKIP_WAITING');
    } catch (error) {
      console.error('[SOS Orçamentos IA] Falha ao registrar Service Worker:', error);
    }
  }

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredPrompt = event;
    showInstallButton();
  });

  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    hideInstallButton();
    if (window.App && typeof window.App.toast === 'function') {
      window.App.toast('SOS Orçamentos IA instalado.');
    }
  });

  window.addEventListener('DOMContentLoaded', () => {
    registerServiceWorker();
    if (isStandalone()) {
      document.documentElement.classList.add('pwa-standalone');
      hideInstallButton();
    } else if (isIOS()) {
      showInstallButton();
    } else {
      // Exibe uma alternativa de instrução caso o navegador não dispare o evento.
      window.setTimeout(() => {
        if (!isStandalone() && !deferredPrompt && /android|mobile/i.test(navigator.userAgent)) showInstallButton();
      }, 1800);
    }

    const modal = $('pwaInstallModal');
    if (modal) {
      modal.addEventListener('click', (event) => {
        if (event.target === modal) closeHelp();
      });
    }
  });

  window.PWAInstall = { install, closeHelp };
})();
