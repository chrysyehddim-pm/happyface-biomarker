/**
 * HappyFace-Biomarker 核心邏輯
 * 狀態機：Setup -> Baseline -> Task1 Smile -> Task2 Frown -> Result & Upload
 */

import {
  initFaceLandmarker,
  detectForVideo,
  getSmileIntensity,
  getFrownIntensity,
  getBlinkIntensity,
  getSmileSymmetry,
  getSmileRaw,
  getFrownRaw,
} from './vision.js';
import { saveRecord } from './firebase.js';

// ========== DOM Elements ==========
const sectionSetup = document.getElementById('section-setup');
const sectionTask = document.getElementById('section-task');
const sectionResult = document.getElementById('section-result');
const inputName = document.getElementById('input-name');
const inputAge = document.getElementById('input-age');
const btnStart = document.getElementById('btn-start');
const btnRestart = document.getElementById('btn-restart');
const video = document.getElementById('video');
const canvas = document.getElementById('canvas');
const taskInstruction = document.getElementById('task-instruction');
const taskTimer = document.getElementById('task-timer');
const progressBar = document.getElementById('progress-bar');
const resultSummary = document.getElementById('result-summary');
const resultMetrics = document.getElementById('result-metrics');
const uploadStatus = document.getElementById('upload-status');

// ========== State Machine ==========
const STATES = {
  SETUP: 'setup',
  BASELINE: 'baseline',
  RESET_SMILE: 'reset_smile',
  SMILE: 'smile',
  RESET_FROWN: 'reset_frown',
  FROWN: 'frown',
  RESULT: 'result',
};

const TASK_DURATION_MS = 5000;
const RESET_THRESHOLD = 0.3; // 歸零檢核：臉部放鬆門檻（放寬以適應自然 resting brow ~0.18–0.20）
const RESET_STABLE_MS = 1000; // 歸零後需穩定 1 秒才進入任務
const RESET_TIMEOUT_MS = 4000; // 歸零階段超時：超過 4 秒強制進入下一關
const TARGET_FPS = 30;
const TARGET_50_PCT = 0.5; // 50% 強度用於 latency 計算

/** 任務實際開始時間（歸零完成後才記錄，用於 latency 計算） */
let smileTaskStartTime = 0;
let frownTaskStartTime = 0;
/** 歸零階段：首次偵測到放鬆 (score < threshold) 的時間 */
let resetRelaxedAt = null;
/** 歸零階段：進入 reset 狀態的時間，用於超時判斷 */
let resetStartTime = 0;

let currentState = STATES.SETUP;
let stream = null;
let animationId = null;
/** MediaPipe 需要遞增的 timestamp，使用 frame 計數避免 live stream 的 currentTime 不穩定 */
let mediaPipeTimestamp = 0;
/** 即時 blendshapes 供 debug UI 顯示 */
let lastDebugBlendshapes = null;

// 累積的偵測資料
let baselineSamples = [];
let smileSamples = [];
let frownSamples = [];
let blinkCount = 0;
let blinkPeakTimestamps = [];

// 用戶資訊
let userInfo = { name: '', age: 0 };

// ========== 狀態切換 ==========
function showSection(section) {
  sectionSetup.classList.add('hidden');
  sectionTask.classList.add('hidden');
  sectionResult.classList.add('hidden');
  if (section === 'setup') sectionSetup.classList.remove('hidden');
  else if (section === 'task') sectionTask.classList.remove('hidden');
  else if (section === 'result') sectionResult.classList.remove('hidden');
}

function setState(state) {
  currentState = state;
}

// ========== Camera ==========
async function startCamera() {
  stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'user', width: 640, height: 480 },
    audio: false,
  });
  video.srcObject = stream;
  await video.play();
}

function stopCamera() {
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
  video.srcObject = null;
}

// ========== 主偵測迴圈 ==========
const DETECT_INTERVAL_MS = 33; // ~30fps
let lastDetectTime = 0;

