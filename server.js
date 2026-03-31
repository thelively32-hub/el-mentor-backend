const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');

const app = express();
app.use(cors());
app.use(express.json({ limit: '25mb' }));

// ── FIREBASE ADMIN INIT ──
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// ── ENV VARS ──
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const REVENUECAT_API_KEY = process.env.REVENUECAT_API_KEY;
const SUPADATA_API_KEY = process.env.SUPADATA_API_KEY;

// ── SYSTEM PROMPT ──
const THE_MENTOR_PROMPT = `You are THE MENTOR — an elite analytical intelligence with encyclopedic expertise across ALL domains: poetry, music, film, law, business, psychology, fitness, technology, and every field of human knowledge. You can analyze ANY input: text, images, audio transcripts, legal documents, business plans, fitness routines, or any creative/professional work.

PRIORITY RULES:
RULE 1: Return ONLY valid JSON. No markdown, no preamble, no text outside JSON.
RULE 2: Every reference must be REAL and verifiable — name specific works, years, people.
RULE 3: Zero vagueness — every sentence must be specific and actionable.
RULE 4: ALL JSON fields required — no empty strings or null values.
RULE 5: Expert mode — sharp, direct, occasionally ruthless, always constructive.
RULE 6: Self-correct before sending — validate JSON is perfectly parseable.

SCORING: 0-25 Weak, 26-40 Below Average, 41-55 Average, 56-70 Emerging, 71-84 Competitive, 85-93 High-Level, 94-100 Exceptional

OUTPUT — STRICT JSON ONLY:
{"score":<0-100>,"zona":"<level>","tipo_detectado":"<precise type>","contexto_historico":{"referente":"<name + work + year>","explicacion":"<mechanism that made it succeed — 2+ sentences>","comparacion":"<direct comparison to user work>"},"paralelo_moderno":{"referente":"<name/brand + current work>","explicacion":"<why succeeding now — 2+ sentences>","comparacion":"<direct comparison>"},"posicionamiento":"<Level> — <one sentence justification>","proyeccion":"<realistic success path>","evaluacion_general":"<4-5 sentence honest verdict>","elementos":[{"nombre":"<criterion>","impacto":<-25 to 25>,"positivo":<true/false>,"referente":"<HISTORICAL: name+work+mastery> | <MODERN: name+work+relevance>","detalle":"<specific analysis citing actual elements from submission>","recomendacion":"<one concrete immediate action>"}],"interpretacion":"<3-4 sentence honest trajectory assessment>","recomendaciones":["<improvement #1 with real master example>","<improvement #2>","<improvement #3>"]}`;

// ── VERIFY FIREBASE TOKEN ──
async function verifyToken(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Missing authorization token' });
  }
  try {
    req.user = await admin.auth().verifyIdToken(auth.split('Bearer ')[1]);
    next();
  } catch (err) {
    return res.status(401).json({ message: 'Invalid or expired token' });
  }
}

// ── USAGE TRACKING ──
async function checkAndIncrementUsage(uid, plan) {
  if (plan === 'pro') return { allowed: true };
  const today = new Date().toISOString().split('T')[0];
  const ref = db.collection('usage').doc(uid);
  const doc = await ref.get();
  const FREE_LIMIT = 5;
  if (!doc.exists || doc.data().lastResetDate !== today) {
    await ref.set({ userId: uid, dailyCount: 1, lastResetDate: today });
    return { allowed: true, remaining: FREE_LIMIT - 1 };
  }
  const data = doc.data();
  if (data.dailyCount >= FREE_LIMIT) {
    return { allowed: false, remaining: 0, message: `Daily limit of ${FREE_LIMIT} analyses reached. Upgrade to Pro for unlimited.` };
  }
  await ref.update({ dailyCount: admin.firestore.FieldValue.increment(1) });
  return { allowed: true, remaining: FREE_LIMIT - data.dailyCount - 1 };
}

// ── TEST ──
app.get('/', (req, res) => res.json({ status: 'ok', message: 'The Mentor Backend 🔥' }));

