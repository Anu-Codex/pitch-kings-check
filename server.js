require("dotenv").config();
const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PIN = process.env.ADMIN_PIN || "5355";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODELS = process.env.GEMINI_MODEL || "gemini-2.5-flash";

// Ensure required folders & database file exist
const DIRS = [
  "uploads",
  "uploads/training",
  "uploads/rulebook",
  "uploads/temp",
  "data",
];
DIRS.forEach((dir) => fs.mkdirSync(path.join(__dirname, dir), { recursive: true }));

const DB_PATH = path.join(__dirname, "data", "db.json");
if (!fs.existsSync(DB_PATH)) {
  fs.writeFileSync(
    DB_PATH,
    JSON.stringify({ trainingVideos: [], rulebookImages: [] }, null, 2)
  );
}

function readDB() {
  return JSON.parse(fs.readFileSync(DB_PATH, "utf-8"));
}

function writeDB(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

// Middleware
app.use(express.json({ limit: "20mb" }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// Admin authentication middleware
function requireAdmin(req, res, next) {
  const pin = req.headers["x-admin-pin"];
  if (!pin || pin !== ADMIN_PIN) {
    return res.status(401).json({ error: "Invalid Admin PIN." });
  }
  next();
}

// Multer storage setup
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (req.path.includes("/training")) {
      cb(null, path.join(__dirname, "uploads/training"));
    } else if (req.path.includes("/rulebook")) {
      cb(null, path.join(__dirname, "uploads/rulebook"));
    } else {
      cb(null, path.join(__dirname, "uploads/temp"));
    }
  },
  filename: (req, file, cb) => {
    const safeExt = path.extname(file.originalname).toLowerCase();
    const uniqueName = `${Date.now()}-${Math.round(Math.random() * 1e6)}${safeExt}`;
    cb(null, uniqueName);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 14 * 1024 * 1024 }, // 14MB limit per clip/photo for fast inline AI vision
});

// Helper: Call Gemini Multimodal API
async function callGemini(parts, { jsonMode = false, temperature = 0.2 } = {}) {
  if (!GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is missing in environment variables.");
  }

  let lastError = null;

  for (const model of GEMINI_MODELS) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
    const body = {
      contents: [{ parts }],
      generationConfig: {
        temperature,
        ...(jsonMode ? { responseMimeType: "application/json" } : {}),
      },
    };

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const data = await response.json();
      if (!response.ok) {
        lastError = new Error(`[${model}] ${data.error?.message || "Request failed"}`);
        // Automatically try backup model if unavailable, rate-limited, or high demand
        if ([400, 404, 429, 500, 503].includes(response.status)) {
          continue;
        }
        throw lastError;
      }

      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) {
        lastError = new Error(`[${model}] Empty response from AI.`);
        continue;
      }
      return text;
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error("All configured Gemini models failed.");
}

function fileToInlinePart(filePath, mimeType) {
  const buffer = fs.readFileSync(filePath);
  return {
    inline_data: {
      mime_type: mimeType,
      data: buffer.toString("base64"),
    },
  };
}

function getLanguageInstruction(language) {
  if (language === "hi") {
    return (
      "LANGUAGE REQUIREMENT: Respond strictly in pure, formal, grammatically correct Hindi (शुद्ध हिंदी) " +
      "using Devanagari script ONLY. Do NOT use WhatsApp Hinglish, Roman Hindi, or casual slang."
    );
  }
  return (
    "LANGUAGE REQUIREMENT: Respond strictly in clear, formal, grammatically correct English. " +
    "Do NOT use slang or casual WhatsApp shorthand."
  );
}

// ---------------- ROUTES ----------------

// Verify Admin PIN
app.post("/api/admin/verify", (req, res) => {
  const { pin } = req.body;
  if (pin === ADMIN_PIN) {
    return res.json({ ok: true });
  }
  return res.status(401).json({ ok: false, error: "Incorrect PIN" });
});

