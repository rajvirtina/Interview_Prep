import { useState, useRef, useEffect } from "react";

/* ===============================================================
   BACKEND API CONFIG
   VITE_API_URL can point to Render backend in production.
   In local dev, leave it empty and Vite proxy forwards /api.
=============================================================== */
const API_BASE = (import.meta.env.VITE_API_URL || "").replace(/\/$/, "");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callAI(messages, system, maxTokens = 4000) {
  const runRequest = async () => {
    const resp = await fetch(`${API_BASE}/api/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ system, messages, maxTokens }),
    });

    const raw = await resp.text();
    let data = null;
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch (_) {
      const looksLikeHtml = raw.trim().toLowerCase().startsWith("<!doctype") || raw.trim().startsWith("<");
      throw new Error(
        looksLikeHtml
          ? "Backend returned HTML instead of JSON. Ensure frontend is hitting the correct API server and Vite proxy is active."
          : `Backend returned non-JSON response (status ${resp.status}).`
      );
    }
    return { resp, data };
  };

  try {
    let { resp, data } = await runRequest();

    if (!resp.ok && data?.code === "quota_exceeded" && Number(data?.retryAfterMs) > 0) {
      const waitMs = Math.min(Number(data.retryAfterMs) + 1000, 65000);
      await sleep(waitMs);
      ({ resp, data } = await runRequest());
    }

    if (!resp.ok) throw new Error(data?.error || "API error " + resp.status);
    if (!data?.text) throw new Error("No text in backend response");
    return data.text;
  } catch (err) {
    if (err?.message?.includes("Failed to fetch")) {
      throw new Error(
        "Cannot reach backend API. Start backend server and set VITE_API_URL for deployed environments."
      );
    }
    throw err;
  }
}

function parseJSON(raw) {
  if (!raw) throw new Error("Empty");
  try {
    return JSON.parse(raw.trim());
  } catch (_) {}
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) {
    try {
      return JSON.parse(fence[1].trim());
    } catch (_) {}
  }
  const a = raw.indexOf("[");
  const b = raw.lastIndexOf("]");
  if (a !== -1 && b > a) {
    try {
      return JSON.parse(raw.slice(a, b + 1));
    } catch (_) {}
  }
  return null;
}

function extractBalancedJsonBlock(raw, openChar, closeChar) {
  const text = String(raw || "");
  const start = text.indexOf(openChar);
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === openChar) depth += 1;
    if (ch === closeChar) depth -= 1;
    if (depth === 0) return text.slice(start, i + 1);
  }

  return null;
}

function parseLenientJson(raw) {
  const txt = String(raw || "").trim();
  if (!txt) return null;

  const direct = parseJSON(txt);
  if (direct) return direct;

  const arrBlock = extractBalancedJsonBlock(txt, "[", "]");
  if (arrBlock) {
    try {
      return JSON.parse(arrBlock);
    } catch (_) {}
  }

  const objBlock = extractBalancedJsonBlock(txt, "{", "}");
  if (objBlock) {
    try {
      return JSON.parse(objBlock);
    } catch (_) {}
  }

  const normalized = txt
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"');
  if (normalized !== txt) {
    const parsed = parseJSON(normalized);
    if (parsed) return parsed;
  }

  return null;
}

function extractQuestionArrayFromPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return null;

  const preferredKeys = ["questions", "items", "data", "result", "output"];
  for (const key of preferredKeys) {
    if (Array.isArray(payload[key])) return payload[key];
  }

  for (const value of Object.values(payload)) {
    if (Array.isArray(value) && value.length > 0) {
      const first = value[0];
      if (typeof first === "string") {
        return value.map((q, idx) => ({ id: idx + 1, question: q }));
      }
      if (first && typeof first === "object") {
        const hasQuestionLikeField =
          typeof first.question === "string" ||
          typeof first.q === "string" ||
          typeof first.prompt === "string";
        if (hasQuestionLikeField) return value;
      }
    }
  }

  return null;
}

function parseQuestionsFromRaw(raw) {
  const parsed = parseLenientJson(raw);
  const arr = extractQuestionArrayFromPayload(parsed);
  if (arr && arr.length > 0) return arr;

  if (parsed && typeof parsed === "object") {
    const stringFields = ["questions", "data", "result", "output", "content"];
    for (const key of stringFields) {
      const val = parsed[key];
      if (typeof val === "string" && val.trim()) {
        const nestedParsed = parseLenientJson(val);
        const nestedArr = extractQuestionArrayFromPayload(nestedParsed);
        if (nestedArr && nestedArr.length > 0) return nestedArr;
      }
    }
  }

  const lines = String(raw || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^([0-9]{1,3}[\.)]|[-*])\s+/.test(l) && l.length > 18)
    .map((l) => l.replace(/^([0-9]{1,3}[\.)]|[-*])\s+/, "").trim())
    .slice(0, 300);

  if (lines.length > 0) {
    return lines.map((question, idx) => ({ id: idx + 1, question }));
  }

  const qSentences = String(raw || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.endsWith("?") && l.length > 24)
    .slice(0, 300);
  if (qSentences.length > 0) {
    return qSentences.map((question, idx) => ({ id: idx + 1, question }));
  }

  return null;
}

/* ===============================================================
   CONSTANTS
=============================================================== */
const ROUNDS = [
  { id: "l1", label: "L1 Technical", icon: "L1" },
  { id: "l2", label: "L2 Technical", icon: "L2" },
  { id: "coding", label: "Coding / DSA", icon: "CD" },
  { id: "system_design", label: "System Design", icon: "SD" },
  { id: "managerial", label: "Managerial", icon: "MG" },
  { id: "hr", label: "HR Round", icon: "HR" },
];

const QCOUNTS = [10, 20, 50, 100, 150];

const LOAD_MSGS = [
  "Scanning Glassdoor interview reports for this company...",
  "Mining LinkedIn posts and Blind threads...",
  "Analysing your JD and resume deeply...",
  "Crafting round-specific realistic questions...",
  "Generating coding problems and system design prompts...",
  "Finalising complete question bank...",
];

const HR_ADMIN_KEYWORDS =
  /\b(hr|human resources|administration|admin|recruitment|talent acquisition|employee lifecycle|payroll|statutory|compliance|pf|esi|gratuity|shops?\s*&?\s*establishment|labor law|labour law|grievance|engagement|retention|hrms|darwinbox|keka|zoho)\b/i;

const QA_TESTING_KEYWORDS =
  /\b(qa|quality assurance|manual testing|functional testing|regression testing|smoke testing|sanity testing|test cases?|test scenario|stlc|sdlc|defect|bug tracking|automation testing)\b/i;

const QA_TOOLING_KEYWORDS =
  /\b(cucumber|bdd|selenium|playwright|testcomplete|appium|postman|jmeter|pytest|robot framework|testng)\b/i;

const QA_HARD_EXCLUDE_KEYWORDS =
  /\b(leetcode|algorithm|data structure|binary tree|linked list|dynamic programming|system design|microservice architecture|distributed system|kafka|rate limiter|url shortener|design instagram|design uber|hashmap|complexity analysis)\b/i;

function isQaRelevantQuestionText(text) {
  const q = String(text || "");
  if (!q.trim()) return false;
  if (QA_HARD_EXCLUDE_KEYWORDS.test(q)) return false;
  return QA_TESTING_KEYWORDS.test(q);
}

const TECH_QUESTION_KEYWORDS =
  /\b(leetcode|algorithm|data structure|bug fix|debug|api|microservice|system design|kafka|redis|sql query|join|java|python|javascript|react|node\.js|backend|frontend|deploy|ci\/cd|latency|o\(n\)|hashmap|binary tree|linked list)\b/i;

function isHrAdminProfile(form) {
  const text = `${form?.role || ""} ${form?.jd || ""}`;
  return HR_ADMIN_KEYWORDS.test(text);
}

function isQaTestingProfile(form) {
  const text = `${form?.role || ""} ${form?.jd || ""}`;
  const hasQaCoreSignal = QA_TESTING_KEYWORDS.test(text);
  const hasQaToolingSignal = QA_TOOLING_KEYWORDS.test(text);
  const roleMentionsTesting = /\b(test|testing|qa)\b/i.test(String(form?.role || ""));
  return (hasQaCoreSignal || (hasQaToolingSignal && roleMentionsTesting)) && !isHrAdminProfile(form);
}

function normalizeQuestionsForProfile(items, form) {
  const total = Number(form.numQ || 20);
  const hrProfile = isHrAdminProfile(form);
  const qaProfile = isQaTestingProfile(form);
  const selectedRounds = Array.isArray(form.rounds) ? form.rounds : [];
  const preferredRound = hrProfile
    ? selectedRounds.find((r) => r === "hr" || r === "managerial") || "hr"
    : selectedRounds[0] || "l1";

  let normalized = (items || [])
    .filter((q) => q && typeof q === "object")
    .map((q, i) => ({
      id: Number(q.id) || i + 1,
      question: String(
        q.question || q.q || q.prompt || q.text || q.title || ""
      ).trim(),
      round: q.round || q.round_name || q.interview_round || preferredRound,
      difficulty: String(q.difficulty || q.level || "medium").toLowerCase(),
      type: String(q.type || q.category || "situational").toLowerCase(),
      source_hint: q.source_hint || q.source || q.reference || "Generated",
      tags: Array.isArray(q.tags) ? q.tags : [],
    }))
    .filter((q) => q.question.length > 0);

  if (hrProfile) {
    normalized = normalized
      .filter((q) => !TECH_QUESTION_KEYWORDS.test(q.question))
      .map((q) => ({
        ...q,
        round: q.round === "hr" || q.round === "managerial" ? q.round : preferredRound,
        type: ["behavioral", "situational", "cultural"].includes(q.type)
          ? q.type
          : "situational",
      }));
  }

  if (qaProfile) {
    const selectedTechnicalRounds = new Set(
      selectedRounds.filter((r) => r === "l1" || r === "l2")
    );
    const preferredQaRound = selectedTechnicalRounds.has("l1")
      ? "l1"
      : selectedTechnicalRounds.has("l2")
      ? "l2"
      : preferredRound;

    normalized = normalized
      .filter(
        (q) =>
          !QA_HARD_EXCLUDE_KEYWORDS.test(q.question)
      )
      .filter((q) => {
        const technicalRound = q.round === "l1" || q.round === "l2";
        const technicalType = q.type === "technical";
        if (technicalRound || technicalType) {
          return isQaRelevantQuestionText(q.question);
        }
        return true;
      })
      .map((q) => ({
        ...q,
        round: ["l1", "l2", "managerial", "hr"].includes(q.round)
          ? q.round
          : preferredQaRound,
        type: ["technical", "situational", "behavioral"].includes(q.type)
          ? q.type
          : "technical",
      }));
  }

  const seen = new Set();
  normalized = normalized.filter((q) => {
    const key = q.question.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return normalized.slice(0, total).map((q, i) => ({ ...q, id: i + 1 }));
}

/* ===============================================================
   PROMPT BUILDERS
=============================================================== */
function buildQuestionsPrompt(form, resumeText) {
  const rl = form.rounds.map((r) => ROUNDS.find((t) => t.id === r)?.label).join(", ");
  const hrProfile = isHrAdminProfile(form);
  const qaProfile = isQaTestingProfile(form);
  const profileRules = hrProfile
    ? `
ADDITIONAL ROLE GUARDRAILS (MANDATORY):
- This is an HR/Admin role. DO NOT ask software engineering, coding, bug-fix, system design, or API questions.
- Focus only on recruitment, employee lifecycle, payroll, statutory compliance, labor-law handling, grievance resolution, admin operations, vendors, leadership, and HR process automation.
- Keep question language realistic for HR/Admin manager interviews.
`
    : qaProfile
    ? `
ADDITIONAL ROLE GUARDRAILS (MANDATORY):
- This is a QA/Manual Testing role. Prioritize Manual Testing, functional/regression/smoke/sanity testing, test design, defect lifecycle, requirement analysis, and release validation.
- Include Cucumber (BDD) and Python automation exposure in realistic QA interview style.
- If role asks for Selenium/Playwright/TestComplete, include practical scenario-based questions on those tools.
- DO NOT include DSA LeetCode-style problems or system design architecture questions unless explicitly requested in JD.
- For L1/L2 rounds, generate QA-technical questions, not software developer coding interview questions.
`
    : "";
  return `You are a senior hiring manager who has conducted 500+ technical interviews at top tech companies. You have studied real interview reports for ${form.company} from Glassdoor, LinkedIn, Blind, and AmbitionBox.

Generate EXACTLY ${form.numQ} interview questions for:
- Company: ${form.company}
- Role: ${form.role}
- Experience: ${
    form.level === "junior"
      ? "Junior (0-3 yrs)"
      : form.level === "mid"
      ? "Mid-level (3-6 yrs)"
      : "Senior (6+ yrs)"
  }
- Rounds: ${rl}

JOB DESCRIPTION:
${form.jd.slice(0, 800)}
${resumeText ? "\nCANDIDATE RESUME:\n" + resumeText.slice(0, 500) : ""}

CRITICAL REQUIREMENTS:
1. Questions must sound like a REAL human interviewer saying them - specific, contextual, sometimes tricky
2. For "coding" round: include actual LeetCode-style problems with problem name and number where applicable
3. For "system_design": name real systems (WhatsApp, Uber, Instagram, Zomato, etc.)
4. For "managerial"/"hr": use real scenario language ("Your sprint is at risk 2 days before the deadline...")
5. Reference the EXACT technologies mentioned in the JD
6. Use source_hint like: "Glassdoor - ${form.company} SDE Interview 2024" or "Blind - ${form.company} thread"
7. Distribute questions across ALL selected rounds: ${form.rounds.join(", ")}
8. Difficulty mix: 25% easy, 50% medium, 25% hard
${profileRules}

Return ONLY a raw JSON array, no markdown fences, no text before or after:
[
  {
    "id": 1,
    "question": "exact realistic question as interviewer would ask it",
    "round": "l1",
    "difficulty": "medium",
    "type": "technical",
    "source_hint": "Glassdoor - ${form.company} SDE1 Interview 2024",
    "tags": ["hashmap", "arrays"]
  }
]

round must be one of: ${form.rounds.join(" | ")}
type must be one of: technical | coding | behavioral | system_design | situational | cultural
Generate exactly ${form.numQ} items. Output raw JSON only - no other text.`;
}

function isDemandSpikeErrorMessage(message) {
  const text = String(message || "").toLowerCase();
  return (
    text.includes("high demand") ||
    text.includes("try again later") ||
    text.includes("resource exhausted") ||
    text.includes("rate limit") ||
    text.includes("503")
  );
}

function isQuotaErrorMessage(message) {
  const text = String(message || "").toLowerCase();
  return (
    text.includes("quota exceeded") ||
    text.includes("billing details") ||
    text.includes("free_tier_requests") ||
    text.includes("rate-limits")
  );
}

function buildChunkPlan(total, chunkSize = 10) {
  const n = Math.max(1, Number(total || 20));
  const size = Math.max(5, Number(chunkSize || 10));
  const chunks = [];
  let remaining = n;
  while (remaining > 0) {
    const take = Math.min(size, remaining);
    chunks.push(take);
    remaining -= take;
  }
  return chunks;
}

function buildAnswerPrompt(q, company, role, jd = "") {
  const isCoding = q.type === "coding";
  const isSD = q.type === "system_design" || q.round === "system_design";
  const isBeh =
    ["behavioral", "situational", "cultural"].includes(q.type) ||
    q.round === "hr" ||
    q.round === "managerial";
  const qaProfile = QA_TESTING_KEYWORDS.test(`${role || ""} ${jd || ""}`);
  const jdContext = (jd || "").trim().slice(0, 900);
  const jdBlock = jdContext
    ? `\nJOB DESCRIPTION CONTEXT:\n${jdContext}\n\nTailor your answer to the JD technologies, responsibilities, and seniority expectations.`
    : "";
  const qaAnswerRules = qaProfile
    ? `\nQA ROLE RULES:\n- Keep examples in QA/testing context (manual testing, test case design, defect lifecycle, BDD/Cucumber, Python automation).\n- Avoid software-developer coding interview framing unless the question explicitly asks for automation code.\n`
    : "";

  if (isCoding) {
    return `You are a FAANG senior engineer coaching a ${role} candidate at ${company}.

QUESTION: "${q.question}"
DIFFICULTY: ${q.difficulty} | TAGS: ${(q.tags || []).join(", ")}
${jdBlock}
${qaAnswerRules}

Give a complete answer with these EXACT section headers (use them verbatim):

**1. PROBLEM UNDERSTANDING**
Restate clearly with input/output format and constraints.

**2. BRUTE FORCE APPROACH**
Naive solution, its time/space complexity, and why it's insufficient.

**3. OPTIMAL APPROACH**
Step-by-step algorithm explanation. Why does this work?

**4. CODE SOLUTION**
Complete, runnable JavaScript (or Python if more natural). Well-commented. Handle edge cases inline.

**5. COMPLEXITY ANALYSIS**
Time: O(?) - explain each factor
Space: O(?) - explain each factor

**6. EDGE CASES**
List 5 important edge cases with expected outputs.

**7. FOLLOW-UP QUESTIONS**
2-3 actual follow-up questions interviewers at ${company} ask after this problem.

Write clean, real code. Be specific and precise.`;
  }

  if (isSD) {
    return `You are a Staff Engineer at ${company} answering a system design question for a ${role} candidate.

QUESTION: "${q.question}"
${jdBlock}
${qaAnswerRules}

Answer with these EXACT section headers:

**1. CLARIFYING QUESTIONS**
5 specific questions you must ask the interviewer before drawing anything.

**2. CAPACITY ESTIMATION**
DAU -> RPS -> storage per day -> total 5-year storage -> bandwidth. Show actual math.

**3. HIGH-LEVEL ARCHITECTURE**
6-8 core components with a one-line description of each component's role.

**4. DEEP DIVE: HARDEST PART**
The single most technically challenging component - go deep. This is what separates senior from mid-level.

**5. DATABASE DESIGN**
Schema, SQL vs NoSQL choice with reasoning, partition key, indexing strategy.

**6. SCALING STRATEGY**
What breaks first at 10x load? Caching layer (what, where, eviction policy), sharding approach, CDN.

**7. COMPANY-SPECIFIC INSIGHT**
How ${company} or a comparable company has actually solved this. Reference real tech choices if known.

Use specific numbers. Name real technologies. Avoid vague statements like "use a database".`;
  }

  if (isBeh) {
    return `You are a senior hiring manager at ${company} coaching a ${role} candidate.

QUESTION: "${q.question}"
ROUND: ${q.round} | DIFFICULTY: ${q.difficulty}
${jdBlock}
${qaAnswerRules}

Answer with these EXACT section headers:

**1. WHAT IS BEING TESTED**
The specific competency or leadership principle this question probes. (2-3 sentences)

**2. RECOMMENDED FRAMEWORK**
Which framework (STAR, SBI, SOAR) fits and why. Lay out the structure clearly.

**3. STRONG MODEL ANSWER**
Write a complete answer as if the candidate is speaking - first person, 200-250 words. Be specific: include real numbers, real outcomes, real emotions. Not a template filler.

**4. KEY PHRASES TO USE**
6-8 specific phrases that resonate strongly at ${company} based on their known values and culture.

**5. COMMON MISTAKES**
3 specific things candidates do wrong on this question that are immediate red flags.

**6. FOLLOW-UP TO EXPECT**
The exact follow-up the interviewer will ask next, and a one-paragraph answer to it.

Make the model answer sound like a real human, not a textbook.`;
  }

  return `You are a senior interviewer at ${company} for the ${role} role.

QUESTION: "${q.question}"
TYPE: ${q.type} | DIFFICULTY: ${q.difficulty}
${jdBlock}
${qaAnswerRules}

Answer with these EXACT section headers:

**1. WHAT THIS TESTS**
The real intent - what skill or trait does this question reveal?

**2. IDEAL ANSWER STRUCTURE**
The framework and key points to hit.

**3. STRONG MODEL ANSWER**
Specific, detailed answer (150-200 words). Real tools, real numbers, real trade-offs.

**4. MUST-MENTION POINTS**
5 bullet points the interviewer specifically wants to hear.

**5. COMMON MISTAKES**
3 things candidates say that immediately signal a red flag.

**6. FOLLOW-UP**
The next question the interviewer will ask, and how to handle it.

Be specific to ${company}. Reference their known tech stack or culture where relevant.`;
}

/* ===============================================================
   STYLES
=============================================================== */
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,300;9..40,400;9..40,500;9..40,600;9..40,700&family=DM+Mono:wght@400;500&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#07090f;--bg2:#0c1020;--bg3:#111828;
  --sur:#14192e;--sur2:#19203a;--sur3:#1f2844;
  --bdr:rgba(255,255,255,0.07);--bdr2:rgba(255,255,255,0.13);
  --acc:#4f8ef7;--acc2:#a67ff5;--grn:#2dd4a0;
  --red:#f87171;--amb:#fbbf24;
  --txt:#d8e4ff;--txt2:#7585aa;--txt3:#465070;
  --sh:0 2px 16px rgba(0,0,0,.45);
}
html,body{min-height:100vh}
body{background:var(--bg);color:var(--txt);font-family:'DM Sans',sans-serif;-webkit-font-smoothing:antialiased}
.app{min-height:100vh;background:
  radial-gradient(ellipse 80% 50% at 20% -5%,rgba(79,142,247,0.11),transparent 55%),
  radial-gradient(ellipse 60% 40% at 80% 110%,rgba(166,127,245,0.07),transparent 50%),
  var(--bg)}

/* HEADER */
.hdr{padding:.9rem 2rem;background:rgba(7,9,15,.88);backdrop-filter:blur(16px);
  border-bottom:1px solid var(--bdr);display:flex;align-items:center;gap:.85rem;
  position:sticky;top:0;z-index:200;box-shadow:0 1px 0 var(--bdr)}
.logo{width:34px;height:34px;border-radius:9px;flex-shrink:0;
  background:linear-gradient(135deg,#1d4ed8,#7c3aed);
  display:flex;align-items:center;justify-content:center;
  font-family:'DM Mono',monospace;font-size:12px;font-weight:500;color:#fff;letter-spacing:-.3px}
.hdr-l{font-size:.92rem;font-weight:700;color:var(--txt)}
.hdr-s{font-size:.62rem;color:var(--txt3);margin-top:1px}
.hdr-r{margin-left:auto;display:flex;align-items:center;gap:.55rem}
.pill{padding:.2rem .6rem;border-radius:20px;font-size:.57rem;font-weight:700;
  letter-spacing:.08em;text-transform:uppercase}
.pill-g{background:rgba(45,212,160,.1);border:1px solid rgba(45,212,160,.22);color:var(--grn)}
.pill-b{background:rgba(79,142,247,.1);border:1px solid rgba(79,142,247,.2);color:var(--acc)}

/* MAIN */
.main{max-width:960px;margin:0 auto;padding:2rem 1.5rem}

/* STEP BAR */
.stpbar{display:flex;align-items:center;gap:.4rem;margin-bottom:2.5rem}
.stp{display:flex;align-items:center;gap:.35rem;font-size:.7rem;font-weight:600;
  color:var(--txt3);white-space:nowrap}
.stp.on{color:var(--acc)}.stp.done{color:var(--grn)}
.sn{width:21px;height:21px;border-radius:50%;border:1.5px solid currentColor;
  display:flex;align-items:center;justify-content:center;font-size:.58rem;flex-shrink:0}
.stp.on .sn{background:var(--acc);border-color:var(--acc);color:#fff}
.stp.done .sn{background:var(--grn);border-color:var(--grn);color:#fff}
.sl{flex:1;height:1px;background:var(--bdr2);max-width:52px}

/* CARDS */
.card{background:var(--sur);border:1px solid var(--bdr);border-radius:14px;
  padding:1.5rem;margin-bottom:1.1rem;box-shadow:var(--sh)}
.ct{font-size:.6rem;font-weight:700;letter-spacing:.12em;color:var(--acc);
  text-transform:uppercase;margin-bottom:1.1rem}

/* AI MODE BANNER */
.ai-banner{background:linear-gradient(135deg,#0d0a24 0%,#13104a 50%,#0d0a24 100%);
  border:1px solid rgba(79,142,247,.25);border-radius:14px;
  padding:1.25rem 1.5rem;margin-bottom:1.1rem;
  display:flex;align-items:center;gap:1rem;flex-wrap:wrap}
.ai-icon{width:38px;height:38px;border-radius:10px;flex-shrink:0;
  background:linear-gradient(135deg,rgba(79,142,247,.3),rgba(166,127,245,.3));
  border:1px solid rgba(79,142,247,.3);
  display:flex;align-items:center;justify-content:center;font-size:1.1rem}
.ai-text .ai-title{font-size:.88rem;font-weight:700;color:#fff}
.ai-text .ai-sub{font-size:.68rem;color:rgba(255,255,255,.45);margin-top:.18rem;line-height:1.5}
.ai-status{margin-left:auto;display:flex;align-items:center;gap:.4rem;
  padding:.28rem .75rem;border-radius:20px;background:rgba(45,212,160,.1);
  border:1px solid rgba(45,212,160,.2);font-size:.6rem;font-weight:700;color:var(--grn)}
.ai-dot{width:6px;height:6px;border-radius:50%;background:var(--grn);animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}

/* FORM */
.g2{display:grid;grid-template-columns:1fr 1fr;gap:.9rem}
@media(max-width:540px){.g2{grid-template-columns:1fr}}
.fld{display:flex;flex-direction:column;gap:.35rem}
label{font-size:.7rem;font-weight:600;color:var(--txt2);letter-spacing:.01em}
input[type=text],select,textarea{
  background:var(--bg2);border:1px solid var(--bdr2);border-radius:8px;
  padding:.58rem .8rem;color:var(--txt);font-family:'DM Sans',sans-serif;
  font-size:.84rem;outline:none;transition:border-color .18s,box-shadow .18s;width:100%}
input[type=text]:focus,select:focus,textarea:focus{
  border-color:var(--acc);box-shadow:0 0 0 3px rgba(79,142,247,.12)}
select{cursor:pointer;appearance:none;
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath fill='%237585aa' d='M5 6L0 0h10z'/%3E%3C/svg%3E");
  background-repeat:no-repeat;background-position:right .75rem center;padding-right:2rem}
select option{background:var(--bg2)}
textarea{resize:vertical;min-height:110px;line-height:1.7}

/* ROUND GRID */
.rgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(148px,1fr));gap:.58rem}
.rbtn{display:flex;align-items:center;gap:.48rem;padding:.62rem .82rem;
  border:1px solid var(--bdr2);border-radius:9px;background:var(--bg2);
  font-family:'DM Sans',sans-serif;font-size:.77rem;font-weight:600;
  color:var(--txt2);cursor:pointer;transition:all .16s;text-align:left}
.rbtn:hover{border-color:rgba(79,142,247,.5);color:var(--txt)}
.rbtn.sel{border-color:var(--acc);background:rgba(79,142,247,.1);color:var(--acc)}
.rck{margin-left:auto;font-size:.7rem;opacity:0;transition:opacity .15s}
.rbtn.sel .rck{opacity:1}

/* Q COUNT */
.qrow{display:flex;gap:.45rem;flex-wrap:wrap}
.qp{padding:.38rem .88rem;border-radius:7px;border:1px solid var(--bdr2);
  background:var(--bg2);font-family:'DM Mono',monospace;font-size:.77rem;font-weight:500;
  color:var(--txt2);cursor:pointer;transition:all .16s}
.qp:hover{border-color:rgba(79,142,247,.5);color:var(--txt)}
.qp.sel{border-color:var(--acc);background:rgba(79,142,247,.1);color:var(--acc);font-weight:600}

/* UPLOAD */
.upz{border:1.5px dashed var(--bdr2);border-radius:10px;padding:1.25rem;
  display:flex;flex-direction:column;align-items:center;gap:.38rem;
  cursor:pointer;transition:all .18s;background:var(--bg2);text-align:center;position:relative}
.upz:hover{border-color:var(--acc);background:rgba(79,142,247,.06)}
.upz.has{border-color:var(--grn);background:rgba(45,212,160,.05)}
.upz input[type=file]{position:absolute;inset:0;opacity:0;cursor:pointer;width:100%;height:100%}

/* BUTTONS */
.btn-go{background:linear-gradient(135deg,#1d4ed8,#2563eb);color:#fff;border:none;
  border-radius:9px;padding:.7rem 1.8rem;font-family:'DM Sans',sans-serif;
  font-size:.86rem;font-weight:700;cursor:pointer;transition:all .2s;
  display:inline-flex;align-items:center;gap:.45rem;
  box-shadow:0 2px 16px rgba(79,142,247,.3)}
.btn-go:hover:not(:disabled){transform:translateY(-1px);box-shadow:0 4px 24px rgba(79,142,247,.4)}
.btn-go:disabled{opacity:.32;cursor:not-allowed;transform:none;box-shadow:none}
.btn-back{background:transparent;color:var(--txt2);border:1px solid var(--bdr2);
  border-radius:8px;padding:.58rem 1.15rem;font-family:'DM Sans',sans-serif;
  font-size:.8rem;font-weight:600;cursor:pointer;transition:all .16s}
.btn-back:hover{border-color:var(--bdr2);color:var(--txt)}

/* GENERATING */
.genscr{display:flex;flex-direction:column;align-items:center;justify-content:center;
  min-height:58vh;gap:1.4rem;text-align:center}
.orb{width:56px;height:56px;position:relative;flex-shrink:0}
.orb::before{content:'';position:absolute;inset:0;border-radius:50%;
  border:2.5px solid transparent;border-top-color:var(--acc);
  animation:spin 1s linear infinite}
.orb::after{content:'';position:absolute;inset:9px;border-radius:50%;
  border:2.5px solid transparent;border-top-color:var(--acc2);
  animation:spin .65s linear infinite reverse}
@keyframes spin{to{transform:rotate(360deg)}}
.glogs{display:flex;flex-direction:column;gap:.38rem;margin-top:.3rem;width:100%;max-width:320px}
.glog{font-size:.7rem;color:var(--txt3);display:flex;align-items:center;gap:.4rem;
  font-family:'DM Mono',monospace;transition:color .3s}
.glog.done{color:var(--grn)}.glog.on{color:var(--acc)}
.gi{width:13px;text-align:center;flex-shrink:0}

/* RESULTS */
.reshdr{display:flex;align-items:flex-start;justify-content:space-between;
  margin-bottom:1.4rem;gap:.9rem;flex-wrap:wrap}
.chips{display:flex;gap:.42rem;flex-wrap:wrap;margin-bottom:1.25rem}
.chip{padding:.26rem .68rem;background:var(--sur2);border:1px solid var(--bdr);
  border-radius:6px;font-size:.67rem;color:var(--txt2);display:flex;align-items:center;gap:.27rem}
.chip strong{color:var(--acc)}

/* TABS */
.tabwrap{overflow-x:auto;margin-bottom:1.2rem;scrollbar-width:none}
.tabwrap::-webkit-scrollbar{display:none}
.tabs{display:flex;gap:.15rem;background:var(--bg2);border-radius:9px;padding:3px;
  border:1px solid var(--bdr);width:max-content;min-width:100%}
.tab{padding:.38rem .8rem;border-radius:7px;font-size:.7rem;font-weight:600;
  cursor:pointer;transition:all .16s;color:var(--txt3);border:none;background:transparent;
  font-family:'DM Sans',sans-serif;white-space:nowrap}
.tab.on{background:var(--sur3);color:var(--txt);box-shadow:0 1px 4px rgba(0,0,0,.4)}

/* QUESTION CARD */
.qcard{background:var(--sur);border:1px solid var(--bdr);border-radius:12px;
  margin-bottom:.72rem;cursor:pointer;transition:border-color .17s}
.qcard:hover{border-color:rgba(79,142,247,.35)}
.qrow{padding:.88rem 1.05rem;display:flex;align-items:flex-start;gap:.78rem}
.qn{width:26px;height:26px;border-radius:6px;background:rgba(79,142,247,.1);
  border:1px solid rgba(79,142,247,.2);display:flex;align-items:center;justify-content:center;
  font-size:.59rem;font-weight:700;color:var(--acc);flex-shrink:0;font-family:'DM Mono',monospace}
.qtxt{font-size:.84rem;line-height:1.55;color:var(--txt);font-weight:600}
.qmeta{display:flex;gap:.28rem;margin-top:.33rem;flex-wrap:wrap;align-items:center}
.b{font-size:.56rem;font-weight:700;padding:.13rem .42rem;border-radius:4px;
  letter-spacing:.05em;text-transform:uppercase}
.bhard{background:rgba(248,113,113,.1);color:#f87171}
.bmed{background:rgba(251,191,36,.1);color:#fbbf24}
.beasy{background:rgba(45,212,160,.1);color:#2dd4a0}
.bcode{background:rgba(45,212,160,.08);color:#2dd4a0}
.btype{background:rgba(166,127,245,.1);color:#a67ff5}
.brnd{background:rgba(79,142,247,.08);color:#6ba3f9}
.bsrc{font-size:.55rem;color:var(--txt3);font-family:'DM Mono',monospace;
  background:var(--sur2);border:1px solid var(--bdr);padding:.1rem .38rem;border-radius:4px}
.qbtn{flex-shrink:0;padding:.36rem .75rem;border:1px solid var(--bdr2);border-radius:7px;
  font-size:.67rem;font-weight:700;background:transparent;color:var(--acc);
  cursor:pointer;transition:all .16s;font-family:'DM Sans',sans-serif;white-space:nowrap;align-self:center}
.qbtn:hover{background:rgba(79,142,247,.1);border-color:var(--acc)}

/* OVERLAY */
.ovlay{position:fixed;inset:0;background:rgba(0,0,0,.72);backdrop-filter:blur(6px);
  z-index:500;display:flex;align-items:flex-start;justify-content:center;
  padding:1.5rem 1rem;overflow-y:auto}
.ovbox{background:#0e1524;border:1px solid rgba(79,142,247,.2);border-radius:16px;
  width:100%;max-width:760px;box-shadow:0 24px 80px rgba(0,0,0,.65);
  margin:auto;animation:su .22s cubic-bezier(.34,1.56,.64,1)}
@keyframes su{from{opacity:0;transform:translateY(20px) scale(.97)}to{opacity:1;transform:none}}
.ovhdr{padding:1.15rem 1.4rem;border-bottom:1px solid var(--bdr);
  display:flex;align-items:flex-start;gap:.88rem}
.ovhl{flex:1;min-width:0}
.ovlbl{font-size:.57rem;font-weight:700;letter-spacing:.1em;color:var(--acc);
  text-transform:uppercase;margin-bottom:.33rem}
.ovq{font-size:.9rem;font-weight:700;color:var(--txt);line-height:1.5}
.ovcls{width:29px;height:29px;border-radius:7px;border:1px solid var(--bdr2);
  background:transparent;cursor:pointer;display:flex;align-items:center;justify-content:center;
  font-size:.88rem;color:var(--txt2);flex-shrink:0;transition:all .15s}
.ovcls:hover{background:var(--sur2);color:var(--txt)}
.ovbody{padding:1.4rem;max-height:68vh;overflow-y:auto;scrollbar-width:thin;
  scrollbar-color:var(--sur3) transparent}
.ovload{display:flex;flex-direction:column;align-items:center;gap:.9rem;
  padding:3rem;text-align:center}
.ovload p{font-size:.77rem;color:var(--txt3);line-height:1.65}
.ovftr{padding:.82rem 1.4rem;border-top:1px solid var(--bdr);
  display:flex;justify-content:flex-end}

/* ANSWER CONTENT */
.ans h3{font-size:.67rem;font-weight:700;color:var(--acc);text-transform:uppercase;
  letter-spacing:.09em;margin:1.15rem 0 .48rem;padding-bottom:.28rem;
  border-bottom:1px solid var(--bdr)}
.ans h3:first-child{margin-top:0}
.ans p{font-size:.82rem;line-height:1.78;color:var(--txt2);margin-bottom:.62rem}
.ans ul,.ans ol{padding-left:1.3rem;margin-bottom:.62rem}
.ans li{font-size:.82rem;line-height:1.72;color:var(--txt2);margin-bottom:.2rem}
.ans strong{color:var(--txt);font-weight:600}
.ans code{font-family:'DM Mono',monospace;font-size:.78em;
  background:rgba(79,142,247,.1);border:1px solid var(--bdr2);
  padding:.09em .3em;border-radius:4px;color:var(--acc)}
.ans pre{background:#060b14;border:1px solid var(--bdr2);border-radius:9px;
  padding:.95rem;margin:.62rem 0;overflow-x:auto}
.ans pre code{background:transparent;border:none;color:#cdd9f5;
  font-size:.77rem;padding:0;line-height:1.7}

/* MISC */
.errbx{background:rgba(248,113,113,.08);border:1px solid rgba(248,113,113,.2);
  border-radius:9px;padding:.82rem 1rem;font-size:.77rem;color:var(--red);
  margin-bottom:.9rem;line-height:1.6}
.infobx{background:rgba(79,142,247,.07);border:1px solid rgba(79,142,247,.18);
  border-radius:9px;padding:.72rem 1rem;font-size:.72rem;color:var(--acc);
  margin-bottom:.9rem;line-height:1.6}
.hint{font-size:.67rem;color:var(--txt3)}
.empty{text-align:center;padding:3rem;color:var(--txt3);font-size:.8rem}
.smpl{font-size:.63rem;background:none;border:none;color:var(--txt3);
  cursor:pointer;font-family:'DM Sans',sans-serif;margin-top:.42rem}
.smpl:hover{color:var(--acc)}
`;

/* ===============================================================
   FORMAT AI ANSWER TEXT -> HTML
=============================================================== */
function fmt(text) {
  if (!text) return "<p>No answer available.</p>";
  const esc = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  let h = esc
    .replace(/```(\w*)\n?([\s\S]*?)```/g, (_, _l, code) => `<pre><code>${code.trim()}</code></pre>`)
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/^\*\*(\d+\.\s+[A-Z][^*]+)\*\*\s*$/gm, "<h3>$1</h3>")
    .replace(/^#{1,3}\s+(.+)$/gm, "<h3>$1</h3>")
    .replace(/^(\d+)\.\s+([A-Z][A-Z &\/:+\-()]{3,})$/gm, "<h3>$1. $2</h3>")
    .replace(/^[-•]\s+(.+)$/gm, "<li>$1</li>")
    .replace(/(<li>[^\n]+<\/li>\n?)+/g, (m) => `<ul>${m}</ul>`)
    .replace(/<\/ul>\s*<ul>/g, "")
    .replace(/\n\n+/g, "</p><p>")
    .replace(/\n(?!<)/g, "<br/>");
  return `<p>${h}</p>`;
}

/* ===============================================================
   MAIN APP COMPONENT
=============================================================== */
export default function App() {
  const [step, setStep] = useState(1);
  const [form, setForm] = useState({
    company: "",
    role: "",
    jd: "",
    rounds: [],
    numQ: 20,
    level: "mid",
  });
  const [resumeFile, setResumeFile] = useState(null);
  const [resumeText, setResumeText] = useState("");
  const [loadStep, setLoadStep] = useState(0);
  const [questions, setQuestions] = useState([]);
  const [tab, setTab] = useState("all");
  const [openIdx, setOpenIdx] = useState(null);
  const [cache, setCache] = useState({});
  const [ansLoading, setAnsLoading] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [aiMode, setAiMode] = useState(false);
  const fileRef = useRef();
  const backdropRef = useRef();

  const upd = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const toggleRound = (id) =>
    setForm((f) => ({
      ...f,
      rounds: f.rounds.includes(id)
        ? f.rounds.filter((r) => r !== id)
        : [...f.rounds, id],
    }));

  const handleFile = (file) => {
    if (!file) return;
    setResumeFile(file);
    if (file.name.match(/\.txt$/i)) {
      const rd = new FileReader();
      rd.onload = (e) => setResumeText(e.target.result.slice(0, 700));
      rd.readAsText(file);
    } else {
      setResumeText(`[Uploaded: ${file.name}]`);
    }
  };

  const canGo =
    form.company.trim() &&
    form.role.trim() &&
    form.jd.trim() &&
    form.rounds.length > 0;

  const getHint = () => {
    if (!form.company.trim()) return "Enter company name";
    if (!form.role.trim()) return "Enter role";
    if (!form.jd.trim()) return "Paste job description";
    if (!form.rounds.length) return "Select at least one round";
    return "";
  };

  /* -- GENERATE -- */
  const generate = async () => {
    setError("");
    setInfo("");
    setLoadStep(0);
    setStep(2);
    const timers = LOAD_MSGS.map((_, i) =>
      setTimeout(() => setLoadStep(i + 1), i * 800)
    );

    try {
      const sys =
        "You are a senior interview coach with 500+ interviews at top tech companies. You generate hyper-realistic interview questions based on actual Glassdoor/LinkedIn/Blind reports. Return ONLY raw JSON arrays - no markdown, no text before or after the array.";
      const requestedCount = Math.max(1, Number(form.numQ || 20));
      const maxTokensForQuestions = Math.min(
        16000,
        Math.max(4000, requestedCount * 200)
      );
      const minAcceptable = Math.max(5, Math.ceil(requestedCount * 0.7));

      const attemptGenerate = async (targetCount, extra = "") => {
        const localForm = { ...form, numQ: targetCount };
        const promptBase = buildQuestionsPrompt(localForm, resumeText);
        const raw = await callAI(
          [{ role: "user", content: promptBase + extra }],
          sys,
          maxTokensForQuestions
        );
        const parsed = parseQuestionsFromRaw(raw);
        const cleaned = parsed && Array.isArray(parsed)
          ? normalizeQuestionsForProfile(parsed, localForm)
          : [];
        return { raw, parsed, cleaned };
      };

      let parsed = null;
      let cleaned = [];
      let infoMessage = "";
      let primaryFailure = null;

      try {
        const first = await attemptGenerate(requestedCount);
        parsed = first.parsed;
        cleaned = first.cleaned;

        console.log("[DEBUG] First attempt:", {
          raw_length: first.raw.length,
          raw_preview: first.raw.substring(0, 300),
          parsed_count: parsed && Array.isArray(parsed) ? parsed.length : "not array",
          cleaned_count: cleaned.length,
          requested: requestedCount,
        });

        if (!parsed || parsed.length === 0 || cleaned.length < minAcceptable) {
          const retry = await attemptGenerate(
            requestedCount,
            "\n\nIMPORTANT RETRY FORMAT: Return ONLY valid JSON in one of these forms: (1) [{...}] OR (2) {\"questions\":[{...}]}. Ensure every item includes: question, round, difficulty, type."
          );
          parsed = retry.parsed;
          cleaned = retry.cleaned;

          console.log("[DEBUG] Retry attempt:", {
            retry_triggered_by: {
              parsed_null: !parsed,
              parsed_empty: parsed && parsed.length === 0,
              below_acceptable: cleaned.length < minAcceptable,
              min_acceptable: minAcceptable,
            },
            retry_raw_length: retry.raw.length,
            retry_parsed_count: parsed && Array.isArray(parsed) ? parsed.length : "not array",
            retry_cleaned_count: cleaned.length,
          });
        }
      } catch (primaryErr) {
        primaryFailure = primaryErr;
        console.warn("[DEBUG] Primary generation failed:", primaryErr?.message || primaryErr);
      }

      const shouldBatchRecover =
        !(primaryFailure && isQuotaErrorMessage(primaryFailure?.message)) &&
        (
          !parsed ||
          cleaned.length < minAcceptable ||
          (primaryFailure && isDemandSpikeErrorMessage(primaryFailure?.message))
        );

      if (!shouldBatchRecover && primaryFailure) {
        throw primaryFailure;
      }

      if (shouldBatchRecover) {
        const chunks = buildChunkPlan(requestedCount, 10);
        const merged = [];
        let chunkFailures = 0;

        for (let i = 0; i < chunks.length; i += 1) {
          const chunkSize = chunks[i];
          try {
            const part = await attemptGenerate(
              chunkSize,
              `\n\nBATCH MODE: This is batch ${i + 1} of ${chunks.length}. Generate exactly ${chunkSize} unique questions not repeated within this batch.`
            );
            if (part.cleaned.length > 0) merged.push(...part.cleaned);
          } catch (chunkErr) {
            chunkFailures += 1;
            console.warn("[DEBUG] Chunk generation failed:", {
              chunk_index: i + 1,
              chunk_size: chunkSize,
              message: chunkErr?.message || "Unknown chunk error",
            });
          }
        }

        const mergedNormalized = normalizeQuestionsForProfile(
          merged,
          { ...form, numQ: requestedCount }
        );

        if (mergedNormalized.length > 0) {
          parsed = merged;
          cleaned = mergedNormalized;
          infoMessage =
            chunkFailures > 0
              ? `Recovered with batch generation during model demand spike. ${chunkFailures} batch(es) failed but ${cleaned.length} question(s) were generated.`
              : `Recovered with batch generation during model demand spike.`;
        } else if (primaryFailure && !isDemandSpikeErrorMessage(primaryFailure?.message)) {
          throw primaryFailure;
        }
      }

      if (parsed && Array.isArray(parsed) && cleaned.length > 0) {
        timers.forEach(clearTimeout);
        setQuestions(cleaned);
        setAiMode(true);
        const removed = parsed.length - cleaned.length;
        
        console.log("[DEBUG] Final result:", {
          parsed_total: parsed.length,
          cleaned_total: cleaned.length,
          removed_by_filter: removed,
          requested: requestedCount,
        });

        if (!infoMessage && removed > 0) {
          infoMessage = `Filtered ${removed} off-topic question(s) to match your role and JD.`;
        }
        setInfo(infoMessage);
      } else {
        throw new Error("Invalid response structure");
      }
    } catch (e) {
      timers.forEach(clearTimeout);
      setQuestions([]);
      setAiMode(false);
      setError(
        e?.message
          ? `Unable to generate questions from JD right now: ${e.message}`
          : "Unable to generate questions from JD right now. Please try again."
      );
      setStep(1);
      return;
    }

    setTab("all");
    setOpenIdx(null);
    setCache({});
    setStep(3);
  };

  /* -- OPEN ANSWER OVERLAY -- */
  const openAnswer = async (idx) => {
    setOpenIdx(idx);
    const q = filtered[idx];
    if (!q) return;
    const ckey = String(q.id ?? idx);
    if (cache[ckey]) return;

    setAnsLoading(true);
    try {
      const sys =
        "You are a world-class interview coach and senior engineer. Give complete, structured, expert-level answers. Format sections with bold headers like **1. SECTION NAME**.";
      const raw = await callAI(
        [
          {
            role: "user",
            content: buildAnswerPrompt(q, form.company, form.role, form.jd),
          },
        ],
        sys,
        2000
      );
      setCache((c) => ({ ...c, [ckey]: raw }));
    } catch (err) {
      setCache((c) => ({
        ...c,
        [ckey]: `Unable to generate answer from JD context right now. ${
          err?.message || "Please retry."
        }`,
      }));
    } finally {
      setAnsLoading(false);
    }
  };

  const closeOverlay = () => setOpenIdx(null);
  useEffect(() => {
    const h = (e) => {
      if (e.key === "Escape") closeOverlay();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  /* -- FILTER -- */
  const filtered =
    tab === "all"
      ? questions
      : questions.filter((q) => q.round === tab || q.type === tab);

  const rCount = (id) => questions.filter((q) => q.round === id).length;

  /* =================================================== RENDER =================================================== */
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <div className="app">
        {/* HEADER */}
        <header className="hdr">
          <div className="logo">IP</div>
          <div>
            <div className="hdr-l">Ambiquest Interview Prep</div>
            <div className="hdr-s">AI Assisted Solution</div>
          </div>
          <div className="hdr-r">
            {step === 3 && (
              <span className={"pill " + (aiMode ? "pill-b" : "pill-g")}>
                {aiMode ? "AI Mode" : "AI Unavailable"}
              </span>
            )}
          </div>
        </header>

        <main className="main">
          {step !== 2 && (
            <div className="stpbar">
              {["Configure", "Generating", "Questions"].map((s, i) => (
                <span key={s} style={{ display: "contents" }}>
                  <div
                    className={`stp ${
                      step === i + 1 ? "on" : step > i + 1 ? "done" : ""
                    }`}
                  >
                    <div className="sn">{step > i + 1 ? "OK" : i + 1}</div>
                    {s}
                  </div>
                  {i < 2 && <div className="sl" />}
                </span>
              ))}
            </div>
          )}

          {/* STEP 1 */}
          {step === 1 && (
            <>
              {/* AI MODE BANNER */}
              <div className="ai-banner">
                <div className="ai-icon">AI</div>
                <div className="ai-text">
                  <div className="ai-title">AI-Powered - No API Key Required</div>
                  <div className="ai-sub">
                    Powered by Claude AI directly. Generates questions tailored to your exact JD,
                    company, and resume.
                  </div>
                </div>
                <div className="ai-status">
                  <span className="ai-dot" />
                  Ready
                </div>
              </div>

              {/* COMPANY & ROLE */}
              <div className="card">
                <div className="ct">Company & Role</div>
                <div className="g2">
                  <div className="fld">
                    <label>Company Name *</label>
                    <input
                      type="text"
                      placeholder="e.g. Google, Infosys, Swiggy, Amazon..."
                      value={form.company}
                      onChange={(e) => upd("company", e.target.value)}
                    />
                  </div>
                  <div className="fld">
                    <label>Role / Position *</label>
                    <input
                      type="text"
                      placeholder="e.g. Senior Software Engineer, SDE-2..."
                      value={form.role}
                      onChange={(e) => upd("role", e.target.value)}
                    />
                  </div>
                  <div className="fld">
                    <label>Experience Level</label>
                    <select
                      value={form.level}
                      onChange={(e) => upd("level", e.target.value)}
                    >
                      <option value="junior">Junior - 0 to 3 years</option>
                      <option value="mid">Mid-level - 3 to 6 years</option>
                      <option value="senior">Senior - 6+ years</option>
                    </select>
                  </div>
                </div>
              </div>

              {/* ROUNDS */}
              <div className="card">
                <div className="ct">Interview Rounds *</div>
                <div className="rgrid">
                  {ROUNDS.map((r) => (
                    <button
                      key={r.id}
                      className={"rbtn" + (form.rounds.includes(r.id) ? " sel" : "")}
                      onClick={() => toggleRound(r.id)}
                    >
                      {r.icon} {r.label}
                      <span className="rck">OK</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Q COUNT */}
              <div className="card">
                <div className="ct">Number of Questions</div>
                <div className="qrow">
                  {QCOUNTS.map((n) => (
                    <button
                      key={n}
                      className={"qp" + (form.numQ === n ? " sel" : "")}
                      onClick={() => upd("numQ", n)}
                    >
                      {n}
                    </button>
                  ))}
                </div>
                <div className="hint" style={{ marginTop: ".5rem" }}>
                  10 = quick warm-up - 20 = standard prep - 50 = thorough - 100-150 = full
                  mock bank
                </div>
              </div>

              {/* JD */}
              <div className="card">
                <div className="ct">Job Description *</div>
                <textarea
                  placeholder="Paste the full job description here. The more detail, the more tailored and realistic the questions will be..."
                  value={form.jd}
                  onChange={(e) => upd("jd", e.target.value)}
                  style={{ minHeight: 120 }}
                />
              </div>

              {/* RESUME */}
              <div className="card">
                <div className="ct">
                  Resume - Optional (personalises questions to your background)
                </div>
                <div
                  className={"upz" + (resumeFile ? " has" : "")}
                  onClick={() => fileRef.current?.click()}
                >
                  <input
                    ref={fileRef}
                    type="file"
                    accept=".pdf,.doc,.docx,.txt"
                    onChange={(e) => handleFile(e.target.files[0])}
                  />
                  {resumeFile ? (
                    <>
                      <div>OK</div>
                      <div
                        style={{
                          fontSize: ".76rem",
                          color: "var(--grn)",
                          fontWeight: 700,
                          fontFamily: "'DM Mono',monospace",
                        }}
                      >
                        {resumeFile.name}
                      </div>
                      <div style={{ fontSize: ".64rem", color: "var(--txt3)" }}>
                        Click to replace
                      </div>
                    </>
                  ) : (
                    <>
                      <div style={{ fontSize: "1.3rem" }}>FILE</div>
                      <div
                        style={{
                          fontSize: ".77rem",
                          color: "var(--txt2)",
                          fontWeight: 600,
                        }}
                      >
                        Drop resume or click to upload
                      </div>
                      <div style={{ fontSize: ".64rem", color: "var(--txt3)" }}>
                        PDF - DOC - DOCX - TXT
                      </div>
                    </>
                  )}
                </div>
              </div>

              {error && <div className="errbx">Warning: {error}</div>}

              <div
                style={{
                  display: "flex",
                  justifyContent: "flex-end",
                  alignItems: "center",
                  gap: ".78rem",
                }}
              >
                {!canGo && <span className="hint">{getHint()}</span>}
                <button className="btn-go" onClick={generate} disabled={!canGo}>
                  Generate {form.numQ} Questions
                </button>
              </div>
            </>
          )}

          {/* STEP 2 */}
          {step === 2 && (
            <div className="genscr">
              <div className="orb" />
              <div style={{ fontSize: ".94rem", fontWeight: 700 }}>
                Building your interview prep guide...
              </div>
              <div
                style={{
                  fontSize: ".74rem",
                  color: "var(--txt3)",
                  maxWidth: 310,
                  lineHeight: 1.65,
                }}
              >
                Generating {form.numQ} realistic questions for{" "}
                <strong style={{ color: "var(--acc)" }}>{form.company || "your company"}</strong>{" "}
                across {form.rounds.length} round{form.rounds.length > 1 ? "s" : ""}
              </div>
              <div className="glogs">
                {LOAD_MSGS.map((msg, i) => (
                  <div
                    key={i}
                    className={
                      "glog" + (i < loadStep ? " done" : i === loadStep ? " on" : "")
                    }
                  >
                    <span className="gi">{i < loadStep ? "OK" : i === loadStep ? ">" : "."}</span>
                    {msg}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* STEP 3 */}
          {step === 3 && questions.length > 0 && (
            <>
              {info && <div className="infobx">Info: {info}</div>}

              <div className="reshdr">
                <div>
                  <div style={{ fontSize: "1rem", fontWeight: 700 }}>
                    {form.company} - {form.role}
                  </div>
                  <div style={{ fontSize: ".64rem", color: "var(--txt3)", marginTop: ".18rem" }}>
                    {questions.length} questions - {form.rounds.length} round
                    {form.rounds.length > 1 ? "s" : ""} - {form.level} - click any question
                    for full answer
                  </div>
                </div>
                <button
                  className="btn-back"
                  onClick={() => {
                    setStep(1);
                    setQuestions([]);
                    setError("");
                    setInfo("");
                  }}
                >
                  New Search
                </button>
              </div>

              <div className="chips">
                <div className="chip">
                  Company <strong>{form.company}</strong>
                </div>
                <div className="chip">Role {form.role}</div>
                {form.rounds.map((r) => {
                  const c = rCount(r);
                  if (!c) return null;
                  return (
                    <div className="chip" key={r}>
                      <strong>{c}</strong> {ROUNDS.find((t) => t.id === r)?.label}
                    </div>
                  );
                })}
                {questions.filter((q) => q.type === "coding").length > 0 && (
                  <div className="chip">
                    Coding <strong>{questions.filter((q) => q.type === "coding").length}</strong>
                  </div>
                )}
              </div>

              {/* TABS */}
              <div className="tabwrap">
                <div className="tabs">
                  <button className={"tab" + (tab === "all" ? " on" : "")} onClick={() => setTab("all")}>
                    All ({questions.length})
                  </button>
                  {form.rounds.map((r) => {
                    const c = rCount(r);
                    if (!c) return null;
                    const rt = ROUNDS.find((t) => t.id === r);
                    return (
                      <button key={r} className={"tab" + (tab === r ? " on" : "")} onClick={() => setTab(r)}>
                        {rt?.icon} {rt?.label} ({c})
                      </button>
                    );
                  })}
                  {["coding", "technical", "system_design", "behavioral", "situational"].map((t) => {
                    const c = questions.filter((q) => q.type === t).length;
                    if (!c) return null;
                    return (
                      <button key={t} className={"tab" + (tab === t ? " on" : "")} onClick={() => setTab(t)}>
                        {t === "coding"
                          ? "Coding"
                          : t === "system_design"
                          ? "Sys Design"
                          : t === "behavioral"
                          ? "Behavioral"
                          : t.replace("_", " ")} ({c})
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* QUESTIONS */}
              {filtered.length === 0 ? (
                <div className="empty">No questions match this filter.</div>
              ) : (
                filtered.map((q, idx) => (
                  <div className="qcard" key={q.id ?? idx} onClick={() => openAnswer(idx)}>
                    <div className="qrow">
                      <div className="qn">{String(idx + 1).padStart(2, "0")}</div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="qtxt">{q.question}</div>
                        <div className="qmeta">
                          {q.difficulty && (
                            <span className={"b " + (q.difficulty === "hard" ? "bhard" : q.difficulty === "easy" ? "beasy" : "bmed")}>
                              {q.difficulty}
                            </span>
                          )}
                          {q.type && (
                            <span className={"b " + (q.type === "coding" ? "bcode" : "btype")}>
                              {q.type.replace("_", " ")}
                            </span>
                          )}
                          {q.round && (
                            <span className="b brnd">
                              {ROUNDS.find((t) => t.id === q.round)?.label || q.round}
                            </span>
                          )}
                          {q.source_hint && <span className="bsrc">{q.source_hint}</span>}
                          {!q.source_hint &&
                            (q.sources || []).slice(0, 1).map((s, si) => (
                              <span className="bsrc" key={si}>
                                {s}
                              </span>
                            ))}
                        </div>
                      </div>
                      <button className="qbtn" onClick={(e) => { e.stopPropagation(); openAnswer(idx); }}>
                        View Answer
                      </button>
                    </div>
                  </div>
                ))
              )}
            </>
          )}
        </main>
      </div>

      {/* ANSWER OVERLAY */}
      {openIdx !== null && filtered[openIdx] && (
        <div
          className="ovlay"
          ref={backdropRef}
          onClick={(e) => {
            if (e.target === backdropRef.current) closeOverlay();
          }}
        >
          <div className="ovbox" onClick={(e) => e.stopPropagation()}>
            <div className="ovhdr">
              <div className="ovhl">
                <div className="ovlbl">
                  {filtered[openIdx].type === "coding"
                    ? "Coding"
                    : filtered[openIdx].type === "system_design"
                    ? "System Design"
                    : filtered[openIdx].type === "behavioral"
                    ? "Behavioral"
                    : filtered[openIdx].type === "situational"
                    ? "Situational"
                    : "Interview Question"}
                  {" - "}
                  <span style={{ textTransform: "capitalize" }}>
                    {filtered[openIdx].difficulty}
                  </span>
                </div>
                <div className="ovq">{filtered[openIdx].question}</div>
              </div>
              <button className="ovcls" onClick={closeOverlay}>
                X
              </button>
            </div>

            <div className="ovbody">
              {ansLoading && !cache[String(filtered[openIdx]?.id ?? openIdx)] ? (
                <div className="ovload">
                  <div className="orb" style={{ width: 44, height: 44 }} />
                  <p>
                    Generating expert answer...
                    <br />
                    <span style={{ fontSize: ".67rem" }}>
                      {filtered[openIdx].type === "coding"
                        ? "Writing complete code solution with complexity analysis..."
                        : filtered[openIdx].type === "system_design"
                        ? "Building full system design with capacity estimation..."
                        : "Crafting structured answer with company-specific tips..."}
                    </span>
                  </p>
                </div>
              ) : (
                <div
                  className="ans"
                  dangerouslySetInnerHTML={{
                    __html: fmt(cache[String(filtered[openIdx]?.id ?? openIdx)] || ""),
                  }}
                />
              )}
            </div>

            <div className="ovftr">
              <button className="btn-back" onClick={closeOverlay}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