function detectionLoop() {
  if (currentState === STATES.SETUP || currentState === STATES.RESULT) return;

  if (video.videoWidth && video.videoHeight) {
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
  }

  const now = performance.now();
  const elapsed = now - lastDetectTime;

  // 不以 video.currentTime 為條件（live stream 可能不穩定），改為固定間隔偵測
  if (elapsed >= DETECT_INTERVAL_MS) {
    mediaPipeTimestamp += Math.round(elapsed);
    const blendshapes = detectForVideo(video, mediaPipeTimestamp);
    lastDetectTime = now;

    if (blendshapes) {
      lastDebugBlendshapes = blendshapes;
      updateDebugPanel(blendshapes);

      if (currentState === STATES.BASELINE) {
        const smile = getSmileIntensity(blendshapes);
        const frown = getFrownIntensity(blendshapes);
        baselineSamples.push({ smile, frown, t: now });
      } else if (currentState === STATES.RESET_SMILE) {
        const smile = getSmileIntensity(blendshapes);
        const elapsed = now - resetStartTime;
        if (elapsed >= RESET_TIMEOUT_MS) {
          resetRelaxedAt = null;
          enterSmileTask();
        } else if (smile < RESET_THRESHOLD) {
          if (resetRelaxedAt === null) resetRelaxedAt = now;
          else if (now - resetRelaxedAt >= RESET_STABLE_MS) {
            resetRelaxedAt = null;
            enterSmileTask();
          }
        } else {
          resetRelaxedAt = null;
        }
      } else if (currentState === STATES.RESET_FROWN) {
        const frown = getFrownIntensity(blendshapes);
        const elapsed = now - resetStartTime;
        if (elapsed >= RESET_TIMEOUT_MS) {
          resetRelaxedAt = null;
          enterFrownTask();
        } else if (frown < RESET_THRESHOLD) {
          if (resetRelaxedAt === null) resetRelaxedAt = now;
          else if (now - resetRelaxedAt >= RESET_STABLE_MS) {
            resetRelaxedAt = null;
            enterFrownTask();
          }
        } else {
          resetRelaxedAt = null;
        }
      } else if (currentState === STATES.SMILE) {
        const smile = getSmileIntensity(blendshapes);
        const symmetry = getSmileSymmetry(blendshapes);
        smileSamples.push({ smile, symmetry, t: now });

        const blink = getBlinkIntensity(blendshapes);
        if (blink > 0.5) {
          const lastPeak = blinkPeakTimestamps[blinkPeakTimestamps.length - 1];
          if (!lastPeak || now - lastPeak > 200) {
            blinkPeakTimestamps.push(now);
            blinkCount++;
          }
        }
      } else if (currentState === STATES.FROWN) {
        const frown = getFrownIntensity(blendshapes);
        frownSamples.push({ frown, t: now });

        const blink = getBlinkIntensity(blendshapes);
        if (blink > 0.5) {
          const lastPeak = blinkPeakTimestamps[blinkPeakTimestamps.length - 1];
          if (!lastPeak || now - lastPeak > 200) {
            blinkPeakTimestamps.push(now);
            blinkCount++;
          }
        }
      }
    } else {
      lastDebugBlendshapes = null;
      updateDebugPanel(null);
    }
  }

  animationId = requestAnimationFrame(detectionLoop);
}

// ========== 即時 Debug 面板 ==========
function updateDebugPanel(blendshapes) {
  const el = document.getElementById('debug-panel');
  if (!el) return;
  if (!blendshapes) {
    el.textContent = '未偵測到臉部';
    return;
  }
  const smileRaw = getSmileRaw(blendshapes);
  const frownRaw = getFrownRaw(blendshapes);
  el.innerHTML = `
    <div class="text-xs font-mono">微笑 L+R: ${smileRaw.sum.toFixed(3)}</div>
    <div class="text-xs font-mono">皺眉 L+R: ${frownRaw.sum.toFixed(3)}</div>
  `;
}

// ========== 歸零檢核與任務進入 ==========
function showResetInstruction() {
  taskInstruction.textContent = '請先放鬆臉部... (Please relax your face)';
  taskInstruction.className = 'mb-4 rounded-lg px-4 py-3 text-amber-600 bg-amber-50/80 font-medium text-center';
  taskTimer.textContent = '—';
  taskTimer.classList.add('opacity-50');
  progressBar.style.width = '0%';
}

