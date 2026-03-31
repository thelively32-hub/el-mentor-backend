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
const ASSEMBLYAI_API_KEY = process.env.ASSEMBLYAI_API_KEY;

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

// ── YOUTUBE TRANSCRIPT (via AssemblyAI — professional grade) ──
const ytCache = new Map();

async function transcribeWithAssemblyAI(youtubeUrl) {
  if (!ASSEMBLYAI_API_KEY) throw new Error('AssemblyAI API key not configured');

  // Step 1: Submit transcription job
  const submitRes = await fetch('https://api.assemblyai.com/v2/transcript', {
    method: 'POST',
    headers: {
      'Authorization': ASSEMBLYAI_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      audio_url: youtubeUrl,
      speech_model: 'universal-2',
      language_detection: true,
      punctuate: true,
      format_text: true
    })
  });

  if (!submitRes.ok) {
    const err = await submitRes.json();
    throw new Error(`AssemblyAI submit failed: ${err.error || submitRes.status}`);
  }

  const { id } = await submitRes.json();
  console.log('AssemblyAI job submitted:', id);

  // Step 2: Poll for completion (max 3 minutes)
  const maxAttempts = 36; // 36 * 5s = 3 minutes
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, 5000)); // wait 5 seconds

    const pollRes = await fetch(`https://api.assemblyai.com/v2/transcript/${id}`, {
      headers: { 'Authorization': ASSEMBLYAI_API_KEY }
    });

    const data = await pollRes.json();
    console.log(`AssemblyAI poll ${i + 1}: status = ${data.status}`);

    if (data.status === 'completed') {
      return data.text || '';
    }

    if (data.status === 'error') {
      throw new Error(`AssemblyAI transcription error: ${data.error}`);
    }
  }

  throw new Error('AssemblyAI transcription timed out after 3 minutes.');
}

app.post('/youtube', verifyToken, async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ message: 'Missing URL' });

  const match = url.match(/(?:youtube\.com\/(?:watch\?v=|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  if (!match) return res.status(400).json({ message: 'Invalid YouTube URL' });
  const videoId = match[1];

  if (ytCache.has(videoId)) {
    console.log('YouTube cache hit:', videoId);
    return res.json(ytCache.get(videoId));
  }

  if (!ASSEMBLYAI_API_KEY) {
    return res.status(500).json({ message: 'AssemblyAI API key not configured' });
  }

  console.log('Transcribing YouTube video:', videoId);

  try {
    const youtubeUrl = `https://www.youtube.com/watch?v=${videoId}`;

    // Transcribe with AssemblyAI
    const transcript = await transcribeWithAssemblyAI(youtubeUrl);

    if (!transcript || transcript.length < 50) {
      return res.status(404).json({ message: 'Transcript too short or empty. The video may not have audio content.' });
    }

    // Truncate if too long
    const finalText = transcript.length > 15000
      ? transcript.substring(0, 15000) + '... [truncated]'
      : transcript;

    // Get title via oEmbed
    let title = '';
    try {
      const oRes = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(youtubeUrl)}&format=json`);
      if (oRes.ok) {
        const o = await oRes.json();
        title = o.title || '';
      }
    } catch (e) {}

    const result = { transcript: finalText, title, videoId };
    ytCache.set(videoId, result);

    console.log(`Transcript ready: ${finalText.length} chars, title: "${title}"`);
    res.json(result);

  } catch (err) {
    console.error('YouTube transcription error:', err.message);

    if (err.message?.includes('timed out')) {
      return res.status(408).json({ message: 'Transcription timed out. Try a shorter video.' });
    }
    if (err.message?.includes('private') || err.message?.includes('unavailable')) {
      return res.status(404).json({ message: 'This video is private or unavailable.' });
    }

    res.status(500).json({
      message: 'Could not transcribe video. Make sure it is public and has audio.',
      detail: err.message
    });
  }
});

// ── GLOBAL ERROR HANDLER ──
app.use((err, req, res, next) => {
  console.error('Unhandled:', err);
  res.status(500).json({ message: 'Internal error', detail: err.message });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`The Mentor Backend on port ${PORT} 🔥`));
