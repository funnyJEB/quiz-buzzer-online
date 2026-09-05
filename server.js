const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// 정적 파일 제공 (public 폴더)
app.use(express.static(path.join(__dirname, 'public')));

// 기본 접속 시 학생 화면으로 안내
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 상태 저장소
let buzzerQueue = [];      // 선착순 누른 목록 [{ id, name, time }]
let isLocked = true;       // 부저 잠김 여부
let scores = {};           // { [name]: 점수 }
let connectedStudents = {};// { [socketId]: name }
let maxDisplayCount = 10;  // 접수할 최대 선착순 인원수 (교사 설정)
let currentQuestionScore = 10; // 현재 문제 배점

io.on('connection', (socket) => {
  // 교사 화면 접속 시 초기 데이터 전송
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

  // 학생 등록 및 재접속 처리
  socket.on('register_student', (name) => {
    const trimmedName = name.trim();
    socket.studentName = trimmedName;
    connectedStudents[socket.id] = trimmedName;

    // 점수 기록이 없으면 0점으로 신규 생성, 있으면 기존 점수 유지
    if (scores[trimmedName] === undefined) {
      scores[trimmedName] = 0;
    }

    // 학생에게 자신의 점수 및 부저 상태 전송
    socket.emit('score_update', scores[trimmedName]);
    const buzzedIndex = buzzerQueue.findIndex(b => b.name === trimmedName);
    socket.emit('buzzer_state', {
      isLocked,
      hasBuzzed: buzzedIndex !== -1,
      rank: buzzedIndex !== -1 ? buzzedIndex + 1 : null
    });

    // 교사 화면 접속자 수 갱신
    io.emit('student_list_updated', {
      scores,
      onlineCount: Object.keys(connectedStudents).length
    });
  });

  // 학생 부저 클릭
  socket.on('press_buzzer', () => {
    if (isLocked || !socket.studentName) return;

    // 이미 선착순에 든 학생이면 무시
    const alreadyBuzzed = buzzerQueue.some(b => b.name === socket.studentName);
    if (alreadyBuzzed) return;

    const rank = buzzerQueue.length + 1;
    buzzerQueue.push({
      id: socket.id,
      name: socket.studentName,
      time: Date.now(),
      rank
    });

    // 본인 기기에 결과 전송
    socket.emit('buzzer_result', { rank, isFirst: rank === 1 });

    // 교사 화면 실시간 순위표 갱신
    io.emit('queue_updated', buzzerQueue);

    // 설정된 인원(예: 5명, 10명)이 다 차면 전체 부저 자동 잠금
    if (buzzerQueue.length >= maxDisplayCount) {
      isLocked = true;
      io.emit('buzzer_state_change', { isLocked: true });
    }
  });

  // [교사 명령] 새 문제 시작 (부저 열기)
  socket.on('open_buzzer', (score) => {
    buzzerQueue = [];
    isLocked = false;
    currentQuestionScore = parseInt(score, 10) || 10;
    io.emit('buzzer_reset');
    io.emit('buzzer_state_change', { isLocked: false, score: currentQuestionScore });
  });

  // [교사 명령] 수동 부저 잠금
  socket.on('lock_buzzer', () => {
    isLocked = true;
    io.emit('buzzer_state_change', { isLocked: true });
  });

  // [교사 명령] 선착순 마감 인원수 변경
  socket.on('set_max_display', (count) => {
    maxDisplayCount = parseInt(count, 10) || 10;
    io.emit('max_display_updated', maxDisplayCount);
  });

  // [교사 명령] 정답 처리 (1위 정답 시 배점 부여 후 자동 잠금)
  socket.on('judge_first_student', ({ isCorrect, score }) => {
    if (buzzerQueue.length === 0) return;
    const targetStudent = buzzerQueue[0];
    const point = parseInt(score, 10);

    if (isCorrect) {
      // 정답: 점수 가산 후 큐 리셋 및 부저 잠금
      scores[targetStudent.name] = (scores[targetStudent.name] || 0) + point;
      isLocked = true;
      io.emit('buzzer_state_change', { isLocked: true });
    } else {
      // 오답: 페널티(옵션) 후 발언권을 2순위에게 토스 (1순위 제거)
      buzzerQueue.shift(); // 맨 앞 1순위 제거
      // 남은 학생들 순위 재계산
      buzzerQueue.forEach((item, index) => item.rank = index + 1);
    }

    // 업데이트된 점수 및 큐 전송
    io.emit('scores_updated', scores);
    io.emit('queue_updated', buzzerQueue);
    sendScoreToStudent(targetStudent.name);
  });

  // [교사 명령] 개별 학생 점수 증감 (+ / -)
  socket.on('manual_score_adjust', ({ name, delta }) => {
    if (scores[name] !== undefined) {
      scores[name] += delta;
      io.emit('scores_updated', scores);
      sendScoreToStudent(name);
    }
  });

  // [교사 명령] 학생 강제 퇴장(Kick)
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

  // [교사 명령] 점수 전체 초기화
  socket.on('reset_all_scores', () => {
    for (const name in scores) scores[name] = 0;
    io.emit('scores_updated', scores);
    io.emit('all_scores_reset');
  });

  // 연결 종료 시 처리
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
