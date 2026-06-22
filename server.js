const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const Database = require('better-sqlite3');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
  cors: { origin: "*" },
  transports: ['websocket', 'polling']
});

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ========== БАЗА ДАННЫХ (better-sqlite3) ==========
const db = new Database('/tmp/discord.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    password TEXT
  );

  CREATE TABLE IF NOT EXISTS servers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    owner_id INTEGER
  );

  CREATE TABLE IF NOT EXISTS channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    server_id INTEGER
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id INTEGER,
    user_id INTEGER,
    content TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS members (
    user_id INTEGER,
    server_id INTEGER,
    PRIMARY KEY (user_id, server_id)
  );
`);

console.log('✅ База данных готова');

const SECRET = 'supersecretkey';

// ========== РЕГИСТРАЦИЯ ==========
app.post('/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    const hash = await bcrypt.hash(password, 10);
    const stmt = db.prepare('INSERT INTO users (username, password) VALUES (?, ?)');
    const info = stmt.run(username, hash);
    res.json({ id: info.lastInsertRowid, username });
  } catch (error) {
    res.status(400).json({ error: 'Пользователь уже существует' });
  }
});

// ========== ЛОГИН ==========
app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const stmt = db.prepare('SELECT * FROM users WHERE username = ?');
  const user = stmt.get(username);
  
  if (!user || !(await bcrypt.compare(password, user.password))) {
    return res.status(401).json({ error: 'Неверный логин или пароль' });
  }
  
  const token = jwt.sign({ id: user.id, username: user.username }, SECRET);
  res.json({ token, user: { id: user.id, username: user.username } });
});

// ========== СЕРВЕРА ==========
app.get('/servers/:userId', (req, res) => {
  const stmt = db.prepare(`
    SELECT s.* FROM servers s
    JOIN members m ON m.server_id = s.id
    WHERE m.user_id = ?
  `);
  res.json(stmt.all(req.params.userId));
});

app.post('/servers', (req, res) => {
  const { name, owner_id } = req.body;
  try {
    const stmt = db.prepare('INSERT INTO servers (name, owner_id) VALUES (?, ?)');
    const info = stmt.run(name, owner_id);
    const serverId = info.lastInsertRowid;
    
    db.prepare('INSERT INTO members (user_id, server_id) VALUES (?, ?)').run(owner_id, serverId);
    db.prepare('INSERT INTO channels (name, server_id) VALUES (?, ?)').run('general', serverId);
    
    res.json({ id: serverId, name });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// ========== КАНАЛЫ ==========
app.get('/channels/:serverId', (req, res) => {
  const stmt = db.prepare('SELECT * FROM channels WHERE server_id = ?');
  res.json(stmt.all(req.params.serverId));
});

// ========== СООБЩЕНИЯ ==========
app.get('/messages/:channelId', (req, res) => {
  const stmt = db.prepare(`
    SELECT m.*, u.username 
    FROM messages m
    JOIN users u ON u.id = m.user_id
    WHERE m.channel_id = ?
    ORDER BY m.timestamp ASC LIMIT 100
  `);
  res.json(stmt.all(req.params.channelId));
});

// ========== ПОИСК ==========
app.get('/users/search', (req, res) => {
  const { q } = req.query;
  const stmt = db.prepare('SELECT id, username FROM users WHERE username LIKE ? LIMIT 10');
  res.json(stmt.all(`%${q}%`));
});

// ========== SOCKET.IO ==========
const onlineUsers = {};

io.on('connection', (socket) => {
  console.log('👤 Подключился:', socket.id);

  socket.on('join', ({ userId, username }) => {
    onlineUsers[socket.id] = { userId, username };
    io.emit('users', Object.values(onlineUsers));
  });

  socket.on('join-server', (serverId) => {
    socket.join(`server-${serverId}`);
  });

  socket.on('join-channel', (channelId) => {
    socket.join(`channel-${channelId}`);
  });

  socket.on('message', (data) => {
    const { channelId, userId, content } = data;
    try {
      const stmt = db.prepare('INSERT INTO messages (channel_id, user_id, content) VALUES (?, ?, ?)');
      const info = stmt.run(channelId, userId, content);
      
      const msgStmt = db.prepare(`
        SELECT m.*, u.username 
        FROM messages m
        JOIN users u ON u.id = m.user_id
        WHERE m.id = ?
      `);
      const msg = msgStmt.get(info.lastInsertRowid);
      io.to(`channel-${channelId}`).emit('message', msg);
    } catch (error) {
      console.error('Ошибка:', error);
    }
  });

  socket.on('signal', (data) => {
    socket.to(data.to).emit('signal', {
      from: socket.id,
      signal: data.signal
    });
  });

  socket.on('disconnect', () => {
    delete onlineUsers[socket.id];
    io.emit('users', Object.values(onlineUsers));
  });
});

// ====== ОТДАЕМ HTML ДЛЯ ЛЮБОГО МАРШРУТА (ДЛЯ ТЕЛЕФОНА) ======
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ========== ЗАПУСК ==========
const port = process.env.PORT || 3000;
server.listen(port, '0.0.0.0', () => {
  console.log(`🚀 Сервер запущен на порту ${port}`);
});