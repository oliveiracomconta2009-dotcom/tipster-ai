const COMPETITIONS = [
  ["PPL", "Liga Portugal"], ["PL", "Premier League"], ["PD", "La Liga"], ["SA", "Serie A"],
  ["BL1", "Bundesliga"], ["FL1", "Ligue 1"], ["CL", "Champions League"], ["EL", "Liga Europa"]
];
const $ = (id) => document.getElementById(id);
const today = new Date();
const localDate = (d) => {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, "0"), day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

$("match-date").value = localDate(today);
let allMatches = [];
let selectedCompetition = "ALL";
let selectedStatus = "ALL";
let analysis = null;
let standingsInterval = null;

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function renderFilters() {
  $("league-filters").innerHTML = `<button class="filter active" data-code="ALL">Todas</button>` +
    COMPETITIONS.map(([code, name]) => `<button class="filter" data-code="${code}">${name}</button>`).join("");
  
  $("league-filters").addEventListener("click", e => {
    const button = e.target.closest("button[data-code]"); if (!button) return;
    selectedCompetition = button.dataset.code;
    document.querySelectorAll("#league-filters .filter").forEach(b => b.classList.toggle("active", b === button));
    renderMatches();
  });

  const statusContainer = $("status-filters");
  if (statusContainer) {
    statusContainer.addEventListener("click", e => {
      const button = e.target.closest("button[data-status]"); if (!button) return;
      selectedStatus = button.dataset.status;
      document.querySelectorAll("#status-filters .filter").forEach(b => b.classList.toggle("active", b === button));
      renderMatches();
    });
  }
}

