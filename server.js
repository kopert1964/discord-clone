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
    owner_id INTEGER,
    invite_code TEXT UNIQUE
  );

  CREATE TABLE IF NOT EXISTS channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    server_id INTEGER,
    is_public INTEGER DEFAULT 1
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
  
  const token = jwt.sign({ id: user.id, username: user.username }, SECRET);
  res.json({ token, user: { id: user.id, username: user.username } });
});

// ========== СЕРВЕРА С ИНВАЙТ-КОДАМИ ==========
app.post('/servers', (req, res) => {
  const { name, owner_id } = req.body;
  try {
    const inviteCode = Math.random().toString(36).substring(2, 8).toUpperCase();
    const stmt = db.prepare('INSERT INTO servers (name, owner_id, invite_code) VALUES (?, ?, ?)');
    const info = stmt.run(name, owner_id, inviteCode);
    const serverId = info.lastInsertRowid;
    
    db.prepare('INSERT INTO members (user_id, server_id) VALUES (?, ?)').run(owner_id, serverId);
    db.prepare('INSERT INTO channels (name, server_id, is_public) VALUES (?, ?, ?)').run('general', serverId, 1);
    
    res.json({ id: serverId, name, invite_code: inviteCode });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/servers/:userId', (req, res) => {
  const stmt = db.prepare(`
    SELECT s.* FROM servers s
    JOIN members m ON m.server_id = s.id
    WHERE m.user_id = ?
  `);
  res.json(stmt.all(req.params.userId));
});

app.get('/servers/search/:query', (req, res) => {
  const stmt = db.prepare(`
    SELECT s.* FROM servers s
    WHERE s.name LIKE ? AND s.is_public = 1
    LIMIT 20
  `);
  res.json(stmt.all(`%${req.params.query}%`));
});

app.post('/servers/join', (req, res) => {
  const { invite_code, user_id } = req.body;
  try {
    const stmt = db.prepare('SELECT id FROM servers WHERE invite_code = ?');
    const server = stmt.get(invite_code);
    if (!server) {
      return res.status(404).json({ error: 'Сервер не найден' });
    }
    
    db.prepare('INSERT OR IGNORE INTO members (user_id, server_id) VALUES (?, ?)')
      .run(user_id, server.id);
    res.json({ success: true, server_id: server.id });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/servers/invite/:serverId', (req, res) => {
  const stmt = db.prepare('SELECT invite_code FROM servers WHERE id = ?');
  const server = stmt.get(req.params.serverId);
  if (server) {
    res.json({ invite_code: server.invite_code });
  } else {
    res.status(404).json({ error: 'Сервер не найден' });
  }
});

// ========== КАНАЛЫ ==========
app.get('/channels/:serverId', (req, res) => {
  const stmt = db.prepare('SELECT * FROM channels WHERE server_id = ?');
  res.json(stmt.all(req.params.serverId));
});

app.post('/channels', (req, res) => {
  const { name, server_id, is_public } = req.body;
  try {
    const stmt = db.prepare('INSERT INTO channels (name, server_id, is_public) VALUES (?, ?, ?)');
    const info = stmt.run(name, server_id, is_public || 1);
    res.json({ id: info.lastInsertRowid, name, server_id, is_public: is_public || 1 });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
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

// ========== ДРУЗЬЯ ==========
app.get('/users/search', (req, res) => {
  const { q } = req.query;
  const stmt = db.prepare('SELECT id, username FROM users WHERE username LIKE ? LIMIT 10');
  res.json(stmt.all(`%${q}%`));
});

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

app.post('/friends/accept', (req, res) => {
  const { userId, friendId } = req.body;
  const stmt = db.prepare('UPDATE friends SET status = "accepted" WHERE user_id = ? AND friend_id = ?');
  stmt.run(friendId, userId);
  res.json({ success: true });
});

app.get('/friends/:userId', (req, res) => {
  const stmt = db.prepare(`
    SELECT u.id, u.username, f.status 
    FROM friends f
    JOIN users u ON (u.id = f.friend_id OR u.id = f.user_id)
    WHERE (f.user_id = ? OR f.friend_id = ?) AND f.status = 'accepted' AND u.id != ?
  `);
  res.json(stmt.all(req.params.userId, req.params.userId, req.params.userId));
});

app.get('/friends/requests/:userId', (req, res) => {
  const stmt = db.prepare(`
    SELECT u.id, u.username 
    FROM friends f
    JOIN users u ON u.id = f.user_id
    WHERE f.friend_id = ? AND f.status = 'pending'
  `);
  res.json(stmt.all(req.params.userId));
});

// ========== ЛИЧНЫЕ СООБЩЕНИЯ ==========
app.post('/private/message', (req, res) => {
  const { from_user, to_user, content } = req.body;
  try {
    const stmt = db.prepare('INSERT INTO private_messages (from_user, to_user, content) VALUES (?, ?, ?)');
    const info = stmt.run(from_user, to_user, content);
    res.json({ id: info.lastInsertRowid });
  } catch (error) {
    res.status(400).json({ error: 'Ошибка отправки' });
  }
});

app.get('/private/messages/:userId/:friendId', (req, res) => {
  const stmt = db.prepare(`
    SELECT * FROM private_messages 
    WHERE (from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?)
    ORDER BY timestamp ASC LIMIT 100
  `);
  res.json(stmt.all(
    req.params.userId, req.params.friendId,
    req.params.friendId, req.params.userId
  ));
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

  socket.on('private-message', (data) => {
    const { from_user, to_user, content, to_socket_id } = data;
    try {
      const stmt = db.prepare('INSERT INTO private_messages (from_user, to_user, content) VALUES (?, ?, ?)');
      const info = stmt.run(from_user, to_user, content);
      
      const msgStmt = db.prepare(`SELECT * FROM private_messages WHERE id = ?`);
      const msg = msgStmt.get(info.lastInsertRowid);
      
      if (to_socket_id) {
        io.to(to_socket_id).emit('private-message', { ...msg, from_user, to_user });
      }
      socket.emit('private-message-sent', msg);
    } catch (error) {
      console.error('Ошибка личного сообщения:', error);
    }
  });

  // ===== ИСПРАВЛЕННЫЙ ВЕБРТК =====
  socket.on('call-user', (data) => {
    const { to, signal, fromUsername } = data;
    const caller = onlineUsers[socket.id];
    if (caller && onlineUsers[to]) {
      io.to(to).emit('incoming-call', {
        from: socket.id,
        fromUserId: caller.userId,
        fromUsername: fromUsername || caller.username,
        signal
      });
    } else {
      socket.emit('call-failed', { reason: 'Пользователь не в сети' });
    }
  });

  socket.on('answer-call', (data) => {
    const { to, signal } = data;
    if (onlineUsers[to]) {
      io.to(to).emit('call-answered', { signal });
    }
  });

  socket.on('ice-candidate', (data) => {
    const { to, candidate } = data;
    if (onlineUsers[to]) {
      io.to(to).emit('ice-candidate', { from: socket.id, candidate });
    }
  });

  socket.on('end-call', (data) => {
    const { to } = data;
    if (onlineUsers[to]) {
      io.to(to).emit('call-ended');
    }
  });

  socket.on('voice-activity', (data) => {
    const { to, isSpeaking } = data;
    if (onlineUsers[to]) {
      io.to(to).emit('voice-activity', { from: socket.id, isSpeaking });
    }
  });

  socket.on('disconnect', () => {
    const user = onlineUsers[socket.id];
    if (user) console.log(`❌ ${user.username} вышел`);
    delete onlineUsers[socket.id];
    io.emit('users', Object.values(onlineUsers));
  });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const port = process.env.PORT || 3000;
server.listen(port, '0.0.0.0', () => {
  console.log(`🚀 Сервер запущен на порту ${port}`);
});