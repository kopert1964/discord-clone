// ... весь предыдущий код HTML до скрипта ...

<script>
// ========== ЭМОДЗИ ПАНЕЛЬ ==========
const EMOJI_LIST = ['😀','😂','😍','😎','🤔','😢','😡','👍','👎','🎉','🔥','❤️','💔','⭐','✨','💬','📞','🎤','🔊','🔇','✅','❌','➡️','⬅️','🙏','💪','🤝','👋','💻','📱','🎵','🎶','🎼','🎧','🎮','🎯','🎨','🎭'];

function toggleEmojiPicker() {
  const picker = document.getElementById('emoji-picker');
  if (picker.classList.contains('show')) {
    picker.classList.remove('show');
    return;
  }
  picker.innerHTML = EMOJI_LIST.map(e => `<span onclick="insertEmoji('${e}')">${e}</span>`).join('');
  picker.classList.add('show');
}

function insertEmoji(emoji) {
  const input = document.getElementById('message-input');
  input.value += emoji;
  input.focus();
  document.getElementById('emoji-picker').classList.remove('show');
}

// ========== ИНДИКАТОР ПЕЧАТАЕТ ==========
let typingTimeout = null;

function handleTyping() {
  const input = document.getElementById('message-input');
  if (input.value.trim() === '') {
    stopTyping();
    return;
  }
  
  if (typingTimeout) clearTimeout(typingTimeout);
  
  if (isPrivateChat && privateChatFriendId) {
    let targetSocketId = null;
    document.querySelectorAll('#users-list .online-user').forEach(el => {
      if (parseInt(el.dataset.userid) === privateChatFriendId) targetSocketId = el.dataset.socketid;
    });
    socket.emit('private-typing-start', { to_socket_id: targetSocketId, username: currentUser.username });
  } else if (currentChannel) {
    socket.emit('typing-start', { channelId: currentChannel, username: currentUser.username });
  }
  
  typingTimeout = setTimeout(stopTyping, 3000);
}

function stopTyping() {
  if (typingTimeout) clearTimeout(typingTimeout);
  
  if (isPrivateChat && privateChatFriendId) {
    let targetSocketId = null;
    document.querySelectorAll('#users-list .online-user').forEach(el => {
      if (parseInt(el.dataset.userid) === privateChatFriendId) targetSocketId = el.dataset.socketid;
    });
    socket.emit('private-typing-stop', { to_socket_id: targetSocketId });
  } else if (currentChannel) {
    socket.emit('typing-stop', { channelId: currentChannel });
  }
  
  hideTyping();
}

function showTyping(username) {
  const indicator = document.getElementById('typing-indicator');
  document.getElementById('typing-username').textContent = username || 'Кто-то';
  indicator.classList.add('active');
}

function hideTyping() {
  document.getElementById('typing-indicator').classList.remove('active');
}

// ========== ИНДИКАТОР ГОЛОСА ==========
function updateVoiceIndicator(element, stream) {
  if (!stream) return;
  
  try {
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    const source = audioCtx.createMediaStreamSource(stream);
    source.connect(analyser);
    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    
    const checkSpeaking = () => {
      analyser.getByteFrequencyData(dataArray);
      const average = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
      
      if (average > 20) {
        element.classList.add('speaking');
        element.classList.remove('silent');
      } else {
        element.classList.add('silent');
        element.classList.remove('speaking');
      }
      
      if (callInProgress || inVoiceChannel) {
        requestAnimationFrame(checkSpeaking);
      }
    };
    
    checkSpeaking();
  } catch (e) {
    console.error('Voice indicator error:', e);
  }
}

// ========== РЕГУЛЯТОР ГРОМКОСТИ ==========
function setRemoteVolume(value) {
  if (remoteAudioElement) {
    remoteAudioElement.volume = value / 100;
  }
}

// ========== ЗВОНКИ (ДОРАБОТАННЫЕ) ==========
async function startCall(socketId, username) {
  if (callInProgress) {
    alert('У вас уже активный звонок!');
    return;
  }
  if (socketId === socket.id) {
    alert('Нельзя позвонить самому себе!');
    return;
  }

  currentCallerId = socketId;
  currentCallerUsername = username;

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });

    callInProgress = true;
    socket.emit('call-user', { to: socketId, fromUsername: currentUser.username });
    showCallWindow('outgoing');
  } catch (e) {
    console.error('Call error:', e);
    alert('❌ Ошибка доступа к микрофону: ' + e.message);
    endCall();
  }
}