function showTaskInstruction(instruction) {
  taskInstruction.textContent = instruction;
  taskInstruction.className = 'mb-4 rounded-lg bg-amber-50 px-4 py-3 text-amber-900 font-medium text-center';
  taskTimer.classList.remove('opacity-50');
}

function enterResetSmile() {
  setState(STATES.RESET_SMILE);
  resetRelaxedAt = null;
  resetStartTime = performance.now();
  showResetInstruction();
}

function enterResetFrown() {
  setState(STATES.RESET_FROWN);
  resetRelaxedAt = null;
  resetStartTime = performance.now();
  showResetInstruction();
}

function enterSmileTask() {
  smileSamples = [];
  smileTaskStartTime = performance.now();
  setState(STATES.SMILE);
  showTaskInstruction('請用力露齒微笑！');
  runTimedTaskInternal(enterResetFrown);
}

function enterFrownTask() {
  frownSamples = [];
  frownTaskStartTime = performance.now();
  setState(STATES.FROWN);
  showTaskInstruction('請用力皺眉！');
  runTimedTaskInternal(finishAndUpload);
}

// ========== 計時任務 ==========
function runTimedTask(state, instruction, onComplete) {
  setState(state);
  showTaskInstruction(instruction);
  progressBar.style.width = '0%';
  taskTimer.textContent = '5';

  const startTime = performance.now();
  const interval = setInterval(() => {
    const elapsed = performance.now() - startTime;
    const remaining = Math.max(0, Math.ceil((TASK_DURATION_MS - elapsed) / 1000));
    taskTimer.textContent = String(remaining);
    progressBar.style.width = `${Math.min(100, (elapsed / TASK_DURATION_MS) * 100)}%`;

    if (elapsed >= TASK_DURATION_MS) {
      clearInterval(interval);
      progressBar.style.width = '100%';
      onComplete();
    }
  }, 100);
}

function runTimedTaskInternal(onComplete) {
  progressBar.style.width = '0%';
  taskTimer.textContent = '5';

  const startTime = performance.now();
  const interval = setInterval(() => {
    const elapsed = performance.now() - startTime;
    const remaining = Math.max(0, Math.ceil((TASK_DURATION_MS - elapsed) / 1000));
    taskTimer.textContent = String(remaining);
    progressBar.style.width = `${Math.min(100, (elapsed / TASK_DURATION_MS) * 100)}%`;

    if (elapsed >= TASK_DURATION_MS) {
      clearInterval(interval);
      progressBar.style.width = '100%';
      onComplete();
    }
  }, 100);
}

// ========== 指標計算 ==========
function computeVariance(arr, key) {
  if (!arr.length) return 1;
  const vals = arr.map((x) => x[key]);
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const variance = vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length;
  return Math.min(1, variance);
}

function computePeakLatency(samples, key, taskStartTime) {
  if (!samples.length) return { peak: 0, latency_ms: 0 };
  const peak = Math.max(...samples.map((s) => s[key]));
  const targetVal = peak * TARGET_50_PCT;
  const crossing = samples.find((s) => s[key] >= targetVal);
  const latency_ms = crossing ? Math.round(crossing.t - taskStartTime) : 0;
  return { peak, latency_ms };
}

function computeBaselineStability() {
  const smileVar = computeVariance(baselineSamples, 'smile');
  const frownVar = computeVariance(baselineSamples, 'frown');
  return (smileVar + frownVar) / 2;
}

// ========== 雷達圖 (Chart.js 五維健康雷達圖) ==========
let radarChartInstance = null;