// ── CHECK SUBSCRIPTION ──
app.post('/check-subscription', verifyToken, async (req, res) => {
  const uid = req.user.uid;
  try {
    if (!REVENUECAT_API_KEY) return res.json({ plan: 'free', uid });
    const r = await fetch(`https://api.revenuecat.com/v1/subscribers/${uid}`, {
      headers: { 'Authorization': `Bearer ${REVENUECAT_API_KEY}`, 'Content-Type': 'application/json' }
    });
    if (!r.ok) return res.json({ plan: 'free', uid });
    const d = await r.json();
    const ent = d?.subscriber?.entitlements?.pro;
    const isPro = ent && new Date(ent.expires_date) > new Date();
    res.json({ plan: isPro ? 'pro' : 'free', uid });
  } catch (err) {
    res.json({ plan: 'free', uid });
  }
});

// ── ANALYZE ──
app.post('/analyze', verifyToken, async (req, res) => {
  const uid = req.user.uid;
  const { messages, plan = 'free' } = req.body;
  if (!messages || !Array.isArray(messages)) return res.status(400).json({ message: 'Invalid messages' });
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ message: 'API key not configured' });
  const usage = await checkAndIncrementUsage(uid, plan);
  if (!usage.allowed) return res.status(429).json({ message: usage.message, code: 'LIMIT_REACHED' });
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 4000, system: THE_MENTOR_PROMPT, messages })
    });
    const data = await response.json();
    if (!response.ok) return res.status(502).json({ message: 'AI error', detail: data });
    const text = (data.content || []).map(c => c.text || '').join('');
    if (!text || text.length < 10) return res.status(502).json({ message: 'Empty AI response' });
    res.json({ result: text, remaining: usage.remaining });
  } catch (err) {
    res.status(500).json({ message: 'Analysis error', detail: err.message });
  }
});

// ── SAVE ANALYSIS ──
app.post('/save', verifyToken, async (req, res) => {
  const uid = req.user.uid;
  const { result } = req.body;
  if (!result) return res.status(400).json({ message: 'Missing result' });
  try {
    const ref = await db.collection('analisis').add({
      userId: uid, score: result.score || 0,
      tipo_detectado: result.tipo_detectado || '', zona: result.zona || '',
      result: JSON.stringify(result), createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    res.json({ id: ref.id });
  } catch (err) {
    res.status(500).json({ message: 'Save error', detail: err.message });
  }
});

// ── HISTORY ──
app.get('/history', verifyToken, async (req, res) => {
  const uid = req.user.uid;
  try {
    const snap = await db.collection('analisis').where('userId', '==', uid).orderBy('createdAt', 'desc').limit(20).get();
    const items = snap.docs.map(doc => ({
      id: doc.id, ...doc.data(),
      result: doc.data().result ? JSON.parse(doc.data().result) : null,
      createdAt: doc.data().createdAt?.toDate?.()?.toISOString() || null
    }));
    res.json({ items });
  } catch (err) {
    res.status(500).json({ message: 'History error', detail: err.message });
  }
});

// ── TRANSCRIBE (Whisper) ──
app.post('/transcribe', verifyToken, async (req, res) => {
  const { audioBase64, mimeType, filename } = req.body;
  if (!audioBase64 || !mimeType) return res.status(400).json({ message: 'Missing audio data' });
  if (!OPENAI_API_KEY) return res.status(500).json({ message: 'OpenAI key not configured' });
  try {
    const buf = Buffer.from(audioBase64, 'base64');
    const boundary = '----FormBoundary' + Math.random().toString(36).slice(2);
    const fname = filename || ('audio.' + (mimeType.split('/')[1] || 'mp3'));
    const parts = [
      `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1`,
      `--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\ntext`
    ];
    const fh = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fname}"\r\nContent-Type: ${mimeType}\r\n\r\n`;
    const body = Buffer.concat([Buffer.from(parts.join('\r\n') + '\r\n' + fh, 'utf8'), buf, Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')]);
    const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length },
      body
    });
    if (!r.ok) return res.status(502).json({ message: 'Whisper failed', detail: await r.text() });
    res.json({ transcript: (await r.text()).trim() });
  } catch (err) {
    res.status(500).json({ message: 'Transcription error', detail: err.message });
  }
});

// ── YOUTUBE HELPERS ──

