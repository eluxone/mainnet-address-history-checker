'use strict';

(() => {
  const form = document.querySelector('#login-form');
  const passwordInput = document.querySelector('#site-password');
  const button = document.querySelector('#login-button');
  const message = document.querySelector('#login-message');

  function showMessage(text) {
    message.textContent = text;
    message.hidden = false;
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
        body: JSON.stringify({ password: passwordInput.value })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Incorrect password.');

      const params = new URLSearchParams(window.location.search);
      const next = params.get('next');
      window.location.replace(next && next.startsWith('/') ? next : '/');
    } catch (error) {
      passwordInput.value = '';
      passwordInput.focus();
      showMessage(error?.message || 'Unable to unlock the website.');
    } finally {
      button.disabled = false;
      button.textContent = 'Unlock website';
    }
  });
})();
