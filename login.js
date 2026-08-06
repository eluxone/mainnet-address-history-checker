'use strict';

(() => {
  const CLIENT_BUILD = '2026-08-06.1836';
  const form = document.querySelector('#login-form');
  const passwordInput = document.querySelector('#site-password');
  const button = document.querySelector('#login-button');
  const message = document.querySelector('#login-message');
  const status = document.querySelector('#login-status');

  function showMessage(text) {
    message.textContent = text;
    message.hidden = false;
  }

  function setStatus(text, kind = '') {
    status.textContent = text;
    status.className = kind === 'success' ? 'message success' : 'field-help';
  }

  function safeDestination(value) {
    if (!value || !value.startsWith('/') || value.startsWith('//')) return '/';
    try {
      const destination = new URL(value, window.location.origin);
      return destination.origin === window.location.origin
        ? `${destination.pathname}${destination.search}${destination.hash}`
        : '/';
    } catch {
      return '/';
    }
  }

  async function readJsonResponse(response) {
    const text = await response.text();
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Login service returned HTTP ${response.status} with a non-JSON response. Client build ${CLIENT_BUILD}.`);
    }
  }

  async function checkLoginService() {
    try {
      const response = await fetch('/api/login?status=1', {
        method: 'GET',
        cache: 'no-store',
        credentials: 'same-origin'
      });
      const data = await readJsonResponse(response);
      if (!response.ok) throw new Error(data.error || `Login service returned HTTP ${response.status}.`);
      const environment = data.environment || 'unknown';
      const source = data.source || 'no password variable';
      const configuredText = data.configured ? 'password configured' : 'password missing';
      setStatus(`Login service ready · ${configuredText} · ${source} · ${environment} · server ${data.build || 'unknown'} · client ${CLIENT_BUILD}`, data.configured ? 'success' : '');
    } catch (error) {
      setStatus(error?.message || `Unable to reach login service. Client build ${CLIENT_BUILD}.`);
    }
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    message.hidden = true;
    button.disabled = true;
    button.textContent = 'Checking…';

    try {
      const response = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        credentials: 'same-origin',
        body: JSON.stringify({ password: passwordInput.value })
      });
      const data = await readJsonResponse(response);
      if (!response.ok) {
        const buildText = data.build ? ` Server build ${data.build}.` : '';
        throw new Error(`${data.error || `Login failed with HTTP ${response.status}.`}${buildText}`);
      }

      const params = new URLSearchParams(window.location.search);
      window.location.replace(safeDestination(params.get('next')));
    } catch (error) {
      passwordInput.value = '';
      passwordInput.focus();
      showMessage(error?.message || `Unable to unlock the website. Client build ${CLIENT_BUILD}.`);
    } finally {
      button.disabled = false;
      button.textContent = 'Unlock website';
    }
  });

  checkLoginService();
})();
