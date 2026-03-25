const express = require('express');
const cors = require('cors');

const app = express();

app.use(cors());
app.use(express.json());

let users = [];

// REGISTER
app.post('/register', (req, res) => {
  const { name, email, password } = req.body;

  if(!email || !password){
    return res.status(400).json({ message: 'Faltan datos' });
  }

  const userExists = users.find(u => u.email === email);

  if(userExists){
    return res.status(400).json({ message: 'Usuario ya existe' });
  }

  const newUser = { name, email, password };
  users.push(newUser);

  res.json({ message: 'Usuario creado', user: newUser });
});

// LOGIN
app.post('/login', (req, res) => {
  const { email, password } = req.body;

  const user = users.find(u => u.email === email && u.password === password);

  if(!user){
    return res.status(401).json({ message: 'Credenciales incorrectas' });
  }

  res.json({ message: 'Login exitoso', user });
});

// TEST
app.get('/', (req, res) => {
  res.send('Backend funcionando 🔥');
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log('Servidor corriendo en puerto', PORT);
});
