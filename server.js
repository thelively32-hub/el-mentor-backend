const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' }));

let users = [];

// ── TEST ──
app.get('/', (req, res) => {
  res.send('El Mentor Backend funcionando 🔥');
});

// ── REGISTER ──
app.post('/register', (req, res) => {
  const { name, email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ message: 'Faltan datos' });
  }
  const userExists = users.find(u => u.email === email);
  if (userExists) {
    return res.status(400).json({ message: 'Usuario ya existe' });
  }
  const newUser = { name, email, password };
  users.push(newUser);
  res.json({ message: 'Usuario creado', user: newUser });
});

// ── LOGIN ──
app.post('/login', (req, res) => {
  const { email, password } = req.body;
  const user = users.find(u => u.email === email && u.password === password);
  if (!user) {
    return res.status(401).json({ message: 'Credenciales incorrectas' });
  }
  res.json({ message: 'Login exitoso', user });
});

// ── ANALYZE ──
app.post('/analyze', async (req, res) => {
  const { messages, system } = req.body;

  if (!messages || !system) {
    return res.status(400).json({ message: 'Faltan datos para el análisis' });
  }

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ message: 'API key no configurada en el servidor' });
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1500,
        system: system,
        messages: messages
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Anthropic error:', data);
      return res.status(502).json({ message: 'Error del modelo IA', detail: data });
    }

    const text = (data.content || []).map(c => c.text || '').join('');
    res.json({ result: text });

  } catch (err) {
    console.error('Analyze error:', err);
    res.status(500).json({ message: 'Error interno al analizar', detail: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Servidor corriendo en puerto', PORT);
});
