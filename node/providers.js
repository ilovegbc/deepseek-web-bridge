'use strict';

const PROVIDERS = {
  deepseek: {
    id: 'deepseek',
    displayName: 'DeepSeek',
    homeUrl: 'https://chat.deepseek.com/',
    model: 'deepseek-chat',
    supportsCustomTools: true,
    desktopMode: false,
    desktopUserAgent: true,
    readySelector: null,
    loginStrategy: 'deepseek_storage',
    freshChatPerApiRequest: true,
    completionStablePolls: 3,
    sessionPattern: '/a/chat/s/([^/?]+)',
    selectors: {
      composer: 'textarea',
      answer: '.ds-markdown',
      thinking: '.ds-think-content',
      toggleButtons: '.ds-toggle-button',
      generating: '[data-testid="chat-stop-button"], .ds-stop-button, button[aria-label*="Stop"]',
      sendButton: '[data-testid="chat-send-button"], button[aria-label*="Send"], button[aria-label*="发送"]',
      sessionLink: 'a[href*="/a/chat/s/"]',
      contentEditableComposer: false,
      submitWithEnter: false,
      newChatButton: null,
      newChatText: '开启新对话'
    }
  }
};

function getProvider(id) {
  return PROVIDERS[id] || null;
}

module.exports = { PROVIDERS, getProvider };