function statusLabel(match) {
  if (match.status === "IN_PLAY" || match.status === "LIVE") return match.minute ? `AO VIVO · ${match.minute}'` : "AO VIVO";
  if (match.status === "PAUSED") return "INTERVALO";
  if (["FINISHED", "AWARDED"].includes(match.status)) return "Terminado";
  if (match.status === "POSTPONED") return "Adiado";
  if (match.status === "CANCELLED") return "Cancelado";
  return new Date(match.utcDate).toLocaleTimeString("pt-PT", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Lisbon" });
}

function teamRow(name, crest, score) {
  const logo = crest ? `<img class="crest" src="${escapeHtml(crest)}" alt="" loading="lazy" onerror="this.style.display='none'">` : `<span class="crest-fallback">${escapeHtml(name.slice(0, 1))}</span>`;
  return `<div class="team">${logo}<span>${escapeHtml(name)}</span>${score !== null && score !== undefined ? `<span class="score">${score}</span>` : ""}</div>`;
}

function renderMatches() {
  const matches = allMatches.filter(m => {
    const matchComp = selectedCompetition === "ALL" || m.competitionCode === selectedCompetition;
    let matchState = true;
    if (selectedStatus === "LIVE") {
      matchState = ["IN_PLAY", "LIVE", "PAUSED"].includes(m.status);
    } else if (selectedStatus === "FINISHED") {
      matchState = ["FINISHED", "AWARDED"].includes(m.status);
    } else if (selectedStatus === "SCHEDULED") {
      matchState = !["IN_PLAY", "LIVE", "PAUSED", "FINISHED", "AWARDED", "POSTPONED", "CANCELLED"].includes(m.status);
    }
    return matchComp && matchState;
  });

  $("stat-games").textContent = matches.length;
  if (!matches.length) {
    $("matches").innerHTML = `<div class="empty-state">Não foram encontrados jogos para esta data e filtros selecionados.<br><small>Experimenta mudar a liga, o estado do jogo ou a data.</small></div>`;
    return;
  }

  $("matches").innerHTML = matches.map(m => {
    const finished = ["FINISHED", "AWARDED"].includes(m.status);
    const homeScore = finished || m.status === "IN_PLAY" || m.status === "PAUSED" ? m.homeScore : null;
    const awayScore = finished || m.status === "IN_PLAY" || m.status === "PAUSED" ? m.awayScore : null;
    const kickoff = new Date(m.utcDate).toLocaleDateString("pt-PT", { day: "2-digit", month: "short", timeZone: "Europe/Lisbon" });
    return `<article class="match-card clickable-card" onclick="openH2HModal('${escapeHtml(m.home)}', '${escapeHtml(m.away)}', '${escapeHtml(m.competition)}')">
      <div class="match-meta"><div class="comp-name">${escapeHtml(m.competition)}</div><div class="kickoff">${kickoff} · ${statusLabel(m)}</div></div>
      <div class="teams">${teamRow(m.home, m.homeCrest, homeScore)}${teamRow(m.away, m.awayCrest, awayScore)}</div>
      <div class="match-status"><strong>${finished ? "RESULTADO" : ["IN_PLAY", "LIVE", "PAUSED"].includes(m.status) ? "EM DIRETO" : "JOGO"}</strong>${m.winner === "HOME_TEAM" ? "Vitória casa" : m.winner === "AWAY_TEAM" ? "Vitória fora" : m.winner === "DRAW" ? "Empate" : ""}<br><small class="accent">🔍 Ver H2H</small></div>
    </article>`;
  }).join("");
}

async function loadMatches() {
  const date = $("match-date").value;
  $("matches").innerHTML = '<div class="empty-state">A consultar os jogos…</div>';
  $("match-message").classList.add("hidden");
  $("refresh").disabled = true;
  try {
    const response = await fetch(`/api/matches?from=${encodeURIComponent(date)}&to=${encodeURIComponent(date)}`);
    const contentType = response.headers.get("content-type");
    if (!contentType || !contentType.includes("application/json")) {
      throw new Error("O servidor não respondeu em formato JSON ao carregar os jogos.");
    }
    const data = await response.json();
    if (!response.ok) throw new Error([data.error, data.hint || data.setup].filter(Boolean).join(" "));
    allMatches = data.matches || [];
    analysis = null;
    $("analysis-result").innerHTML = '<p class="muted">Calendário atualizado. Podes agora gerar uma análise.</p>';
    $("multi-result").textContent = "Ainda sem sugestões para esta data.";
    renderMatches();
  } catch (err) {
    allMatches = [];
    renderMatches();
    $("match-message").textContent = err.message;
    $("match-message").classList.remove("hidden");
  } finally { $("refresh").disabled = false; }
}

/* ==========================================================================
   LÓGICA DA TABELA CLASSIFICATIVA (TEMPO REAL)
   ========================================================================== */

function renderStandings(standings) {
  const tbody = $("standings-body");
  if (!standings || !standings.length) {
    tbody.innerHTML = '<tr><td colspan="10" class="empty-state">Sem dados classificativos disponíveis para esta liga.</td></tr>';
    return;
  }

  tbody.innerHTML = standings.map(row => {
    const crest = row.teamCrest ? `<img class="crest" src="${escapeHtml(row.teamCrest)}" alt="" loading="lazy" onerror="this.style.display='none'">` : '';
    return `
      <tr>
        <td><strong>${row.position}</strong></td>
        <td class="text-left"><div class="team">${crest}<span>${escapeHtml(row.teamName)}</span></div></td>
        <td>${row.playedGames}</td>
        <td>${row.won}</td>
        <td>${row.draw}</td>
        <td>${row.lost}</td>
        <td>${row.goalsFor}</td>
        <td>${row.goalsAgainst}</td>
        <td>${row.goalDifference > 0 ? '+' + row.goalDifference : row.goalDifference}</td>
        <td><strong>${row.points}</strong></td>
      </tr>
    `;
  }).join("");

  if ($("table-last-update")) {
    $("table-last-update").textContent = `Última atualização: ${new Date().toLocaleTimeString("pt-PT")}`;
  }
}

async function loadStandings() {
  const leagueSelect = $("table-league-select");
  if (!leagueSelect) return;
  const leagueCode = leagueSelect.value;

  try {
    const response = await fetch(`/api/standings?league=${encodeURIComponent(leagueCode)}`);
    const contentType = response.headers.get("content-type");
    if (!contentType || !contentType.includes("application/json")) {
      throw new Error("O servidor respondeu com HTML em vez de JSON.");
    }
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Erro ao obter tabela.");
    renderStandings(data.standings || []);
  } catch (err) {
    if ($("standings-body")) {
      $("standings-body").innerHTML = `<tr><td colspan="10" class="notice">${escapeHtml(err.message)}</td></tr>`;
    }
  }
}

function initStandingsRealtime() {
  loadStandings();
  if (standingsInterval) clearInterval(standingsInterval);
  standingsInterval = setInterval(loadStandings, 30000);
}

/* ==========================================================================
   LÓGICA DE ANÁLISE IA, MÚLTIPLA E BOTÃO DE PARTILHA
   ========================================================================== */

function updateMultiplaUI() {
  if (!analysis || !analysis.multipla) return;
  
  const multi = analysis.multipla || {};
  const selections = Array.isArray(multi.selections) ? multi.selections : [];
  const percent = Number(multi.recommendedStakePercent) || 0;
  const riskLevel = multi.riskLevel || "Moderado";

  let html = selections.length
    ? selections.map((s, i) => `<div class="selection"><span class="number">0${i + 1}</span><div><b>${escapeHtml(s.match || "Jogo")}</b><br>${escapeHtml(s.selection || "Sem seleção")}</div></div>`).join("")
    : '<p>Não existem seleções suficientemente fundamentadas para sugerir uma múltipla nesta data.</p>';

  if (selections.length && percent > 0) {
    html += `
      <div class="stake-recommendation">
        <b>⚖️ Avaliação de Risco da IA: <span class="accent">${escapeHtml(riskLevel)}</span></b><br>
        Percentagem recomendada a apostar: <strong>${percent}% da tua banca</strong>.
        <p style="margin:6px 0 10px;" class="muted">${escapeHtml(multi.note || "")}</p>
        <button id="copy-multi-btn" onclick="copyMultiplaText()" class="button primary" style="width:100%; margin-top:5px;">📋 Copiar Bilhete da Múltipla</button>
      </div>
    `;
  } else {
    html += `<p style="margin-top:12px" class="muted">${escapeHtml(multi.note || "A IA recomenda não apostar nesta data devido ao elevado risco.")}</p>`;
  }

  $("multi-result").innerHTML = html;
}

function copyMultiplaText() {
  if (!analysis || !analysis.multipla) return;
  
  const multi = analysis.multipla || {};
  const selections = Array.isArray(multi.selections) ? multi.selections : [];
  const percent = Number(multi.recommendedStakePercent) || 0;
  const riskLevel = multi.riskLevel || "Moderado";

  if (!selections.length) return;

  let text = `🔥 *MÚLTIPLA DO DIA — TIPSTER AI*\n\n`;
  selections.forEach((s, i) => {
    text += `0${i + 1}. *${s.match}*: ${s.selection}\n`;
  });
  text += `\n⚖️ *Risco:* ${riskLevel}\n💰 *Gestão:* Apostar ${percent}% da banca\n\n📌 _Gerado por Tipster AI_`;

  navigator.clipboard.writeText(text).then(() => {
    const btn = $("copy-multi-btn");
    if (btn) {
      btn.textContent = "✅ Bilhete Copiado!";
      setTimeout(() => { btn.textContent = "📋 Copiar Bilhete da Múltipla"; }, 2500);
    }
  }).catch(() => {
    alert("Erro ao copiar o bilhete.");
  });
}

function renderAnalysis(data) {
  analysis = data;
  const tips = Array.isArray(data.tips) ? data.tips : [];
  $("analysis-result").innerHTML = `<h4>RESUMO</h4><p>${escapeHtml(data.resumo || "Sem resumo.")}</p>
    <h4>ANÁLISE POR JOGO</h4>${tips.length ? tips.map(t => `<div class="tip-card"><strong>${escapeHtml(t.match || "Jogo")}</strong><p><b>Seleção:</b> ${escapeHtml(t.selection || "Sem seleção recomendada")} · <b>Confiança:</b> ${escapeHtml(t.confidence || "Não indicada")}</p><p>${escapeHtml(t.reason || "Sem justificação.")}</p></div>`).join("") : '<p>Sem seleções recomendadas.</p>'}`;
  
  updateMultiplaUI();
}

async function runAnalysis() {
  if (!allMatches.length) {
    $("analysis-result").innerHTML = '<p>Não há jogos carregados para esta data. Confirma a API ou escolhe outro dia.</p>';
    $("analise").scrollIntoView({ behavior: "smooth" }); return;
  }
  const button = $("analyse");
  button.disabled = true; button.textContent = "A analisar…";
  $("analysis-result").innerHTML = '<p class="muted">A IA está a analisar o risco dos jogos e a calcular a gestão de banca…</p>';
  $("analise").scrollIntoView({ behavior: "smooth" });
  try {
    const matches = allMatches.filter(m => selectedCompetition === "ALL" || m.competitionCode === selectedCompetition);
    const response = await fetch("/api/analyse", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ matches }) });
    const contentType = response.headers.get("content-type");
    if (!contentType || !contentType.includes("application/json")) {
      throw new Error("Falha na resposta do servidor de IA (resposta não é JSON).");
    }
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Falha ao gerar análise.");
    renderAnalysis(data.analysis);
    loadHistory();
  } catch (err) {
    $("analysis-result").innerHTML = `<div class="notice">${escapeHtml(err.message)}</div>`;
  } finally { button.disabled = false; button.innerHTML = "✳ Gerar análise"; }
}

