// State Management
let apiToken = localStorage.getItem('recall_admin_token') || null;
let activeCategory = '';
let searchQuery = '';
let searchTimeout = null;

// DOM Elements
const authOverlay = document.getElementById('auth-overlay');
const authForm = document.getElementById('auth-form');
const adminPasswordInput = document.getElementById('admin-password');
const authError = document.getElementById('auth-error');

const appContainer = document.getElementById('app-container');
const logoutBtn = document.getElementById('logout-btn');
const activeWorkspaceName = document.getElementById('active-workspace-name');
const installBanner = document.getElementById('install-banner');
const installBannerText = document.getElementById('install-banner-text');

// Stats DOM
const statTotalCount = document.getElementById('stat-total-count');
const statActiveChannels = document.getElementById('stat-active-channels');
const statWorkspacesCount = document.getElementById('stat-workspaces-count');
const chartTotalCount = document.getElementById('chart-total-count');

// Donut segments
const donutDecision = document.getElementById('donut-segment-decision');
const donutCommitment = document.getElementById('donut-segment-commitment');
const donutResolved = document.getElementById('donut-segment-resolved');

// Percent text labels
const pctDecisions = document.getElementById('pct-decisions');
const pctCommitments = document.getElementById('pct-commitments');
const pctResolved = document.getElementById('pct-resolved');

// List Feed DOM
const decisionsList = document.getElementById('decisions-list');
const decisionsLoading = document.getElementById('decisions-loading');
const decisionsEmpty = document.getElementById('decisions-empty');
const searchFilter = document.getElementById('search-filter');
const filterBtns = document.querySelectorAll('.filter-btn');

// --- Initialization ---
document.addEventListener('DOMContentLoaded', () => {
  checkInstallationBanner();
  
  if (apiToken) {
    initDashboard();
  } else {
    showLogin();
  }
});

// --- Auth Flow ---
authForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const password = adminPasswordInput.value;
  authError.textContent = '';

  try {
    const res = await fetch('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password })
    });
    
    const data = await res.json();
    
    if (res.ok && data.success) {
      apiToken = data.token;
      localStorage.setItem('recall_admin_token', apiToken);
      initDashboard();
    } else {
      authError.textContent = data.error || 'Authentication failed.';
    }
  } catch (err) {
    authError.textContent = 'Server unreachable. Verify connection.';
  }
});

logoutBtn.addEventListener('click', () => {
  localStorage.removeItem('recall_admin_token');
  apiToken = null;
  showLogin();
});

function showLogin() {
  authOverlay.classList.remove('hidden');
  appContainer.classList.add('hidden');
  adminPasswordInput.value = '';
  authError.textContent = '';
}

function initDashboard() {
  authOverlay.classList.add('hidden');
  appContainer.classList.remove('hidden');
  
  loadStats();
  loadDecisions();
}

// --- Fetch & Update Stats (with custom SVG donut rendering) ---
async function loadStats() {
  try {
    const res = await fetch('/api/stats', {
      headers: { 'Authorization': `Bearer ${apiToken}` }
    });

    if (res.status === 401 || res.status === 403) {
      logoutBtn.click();
      return;
    }

    const data = await res.json();
    
    // Update Stats row text
    statTotalCount.textContent = data.totalCount;
    statActiveChannels.textContent = data.activeChannels;
    statWorkspacesCount.textContent = data.totalWorkspaces;
    chartTotalCount.textContent = data.totalCount;

    // Display primary active workspace
    if (data.workspaces && data.workspaces.length > 0) {
      activeWorkspaceName.textContent = data.workspaces[0].team_name;
    } else {
      activeWorkspaceName.textContent = 'No workspaces connected';
    }

    // Render donut chart
    updateDonutChart(data.categoryBreakdown, data.totalCount);

  } catch (error) {
    console.error('Failed to load stats:', error);
  }
}

