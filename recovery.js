'use strict';

(() => {
  const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
  const VERIFY_INDEX_LIMIT = 200;
  const PROFILE_LABELS = {
    standard: 'Standard / MetaMask',
    'ledger-live': 'Ledger Live',
    'ledger-legacy': 'Legacy Ledger'
  };
  const PROFILE_ORDER = ['standard', 'ledger-live', 'ledger-legacy'];

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

  const verifier = document.createElement('div');
  verifier.className = 'token-wrap';
  verifier.innerHTML = `
    <label for="known-wallet-address">Known public wallet address <span>(optional — improves derivation confidence)</span></label>
    <div class="input-row">
      <input id="known-wallet-address" type="text" maxlength="42" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Optional 0x... address currently shown in your wallet">
      <button id="verify-recovery-button" class="secondary" type="button">Verify address & detect path</button>
    </div>
    <p id="verification-status" class="field-help">Provide a public address to verify the phrase and detect its derivation path, or leave it blank to audit the selected profile and index range.</p>
    <div id="verification-preview" class="table-wrap" hidden>
      <table>
        <thead><tr><th>Profile</th><th>Index</th><th>Derivation path</th><th>Derived public address</th></tr></thead>
        <tbody id="verification-preview-body"></tbody>
      </table>
    </div>`;
  passphraseInput.insertAdjacentElement('afterend', verifier);

  const knownAddressInput = document.querySelector('#known-wallet-address');
  const verifyButton = document.querySelector('#verify-recovery-button');
  const verificationStatus = document.querySelector('#verification-status');
  const verificationPreview = document.querySelector('#verification-preview');
  const verificationPreviewBody = document.querySelector('#verification-preview-body');

  let auditRunning = false;
  let stopRequested = false;
  let activeFetchController = null;
  let foundResults = [];
  let verifiedMatch = null;

  function normalizePhrase(value) {
    return value.normalize('NFKD').trim().toLowerCase().split(/\s+/).join(' ');
  }

  function derivationPath(profile, index) {
    if (profile === 'standard') return `m/44'/60'/0'/0/${index}`;
    if (profile === 'ledger-live') return `m/44'/60'/${index}'/0/0`;
    if (profile === 'ledger-legacy') return `m/44'/60'/0'/${index}`;
    throw new Error('Unsupported derivation profile.');
  }

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

  function setVerificationStatus(text, kind = '') {
    verificationStatus.textContent = text;
    verificationStatus.className = kind === 'success'
      ? 'message success'
      : kind === 'error'
        ? 'message'
        : 'field-help';
  }

  function safeInteger(input, min, max, label) {
    const value = Number(input.value);
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      throw new Error(`${label} must be between ${min} and ${max}.`);
    }
    return value;
  }

  function clearVerification() {
    verifiedMatch = null;
    verificationPreview.hidden = true;
    verificationPreviewBody.replaceChildren();
    setVerificationStatus('Provide a public address to verify the phrase and detect its derivation path, or leave it blank to audit the selected profile and index range.');
  }

  function setAuditBusy(value) {
    auditRunning = value;
    auditButton.disabled = value;
    stopButton.disabled = !value;
    clearButton.disabled = value;
    togglePhraseButton.disabled = value;
    pastePhraseButton.disabled = value;
    verifyButton.disabled = value;
    knownAddressInput.disabled = value;
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

  function addPreviewRow(profile, index, path, address) {
    const row = document.createElement('tr');
    for (const value of [PROFILE_LABELS[profile], String(index), path, address]) {
      const cell = document.createElement('td');
      cell.textContent = value;
      if (value === path || value === address) cell.className = 'mono';
      row.append(cell);
    }
    verificationPreviewBody.append(row);
  }

  async function verifyKnownAddress() {
    if (auditRunning) return false;
    hideRecoveryMessage();
    verifiedMatch = null;
    verificationPreviewBody.replaceChildren();
    verificationPreview.hidden = true;

    if (!window.ethers?.HDNodeWallet || !window.ethers?.Mnemonic) {
      setVerificationStatus('The wallet-derivation library did not load. Refresh the page.', 'error');
      return false;
    }

    const phrase = normalizePhrase(phraseInput.value);
    const knownAddress = knownAddressInput.value.trim();
    if (!window.ethers.Mnemonic.isValidMnemonic(phrase)) {
      setVerificationStatus('The recovery phrase is not a valid checksum-protected BIP-39 English phrase.', 'error');
      return false;
    }
    if (!knownAddress) {
      setVerificationStatus('No public address was supplied. Leave this field blank and start the audit to scan the selected profile and range.', 'success');
      return true;
    }
    if (!ADDRESS_RE.test(knownAddress)) {
      setVerificationStatus('Enter a valid public 0x address, or leave the field blank.', 'error');
      return false;
    }

    verifyButton.disabled = true;
    verifyButton.textContent = 'Detecting path…';
    setVerificationStatus(`Searching the first ${VERIFY_INDEX_LIMIT} indexes across common Ethereum derivation profiles…`);

    let root = null;
    try {
      root = window.ethers.HDNodeWallet.fromPhrase(phrase, passphraseInput.value, 'm');
      const target = knownAddress.toLowerCase();
      const selectedFirst = [profileInput.value, ...PROFILE_ORDER.filter((profile) => profile !== profileInput.value)];

      for (const profile of selectedFirst) {
        for (let index = 0; index < VERIFY_INDEX_LIMIT; index += 1) {
          const path = derivationPath(profile, index);
          const address = root.derivePath(path).address;
          if (address.toLowerCase() === target) {
            verifiedMatch = { profile, index, path, address };
            profileInput.value = profile;
            if (Number(startInput.value) > index) startInput.value = '0';
            if (Number(countInput.value) <= index) countInput.value = String(Math.min(index + 1, 1000));
            addPreviewRow(profile, index, path, address);
            verificationPreview.hidden = false;
            setVerificationStatus(`Verified: this phrase and passphrase derive your known address at ${path}.`, 'success');
            return true;
          }
          if (index > 0 && index % 20 === 0) await new Promise(requestAnimationFrame);
        }
      }

      for (const profile of PROFILE_ORDER) {
        const path = derivationPath(profile, 0);
        addPreviewRow(profile, 0, path, root.derivePath(path).address);
      }
      verificationPreview.hidden = false;
      setVerificationStatus(
        'No match was found in the first 200 indexes. Common causes: the optional BIP-39 passphrase is wrong, the address came from an imported private key, the visible wallet is a smart-account/contract address, or the wallet uses an unsupported derivation path.',
        'error'
      );
      return false;
    } catch (error) {
      setVerificationStatus(error?.message || 'Unable to verify this recovery phrase.', 'error');
      return false;
    } finally {
      root = null;
      verifyButton.disabled = false;
      verifyButton.textContent = 'Verify address & detect path';
    }
  }

  function appendFoundResult(item) {
    foundResults.push(item);
    recoveryEmpty.hidden = true;
    exportButton.disabled = false;

    const row = document.createElement('tr');
    const values = [String(item.index), item.path, item.address, (item.activeNetworks || []).join(', ') || '—'];
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
    detailsButton.addEventListener('click', () => window.openDetailedAddress?.(item.address, recoveryAccessToken.value));
    actionCell.append(detailsButton);
    row.append(actionCell);
    recoveryResultsBody.append(row);
  }

  async function checkAddressBatch(addresses, accessToken) {
    activeFetchController = new AbortController();
    const response = await fetch('/api/audit-addresses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-App-Access-Token': accessToken },
      body: JSON.stringify({ addresses }),
      signal: activeFetchController.signal
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Audit request failed (${response.status}).`);

    const results = data.results || [];
    const mostlyUnavailable = results.find((item) =>
      Number(item.networkErrorCount || 0) >= 2 && Number(item.successfulNetworkCount || 0) <= 1
    );
    if (mostlyUnavailable) {
      const failures = (mostlyUnavailable.failedNetworks || [])
        .map((network) => `${network.label}: ${network.error}`)
        .join('; ');
      throw new Error(`Most configured networks are unavailable. Only ${mostlyUnavailable.successfulNetworkCount || 0} of 3 checks succeeded. ${failures}`);
    }
    return results;
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
    verifiedMatch = null;
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
        throw new Error('The wallet-derivation library did not load. Refresh the page and try again.');
      }
      if (!ownershipInput.checked) {
        throw new Error('Confirm that you own or are authorized to recover this phrase.');
      }
      if (!recoveryAccessToken.value) {
        throw new Error('Enter the private APP_ACCESS_TOKEN configured in Vercel.');
      }

      const phrase = normalizePhrase(phraseInput.value);
      if (!window.ethers.Mnemonic.isValidMnemonic(phrase)) {
        throw new Error('The recovery phrase is not a valid checksum-protected BIP-39 English phrase.');
      }

      const knownAddress = knownAddressInput.value.trim();
      if (knownAddress && !ADDRESS_RE.test(knownAddress)) {
        throw new Error('Enter a valid known public address, or leave that field blank.');
      }
      if (knownAddress && !verifiedMatch && !(await verifyKnownAddress())) {
        throw new Error('The supplied public address did not verify against this phrase. Fix the address, passphrase, or derivation details, or leave the address blank to scan the selected profile directly.');
      }

      root = window.ethers.HDNodeWallet.fromPhrase(phrase, passphraseInput.value, 'm');

      if (knownAddress && verifiedMatch) {
        const rederived = root.derivePath(verifiedMatch.path).address;
        if (rederived.toLowerCase() !== knownAddress.toLowerCase()) {
          verifiedMatch = null;
          throw new Error('The phrase, passphrase, or known address changed after verification. Verify it again.');
        }
      }

      const start = safeInteger(startInput, 0, 0x7fffffff, 'Starting index');
      const count = safeInteger(countInput, 1, 1000, 'Maximum addresses');
      if (start + count - 1 > 0x7fffffff) {
        throw new Error('The requested address range exceeds the maximum BIP-32 index.');
      }
      if (knownAddress && verifiedMatch && (verifiedMatch.index < start || verifiedMatch.index >= start + count)) {
        throw new Error(`The verified wallet address is at index ${verifiedMatch.index}, outside the requested scan range.`);
      }

      const profile = profileInput.value;
      stopRequested = false;
      resetRecoveryResults();
      progressPanel.hidden = false;
      updateProgress(
        0,
        count,
        0,
        0,
        '—',
        knownAddress ? 'Verified derivation. Preparing blockchain checks…' : 'No known address supplied. Preparing selected derivation profile…'
      );
      setAuditBusy(true);

      for (let offset = 0; offset < count && !stopRequested; offset += 1) {
        const index = start + offset;
        const path = derivationPath(profile, index);
        const address = root.derivePath(path).address;
        currentPathMetric.textContent = path;
        updateProgress(
          scanned,
          count,
          foundResults.length,
          errors,
          path,
          `Checking ${PROFILE_LABELS[profile]} address across Ethereum, Base, and OP Mainnet…`
        );

        const checked = await checkAddressBatch([{ index, path, address }], recoveryAccessToken.value);
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
          throw new Error('The provider failed all three network checks for three consecutive addresses.');
        }
        if (stopGapInput.checked && consecutiveEmpty >= 50) break;
        await new Promise((resolve) => setTimeout(resolve, 900));
      }

      let contextText;
      let success = false;
      if (knownAddress) {
        const knownFound = foundResults.some((item) => item.address.toLowerCase() === knownAddress.toLowerCase());
        contextText = knownFound
          ? ' The verified wallet address returned blockchain activity.'
          : ' The phrase matched your known wallet address, but that address returned no activity on Ethereum Mainnet, Base Mainnet, or OP Mainnet.';
        success = knownFound && errors === 0;
      } else {
        contextText = ` No known public address was supplied; the audit searched ${PROFILE_LABELS[profile]} indexes ${start}–${start + scanned - 1}.`;
        success = foundResults.length > 0 && errors === 0;
      }

      const errorText = errors
        ? ` ${errors} network check${errors === 1 ? '' : 's'} failed and were not treated as empty results.`
        : '';
      showRecoveryMessage(
        `Audit finished. Checked ${scanned} address${scanned === 1 ? '' : 'es'} and found ${foundResults.length} with activity.${contextText}${errorText}`,
        success ? 'success' : ''
      );
      updateProgress(
        scanned,
        count,
        foundResults.length,
        errors,
        currentPathMetric.textContent,
        stopRequested ? 'Stopped by user' : 'Audit complete'
      );
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

  verifyButton.addEventListener('click', verifyKnownAddress);
  for (const input of [phraseInput, passphraseInput, knownAddressInput, profileInput]) {
    input.addEventListener('input', clearVerification);
    input.addEventListener('change', clearVerification);
  }

  stopButton.addEventListener('click', () => {
    stopRequested = true;
    activeFetchController?.abort();
    recoveryStatus.textContent = 'Stopping…';
    stopButton.disabled = true;
  });

  clearButton.addEventListener('click', () => {
    if (auditRunning) return;
    clearSensitiveFields();
    knownAddressInput.value = '';
    recoveryAccessToken.value = '';
    clearVerification();
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
      clearVerification();
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