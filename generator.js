'use strict';

(() => {
  const DEFAULT_PATH = "m/44'/60'/0'/0/0";

  const wordCountInput = document.querySelector('#generator-word-count');
  const generateButton = document.querySelector('#generate-wallet-button');
  const clearButton = document.querySelector('#clear-generated-wallet');
  const revealButton = document.querySelector('#reveal-generated-secrets');
  const copyAddressButton = document.querySelector('#copy-generated-address');
  const copyPhraseButton = document.querySelector('#copy-generated-phrase');
  const copyPrivateKeyButton = document.querySelector('#copy-generated-private-key');
  const checkButton = document.querySelector('#check-generated-address');
  const accessTokenInput = document.querySelector('#generator-access-token');
  const output = document.querySelector('#generator-output');
  const addressOutput = document.querySelector('#generated-address');
  const pathOutput = document.querySelector('#generated-path');
  const phraseOutput = document.querySelector('#generated-phrase');
  const privateKeyOutput = document.querySelector('#generated-private-key');
  const message = document.querySelector('#generator-message');

  if (!generateButton) return;

  let secretsVisible = false;

  function showMessage(text, kind = '') {
    message.textContent = text;
    message.className = `message${kind ? ` ${kind}` : ''}`;
    message.hidden = false;
  }

  function hideMessage() {
    message.textContent = '';
    message.className = 'message';
    message.hidden = true;
  }

  function setSecretsVisible(visible) {
    secretsVisible = visible;
    phraseOutput.classList.toggle('secret-hidden', !visible);
    privateKeyOutput.type = visible ? 'text' : 'password';
    revealButton.textContent = visible ? 'Hide seed and private key' : 'Reveal seed and private key';
  }

  function setGeneratedControls(enabled) {
    clearButton.disabled = !enabled;
    revealButton.disabled = !enabled;
    copyAddressButton.disabled = !enabled;
    copyPhraseButton.disabled = !enabled;
    copyPrivateKeyButton.disabled = !enabled;
    checkButton.disabled = !enabled;
  }

  function clearGeneratedWallet() {
    addressOutput.value = '';
    pathOutput.value = '';
    phraseOutput.value = '';
    privateKeyOutput.value = '';
    accessTokenInput.value = '';
    output.hidden = true;
    setSecretsVisible(false);
    setGeneratedControls(false);
    hideMessage();
  }

  async function copyValue(value, label) {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      showMessage(`${label} copied. Clear your clipboard after storing it securely.`, 'success');
    } catch {
      showMessage(`Clipboard access was blocked. Select and copy the ${label.toLowerCase()} manually.`);
    }
  }

  generateButton.addEventListener('click', () => {
    hideMessage();

    if (!window.crypto?.getRandomValues || !window.ethers?.Mnemonic || !window.ethers?.HDNodeWallet) {
      showMessage('Secure browser randomness or the wallet library is unavailable. Refresh the page in a modern browser.');
      return;
    }

    if (!output.hidden) {
      const replace = window.confirm('Generating another wallet will replace the seed phrase and private key currently shown. Continue?');
      if (!replace) return;
    }

    generateButton.disabled = true;
    generateButton.textContent = 'Generating locally…';

    let entropy = null;
    try {
      const wordCount = Number(wordCountInput.value) === 24 ? 24 : 12;
      entropy = new Uint8Array(wordCount === 24 ? 32 : 16);
      window.crypto.getRandomValues(entropy);

      const mnemonic = window.ethers.Mnemonic.fromEntropy(entropy);
      const wallet = window.ethers.HDNodeWallet.fromMnemonic(mnemonic, DEFAULT_PATH);

      addressOutput.value = wallet.address;
      pathOutput.value = wallet.path || DEFAULT_PATH;
      phraseOutput.value = mnemonic.phrase;
      privateKeyOutput.value = wallet.privateKey;
      output.hidden = false;
      setSecretsVisible(false);
      setGeneratedControls(true);
      showMessage(
        `A new ${wordCount}-word wallet was generated only in this browser tab. It is expected to have no previous blockchain activity.`,
        'success'
      );
      output.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (error) {
      clearGeneratedWallet();
      showMessage(error?.message || 'Unable to generate a wallet.');
    } finally {
      entropy?.fill(0);
      generateButton.disabled = false;
      generateButton.textContent = 'Generate one new wallet';
    }
  });

  revealButton.addEventListener('click', () => setSecretsVisible(!secretsVisible));
  clearButton.addEventListener('click', clearGeneratedWallet);
  copyAddressButton.addEventListener('click', () => copyValue(addressOutput.value, 'Public address'));
  copyPhraseButton.addEventListener('click', () => copyValue(phraseOutput.value, 'Recovery phrase'));
  copyPrivateKeyButton.addEventListener('click', () => copyValue(privateKeyOutput.value, 'Private key'));

  checkButton.addEventListener('click', () => {
    const address = addressOutput.value.trim();
    if (!address) {
      showMessage('Generate a wallet first.');
      return;
    }

    window.openDetailedAddress?.(address, accessTokenInput.value);
    window.setTimeout(() => {
      document.querySelector('#address-form')?.requestSubmit();
    }, 100);
  });

  window.addEventListener('pagehide', () => {
    addressOutput.value = '';
    pathOutput.value = '';
    phraseOutput.value = '';
    privateKeyOutput.value = '';
  });

  setGeneratedControls(false);
})();