// List all models currently available on your GEMINI_API_KEY
app.get("/api/models", async (req, res) => {
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${GEMINI_API_KEY}`
    );
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json(data);

    const available = (data.models || [])
      .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
      .map((m) => ({
        id: m.name.replace(/^models\//, ""),
        displayName: m.displayName,
      }));

    res.json({ activeConfigured: GEMINI_MODELS, available });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// Get training counts and rulebook list
app.get("/api/status", (req, res) => {
  const db = readDB();
  const counts = {
    real_cross: 0,
    fake_cross: 0,
    real_lob: 0,
    fake_lob: 0,
  };
  db.trainingVideos.forEach((v) => {
    if (counts[v.category] !== undefined) counts[v.category]++;
  });

  res.json({
    counts,
    trainingVideos: db.trainingVideos,
    rulebookImages: db.rulebookImages,
  });
});

// 1. ADMIN: Upload & Index a Training Reference Video
app.post(
  "/api/admin/training",
  requireAdmin,
  upload.single("video"),
  async (req, res) => {
    try {
      const { category, notes = "" } = req.body;
      const validCategories = ["real_cross", "fake_cross", "real_lob", "fake_lob"];
      if (!validCategories.includes(category)) {
        return res.status(400).json({ error: "Invalid training category." });
      }
      if (!req.file) {
        return res.status(400).json({ error: "Please upload a video file." });
      }

      const categoryDescriptions = {
        real_cross: "A TRUE Cross Goal (valid cross from wide/flank into the box leading to a goal).",
        fake_cross: "NOT a Cross Goal, even though it superficially looks like one.",
        real_lob: "A TRUE Lob Goal (valid chipped/lofted ball over the goalkeeper or defense).",
        fake_lob: "NOT a Lob Goal, even though it superficially looks like one.",
      };

      const analysisPrompt = `
You are building a visual training knowledge base for a football/gaming referee AI.
This uploaded reference video is labeled by the community admin as:
CATEGORY: ${category} — ${categoryDescriptions[category]}
ADMIN NOTES: ${notes || "None provided"}

Watch the clip carefully and write a concise, objective technical breakdown (4-6 bullet points) of the visual cues that make this clip belong to "${category}":
- Where the pass/shot originates (flank/wing vs central)
- Ball trajectory (low/driven vs lofted arc vs chip over keeper)
- Player and goalkeeper positioning
- Key distinguishing feature between a true cross/lob and a deceptive lookalike.
`;

      const aiFeatures = await callGemini([
        { text: analysisPrompt },
        fileToInlinePart(req.file.path, req.file.mimetype),
      ]);

      const db = readDB();
      const entry = {
        id: Date.now().toString(),
        category,
        filename: req.file.filename,
        originalName: req.file.originalname,
        mimeType: req.file.mimetype,
        notes,
        aiFeatures,
        createdAt: new Date().toISOString(),
      };
      db.trainingVideos.push(entry);
      writeDB(db);

      res.json({ ok: true, entry });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  }
);

// Delete training video
app.delete("/api/admin/training/:id", requireAdmin, (req, res) => {
  const db = readDB();
  const idx = db.trainingVideos.findIndex((v) => v.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "Not found" });

  const [removed] = db.trainingVideos.splice(idx, 1);
  const filePath = path.join(__dirname, "uploads/training", removed.filename);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

  writeDB(db);
  res.json({ ok: true });
});

// 2. ADMIN: Upload Rulebook / Community Details Photo
app.post(
  "/api/admin/rulebook",
  requireAdmin,
  upload.single("image"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "Please upload an image file." });
      }
      const title = req.body.title || req.file.originalname;

      const ocrPrompt = `
Extract all text, rules, entry fees, timings, numbers, and community details visible in this image cleanly and accurately.
Preserve headings and bullet points. Do not invent anything that is not in the image.
`;
      const extractedText = await callGemini([
        { text: ocrPrompt },
        fileToInlinePart(req.file.path, req.file.mimetype),
      ]);

      const db = readDB();
      const entry = {
        id: Date.now().toString(),
        title,
        filename: req.file.filename,
        originalName: req.file.originalname,
        mimeType: req.file.mimetype,
        extractedText,
        createdAt: new Date().toISOString(),
      };
      db.rulebookImages.push(entry);
      writeDB(db);

      res.json({ ok: true, entry });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  }
);

// Delete rulebook photo
app.delete("/api/admin/rulebook/:id", requireAdmin, (req, res) => {
  const db = readDB();
  const idx = db.rulebookImages.findIndex((img) => img.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "Not found" });

  const [removed] = db.rulebookImages.splice(idx, 1);
  const filePath = path.join(__dirname, "uploads/rulebook", removed.filename);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

  writeDB(db);
  res.json({ ok: true });
});

// 3. USER: Check Goal Video (Cross / Lob)
app.post("/api/check-video", upload.single("video"), async (req, res) => {
  const tempPath = req.file?.path;
  try {
    if (!req.file) {
      return res.status(400).json({ error: "Please upload a video clip to check." });
    }
    const { checkType = "both", language = "en" } = req.body;
    const db = readDB();

    // Compile learned reference rules from admin-uploaded training videos
    const grouped = {
      real_cross: [],
      fake_cross: [],
      real_lob: [],
      fake_lob: [],
    };
    db.trainingVideos.forEach((v) => {
      if (grouped[v.category]) {
        grouped[v.category].push(`- [${v.originalName}]: ${v.aiFeatures}`);
      }
    });

    const knowledgeBase = `
COMMUNITY TRAINING EXAMPLES KNOWLEDGE BASE:
[1. Real Cross Goal Examples (${grouped.real_cross.length} videos)]
${grouped.real_cross.join("\n") || "No custom clips uploaded yet; use standard football cross goal rules."}

[2. Looks Like Cross, But NOT Cross Examples (${grouped.fake_cross.length} videos)]
${grouped.fake_cross.join("\n") || "None uploaded yet."}

[3. Real Lob Goal Examples (${grouped.real_lob.length} videos)]
${grouped.real_lob.join("\n") || "No custom clips uploaded yet; use standard football lob/chip goal rules."}

[4. Looks Like Lob, But NOT Lob Examples (${grouped.fake_lob.length} videos)]
${grouped.fake_lob.join("\n") || "None uploaded yet."}
`;

    const prompt = `
You are an impartial, expert Football / Gaming Tournament Video Referee AI.
Analyze the attached goal video clip and determine whether it is a Cross Goal and/or a Lob Goal based on the community's training knowledge base below.

CHECK MODE REQUESTED: ${checkType} (options: "cross", "lob", or "both")
${getLanguageInstruction(language)}

${knowledgeBase}

Return a JSON object with this EXACT schema:
{
  "cross_percent": <integer 0 to 100>,
  "not_cross_percent": <integer equal to 100 - cross_percent>,
  "lob_percent": <integer 0 to 100>,
  "not_lob_percent": <integer equal to 100 - lob_percent>,
  "cross_statement": "<exact summary line in requested language, e.g. 'This is 90% cross, 10% not cross' or in Hindi 'यह 90% क्रॉस है, 10% क्रॉस नहीं है'>",
  "lob_statement": "<exact summary line in requested language, e.g. 'This is 85% lob, 15% not lob' or in Hindi 'यह 85% लॉब है, 15% लॉब नहीं है'>",
  "explanation": "<detailed 2-4 sentence referee explanation in the requested language explaining ball movement, pass origin, and why these percentages were assigned>"
}
`;

    const rawJson = await callGemini(
      [{ text: prompt }, fileToInlinePart(tempPath, req.file.mimetype)],
      { jsonMode: true, temperature: 0.15 }
    );

    const parsed = JSON.parse(rawJson);
    res.json({ ok: true, result: parsed });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  } finally {
    if (tempPath && fs.existsSync(tempPath)) {
      fs.unlinkSync(tempPath); // clean up user temp video after checking
    }
  }
});

// 4. USER: Ask Rulebook / Community Details Question
app.post("/api/ask-rulebook", async (req, res) => {
  try {
    const { question, language = "en" } = req.body;
    if (!question || !question.trim()) {
      return res.status(400).json({ error: "Please enter a question." });
    }

    const db = readDB();
    if (db.rulebookImages.length === 0) {
      const emptyMsg =
        language === "hi"
          ? "क्षमा करें, अभी तक एडमिन द्वारा कोई नियम-पुस्तिका (रूलबुक) या समुदाय विवरण की फ़ोटो अपलोड नहीं की गई है।"
          : "Sorry, no rulebook or community detail photos have been uploaded by the admins yet.";
      return res.json({ ok: true, answer: emptyMsg });
    }

    // Include up to 8 actual rulebook photos directly + extracted text from all photos
    const parts = [];
    const rulebookTextDump = db.rulebookImages
      .map((img, i) => `--- Photo ${i + 1}: ${img.title} ---\n${img.extractedText}`)
      .join("\n\n");

    const prompt = `
You are the official Robotic AI Half-Admin for this gaming/sports community.
A member has asked the following question:
"${question}"

${getLanguageInstruction(language)}

Answer the question strictly using the uploaded Rulebook & Community Detail photos (provided both visually and as extracted notes below).
If the answer is not found in the rulebook/photos, politely state that this detail is not mentioned in the uploaded rulebook and suggest contacting the main admin.
Keep the answer clear, accurate, and polite.

EXTRACTED NOTES FROM ALL RULEBOOK PHOTOS:
${rulebookTextDump}
`;
    parts.push({ text: prompt });

    db.rulebookImages.slice(0, 8).forEach((img) => {
      const p = path.join(__dirname, "uploads/rulebook", img.filename);
      if (fs.existsSync(p)) {
        parts.push(fileToInlinePart(p, img.mimeType));
      }
    });

    const answer = await callGemini(parts, { temperature: 0.2 });
    res.json({ ok: true, answer });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Half-Admin AI Website running at http://localhost:${PORT}`);
});
