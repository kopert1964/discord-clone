const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
const DATA_DIR = path.join(__dirname, 'data');

// Создаём папки для данных
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(path.join(__dirname, 'public', 'uploads'))) {
  fs.mkdirSync(path.join(__dirname, 'public', 'uploads'), { recursive: true });
}

// Файлы данных
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const CHANNELS_FILE = path.join(DATA_DIR, 'channels.json');
const MESSAGES_FILE = path.join(DATA_DIR, 'messages.json');
const VOICE_FILE = path.join(DATA_DIR, 'voice.json');

// Загружаем данные из файлов
let users = loadJSON(USERS_FILE, []);
let channels = loadJSON(CHANNELS_FILE, [
  { id: 'general', name: '📢 Основной', createdBy: 'system', createdAt: Date.now() },
  { id: 'random', name: '🎲 Флудилка', createdBy: 'system', createdAt: Date.now() }
]);
let messages = loadJSON(MESSAGES_FILE, []);
let voiceChannels = loadJSON(VOICE_FILE, [
  { id: 'voice-general', name: '🔊 Общий', users: [] },
  { id: 'voice-gaming', name: '🎮 Игры', users: [] }
]);
let directMessages = {};

function loadJSON(file, defaultData) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) { console.error('Ошибка загрузки:', file, e); }
  return defaultData;
}

function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// Хранилище онлайн-пользователей
const onlineUsers = new Map(); // socket.id -> { userId, username, status }

// ==================== MIDDLEWARE ====================
app.use(express.static('public'));
app.use(express.json());

// Multer для загрузки аватарок
const storage = multer.diskStorage({
  destination: path.join(__dirname, 'public', 'uploads'),
  filename: (req, file, cb) => cb(null, uuidv4() + path.extname(file.originalname))
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } }); // 5MB

// ==================== AUTH ROUTES ====================

// Регистрация
app.post('/api/register', async (req, res) => {
  const { username, email, password } = req.body;
  
  if (!username || !email || !password) {
    return res.status(400).json({ error: 'Все поля обязательны' });
  }
  
  if (users.find(u => u.email === email)) {
    return res.status(400).json({ error: 'Email уже занят' });
  }
  
  if (users.find(u => u.username === username)) {
    return res.status(400).json({ error: 'Ник уже занят' });
  }
  
  const hashedPassword = await bcrypt.hash(password, 10);
  const user = {
    id: uuidv4(),
    username,
    email,
    password: hashedPassword,
    avatar: null,
    status: 'online',
    createdAt: Date.now()
  };
  
  users.push(user);
  saveJSON(USERS_FILE, users);
  
  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id: user.id, username: user.username, avatar: user.avatar, status: user.status } });
});

// Вход
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  
  const user = users.find(u => u.email === email);
  if (!user) return res.status(400).json({ error: 'Неверный email или пароль' });
  
  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.status(400).json({ error: 'Неверный email или пароль' });
  
  user.status = 'online';
  saveJSON(USERS_FILE, users);
  
  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id: user.id, username: user.username, avatar: user.avatar, status: user.status } });
});

// Проверка токена
app.get('/api/me', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Нет токена' });
  
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = users.find(u => u.id === decoded.id);
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    
    res.json({ user: { id: user.id, username: user.username, avatar: user.avatar, status: user.status } });
  } catch (e) {
    res.status(401).json({ error: 'Неверный токен' });
  }
});

// Загрузка аватарки
app.post('/api/avatar', upload.single('avatar'), (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Нет токена' });
  
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = users.find(u => u.id === decoded.id);
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    
    user.avatar = '/uploads/' + req.file.filename;
    saveJSON(USERS_FILE, users);
    
    io.emit('user-updated', { id: user.id, avatar: user.avatar, username: user.username, status: user.status });
    res.json({ avatar: user.avatar });
  } catch (e) {
    res.status(401).json({ error: 'Неверный токен' });
  }
});

// Получить список пользователей
app.get('/api/users', (req, res) => {
  const usersList = users.map(u => ({ id: u.id, username: u.username, avatar: u.avatar, status: u.status }));
  res.json(usersList);
});

// Получить каналы
app.get('/api/channels', (req, res) => {
  res.json(channels);
});

