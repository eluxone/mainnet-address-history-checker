'use strict';

(() => {
  const form = document.querySelector('#btc-search-form');
  if (!form) return;

  const startDate = document.querySelector('#btc-start-date');
  const endDate = document.querySelector('#btc-end-date');
  const minInactive = document.querySelector('#btc-min-inactive');
  const minBalance = document.querySelector('#btc-min-balance');
  const maxBalance = document.querySelector('#btc-max-balance');
  const target = document.querySelector('#btc-target');
  const candidateLimit = document.querySelector('#btc-candidate-limit');
  const accessToken = document.querySelector('#btc-access-token');
  const sort = document.querySelector('#btc-sort');
  const autoScan = document.querySelector('#btc-auto-scan');
  const searchButton = document.querySelector('#btc-search-button');
  const continueButton = document.querySelector('#btc-continue-button');
  const pauseButton = document.querySelector('#btc-pause-button');
  const clearButton = document.querySelector('#btc-clear-button');
  const message = document.querySelector('#btc-message');
  const progress = document.querySelector('#btc-progress');
  const progressBar = document.querySelector('#btc-progress-bar');
  const progressLabel = document.querySelector('#btc-progress-label');
  const progressDetail = document.querySelector('#btc-progress-detail');
  const resultsPanel = document.querySelector('#btc-results');
  const resultsTitle = document.querySelector('#btc-results-title');
  const resultsBody = document.querySelector('#btc-results-body');
  const empty = document.querySelector('#btc-empty');
  const exportButton = document.querySelector('#btc-export-button');
  const resultCount = document.querySelector('#btc-result-count');
  const candidatesCount = document.querySelector('#btc-candidates-count');
  const bytesProcessed = document.querySelector('#btc-bytes-processed');
  const cacheStatus = document.querySelector('#btc-cache-status');

  const filterInputs = [startDate, endDate, minInactive, minBalance, maxBalance, target, candidateLimit];
  const AUTO_BATCH_DELAY_MS = 900;

  let currentRows = [];
  let controller = null;
  let nextOffset = 0;
  let candidateCount = 0;
  let checkedTotal = 0;
  let totalBigQueryBytes = 0;
  let addressCacheHits = 0;
  let providerErrors = 0;
  let activePayload = null;
  let autoRunning = false;
  let autoPaused = false;
  let pauseRequested = false;
  let runGeneration = 0;

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

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function targetReached() {
    return Boolean(activePayload) && currentRows.length >= Number(activePayload.target || 0);
  }

  function hasMoreCandidates() {
    return Boolean(activePayload) && nextOffset < candidateCount && !targetReached();
  }

  function updateProgress(label = '') {
    const ratio = candidateCount > 0 ? checkedTotal / candidateCount : 0;
    progressBar.value = Math.max(0, Math.min(100, ratio * 100));

    if (label) {
      progressLabel.textContent = label;
    } else if (autoRunning) {
      progressLabel.textContent = 'Automatic scan in progress…';
    } else if (autoPaused) {
      progressLabel.textContent = 'Automatic scan paused';
    } else if (targetReached()) {
      progressLabel.textContent = 'Target reached';
    } else if (candidateCount && checkedTotal >= candidateCount) {
      progressLabel.textContent = 'Candidate scan complete';
    }

    const targetValue = Number(activePayload?.target || 0);
    progressDetail.textContent = candidateCount
      ? `${new Intl.NumberFormat().format(checkedTotal)} of ${new Intl.NumberFormat().format(candidateCount)} candidates checked · ${currentRows.length} of ${targetValue} target matches`
      : 'Preparing candidate discovery and cost estimate…';
  }

  function refreshControls() {
    const requestBusy = Boolean(controller);
    const running = autoRunning || requestBusy;

    searchButton.disabled = running;
    clearButton.disabled = requestBusy;
    autoScan.disabled = running;

    if (autoRunning) {
      pauseButton.hidden = false;
      pauseButton.disabled = false;
      pauseButton.textContent = pauseRequested ? 'Pausing after this batch…' : 'Pause automatic scan';
      continueButton.hidden = true;
      continueButton.disabled = true;
    } else if (autoPaused && hasMoreCandidates()) {
      pauseButton.hidden = false;
      pauseButton.disabled = false;
      pauseButton.textContent = 'Resume automatic scan';
      continueButton.hidden = true;
      continueButton.disabled = true;
    } else {
      pauseButton.hidden = true;
      pauseButton.disabled = true;
      const manualHasMore = hasMoreCandidates() && !autoScan.checked;
      continueButton.hidden = !manualHasMore;
      continueButton.disabled = !manualHasMore || requestBusy;
    }

    if (requestBusy && checkedTotal === 0) {
      searchButton.textContent = 'Discovering candidates…';
    } else if (requestBusy) {
      searchButton.textContent = 'Search running…';
    } else {
      searchButton.textContent = autoScan.checked ? 'Start automatic search' : 'Start new search';
    }
  }

  function safeNumber(input, min, max, label) {
    const value = Number(input.value);
    if (!Number.isFinite(value) || value < min || value > max) {
      throw new Error(`${label} must be between ${min} and ${max}.`);
    }
    return value;
  }

  function parseTimestamp(value) {
    if (value === null || value === undefined || value === '') return null;
    const unwrapped = typeof value === 'object' && value.value !== undefined ? value.value : value;
    const text = String(unwrapped).trim();
    if (!text) return null;

    let date;
    if (/^-?\d+(?:\.\d+)?$/.test(text)) {
      const numeric = Number(text);
      if (!Number.isFinite(numeric)) return null;
      date = new Date(Math.abs(numeric) >= 1_000_000_000_000 ? numeric : numeric * 1_000);
    } else {
      date = new Date(text);
    }
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function formatDate(value) {
    const date = parseTimestamp(value);
    if (!date) return '—';
    return new Intl.DateTimeFormat(undefined, {
      year: 'numeric',
      month: 'short',
      day: '2-digit'
    }).format(date);
  }

  function isoTimestamp(value) {
    const date = parseTimestamp(value);
    return date ? date.toISOString() : '';
  }

  function formatBtc(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return '0 BTC';
    return `${new Intl.NumberFormat(undefined, {
      minimumFractionDigits: 0,
      maximumFractionDigits: 8
    }).format(numeric)} BTC`;
  }

  function formatBytes(value) {
    const bytes = Number(value);
    if (!Number.isFinite(bytes) || bytes < 0) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let amount = bytes;
    let unit = 0;
    while (amount >= 1_000 && unit < units.length - 1) {
      amount /= 1_000;
      unit += 1;
    }
    return `${amount.toFixed(amount >= 10 || unit === 0 ? 1 : 2)} ${units[unit]}`;
  }

  function shortenAddress(value) {
    if (!value || value.length < 20) return value || '—';
    return `${value.slice(0, 10)}…${value.slice(-8)}`;
  }

  function createCell(text, className = '') {
    const cell = document.createElement('td');
    cell.textContent = text;
    if (className) cell.className = className;
    return cell;
  }

  function sortRows(rows) {
    const copy = [...rows];
    copy.sort((left, right) => {
      if (sort.value === 'balance_desc') {
        return Number(right.balanceBtc) - Number(left.balanceBtc) || Number(right.inactiveDays) - Number(left.inactiveDays);
      }
      if (sort.value === 'oldest_first') {
        return String(left.firstSeen || '').localeCompare(String(right.firstSeen || ''));
      }
      return Number(right.inactiveDays) - Number(left.inactiveDays) || Number(right.balanceBtc) - Number(left.balanceBtc);
    });
    return copy;
  }

  function renderRows(rows) {
    resultsBody.replaceChildren();
    empty.hidden = rows.length > 0;

    for (const item of rows) {
      const row = document.createElement('tr');
      const addressCell = createCell(shortenAddress(item.address), 'mono');
      addressCell.title = item.address;
      row.append(addressCell);
      row.append(createCell(formatBtc(item.balanceBtc)));
      row.append(createCell(formatDate(item.firstSeen)));
      row.append(createCell(formatDate(item.lastActivity)));
      row.append(createCell(new Intl.NumberFormat().format(Number(item.inactiveDays || 0))));
      row.append(createCell(new Intl.NumberFormat().format(Number(item.activityRecords || 0))));

      const explorerCell = document.createElement('td');
      const link = document.createElement('a');
      link.href = `https://mempool.space/address/${encodeURIComponent(item.address)}`;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = 'View public address';
      explorerCell.append(link);
      row.append(explorerCell);
      resultsBody.append(row);
    }
  }

  function resetState() {
    runGeneration += 1;
    controller?.abort();
    controller = null;
    currentRows = [];
    nextOffset = 0;
    candidateCount = 0;
    checkedTotal = 0;
    totalBigQueryBytes = 0;
    addressCacheHits = 0;
    providerErrors = 0;
    activePayload = null;
    autoRunning = false;
    autoPaused = false;
    pauseRequested = false;
    resultsBody.replaceChildren();
    resultsPanel.hidden = true;
    progress.hidden = true;
    progressBar.value = 0;
    exportButton.disabled = true;
    resultCount.textContent = '0';
    candidatesCount.textContent = '0 / 0';
    bytesProcessed.textContent = '—';
    cacheStatus.textContent = '—';
    hideMessage();
    refreshControls();
  }

  function buildPayload(offset = 0) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate.value) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate.value)) {
      throw new Error('Enter a valid start and end date.');
    }
    if (startDate.value > endDate.value) throw new Error('The start date must be on or before the end date.');

    const minBtc = safeNumber(minBalance, 0, 21_000_000, 'Minimum BTC');
    const maxBtc = safeNumber(maxBalance, 0, 21_000_000, 'Maximum BTC');
    if (minBtc > maxBtc) throw new Error('Minimum BTC cannot exceed maximum BTC.');

    return {
      startDate: startDate.value,
      endDate: endDate.value,
      minBalanceBtc: minBtc,
      maxBalanceBtc: maxBtc,
      minInactiveDays: Math.trunc(safeNumber(minInactive, 0, 10_000, 'Minimum inactive days')),
      target: Math.trunc(safeNumber(target, 1, 100, 'Target results')),
      candidateLimit: Math.trunc(safeNumber(candidateLimit, 10, 5_000, 'Candidate limit')),
      sort: sort.value,
      offset
    };
  }

  function mergeRows(rows) {
    const byAddress = new Map(currentRows.map((item) => [item.address, item]));
    for (const item of rows) byAddress.set(item.address, item);
    currentRows = sortRows([...byAddress.values()]).slice(0, Number(activePayload?.target || 100));
  }

  function updateResults(data, { automatic = false } = {}) {
    mergeRows(Array.isArray(data.results) ? data.results : []);
    candidateCount = Number(data.candidateCount || candidateCount || 0);
    checkedTotal = Number(data.nextOffset || checkedTotal || 0);
    nextOffset = Number(data.nextOffset || 0);
    totalBigQueryBytes += Number(data.bigQueryBytesProcessed || 0);
    addressCacheHits += Number(data.addressCacheHits || 0);
    providerErrors += Number(data.providerErrors || 0);

    renderRows(currentRows);
    resultCount.textContent = String(currentRows.length);
    candidatesCount.textContent = `${new Intl.NumberFormat().format(checkedTotal)} / ${new Intl.NumberFormat().format(candidateCount)}`;
    bytesProcessed.textContent = formatBytes(totalBigQueryBytes);
    cacheStatus.textContent = `${addressCacheHits} address hit${addressCacheHits === 1 ? '' : 's'}${data.candidateCacheHit ? ' · candidates cached' : ''}`;
    resultsTitle.textContent = `${currentRows.length} public address${currentRows.length === 1 ? '' : 'es'} matched`;
    resultsPanel.hidden = false;
    exportButton.disabled = currentRows.length === 0;
    progress.hidden = false;
    updateProgress();

    const reached = targetReached();
    const hasMore = Boolean(data.hasMore) && !reached;
    const errorNote = providerErrors ? ` ${providerErrors} public API check${providerErrors === 1 ? '' : 's'} failed and can be retried.` : '';

    if (reached) {
      showMessage(`Target reached. Found ${currentRows.length} matching public addresses after checking ${checkedTotal} of ${candidateCount} candidates.${errorNote}`, 'success');
    } else if (hasMore && automatic) {
      showMessage(`Checked ${checkedTotal} of ${candidateCount} candidates and found ${currentRows.length} matches. Automatic scanning will continue.${errorNote}`, 'success');
    } else if (hasMore) {
      showMessage(`Checked ${checkedTotal} of ${candidateCount} cached candidates and found ${currentRows.length} matches. Use Continue search for the next batch.${errorNote}`, 'success');
    } else {
      showMessage(`Search complete. Checked all ${candidateCount} candidates and found ${currentRows.length} matches.${errorNote}`, 'success');
    }

    refreshControls();
    return { reached, hasMore };
  }

  async function requestBatch(payload, continuing, generation) {
    if (generation !== runGeneration) return null;
    hideMessage();
    progress.hidden = false;
    updateProgress(continuing ? `Checking cached candidates ${payload.offset + 1} onward…` : 'Estimating and discovering historical candidates…');

    controller = new AbortController();
    refreshControls();
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (accessToken.value) headers['X-App-Access-Token'] = accessToken.value;
      const response = await fetch('/api/btc-discovery', {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `BTC discovery request failed (${response.status}).`);
      return data;
    } catch (error) {
      if (error?.name !== 'AbortError' && generation === runGeneration) {
        showMessage(error?.message || 'Unable to search public Bitcoin data.');
      }
      return null;
    } finally {
      controller = null;
      refreshControls();
    }
  }

  async function automaticLoop(generation) {
    if (generation !== runGeneration || !activePayload || !hasMoreCandidates()) return;

    autoRunning = true;
    autoPaused = false;
    pauseRequested = false;
    refreshControls();
    updateProgress('Automatic scan in progress…');

    while (generation === runGeneration && hasMoreCandidates()) {
      if (pauseRequested) break;
      await sleep(AUTO_BATCH_DELAY_MS);
      if (generation !== runGeneration || pauseRequested) break;

      const payload = { ...activePayload, offset: nextOffset };
      const data = await requestBatch(payload, true, generation);
      if (!data || generation !== runGeneration) {
        autoRunning = false;
        autoPaused = hasMoreCandidates();
        refreshControls();
        updateProgress(autoPaused ? 'Automatic scan paused after an error' : 'Automatic scan stopped');
        return;
      }

      const state = updateResults(data, { automatic: true });
      if (state.reached || !state.hasMore) break;
    }

    if (generation !== runGeneration) return;

    if (pauseRequested && hasMoreCandidates()) {
      autoRunning = false;
      autoPaused = true;
      pauseRequested = false;
      showMessage(`Automatic scan paused after checking ${checkedTotal} of ${candidateCount} candidates.`, 'success');
      updateProgress('Automatic scan paused');
    } else {
      autoRunning = false;
      autoPaused = false;
      pauseRequested = false;
      updateProgress(targetReached() ? 'Target reached' : 'Candidate scan complete');
    }
    refreshControls();
  }

  async function startSearch() {
    const initialPayload = buildPayload(0);
    resetState();
    const generation = runGeneration;
    activePayload = { ...initialPayload, offset: 0 };
    refreshControls();

    const data = await requestBatch(initialPayload, false, generation);
    if (!data || generation !== runGeneration) return;

    const automatic = autoScan.checked;
    const state = updateResults(data, { automatic });
    if (automatic && state.hasMore && !state.reached) {
      await automaticLoop(generation);
    }
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await startSearch();
    } catch (error) {
      showMessage(error?.message || 'Unable to start the search.');
    }
  });

  continueButton.addEventListener('click', async () => {
    if (!activePayload || nextOffset >= candidateCount || autoRunning) return;
    const generation = runGeneration;
    const data = await requestBatch({ ...activePayload, offset: nextOffset }, true, generation);
    if (data && generation === runGeneration) updateResults(data, { automatic: false });
  });

  pauseButton.addEventListener('click', async () => {
    if (autoRunning) {
      pauseRequested = true;
      pauseButton.textContent = 'Pausing after this batch…';
      pauseButton.disabled = true;
      return;
    }

    if (autoPaused && hasMoreCandidates()) {
      const generation = runGeneration;
      await automaticLoop(generation);
    }
  });

  clearButton.addEventListener('click', resetState);

  sort.addEventListener('change', () => {
    currentRows = sortRows(currentRows);
    renderRows(currentRows);
  });

  autoScan.addEventListener('change', () => {
    if (!activePayload) {
      refreshControls();
      return;
    }
    if (!autoScan.checked && autoRunning) pauseRequested = true;
    refreshControls();
  });

  for (const input of filterInputs) {
    input.addEventListener('change', () => {
      if (!activePayload || autoRunning || controller) return;
      continueButton.hidden = true;
      pauseButton.hidden = true;
      activePayload = null;
      autoPaused = false;
      refreshControls();
    });
  }

  exportButton.addEventListener('click', () => {
    if (!currentRows.length) return;
    const escapeCsv = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`;
    const rows = [
      ['public_address', 'current_balance_btc', 'first_seen', 'last_activity', 'inactive_days', 'activity_records'],
      ...currentRows.map((item) => [
        item.address,
        item.balanceBtc,
        isoTimestamp(item.firstSeen),
        isoTimestamp(item.lastActivity),
        item.inactiveDays,
        item.activityRecords
      ])
    ];
    const csv = rows.map((row) => row.map(escapeCsv).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `btc-discovery-public-results-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  });

  refreshControls();
})();
