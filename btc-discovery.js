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
  const searchButton = document.querySelector('#btc-search-button');
  const continueButton = document.querySelector('#btc-continue-button');
  const clearButton = document.querySelector('#btc-clear-button');
  const message = document.querySelector('#btc-message');
  const progress = document.querySelector('#btc-progress');
  const progressLabel = document.querySelector('#btc-progress-label');
  const resultsPanel = document.querySelector('#btc-results');
  const resultsTitle = document.querySelector('#btc-results-title');
  const resultsBody = document.querySelector('#btc-results-body');
  const empty = document.querySelector('#btc-empty');
  const exportButton = document.querySelector('#btc-export-button');
  const resultCount = document.querySelector('#btc-result-count');
  const candidatesCount = document.querySelector('#btc-candidates-count');
  const bytesProcessed = document.querySelector('#btc-bytes-processed');
  const cacheStatus = document.querySelector('#btc-cache-status');

  let currentRows = [];
  let controller = null;
  let nextOffset = 0;
  let candidateCount = 0;
  let checkedTotal = 0;
  let totalBigQueryBytes = 0;
  let addressCacheHits = 0;
  let providerErrors = 0;
  let activePayload = null;

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

  function setBusy(value, continuing = false) {
    searchButton.disabled = value;
    continueButton.disabled = value;
    clearButton.disabled = value;
    searchButton.textContent = value && !continuing ? 'Discovering candidates…' : 'Start new search';
    continueButton.textContent = value && continuing ? 'Checking next batch…' : 'Continue search';
    progress.hidden = !value;
    progressLabel.textContent = continuing
      ? `Checking cached candidates ${nextOffset + 1} onward…`
      : 'Estimating and discovering historical candidates…';
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
    resultsBody.replaceChildren();
    resultsPanel.hidden = true;
    progress.hidden = true;
    continueButton.hidden = true;
    continueButton.disabled = true;
    exportButton.disabled = true;
    resultCount.textContent = '0';
    candidatesCount.textContent = '0 / 0';
    bytesProcessed.textContent = '—';
    cacheStatus.textContent = '—';
    hideMessage();
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

  function updateResults(data) {
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

    const targetReached = currentRows.length >= Number(activePayload.target);
    const hasMore = Boolean(data.hasMore) && !targetReached;
    continueButton.hidden = !hasMore;
    continueButton.disabled = !hasMore;

    const errorNote = providerErrors ? ` ${providerErrors} public API check${providerErrors === 1 ? '' : 's'} failed and can be retried.` : '';
    if (targetReached) {
      showMessage(`Target reached. Found ${currentRows.length} matching public addresses after checking ${checkedTotal} of ${candidateCount} candidates.${errorNote}`, 'success');
    } else if (hasMore) {
      showMessage(`Checked ${checkedTotal} of ${candidateCount} cached candidates and found ${currentRows.length} matches. Use Continue search for the next batch.${errorNote}`, 'success');
    } else {
      showMessage(`Search complete. Checked all ${candidateCount} candidates and found ${currentRows.length} matches.${errorNote}`, 'success');
    }
    resultsPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function runBatch(offset, continuing) {
    hideMessage();
    const payload = continuing && activePayload
      ? { ...activePayload, offset }
      : buildPayload(offset);
    if (!continuing) {
      resetState();
      activePayload = { ...payload, offset: 0 };
    }

    setBusy(true, continuing);
    controller = new AbortController();
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
      updateResults(data);
    } catch (error) {
      if (error?.name !== 'AbortError') showMessage(error?.message || 'Unable to search public Bitcoin data.');
    } finally {
      controller = null;
      setBusy(false, continuing);
    }
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await runBatch(0, false);
    } catch (error) {
      showMessage(error?.message || 'Unable to start the search.');
    }
  });

  continueButton.addEventListener('click', async () => {
    if (!activePayload || nextOffset >= candidateCount) return;
    await runBatch(nextOffset, true);
  });

  clearButton.addEventListener('click', resetState);
  sort.addEventListener('change', () => {
    currentRows = sortRows(currentRows);
    renderRows(currentRows);
  });

  for (const input of [startDate, endDate, minInactive, minBalance, maxBalance, target, candidateLimit]) {
    input.addEventListener('change', () => {
      continueButton.hidden = true;
      activePayload = null;
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
})();
