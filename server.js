const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

let buzzerQueue = [];
let isLocked = true;
let scores = {};
let connectedStudents = {};
let maxDisplayCount = 10;
let currentQuestionScore = 10;

io.on('connection', (socket) => {
  // 교사 초기 연결
  socket.on('teacher_init', () => {
    socket.emit('state_update', {
      isLocked,
      buzzerQueue,
      scores,
      maxDisplayCount,
      currentQuestionScore,
      onlineCount: Object.keys(connectedStudents).length
    });
  });

  // 학생 등록 및 재접속
  socket.on('register_student', (name) => {
    const trimmedName = name.trim();
    socket.studentName = trimmedName;
    connectedStudents[socket.id] = trimmedName;

    if (scores[trimmedName] === undefined) {
      scores[trimmedName] = 0;
    }

    socket.emit('score_update', scores[trimmedName]);
    const buzzedIndex = buzzerQueue.findIndex(b => b.name === trimmedName);
    socket.emit('buzzer_state', {
      isLocked,
      hasBuzzed: buzzedIndex !== -1,
      rank: buzzedIndex !== -1 ? buzzedIndex + 1 : null
    });

    io.emit('student_list_updated', {
      scores,
      onlineCount: Object.keys(connectedStudents).length
    });
  });

  // 부저 클릭
  socket.on('press_buzzer', () => {
    if (isLocked || !socket.studentName) return;
    if (buzzerQueue.some(b => b.name === socket.studentName)) return;

    const rank = buzzerQueue.length + 1;
    buzzerQueue.push({
      id: socket.id,
      name: socket.studentName,
      time: Date.now(),
      rank
    });

    socket.emit('buzzer_result', { rank, isFirst: rank === 1 });
    io.emit('queue_updated', buzzerQueue);

    if (buzzerQueue.length >= maxDisplayCount) {
      isLocked = true;
      io.emit('buzzer_state_change', { isLocked: true });
    }
  });

  // 새 문제 시작 (부저 열기)
  socket.on('open_buzzer', (score) => {
    buzzerQueue = [];
    isLocked = false;
    currentQuestionScore = parseInt(score, 10) || 10;
    io.emit('buzzer_reset');
    io.emit('buzzer_state_change', { isLocked: false, score: currentQuestionScore });
  });

  // 수동 부저 잠금
  socket.on('lock_buzzer', () => {
    isLocked = true;
    io.emit('buzzer_state_change', { isLocked: true });
  });

  // 선착순 인원수 설정
  socket.on('set_max_display', (count) => {
    maxDisplayCount = parseInt(count, 10) || 10;
    io.emit('max_display_updated', maxDisplayCount);
  });

  // 정답 판정 (1순위)
  socket.on('judge_first_student', ({ isCorrect, score }) => {
    if (buzzerQueue.length === 0) return;
    const target = buzzerQueue[0];
    const point = parseInt(score, 10);

    if (isCorrect) {
      scores[target.name] = (scores[target.name] || 0) + point;
      isLocked = true;
      io.emit('buzzer_state_change', { isLocked: true });
    } else {
      buzzerQueue.shift();
      buzzerQueue.forEach((item, idx) => item.rank = idx + 1);
    }

    io.emit('scores_updated', scores);
    io.emit('queue_updated', buzzerQueue);
    sendScoreToStudent(target.name);
  });

  // 개별 점수 조정
  socket.on('manual_score_adjust', ({ name, delta }) => {
    if (scores[name] !== undefined) {
      scores[name] += delta;
      io.emit('scores_updated', scores);
      sendScoreToStudent(name);
    }
  });

  // 개별 학생 강퇴
  socket.on('kick_student', (targetName) => {
    for (const [id, s] of io.of('/').sockets) {
      if (s.studentName === targetName) {
        s.emit('force_kicked');
        s.disconnect(true);
      }
    }
    delete scores[targetName];
    buzzerQueue = buzzerQueue.filter(b => b.name !== targetName);
    io.emit('scores_updated', scores);
    io.emit('queue_updated', buzzerQueue);
  });

  // 점수만 리셋 (이어하기)
  socket.on('reset_all_scores', () => {
    for (const name in scores) scores[name] = 0;
    io.emit('scores_updated', scores);
    io.emit('all_scores_reset');
    for (const [id, s] of io.of('/').sockets) {
      if (s.studentName) s.emit('score_update', 0);
    }
  });

  // 새 게임 시작 (완전 초기화 및 전체 퇴장)
  socket.on('start_new_game', () => {
    scores = {};
    buzzerQueue = [];
    isLocked = true;
    connectedStudents = {};
    io.emit('force_game_restart');
    io.emit('scores_updated', scores);
    io.emit('queue_updated', buzzerQueue);
    io.emit('buzzer_state_change', { isLocked: true });
  });

  socket.on('disconnect', () => {
    delete connectedStudents[socket.id];
    io.emit('student_list_updated', {
      scores,
      onlineCount: Object.keys(connectedStudents).length
    });
  });

  function sendScoreToStudent(name) {
    for (const [id, s] of io.of('/').sockets) {
      if (s.studentName === name) {
        s.emit('score_update', scores[name]);
      }
    }
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
