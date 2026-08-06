'use strict';

(() => {
  const PROFILE_LABELS = {
    standard: 'Standard / MetaMask',
    'ledger-live': 'Ledger Live',
    'ledger-legacy': 'Legacy Ledger'
  };

  const recoveryForm = document.querySelector('#recovery-form');
  const phraseInput = document.querySelector('#recovery-phrase');
  const passphraseInput = document.querySelector('#recovery-passphrase');
  const profileInput = document.querySelector('#derivation-profile');
  const startInput = document.querySelector('#recovery-start');
  const countInput = document.querySelector('#recovery-count');
  const recoveryAccessToken = document.querySelector('#recovery-access-token');
  const stopGapInput = document.querySelector('#stop-gap');
  const ownershipInput = document.querySelector('#ownership-confirmation');
  const auditButton = document.querySelector('#audit-button');
  const stopButton = document.querySelector('#stop-audit-button');
  const clearButton = document.querySelector('#clear-recovery-button');
  const togglePhraseButton = document.querySelector('#toggle-phrase');
  const pastePhraseButton = document.querySelector('#paste-phrase');
  const recoveryMessage = document.querySelector('#recovery-message');
  const progressPanel = document.querySelector('#recovery-progress-panel');
  const progressBar = document.querySelector('#recovery-progress');
  const progressLabel = document.querySelector('#recovery-progress-label');
  const recoveryStatus = document.querySelector('#recovery-status');
  const scannedMetric = document.querySelector('#recovery-scanned');
  const foundMetric = document.querySelector('#recovery-found-count');
  const errorMetric = document.querySelector('#recovery-error-count');
  const currentPathMetric = document.querySelector('#recovery-current-path');
  const recoveryResults = document.querySelector('#recovery-results');
  const recoveryResultsBody = document.querySelector('#recovery-results-body');
  const recoveryEmpty = document.querySelector('#recovery-empty');
  const exportButton = document.querySelector('#export-recovery');

  let auditRunning = false;
  let stopRequested = false;
  let activeFetchController = null;
  let foundResults = [];

  function showRecoveryMessage(text, kind = '') {
    recoveryMessage.textContent = text;
    recoveryMessage.className = `message${kind ? ` ${kind}` : ''}`;
    recoveryMessage.hidden = false;
  }

  function hideRecoveryMessage() {
    recoveryMessage.textContent = '';
    recoveryMessage.className = 'message';
    recoveryMessage.hidden = true;
  }

  function normalizePhrase(value) {
    return value.normalize('NFKD').trim().toLowerCase().split(/\s+/).join(' ');
  }

  function safeInteger(input, min, max, label) {
    const value = Number(input.value);
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      throw new Error(`${label} must be between ${min} and ${max}.`);
    }
    return value;
  }

  function setAuditBusy(value) {
    auditRunning = value;
    auditButton.disabled = value;
    stopButton.disabled = !value;
    clearButton.disabled = value;
    togglePhraseButton.disabled = value;
    pastePhraseButton.disabled = value;
    profileInput.disabled = value;
    startInput.disabled = value;
    countInput.disabled = value;
    stopGapInput.disabled = value;
    ownershipInput.disabled = value;
    auditButton.textContent = value ? 'Auditing EVM networks…' : 'Start recovery audit';
  }

  function updateProgress(scanned, total, found, errors, path, status) {
    progressBar.max = total || 1;
    progressBar.value = scanned;
    progressLabel.textContent = `${scanned} / ${total}`;
    scannedMetric.textContent = String(scanned);
    foundMetric.textContent = String(found);
    errorMetric.textContent = String(errors);
    currentPathMetric.textContent = path || '—';
    recoveryStatus.textContent = status || 'Working…';
  }

  function derivationPath(profile, index) {
    if (profile === 'standard') return `m/44'/60'/0'/0/${index}`;
    if (profile === 'ledger-live') return `m/44'/60'/${index}'/0/0`;
    if (profile === 'ledger-legacy') return `m/44'/60'/0'/${index}`;
    throw new Error('Unsupported derivation profile.');
  }

  function appendFoundResult(item) {
    foundResults.push(item);
    recoveryEmpty.hidden = true;
    exportButton.disabled = false;

    const row = document.createElement('tr');
    const values = [
      String(item.index),
      item.path,
      item.address,
      (item.activeNetworks || []).join(', ') || '—'
    ];

    values.forEach((value, index) => {
      const cell = document.createElement('td');
      cell.textContent = value;
      if (index === 1 || index === 2) cell.className = 'mono';
      row.append(cell);
    });

    const evidenceCell = document.createElement('td');
    const tags = document.createElement('div');
    tags.className = 'evidence-tags';
    for (const evidence of item.evidence || []) {
      const tag = document.createElement('span');
      tag.className = 'evidence-tag';
      tag.textContent = evidence;
      tags.append(tag);
    }
    evidenceCell.append(tags);
    row.append(evidenceCell);

    const actionCell = document.createElement('td');
    const detailsButton = document.createElement('button');
    detailsButton.type = 'button';
    detailsButton.className = 'secondary small-button';
    detailsButton.textContent = 'Detailed history';
    detailsButton.addEventListener('click', () => {
      window.openDetailedAddress?.(item.address, recoveryAccessToken.value);
    });
    actionCell.append(detailsButton);
    row.append(actionCell);

    recoveryResultsBody.append(row);
  }

  async function checkAddressBatch(addresses, accessToken) {
    activeFetchController = new AbortController();
    const response = await fetch('/api/audit-addresses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-App-Access-Token': accessToken
      },
      body: JSON.stringify({ addresses }),
      signal: activeFetchController.signal
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Audit request failed (${response.status}).`);
    return data.results || [];
  }

  function resetRecoveryResults() {
    foundResults = [];
    recoveryResultsBody.replaceChildren();
    recoveryEmpty.hidden = false;
    exportButton.disabled = true;
    recoveryResults.hidden = false;
  }

  function clearSensitiveFields() {
    phraseInput.value = '';
    passphraseInput.value = '';
    ownershipInput.checked = false;
    phraseInput.classList.add('secret-hidden');
    togglePhraseButton.textContent = 'Reveal phrase';
  }

  recoveryForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (auditRunning) return;
    hideRecoveryMessage();

    let scanned = 0;
    let errors = 0;
    let consecutiveEmpty = 0;
    let consecutiveTotalFailures = 0;
    let root = null;

    try {
      if (!window.ethers?.HDNodeWallet || !window.ethers?.Mnemonic) {
        throw new Error('The local wallet-derivation library did not load. Refresh the page and try again.');
      }
      if (!ownershipInput.checked) {
        throw new Error('Confirm that you own or are authorized to recover this phrase.');
      }
      const accessToken = recoveryAccessToken.value;
      if (!accessToken) {
        throw new Error('Enter the private APP_ACCESS_TOKEN configured in Vercel.');
      }

      const phrase = normalizePhrase(phraseInput.value);
      if (!window.ethers.Mnemonic.isValidMnemonic(phrase)) {
        throw new Error('The recovery phrase is not a valid checksum-protected BIP-39 English phrase.');
      }
      phraseInput.value = phrase;

      const start = safeInteger(startInput, 0, 0x7fffffff, 'Starting index');
      const count = safeInteger(countInput, 1, 1000, 'Maximum addresses');
      if (start + count - 1 > 0x7fffffff) {
        throw new Error('The requested address range exceeds the maximum BIP-32 index.');
      }

      const profile = profileInput.value;
      stopRequested = false;
      resetRecoveryResults();
      progressPanel.hidden = false;
      updateProgress(0, count, 0, 0, '—', 'Validating and preparing local derivation…');
      setAuditBusy(true);

      root = window.ethers.HDNodeWallet.fromPhrase(phrase, passphraseInput.value, 'm');
      const chunkSize = 1;

      for (let offset = 0; offset < count && !stopRequested; offset += chunkSize) {
        const chunk = [];
        const size = Math.min(chunkSize, count - offset);

        for (let position = 0; position < size && !stopRequested; position += 1) {
          const index = start + offset + position;
          const path = derivationPath(profile, index);
          const wallet = root.derivePath(path);
          chunk.push({ index, path, address: wallet.address });
          currentPathMetric.textContent = path;
        }

        if (stopRequested || chunk.length === 0) break;
        updateProgress(
          scanned,
          count,
          foundResults.length,
          errors,
          chunk[0].path,
          `Checking ${PROFILE_LABELS[profile]} address across supported EVM networks…`
        );

        const checked = await checkAddressBatch(chunk, accessToken);
        for (const item of checked) {
          scanned += 1;
          errors += Number(item.networkErrorCount || 0);

          if (item.error) {
            consecutiveEmpty = 0;
            consecutiveTotalFailures += 1;
          } else if (item.activityFound) {
            consecutiveEmpty = 0;
            consecutiveTotalFailures = 0;
            appendFoundResult(item);
          } else if (Number(item.successfulNetworkCount || 0) > 0) {
            consecutiveEmpty += 1;
            consecutiveTotalFailures = 0;
          } else {
            consecutiveEmpty = 0;
            consecutiveTotalFailures += 1;
          }

          updateProgress(
            scanned,
            count,
            foundResults.length,
            errors,
            item.path,
            `Checked ${scanned} address${scanned === 1 ? '' : 'es'}…`
          );
        }

        if (consecutiveTotalFailures >= 3) {
          throw new Error('The provider failed all network checks for three consecutive addresses. The audit stopped to prevent unreliable results. Wait a few minutes, verify the enabled Alchemy chains, and try again.');
        }

        if (stopGapInput.checked && consecutiveEmpty >= 50) {
          recoveryStatus.textContent = 'Stopped after 50 consecutive addresses with no returned evidence.';
          break;
        }

        await new Promise((resolve) => setTimeout(resolve, 900));
      }

      const errorText = errors > 0
        ? ` ${errors} network check${errors === 1 ? '' : 's'} failed and were not treated as empty results.`
        : '';
      const summary = stopRequested
        ? `Audit stopped after ${scanned} addresses. ${foundResults.length} address${foundResults.length === 1 ? '' : 'es'} returned activity evidence.${errorText}`
        : `Audit finished. Checked ${scanned} address${scanned === 1 ? '' : 'es'} and found ${foundResults.length} with returned activity evidence.${errorText}`;

      updateProgress(
        scanned,
        count,
        foundResults.length,
        errors,
        currentPathMetric.textContent,
        stopRequested ? 'Stopped by user' : 'Audit complete'
      );
      showRecoveryMessage(summary, errors > 0 ? '' : 'success');
      if (scanned > 0) clearSensitiveFields();
    } catch (error) {
      if (error?.name === 'AbortError' && stopRequested) {
        showRecoveryMessage(`Audit stopped after ${scanned} checked addresses.`, 'success');
      } else {
        showRecoveryMessage(error?.message || 'Unable to run the recovery audit.');
      }
    } finally {
      root = null;
      activeFetchController = null;
      setAuditBusy(false);
    }
  });

  stopButton.addEventListener('click', () => {
    stopRequested = true;
    activeFetchController?.abort();
    recoveryStatus.textContent = 'Stopping…';
    stopButton.disabled = true;
  });

  clearButton.addEventListener('click', () => {
    if (auditRunning) return;
    clearSensitiveFields();
    recoveryAccessToken.value = '';
    hideRecoveryMessage();
    progressPanel.hidden = true;
    recoveryResults.hidden = true;
    foundResults = [];
    recoveryResultsBody.replaceChildren();
    recoveryEmpty.hidden = false;
    exportButton.disabled = true;
    phraseInput.focus();
  });

  togglePhraseButton.addEventListener('click', () => {
    const hidden = phraseInput.classList.toggle('secret-hidden');
    togglePhraseButton.textContent = hidden ? 'Reveal phrase' : 'Hide phrase';
  });

  pastePhraseButton.addEventListener('click', async () => {
    hideRecoveryMessage();
    try {
      phraseInput.value = (await navigator.clipboard.readText()).trim();
      phraseInput.focus();
    } catch {
      showRecoveryMessage('Clipboard access was blocked. Paste the recovery phrase manually.');
    }
  });

  exportButton.addEventListener('click', () => {
    if (!foundResults.length) return;
    const escapeCsv = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`;
    const rows = [
      ['index', 'derivation_path', 'public_address', 'active_networks', 'evidence'],
      ...foundResults.map((item) => [
        item.index,
        item.path,
        item.address,
        (item.activeNetworks || []).join('; '),
        (item.evidence || []).join(' | ')
      ])
    ];
    const csv = rows.map((row) => row.map(escapeCsv).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `evm-recovery-public-results-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  });
})();
