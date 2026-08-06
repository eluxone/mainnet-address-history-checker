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
  const previewButton = document.querySelector('#btc-preview-button');
  const searchButton = document.querySelector('#btc-search-button');
  const previewPanel = document.querySelector('#btc-cost-preview');
  const previewStatus = document.querySelector('#btc-preview-status');
  const previewEstimate = document.querySelector('#btc-preview-estimate');
  const previewLimit = document.querySelector('#btc-preview-limit');
  const previewPercent = document.querySelector('#btc-preview-percent');
  const previewCache = document.querySelector('#btc-preview-cache');
  const previewNote = document.querySelector('#btc-preview-note');

  if (!previewButton || !searchButton || !previewPanel) return;

  const watchedInputs = [startDate, endDate, minInactive, minBalance, maxBalance, target, candidateLimit];
  let approved = false;
  let approvedFingerprint = '';
  let previewController = null;

  function safeNumber(input) {
    const value = Number(input.value);
    return Number.isFinite(value) ? value : null;
  }

  function payload() {
    return {
      startDate: startDate.value,
      endDate: endDate.value,
      minBalanceBtc: safeNumber(minBalance),
      maxBalanceBtc: safeNumber(maxBalance),
      minInactiveDays: Math.trunc(safeNumber(minInactive) ?? 0),
      target: Math.trunc(safeNumber(target) ?? 0),
      candidateLimit: Math.trunc(safeNumber(candidateLimit) ?? 0)
    };
  }

  function fingerprint(value = payload()) {
    return JSON.stringify(value);
  }

  function formatBytes(value) {
    const bytes = Number(value);
    if (!Number.isFinite(bytes) || bytes < 0) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let amount = bytes;
    let unit = 0;
    while (amount >= 1000 && unit < units.length - 1) {
      amount /= 1000;
      unit += 1;
    }
    return `${amount.toFixed(amount >= 10 || unit === 0 ? 1 : 2)} ${units[unit]}`;
  }

  function setStatus(text, ok = null) {
    previewStatus.textContent = text;
    previewStatus.className = ok === true
      ? 'status-pill activity'
      : ok === false
        ? 'status-pill empty'
        : 'status-pill';
  }

  function invalidatePreview() {
    approved = false;
    approvedFingerprint = '';
    previewController?.abort();
    previewController = null;
    previewPanel.hidden = true;
    previewEstimate.textContent = '—';
    previewLimit.textContent = '—';
    previewPercent.textContent = '—';
    previewCache.textContent = '—';
    previewNote.textContent = 'Change detected. Run a new cost preview before starting the search.';
    searchButton.disabled = true;
  }

  async function runPreview() {
    const currentPayload = payload();
    approved = false;
    approvedFingerprint = '';
    searchButton.disabled = true;
    previewPanel.hidden = false;
    setStatus('Checking cost…');
    previewEstimate.textContent = '…';
    previewLimit.textContent = '…';
    previewPercent.textContent = '…';
    previewCache.textContent = '…';
    previewNote.textContent = 'Running a preview only. No candidate-discovery query is being executed.';

    previewController?.abort();
    previewController = new AbortController();
    previewButton.disabled = true;
    previewButton.textContent = 'Checking search cost…';

    try {
      const headers = { 'Content-Type': 'application/json' };
      if (accessToken.value) headers['X-App-Access-Token'] = accessToken.value;
      const response = await fetch('/api/btc-preview', {
        method: 'POST',
        headers,
        body: JSON.stringify(currentPayload),
        signal: previewController.signal
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `Cost preview failed (${response.status}).`);

      previewEstimate.textContent = formatBytes(data.estimatedBytes);
      previewLimit.textContent = formatBytes(data.maxBytes);
      previewPercent.textContent = data.candidateCacheHit ? '0%' : `${Number(data.percentOfLimit || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}%`;
      previewCache.textContent = data.candidateCacheHit
        ? `Cached${Number.isFinite(Number(data.candidateCount)) ? ` · ${new Intl.NumberFormat().format(Number(data.candidateCount))} candidates` : ''}`
        : 'New discovery required';
      previewNote.textContent = data.note || '';

      if (data.allowed) {
        approved = true;
        approvedFingerprint = fingerprint(currentPayload);
        searchButton.disabled = false;
        setStatus(data.candidateCacheHit ? 'Ready · 0 B new BigQuery discovery' : 'Ready · within safety limit', true);
      } else {
        searchButton.disabled = true;
        setStatus('Blocked · above safety limit', false);
      }
    } catch (error) {
      if (error?.name !== 'AbortError') {
        setStatus('Preview failed', false);
        previewEstimate.textContent = '—';
        previewLimit.textContent = '—';
        previewPercent.textContent = '—';
        previewCache.textContent = '—';
        previewNote.textContent = error?.message || 'Unable to preview the search cost.';
      }
    } finally {
      previewController = null;
      previewButton.disabled = false;
      previewButton.textContent = 'Check search cost';
    }
  }

  previewButton.addEventListener('click', runPreview);

  form.addEventListener('submit', (event) => {
    const valid = approved && approvedFingerprint === fingerprint();
    if (valid) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    searchButton.disabled = true;
    previewPanel.hidden = false;
    setStatus('Cost preview required', false);
    previewNote.textContent = 'Run Check search cost after the latest filter changes before starting the search.';
  }, true);

  for (const input of watchedInputs) {
    input.addEventListener('change', invalidatePreview);
    input.addEventListener('input', () => {
      if (approved && approvedFingerprint !== fingerprint()) invalidatePreview();
    });
  }

  searchButton.disabled = true;
})();