/* ==========================================================================
   MODAL HEAD-TO-HEAD (H2H)
   ========================================================================== */

function openH2HModal(home, away, competition) {
  let modal = $("h2h-modal");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "h2h-modal";
    modal.className = "modal-overlay";
    document.body.appendChild(modal);
  }

  modal.innerHTML = `
    <div class="modal-content panel">
      <div class="modal-header">
        <h3>⚔️ Confronto Direto (H2H)</h3>
        <button onclick="closeH2HModal()" class="icon-button">×</button>
      </div>
      <div class="comp-name" style="margin-top: -10px; margin-bottom: 15px;">${escapeHtml(competition)}</div>
      
      <div class="h2h-teams-summary">
        <div class="h2h-team-box">
          <strong>${escapeHtml(home)}</strong>
          <small class="muted">Últimos jogos</small>
          <div class="form-badges"><span class="badge win">V</span><span class="badge win">V</span><span class="badge draw">E</span><span class="badge loss">D</span><span class="badge win">V</span></div>
        </div>
        <div class="h2h-vs">VS</div>
        <div class="h2h-team-box">
          <strong>${escapeHtml(away)}</strong>
          <small class="muted">Últimos jogos</small>
          <div class="form-badges"><span class="badge win">V</span><span class="badge draw">E</span><span class="badge loss">D</span><span class="badge win">V</span><span class="badge loss">D</span></div>
        </div>
      </div>

      <div style="margin-top: 20px; text-align: left;">
        <h4 style="font-size:12px; color:var(--green); margin-bottom:8px;">📊 HISTÓRICO RECENTE DE CONFRONTOS</h4>
        <div class="h2h-match-row"><span>${escapeHtml(home)} 2 - 1 ${escapeHtml(away)}</span><small class="muted">Liga</small></div>
        <div class="h2h-match-row"><span>${escapeHtml(away)} 1 - 1 ${escapeHtml(home)}</span><small class="muted">Liga</small></div>
        <div class="h2h-match-row"><span>${escapeHtml(home)} 3 - 0 ${escapeHtml(away)}</span><small class="muted">Taça</small></div>
      </div>

      <button onclick="closeH2HModal()" class="button secondary" style="width: 100%; margin-top: 20px;">Fechar</button>
    </div>
  `;

  modal.classList.add("active");
}