function updateDonutChart(breakdown, total) {
  if (total === 0) {
    // Empty default
    donutDecision.setAttribute('stroke-dasharray', '0 100');
    donutCommitment.setAttribute('stroke-dasharray', '0 100');
    donutResolved.setAttribute('stroke-dasharray', '0 100');
    pctDecisions.textContent = '0%';
    pctCommitments.textContent = '0%';
    pctResolved.textContent = '0%';
    return;
  }

  const decCount = breakdown.decision || 0;
  const comCount = breakdown.commitment || 0;
  const resCount = breakdown.resolved_question || 0;

  const decPct = Math.round((decCount / total) * 100);
  const comPct = Math.round((comCount / total) * 100);
  const resPct = Math.round((resCount / total) * 100);

  pctDecisions.textContent = `${decPct}%`;
  pctCommitments.textContent = `${comPct}%`;
  pctResolved.textContent = `${resPct}%`;

  // Draw stacked elements in circular path (circumference = 100)
  donutDecision.setAttribute('stroke-dasharray', `${decPct} ${100 - decPct}`);
  donutDecision.setAttribute('stroke-dashoffset', '0');

  donutCommitment.setAttribute('stroke-dasharray', `${comPct} ${100 - comPct}`);
  donutCommitment.setAttribute('stroke-dashoffset', `-${decPct}`);

  donutResolved.setAttribute('stroke-dasharray', `${resPct} ${100 - resPct}`);
  donutResolved.setAttribute('stroke-dashoffset', `-${decPct + comPct}`);
}

// --- Fetch & Update Decisions Log ---
async function loadDecisions() {
  decisionsLoading.classList.remove('hidden');
  decisionsEmpty.classList.add('hidden');
  decisionsList.classList.add('hidden');
  decisionsList.innerHTML = '';

  try {
    const params = new URLSearchParams();
    if (activeCategory) params.append('category', activeCategory);
    if (searchQuery) params.append('search', searchQuery);

    const res = await fetch(`/api/decisions?${params.toString()}`, {
      headers: { 'Authorization': `Bearer ${apiToken}` }
    });

    if (res.status === 401 || res.status === 403) {
      logoutBtn.click();
      return;
    }

    const decisions = await res.json();
    decisionsLoading.classList.add('hidden');

    if (decisions.length === 0) {
      decisionsEmpty.classList.remove('hidden');
      return;
    }

    decisionsList.classList.remove('hidden');
    decisions.forEach(decision => {
      const card = createDecisionCard(decision);
      decisionsList.appendChild(card);
    });

  } catch (error) {
    console.error('Failed to load decisions:', error);
    decisionsLoading.classList.add('hidden');
    decisionsEmpty.classList.remove('hidden');
    decisionsEmpty.querySelector('.empty-text').textContent = 'Error Loading Logs';
    decisionsEmpty.querySelector('.empty-subtext').textContent = 'Please refresh the page to try again.';
  }
}

function createDecisionCard(decision) {
  const card = document.createElement('div');
  card.className = `decision-card category-${decision.category}`;
  
  // Format Category Label text
  let categoryLabel = 'Decision';
  if (decision.category === 'commitment') categoryLabel = 'Commitment';
  if (decision.category === 'resolved_question') categoryLabel = 'Resolved Q';

  const dateStr = decision.message_date 
    ? new Date(decision.message_date).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      })
    : 'Unknown Date';

  card.innerHTML = `
    <div class="decision-card-glow"></div>
    <div class="card-top">
      <div class="badge-row">
        <span class="badge badge-${decision.category}">${categoryLabel}</span>
        <span class="channel-tag">#${decision.channel_name || 'unknown'}</span>
      </div>
      <div class="card-actions">
        ${decision.slack_link ? `
          <a href="${decision.slack_link}" target="_blank" rel="noopener" class="slack-link-icon" title="View thread in Slack">
            <svg xmlns="http://www.w3.org/2000/svg" height="18px" viewBox="0 -960 960 960" width="18px" fill="currentColor"><path d="M440-280H280q-83 0-141.5-58.5T80-480q0-83 58.5-141.5T280-680h160v80H280q-50 0-85 35t-35 85q0 50 35 85t35 35h160v80ZM320-440v-80h320v80H320Zm200 160v-80h160q50 0 85-35t35-85q0-50-35-85t-35-35H520v-80h160q83 0 141.5 58.5T880-480q0 83-58.5 141.5T680-280H520Z"/></svg>
          </a>
        ` : ''}
        <button class="btn-delete" data-id="${decision.id}" title="Remove decision from memory">
          <svg xmlns="http://www.w3.org/2000/svg" height="18px" viewBox="0 -960 960 960" width="18px"><path d="M280-120q-33 0-56.5-23.5T200-200v-520h-40v-80h200v-40h240v40h200v80h-40v520q0 33-23.5 56.5T680-120H280Zm400-600H280v520h400v-520ZM360-280h80v-360h-80v360Zm160 0h80v-360h-80v360ZM280-720v520-520Z"/></svg>
        </button>
      </div>
    </div>
    
    <div class="decision-statement">
      ${escapeHtml(decision.decision_text)}
    </div>
    
    <div class="decision-details">
      ${decision.rationale ? `
        <div class="detail-line rationale">
          <strong>Rationale:</strong> ${escapeHtml(decision.rationale)}
        </div>
      ` : ''}
      <div class="detail-meta-row">
        <span class="meta-owner">Owner: <strong>${escapeHtml(decision.user_name || decision.user_id)}</strong></span>
        <span class="meta-date">${dateStr}</span>
      </div>
    </div>
  `;

  // Attach delete event
  const deleteBtn = card.querySelector('.btn-delete');
  deleteBtn.addEventListener('click', () => {
    const decisionId = deleteBtn.getAttribute('data-id');
    deleteDecision(decisionId, card);
  });

  return card;
}

