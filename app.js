'use strict';

const tabButtons = [...document.querySelectorAll('.tab-button')];
const tabPanels = [...document.querySelectorAll('.tab-panel')];

function switchTab(name) {
  for (const button of tabButtons) {
    button.classList.toggle('active', button.dataset.tab === name);
  }
  for (const panel of tabPanels) {
    panel.hidden = panel.dataset.panel !== name;
  }
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

for (const button of tabButtons) {
  button.addEventListener('click', () => switchTab(button.dataset.tab));
}
window.switchAuditorTab = switchTab;

const form = document.querySelector('#address-form');
const addressInput = document.querySelector('#address');
const accessTokenInput = document.querySelector('#access-token');
const checkButton = document.querySelector('#check-button');
const pasteButton = document.querySelector('#paste-button');
const clearButton = document.querySelector('#clear-button');
const message = document.querySelector('#message');
const results = document.querySelector('#results');
const statusPanel = document.querySelector('.status-panel');
const statusLabel = document.querySelector('#status-label');
const statusPill = document.querySelector('#status-pill');
const resultAddress = document.querySelector('#result-address');
const evidenceList = document.querySelector('#evidence-list');
const disclaimer = document.querySelector('#disclaimer');
const balance = document.querySelector('#balance');
const nonce = document.querySelector('#nonce');
const addressType = document.querySelector('#address-type');
const historyCount = document.querySelector('#history-count');
const partialNote = document.querySelector('#partial-note');
const historyBody = document.querySelector('#history-body');
const emptyHistory = document.querySelector('#empty-history');

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

function showMessage(text) {
  message.textContent = text;
  message.hidden = false;
}

function hideMessage() {
  message.textContent = '';
  message.hidden = true;
}

function setBusy(isBusy) {
  checkButton.disabled = isBusy;
  pasteButton.disabled = isBusy;
  clearButton.disabled = isBusy;
  checkButton.textContent = isBusy ? 'Checking Mainnet…' : 'Check Mainnet history';
}

function shortenAddress(value) {
  if (!value || value.length < 16) return value || '—';
  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}

function formatTimestamp(value) {
  if (!value) return 'Unknown';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown';
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date);
}

function formatValue(item) {
  const asset = item.asset || item.category.toUpperCase();
  if (item.value === null || item.value === undefined) {
    return item.tokenId ? `${asset} #${item.tokenId}` : asset;
  }
  const numeric = typeof item.value === 'number'
    ? new Intl.NumberFormat(undefined, { maximumSignificantDigits: 8 }).format(item.value)
    : String(item.value);
  return `${numeric} ${asset}`;
}

function counterpartyFor(item, checkedAddress) {
  const checked = checkedAddress.toLowerCase();
  if (item.direction === 'incoming') return item.from;
  if (item.direction === 'outgoing') return item.to;
  if (item.from?.toLowerCase() !== checked) return item.from;
  return item.to;
}

function createCell(text, className = '') {
  const cell = document.createElement('td');
  cell.textContent = text;
  if (className) cell.className = className;
  return cell;
}

function renderHistory(items, checkedAddress) {
  historyBody.replaceChildren();
  emptyHistory.hidden = items.length > 0;

  for (const item of items) {
    const row = document.createElement('tr');
    row.append(createCell(formatTimestamp(item.timestamp)));

    const directionCell = document.createElement('td');
    const direction = document.createElement('span');
    direction.className = `direction ${item.direction}`;
    direction.textContent = item.direction;
    directionCell.append(direction);
    row.append(directionCell);

    row.append(createCell(item.category.toUpperCase()));
    row.append(createCell(formatValue(item)));

    const counterparty = counterpartyFor(item, checkedAddress);
    const counterpartyCell = createCell(shortenAddress(counterparty), 'mono address-short');
    counterpartyCell.title = counterparty || '';
    row.append(counterpartyCell);

    const txCell = document.createElement('td');
    if (item.hash) {
      const link = document.createElement('a');
      link.href = `https://etherscan.io/tx/${encodeURIComponent(item.hash)}`;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = shortenAddress(item.hash);
      link.className = 'mono';
      txCell.append(link);
    } else {
      txCell.textContent = '—';
    }
    row.append(txCell);
    historyBody.append(row);
  }
}

function renderResult(data) {
  const found = Boolean(data.activity?.found);
  statusPanel.classList.toggle('activity', found);
  statusPanel.classList.toggle('empty', !found);
  statusPill.className = `status-pill ${found ? 'activity' : 'empty'}`;
  statusLabel.textContent = data.activity?.label || 'CHECK COMPLETE';
  statusPill.textContent = found ? 'Used / active evidence' : 'No evidence returned';
  resultAddress.textContent = data.address;

  evidenceList.replaceChildren();
  const evidence = data.activity?.evidence || [];
  const statements = evidence.length
    ? evidence
    : ['Balance, outgoing nonce, contract code, and returned indexed transfers are all zero or empty.'];
  for (const statement of statements) {
    const item = document.createElement('li');
    item.textContent = statement;
    evidenceList.append(item);
  }

  disclaimer.textContent = data.disclaimer || '';
  balance.textContent = `${data.state?.balanceEth ?? '0'} ETH`;
  nonce.textContent = data.state?.outgoingTransactionCount ?? '0';
  addressType.textContent = data.state?.hasContractCode ? 'Smart contract' : 'Externally owned / empty';
  historyCount.textContent = String(data.history?.returned ?? 0);
  partialNote.textContent = data.history?.partial
    ? 'Showing the latest returned records; more history exists.'
    : 'All records returned by this query fit in the current result.';

  renderHistory(data.history?.transfers || [], data.address);
  results.hidden = false;
  results.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  hideMessage();

  const address = addressInput.value.trim();
  if (!ADDRESS_RE.test(address)) {
    showMessage('Enter a valid Ethereum address beginning with 0x followed by 40 hexadecimal characters.');
    addressInput.focus();
    return;
  }

  setBusy(true);
  try {
    const headers = { 'Content-Type': 'application/json' };
    const accessToken = accessTokenInput.value;
    if (accessToken) headers['X-App-Access-Token'] = accessToken;

    const response = await fetch('/api/check-address', {
      method: 'POST',
      headers,
      body: JSON.stringify({ address })
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Check failed (${response.status}).`);
    renderResult(data);
  } catch (error) {
    results.hidden = true;
    showMessage(error.message || 'Unable to check this address.');
  } finally {
    setBusy(false);
  }
});

pasteButton.addEventListener('click', async () => {
  hideMessage();
  try {
    const clipboardText = await navigator.clipboard.readText();
    addressInput.value = clipboardText.trim();
    addressInput.focus();
  } catch {
    showMessage('Clipboard access was blocked. Paste the public address manually.');
  }
});

clearButton.addEventListener('click', () => {
  addressInput.value = '';
  accessTokenInput.value = '';
  results.hidden = true;
  hideMessage();
  addressInput.focus();
});

window.openDetailedAddress = (address, accessToken = '') => {
  switchTab('address');
  addressInput.value = address;
  if (accessToken) accessTokenInput.value = accessToken;
  addressInput.focus();
};
