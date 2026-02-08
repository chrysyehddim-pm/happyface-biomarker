# HappyFace-Biomarker

臉部表情肌耐力與情緒反應檢測工具 — 神經退化疾病初步篩檢研究 Web POC。

## Tech Stack

- **Framework**: Vite (Vanilla JS)
- **UI**: Tailwind CSS (PostCSS)
- **AI**: Google MediaPipe Face Landmarker
- **Backend**: Firebase Firestore (Web SDK v9 Modular)

## 專案結構

```
emotion-demo/
├── index.html           # UI 介面
├── src/
│   ├── main.js          # 核心邏輯與狀態機
│   ├── firebase.js      # Firebase 初始化與 saveRecord
│   ├── vision.js        # MediaPipe Face Landmarker 封裝
│   └── style.css        # Tailwind 樣式
├── package.json
├── vite.config.js
├── tailwind.config.js
└── postcss.config.js
```

## 安裝與執行

**需求：Node.js >= 18**

```bash
npm install
npm run dev
```

瀏覽器開啟 `http://localhost:5173`。

## Firebase 設定

1. 在 `src/firebase.js` 中將 `firebaseConfig` 替換為您的 Firebase 專案設定（與 Squat Analysis 專案相同）。
2. 確保 Firestore 已啟用，且安全規則允許寫入 `emotion_records` 集合。

## 測試流程（狀態機）

1. **Setup**: 輸入受測者姓名與年齡
2. **Baseline (5s)**: 靜止不動，計算基礎表情張力
3. **Task 1: Smile Mimicry (5s)**: 用力露齒微笑，偵測反應速度與最大強度
4. **Task 2: Frown Mimicry (5s)**: 用力皺眉，偵測眉頭深鎖能力
5. **Result & Upload**: 顯示雷達圖，並自動上傳至 Firestore `emotion_records`

## Firestore Schema (`emotion_records`)

```json
{
  "user_info": {
    "name": "String",
    "age": "Number",
    "timestamp": "ServerTimestamp",
    "platform": "Web POC"
  },
  "biomarkers": {
    "baseline_stability": "Number (0-1)",
    "smile_metrics": {
      "peak_intensity": "Number (0-1)",
      "latency_ms": "Number",
      "symmetry": "Number (0-1)"
    },
    "frown_metrics": {
      "peak_intensity": "Number (0-1)",
      "latency_ms": "Number"
    },
    "blink_rate": "Number (每分鐘眨眼次數)"
  },
  "raw_data_summary": "String (Normal | Need Consultation)"
}
```
