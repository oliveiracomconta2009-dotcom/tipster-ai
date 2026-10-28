import express from "express";
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";

dotenv.config();
const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const FOOTBALL_TOKEN = process.env.FOOTBALL_DATA_TOKEN;
const GEMINI_KEY = process.env.GEMINI_API_KEY;

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

const COMPETITIONS = ["PPL", "PL", "PD", "SA", "BL1", "FL1", "CL", "EL"];
const HISTORY_FILE = path.join(__dirname, "history.json");

// Cache simples em memória para as tabelas classificativas
const standingsCache = new Map();

/* ==========================================================================
   FUNÇÕES AUXILIARES DO GREEN TRACKER (HISTÓRICO)
   ========================================================================== */
async function getHistoryData() {
  try {
    const data = await fs.readFile(HISTORY_FILE, "utf-8");
    return JSON.parse(data);
  } catch {
    return [];
  }
}

async function saveHistoryData(history) {
  try {
    await fs.writeFile(HISTORY_FILE, JSON.stringify(history, null, 2), "utf-8");
  } catch (err) {
    console.error("Erro ao guardar histórico:", err);
  }
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    footballConfigured: Boolean(FOOTBALL_TOKEN),
    aiConfigured: Boolean(GEMINI_KEY)
  });
});

/* ==========================================================================
   ROTAS DO GREEN TRACKER
   ========================================================================== */
app.get("/api/history", async (_req, res) => {
  const history = await getHistoryData();
  res.json({ history });
});

app.post("/api/history/update", async (req, res) => {
  const { id, status } = req.body;
  let history = await getHistoryData();

  history = history.map(item => {
    if (item.id === id) {
      return { ...item, status };
    }
    return item;
  });

  await saveHistoryData(history);
  res.json({ ok: true, history });
});

/* ==========================================================================
   ROTA PARA A TABELA CLASSIFICATIVA (FRONTEND)
   ========================================================================== */
app.get("/api/standings", async (req, res) => {
  if (!FOOTBALL_TOKEN) {
    return res.status(503).json({ error: "Falta configurar FOOTBALL_DATA_TOKEN." });
  }

  const league = req.query.league || "PL";

  try {
    const response = await fetch(`https://api.football-data.org/v4/competitions/${league}/standings`, {
      headers: { "X-Auth-Token": FOOTBALL_TOKEN },
      signal: AbortSignal.timeout(10000)
    });

    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({}));
      console.error(`[STANDINGS API ERROR] Liga: ${league} | HTTP ${response.status}:`, errorBody.message || errorBody);
      
      let msg = "Erro ao obter classificação da API externa.";
      if (response.status === 403) msg = "A tua conta/plano da API não tem acesso à tabela desta liga.";
      if (response.status === 429) msg = "Limite de pedidos da API atingido (10 por min). Aguarda alguns segundos.";

      return res.status(response.status).json({ error: msg });
    }

    const data = await response.json();
    const tableData = data.standings?.find(s => s.type === "TOTAL")?.table || [];

    const standings = tableData.map(item => ({
      position: item.position,
      teamName: item.team.name,
      teamCrest: item.team.crest || "",
      playedGames: item.playedGames,
      won: item.won,
      draw: item.draw,
      lost: item.lost,
      goalsFor: item.goalsFor,
      goalsAgainst: item.goalsAgainst,
      goalDifference: item.goalDifference,
      points: item.points
    }));

    res.json({ standings });
  } catch (err) {
    console.error("Erro na rota /api/standings:", err);
    res.status(502).json({ error: "Erro ao comunicar com o servidor da API de futebol." });
  }
});