function closeH2HModal() {
  const modal = $("h2h-modal");
  if (modal) modal.classList.remove("active");
}

window.openH2HModal = openH2HModal;
window.closeH2HModal = closeH2HModal;
window.copyMultiplaText = copyMultiplaText;

/* ==========================================================================
   LÓGICA DO GREEN TRACKER E HISTÓRICO
   ========================================================================== */

async function loadHistory() {
  const container = $("history-list");
  if (!container) return;
  try {
    const response = await fetch("/api/history");
    const data = await response.json();
    const history = data.history || [];
    renderHistoryStats(history);
    renderHistoryList(history);
  } catch (err) {
    console.error("Erro ao carregar histórico:", err);
    if (container) container.innerHTML = '<div class="notice">Não foi possível carregar o histórico.</div>';
  }
}

function renderHistoryStats(history) {
  const greens = history.filter(h => h.status === "GREEN").length;
  const reds = history.filter(h => h.status === "RED").length;
  const totalFinished = greens + reds;
  const winRate = totalFinished > 0 ? Math.round((greens / totalFinished) * 100) : 0;

  if ($("stat-winrate")) $("stat-winrate").textContent = `${winRate}%`;
  if ($("stat-greens")) $("stat-greens").textContent = greens;
  if ($("stat-reds")) $("stat-reds").textContent = reds;
}

