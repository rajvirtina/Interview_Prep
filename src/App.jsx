import { useState, useRef, useEffect } from "react";
import "./App.css";

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
    const val = payload[key];
    if (!Array.isArray(val) || val.length === 0) continue;
    const first = val[0];
    if (typeof first === "string") return val.map((q, i) => ({ id: i + 1, question: q }));
    if (first && typeof first === "object") return val;
    // numeric/other arrays — skip, don't return
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
function sanitizeInput(str, maxLen = 500) {
  return String(str || "")
    .replace(/[\u0000-\u001F]/g, " ")
    .slice(0, maxLen)
    .trim();
}

function buildQuestionsPrompt(form, resumeText) {
  const currentYear = new Date().getFullYear();
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
- Company: ${sanitizeInput(form.company, 100)}
- Role: ${sanitizeInput(form.role, 100)}
- Experience: ${
    form.level === "junior"
      ? "Junior (0-3 yrs)"
      : form.level === "mid"
      ? "Mid-level (3-6 yrs)"
      : "Senior (6+ yrs)"
  }
- Rounds: ${rl}

JOB DESCRIPTION:
${sanitizeInput(form.jd, 2500)}
${resumeText ? "\nCANDIDATE RESUME:\n" + sanitizeInput(resumeText, 2000) : ""}

CRITICAL REQUIREMENTS:
1. Questions must sound like a REAL human interviewer saying them - specific, contextual, sometimes tricky
2. For "coding" round: include actual LeetCode-style problems with problem name and number where applicable
3. For "system_design": name real systems (WhatsApp, Uber, Instagram, Zomato, etc.)
4. For "managerial"/"hr": use real scenario language ("Your sprint is at risk 2 days before the deadline...")
5. Reference the EXACT technologies mentioned in the JD
6. Use source_hint like: "Glassdoor - ${form.company} SDE Interview ${currentYear}" or "Blind - ${form.company} thread"
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
    "source_hint": "Glassdoor - ${form.company} SDE1 Interview ${currentYear}",
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
  const safeCompany = sanitizeInput(company, 100);
  const safeRole = sanitizeInput(role, 100);
  const safeQuestion = sanitizeInput(q.question, 500);
  const isCoding = q.type === "coding";
  const isSD = q.type === "system_design" || q.round === "system_design";
  const isBeh =
    ["behavioral", "situational", "cultural"].includes(q.type) ||
    q.round === "hr" ||
    q.round === "managerial";
  const qaProfile = QA_TESTING_KEYWORDS.test(`${role || ""} ${jd || ""}`);
  const jdContext = sanitizeInput(jd, 2500);
  const jdBlock = jdContext
    ? `\nJOB DESCRIPTION CONTEXT:\n${jdContext}\n\nTailor your answer to the JD technologies, responsibilities, and seniority expectations.`
    : "";
  const qaAnswerRules = qaProfile
    ? `\nQA ROLE RULES:\n- Keep examples in QA/testing context (manual testing, test case design, defect lifecycle, BDD/Cucumber, Python automation).\n- Avoid software-developer coding interview framing unless the question explicitly asks for automation code.\n`
    : "";

  if (isCoding) {
    return `You are a FAANG senior engineer coaching a ${safeRole} candidate at ${safeCompany}.

QUESTION: "${safeQuestion}"
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
2-3 actual follow-up questions interviewers at ${safeCompany} ask after this problem.

Write clean, real code. Be specific and precise.`;
  }

  if (isSD) {
    return `You are a Staff Engineer at ${safeCompany} answering a system design question for a ${safeRole} candidate.

QUESTION: "${safeQuestion}"
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
How ${safeCompany} or a comparable company has actually solved this. Reference real tech choices if known.

Use specific numbers. Name real technologies. Avoid vague statements like "use a database".`;
  }

  if (isBeh) {
    return `You are a senior hiring manager at ${safeCompany} coaching a ${safeRole} candidate.

QUESTION: "${safeQuestion}"
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
6-8 specific phrases that resonate strongly at ${safeCompany} based on their known values and culture.

**5. COMMON MISTAKES**
3 specific things candidates do wrong on this question that are immediate red flags.

**6. FOLLOW-UP TO EXPECT**
The exact follow-up the interviewer will ask next, and a one-paragraph answer to it.

Make the model answer sound like a real human, not a textbook.`;
  }

  return `You are a senior interviewer at ${safeCompany} for the ${safeRole} role.

QUESTION: "${safeQuestion}"
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

Be specific to ${safeCompany}. Reference their known tech stack or culture where relevant.`;
}

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
  const [resumeWarning, setResumeWarning] = useState("");
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
      rd.onload = (e) => setResumeText(e.target.result.slice(0, 2000));
      rd.readAsText(file);
    } else {
      setResumeText(`[Uploaded: ${file.name}]`);
      setResumeWarning("Only .txt files are read for personalisation. PDF/DOCX content is ignored.");
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
        8000,
        Math.max(2000, requestedCount * 150)
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

        if (import.meta.env.DEV) {
          console.log("[DEBUG] First attempt:", {
            raw_length: first.raw.length,
            raw_preview: first.raw.substring(0, 300),
            parsed_count: parsed && Array.isArray(parsed) ? parsed.length : "not array",
            cleaned_count: cleaned.length,
            requested: requestedCount,
          });
        }

        if (!parsed || parsed.length === 0 || cleaned.length < minAcceptable) {
          const retry = await attemptGenerate(
            requestedCount,
            "\n\nIMPORTANT RETRY FORMAT: Return ONLY valid JSON in one of these forms: (1) [{...}] OR (2) {\"questions\":[{...}]}. Ensure every item includes: question, round, difficulty, type."
          );
          parsed = retry.parsed;
          cleaned = retry.cleaned;

          if (import.meta.env.DEV) {
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
        }
      } catch (primaryErr) {
        primaryFailure = primaryErr;
        if (import.meta.env.DEV) {
          console.warn("[DEBUG] Primary generation failed:", primaryErr?.message || primaryErr);
        }
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
            if (import.meta.env.DEV) {
              console.warn("[DEBUG] Chunk generation failed:", {
                chunk_index: i + 1,
                chunk_size: chunkSize,
                message: chunkErr?.message || "Unknown chunk error",
              });
            }
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
        const removed = parsed.length - cleaned.length;
        
        if (import.meta.env.DEV) {
          console.log("[DEBUG] Final result:", {
            parsed_total: parsed.length,
            cleaned_total: cleaned.length,
            removed_by_filter: removed,
            requested: requestedCount,
          });
        }

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

  /* -- FILTER -- */
  const filtered =
    tab === "all"
      ? questions
      : questions.filter((q) => q.round === tab || q.type === tab);

  const rCount = (id) => questions.filter((q) => q.round === id).length;

  /* -- OPEN ANSWER OVERLAY -- */
  const openAnswer = async (idx) => {
    document.body.style.overflow = "hidden";
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

  const closeOverlay = () => {
    document.body.style.overflow = "";
    setOpenIdx(null);
  };
  useEffect(() => {
    const h = (e) => {
      if (e.key === "Escape") closeOverlay();
    };
    window.addEventListener("keydown", h);
    return () => {
      window.removeEventListener("keydown", h);
      document.body.style.overflow = "";
    };
  }, []);

  /* =================================================== RENDER =================================================== */
  return (
    <>
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
              <span className="pill pill-b">AI Mode</span>
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
                  <div className="ai-title">AI-Powered — No Setup Required</div>
                  <div className="ai-sub">
                    Powered by AI. Generates questions tailored to your exact JD,
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
                    accept=".txt"
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
                        TXT — PDF/DOCX coming soon
                      </div>
                    </>
                  )}
                </div>
                {resumeWarning && (
                  <div className="errbx" style={{ marginTop: ".5rem" }}>{resumeWarning}</div>
                )}
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

