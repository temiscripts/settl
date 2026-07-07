const POLL_MS = 5000;
const fmtNaira = (kobo) => "₦" + (kobo / 100).toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtPct = (r) => (r * 100).toFixed(1) + "%";
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));

function renderStats(summary) {
  const statsEl = document.getElementById("stats");
  const matchBarSection = document.getElementById("matchBarSection");

  if (!summary || summary.total === 0) {
    statsEl.innerHTML = "";
    matchBarSection.innerHTML = `<div class="empty-state">No transactions yet.</div>`;
    return;
  }

  const s = summary.byState;
  statsEl.innerHTML = `
    <div class="stat-tile"><div class="label">Total</div><div class="value">${summary.total}</div></div>
    <div class="stat-tile"><div class="label">Pending</div><div class="value" style="color:var(--warning)">${s.pending}</div></div>
    <div class="stat-tile"><div class="label">Settled</div><div class="value" style="color:var(--good)">${s.settled}</div></div>
    <div class="stat-tile"><div class="label">Failed</div><div class="value" style="color:var(--critical)">${s.failed}</div></div>
    <div class="stat-tile"><div class="label">Reversing</div><div class="value" style="color:var(--serious)">${s.reversing}</div></div>
    <div class="stat-tile"><div class="label">Reversed</div><div class="value" style="color:var(--text-muted)">${s.reversed}</div></div>
  `;

  const m = summary.byMatch;
  const total = Math.max(m.exact + m.overpaid + m.underpaid + m.none, 1);
  const seg = (n) => Math.max((n / total) * 100, n > 0 ? 1 : 0);
  matchBarSection.innerHTML = `
    <h2>Settlement Match Breakdown</h2>
    <div class="match-bar">
      <div class="seg exact" style="width:${seg(m.exact)}%" title="Exact: ${m.exact}"></div>
      <div class="seg over"  style="width:${seg(m.overpaid)}%" title="Overpaid: ${m.overpaid}"></div>
      <div class="seg under" style="width:${seg(m.underpaid)}%" title="Underpaid: ${m.underpaid}"></div>
      <div class="seg none"  style="width:${seg(m.none)}%" title="No expected amount: ${m.none}"></div>
    </div>
    <div class="legend">
      <span class="item"><span class="swatch exact"></span>Exact (${m.exact})</span>
      <span class="item"><span class="swatch over"></span>Overpaid (${m.overpaid})</span>
      <span class="item"><span class="swatch under"></span>Underpaid (${m.underpaid})</span>
      <span class="item"><span class="swatch none"></span>No expected amount (${m.none})</span>
    </div>
  `;
}

function matchPillClass(match) {
  if (match === "overpaid") return "over";
  if (match === "underpaid") return "under";
  return match;
}

function renderTransactions(rows) {
  const el = document.getElementById("txTable");
  rows = rows || [];

  if (!rows.length) {
    el.innerHTML = `<div class="empty-state">No transactions yet.</div>`;
    return;
  }

  el.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>merchantTxRef</th>
          <th>Account</th>
          <th>Amount</th>
          <th>State</th>
          <th>Match</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map((r) => `
          <tr>
            <td class="ref">${esc(r.merchantTxRef)}</td>
            <td class="ref">${esc(r.accountId)}</td>
            <td class="amount">${fmtNaira(r.amount)}</td>
            <td><span class="pill ${esc(r.state)}">${esc(r.state)}</span></td>
            <td>${r.settlementMatch ? `<span class="pill ${matchPillClass(r.settlementMatch)}">${esc(r.settlementMatch)}</span>` : "—"}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

function renderBankHealth(data) {
  const el = document.getElementById("bankHealth");
  const banks = data && data.banks ? data.banks : [];

  if (!banks.length) {
    el.innerHTML = `<div class="empty-state">No bank data yet — bank codes are captured once Nomba includes sender details on a webhook.</div>`;
    return;
  }

  const icon = { healthy: "●", degraded: "▲", critical: "■" };

  el.innerHTML = banks.map((b) => `
    <div class="bank-card ${b.status}">
      <div class="bank-code">Bank ${esc(b.bankCode)}</div>
      <div class="badge ${b.status}">${icon[b.status] || ""} ${b.status}</div>
      <div class="failure-rate" style="color:var(--${b.status === "healthy" ? "good" : b.status === "degraded" ? "warning" : "critical"})">
        ${fmtPct(b.failureRate)} <span style="font-size:12px;font-weight:400;color:var(--text-muted)">failure rate</span>
      </div>
      <div class="metrics">
        <span>${b.totalTransactions} total</span>
        <span>${b.settled} settled · ${b.pending} pending · ${b.failed} failed</span>
      </div>
    </div>
  `).join("");
}

function renderAuditLog(entries, verify) {
  const chainStatusEl = document.getElementById("chainStatus");
  const listEl = document.getElementById("auditLog");

  if (verify) {
    chainStatusEl.className = "badge " + (verify.valid ? "healthy" : "critical");
    chainStatusEl.textContent = verify.valid
      ? `● verified (${verify.checked} entries)`
      : `■ ${verify.reason || "tampered"}`;
  } else {
    chainStatusEl.className = "badge";
    chainStatusEl.textContent = "";
  }

  const rows = entries || [];
  if (!rows.length) {
    listEl.innerHTML = `<div class="empty-state">No audit events yet.</div>`;
    return;
  }

  listEl.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Seq</th>
          <th>Event</th>
          <th>Time</th>
          <th>Hash</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map((r) => `
          <tr>
            <td>${r.sequenceNumber}</td>
            <td class="ref">${esc(r.eventType)}</td>
            <td>${new Date(r.timestamp).toLocaleTimeString()}</td>
            <td class="ref" title="${esc(r.hash)}">${esc(r.hash).slice(0, 12)}…</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

async function refresh() {
  const liveDot = document.getElementById("liveDot");
  try {
    const [txRes, healthRes, auditRes, verifyRes] = await Promise.all([
      fetch("/v1/transactions?limit=15"),
      fetch("/v1/bank-health"),
      fetch("/v1/audit-log?limit=15"),
      fetch("/v1/audit-log/verify"),
    ]);

    const txData = txRes.ok ? await txRes.json() : null;
    const health = healthRes.ok ? await healthRes.json() : null;
    const auditData = auditRes.ok ? await auditRes.json() : null;
    const verify = verifyRes.ok ? await verifyRes.json() : null;

    renderStats(txData ? txData.summary : null);
    renderTransactions(txData ? txData.transactions : []);
    renderBankHealth(health);
    renderAuditLog(auditData ? auditData.entries : [], verify);

    liveDot.classList.remove("stale");
    document.getElementById("lastUpdated").textContent =
      "Last updated " + new Date().toLocaleTimeString();
  } catch (err) {
    liveDot.classList.add("stale");
    document.getElementById("lastUpdated").textContent = "Connection lost — retrying…";
    console.error(err);
  }
}

refresh();
setInterval(refresh, POLL_MS);
