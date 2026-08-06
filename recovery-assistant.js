'use strict';

(() => {
  const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
  const TOTAL_WORDS = 12;
  const WORDLIST_SIZE = 2048;
  const MAX_SHORTLIST_WORDS = 32;
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
  const MODE_DETAILS = {
    'missing-one': { targetCount: 1, incorrect: false },
    'incorrect-one': { targetCount: 1, incorrect: true },
    'missing-two': { targetCount: 2, incorrect: false },
    'incorrect-two': { targetCount: 2, incorrect: true }
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
  const incorrectPositionSecondWrap = document.querySelector('#incorrect-position-second-wrap');
  const incorrectPositionSecond = document.querySelector('#incorrect-position-second');
  const twoWordCandidateWrap = document.querySelector('#two-word-candidate-wrap');
  const firstCandidateLabel = document.querySelector('#first-candidate-label');
  const secondCandidateLabel = document.querySelector('#second-candidate-label');
  const firstCandidateInput = document.querySelector('#first-candidate-list');
  const secondCandidateInput = document.querySelector('#second-candidate-list');
  const twoWordConfirmation = document.querySelector('#two-word-confirmation');
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
  const testedMetric = document.querySelector('#seed-tested-count');
  const validMetric = document.querySelector('#seed-valid-count');
  const rateMetric = document.querySelector('#seed-rate');
  const etaMetric = document.querySelector('#seed-eta');
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
  let lastBenchmark = null;

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

  function modeDetails() {
    const details = MODE_DETAILS[modeInput.value];
    if (!details) throw new Error('Select a supported recovery type.');
    return details;
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
    incorrectPositionSecond.disabled = value;
    firstCandidateInput.disabled = value;
    secondCandidateInput.disabled = value;
    twoWordConfirmation.disabled = value;
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

  function formatInteger(value) {
    return new Intl.NumberFormat('en-GB').format(value);
  }

  function formatRate(value) {
    if (!Number.isFinite(value) || value <= 0) return 'Calculating…';
    return `${new Intl.NumberFormat('en-GB', {
      maximumFractionDigits: value < 10 ? 2 : 1
    }).format(value)} / sec`;
  }

  function formatDuration(totalSeconds) {
    if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return 'Calculating…';
    if (totalSeconds < 1) return '< 1 second';
    if (totalSeconds < 60) return `${Math.ceil(totalSeconds)} seconds`;

    const minutes = totalSeconds / 60;
    if (minutes < 60) return `${Math.floor(minutes)}m ${Math.round(totalSeconds % 60)}s`;

    const hours = minutes / 60;
    if (hours < 24) return `${Math.floor(hours)}h ${Math.round(minutes % 60)}m`;

    const days = hours / 24;
    if (days < 365.25) return `${Math.floor(days)}d ${Math.round(hours % 24)}h`;

    const years = days / 365.25;
    if (years < 100) {
      return `${new Intl.NumberFormat('en-GB', { maximumFractionDigits: 1 }).format(years)} years`;
    }
    return `${new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 }).format(years)} years`;
  }

  function updateProgress(tested, total, checksumValid, startedAt) {
    const elapsedSeconds = startedAt
      ? Math.max((performance.now() - startedAt) / 1000, 0.001)
      : 0;
    const rate = elapsedSeconds ? tested / elapsedSeconds : 0;
    const etaSeconds = rate > 0 ? Math.max(total - tested, 0) / rate : null;

    progress.max = total || 1;
    progress.value = Math.min(tested, total || 1);
    progressLabel.textContent = `${formatInteger(tested)} / ${formatInteger(total)}`;
    testedMetric.textContent = formatInteger(tested);
    validMetric.textContent = formatInteger(checksumValid);
    rateMetric.textContent = formatRate(rate);
    etaMetric.textContent = etaSeconds === null ? 'Calculating…' : formatDuration(etaSeconds);
    return { rate, etaSeconds };
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
    firstCandidateInput.value = '';
    secondCandidateInput.value = '';
    knownAddressInput.value = '';
    passphraseInput.value = '';
    ownershipInput.checked = false;
    twoWordConfirmation.checked = false;
    clearResult();
    hideMessage();
    progressPanel.hidden = true;
    updateProgress(0, 1, 0, null);
    status.textContent = 'Ready';
    wordInputs[0]?.focus();
  }

  function selectedTargetIndexes(words) {
    const { targetCount, incorrect } = modeDetails();
    if (incorrect) {
      const indexes = [Number(incorrectPosition.value)];
      if (targetCount === 2) indexes.push(Number(incorrectPositionSecond.value));
      return indexes;
    }
    return words
      .map((word, index) => word ? -1 : index)
      .filter((index) => index >= 0);
  }

  function updateCandidateLabels() {
    const words = collectWords();
    const { targetCount } = modeDetails();
    if (targetCount !== 2) return;

    const indexes = selectedTargetIndexes(words);
    firstCandidateLabel.textContent = indexes[0] === undefined
      ? 'Candidate words for first position'
      : `Candidate words for Word ${indexes[0] + 1}`;
    secondCandidateLabel.textContent = indexes[1] === undefined
      ? 'Candidate words for second position'
      : `Candidate words for Word ${indexes[1] + 1}`;
  }

  function updateModeUi() {
    const { targetCount, incorrect } = modeDetails();
    incorrectWrap.hidden = !incorrect;
    incorrectPositionSecondWrap.hidden = !(incorrect && targetCount === 2);
    twoWordCandidateWrap.hidden = targetCount !== 2;

    if (targetCount === 2) {
      countInput.max = '10';
      if (Number(countInput.value) > 10) countInput.value = '10';
      modeHelp.textContent = incorrect
        ? 'Enter all 12 current words, select two exact positions, and provide a candidate shortlist for each position.'
        : 'Leave exactly two word boxes empty and provide a candidate shortlist for each missing position.';
    } else {
      countInput.max = '50';
      modeHelp.textContent = incorrect
        ? 'Enter all 12 current words and select the exact incorrect position.'
        : 'Leave exactly one numbered word box empty where the missing word belongs.';
      firstCandidateInput.value = '';
      secondCandidateInput.value = '';
      twoWordConfirmation.checked = false;
    }
    updateCandidateLabels();
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
      input.addEventListener('input', updateCandidateLabels);
      input.addEventListener('paste', (event) => {
        const text = event.clipboardData?.getData('text') || '';
        const words = text.trim().split(/\s+/).map(normalizeWord).filter(Boolean);
        if (words.length <= 1) return;
        event.preventDefault();
        words.slice(0, TOTAL_WORDS - index).forEach((word, offset) => {
          wordInputs[index + offset].value = word;
        });
        updateCandidateLabels();
      });

      wrap.append(label, input);
      wordGrid.append(wrap);
      wordInputs.push(input);

      for (const select of [incorrectPosition, incorrectPositionSecond]) {
        const option = document.createElement('option');
        option.value = String(index);
        option.textContent = `Word ${index + 1}`;
        select.append(option);
      }
    }
    incorrectPositionSecond.value = '1';
  }

  function collectWords() {
    return wordInputs.map((input) => normalizeWord(input.value));
  }

  function wordExists(word) {
    try {
      window.ethers.wordlists.en.getWordIndex(word);
      return true;
    } catch {
      return false;
    }
  }

  function parseCandidateList(input, label) {
    const words = input.value
      .normalize('NFKD')
      .toLowerCase()
      .split(/[\s,;]+/)
      .map((word) => word.trim())
      .filter(Boolean);
    const unique = [...new Set(words)];

    if (!unique.length) {
      throw new Error(`Enter at least one ${label.toLowerCase()}.`);
    }
    if (unique.length > MAX_SHORTLIST_WORDS) {
      throw new Error(`${label} can contain no more than ${MAX_SHORTLIST_WORDS} unique words.`);
    }
    for (const word of unique) {
      if (!wordExists(word)) {
        throw new Error(`“${word}” in ${label.toLowerCase()} is not an English BIP-39 word.`);
      }
    }
    return unique;
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

    const { targetCount, incorrect } = modeDetails();
    const words = collectWords();
    let targetIndexes;

    if (incorrect) {
      if (words.some((word) => !word)) {
        throw new Error('Enter all 12 current words for incorrect-word recovery.');
      }
      targetIndexes = selectedTargetIndexes(words);
      if (new Set(targetIndexes).size !== targetIndexes.length) {
        throw new Error('Select two different incorrect-word positions.');
      }
    } else {
      targetIndexes = selectedTargetIndexes(words);
      if (targetIndexes.length !== targetCount) {
        throw new Error(`Leave exactly ${targetCount} word box${targetCount === 1 ? '' : 'es'} empty.`);
      }
    }

    const targetSet = new Set(targetIndexes);
    for (let index = 0; index < words.length; index += 1) {
      if (targetSet.has(index)) continue;
      if (!wordExists(words[index])) {
        throw new Error(`Word ${index + 1} is not in the English BIP-39 word list.`);
      }
    }

    let candidateLists;
    if (targetCount === 1) {
      candidateLists = [[...Array(WORDLIST_SIZE)].map((_, index) => window.ethers.wordlists.en.getWord(index))];
    } else {
      if (!twoWordConfirmation.checked) {
        throw new Error('Confirm that the two-word search is limited to your supplied candidate shortlists.');
      }
      candidateLists = [
        parseCandidateList(firstCandidateInput, 'First candidate list'),
        parseCandidateList(secondCandidateInput, 'Second candidate list')
      ];
    }

    if (incorrect) {
      candidateLists = candidateLists.map((list, offset) =>
        list.filter((word) => word !== words[targetIndexes[offset]])
      );
      if (candidateLists.some((list) => !list.length)) {
        throw new Error('Each incorrect-word candidate list must contain at least one word different from the current word.');
      }
    }

    const maximumAccounts = targetCount === 2 ? 10 : 50;
    const start = safeInteger(startInput, 0, 200, 'Starting account index');
    const count = safeInteger(countInput, 1, maximumAccounts, 'Accounts to check');

    return {
      words,
      targetIndexes,
      candidateLists,
      knownAddress,
      profile: profileInput.value,
      start,
      count,
      passphrase: passphraseInput.value.normalize('NFKD'),
      targetCount
    };
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
    estimatorPositionsResult.textContent = positionMode === 'known'
      ? 'Exact positions known'
      : 'Positions unknown';
    estimatorResultsBody.replaceChildren();

    for (let missingWords = 1; missingWords <= 3; missingWords += 1) {
      const candidates = checksumValidCandidates(missingWords, positionMode);
      const candidateNumber = Number(candidates);
      const averageSeconds = (candidateNumber / 2) / rate;
      const worstSeconds = candidateNumber / rate;
      const row = document.createElement('tr');
      row.append(
        createEstimatorCell(String(missingWords)),
        createEstimatorCell(candidates.toLocaleString('en-GB'), 'mono'),
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
      lastBenchmark = { rate, profile, accountCount };
      renderEstimator(rate, profile, accountCount, positionMode);
      showEstimatorMessage(
        'Benchmark complete. Times use checksum-valid candidates and this device’s measured derivation rate.',
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
      const payload = validateInputs();
      const total = payload.candidateLists.reduce((product, list) => product * list.length, 1);
      const candidateWords = [...payload.words];
      const startedAt = performance.now();
      let tested = 0;
      let checksumValid = 0;

      stopRequested = false;
      setBusy(true);
      progressPanel.hidden = false;
      updateProgress(0, total, 0, startedAt);

      let preflight = `Testing ${formatInteger(total)} local candidate combination${total === 1 ? '' : 's'}`;
      if (
        lastBenchmark &&
        lastBenchmark.profile === payload.profile &&
        lastBenchmark.accountCount === payload.count
      ) {
        preflight += ` · worst case approximately ${formatDuration(total / lastBenchmark.rate)}`;
      }
      status.textContent = preflight;

      searchLoop:
      for (let firstIndex = 0; firstIndex < payload.candidateLists[0].length; firstIndex += 1) {
        const firstWord = payload.candidateLists[0][firstIndex];
        candidateWords[payload.targetIndexes[0]] = firstWord;

        const secondList = payload.targetCount === 2 ? payload.candidateLists[1] : [null];
        for (let secondIndex = 0; secondIndex < secondList.length; secondIndex += 1) {
          if (stopRequested) break searchLoop;

          if (payload.targetCount === 2) {
            candidateWords[payload.targetIndexes[1]] = secondList[secondIndex];
          }

          const phrase = candidateWords.join(' ');
          tested += 1;

          if (window.ethers.Mnemonic.isValidMnemonic(phrase)) {
            checksumValid += 1;
            const match = await candidateMatches(
              phrase,
              payload.knownAddress,
              payload.profile,
              payload.start,
              payload.count,
              payload.passphrase
            );

            if (match) {
              resultInput.value = phrase;
              matchedPath.textContent = `Verified ${PROFILE_LABELS[payload.profile]} address at ${match.path}`;
              resultPanel.hidden = false;
              updateProgress(tested, total, checksumValid, startedAt);
              status.textContent = 'Match found';
              showMessage(
                'A matching phrase was found and verified against the supplied public address.',
                'success'
              );
              wordInputs.forEach((input) => { input.value = ''; });
              firstCandidateInput.value = '';
              secondCandidateInput.value = '';
              passphraseInput.value = '';
              ownershipInput.checked = false;
              twoWordConfirmation.checked = false;
              return;
            }
          }

          if (tested % 8 === 0 || tested === total) {
            const live = updateProgress(tested, total, checksumValid, startedAt);
            status.textContent = live.etaSeconds === null
              ? 'Testing local candidates…'
              : `Testing local candidates · estimated time remaining ${formatDuration(live.etaSeconds)}`;
            await new Promise(requestAnimationFrame);
          }
        }
      }

      updateProgress(tested, total, checksumValid, startedAt);
      if (stopRequested) {
        status.textContent = 'Stopped by user';
        showMessage('Recovery stopped.');
      } else {
        status.textContent = 'Search complete';
        showMessage(
          'No matching phrase was found. Check the candidate shortlists, exact positions, known address, derivation profile, account range and optional BIP-39 passphrase.'
        );
      }
    } catch (error) {
      showMessage(error?.message || 'Unable to run local recovery.');
    } finally {
      setBusy(false);
    }
  });

  modeInput.addEventListener('change', updateModeUi);
  incorrectPosition.addEventListener('change', updateCandidateLabels);
  incorrectPositionSecond.addEventListener('change', updateCandidateLabels);

  stopButton.addEventListener('click', () => {
    stopRequested = true;
    stopButton.disabled = true;
    status.textContent = 'Stopping local recovery…';
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
  updateProgress(0, 1, 0, null);
})();