// Создать канал
app.post('/api/channels', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Нет токена' });
  
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Название обязательно' });
    
    const channel = { id: uuidv4(), name, createdBy: decoded.username, createdAt: Date.now() };
    channels.push(channel);
    saveJSON(CHANNELS_FILE, channels);
    
    io.emit('channel-created', channel);
    res.json(channel);
  } catch (e) {
    res.status(401).json({ error: 'Неверный токен' });
  }
});

// Получить сообщения канала
app.get('/api/messages/:channelId', (req, res) => {
  const channelMessages = messages.filter(m => m.channelId === req.params.channelId);
  res.json(channelMessages.slice(-100)); // последние 100 сообщений
});

// Получить голосовые каналы
app.get('/api/voice-channels', (req, res) => {
  res.json(voiceChannels.map(vc => ({ id: vc.id, name: vc.name, userCount: vc.users.length })));
});

// Получить ЛС между двумя пользователями
app.get('/api/dm/:userId', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Нет токена' });
  
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const dmKey = [decoded.id, req.params.userId].sort().join('-');
    res.json(directMessages[dmKey] || []);
  } catch(e) {
    res.status(401).json({ error: 'Неверный токен' });
  }
});

// ==================== SOCKET.IO ====================
io.on('connection', (socket) => {
  console.log('🔌 Подключён:', socket.id);
  let currentUser = null;
  
  // Аутентификация через сокет
  socket.on('auth', ({ token }) => {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      const user = users.find(u => u.id === decoded.id);
      if (user) {
        currentUser = user;
        onlineUsers.set(socket.id, { userId: user.id, username: user.username, status: 'online' });
        
        user.status = 'online';
        saveJSON(USERS_FILE, users);
        
        io.emit('user-status', { id: user.id, status: 'online' });
        console.log(`✅ ${user.username} вошёл`);
      }
    } catch (e) {
      console.log('❌ Неверный токен сокета');
    }
  });
  
  // Отправка сообщения
  socket.on('send-message', ({ channelId, text }) => {
    if (!currentUser || !text?.trim()) return;
    
    const message = {
      id: uuidv4(),
      channelId,
      userId: currentUser.id,
      username: currentUser.username,
      avatar: currentUser.avatar,
      text: text.trim(),
      edited: false,
      createdAt: Date.now()
    };
    
    messages.push(message);
    if (messages.length > 10000) messages = messages.slice(-5000);
    saveJSON(MESSAGES_FILE, messages);
    
    io.emit('new-message', message);
  });
  
  // Редактирование сообщения
  socket.on('edit-message', ({ messageId, text }) => {
    const msg = messages.find(m => m.id === messageId && m.userId === currentUser?.id);
    if (msg && text?.trim()) {
      msg.text = text.trim();
      msg.edited = true;
      saveJSON(MESSAGES_FILE, messages);
      io.emit('message-edited', { messageId, text: msg.text, edited: true });
    }
  });
  
  // Удаление сообщения
  socket.on('delete-message', ({ messageId }) => {
    const msg = messages.find(m => m.id === messageId && m.userId === currentUser?.id);
    if (msg) {
      messages = messages.filter(m => m.id !== messageId);
      saveJSON(MESSAGES_FILE, messages);
      io.emit('message-deleted', { messageId });
    }
  });
  
  // Смена статуса
  socket.on('set-status', ({ status }) => {
    if (!currentUser) return;
    currentUser.status = status;
    saveJSON(USERS_FILE, users);
    io.emit('user-status', { id: currentUser.id, status });
  });
  
  // Присоединиться к голосовому каналу
  socket.on('join-voice', ({ channelId }) => {
    if (!currentUser) return;
    
    leaveAllVoiceChannels(socket);
    
    const vc = voiceChannels.find(c => c.id === channelId);
    if (vc && !vc.users.find(u => u.userId === currentUser.id)) {
      vc.users.push({ userId: currentUser.id, username: currentUser.username });
      socket.join('voice-' + channelId);
      socket.currentVoiceChannel = channelId;
      
      saveJSON(VOICE_FILE, voiceChannels);
      io.emit('voice-users-update', { channelId, users: vc.users });
      socket.to('voice-' + channelId).emit('user-joined-voice', { userId: currentUser.id, username: currentUser.username });
    }
  });
  
  // Выйти из голосового канала
  socket.on('leave-voice', () => {
    leaveAllVoiceChannels(socket);
  });
  
  function leaveAllVoiceChannels(socket) {
    voiceChannels.forEach(vc => {
      const idx = vc.users.findIndex(u => u.userId === currentUser?.id);
      if (idx !== -1) {
        vc.users.splice(idx, 1);
        socket.leave('voice-' + vc.id);
        io.emit('voice-users-update', { channelId: vc.id, users: vc.users });
        socket.to('voice-' + vc.id).emit('user-left-voice', { userId: currentUser?.id });
      }
    });
    socket.currentVoiceChannel = null;
    saveJSON(VOICE_FILE, voiceChannels);
  }
  
  // WebRTC для голосовых каналов
  socket.on('voice-offer', ({ channelId, offer }) => {
    socket.to('voice-' + channelId).emit('voice-offer', { from: currentUser?.id, offer });
  });
  
  socket.on('voice-answer', ({ channelId, to, answer }) => {
    const target = findSocketByUserId(to);
    if (target) target.emit('voice-answer', { from: currentUser?.id, answer });
  });
  
  socket.on('voice-ice', ({ channelId, to, candidate }) => {
    const target = findSocketByUserId(to);
    if (target) target.emit('voice-ice', { from: currentUser?.id, candidate });
  });
  
  // ЛС сообщения
  socket.on('send-dm', ({ to, text }) => {
    if (!currentUser || !text?.trim()) return;
    
    const dmKey = [currentUser.id, to].sort().join('-');
    if (!directMessages[dmKey]) directMessages[dmKey] = [];
    
    const message = {
      id: uuidv4(),
      userId: currentUser.id,
      username: currentUser.username,
      avatar: currentUser.avatar,
      text: text.trim(),
      createdAt: Date.now()
    };
    
    directMessages[dmKey].push(message);
    
    const target = findSocketByUserId(to);
    if (target) target.emit('new-dm', { from: currentUser.id, message });
    socket.emit('new-dm', { from: currentUser.id, message });
  });
  
  // ==================== ЗВОНКИ 1-на-1 ====================
  socket.on('call-offer', ({ to, offer }) => {
    const targetSocket = findSocketByUserId(to);
    if (targetSocket) {
      targetSocket.emit('call-offer', { from: currentUser?.id, offer, callerName: currentUser?.username });
    }
  });
  
  socket.on('call-answer', ({ to, answer }) => {
    const targetSocket = findSocketByUserId(to);
    if (targetSocket) targetSocket.emit('call-answer', { from: currentUser?.id, answer });
  });
  
  socket.on('call-ice', ({ to, candidate }) => {
    const targetSocket = findSocketByUserId(to);
    if (targetSocket) targetSocket.emit('call-ice', { from: currentUser?.id, candidate });
  });
  
  socket.on('call-accept', ({ to }) => {
    const targetSocket = findSocketByUserId(to);
    if (targetSocket) targetSocket.emit('call-accepted', { from: currentUser?.id });
  });
  
  socket.on('call-reject', ({ to }) => {
    const targetSocket = findSocketByUserId(to);
    if (targetSocket) targetSocket.emit('call-rejected', { from: currentUser?.id });
  });
  
  socket.on('call-end', ({ to }) => {
    const targetSocket = findSocketByUserId(to);
    if (targetSocket) targetSocket.emit('call-ended', { from: currentUser?.id });
  });
  
  function findSocketByUserId(userId) {
    for (let [sid, data] of onlineUsers) {
      if (data.userId === userId) return io.sockets.sockets.get(sid);
    }
    return null;
  }
  
  // Отключение
  socket.on('disconnect', () => {
    leaveAllVoiceChannels(socket);
    console.log('🔌 Отключён:', socket.id);
    if (currentUser) {
      currentUser.status = 'offline';
      saveJSON(USERS_FILE, users);
      onlineUsers.delete(socket.id);
      io.emit('user-status', { id: currentUser.id, status: 'offline' });
    }
  });
});

server.listen(PORT, () => {
  console.log(`🚀 Сервер на порту ${PORT}`);
});