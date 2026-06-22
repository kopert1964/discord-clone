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

// ========== БАЗА ДАННЫХ ==========
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

  -- НОВЫЕ ТАБЛИЦЫ ДЛЯ ДРУЗЕЙ
  CREATE TABLE IF NOT EXISTS friends (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    friend_id INTEGER,
    status TEXT DEFAULT 'pending', -- pending, accepted, blocked
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, friend_id)
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

// ========== ПОИСК ПОЛЬЗОВАТЕЛЕЙ ==========
app.get('/users/search', (req, res) => {
  const { q } = req.query;
  const stmt = db.prepare('SELECT id, username FROM users WHERE username LIKE ? LIMIT 10');
  res.json(stmt.all(`%${q}%`));
});

// ========== ОТПРАВИТЬ ЗАЯВКУ В ДРУЗЬЯ ==========
app.post('/friends/request', (req, res) => {
  const { userId, friendId } = req.body;
  try {
    const stmt = db.prepare('INSERT INTO friends (user_id, friend_id, status) VALUES (?, ?, ?)');
    stmt.run(userId, friendId, 'pending');
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ error: 'Заявка уже отправлена' });
  }
});

// ========== ПРИНЯТЬ ЗАЯВКУ ==========
app.post('/friends/accept', (req, res) => {
  const { userId, friendId } = req.body;
  const stmt = db.prepare('UPDATE friends SET status = "accepted" WHERE user_id = ? AND friend_id = ?');
  stmt.run(friendId, userId);
  res.json({ success: true });
});

// ========== ПОЛУЧИТЬ СПИСОК ДРУЗЕЙ ==========
app.get('/friends/:userId', (req, res) => {
  const stmt = db.prepare(`
    SELECT u.id, u.username, f.status 
    FROM friends f
    JOIN users u ON (u.id = f.friend_id OR u.id = f.user_id)
    WHERE (f.user_id = ? OR f.friend_id = ?) AND f.status = 'accepted' AND u.id != ?
  `);
  res.json(stmt.all(req.params.userId, req.params.userId, req.params.userId));
});

// ========== ПОЛУЧИТЬ ЗАЯВКИ ==========
app.get('/friends/requests/:userId', (req, res) => {
  const stmt = db.prepare(`
    SELECT u.id, u.username 
    FROM friends f
    JOIN users u ON u.id = f.user_id
    WHERE f.friend_id = ? AND f.status = 'pending'
  `);
  res.json(stmt.all(req.params.userId));
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

// ========== SOCKET.IO ==========
const onlineUsers = {};

io.on('connection', (socket) => {
  console.log('👤 Подключился:', socket.id);

  socket.on('join', ({ userId, username }) => {
    onlineUsers[socket.id] = { userId, username, socketId: socket.id };
    io.emit('users', Object.values(onlineUsers));
    console.log(`✅ ${username} онлайн`);
  });

  socket.on('join-server', (serverId) => {
    socket.join(`server-${serverId}`);
  });

  socket.on('join-channel', (channelId) => {
    socket.join(`channel-${channelId}`);
  });

  // ====== СООБЩЕНИЯ ======
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

  // ====== ВЕБРТК СИГНАЛИНГ (для звонков) ======
  socket.on('call-user', (data) => {
    const { to, signal } = data;
    // Отправляем сигнал конкретному пользователю
    io.to(to).emit('incoming-call', {
      from: socket.id,
      fromUsername: onlineUsers[socket.id]?.username,
      signal
    });
  });

  socket.on('answer-call', (data) => {
    const { to, signal } = data;
    io.to(to).emit('call-answered', {
      signal
    });
  });

  socket.on('ice-candidate', (data) => {
    const { to, candidate } = data;
    io.to(to).emit('ice-candidate', {
      from: socket.id,
      candidate
    });
  });

  socket.on('end-call', (data) => {
    const { to } = data;
    io.to(to).emit('call-ended');
  });

  socket.on('disconnect', () => {
    const user = onlineUsers[socket.id];
    if (user) {
      console.log(`❌ ${user.username} вышел`);
    }
    delete onlineUsers[socket.id];
    io.emit('users', Object.values(onlineUsers));
  });
});

// ====== ОТДАЕМ HTML ДЛЯ ЛЮБОГО МАРШРУТА ======
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ========== ЗАПУСК ==========
const port = process.env.PORT || 3000;
server.listen(port, '0.0.0.0', () => {
  console.log(`🚀 Сервер запущен на порту ${port}`);
});