// --- Deletion Flow ---
async function deleteDecision(id, cardElement) {
  if (!confirm('Are you sure you want to delete this captured decision from memory?')) {
    return;
  }

  try {
    const res = await fetch(`/api/decisions/${id}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${apiToken}` }
    });

    if (res.ok) {
      // Smooth fade out animation
      cardElement.style.opacity = '0';
      cardElement.style.transform = 'scale(0.95)';
      cardElement.style.transition = 'all 0.3s ease-out';
      
      setTimeout(() => {
        cardElement.remove();
        loadStats(); // refresh statistics count
        
        // Check if list became empty
        if (decisionsList.children.length === 0) {
          decisionsEmpty.classList.remove('hidden');
        }
      }, 300);
    } else {
      const data = await res.json();
      alert(`Failed to delete record: ${data.error || 'Unknown error'}`);
    }
  } catch (error) {
    alert('Network error. Failed to delete record.');
  }
}

// --- Interactive Events & Filtering ---
searchFilter.addEventListener('input', (e) => {
  clearTimeout(searchTimeout);
  searchQuery = e.target.value.trim();
  
  // Debounce search to prevent immediate consecutive queries
  searchTimeout = setTimeout(() => {
    loadDecisions();
  }, 350);
});

filterBtns.forEach(btn => {
  btn.addEventListener('click', (e) => {
    filterBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    
    activeCategory = btn.getAttribute('data-category');
    loadDecisions();
  });
});

// --- URL OAuth Feedback Helper ---
function checkInstallationBanner() {
  const urlParams = new URLSearchParams(window.location.search);
  const installed = urlParams.get('installed');
  const team = urlParams.get('team');
  const error = urlParams.get('error');

  if (installed === 'true') {
    installBannerText.innerHTML = `🎉 <strong>Success!</strong> Recall was successfully authorized and added to <strong>${escapeHtml(team)}</strong>.`;
    installBanner.classList.remove('hidden');
  } else if (installed === 'false') {
    installBannerText.innerHTML = `⚠️ <strong>Installation Failed:</strong> ${escapeHtml(error || 'Authorization aborted.')}`;
    installBanner.classList.remove('hidden');
    // Change style to error theme
    installBanner.style.background = 'linear-gradient(90deg, rgba(239, 68, 68, 0.15) 0%, rgba(245, 158, 11, 0.15) 100%)';
    installBanner.style.borderColor = 'rgba(239, 68, 68, 0.3)';
  }

  // Clean the URL search parameters to make it neat
  if (installed) {
    const cleanUrl = window.location.protocol + "//" + window.location.host + window.location.pathname;
    window.history.replaceState({ path: cleanUrl }, '', cleanUrl);
  }
}

// Utility: HTML escaping
function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
