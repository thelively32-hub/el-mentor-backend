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

// ── SYSTEM PROMPT (secure on backend) ──
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

// ── YOUTUBE TRANSCRIPT ──
app.post('/youtube', verifyToken, async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ message: 'Missing URL' });
  const match = url.match(/(?:youtube\.com\/(?:watch\?v=|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  if (!match) return res.status(400).json({ message: 'Invalid YouTube URL' });
  const videoId = match[1];

  try {
    let transcript = '', title = '';

    // Step 1: Get page HTML to extract title and caption tracks
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    };

    const pageRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`, { headers });
    const html = await pageRes.text();

    // Extract title
    const titleMatch = html.match(/"title":"([^"]+)"/);
    if (titleMatch) title = titleMatch[1].replace(/\\u0026/g, '&').replace(/\\"/g, '"');

    // Method 1: Extract caption URL from ytInitialPlayerResponse
    const playerMatch = html.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\});/s) ||
                        html.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\})\s*;/s);

    if (playerMatch) {
      try {
        const player = JSON.parse(playerMatch[1]);
        const captions = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks;

        if (captions && captions.length > 0) {
          // Prefer English, then any available
          const track = captions.find(t => t.languageCode === 'en') ||
                        captions.find(t => t.languageCode === 'es') ||
                        captions[0];

          if (track?.baseUrl) {
            const capUrl = track.baseUrl + '&fmt=json3';
            const capRes = await fetch(capUrl, { headers });
            const capData = await capRes.json();

            if (capData.events?.length > 0) {
              transcript = capData.events
                .filter(e => e.segs)
                .map(e => e.segs.map(s => s.utf8 || '').join(''))
                .join(' ')
                .replace(/\s+/g, ' ')
                .replace(/\n/g, ' ')
                .trim();
            }
          }
        }
      } catch(e) {
        console.error('Player parse error:', e.message);
      }
    }

    // Method 2: Fallback to timedtext API with more languages
    if (!transcript) {
      for (const lang of ['en', 'es', 'a.en', 'a.es', 'en-US', 'en-GB']) {
        try {
          const r = await fetch(
            `https://www.youtube.com/api/timedtext?v=${videoId}&lang=${lang}&fmt=json3`,
            { headers }
          );
          if (!r.ok) continue;
          const d = await r.json();
          if (d.events?.length > 0) {
            transcript = d.events
              .filter(e => e.segs)
              .map(e => e.segs.map(s => s.utf8 || '').join(''))
              .join(' ')
              .replace(/\s+/g, ' ')
              .trim();
            if (transcript) break;
          }
        } catch(e) { continue; }
      }
    }

    if (!transcript) {
      return res.status(404).json({
        message: 'No captions found. Make sure the video has subtitles enabled and is publicly accessible.'
      });
    }

    // Limit transcript length to avoid token overflow
    if (transcript.length > 15000) {
      transcript = transcript.substring(0, 15000) + '... [transcript truncated]';
    }

    res.json({ transcript, title, videoId });

  } catch (err) {
    console.error('YouTube error:', err);
    res.status(500).json({ message: 'Error fetching YouTube transcript', detail: err.message });
  }
});


// ── GLOBAL ERROR HANDLER ──
app.use((err, req, res, next) => {
  console.error('Unhandled:', err);
  res.status(500).json({ message: 'Internal error', detail: err.message });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`The Mentor Backend on port ${PORT} 🔥`));