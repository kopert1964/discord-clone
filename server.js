const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = socketIO(server, { 
  cors: { origin: "*" },
  transports: ['websocket', 'polling']
});

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// === БД (исправлено для хостинга) ===
// Сохраняем БД в /tmp на Render/Railway
const dbPath = process.env.NODE_ENV === 'production' 
  ? '/tmp/discord.db' 
  : './discord.db';

// Убедимся, что папка /tmp существует
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new sqlite3.Database(dbPath);

// Создаем таблицы (с проверкой на существование)
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    password TEXT,
    avatar TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS servers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    owner_id INTEGER
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    server_id INTEGER,
    type TEXT DEFAULT 'text'
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id INTEGER,
    user_id INTEGER,
    content TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS members (
    user_id INTEGER,
    server_id INTEGER,
    PRIMARY KEY (user_id, server_id)
  )`);

  console.log('✅ База данных подключена');
});

const SECRET = process.env.JWT_SECRET || 'supersecretkey';

// === РЕГИСТРАЦИЯ ===
app.post('/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    const hash = await bcrypt.hash(password, 10);
    db.run('INSERT INTO users (username, password) VALUES (?, ?)', [username, hash], function(err) {
      if (err) {
        console.error('Ошибка регистрации:', err);
        return res.status(400).json({ error: 'User exists' });
      }
      res.json({ id: this.lastID, username });
    });
  } catch (error) {
    console.error('Ошибка:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// === ЛОГИН ===
app.post('/login', (req, res) => {
  const { username, password } = req.body;
  db.get('SELECT * FROM users WHERE username = ?', [username], async (err, user) => {
    if (err) {
      console.error('Ошибка логина:', err);
      return res.status(500).json({ error: 'Server error' });
    }
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const token = jwt.sign({ id: user.id, username: user.username }, SECRET);
    res.json({ token, user: { id: user.id, username: user.username } });
  });
});

// === ПОЛУЧИТЬ СЕРВЕРА ===
app.get('/servers/:userId', (req, res) => {
  db.all(`
    SELECT s.* FROM servers s
    JOIN members m ON m.server_id = s.id
    WHERE m.user_id = ?
  `, [req.params.userId], (err, rows) => {
    if (err) {
      console.error('Ошибка получения серверов:', err);
      return res.status(500).json({ error: 'Server error' });
    }
    res.json(rows || []);
  });
});

// === СОЗДАТЬ СЕРВЕР ===
app.post('/servers', (req, res) => {
  const { name, owner_id } = req.body;
  db.run('INSERT INTO servers (name, owner_id) VALUES (?, ?)', [name, owner_id], function(err) {
    if (err) {
      console.error('Ошибка создания сервера:', err);
      return res.status(400).json({ error: err.message });
    }
    const serverId = this.lastID;
    db.run('INSERT INTO members (user_id, server_id) VALUES (?, ?)', [owner_id, serverId]);
    db.run('INSERT INTO channels (name, server_id, type) VALUES (?, ?, ?)', ['general', serverId, 'text']);
    res.json({ id: serverId, name });
  });
});

// === ПОЛУЧИТЬ КАНАЛЫ ===
app.get('/channels/:serverId', (req, res) => {
  db.all('SELECT * FROM channels WHERE server_id = ?', [req.params.serverId], (err, rows) => {
    if (err) {
      console.error('Ошибка получения каналов:', err);
      return res.status(500).json({ error: 'Server error' });
    }
    res.json(rows || []);
  });
});

// === ПОЛУЧИТЬ СООБЩЕНИЯ ===
app.get('/messages/:channelId', (req, res) => {
  db.all(`
    SELECT m.*, u.username, u.avatar 
    FROM messages m
    JOIN users u ON u.id = m.user_id
    WHERE m.channel_id = ?
    ORDER BY m.timestamp ASC LIMIT 100
  `, [req.params.channelId], (err, rows) => {
    if (err) {
      console.error('Ошибка получения сообщений:', err);
      return res.status(500).json({ error: 'Server error' });
    }
    res.json(rows || []);
  });
});

// === ПОИСК ПОЛЬЗОВАТЕЛЕЙ ===
app.get('/users/search', (req, res) => {
  const { q } = req.query;
  db.all('SELECT id, username FROM users WHERE username LIKE ? LIMIT 10', [`%${q}%`], (err, rows) => {
    if (err) {
      console.error('Ошибка поиска:', err);
      return res.status(500).json({ error: 'Server error' });
    }
    res.json(rows || []);
  });
});

// === ПРИГЛАСИТЕЛЬНАЯ ССЫЛКА ===
app.get('/invite/:serverId', (req, res) => {
  const baseUrl = process.env.RENDER_URL || process.env.RAILWAY_URL || 'http://localhost:3000';
  res.json({ link: `${baseUrl}/join/${req.params.serverId}` });
});

// ======== SOCKET.IO ========
const users = {};

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('join', ({ userId, username }) => {
    users[socket.id] = { userId, username };
    io.emit('users', Object.values(users));
  });

  socket.on('join-server', (serverId) => {
    socket.join(`server-${serverId}`);
  });

  socket.on('join-channel', (channelId) => {
    socket.join(`channel-${channelId}`);
  });

  socket.on('message', (data) => {
    const { channelId, userId, content } = data;
    db.run('INSERT INTO messages (channel_id, user_id, content) VALUES (?, ?, ?)',
      [channelId, userId, content],
      function(err) {
        if (err) {
          console.error('Ошибка сохранения сообщения:', err);
          return;
        }
        db.get(`
          SELECT m.*, u.username, u.avatar 
          FROM messages m
          JOIN users u ON u.id = m.user_id
          WHERE m.id = ?
        `, [this.lastID], (err, msg) => {
          if (err) {
            console.error('Ошибка получения сообщения:', err);
            return;
          }
          io.to(`channel-${channelId}`).emit('message', msg);
        });
      }
    );
  });

  socket.on('signal', (data) => {
    socket.to(data.to).emit('signal', {
      from: socket.id,
      signal: data.signal
    });
  });

  socket.on('disconnect', () => {
    delete users[socket.id];
    io.emit('users', Object.values(users));
  });
});

// === ЗАПУСК СЕРВЕРА ===
const port = process.env.PORT || 3000;
server.listen(port, '0.0.0.0', () => {
  console.log(`🚀 Сервер запущен на порту ${port}`);
  console.log(`📍 База данных: ${dbPath}`);
  console.log(`🌐 Режим: ${process.env.NODE_ENV || 'development'}`);
});

// Обработка ошибок (чтобы сервер не падал)
process.on('uncaughtException', (err) => {
  console.error('Необработанная ошибка:', err);
});

process.on('unhandledRejection', (err) => {
  console.error('Необработанный reject:', err);
});