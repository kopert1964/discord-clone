const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');

const PORT = process.env.PORT || 3000;

// ========== MIDDLEWARE ==========
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ========== БАЗА ДАННЫХ ==========
const db = new Database('/tmp/discord.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    password TEXT,
    last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
    is_online INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS servers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    owner_id INTEGER,
    invite_code TEXT UNIQUE,
    is_public INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    server_id INTEGER,
    is_public INTEGER DEFAULT 1,
    is_voice INTEGER DEFAULT 0
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

  CREATE TABLE IF NOT EXISTS friends (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    friend_id INTEGER,
    status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, friend_id)
  );

  CREATE TABLE IF NOT EXISTS private_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_user INTEGER,
    to_user INTEGER,
    content TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    read INTEGER DEFAULT 0
  );
`);

console.log('✅ База данных готова');

const SECRET = 'supersecretkey';

// ========== АУТЕНТИФИКАЦИЯ ==========
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

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const stmt = db.prepare('SELECT * FROM users WHERE username = ?');
  const user = stmt.get(username);
  
  if (!user || !(await bcrypt.compare(password, user.password))) {
    return res.status(401).json({ error: 'Неверный логин или пароль' });
  }
  
  db.prepare('UPDATE users SET is_online = 1, last_seen = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);
  
  const token = jwt.sign({ id: user.id, username: user.username }, SECRET);
  res.json({ token, user: { id: user.id, username: user.username } });
});

// ========== СЕРВЕРА ==========
app.post('/servers', (req, res) => {
  const { name, owner_id } = req.body;
  try {
    const inviteCode = Math.random().toString(36).substring(2, 8).toUpperCase();
    const stmt = db.prepare('INSERT INTO servers (name, owner_id, invite_code) VALUES (?, ?, ?)');
    const info = stmt.run(name, owner_id, inviteCode);
    const serverId = info.lastInsertRowid;
    
    db.prepare('INSERT INTO members (user_id, server_id) VALUES (?, ?)').run(owner_id, serverId);
    db.prepare('INSERT INTO channels (name, server_id, is_public, is_voice) VALUES (?, ?, ?, ?)').run('💬-общий', serverId, 1, 0);
    db.prepare('INSERT INTO channels (name, server_id, is_public, is_voice) VALUES (?, ?, ?, ?)').run('🔊-Голосовой', serverId, 1, 1);
    
    res.json({ id: serverId, name, invite_code: inviteCode });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/servers/:userId', (req, res) => {
  const stmt = db.prepare(`SELECT s.* FROM servers s JOIN members m ON m.server_id = s.id WHERE m.user_id = ?`);
  res.json(stmt.all(req.params.userId));
});

app.get('/servers/search/:query', (req, res) => {
  const stmt = db.prepare(`SELECT s.* FROM servers s WHERE s.name LIKE ? AND s.is_public = 1 LIMIT 20`);
  res.json(stmt.all(`%${req.params.query}%`));
});

app.post('/servers/join', (req, res) => {
  const { invite_code, user_id } = req.body;
  try {
    const stmt = db.prepare('SELECT id FROM servers WHERE invite_code = ?');
    const server = stmt.get(invite_code);
    if (!server) return res.status(404).json({ error: 'Сервер не найден' });
    
    db.prepare('INSERT OR IGNORE INTO members (user_id, server_id) VALUES (?, ?)').run(user_id, server.id);
    res.json({ success: true, server_id: server.id });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// ========== КАНАЛЫ ==========
app.get('/channels/:serverId', (req, res) => {
  const stmt = db.prepare('SELECT * FROM channels WHERE server_id = ?');
  res.json(stmt.all(req.params.serverId));
});

app.post('/channels', (req, res) => {
  const { name, server_id, is_public, is_voice } = req.body;
  try {
    const stmt = db.prepare('INSERT INTO channels (name, server_id, is_public, is_voice) VALUES (?, ?, ?, ?)');
    const info = stmt.run(name, server_id, is_public || 1, is_voice || 0);
    res.json({ id: info.lastInsertRowid, name, server_id });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// ========== СООБЩЕНИЯ ==========
app.get('/messages/:channelId', (req, res) => {
  const stmt = db.prepare(`SELECT m.*, u.username FROM messages m JOIN users u ON u.id = m.user_id WHERE m.channel_id = ? ORDER BY m.timestamp ASC LIMIT 100`);
  res.json(stmt.all(req.params.channelId));
});

// ========== ДРУЗЬЯ ==========
app.get('/users/search', (req, res) => {
  const { q } = req.query;
  const stmt = db.prepare('SELECT id, username, is_online, last_seen FROM users WHERE username LIKE ? LIMIT 10');
  res.json(stmt.all(`%${q}%`));
});

app.post('/friends/request', (req, res) => {
  const { userId, friendId } = req.body;
  try {
    db.prepare('INSERT INTO friends (user_id, friend_id, status) VALUES (?, ?, ?)').run(userId, friendId, 'pending');
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ error: 'Заявка уже отправлена' });
  }
});

app.post('/friends/accept', (req, res) => {
  const { userId, friendId } = req.body;
  db.prepare('UPDATE friends SET status = "accepted" WHERE user_id = ? AND friend_id = ?').run(friendId, userId);
  res.json({ success: true });
});

app.get('/friends/:userId', (req, res) => {
  const stmt = db.prepare(`
    SELECT u.id, u.username, u.is_online, u.last_seen, f.status 
    FROM friends f
    JOIN users u ON (u.id = f.friend_id OR u.id = f.user_id)
    WHERE (f.user_id = ? OR f.friend_id = ?) AND f.status = 'accepted' AND u.id != ?
  `);
  res.json(stmt.all(req.params.userId, req.params.userId, req.params.userId));
});

app.get('/friends/requests/:userId', (req, res) => {
  const stmt = db.prepare(`SELECT u.id, u.username FROM friends f JOIN users u ON u.id = f.user_id WHERE f.friend_id = ? AND f.status = 'pending'`);
  res.json(stmt.all(req.params.userId));
});

// ========== ЛИЧНЫЕ СООБЩЕНИЯ ==========
app.post('/private/message', (req, res) => {
  const { from_user, to_user, content } = req.body;
  const info = db.prepare('INSERT INTO private_messages (from_user, to_user, content) VALUES (?, ?, ?)').run(from_user, to_user, content);
  res.json({ id: info.lastInsertRowid });
});

app.get('/private/messages/:userId/:friendId', (req, res) => {
  const stmt = db.prepare(`SELECT * FROM private_messages WHERE (from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?) ORDER BY timestamp ASC LIMIT 100`);
  res.json(stmt.all(req.params.userId, req.params.friendId, req.params.friendId, req.params.userId));
});

// ========== SOCKET.IO ==========
const onlineUsers = {};
const voiceRooms = {};

io.on('connection', (socket) => {
  console.log(`👤 Пользователь подключился: ${socket.id}`);

  // ========== БАЗОВЫЕ СОБЫТИЯ ==========
  socket.on('join', ({ userId, username }) => {
    onlineUsers[socket.id] = { userId, username, socketId: socket.id };
    db.prepare('UPDATE users SET is_online = 1, last_seen = CURRENT_TIMESTAMP WHERE id = ?').run(userId);
    io.emit('users', Object.values(onlineUsers));
    console.log(`✅ ${username} онлайн`);
  });

  socket.on('join-server', (serverId) => socket.join(`server-${serverId}`));
  socket.on('join-channel', (channelId) => socket.join(`channel-${channelId}`));

  // ========== СООБЩЕНИЯ ==========
  socket.on('message', (data) => {
    const { channelId, userId, content } = data;
    const info = db.prepare('INSERT INTO messages (channel_id, user_id, content) VALUES (?, ?, ?)').run(channelId, userId, content);
    const msg = db.prepare(`SELECT m.*, u.username FROM messages m JOIN users u ON u.id = m.user_id WHERE m.id = ?`).get(info.lastInsertRowid);
    io.to(`channel-${channelId}`).emit('message', msg);
  });

  socket.on('private-message', (data) => {
    const { from_user, to_user, content, to_socket_id } = data;
    const info = db.prepare('INSERT INTO private_messages (from_user, to_user, content) VALUES (?, ?, ?)').run(from_user, to_user, content);
    const msg = db.prepare(`SELECT * FROM private_messages WHERE id = ?`).get(info.lastInsertRowid);
    if (to_socket_id) io.to(to_socket_id).emit('private-message', { ...msg, from_user, to_user });
    socket.emit('private-message-sent', msg);
  });

  // ========== ИНДИКАТОР ПЕЧАТАЕТ ==========
  socket.on('typing-start', ({ channelId, username }) => {
    socket.to(`channel-${channelId}`).emit('user-typing', { username });
  });

  socket.on('typing-stop', ({ channelId }) => {
    socket.to(`channel-${channelId}`).emit('user-stop-typing');
  });

  // ========== ГОЛОСОВЫЕ КАНАЛЫ ==========
  socket.on('voice-join', ({ channelId, userId, username }) => {
    const roomName = `voice-${channelId}`;
    socket.join(roomName);
    if (!voiceRooms[roomName]) voiceRooms[roomName] = [];
    voiceRooms[roomName] = voiceRooms[roomName].filter(u => u.userId !== userId);
    voiceRooms[roomName].push({ userId, username, socketId: socket.id });
    io.to(roomName).emit('voice-users', voiceRooms[roomName]);
  });

  socket.on('voice-leave', ({ channelId, userId }) => {
    const roomName = `voice-${channelId}`;
    socket.leave(roomName);
    if (voiceRooms[roomName]) {
      voiceRooms[roomName] = voiceRooms[roomName].filter(u => u.userId !== userId);
      io.to(roomName).emit('voice-users', voiceRooms[roomName]);
      if (voiceRooms[roomName].length === 0) delete voiceRooms[roomName];
    }
  });

  // ========== СИГНАЛЫ ЗВОНКОВ (UI) ==========
  socket.on('call-user', ({ to, fromUsername }) => {
    io.to(to).emit('incoming-call', { from: socket.id, fromUsername });
  });

  socket.on('call-accept', ({ to }) => {
    io.to(to).emit('call-connected');
  });

  socket.on('call-reject', ({ to }) => {
    io.to(to).emit('call-rejected');
  });

  socket.on('call-end', ({ to }) => {
    io.to(to).emit('call-ended');
  });

  // ========== ИСПРАВЛЕННЫЙ WebRTC (ретранслятор через broadcast) ==========
  socket.on('webrtc-offer', (offer) => {
    console.log(`📤 Offer от ${socket.id}, пересылаю всем остальным`);
    socket.broadcast.emit('webrtc-offer', offer);
  });

  socket.on('webrtc-answer', (answer) => {
    console.log(`📤 Answer от ${socket.id}, пересылаю всем остальным`);
    socket.broadcast.emit('webrtc-answer', answer);
  });

  socket.on('webrtc-candidate', (candidate) => {
    socket.broadcast.emit('webrtc-candidate', candidate);
  });

  // ========== ОТКЛЮЧЕНИЕ ==========
  socket.on('disconnect', () => {
    const user = onlineUsers[socket.id];
    if (user) {
      console.log(`❌ ${user.username} вышел`);
      db.prepare('UPDATE users SET is_online = 0, last_seen = CURRENT_TIMESTAMP WHERE id = ?').run(user.userId);
      
      for (const roomName in voiceRooms) {
        voiceRooms[roomName] = voiceRooms[roomName].filter(u => u.userId !== user.userId);
        io.to(roomName).emit('voice-users', voiceRooms[roomName]);
        if (voiceRooms[roomName].length === 0) delete voiceRooms[roomName];
      }
    }
    delete onlineUsers[socket.id];
    io.emit('users', Object.values(onlineUsers));
  });
});

// ========== ОТДАЧА index.html ДЛЯ ВСЕХ МАРШРУТОВ ==========
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ========== ЗАПУСК ==========
http.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Сервер запущен на http://localhost:${PORT}`);
});