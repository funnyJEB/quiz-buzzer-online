const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const QRCode = require('qrcode');

const app = express();
app.set('trust proxy', true); // Render 프록시 뒤에서도 https 주소를 올바르게 인식
const server = http.createServer(app);
const io = new Server(server);

// ===== 설정 =====
// 교사 PIN은 코드에 적지 않고 Render 환경변수(TEACHER_PIN)로 설정합니다.
const TEACHER_PIN = String(process.env.TEACHER_PIN || '').trim();
const NAME_MAX = 12;        // 닉네임 최대 글자 수
const MAX_PIN_TRIES = 5;    // 한 연결에서 PIN을 틀릴 수 있는 횟수

if (!TEACHER_PIN) {
  console.warn('[경고] TEACHER_PIN 환경변수가 없습니다. 교사 화면에 로그인할 수 없습니다.');
}

app.use(express.static(path.join(__dirname, 'public')));

// 학생 접속용 QR코드 (외부 사이트 없이 서버에서 직접 생성)
app.get('/qr.svg', async (req, res) => {
  try {
    const url = `${req.protocol}://${req.get('host')}/`;
    const svg = await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    res.type('image/svg+xml').set('Cache-Control', 'no-cache').send(svg);
  } catch (err) {
    console.error('[qr]', err);
    res.status(500).end();
  }
});

// ===== 게임 상태 =====
let scores = {};        // 닉네임 -> 점수
let nameOwner = {};     // 닉네임 -> 기기 ID
let deviceName = {};    // 기기 ID -> 닉네임
let deviceSocket = {};  // 기기 ID -> 현재 연결된 socket.id (기기당 하나)
let buzzerQueue = [];   // [{ name, elapsed }]  elapsed: 부저가 열린 뒤 누르기까지 걸린 시간(ms)
let isLocked = true;
let openedAt = 0;
let answered = null;    // 이번 문제 정답 처리 결과 { name, point }
let cutoffCount = 10;   // 선착순 마감 인원
let lastScore = 10;     // 교사 화면에서 마지막으로 고른 배점 (새로고침 시 복원용)