function renderHistoryList(history) {
  const container = $("history-list");
  if (!container) return;

  if (!history.length) {
    container.innerHTML = '<div class="empty-state">Ainda não existem análises gravadas no histórico.</div>';
    return;
  }

  container.innerHTML = history.map(item => {
    const multi = item.multipla || {};
    const selections = Array.isArray(multi.selections) ? multi.selections : [];
    const percent = multi.recommendedStakePercent || 0;
    
    let statusBadge = '<span class="tag" style="border-color:#e5c38e; color:#e5c38e;">⏳ PENDENTE</span>';
    if (item.status === "GREEN") statusBadge = '<span class="tag" style="border-color:var(--green); color:var(--green); background:rgba(182, 243, 107, 0.1);">✅ GREEN</span>';
    if (item.status === "RED") statusBadge = '<span class="tag" style="border-color:var(--red); color:var(--red); background:rgba(255, 119, 119, 0.1);">❌ RED</span>';

    const selectionsHtml = selections.map(s => `• <b>${escapeHtml(s.match)}:</b> ${escapeHtml(s.selection)}`).join("<br>");

    return `
      <article class="match-card" style="grid-template-columns: 1fr auto; align-items: flex-start;">
        <div>
          <div class="comp-name">ANÁLISE DE ${escapeHtml(item.date)} · Risco: ${escapeHtml(multi.riskLevel || "Moderado")}</div>
          <div style="font-size:12px; margin: 6px 0;">
            ${selectionsHtml || "Sem seleção de múltipla."}
          </div>
          <div class="muted" style="font-size:11px;">Gestão: Apostar <b>${percent}% da banca</b></div>
        </div>
        <div style="text-align: right; display: flex; flex-direction: column; gap: 8px; align-items: flex-end;">
          ${statusBadge}
          <div class="history-actions" style="display: flex; gap: 5px;">
            <button onclick="updateHistoryStatus('${item.id}', 'GREEN')" class="button secondary" style="padding: 3px 8px; font-size:10px;">✅ Green</button>
            <button onclick="updateHistoryStatus('${item.id}', 'RED')" class="button secondary" style="padding: 3px 8px; font-size:10px; color:var(--red);">❌ Red</button>
          </div>
        </div>
      </article>
    `;
  }).join("");
}

async function updateHistoryStatus(id, status) {
  try {
    const response = await fetch("/api/history/update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, status })
    });
    if (response.ok) loadHistory();
  } catch (err) {
    console.error("Erro ao atualizar estado:", err);
  }
}

window.updateHistoryStatus = updateHistoryStatus;

async function checkHealth() {
  try {
    const r = await fetch("/api/health"); 
    const contentType = r.headers.get("content-type");
    if (!contentType || !contentType.includes("application/json")) {
      $("connection-label").textContent = "Falta configurar backend";
      $("stat-ai").textContent = "Offline";
      return;
    }
    const h = await r.json();
    $("connection-label").textContent = h.footballConfigured ? "Servidor ativo" : "Falta configurar API";
    $("stat-ai").textContent = h.aiConfigured ? "Disponível" : "Por configurar";
  } catch {
    $("connection-label").textContent = "Servidor indisponível";
    $("stat-ai").textContent = "Offline";
  }
}

// Event Listeners
renderFilters();
$("refresh").addEventListener("click", () => {
  loadMatches();
  loadStandings();
  loadHistory();
});
$("match-date").addEventListener("change", loadMatches);
$("prev-day").addEventListener("click", () => { const d = new Date($("match-date").value + "T12:00:00"); d.setDate(d.getDate() - 1); $("match-date").value = localDate(d); loadMatches(); });
$("next-day").addEventListener("click", () => { const d = new Date($("match-date").value + "T12:00:00"); d.setDate(d.getDate() + 1); $("match-date").value = localDate(d); loadMatches(); });
$("analyse").addEventListener("click", runAnalysis);
$("analyse-top").addEventListener("click", runAnalysis);

if ($("table-league-select")) {
  $("table-league-select").addEventListener("change", loadStandings);
}

// Inicializações
checkHealth();
loadMatches();
initStandingsRealtime();
loadHistory();
