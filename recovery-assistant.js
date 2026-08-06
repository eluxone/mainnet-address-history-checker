'use strict';

(() => {
  const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
  const TOTAL_WORDS = 12;
  const MAX_CANDIDATES = 2048;
  const PROFILE_LABELS = {
    standard: 'Standard / MetaMask',
    'ledger-live': 'Ledger Live',
    'ledger-legacy': 'Legacy Ledger'
  };

  const form = document.querySelector('#seed-recovery-form');
  const modeInput = document.querySelector('#recovery-mode');
  const modeHelp = document.querySelector('#mode-help');
  const wordGrid = document.querySelector('#word-grid');
  const incorrectWrap = document.querySelector('#incorrect-position-wrap');
  const incorrectPosition = document.querySelector('#incorrect-position');
  const knownAddressInput = document.querySelector('#known-recovery-address');
  const profileInput = document.querySelector('#recovery-profile');
  const startInput = document.querySelector('#account-start');
  const countInput = document.querySelector('#account-count');
  const passphraseInput = document.querySelector('#bip39-passphrase');
  const ownershipInput = document.querySelector('#recovery-ownership');
  const startButton = document.querySelector('#start-seed-recovery');
  const stopButton = document.querySelector('#stop-seed-recovery');
  const clearButton = document.querySelector('#clear-seed-recovery');
  const message = document.querySelector('#seed-recovery-message');
  const progressPanel = document.querySelector('#seed-progress-panel');
  const progress = document.querySelector('#seed-progress');
  const progressLabel = document.querySelector('#seed-progress-label');
  const status = document.querySelector('#seed-status');
  const resultPanel = document.querySelector('#seed-result-panel');
  const resultInput = document.querySelector('#seed-result');
  const matchedPath = document.querySelector('#matched-path');
  const revealButton = document.querySelector('#reveal-seed-result');
  const copyButton = document.querySelector('#copy-seed-result');
  const eraseButton = document.querySelector('#erase-seed-result');

  const wordInputs = [];
  let stopRequested = false;
  let running = false;

  function normalizeWord(value) {
    return value.normalize('NFKD').trim().toLowerCase();
  }

  function derivationPath(profile, index) {
    if (profile === 'standard') return `m/44'/60'/0'/0/${index}`;
    if (profile === 'ledger-live') return `m/44'/60'/${index}'/0/0`;
    if (profile === 'ledger-legacy') return `m/44'/60'/0'/${index}`;
    throw new Error('Unsupported derivation profile.');
  }

  function safeInteger(input, min, max, label) {
    const value = Number(input.value);
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      throw new Error(`${label} must be between ${min} and ${max}.`);
    }
    return value;
  }

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

  function setBusy(value) {
    running = value;
    startButton.disabled = value;
    stopButton.disabled = !value;
    clearButton.disabled = value;
    modeInput.disabled = value;
    incorrectPosition.disabled = value;
    knownAddressInput.disabled = value;
    profileInput.disabled = value;
    startInput.disabled = value;
    countInput.disabled = value;
    passphraseInput.disabled = value;
    ownershipInput.disabled = value;
    wordInputs.forEach((input) => { input.disabled = value; });
    startButton.textContent = value ? 'Recovering locally…' : 'Start local recovery';
  }

  function updateProgress(done, total, text) {
    progress.max = total || 1;
    progress.value = done;
    progressLabel.textContent = `${done} / ${total}`;
    status.textContent = text;
  }

  function clearResult() {
    resultInput.value = '';
    resultInput.classList.add('secret-hidden');
    revealButton.textContent = 'Reveal result';
    matchedPath.textContent = '';
    resultPanel.hidden = true;
  }

  function clearSensitiveData() {
    stopRequested = true;
    wordInputs.forEach((input) => { input.value = ''; });
    knownAddressInput.value = '';
    passphraseInput.value = '';
    ownershipInput.checked = false;
    clearResult();
    hideMessage();
    progressPanel.hidden = true;
    updateProgress(0, 1, 'Ready');
    wordInputs[0]?.focus();
  }

  function updateModeUi() {
    const incorrect = modeInput.value === 'incorrect';
    incorrectWrap.hidden = !incorrect;
    modeHelp.textContent = incorrect
      ? 'Enter all 12 words, then choose the numbered position containing the incorrect word.'
      : 'Leave exactly one numbered word box empty where the missing word belongs.';
  }

  function buildWordInputs() {
    for (let index = 0; index < TOTAL_WORDS; index += 1) {
      const wrap = document.createElement('div');
      wrap.className = 'word-field';
      const label = document.createElement('label');
      label.htmlFor = `seed-word-${index + 1}`;
      label.textContent = `Word ${index + 1}`;
      const input = document.createElement('input');
      input.id = `seed-word-${index + 1}`;
      input.type = 'password';
      input.autocomplete = 'off';
      input.autocapitalize = 'off';
      input.spellcheck = false;
      input.placeholder = 'word';
      input.addEventListener('paste', (event) => {
        const text = event.clipboardData?.getData('text') || '';
        const words = text.trim().split(/\s+/).map(normalizeWord).filter(Boolean);
        if (words.length <= 1) return;
        event.preventDefault();
        words.slice(0, TOTAL_WORDS - index).forEach((word, offset) => {
          wordInputs[index + offset].value = word;
        });
      });
      wrap.append(label, input);
      wordGrid.append(wrap);
      wordInputs.push(input);

      const option = document.createElement('option');
      option.value = String(index);
      option.textContent = `Word ${index + 1}`;
      incorrectPosition.append(option);
    }
  }

  function collectWords() {
    return wordInputs.map((input) => normalizeWord(input.value));
  }

  function validateInputs() {
    if (!window.ethers?.HDNodeWallet || !window.ethers?.Mnemonic || !window.ethers?.wordlists?.en) {
      throw new Error('The local wallet library did not load. Refresh the page and try again.');
    }
    if (!ownershipInput.checked) {
      throw new Error('Confirm that you own or are authorized to recover this wallet.');
    }
    const knownAddress = knownAddressInput.value.trim();
    if (!ADDRESS_RE.test(knownAddress)) {
      throw new Error('Enter a valid known public Ethereum address beginning with 0x.');
    }

    const words = collectWords();
    if (modeInput.value === 'missing') {
      const blankIndexes = words.map((word, index) => word ? -1 : index).filter((index) => index >= 0);
      if (blankIndexes.length !== 1) {
        throw new Error('Leave exactly one word box empty at the missing position.');
      }
      return { words, targetIndex: blankIndexes[0], knownAddress };
    }

    if (words.some((word) => !word)) {
      throw new Error('Enter all 12 words for incorrect-word recovery.');
    }
    return { words, targetIndex: Number(incorrectPosition.value), knownAddress };
  }

  async function candidateMatches(candidatePhrase, knownAddress, profile, start, count, passphrase) {
    if (!window.ethers.Mnemonic.isValidMnemonic(candidatePhrase)) return null;
    let root = null;
    try {
      root = window.ethers.HDNodeWallet.fromPhrase(candidatePhrase, passphrase, 'm');
      const target = knownAddress.toLowerCase();
      for (let offset = 0; offset < count; offset += 1) {
        const index = start + offset;
        const path = derivationPath(profile, index);
        const derived = root.derivePath(path).address;
        if (derived.toLowerCase() === target) return { path, address: derived, index };
      }
      return null;
    } finally {
      root = null;
    }
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (running) return;
    hideMessage();
    clearResult();

    try {
      const { words, targetIndex, knownAddress } = validateInputs();
      const start = safeInteger(startInput, 0, 200, 'Starting account index');
      const count = safeInteger(countInput, 1, 50, 'Accounts to check');
      const profile = profileInput.value;
      const passphrase = passphraseInput.value.normalize('NFKD');
      const wordlist = window.ethers.wordlists.en;
      const currentWord = words[targetIndex];

      stopRequested = false;
      setBusy(true);
      progressPanel.hidden = false;
      updateProgress(0, MAX_CANDIDATES, `Testing candidates for word ${targetIndex + 1}…`);

      for (let candidateIndex = 0; candidateIndex < MAX_CANDIDATES; candidateIndex += 1) {
        if (stopRequested) throw new DOMException('Stopped', 'AbortError');
        const candidateWord = wordlist.getWord(candidateIndex);
        if (modeInput.value === 'incorrect' && candidateWord === currentWord) {
          updateProgress(candidateIndex + 1, MAX_CANDIDATES, `Testing candidates for word ${targetIndex + 1}…`);
          continue;
        }

        const candidateWords = [...words];
        candidateWords[targetIndex] = candidateWord;
        const phrase = candidateWords.join(' ');
        const match = await candidateMatches(phrase, knownAddress, profile, start, count, passphrase);
        if (match) {
          resultInput.value = phrase;
          matchedPath.textContent = `Verified ${PROFILE_LABELS[profile]} address at ${match.path}`;
          resultPanel.hidden = false;
          showMessage('A matching phrase was found and verified against the supplied public address.', 'success');
          updateProgress(candidateIndex + 1, MAX_CANDIDATES, 'Match found');
          wordInputs.forEach((input) => { input.value = ''; });
          passphraseInput.value = '';
          ownershipInput.checked = false;
          return;
        }

        if (candidateIndex % 8 === 0) {
          updateProgress(candidateIndex + 1, MAX_CANDIDATES, `Testing candidates for word ${targetIndex + 1}…`);
          await new Promise(requestAnimationFrame);
        }
      }

      updateProgress(MAX_CANDIDATES, MAX_CANDIDATES, 'Search complete');
      showMessage('No matching phrase was found. Check the word position, public address, derivation profile, account range, and optional BIP-39 passphrase.');
    } catch (error) {
      if (error?.name === 'AbortError') showMessage('Recovery stopped.');
      else showMessage(error?.message || 'Unable to run local recovery.');
    } finally {
      setBusy(false);
    }
  });

  modeInput.addEventListener('change', updateModeUi);
  stopButton.addEventListener('click', () => {
    stopRequested = true;
    stopButton.disabled = true;
    status.textContent = 'Stopping…';
  });
  clearButton.addEventListener('click', clearSensitiveData);
  revealButton.addEventListener('click', () => {
    const hidden = resultInput.classList.toggle('secret-hidden');
    revealButton.textContent = hidden ? 'Reveal result' : 'Hide result';
  });
  copyButton.addEventListener('click', async () => {
    if (!resultInput.value) return;
    try {
      await navigator.clipboard.writeText(resultInput.value);
      showMessage('Recovered phrase copied. Clear the clipboard after use.', 'success');
    } catch {
      showMessage('Clipboard access was blocked. Reveal the result and copy it manually.');
    }
  });
  eraseButton.addEventListener('click', clearResult);
  window.addEventListener('pagehide', clearSensitiveData);

  buildWordInputs();
  updateModeUi();
})();