// ===== 입력값 검사 =====
function cleanName(v) {
  if (typeof v !== 'string') return null;
  const name = v.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  const len = Array.from(name).length;
  return len >= 1 && len <= NAME_MAX ? name : null;
}
function cleanDeviceId(v) {
  return typeof v === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(v) ? v : null;
}
function cleanInt(v, min, max) {
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

// ===== 도우미 =====
function socketOfName(name) {
  const dev = nameOwner[name];
  const sid = dev && deviceSocket[dev];
  return sid ? io.sockets.sockets.get(sid) || null : null;
}
function sendToStudent(name, event, data) {
  const s = socketOfName(name);
  if (s) s.emit(event, data);
}
function onlineNames() {
  return Object.keys(deviceSocket).map(dev => deviceName[dev]).filter(Boolean);
}
function teacherState() {
  return {
    isLocked,
    queue: buzzerQueue,
    scores,
    online: onlineNames(),
    cutoffCount,
    lastScore,
    answered
  };
}
function pushTeacher() {
  io.to('teachers').emit('teacher_state', teacherState());
}
function studentBuzzerState(name) {
  const idx = buzzerQueue.findIndex(b => b.name === name);
  return { isLocked, hasBuzzed: idx !== -1, rank: idx !== -1 ? idx + 1 : null };
}
function setLocked(locked) {
  if (isLocked === locked) return;
  isLocked = locked;
  io.emit('buzzer_state_change', { isLocked });
}
function dropSocket(s, event) {
  if (!s) return;
  s.data.name = null;
  s.data.deviceId = null;
  if (event) s.emit(event);
  s.disconnect(true);
}

io.on('connection', (socket) => {
  // 이벤트 처리 중 에러가 나도 서버가 꺼지지 않도록 감쌈
  const on = (event, handler) => {
    socket.on(event, (...args) => {
      try { handler(...args); } catch (err) { console.error(`[${event}]`, err); }
    });
  };
  // 교사 인증을 통과한 연결만 처리
  const onTeacher = (event, handler) => {
    on(event, (...args) => { if (socket.data.isTeacher) handler(...args); });
  };
  const replyOf = (ack) => (typeof ack === 'function' ? ack : () => {});

  // ---------- 교사 로그인 ----------
  on('teacher_login', (pin, ack) => {
    const reply = replyOf(ack);
    if (!TEACHER_PIN) return reply({ ok: false, error: 'not_configured' });
    socket.data.pinTries = (socket.data.pinTries || 0) + 1;
    if (socket.data.pinTries > MAX_PIN_TRIES) {
      reply({ ok: false, error: 'too_many' });
      socket.disconnect(true);
      return;
    }
    if (typeof pin !== 'string' || pin.trim() !== TEACHER_PIN) {
      setTimeout(() => reply({ ok: false, error: 'wrong' }), 600); // 무작위 대입 속도 늦추기
      return;
    }
    socket.data.isTeacher = true;
    socket.data.pinTries = 0;
    socket.join('teachers');
    reply({ ok: true });
    socket.emit('teacher_state', teacherState());
  });

  // ---------- 학생 등록 / 재접속 ----------
  on('register_student', (payload, ack) => {
    const reply = replyOf(ack);
    const name = cleanName(payload && payload.name);
    const deviceId = cleanDeviceId(payload && payload.deviceId);
    if (!deviceId) return reply({ ok: false, error: '접속 정보를 확인할 수 없어요. 새로고침해 주세요.' });
    if (!name) return reply({ ok: false, error: `닉네임은 1~${NAME_MAX}자로 입력해 주세요.` });

    const owner = nameOwner[name];
    if (owner && owner !== deviceId) {
      return reply({ ok: false, error: '이미 사용 중인 닉네임이에요. 다른 닉네임을 입력해 주세요.' });
    }

    // 이 기기가 다른 닉네임을 쓰고 있었다면 → 닉네임 변경 (점수 이어받기)
    const prevName = deviceName[deviceId];
    if (prevName && prevName !== name) {
      scores[name] = scores[prevName] || 0;
      delete scores[prevName];
      delete nameOwner[prevName];
      buzzerQueue.forEach(b => { if (b.name === prevName) b.name = name; });
      if (answered && answered.name === prevName) answered.name = name;
    }

    // 같은 기기의 다른 창(탭) 연결은 끊음 → 기기당 접속 하나
    const prevSid = deviceSocket[deviceId];
    if (prevSid && prevSid !== socket.id) {
      dropSocket(io.sockets.sockets.get(prevSid), 'duplicate_session');
    }

    socket.data.name = name;
    socket.data.deviceId = deviceId;
    nameOwner[name] = deviceId;
    deviceName[deviceId] = name;
    deviceSocket[deviceId] = socket.id;
    if (scores[name] === undefined) scores[name] = 0;

    reply({ ok: true, name, score: scores[name], ...studentBuzzerState(name) });
    pushTeacher();
  });

  // ---------- 부저 누르기 ----------
  on('press_buzzer', (ack) => {
    const reply = replyOf(ack);
    const name = socket.data.name;
    if (!name || nameOwner[name] !== socket.data.deviceId) return reply({ ok: false });
    if (isLocked) return reply({ ok: false, locked: true });

    const existing = buzzerQueue.findIndex(b => b.name === name);
    if (existing !== -1) return reply({ ok: true, rank: existing + 1 });

    buzzerQueue.push({ name, elapsed: Date.now() - openedAt });
    reply({ ok: true, rank: buzzerQueue.length });

    if (buzzerQueue.length >= cutoffCount) setLocked(true);
    pushTeacher();
  });

  // ---------- 교사 기능 ----------
  onTeacher('open_buzzer', () => {
    buzzerQueue = [];
    answered = null;
    isLocked = false;
    openedAt = Date.now();
    io.emit('buzzer_state_change', { isLocked: false, fresh: true });
    pushTeacher();
  });

  onTeacher('lock_buzzer', () => {
    setLocked(true);
    pushTeacher();
  });

  onTeacher('set_cutoff', (count) => {
    const n = cleanInt(count, 1, 200);
    if (n === null) return;
    cutoffCount = n;
    if (!isLocked && buzzerQueue.length >= cutoffCount) setLocked(true);
    pushTeacher();
  });

  onTeacher('set_score', (score) => {
    const n = cleanInt(score, 1, 1000);
    if (n !== null) lastScore = n;
  });

  // 1순위 판정: 교사 화면에 보이던 1순위 이름(name)과 서버의 1순위가 같을 때만 처리
  // → 버튼을 두 번 눌러도 점수가 두 번 들어가거나 두 명이 넘어가지 않음
  onTeacher('judge_first_student', (payload) => {
    const { isCorrect, score, name } = payload || {};
    if (answered || buzzerQueue.length === 0) return;
    const target = buzzerQueue[0];
    if (name !== target.name) return;

    if (isCorrect) {
      const point = cleanInt(score, 1, 1000); // 클릭하는 순간 선택돼 있던 배점
      if (point === null) return;
      lastScore = point;
      scores[target.name] = (scores[target.name] || 0) + point;
      answered = { name: target.name, point };
      setLocked(true);
      sendToStudent(target.name, 'score_update', scores[target.name]);
    } else {
      buzzerQueue.shift();
    }
    pushTeacher();
  });

  onTeacher('manual_score_adjust', (payload) => {
    const { name, delta } = payload || {};
    const d = cleanInt(delta, -1000, 1000);
    if (d === null || typeof name !== 'string' || scores[name] === undefined) return;
    scores[name] += d;
    sendToStudent(name, 'score_update', scores[name]);
    pushTeacher();
  });

  onTeacher('kick_student', (name) => {
    if (typeof name !== 'string') return;
    const dev = nameOwner[name];
    if (dev) {
      const sid = deviceSocket[dev];
      dropSocket(sid && io.sockets.sockets.get(sid), 'force_kicked');
      delete deviceSocket[dev];
      delete deviceName[dev];
    }
    delete nameOwner[name];
    delete scores[name];
    buzzerQueue = buzzerQueue.filter(b => b.name !== name);
    pushTeacher();
  });

  onTeacher('reset_all_scores', () => {
    for (const name in scores) {
      scores[name] = 0;
      sendToStudent(name, 'score_update', 0);
    }
    pushTeacher();
  });

  onTeacher('start_new_game', () => {
    for (const s of io.sockets.sockets.values()) {
      if (s.data.name) {
        s.data.name = null;
        s.data.deviceId = null;
        s.emit('force_game_restart');
      }
    }
    scores = {};
    nameOwner = {};
    deviceName = {};
    deviceSocket = {};
    buzzerQueue = [];
    answered = null;
    setLocked(true);
    pushTeacher();
  });

  on('disconnect', () => {
    const dev = socket.data.deviceId;
    if (dev && deviceSocket[dev] === socket.id) {
      delete deviceSocket[dev];
      pushTeacher();
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