// STRATEGY 1: Free captions via timedtext (works for videos with public subtitles)
async function getFreeCaptions(videoId) {
  const langs = ['en', 'es', 'en-US', 'en-GB'];
  for (const lang of langs) {
    try {
      const url = `https://www.youtube.com/api/timedtext?lang=${lang}&v=${videoId}&fmt=json3`;
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
      });
      if (!res.ok) continue;
      const data = await res.json();
      if (!data.events || data.events.length === 0) continue;

      const text = data.events
        .filter(e => e.segs)
        .map(e => e.segs.map(s => s.utf8 || '').join(''))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();

      if (text.length > 100) {
        console.log(`Free captions OK (${lang}): ${text.length} chars`);
        return text;
      }
    } catch (e) {
      console.log(`timedtext ${lang} failed:`, e.message);
    }
  }

  // Try auto-generated captions
  try {
    const url = `https://www.youtube.com/api/timedtext?v=${videoId}&lang=en&kind=asr&fmt=json3`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    if (res.ok) {
      const data = await res.json();
      if (data.events && data.events.length > 0) {
        const text = data.events
          .filter(e => e.segs)
          .map(e => e.segs.map(s => s.utf8 || '').join(''))
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();
        if (text.length > 100) {
          console.log(`Free auto-captions OK: ${text.length} chars`);
          return text;
        }
      }
    }
  } catch (e) {}

  throw new Error('No free captions available');
}

// STRATEGY 2: Supadata (paid fallback — only when free captions unavailable)
async function getSupadataTranscript(videoId) {
  if (!SUPADATA_API_KEY) throw new Error('Supadata API key not configured');

  const youtubeUrl = `https://www.youtube.com/watch?v=${videoId}`;
  console.log('Using Supadata for:', videoId);

  const res = await fetch(`https://api.supadata.ai/v1/youtube/transcript?url=${encodeURIComponent('https://www.youtube.com/watch?v=' + videoId)}&text=true`, {
  method: 'GET',
  headers: {
    'x-api-key': SUPADATA_API_KEY
  }
});
   

  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    throw new Error(errData.message || errData.error || `Supadata error ${res.status}`);
  }

  const data = await res.json();
  const text = data.content || data.transcript || data.text || '';

  if (!text || text.length < 50) {
    throw new Error('Supadata returned empty transcript');
  }

  console.log(`Supadata OK: ${text.length} chars`);
  return text;
}

// ── YOUTUBE TRANSCRIPT ENDPOINT (hybrid: free first → Supadata fallback) ──
const ytCache = new Map();

app.post('/youtube', verifyToken, async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ message: 'Missing URL' });

  const match = url.match(/(?:youtube\.com\/(?:watch\?v=|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  if (!match) return res.status(400).json({ message: 'Invalid YouTube URL' });
  const videoId = match[1];

  if (ytCache.has(videoId)) {
    console.log('Cache hit:', videoId);
    return res.json(ytCache.get(videoId));
  }

  console.log('Processing YouTube video:', videoId);

  let transcript = '';
  let source = '';

  // STRATEGY 1: Free captions
  try {
    transcript = await getFreeCaptions(videoId);
    source = 'captions';
  } catch (e) {
    console.log('Free captions failed, trying Supadata...');

    // STRATEGY 2: Supadata (paid)
    try {
      transcript = await getSupadataTranscript(videoId);
      source = 'supadata';
    } catch (e2) {
      console.error('Both strategies failed:', e2.message);
      return res.status(404).json({
        message: 'Could not get transcript. The video may not have captions or may be restricted.'
      });
    }
  }

  // Clean up transcript
  const cleaned = transcript
    .replace(/\[.*?\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (cleaned.length < 50) {
    return res.status(404).json({ message: 'Transcript too short or empty.' });
  }

  const finalText = cleaned.length > 15000
    ? cleaned.substring(0, 15000) + '... [truncated]'
    : cleaned;

  // Get title via oEmbed
  let title = '';
  try {
    const oRes = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`);
    if (oRes.ok) { const o = await oRes.json(); title = o.title || ''; }
  } catch (e) {}

  const result = { transcript: finalText, title, videoId, source };
  ytCache.set(videoId, result);

  console.log(`Done [${source}]: ${finalText.length} chars, title: "${title}"`);
  res.json(result);
});

// ── GLOBAL ERROR HANDLER ──
app.use((err, req, res, next) => {
  console.error('Unhandled:', err);
  res.status(500).json({ message: 'Internal error', detail: err.message });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`The Mentor Backend on port ${PORT} 🔥`));