async function createOffer() {
  if (peerConnection) peerConnection.close();
  
  const config = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ]
  };
  
  peerConnection = new RTCPeerConnection(config);
  
  if (localStream) {
    localStream.getTracks().forEach(track => {
      peerConnection.addTrack(track, localStream);
    });
  }
  
  peerConnection.ontrack = (event) => {
    if (event.streams && event.streams[0]) {
      if (remoteAudioElement) {
        remoteAudioElement.srcObject = null;
        remoteAudioElement.remove();
      }
      
      remoteAudioElement = new Audio();
      remoteAudioElement.srcObject = event.streams[0];
      remoteAudioElement.autoplay = true;
      remoteAudioElement.volume = document.getElementById('remote-volume').value / 100;
      remoteAudioElement.play().catch(e => console.error('Audio play error:', e));
      
      // Обновляем индикатор голоса для входящего аудио
      const voiceIndicator = document.getElementById('call-voice-indicator');
      updateVoiceIndicator(voiceIndicator, event.streams[0]);
      
      startAudioVisualization(event.streams[0]);
    }
  };
  
  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('call-ice', { to: currentCallerId, candidate: event.candidate });
    }
  };
  
  peerConnection.onconnectionstatechange = () => {
    console.log('📡 Состояние соединения:', peerConnection.connectionState);
    if (peerConnection.connectionState === 'connected') {
      console.log('✅ WebRTC соединение установлено!');
    }
  };
  
  const offer = await peerConnection.createOffer({
    offerToReceiveAudio: true,
    offerToReceiveVideo: false
  });
  
  await peerConnection.setLocalDescription(offer);
  socket.emit('call-offer', { to: currentCallerId, offer });
  
  callInProgress = true;
  startTimer();
  showCallWindow('active');
}

async function handleOffer(from, offer) {
  if (peerConnection) peerConnection.close();
  
  const config = {
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
  };
  
  peerConnection = new RTCPeerConnection(config);
  
  if (localStream) {
    localStream.getTracks().forEach(track => {
      peerConnection.addTrack(track, localStream);
    });
  }
  
  peerConnection.ontrack = (event) => {
    if (event.streams && event.streams[0]) {
      if (remoteAudioElement) {
        remoteAudioElement.srcObject = null;
        remoteAudioElement.remove();
      }
      
      remoteAudioElement = new Audio();
      remoteAudioElement.srcObject = event.streams[0];
      remoteAudioElement.autoplay = true;
      remoteAudioElement.volume = document.getElementById('remote-volume').value / 100;
      remoteAudioElement.play().catch(e => console.error('Audio error:', e));
      
      const voiceIndicator = document.getElementById('call-voice-indicator');
      updateVoiceIndicator(voiceIndicator, event.streams[0]);
    }
  };
  
  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('call-ice', { to: from, candidate: event.candidate });
    }
  };
  
  await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
  const answer = await peerConnection.createAnswer();
  await peerConnection.setLocalDescription(answer);
  socket.emit('call-answer', { to: from, answer });
  
  callInProgress = true;
  startTimer();
  showCallWindow('active');
}

async function acceptCall() {
  if (!currentCallerId) return;
  
  stopRingtone();
  playConnectSound();
  
  try {
    if (!localStream) {
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
    }
    
    socket.emit('call-accept', { to: currentCallerId });
    createOffer();
  } catch (e) {
    console.error('Accept error:', e);
    alert('❌ Ошибка: ' + e.message);
    endCall();
  }
}

// ... остальные функции звонков остаются похожими ...

// В обработчиках socket.on добавить:
socket.on('user-typing', ({ username }) => {
  showTyping(username);
});

socket.on('user-stop-typing', () => {
  hideTyping();
});

socket.on('private-user-typing', ({ username }) => {
  showTyping(username);
});

socket.on('private-user-stop-typing', () => {
  hideTyping();
});

// ========== ЗАПУСК ==========
loadSavedLogin();

document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && document.activeElement.id === 'message-input') {
    e.preventDefault();
    sendMessage();
  }
});

// Закрываем эмодзи панель при клике вне её
document.addEventListener('click', (e) => {
  const picker = document.getElementById('emoji-picker');
  const emojiBtn = document.querySelector('.emoji-btn');
  if (picker && emojiBtn && !picker.contains(e.target) && !emojiBtn.contains(e.target)) {
    picker.classList.remove('show');
  }
});

window.addEventListener('beforeunload', () => {
  if (inVoiceChannel) leaveVoiceChannel();
  if (callInProgress) endCall();
});
</script>