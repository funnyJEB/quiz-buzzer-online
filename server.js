const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

// 정적 파일 제공
app.use(express.static(path.join(__dirname, 'public')));

// 상태 관리
let buzzerQueue = [];      // 클릭한 학생 순서 목록 [{ id, name, time }]
let isLocked = true;       // 부저 활성화 여부 (기본 잠김)
let scores = {};           // 학생별 점수 { [name]: number }
let maxDisplayCount = 10;  // 교사 화면 표시 순위 개수

io.on('connection', (socket) => {
  // 교사 초기 상태 전달
  socket.on('teacher_init', () => {
    socket.emit('state_update', {
      isLocked,
      buzzerQueue,
      scores,
      maxDisplayCount
    });
  });

  // 학생 등록
  socket.on('register_student', (name) => {
    socket.studentName = name.trim();
    if (scores[socket.studentName] === undefined) {
      scores[socket.studentName] = 0;
    }
    socket.emit('score_update', scores[socket.studentName]);
    socket.emit('buzzer_state', {
      isLocked,
      hasBuzzed: buzzerQueue.some(b => b.name === socket.studentName),
      isFirst: buzzerQueue.length > 0 && buzzerQueue[0].name === socket.studentName
    });
  });

  // 부저 클릭
  socket.on('press_buzzer', () => {
    if (isLocked || !socket.studentName) return;

    // 이미 누른 학생 중복 방지
    const alreadyBuzzed = buzzerQueue.some(b => b.name === socket.studentName);
    if (alreadyBuzzed) return;

    const rank = buzzerQueue.length + 1;
    const buzzRecord = {
      id: socket.id,
      name: socket.studentName,
      time: Date.now(),
      rank
    };
    buzzerQueue.push(buzzRecord);

    // 본인 기기에 알림
    socket.emit('buzzer_result', { rank, isFirst: rank === 1 });

    // 교사 화면 실시간 업데이트
    io.emit('queue_updated', buzzerQueue);

    // 전체 학생 기기 상태 갱신 (1순위 발생 시 화면 잠금 반영 등)
    io.emit('buzzer_status_broadcast', {
      firstBuzzerName: buzzerQueue[0].name,
      totalBuzzed: buzzerQueue.length
    });
  });

  // 교사 명령: 부저 열기 (새 문제 시작)
  socket.on('open_buzzer', () => {
    buzzerQueue = [];
    isLocked = false;
    io.emit('buzzer_reset');
    io.emit('buzzer_state_change', { isLocked: false });
  });

  // 교사 명령: 부저 수동 잠금
  socket.on('lock_buzzer', () => {
    isLocked = true;
    io.emit('buzzer_state_change', { isLocked: true });
  });

  // 교사 명령: 순위 표시 개수 변경
  socket.on('set_max_display', (count) => {
    maxDisplayCount = parseInt(count, 10) || 10;
    io.emit('max_display_updated', maxDisplayCount);
  });

  // 교사 명령: 점수 증감 (정답/오답)
  socket.on('update_score', ({ name, delta }) => {
    if (scores[name] !== undefined) {
      scores[name] += delta;
      // 교사용 전체 점수표
      io.emit('scores_updated', scores);
      // 해당 학생 기기 개별 통보
      for (const [id, s] of io.of("/").sockets) {
        if (s.studentName === name) {
          s.emit('score_update', scores[name]);
        }
      }
    }
  });

  // 교사 명령: 전체 점수 초기화
  socket.on('reset_all_scores', () => {
    for (const name in scores) {
      scores[name] = 0;
    }
    io.emit('scores_updated', scores);
    io.emit('all_scores_reset');
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Buzzer Server running on port ${PORT}`);
});