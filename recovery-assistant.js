'use strict';

(() => {
  const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
  const TOTAL_WORDS = 12;
  const MAX_CANDIDATES = 2048;
  const BENCHMARK_PHRASE = 'test test test test test test test test test test test junk';
  const PROFILE_LABELS = {
    standard: 'Standard / MetaMask',
    'ledger-live': 'Ledger Live',
    'ledger-legacy': 'Legacy Ledger'
  };
  const POSITION_MULTIPLIERS = {
    known: { 1: 1n, 2: 1n, 3: 1n },
    unknown: { 1: 12n, 2: 66n, 3: 220n }
  };

  const estimatorForm = document.querySelector('#recovery-estimator-form');
  const estimatorProfileInput = document.querySelector('#estimator-profile');
  const estimatorAccountCountInput = document.querySelector('#estimator-account-count');
  const estimatorPositionModeInput = document.querySelector('#estimator-position-mode');
  const estimatorButton = document.querySelector('#run-recovery-estimate');
  const estimatorMessage = document.querySelector('#estimator-message');
  const estimatorMetrics = document.querySelector('#estimator-metrics');
  const estimatorRate = document.querySelector('#estimator-rate');
  const estimatorProfileResult = document.querySelector('#estimator-profile-result');
  const estimatorAccountsResult = document.querySelector('#estimator-accounts-result');
  const estimatorPositionsResult = document.querySelector('#estimator-positions-result');
  const estimatorResults = document.querySelector('#estimator-results');
  const estimatorResultsBody = document.querySelector('#estimator-results-body');
  const estimatorNote = document.querySelector('#estimator-note');

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
  let estimatorRunning = false;

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

  function showEstimatorMessage(text, kind = '') {
    estimatorMessage.textContent = text;
    estimatorMessage.className = `message${kind ? ` ${kind}` : ''}`;
    estimatorMessage.hidden = false;
  }

  function hideEstimatorMessage() {
    estimatorMessage.textContent = '';
    estimatorMessage.className = 'message';
    estimatorMessage.hidden = true;
  }

  function setBusy(value) {
    running = value;
    startButton.disabled = value || estimatorRunning;
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
    estimatorButton.disabled = value || estimatorRunning;
    wordInputs.forEach((input) => { input.disabled = value; });
    startButton.textContent = value ? 'Recovering locally…' : 'Start local recovery';
  }

  function setEstimatorBusy(value) {
    estimatorRunning = value;
    estimatorButton.disabled = value || running;
    estimatorProfileInput.disabled = value;
    estimatorAccountCountInput.disabled = value;
    estimatorPositionModeInput.disabled = value;
    startButton.disabled = value || running;
    estimatorButton.textContent = value ? 'Benchmarking this device…' : 'Benchmark this device';
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

  function benchmarkCandidate(profile, accountCount, sampleIndex) {
    let root = null;
    try {
      root = window.ethers.HDNodeWallet.fromPhrase(
        BENCHMARK_PHRASE,
        `device-benchmark-${sampleIndex}`,
        'm'
      );
      for (let index = 0; index < accountCount; index += 1) {
        root.derivePath(derivationPath(profile, index)).address;
      }
    } finally {
      root = null;
    }
  }

  function checksumValidCandidates(missingWords, positionMode) {
    const rawCombinations = 2048n ** BigInt(missingWords);
    const checksumValid = rawCombinations / 16n;
    return checksumValid * POSITION_MULTIPLIERS[positionMode][missingWords];
  }

  function formatCandidateCount(value) {
    return value.toLocaleString('en-GB');
  }

  function formatRate(value) {
    return `${new Intl.NumberFormat('en-GB', { maximumFractionDigits: value < 10 ? 2 : 1 }).format(value)} / sec`;
  }

  function formatDuration(totalSeconds) {
    if (!Number.isFinite(totalSeconds)) return 'Unavailable';
    if (totalSeconds < 1) return '< 1 second';
    if (totalSeconds < 60) return `${Math.ceil(totalSeconds)} seconds`;

    const minutes = totalSeconds / 60;
    if (minutes < 60) return `${Math.floor(minutes)}m ${Math.round(totalSeconds % 60)}s`;

    const hours = minutes / 60;
    if (hours < 24) return `${Math.floor(hours)}h ${Math.round(minutes % 60)}m`;

    const days = hours / 24;
    if (days < 365.25) return `${Math.floor(days)}d ${Math.round(hours % 24)}h`;

    const years = days / 365.25;
    if (years < 100) return `${new Intl.NumberFormat('en-GB', { maximumFractionDigits: 1 }).format(years)} years`;
    return `${new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 }).format(years)} years`;
  }

  function createEstimatorCell(text, className = '') {
    const cell = document.createElement('td');
    cell.textContent = text;
    if (className) cell.className = className;
    return cell;
  }

  function renderEstimator(rate, profile, accountCount, positionMode) {
    estimatorRate.textContent = formatRate(rate);
    estimatorProfileResult.textContent = PROFILE_LABELS[profile];
    estimatorAccountsResult.textContent = String(accountCount);
    estimatorPositionsResult.textContent = positionMode === 'known' ? 'Exact positions known' : 'Positions unknown';
    estimatorResultsBody.replaceChildren();

    for (let missingWords = 1; missingWords <= 3; missingWords += 1) {
      const candidates = checksumValidCandidates(missingWords, positionMode);
      const candidateNumber = Number(candidates);
      const averageSeconds = (candidateNumber / 2) / rate;
      const worstSeconds = candidateNumber / rate;
      const row = document.createElement('tr');
      row.append(
        createEstimatorCell(String(missingWords)),
        createEstimatorCell(formatCandidateCount(candidates), 'mono'),
        createEstimatorCell(formatDuration(averageSeconds)),
        createEstimatorCell(formatDuration(worstSeconds))
      );
      estimatorResultsBody.append(row);
    }

    estimatorMetrics.hidden = false;
    estimatorResults.hidden = false;
    estimatorNote.hidden = false;
  }

  estimatorForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (running || estimatorRunning) return;
    hideEstimatorMessage();

    try {
      if (!window.ethers?.HDNodeWallet) {
        throw new Error('The local wallet library did not load. Refresh the page and try again.');
      }

      const profile = estimatorProfileInput.value;
      const accountCount = safeInteger(estimatorAccountCountInput, 1, 50, 'Accounts checked per candidate');
      const positionMode = estimatorPositionModeInput.value;
      const samples = accountCount <= 5 ? 32 : accountCount <= 15 ? 20 : accountCount <= 30 ? 12 : 8;
      const warmupSamples = 2;

      setEstimatorBusy(true);
      estimatorMetrics.hidden = true;
      estimatorResults.hidden = true;
      estimatorNote.hidden = true;
      showEstimatorMessage('Warming up the local derivation benchmark…');

      for (let index = 0; index < warmupSamples; index += 1) {
        benchmarkCandidate(profile, accountCount, -index - 1);
      }
      await new Promise(requestAnimationFrame);

      let activeMilliseconds = 0;
      for (let index = 0; index < samples; index += 1) {
        const startedAt = performance.now();
        benchmarkCandidate(profile, accountCount, index);
        activeMilliseconds += performance.now() - startedAt;

        if (index % 4 === 3) {
          showEstimatorMessage(`Benchmarking sample ${index + 1} of ${samples}…`);
          await new Promise(requestAnimationFrame);
        }
      }

      const rate = samples / Math.max(activeMilliseconds / 1000, 0.001);
      renderEstimator(rate, profile, accountCount, positionMode);
      showEstimatorMessage(
        'Benchmark complete. Times are calculated from checksum-valid candidates and the measured local address-derivation rate.',
        'success'
      );
    } catch (error) {
      showEstimatorMessage(error?.message || 'Unable to benchmark this device.');
    } finally {
      setEstimatorBusy(false);
    }
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (running || estimatorRunning) return;
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
