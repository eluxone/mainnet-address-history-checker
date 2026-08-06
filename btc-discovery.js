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
    searchButton.disabled = value;
    clearButton.disabled = value;
    searchButton.textContent = value ? 'Searching public BTC data…' : 'Search public BTC data';
    progress.hidden = !value;
    progressLabel.textContent = value
      ? 'Querying historical Bitcoin records…'
      : 'Preparing public-data query…';
  }

  function safeNumber(input, min, max, label) {
    const value = Number(input.value);
    if (!Number.isFinite(value) || value < min || value > max) {
      throw new Error(`${label} must be between ${min} and ${max}.`);
    }
    return value;
  }

  function formatDate(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return new Intl.DateTimeFormat(undefined, {
      year: 'numeric',
      month: 'short',
      day: '2-digit'
    }).format(date);
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
    while (amount >= 1024 && unit < units.length - 1) {
      amount /= 1024;
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

  function clearResults() {
    controller?.abort();
    controller = null;
    currentRows = [];
    resultsBody.replaceChildren();
    resultsPanel.hidden = true;
    progress.hidden = true;
    exportButton.disabled = true;
    resultCount.textContent = '0';
    candidatesCount.textContent = '0';
    bytesProcessed.textContent = '—';
    cacheStatus.textContent = '—';
    hideMessage();
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    hideMessage();

    try {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate.value) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate.value)) {
        throw new Error('Enter a valid start and end date.');
      }
      if (startDate.value > endDate.value) {
        throw new Error('The start date must be on or before the end date.');
      }

      const minBtc = safeNumber(minBalance, 0, 21_000_000, 'Minimum BTC');
      const maxBtc = safeNumber(maxBalance, 0, 21_000_000, 'Maximum BTC');
      if (minBtc > maxBtc) throw new Error('Minimum BTC cannot exceed maximum BTC.');

      const payload = {
        startDate: startDate.value,
        endDate: endDate.value,
        minBalanceBtc: minBtc,
        maxBalanceBtc: maxBtc,
        minInactiveDays: Math.trunc(safeNumber(minInactive, 0, 10_000, 'Minimum inactive days')),
        target: Math.trunc(safeNumber(target, 1, 100, 'Target results')),
        candidateLimit: Math.trunc(safeNumber(candidateLimit, 10, 5_000, 'Candidate limit')),
        sort: sort.value
      };

      clearResults();
      setBusy(true);
      controller = new AbortController();

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

      currentRows = Array.isArray(data.results) ? data.results : [];
      renderRows(currentRows);
      resultCount.textContent = String(currentRows.length);
      candidatesCount.textContent = String(data.candidatesEvaluated ?? payload.candidateLimit);
      bytesProcessed.textContent = formatBytes(data.totalBytesProcessed);
      cacheStatus.textContent = data.cacheHit ? 'Used' : 'Not used';
      resultsTitle.textContent = `${currentRows.length} public address${currentRows.length === 1 ? '' : 'es'} matched`;
      resultsPanel.hidden = false;
      exportButton.disabled = currentRows.length === 0;
      showMessage(
        currentRows.length
          ? `Search complete. ${currentRows.length} public address${currentRows.length === 1 ? '' : 'es'} matched the selected filters.`
          : 'Search complete. No public addresses matched all selected filters.',
        'success'
      );
      resultsPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (error) {
      if (error?.name !== 'AbortError') {
        showMessage(error?.message || 'Unable to search public Bitcoin data.');
      }
    } finally {
      controller = null;
      setBusy(false);
    }
  });

  clearButton.addEventListener('click', clearResults);

  exportButton.addEventListener('click', () => {
    if (!currentRows.length) return;
    const escapeCsv = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`;
    const rows = [
      ['public_address', 'current_balance_btc', 'first_seen', 'last_activity', 'inactive_days', 'activity_records'],
      ...currentRows.map((item) => [
        item.address,
        item.balanceBtc,
        item.firstSeen,
        item.lastActivity,
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
