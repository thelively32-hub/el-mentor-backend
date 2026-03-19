const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const cors = require('cors');
require('dotenv').config();

const app = express();

// Allow ALL origins
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json({ limit: '50mb' }));

app.get('/', (req, res) => {
  res.json({ status: 'El Mentor Backend activo', version: '2.1.0' });
});

app.post('/transcribe', async (req, res) => {
  try {
    const { audioBase64, mimeType, filename } = req.body;
    if (!audioBase64) return res.status(400).json({ error: 'No se recibió audio' });

    const audioBuffer = Buffer.from(audioBase64, 'base64');
    const formData = new FormData();
    formData.append('file', audioBuffer, {
      filename: filename || 'audio.mp3',
      contentType: mimeType || 'audio/mpeg',
    });
    formData.append('model', 'whisper-1');
    formData.append('response_format', 'verbose_json');
    formData.append('language', 'es');

    const response = await axios.post(
      'https://api.openai.com/v1/audio/transcriptions',
      formData,
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_KEY}`,
          ...formData.getHeaders(),
        },
        maxBodyLength: Infinity,
      }
    );

    const { text, duration, language } = response.data;
    res.json({ text, duration, language });

  } catch (err) {
    console.error('Whisper error:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.error?.message || err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`El Mentor Backend v2.1 corriendo en puerto ${PORT}`));

app.get('/', (req, res) => {
  res.json({ status: 'El Mentor Backend activo', version: '2.0.0' });
});

// Accepts base64 audio — works from sandboxed iframes
app.post('/transcribe', async (req, res) => {
  try {
    const { audioBase64, mimeType, filename } = req.body;

    if (!audioBase64) {
      return res.status(400).json({ error: 'No se recibió audio' });
    }

    const audioBuffer = Buffer.from(audioBase64, 'base64');
    const formData = new FormData();
    formData.append('file', audioBuffer, {
      filename: filename || 'audio.mp3',
      contentType: mimeType || 'audio/mpeg',
    });
    formData.append('model', 'whisper-1');
    formData.append('response_format', 'verbose_json');
    formData.append('language', 'es');

    const response = await axios.post(
      'https://api.openai.com/v1/audio/transcriptions',
      formData,
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_KEY}`,
          ...formData.getHeaders(),
        },
        maxBodyLength: Infinity,
      }
    );

    const { text, duration, language } = response.data;
    res.json({ text, duration, language });

  } catch (err) {
    console.error('Whisper error:', err.response?.data || err.message);
    res.status(500).json({
      error: err.response?.data?.error?.message || err.message
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`El Mentor Backend v2 corriendo en puerto ${PORT}`);
});