async function fetchStandings(competitionCode) {
  if (!FOOTBALL_TOKEN || !competitionCode) return null;
  
  const cached = standingsCache.get(competitionCode);
  if (cached && Date.now() - cached.timestamp < 3600000) {
    return cached.data;
  }

  try {
    const response = await fetch(`https://api.football-data.org/v4/competitions/${competitionCode}/standings`, {
      headers: { "X-Auth-Token": FOOTBALL_TOKEN },
      signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) return null;
    const data = await response.json();
    
    const table = data.standings?.find(s => s.type === "TOTAL")?.table || [];
    const simplifiedTable = table.map(row => ({
      pos: row.position,
      team: row.team.name,
      points: row.points,
      played: row.playedGames,
      form: row.form || "N/A",
      gd: row.goalDifference
    }));

    standingsCache.set(competitionCode, { timestamp: Date.now(), data: simplifiedTable });
    return simplifiedTable;
  } catch {
    return null;
  }
}

app.get("/api/matches", async (req, res) => {
  if (!FOOTBALL_TOKEN) {
    return res.status(503).json({
      error: "Falta configurar FOOTBALL_DATA_TOKEN no ficheiro .env.",
      setup: "Cria uma conta em football-data.org, obtém uma chave e reinicia o servidor."
    });
  }
  const from = validDate(req.query.from) ? req.query.from : new Date().toISOString().slice(0, 10);
  const requestedTo = validDate(req.query.to) ? req.query.to : from;
  const to = addDays(requestedTo, 1);
  const codes = String(req.query.competitions || COMPETITIONS.join(","))
    .split(",").filter(c => COMPETITIONS.includes(c));
  if (!codes.length) return res.status(400).json({ error: "Seleciona pelo menos uma competição suportada." });

  try {
    const url = new URL("https://api.football-data.org/v4/matches");
    url.searchParams.set("dateFrom", from);
    url.searchParams.set("dateTo", to);
    url.searchParams.set("competitions", codes.join(","));
    const response = await fetch(url, {
      headers: { "X-Auth-Token": FOOTBALL_TOKEN },
      signal: AbortSignal.timeout(15000)
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      return res.status(response.status).json({
        error: body.message || `A API de futebol respondeu com HTTP ${response.status}.`,
        hint: response.status === 403
          ? "Confirma se o teu plano permite estas competições."
          : response.status === 429
          ? "Limite de pedidos atingido. Aguarda e tenta novamente."
          : "Confirma a chave e a documentação do fornecedor."
      });
    }
    const matches = (body.matches || []).map(m => ({
      id: m.id,
      competition: m.competition?.name || "Competição",
      competitionCode: m.competition?.code || "",
      utcDate: m.utcDate,
      status: m.status,
      minute: m.minute,
      home: m.homeTeam?.name || "Equipa da casa",
      away: m.awayTeam?.name || "Equipa visitante",
      homeCrest: m.homeTeam?.crest || "",
      awayCrest: m.awayTeam?.crest || "",
      homeScore: m.score?.fullTime?.home ?? null,
      awayScore: m.score?.fullTime?.away ?? null,
      winner: m.score?.winner || null
    }));
    res.set("Cache-Control", "public, max-age=60");
    res.json({ from, to, count: matches.length, matches, provider: "football-data.org" });
  } catch (err) {
    console.error("ERRO COMPLETO DO FOOTBALL API:", err);
    res.status(502).json({ error: "Não foi possível contactar a API de futebol.", hint: err.message });
  }
});

app.post("/api/analyse", async (req, res) => {
  console.log("-> Recebido pedido em /api/analyse (Otimizado para Fim de Semana)");

  if (!GEMINI_KEY) {
    return res.status(503).json({
      error: "A IA ainda não está configurada.",
      hint: "Adiciona GEMINI_API_KEY ao ficheiro .env e reinicia o servidor."
    });
  }

  const matches = Array.isArray(req.body.matches) ? req.body.matches.slice(0, 15) : [];
  if (!matches.length) return res.status(400).json({ error: "Não existem jogos para analisar nesta data." });

  const uniqueCodes = [...new Set(matches.map(m => m.competitionCode).filter(Boolean))];
  const standingsMap = {};
  
  for (const code of uniqueCodes) {
    const table = await fetchStandings(code);
    if (table) standingsMap[code] = table;
  }

  const safeMatches = matches.map(m => ({
    competition: String(m.competition || "").slice(0, 100),
    competitionCode: String(m.competitionCode || ""),
    home: String(m.home || "").slice(0, 100),
    away: String(m.away || "").slice(0, 100),
    kickoff: String(m.utcDate || ""),
    status: String(m.status || "")
  }));

  const prompt = `És um analista de apostas desportivas profissional e especialista em gestão de risco para grandes jornadas de futebol. Responde em português de Portugal.

Analisa os jogos fornecidos comparando os dados das tabelas classificativas reais (posição, pontos, jogos jogados, golos marcados, golos sofridos e diferença de golos).

Tens acesso a TODOS os mercados principais das casas de apostas. Escolhe O MELHOR mercado para cada jogo entre as seguintes opções:
- **Resultado Principal / Margem:** "Vitória Casa (1)", "Vitória Visitante (2)", "Empate (X)"
- **Proteção:** "Dupla Hipótese (1X, X2 ou 12)", "Empate Anula Aposta (DNB Casa / DNB Visitante)"
- **Golos:** "Mais de 1.5 Golos", "Mais de 2.5 Golos", "Menos de 2.5 Golos", "Ambas as Equipas Marcam (Sim / Não)", "Mais de 0.5 Golos na 1ª Parte"
- **Golos por Equipa:** "Casa - Mais de 1.5 Golos", "Visitante - Mais de 0.5 Golos"
- **Estatísticas:** "Mais de 8.5 Cantos", "Mais de 9.5 Cantos", "Mais de 4.5 Cartões"
- **Handicaps:** "Handicap Asiático (-0.5 / +0.5 / -1.0 / +1.0)"

ANÁLISE DE RISCO E GESTÃO DE BANCA PARA A MÚLTIPLA:
1. Constrói uma múltipla com as 2 a 3 seleções de maior valor e lógica estatística.
2. Avalia livremente o nível de risco da múltipla (ex: "Muito Baixo", "Baixo", "Moderado", "Elevado", "Muito Elevado").
3. Define APENAS a percentagem exata da banca ("recommendedStakePercent") que consideras prudente para este bilhete (ex: 0.5, 1.2, 2.0).
4. IMPORTANTE: Não conheces o valor total da banca do utilizador. NUNCA menciones valores em Euros (€) na "note". Fala estritamente em percentagem e gestão de risco com justificações concisas de 1 frase.

Produz um JSON válido com esta estrutura exata:
{
 "resumo":"Visão geral concisa da jornada em 2 frases.",
 "tips":[{"match":"Casa vs Visitante","selection":"nome exato do mercado escolhido ou Sem seleção recomendada","confidence":"Baixa|Moderada|Alta","reason":"justificação concisa baseada nos números de golos, pontos e posição das duas equipas"}],
 "multipla":{
   "selections":[{"match":"Casa vs Visitante","selection":"mercado recomendado"}],
   "riskLevel":"nível de risco avaliado pela IA",
   "recommendedStakePercent": 1.5,
   "note":"explicação focada apenas no risco e na percentagem sugerida, sem mencionar valores em Euros"
 }
}

Tabelas Classificativas:
${JSON.stringify(standingsMap)}

Jogos a Analisar:
${JSON.stringify(safeMatches)}`;

  try {
    console.log("-> A enviar pedido para a API do Gemini...");
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${GEMINI_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: "application/json"
        }
      }),
      signal: AbortSignal.timeout(180000)
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      return res.status(response.status).json({
        error: data.error?.message || `O serviço de IA respondeu com HTTP ${response.status}.`
      });
    }

    const output = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!output) return res.status(502).json({ error: "A IA não devolveu uma análise legível." });

    let analysis;
    try { 
      analysis = JSON.parse(output); 
    } catch { 
      return res.status(502).json({ error: "A resposta da IA não veio em JSON válido." }); 
    }

    // Regista a análise no histórico (Green Tracker)
    const history = await getHistoryData();
    const dateStr = safeMatches[0]?.kickoff ? safeMatches[0].kickoff.slice(0, 10) : new Date().toISOString().slice(0, 10);
    
    const newEntry = {
      id: "tip_" + Date.now(),
      date: dateStr,
      createdAt: new Date().toISOString(),
      resumo: analysis.resumo,
      tips: analysis.tips || [],
      multipla: analysis.multipla || {},
      status: "PENDING"
    };

    const updatedHistory = [newEntry, ...history].slice(0, 50);
    await saveHistoryData(updatedHistory);

    res.json({ analysis, model: "gemini-3.8-flash", generatedAt: new Date().toISOString() });
  } catch (err) {
    console.error("-> ERRO CRÍTICO NO GEMINI:", err);
    res.status(502).json({ error: "Ocorreu um tempo limite na IA. Tenta filtrar por uma liga específica para acelerar." });
  }
});

function validDate(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
}

function addDays(dateString, days) {
  const date = new Date(`${dateString}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

app.listen(PORT, () => console.log(`Tipster AI disponível em http://localhost:${PORT}`));