function drawRadarChart(canvasEl, biomarkers) {
  if (!canvasEl || typeof Chart === 'undefined') return;

  const {
    baseline_stability,
    smile_metrics,
    frown_metrics,
  } = biomarkers;

  // 數據映射：0–100 分
  const smileScore = Math.min(100, (smile_metrics.peak_intensity ?? 0) * 100);
  const frownScore = Math.min(100, (frown_metrics.peak_intensity ?? 0) * 100);
  const symmetryScore = Math.min(100, (smile_metrics.symmetry ?? 0) * 100);
  const stabilityScore = Math.max(0, 100 - (baseline_stability ?? 0) * 100);
  const avgLatencyMs = ((smile_metrics.latency_ms ?? 0) + (frown_metrics.latency_ms ?? 0)) / 2;
  const reflexScore = Math.max(0, 100 - avgLatencyMs / 15);

  const labels = ['微笑肌力', '皺眉肌力', '對稱性', '靜態穩定', '神經反應'];
  const values = [smileScore, frownScore, symmetryScore, stabilityScore, reflexScore];

  if (radarChartInstance) {
    radarChartInstance.destroy();
    radarChartInstance = null;
  }

  radarChartInstance = new Chart(canvasEl, {
    type: 'radar',
    data: {
      labels,
      datasets: [
        {
          label: '臉部情緒肌耐力',
          data: values,
          backgroundColor: 'rgba(75, 192, 192, 0.2)',
          borderColor: 'rgba(75, 192, 192, 1)',
          borderWidth: 2,
          pointBackgroundColor: 'rgba(255, 99, 132, 1)',
          pointBorderColor: 'rgba(255, 99, 132, 1)',
          pointHoverBackgroundColor: 'rgba(255, 99, 132, 1)',
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      scales: {
        r: {
          min: 0,
          max: 100,
          ticks: {
            stepSize: 20,
          },
        },
      },
    },
  });
}

// ========== 簡單規則：raw_data_summary ==========
function computeRawSummary(biomarkers) {
  const { baseline_stability, smile_metrics, frown_metrics } = biomarkers;
  const issues = [];
  if (baseline_stability > 0.5) issues.push('baseline');
  if (smile_metrics.peak_intensity < 0.3) issues.push('smile');
  if (frown_metrics.peak_intensity < 0.3) issues.push('frown');
  if (smile_metrics.symmetry < 0.6) issues.push('symmetry');
  return issues.length === 0 ? '正常' : '建議諮詢專業醫師';
}

// ========== 流程控制 ==========
async function runBaseline() {
  baselineSamples = [];
  runTimedTask(
    STATES.BASELINE,
    '請保持臉部靜止不動，計算基礎表情張力',
    enterResetSmile
  );
}

async function finishAndUpload() {
  setState(STATES.RESULT);
  cancelAnimationFrame(animationId);
  stopCamera();

  const baseline_stability = computeBaselineStability();
  const { peak: smilePeak, latency_ms: smileLatency } = computePeakLatency(
    smileSamples,
    'smile',
    smileTaskStartTime
  );
  const smileSymmetry =
    smileSamples.length > 0
      ? smileSamples.reduce((s, x) => s + x.symmetry, 0) / smileSamples.length
      : 0;

  const { peak: frownPeak, latency_ms: frownLatency } = computePeakLatency(
    frownSamples,
    'frown',
    frownTaskStartTime
  );

  const totalDurationSec = (frownSamples[frownSamples.length - 1]?.t ?? 0) / 1000;
  const blink_rate = totalDurationSec > 0 ? (blinkCount / totalDurationSec) * 60 : 0;

  const biomarkers = {
    baseline_stability,
    smile_metrics: {
      peak_intensity: Math.min(1, smilePeak),
      latency_ms: smileLatency,
      symmetry: Math.min(1, smileSymmetry),
    },
    frown_metrics: {
      peak_intensity: Math.min(1, frownPeak),
      latency_ms: frownLatency,
    },
    blink_rate,
  };

  const raw_data_summary = computeRawSummary(biomarkers);

  const record = {
    user_info: {
      name: userInfo.name,
      age: userInfo.age,
    },
    biomarkers,
    raw_data_summary,
  };

  // 顯示結果
  showSection('result');
  drawRadarChart(document.getElementById('radarChart'), biomarkers);

  resultSummary.textContent = raw_data_summary;
  resultSummary.className =
    raw_data_summary === '正常'
      ? 'rounded-lg p-4 mb-4 text-center font-medium bg-green-100 text-green-800'
      : 'rounded-lg p-4 mb-4 text-center font-medium bg-amber-100 text-amber-800';

  resultMetrics.innerHTML = `
    <p>靜態穩定度：${(baseline_stability * 100).toFixed(1)}%</p>
    <p>微笑強度：${(biomarkers.smile_metrics.peak_intensity * 100).toFixed(1)}%，反應速度：${smileLatency}ms，對稱性：${(smileSymmetry * 100).toFixed(1)}%</p>
    <p>皺眉強度：${(biomarkers.frown_metrics.peak_intensity * 100).toFixed(1)}%，反應速度：${frownLatency}ms</p>
    <p>眨眼頻率：${blink_rate.toFixed(1)} 次/分</p>
  `;

  uploadStatus.textContent = '正在上傳至 Firestore...';
  uploadStatus.className = 'rounded-lg px-4 py-2 text-center text-sm text-slate-600';

  try {
    const docId = await saveRecord(record);
    uploadStatus.textContent = `已上傳成功（文件 ID: ${docId}）`;
    uploadStatus.className = 'rounded-lg px-4 py-2 text-center text-sm text-green-600';
  } catch (err) {
    console.error('Firestore upload error:', err);
    uploadStatus.textContent = `上傳失敗：${err.message}`;
    uploadStatus.className = 'rounded-lg px-4 py-2 text-center text-sm text-red-600';
  }
}

// ========== Event Handlers ==========
async function onStart() {
  const name = inputName.value?.trim();
  const age = parseInt(inputAge.value, 10);

  if (!name || isNaN(age) || age < 1 || age > 120) {
    alert('請輸入有效的姓名與年齡（1–120）');
    return;
  }

  userInfo = { name, age };
  btnStart.disabled = true;

  try {
    await initFaceLandmarker();
    await startCamera();
    showSection('task');
    setState(STATES.BASELINE);
    mediaPipeTimestamp = 0;
    lastDetectTime = performance.now();
    detectionLoop();
    runBaseline();
  } catch (err) {
    console.error(err);
    alert('無法啟動相機或 Face Landmarker：' + err.message);
    btnStart.disabled = false;
  }
}

function onRestart() {
  if (radarChartInstance) {
    radarChartInstance.destroy();
    radarChartInstance = null;
  }
  currentState = STATES.SETUP;
  baselineSamples = [];
  smileSamples = [];
  frownSamples = [];
  blinkCount = 0;
  blinkPeakTimestamps = [];
  resetRelaxedAt = null;
  resetStartTime = 0;
  smileTaskStartTime = 0;
  frownTaskStartTime = 0;
  btnStart.disabled = false;
  showSection('setup');
  inputName.value = '';
  inputAge.value = '';
}

// ========== URL 參數自動帶入 ==========
function initFromUrlParams() {
  const urlParams = new URLSearchParams(window.location.search);
  const name = urlParams.get('name')?.trim();
  const age = urlParams.get('age')?.trim();

  const nameInput = document.getElementById('input-name');
  const ageInput = document.getElementById('input-age');

  let filledCount = 0;
  if (name && nameInput) {
    nameInput.value = name;
    nameInput.dispatchEvent(new Event('input'));
    filledCount++;
  }
  if (age && ageInput) {
    const ageNum = parseInt(age, 10);
    if (!isNaN(ageNum) && ageNum >= 1 && ageNum <= 120) {
      ageInput.value = String(ageNum);
      ageInput.dispatchEvent(new Event('input'));
      filledCount++;
    }
  }

  if (filledCount === 2) {
    showToast(`嗨 ${name}，資料已自動帶入！`);
    const startBtn = document.getElementById('btn-start');
    if (startBtn) startBtn.focus();
  }
}

function showToast(message) {
  const toast = document.createElement('div');
  toast.setAttribute('role', 'status');
  toast.className =
    'fixed bottom-4 left-1/2 -translate-x-1/2 px-4 py-2 rounded-lg bg-amber-600 text-white text-sm font-medium shadow-lg z-50 animate-fade-in';
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

// ========== Init ==========
btnStart.addEventListener('click', onStart);
btnRestart.addEventListener('click', onRestart);

// DOM 載入完成後執行 URL 參數帶入
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initFromUrlParams);
} else {
  initFromUrlParams();
}
